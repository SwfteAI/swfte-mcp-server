/**
 * Compliance control plane tools (CONTRACT rev 7).
 *
 * Assess an artifact, scan code, read and verify a Control Evidence Record,
 * export the workspace's evidence, and read one control's history. Attesting
 * and issuing a record are deliberately not offered: the backend requires an
 * interactive session and an independent person, so the tools hand back the
 * Studio link instead.
 *
 * Every output follows the plane's wording rules: UNAVAILABLE reads as "not
 * checked" and is never counted as passing, and nothing says "certified",
 * "compliant" or "tamper-proof".
 */
import { z } from 'zod';
import {
  assess,
  checkJsonExport,
  collectInlineFiles,
  collectLocalFiles,
  COMPLIANCE_BASE,
  COMPLIANCE_KINDS,
  describeVerdict,
  getEvidenceRecord,
  RECORD_WORDING,
  resolveTarget,
  scanFiles,
  sha256Hex,
  summarizeAssessment,
  type SigningKey,
} from '../compliance.js';
import { assertLocalFilesystem, ConfinedWriter } from '../fsguard.js';
import type { ToolDefinition } from './_types.js';

const TargetArg = z
  .union([
    z.string().describe('"<kind>:<id>", e.g. "workflow:wf_123".'),
    z.object({ kind: z.enum(COMPLIANCE_KINDS), id: z.string().min(1) }),
  ])
  .describe(`The artifact. Kinds: ${COMPLIANCE_KINDS.join(', ')}.`);

const INLINE_ALTERNATIVE = 'Pass the code inline as `files: [{path, content}]` or `snippet` instead.';

/** Largest export returned inline; larger ones need savePath (stdio only). */
const EXPORT_INLINE_BYTES = 200 * 1024;

