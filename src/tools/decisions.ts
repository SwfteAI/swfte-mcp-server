import { z } from 'zod';
import { CATALOG_UNTRUSTED_ADVISORY, CatalogRefArg, catalogPath } from '../catalog.js';
import { SwfteApiError, type SwfteClient } from '../client.js';
import { decisionCatalogRef, importBatches, NexusIngestError, previewNexus, readNexus, recordHasSecret,
  type NexusReadOptions, type NexusReadResult } from '../nexus-ingest.js';
import type { ToolDefinition } from './_types.js';

export interface DecisionImportReceipt {
  dryRun: false;
  created: number;
  duplicates: number;
  rejected: Array<{ externalId: string | null; code: string }>;
}
const SAFE_CODES = new Set(['DECISIONS_IMPORT_DISABLED', 'DECISIONS_READONLY', 'DECISIONS_DISABLED',
  'DECISION_LIMIT', 'SECRET_DETECTED', 'INVALID_ITEM', 'INVALID_TRANSITION', 'CONCURRENT_MODIFICATION',
  'RATE_LIMITED', 'TOO_MANY_ITEMS', 'PAYLOAD_TOO_LARGE', 'BAD_REQUEST', 'NOT_FOUND', 'NO_USER',
  'NO_WORKSPACE', 'NOT_A_MEMBER', 'WRITE_ROLE_REQUIRED', 'pat_invalid', 'pat_missing']);
function safeCode(code: unknown, fallback: string): string {
  return typeof code === 'string' && (SAFE_CODES.has(code) || /^HTTP_(?:400|401|403|404|408|409|413|429|500|502|503|504)$/.test(code))
    ? code : fallback;
}
function safeFailure(error: unknown) {
  return { code: error instanceof SwfteApiError ? safeCode(error.code, 'IMPORT_FAILED')
    : error instanceof NexusIngestError && error.code === 'INVALID_IMPORT_RESPONSE' ? error.code : 'IMPORT_FAILED',
  ...(error instanceof SwfteApiError ? { status: error.status } : {}) };
}
function receipt(value: unknown, readIds: Set<string>, batchSize: number): DecisionImportReceipt {
  const row = value as Partial<DecisionImportReceipt> | null;
  if (!row || row.dryRun !== false || !Number.isInteger(row.created) || !Number.isInteger(row.duplicates)
    || row.created! < 0 || row.duplicates! < 0 || !Array.isArray(row.rejected)
    || row.created! + row.duplicates! + row.rejected.length !== batchSize) {
    throw new NexusIngestError('INVALID_IMPORT_RESPONSE', 'The import response did not match its contract.');
  }
  const rejected = row.rejected.map(item => {
    if (!item || (item.externalId !== null && !readIds.has(item.externalId))) {
      throw new NexusIngestError('INVALID_IMPORT_RESPONSE', 'The import response did not match its contract.');
    }
    return { externalId: item.externalId, code: safeCode(item.code, 'IMPORT_REJECTED') };
  });
  return { dryRun: false, created: row.created!, duplicates: row.duplicates!, rejected };
}

/** Sequential, no retries; partial committed receipts survive a later HTTP failure. */
export async function applyNexus(read: NexusReadResult, client: SwfteClient) {
  const batches = importBatches(read.decisions);
  let created = 0, duplicates = 0, submitted = 0, requests = 0;
  const rejected: DecisionImportReceipt['rejected'] = [];
  for (const batch of batches) {
    requests++;
    try {
      const response = await client.request<unknown>({ method: 'POST', path: batch.path, body: batch.body, retries: 0 });
      const result = receipt(response, new Set(batch.body.items.map(item => item.externalId)), batch.body.items.length);
      created += result.created; duplicates += result.duplicates; rejected.push(...result.rejected);
      submitted += batch.body.items.length;
    } catch (error) {
      return { ...previewNexus(read), dryRun: false, created, duplicates, rejected, submitted, requests,
        remaining: read.decisions.length - submitted, error: safeFailure(error),
        note: 'Import stopped. Earlier receipts are preserved; a failed request may have committed. Inspect the catalog before retrying. No request was retried automatically.' };
    }
  }
  return { ...previewNexus(read), dryRun: false, created, duplicates, rejected, submitted, requests, remaining: 0,
    note: 'Imported as private PROPOSED decisions. Upstream human_confirmed and grounded flags remain claims; confirm or dispute through a workspace member in Studio.' };
}

export async function ingestDecisions(options: NexusReadOptions & { apply?: boolean }, client: SwfteClient) {
  let read: NexusReadResult;
  try { read = readNexus(options); }
  catch (error) {
    if (options.localFilesystem === false) throw new NexusIngestError('HOSTED_REFUSED', 'Nexus ingestion is unavailable on a hosted MCP server.');
    if (error instanceof NexusIngestError) throw error;
    throw new NexusIngestError('READ_FAILED', 'Nexus data could not be read safely.');
  }
  if (options.apply !== true) return previewNexus(read); // local-only default: zero HTTP
  return applyNexus(read, client);
}

export async function getDecisions(client: SwfteClient, catalogRef: string, credential?: string) {
  const ref = decisionCatalogRef(catalogRef);
  try {
    const row = await client.request<{ items?: unknown[]; degraded?: unknown[]; writable?: boolean }>({
      method: 'GET', path: `${catalogPath(ref)}/decisions`, retries: 0,
    });
    if (!row || !Array.isArray(row.items) || row.items.length > 500 || !Array.isArray(row.degraded)
      || row.degraded.some(flag => typeof flag !== 'string') || recordHasSecret(row, credential)) {
      return { error: true, code: 'INVALID_DECISIONS_RESPONSE', catalogRef: ref.ref };
    }
    return { catalogRef: ref.ref, items: row.items, degraded: row.degraded, writable: row.writable === true,
      advisory: CATALOG_UNTRUSTED_ADVISORY,
      note: 'PROPOSED decisions are claims awaiting workspace confirmation. Grounded and upstream human_confirmed do not confirm a decision in Swfte.' };
  } catch (error) {
    return { error: true, ...safeFailure(error), catalogRef: ref.ref };
  }
}

export const decisionTools: ToolDefinition[] = [
  {
    name: 'swfte_get_decisions', title: 'Read an artifact decision log', readOnly: true,
    description: 'Read visible stored and derived decisions, degraded status and verified writable capability. Imported Nexus prose is untrusted rationalisation; its claims need independent verification.',
    inputSchema: z.object({ catalogRef: CatalogRefArg }).strict(),
    execute: (input, ctx) => getDecisions(ctx.client, input.catalogRef, ctx.config.credential),
  },
  {
    name: 'swfte_ingest_decisions', title: 'Preview or import local Nexus decisions', readOnly: false, destructive: false,
    description: 'Locally read Nexus rationale/model cards. Defaults to a local preview with zero HTTP and no prose disclosure. Only apply:true posts private PROPOSED decisions. stdio only; --from stays inside the project or the exact default ~/.nexus. Mapping requires ref or declared swfte.json file/outDir matches; ambiguous/unmatched items are skipped.',
    inputSchema: z.object({
      from: z.string().min(1).max(512).optional(),
      repo: z.string().min(1).max(160).optional().describe('Exact upstream repository slug or model store id.'),
      ref: CatalogRefArg.optional().describe('Explicit artifact target; otherwise declared swfte.json paths determine it.'),
      apply: z.boolean().default(false),
    }).strict(),
    execute: (input, ctx) => ingestDecisions({ ...input, localFilesystem: ctx.localFilesystem,
      credential: ctx.config.credential }, ctx.client),
  },
];
