/**
 * Creating knowledge that can actually be retrieved.
 *
 * Four calls stand between a description and a groundable dataset — create,
 * upload, attach, index — with an unvalidated join between the third and the
 * fourth, and a status field that reports COMPLETED whether or not anything
 * landed. On workspace 271 both knowledge datasets report COMPLETED with
 * totalSegments 0, wordCount 0 and data_source_info null; a retrieval probe
 * against them returns candidatesRetrieved 0. The knowledge is attached and
 * dead, and nothing in the platform says so.
 *
 * This module refuses to report success on that state. It does not fix the
 * backend defect — it cannot — but it makes the defect impossible to ship:
 *
 *   - a document is not attached until its uploaded file has been confirmed;
 *   - COMPLETED with totalSegments == 0 is a FAILURE, not a success;
 *   - the acceptance test is a RETRIEVAL PROBE, not a status field.
 *
 * That last point is the same discipline the coverage checks apply to prompts.
 * The counter is the stored value; what retrieval returns is the effective one.
 * Only the second is worth showing anyone.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SwfteClient } from './client.js';
import { SwfteApiError } from './client.js';
import type { VerifyCheck } from './kinds/_adapter.js';

const DATASETS = '/api/v2/datasets';
const FILES = '/api/v2/files';
const RAG_SEARCH = '/v2/rag/search';

/** Terminal indexing statuses. DocumentV2.IndexingStatus, uppercased. */
const TERMINAL = new Set(['COMPLETED', 'ERROR', 'FAILED', 'CANCELLED', 'PAUSED']);

export interface KnowledgeDocInput {
  name: string;
  /** Inline text. Written to a temp file, because the API only takes a fileId. */
  text?: string;
  /** Or an existing local file. */
  path?: string;
  mimeType?: string;
}

export interface BuildKnowledgeInput {
  name: string;
  description?: string;
  documents: KnowledgeDocInput[];
  indexingTechnique?: 'HIGH_QUALITY' | 'ECONOMY';
  permission?: string;
  /** Query used for the retrieval probe. Defaults to the dataset description. */
  probeQuery?: string;
  /** How long to wait for indexing before reporting what it found. */
  waitMs?: number;
  workspaceId?: string;
}

export interface KnowledgeDocResult {
  documentId: string;
  name: string;
  fileId: string;
  indexingStatus: string;
  totalSegments: number;
  wordCount: number;
  ok: boolean;
  detail: string;
}