export const complianceTools: ToolDefinition[] = [
  {
    name: 'swfte_compliance_assess',
    title: 'Assess an artifact against compliance controls',
    description:
      'POST /v2/compliance/assess: check a workflow, agent, chatflow, model, MCP server or application against the ' +
      'versioned control catalog (optionally only some frameworks, e.g. ["SOC2","OWASP_LLM"]). Returns the summary, ' +
      'blocking controls, each failing control with its evidence and remediation, and the controls that were NOT ' +
      'checked (UNAVAILABLE, with the reason) — those are never a pass. ok is true only when the assessment is ' +
      `record-eligible. Attesting and issuing a ${RECORD_WORDING.split(' —')[0]} happen in Studio (link returned). ` +
      RECORD_WORDING,
    inputSchema: z.object({
      catalogRef: z.string().optional().describe('"<kind>:<id>" from swfte_find_existing. Or pass target.'),
      target: TargetArg.optional(),
      frameworks: z.array(z.string().min(1)).max(20).optional().describe('Framework ids; omit for every framework with a control for the kind.'),
    }),
    execute: async (input, { client }) => {
      const target = resolveTarget(input);
      const a = await assess(client, target, input.frameworks);
      return summarizeAssessment(a);
    },
  },
  {
    name: 'swfte_compliance_scan_code',
    title: 'Scan code for security and compliance findings',
    description:
      'Sends code to POST /v2/compliance/scan and returns findings by file, line, rule, severity and control ' +
      '(e.g. secrets, injection, SSRF, PII logging). Local mode reads paths/globs under the working directory only ' +
      '(respects .gitignore; symlinks, credential files such as .env and keys, binaries and files over 200 KB are ' +
      'reported, never uploaded) and batches ≤50 files / 600 KB per request. Hosted mode refuses paths; pass files ' +
      'inline. verdict: FAIL (critical/high), PARTIAL (medium/low only), PASS (nothing found and everything checked), ' +
      'UNAVAILABLE (something not checked — not a pass). The server does not keep the code.',
    inputSchema: z.object({
      paths: z.array(z.string().min(1)).max(200).optional().describe('Files or directories, relative to the project root.'),
      globs: z.array(z.string().min(1)).max(50).optional().describe('e.g. ["src/**/*.ts"]. Relative, no "..".'),
      files: z
        .array(z.object({ path: z.string().min(1), content: z.string() }))
        .max(200)
        .optional()
        .describe('Inline code (works on a hosted server).'),
      snippet: z.string().max(200_000).optional().describe('A single piece of code, no file.'),
      language: z.string().optional().describe('Hint, e.g. "typescript", "python". Default: inferred per file.'),
      retain: z.boolean().optional().describe('Keep the result (never the code) as scan evidence. Default false.'),
    }),
    execute: async (input, { client, localFilesystem }) => {
      const wantsDisk = Boolean(input.paths?.length || input.globs?.length);
      if (!wantsDisk && !input.files?.length && !input.snippet) throw new Error('Pass paths, globs, files (inline) or snippet.');
      if (wantsDisk) assertLocalFilesystem(localFilesystem, 'swfte_compliance_scan_code paths/globs', INLINE_ALTERNATIVE);
      const local = wantsDisk ? collectLocalFiles({ paths: input.paths, globs: input.globs }) : { files: [], notScanned: [], notes: [] };
      const inline = input.files?.length ? collectInlineFiles(input.files) : { files: [], notScanned: [] };
      return scanFiles(client, {
        files: [...local.files, ...inline.files],
        notScanned: [...local.notScanned, ...inline.notScanned],
        notes: local.notes,
        snippet: input.snippet,
        language: input.language,
        retain: input.retain,
      });
    },
  },
  {
    name: 'swfte_get_evidence_record',
    title: 'Read and verify a Control Evidence Record',
    readOnly: true,
    description:
      'GET /v2/compliance/evidence-records/{id}, then (unless verify:false) the server verification — signature, ' +
      'status, and whether the artifact still has the content hash the record was issued for — plus an offline ' +
      'Ed25519 check against the published signing key when possible. conclusion: VALID_AND_CURRENT, STALE, EXPIRED, ' +
      `REVOKED, INVALID_SIGNATURE or UNVERIFIABLE. ${RECORD_WORDING}`,
    inputSchema: z.object({
      id: z.string().min(1).describe('Record id (cer_…).'),
      verify: z.boolean().optional().describe('Default true.'),
    }),
    execute: async (input, { client }) => getEvidenceRecord(client, input.id, { verify: input.verify }),
  },
  {
    name: 'swfte_compliance_export',
    title: 'Export compliance evidence (JSON or CSV)',
    description:
      'GET /v2/compliance/export: the control matrix, assessment events, attestations and evidence records for the ' +
      'workspace (optionally one framework and a from/to window). The manifest hash is recomputed locally and the ' +
      'signature checked offline when the key allows. savePath writes the export into the project (stdio only, never ' +
      'overwrites without force); otherwise it is returned inline up to 200 KB. Supports your audit; not an audit opinion.',
    inputSchema: z.object({
      format: z.enum(['json', 'csv']).optional().describe('Default json.'),
      framework: z.string().optional(),
      from: z.string().optional().describe('ISO-8601.'),
      to: z.string().optional().describe('ISO-8601.'),
      savePath: z.string().optional().describe('File path relative to the project root.'),
      force: z.boolean().optional().describe('Replace an existing savePath.'),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      if (input.savePath) assertLocalFilesystem(localFilesystem, 'swfte_compliance_export savePath', 'Omit savePath to get the export inline.');
      const format = input.format ?? 'json';
      const query = { format, framework: input.framework, from: input.from, to: input.to };
      const key = await client
        .request<SigningKey>({ method: 'GET', path: `${COMPLIANCE_BASE}/evidence-records/signing-key`, retries: 1 })
        .catch(() => null);

      let text: string;
      let integrity: Record<string, unknown>;
      let summary: Record<string, unknown>;
      if (format === 'json') {
        const body = await client.request<Record<string, any>>({ method: 'GET', path: `${COMPLIANCE_BASE}/export`, query, retries: 1, timeoutMs: 180_000 });
        text = JSON.stringify(body, null, 2);
        integrity = checkJsonExport(body, key);
        summary = {
          manifest: body?.manifest ?? null,
          counts: {
            controlMatrix: Array.isArray(body?.controlMatrix) ? body.controlMatrix.length : 0,
            assessmentEvents: Array.isArray(body?.assessmentEvents) ? body.assessmentEvents.length : 0,
            attestations: Array.isArray(body?.attestations) ? body.attestations.length : 0,
            evidenceRecords: Array.isArray(body?.evidenceRecords) ? body.evidenceRecords.length : 0,
          },
        };
      } else {
        const res = await client.getBinary(`${COMPLIANCE_BASE}/export`, { query, timeoutMs: 180_000 });
        text = Buffer.from(res.bytes).toString('utf8');
        const declared = (res.headers['x-swfte-export-csv-sha256'] ?? '').replace(/^sha256:/, '');
        const computed = sha256Hex(res.bytes);
        integrity = {
          computedCsvSha256: computed,
          declaredCsvSha256: declared || null,
          csvHashMatches: Boolean(declared) && declared === computed,
          bodySha256: res.headers['x-swfte-export-body-sha256'] ?? null,
          signature: res.headers['x-swfte-export-signature'] ?? null,
          keyId: res.headers['x-swfte-export-key-id'] ?? null,
        };
        summary = { rows: Math.max(0, text.split(/\r?\n/).filter(Boolean).length - 1) };
      }

      const bytes = Buffer.byteLength(text, 'utf8');
      let saved: unknown = null;
      if (input.savePath) {
        const writer = new ConfinedWriter({ forbidden: [config.credential] });
        writer.create(writer.resolve(input.savePath), text, Boolean(input.force));
        saved = writer.commit();
      }
      const intact = format === 'json' ? (integrity as any).bodyHashMatches : (integrity as any).csvHashMatches;
      return {
        format,
        bytes,
        ...summary,
        integrity,
        integrityConclusion: intact ? 'hash matches the manifest' : 'hash does NOT match the manifest, or none was declared — do not rely on this export',
        ...(saved ? { saved } : bytes <= EXPORT_INLINE_BYTES ? { content: text } : { content: null, note: `Export is ${Math.round(bytes / 1024)} KB; pass savePath to write it into the project.` }),
        wording: 'Supports your audit; not an audit opinion.',
      };
    },
  },
  {
    name: 'swfte_compliance_history',
    title: 'One control\'s verdict history for an artifact',
    readOnly: true,
    description:
      'GET /v2/compliance/controls/{controlId}/history: every assessment of one control on one artifact (oldest first) ' +
      'and the intervals it held each verdict, optionally within from/to. UNAVAILABLE intervals read as "not checked", ' +
      'never as passing.',
    inputSchema: z.object({
      controlId: z.string().min(1).describe('e.g. "SOC2.CC6.1".'),
      target: TargetArg.optional(),
      catalogRef: z.string().optional().describe('Alternative to target.'),
      from: z.string().optional().describe('ISO-8601.'),
      to: z.string().optional().describe('ISO-8601.'),
    }),
    execute: async (input, { client }) => {
      const t = resolveTarget(input);
      const h = await client.request<Record<string, any>>({
        method: 'GET',
        path: `${COMPLIANCE_BASE}/controls/${encodeURIComponent(input.controlId)}/history`,
        query: { target: `${t.kind}:${t.id}`, from: input.from, to: input.to },
        retries: 1,
      });
      const points = Array.isArray(h?.points) ? h.points : [];
      const intervals = Array.isArray(h?.intervals) ? h.intervals : [];
      const latest = points.at(-1);
      return {
        controlId: h?.controlId ?? input.controlId,
        target: h?.target ?? `${t.kind}:${t.id}`,
        from: h?.from ?? input.from ?? null,
        to: h?.to ?? input.to ?? null,
        current: latest ? { verdict: latest.verdict, meaning: describeVerdict(latest.verdict), assessedAt: latest.assessedAt, contentHash: latest.contentHash } : null,
        intervals: intervals.map((i: any) => ({ ...i, meaning: describeVerdict(i.verdict) })),
        points: points.map((p: any) => ({ ...p, meaning: describeVerdict(p.verdict) })),
        truncated: Boolean(h?.truncated),
        notes: h?.notes ?? [],
        ...(points.length ? {} : { note: 'No assessment of this control on this artifact in the window. That is "never assessed", not a pass.' }),
      };
    },
  },
];