export interface BuildKnowledgeReport {
  ok: boolean;
  datasetId: string;
  name: string;
  documents: KnowledgeDocResult[];
  checks: VerifyCheck[];
  /** What retrieval actually returned. The only evidence that counts. */
  probe?: { query: string; candidatesRetrieved: number; resultsReturned: number; sample?: string };
  nextActions: string[];
  summary: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function docArray(body: any): any[] {
  if (Array.isArray(body)) return body;
  return body?.data ?? body?.content ?? body?.items ?? body?.documents ?? [];
}

/**
 * Upload one document's bytes and return the file id.
 *
 * The dataset document endpoint takes a fileId and nothing else — no raw text,
 * no URL — so inline text has to become a real file first. It also does not
 * validate the fileId it is handed, which is how a document ends up pointing at
 * a file that is not in the workspace.
 */
async function uploadDoc(client: SwfteClient, doc: KnowledgeDocInput, workspaceId?: string): Promise<string> {
  let filePath = doc.path;
  let cleanup: string | undefined;

  if (!filePath) {
    if (typeof doc.text !== 'string' || doc.text.trim().length === 0) {
      throw new Error(`Document "${doc.name}" has neither a path nor non-empty text.`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'swfte-kb-'));
    filePath = join(dir, doc.name.endsWith('.md') ? doc.name : `${doc.name}.md`);
    writeFileSync(filePath, doc.text, 'utf8');
    cleanup = dir;
  }

  try {
    const { readFileSync } = await import('node:fs');
    const bytes = new Uint8Array(readFileSync(filePath));
    if (bytes.byteLength === 0) {
      throw new Error(`Document "${doc.name}" is zero bytes — indexing it would produce a COMPLETED document with no segments.`);
    }

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: doc.mimeType ?? 'text/markdown' }), doc.name);

    const uploaded = await client.postMultipart<any>(`${FILES}/upload`, form, { workspaceId });
    const fileId = uploaded?.id ?? uploaded?.fileId ?? uploaded?.data?.id;
    if (!fileId) {
      throw new Error(`Upload returned no file id: ${JSON.stringify(uploaded).slice(0, 300)}`);
    }
    return String(fileId);
  } finally {
    if (cleanup) {
      try {
        rmSync(cleanup, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
  }
}

/**
 * Retrieval probe: the acceptance test.
 *
 * A document row can say COMPLETED while the vector namespace is empty. This is
 * the only call that distinguishes the two, and it costs one embedding.
 */
async function probe(
  client: SwfteClient,
  datasetId: string,
  query: string,
  workspaceId?: string
): Promise<{ candidatesRetrieved: number; resultsReturned: number; sample?: string }> {
  const res = await client.request<any>({
    method: 'POST',
    path: RAG_SEARCH,
    body: { query, datasetIds: [datasetId], topK: 5 },
    workspaceId,
    retries: 1,
    timeoutMs: 60_000,
  });
  const results: any[] = Array.isArray(res?.results) ? res.results : [];
  const meta = res?.metadata ?? {};
  const first = results[0];
  return {
    candidatesRetrieved: num(meta.candidatesRetrieved) || results.length,
    resultsReturned: num(meta.resultsReturned) || results.length,
    sample: first ? String(first.content ?? first.text ?? first.chunk ?? '').slice(0, 160) : undefined,
  };
}

export async function buildKnowledge(client: SwfteClient, input: BuildKnowledgeInput): Promise<BuildKnowledgeReport> {
  const checks: VerifyCheck[] = [];
  const nextActions: string[] = [];
  const waitMs = input.waitMs ?? 180_000;

  // 1 — create the dataset.
  const created = await client.request<any>({
    method: 'POST',
    path: DATASETS,
    body: {
      name: input.name,
      description: input.description,
      // Enum-valued fields travel UPPERCASE or the API rejects the body as malformed.
      indexingTechnique: input.indexingTechnique ?? 'HIGH_QUALITY',
      permission: input.permission ?? 'ONLY_ME',
    },
    workspaceId: input.workspaceId,
    expectStatuses: [200, 201],
    retries: 0,
    timeoutMs: 60_000,
  });
  const datasetId = String(created?.id ?? created?.datasetId ?? created?.data?.id ?? '');
  if (!datasetId) {
    throw new Error(`Dataset create returned no id: ${JSON.stringify(created).slice(0, 300)}`);
  }
  checks.push({ id: 'dataset-created', ok: true, detail: `${DATASETS}/${datasetId} ("${input.name}")` });

  // 2 — upload and attach, one document per call.
  const attached: Array<{ name: string; fileId: string }> = [];
  for (const doc of input.documents) {
    const fileId = await uploadDoc(client, doc, input.workspaceId);

    // Confirm the uploaded file is actually in the workspace before attaching.
    // A document that points at a missing file still indexes to COMPLETED, and
    // that is exactly the state that shipped last time.
    let fileConfirmed = false;
    try {
      await client.request({ method: 'GET', path: `${FILES}/${encodeURIComponent(fileId)}`, retries: 1 });
      fileConfirmed = true;
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({
        id: `file-readable:${doc.name}`,
        ok: false,
        detail:
          `Uploaded file ${fileId} did not read back (${msg.slice(0, 120)}). Attaching it anyway would ` +
          'produce a document that reports COMPLETED with zero segments.',
      });
      nextActions.push(`Re-upload "${doc.name}" — the file store did not confirm ${fileId}.`);
    }
    if (fileConfirmed) {
      checks.push({ id: `file-readable:${doc.name}`, ok: true, detail: `file ${fileId} confirmed in the workspace` });
    }

    await client.request({
      method: 'POST',
      path: `${DATASETS}/${encodeURIComponent(datasetId)}/documents`,
      // datasetId is repeated in the body: the controller reads it from there,
      // not from the path, and rejects the call without it.
      body: { datasetId, fileId, name: doc.name, dataSourceType: 'upload_file' },
      workspaceId: input.workspaceId,
      expectStatuses: [200, 201, 202],
      retries: 0,
      timeoutMs: 60_000,
    });
    attached.push({ name: doc.name, fileId });
  }

  // 3 — wait for indexing to reach a terminal state.
  const deadline = Date.now() + waitMs;
  let rows: any[] = [];
  for (;;) {
    const listed = await client.request<any>({
      method: 'GET',
      path: `${DATASETS}/${encodeURIComponent(datasetId)}/documents`,
      query: { size: 100 },
      workspaceId: input.workspaceId,
      retries: 1,
    });
    rows = docArray(listed);
    const pending = rows.filter((r) => !TERMINAL.has(String(r?.indexingStatus ?? '').toUpperCase()));
    if (rows.length >= attached.length && pending.length === 0) break;
    if (Date.now() >= deadline) break;
    await sleep(3_000);
  }

  // 4 — judge each document on segments, not on status.
  const documents: KnowledgeDocResult[] = rows.map((r) => {
    const status = String(r?.indexingStatus ?? 'UNKNOWN').toUpperCase();
    const totalSegments = num(r?.totalSegments);
    const wordCount = num(r?.wordCount);
    const indexedOk = status === 'COMPLETED' && totalSegments > 0;
    return {
      documentId: String(r?.id ?? ''),
      name: String(r?.name ?? ''),
      fileId: String(r?.fileId ?? ''),
      indexingStatus: status,
      totalSegments,
      wordCount,
      ok: indexedOk,
      detail: indexedOk
        ? `${status}, ${totalSegments} segment(s)`
        : status === 'COMPLETED'
          ? `${status} with totalSegments 0 — the document reports success and holds nothing. ` +
            'The data-runtime ingest path sets COMPLETED without writing the segment counters, and a ' +
            'document whose source file is missing takes the same path.'
          : `${status}${r?.error ? ` — ${String(r.error).slice(0, 120)}` : ''}`,
    };
  });

  const emptyCompleted = documents.filter((d) => d.indexingStatus === 'COMPLETED' && d.totalSegments === 0);
  const allSegmented = documents.length > 0 && documents.every((d) => d.ok);

  checks.push({
    id: 'segments',
    ok: allSegmented,
    detail: allSegmented
      ? `${documents.length} document(s), all with segments`
      : `${emptyCompleted.length} of ${documents.length} document(s) report COMPLETED with zero segments`,
  });
  if (!allSegmented) {
    nextActions.push(
      'Do not ground anything on this dataset yet — retrieval against a zero-segment document returns nothing. ' +
        'Backend fix: write chunk_count into totalSegments before marking COMPLETED on the data-runtime path.'
    );
  }

  // 5 — the retrieval probe. The status field is a claim; this is the evidence.
  const query = input.probeQuery ?? input.description ?? input.name;
  let probeResult: BuildKnowledgeReport['probe'];
  try {
    const p = await probe(client, datasetId, query, input.workspaceId);
    probeResult = { query, ...p };
    const retrieves = p.candidatesRetrieved > 0;
    checks.push({
      id: 'retrieves',
      ok: retrieves,
      detail: retrieves
        ? `${p.candidatesRetrieved} candidate(s) retrieved${p.sample ? ` — "${p.sample}"` : ''}`
        : 'Retrieval returned 0 candidates. Whatever the document status says, this dataset grounds nothing.',
    });
    if (!retrieves) {
      nextActions.push('Retrieval returns nothing — treat this dataset as empty regardless of its COMPLETED status.');
    }
  } catch (err) {
    const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
    checks.push({ id: 'retrieves', ok: null, detail: `Probe could not run: ${msg.slice(0, 160)}` });
  }

  const ok = checks.every((c) => c.ok !== false);
  if (ok) {
    nextActions.push(
      'To ground an agent on this: mint a KnowledgeModule with datasetId set, then put the MODULE id in ' +
        'knowledgeModuleIds — a dataset id there resolves to a silent skip.'
    );
  }

  return {
    ok,
    datasetId,
    name: input.name,
    documents,
    checks,
    probe: probeResult,
    nextActions,
    summary: ok
      ? `Dataset ${datasetId} holds ${documents.length} indexed document(s) and answers a retrieval probe.`
      : `Dataset ${datasetId} was created but is not usable: ${checks.filter((c) => c.ok === false).map((c) => c.id).join(', ')}.`,
  };
}
