/**
 * Compliance control plane client (CONTRACT rev 7, `/v2/compliance`).
 *
 * Shared by the MCP tools (src/tools/compliance.ts) and the CLI
 * (`swfte verify --compliance`, the scan after `swfte add`), so both say the
 * same thing about the same result.
 *
 * Honesty rules this file enforces rather than trusts:
 *   - UNAVAILABLE is "not checked", never a pass. It is counted and listed on
 *     its own and never folded into a passing number.
 *   - An incomplete scan is never PASS: a file that was too large, binary, a
 *     credential file, or in a batch the server could not scan makes the
 *     overall verdict UNAVAILABLE unless something already failed.
 *   - Nothing here says "certified", "compliant" or "tamper-proof". The signed
 *     artifact is a Control Evidence Record, which supports an audit and is not
 *     an audit opinion.
 *   - Local files are read only through fsguard: confined under the working
 *     directory, symlinks not followed, never from a hosted server's disk.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { CATALOG_KINDS, parseCatalogRef, stableStringify } from './catalog.js';
import type { SwfteClient } from './client.js';
import { confinementRoot, confinePath, isInside, PathConfinementError } from './fsguard.js';

export const COMPLIANCE_BASE = '/v2/compliance';

/** Kinds the plane can assess. `code` is scan-only; widget, module and solution are not assessable. */
export const COMPLIANCE_KINDS = ['workflow', 'agent', 'chatflow', 'model', 'mcp-server', 'application'] as const;
export type ComplianceKind = (typeof COMPLIANCE_KINDS)[number];

export const RECORD_WORDING = 'Control Evidence Record — supports your audit; not an audit opinion.';
export const NOT_CHECKED = 'not checked — this is not a pass';

/** Words no output of this module may contain (the plane's own rule, applied client-side too). */
export const FORBIDDEN_WORDS = /\b(certified|compliant|tamper-proof)\b/i;

/* ── wire types (CONTRACT rev 7) ──────────────────────────────────────────── */

export type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface EvidenceRef {
  type: string;
  ref: string;
  detail?: string;
}
export interface CheckResult {
  checkId: string;
  verdict: Verdict;
  source: string;
  summary: string;
  evidence?: EvidenceRef[];
  unavailableReason?: string;
}
export interface ControlResult {
  controlId: string;
  frameworkId: string;
  title: string;
  refs?: string[];
  severity: Severity;
  required: boolean;
  evidenceType?: string;
  verdict: Verdict;
  checks?: CheckResult[];
  remediation?: string;
}
export interface Assessment {
  id: string;
  target: { kind: string; id: string };
  contentHash: string;
  catalogVersion: string;
  frameworks: string[];
  results: ControlResult[];
  summary: { pass: number; fail: number; partial: number; unavailable: number; notApplicable: number; requiredTotal: number; requiredPassing: number };
  recordEligible: boolean;
  blockingControls: string[];
  createdAt: string;
  notes?: string[];
  verdictSource?: string;
}

export interface ScanFinding {
  ruleId: string;
  severity: Severity;
  file: string;
  line: number;
  excerpt: string | null;
  message: string;
  remediation: string;
  controls: string[];
}
export interface ScanResponse {
  scanId: string;
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'UNAVAILABLE';
  findings: ScanFinding[];
  summary: { critical: number; high: number; medium: number; low: number };
  files?: { path: string; sha256: string }[];
  filesScanned: number;
  bytesScanned: number;
  complete: boolean;
  coverageNotes?: string[];
  rulesRun?: string[];
  failingControls?: string[];
  stored?: boolean;
  catalogVersion?: string;
  scannedAt?: string;
  note?: string;
}

/* ── targets ──────────────────────────────────────────────────────────────── */

export interface Target {
  kind: ComplianceKind;
  id: string;
}

/** `{catalogRef}` or `{target}` (object or "kind:id") → an assessable target, or a clear refusal. */
export function resolveTarget(input: { catalogRef?: string; target?: string | { kind: string; id: string } }): Target {
  let kind: string;
  let id: string;
  if (input.catalogRef) {
    const r = parseCatalogRef(input.catalogRef);
    kind = r.kind;
    id = r.id;
  } else if (typeof input.target === 'string') {
    const at = input.target.indexOf(':');
    if (at <= 0 || !input.target.slice(at + 1).trim()) throw new Error(`Invalid target "${input.target}" — expected "<kind>:<id>".`);
    kind = input.target.slice(0, at);
    id = input.target.slice(at + 1).trim();
  } else if (input.target && typeof input.target === 'object') {
    kind = input.target.kind;
    id = String(input.target.id ?? '').trim();
  } else {
    throw new Error('Pass catalogRef ("<kind>:<id>") or target {kind, id}.');
  }
  if (!id) throw new Error('Target id is empty.');
  if (!(COMPLIANCE_KINDS as readonly string[]).includes(kind)) {
    const known = (CATALOG_KINDS as readonly string[]).includes(kind);
    throw new Error(
      `${known ? `Kind "${kind}" is not assessable` : `Unknown kind "${kind}"`}: the compliance plane assesses ` +
        `${COMPLIANCE_KINDS.join(', ')}. Generated code is checked with swfte_compliance_scan_code instead.`
    );
  }
  return { kind: kind as ComplianceKind, id };
}

export function studioComplianceUrl(target: Target, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.SWFTE_STUDIO_URL?.trim() || 'https://studio.swfte.com').replace(/\/+$/, '');
  return `${base}/v2/studio/compliance?target=${encodeURIComponent(`${target.kind}:${target.id}`)}`;
}

/* ── assess ───────────────────────────────────────────────────────────────── */

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const bySeverity = <T extends { severity: string }>(a: T, b: T) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);

export async function assess(client: SwfteClient, target: Target, frameworks?: string[]): Promise<Assessment> {
  return client.request<Assessment>({
    method: 'POST',
    path: `${COMPLIANCE_BASE}/assess`,
    body: { target, ...(frameworks && frameworks.length ? { frameworks } : {}) },
    retries: 0,
    timeoutMs: 120_000,
  });
}

/** What a person needs from an assessment: what failed, how to fix it, and what was not checked. */
export function summarizeAssessment(a: Assessment, env: NodeJS.ProcessEnv = process.env) {
  const results = Array.isArray(a.results) ? a.results : [];
  const evidenceOf = (c: ControlResult) =>
    (c.checks ?? [])
      .filter((k) => k.verdict === 'FAIL' || k.verdict === 'PARTIAL')
      .map((k) => ({ checkId: k.checkId, verdict: k.verdict, summary: k.summary, evidence: (k.evidence ?? []).slice(0, 10) }));
  const failing = results
    .filter((c) => c.verdict === 'FAIL' || c.verdict === 'PARTIAL')
    .sort(bySeverity)
    .map((c) => ({
      controlId: c.controlId,
      frameworkId: c.frameworkId,
      title: c.title,
      severity: c.severity,
      required: c.required,
      verdict: c.verdict,
      refs: c.refs ?? [],
      remediation: c.remediation ?? null,
      failingChecks: evidenceOf(c),
    }));
  const notChecked = results
    .filter((c) => c.verdict === 'UNAVAILABLE')
    .map((c) => {
      const reasons = [...new Set((c.checks ?? []).filter((k) => k.verdict === 'UNAVAILABLE').map((k) => k.unavailableReason ?? 'UNKNOWN'))];
      return {
        controlId: c.controlId,
        title: c.title,
        required: c.required,
        status: NOT_CHECKED,
        reasons: reasons.length ? reasons : ['UNKNOWN'],
        ...(reasons.includes('ATTESTATION_REQUIRED') ? { action: 'A person attests to this in Studio (interactive session only).' } : {}),
        remediation: c.remediation ?? null,
      };
    });
  const s = a.summary ?? ({} as Assessment['summary']);
  const target = a.target as Target;
  return {
    outcome: a.recordEligible ? 'RECORD_ELIGIBLE' : 'NOT_RECORD_ELIGIBLE',
    ok: Boolean(a.recordEligible),
    assessmentId: a.id,
    target: a.target,
    contentHash: a.contentHash,
    catalogVersion: a.catalogVersion,
    frameworks: a.frameworks,
    assessedAt: a.createdAt,
    verdictSource: a.verdictSource ?? 'deterministic',
    summary: {
      passing: s.pass ?? 0,
      failing: s.fail ?? 0,
      partial: s.partial ?? 0,
      notChecked: s.unavailable ?? 0,
      notApplicable: s.notApplicable ?? 0,
      requiredPassing: s.requiredPassing ?? 0,
      requiredTotal: s.requiredTotal ?? 0,
    },
    blockingControls: a.blockingControls ?? [],
    failing,
    notChecked,
    notes: a.notes ?? [],
    nextSteps: [
      ...(failing.length ? ['Apply each failing control\'s remediation, then call swfte_compliance_assess again.'] : []),
      ...(notChecked.length
        ? [`${notChecked.length} control(s) were not checked. They count against nothing and pass nothing; required ones block a record until checked or attested.`]
        : []),
      a.recordEligible
        ? `Every required control passes. A signed-in reviewer who did not author, modify, assess or attest this artifact can issue a ${RECORD_WORDING.split(' —')[0]} in Studio: ${studioComplianceUrl(target, env)}`
        : `Attestation and record issuance need an interactive Studio session: ${studioComplianceUrl(target, env)}`,
    ],
    wording: RECORD_WORDING,
  };
}

/* ── local file collection ────────────────────────────────────────────────── */

export const SCAN_LIMITS = {
  /** Per file (CONTRACT rev 7). Larger files are reported, never uploaded. */
  fileBytes: 200 * 1024,
  /** Per request. */
  batchBytes: 600 * 1024,
  batchFiles: 50,
  /** Per invocation, so a stray glob cannot upload a whole monorepo. */
  totalFiles: 1_000,
  totalBytes: 20 * 1024 * 1024,
} as const;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', '__pycache__', '.venv', 'venv', '.tox', 'target', 'vendor']);

/** Files that hold credentials rather than code. Never uploaded, whatever the pattern says. */
export function isCredentialFile(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (/^\.env(\..*)?$/i.test(base)) return !/\.(example|sample|template)$/i.test(base);
  return /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i.test(base) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(base) || /^\.(npmrc|pypirc|netrc)$/i.test(base);
}

/** Minimal glob → RegExp: `**`, `*`, `?`, `{a,b}`, character classes. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inBrace = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inBrace++;
      re += '(?:';
    } else if (c === '}' && inBrace) {
      inBrace--;
      re += ')';
    } else if (c === ',' && inBrace) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end + 1;
        continue;
      }
      re += '\\[';
    } else re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** Root .gitignore patterns as matchers (negations are not supported and are reported). */
function gitignoreMatchers(root: string): { match: (rel: string, isDir: boolean) => boolean; notes: string[] } {
  let text = '';
  try {
    text = readFileSync(join(root, '.gitignore'), 'utf8');
  } catch {
    return { match: () => false, notes: [] };
  }
  const notes: string[] = [];
  const rules: { re: RegExp; dirOnly: boolean }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      notes.push(`.gitignore negation "${line}" is not applied by the scanner; name that path explicitly to include it.`);
      continue;
    }
    const dirOnly = line.endsWith('/');
    let pat = line.replace(/\/+$/, '');
    const anchored = pat.includes('/');
    pat = pat.replace(/^\/+/, '');
    rules.push({ re: globToRegExp(anchored ? pat : `**/${pat}`), dirOnly });
  }
  return { match: (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(rel)), notes };
}

export interface CollectedFile {
  path: string;
  content: string;
}
export interface NotScanned {
  path: string;
  reason: string;
}

/**
 * Resolve `paths` (files or directories) and `globs` under the working
 * directory into file contents, every one through fsguard. Nothing outside the
 * root is read; symlinks are not followed; credential files, binaries and
 * files over the size cap are reported rather than read.
 */
export function collectLocalFiles(opts: { paths?: string[]; globs?: string[]; root?: string }): { files: CollectedFile[]; notScanned: NotScanned[]; notes: string[] } {
  const root = confinementRoot(opts.root);
  const files: CollectedFile[] = [];
  const notScanned: NotScanned[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const ignore = gitignoreMatchers(root);
  notes.push(...ignore.notes);
  let totalBytes = 0;
  const rel = (abs: string) => relative(root, abs).split(sep).join('/');

  const addFile = (abs: string, explicit: boolean) => {
    const r = rel(abs);
    if (seen.has(r)) return;
    seen.add(r);
    if (isCredentialFile(r)) return notScanned.push({ path: r, reason: 'credential file — never uploaded' });
    if (!explicit && ignore.match(r, false)) return;
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return notScanned.push({ path: r, reason: 'no such file' });
    }
    if (st.isSymbolicLink()) return notScanned.push({ path: r, reason: 'symlink — not followed' });
    if (!st.isFile()) return notScanned.push({ path: r, reason: 'not a regular file' });
    if (st.size > SCAN_LIMITS.fileBytes) return notScanned.push({ path: r, reason: `over ${SCAN_LIMITS.fileBytes / 1024} KB — not uploaded` });
    if (files.length >= SCAN_LIMITS.totalFiles || totalBytes + st.size > SCAN_LIMITS.totalBytes) {
      return notScanned.push({ path: r, reason: `per-run cap reached (${SCAN_LIMITS.totalFiles} files / ${SCAN_LIMITS.totalBytes / 1024 / 1024} MB)` });
    }
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return notScanned.push({ path: r, reason: 'binary — not uploaded' });
    totalBytes += buf.length;
    files.push({ path: r, content: buf.toString('utf8') });
  };

  const walk = (dir: string, visit: (abs: string) => void) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || ignore.match(rel(abs), true)) continue;
        walk(abs, visit);
      } else if (st.isFile()) visit(abs);
    }
  };

  for (const p of opts.paths ?? []) {
    const abs = confinePath(p, root);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      notScanned.push({ path: rel(abs) || p, reason: 'no such file' });
      continue;
    }
    if (st.isSymbolicLink()) {
      notScanned.push({ path: rel(abs), reason: 'symlink — not followed' });
      continue;
    }
    if (st.isDirectory()) walk(abs, (f) => addFile(f, false));
    else addFile(abs, true);
  }

  if (opts.globs?.length) {
    const res = opts.globs.map((g) => {
      if (g.includes('\0')) throw new PathConfinementError('Glob contains a NUL byte.');
      const clean = g.replace(/^\.\/+/, '');
      if (clean.startsWith('/') || clean.split('/').includes('..')) {
        throw new PathConfinementError(`Refusing glob "${g}": globs are relative to the working directory and may not contain "..".`);
      }
      return globToRegExp(clean);
    });
    walk(root, (abs) => {
      if (!isInside(root, abs)) return;
      const r = rel(abs);
      if (res.some((re) => re.test(r))) addFile(abs, false);
    });
  }
  return { files, notScanned, notes };
}

/** Inline files (hosted mode, or content the caller already holds). Same caps, no disk. */
export function collectInlineFiles(inline: { path: string; content: string }[]): { files: CollectedFile[]; notScanned: NotScanned[] } {
  const files: CollectedFile[] = [];
  const notScanned: NotScanned[] = [];
  let total = 0;
  for (const f of inline) {
    const path = String(f.path ?? '').replace(/\\/g, '/');
    if (!path.trim() || path.includes('\0')) {
      notScanned.push({ path: path || '(empty)', reason: 'invalid path' });
      continue;
    }
    if (isCredentialFile(path)) {
      notScanned.push({ path, reason: 'credential file — never uploaded' });
      continue;
    }
    const bytes = Buffer.byteLength(f.content ?? '', 'utf8');
    if (bytes > SCAN_LIMITS.fileBytes) {
      notScanned.push({ path, reason: `over ${SCAN_LIMITS.fileBytes / 1024} KB — not uploaded` });
      continue;
    }
    if (files.length >= SCAN_LIMITS.totalFiles || total + bytes > SCAN_LIMITS.totalBytes) {
      notScanned.push({ path, reason: 'per-run cap reached' });
      continue;
    }
    total += bytes;
    files.push({ path, content: f.content ?? '' });
  }
  return { files, notScanned };
}

/** Split into batches of ≤ 50 files and ≤ 600 KB (CONTRACT rev 7 per-request limits). */
export function batchFiles(files: CollectedFile[]): CollectedFile[][] {
  const batches: CollectedFile[][] = [];
  let cur: CollectedFile[] = [];
  let bytes = 0;
  for (const f of files) {
    const b = Buffer.byteLength(f.content, 'utf8') + Buffer.byteLength(f.path, 'utf8');
    if (cur.length && (cur.length >= SCAN_LIMITS.batchFiles || bytes + b > SCAN_LIMITS.batchBytes)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += b;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/* ── scan ─────────────────────────────────────────────────────────────────── */

export interface ScanReport {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'UNAVAILABLE';
  /** true when nothing HIGH or CRITICAL was found and every file was checked. */
  ok: boolean;
  summary: { critical: number; high: number; medium: number; low: number };
  findings: ScanFinding[];
  byFile: Record<string, string[]>;
  failingControls: string[];
  filesScanned: number;
  bytesScanned: number;
  complete: boolean;
  notScanned: NotScanned[];
  batchErrors: string[];
  coverageNotes: string[];
  scanIds: string[];
  note: string;
}

/** The contract's verdict rule over merged results: an incomplete scan with no findings is UNAVAILABLE, never PASS. */
export function scanVerdict(summary: ScanReport['summary'], complete: boolean): ScanReport['verdict'] {
  if (summary.critical + summary.high > 0) return 'FAIL';
  if (summary.medium + summary.low > 0) return 'PARTIAL';
  return complete ? 'PASS' : 'UNAVAILABLE';
}

export async function scanFiles(
  client: SwfteClient,
  input: { files: CollectedFile[]; notScanned?: NotScanned[]; notes?: string[]; snippet?: string; language?: string; retain?: boolean; context?: string }
): Promise<ScanReport> {
  const findings: ScanFinding[] = [];
  const summary = { critical: 0, high: 0, medium: 0, low: 0 };
  const failingControls = new Set<string>();
  const coverageNotes = [...(input.notes ?? [])];
  const batchErrors: string[] = [];
  const scanIds: string[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let complete = true;

  const requests: { files?: CollectedFile[]; snippet?: string }[] = batchFiles(input.files).map((b) => ({ files: b }));
  if (input.snippet) requests.push({ snippet: input.snippet });
  if (!requests.length) {
    complete = false;
    coverageNotes.push('Nothing was scanned: no readable files matched.');
  }

  for (const req of requests) {
    try {
      const res = await client.request<ScanResponse>({
        method: 'POST',
        path: `${COMPLIANCE_BASE}/scan`,
        body: {
          ...(input.language ? { language: input.language } : {}),
          ...(req.files ? { files: req.files } : {}),
          ...(req.snippet ? { snippet: req.snippet } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.retain ? { retain: true } : {}),
        },
        retries: 1,
        timeoutMs: 120_000,
      });
      scanIds.push(res.scanId);
      for (const f of res.findings ?? []) {
        findings.push(f);
        for (const c of f.controls ?? []) if (f.severity === 'CRITICAL' || f.severity === 'HIGH') failingControls.add(c);
      }
      for (const c of res.failingControls ?? []) failingControls.add(c);
      summary.critical += res.summary?.critical ?? 0;
      summary.high += res.summary?.high ?? 0;
      summary.medium += res.summary?.medium ?? 0;
      summary.low += res.summary?.low ?? 0;
      filesScanned += res.filesScanned ?? 0;
      bytesScanned += res.bytesScanned ?? 0;
      if (!res.complete || res.verdict === 'UNAVAILABLE') complete = false;
      coverageNotes.push(...(res.coverageNotes ?? []));
    } catch (err) {
      complete = false;
      const what = req.files ? `${req.files.length} file(s): ${req.files.slice(0, 3).map((f) => f.path).join(', ')}${req.files.length > 3 ? ', …' : ''}` : 'snippet';
      batchErrors.push(`${what} — not checked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const notScanned = input.notScanned ?? [];
  if (notScanned.length) complete = false;

  findings.sort((a, b) => bySeverity(a, b) || a.file.localeCompare(b.file) || a.line - b.line);
  const byFile: Record<string, string[]> = {};
  for (const f of findings) {
    (byFile[f.file] ??= []).push(`${f.file}:${f.line} ${f.severity} ${f.ruleId} [${(f.controls ?? []).join(', ')}] ${f.message}`);
  }
  const verdict = scanVerdict(summary, complete);
  return {
    verdict,
    ok: verdict === 'PASS' || verdict === 'PARTIAL',
    summary,
    findings,
    byFile,
    failingControls: [...failingControls].sort(),
    filesScanned,
    bytesScanned,
    complete,
    notScanned,
    batchErrors,
    coverageNotes: [...new Set(coverageNotes)],
    scanIds,
    note:
      verdict === 'UNAVAILABLE'
        ? 'Some or all of the code was not checked. That is not a pass: see notScanned and batchErrors.'
        : 'Deterministic rules over the submitted code; the server does not keep the code. Findings support a review; they are not an audit opinion.',
  };
}

/** A scan that could not run at all: reported as not checked, never as a pass. */
export function unavailableScan(reason: string): ScanReport {
  return {
    verdict: 'UNAVAILABLE',
    ok: false,
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
    findings: [],
    byFile: {},
    failingControls: [],
    filesScanned: 0,
    bytesScanned: 0,
    complete: false,
    notScanned: [],
    batchErrors: [reason],
    coverageNotes: [],
    scanIds: [],
    note: 'The code was not checked. That is not a pass.',
  };
}

/** Scan project files through fsguard. Never throws for a scan problem; the report says what was not checked. */
export async function scanProject(client: SwfteClient | null, root: string | undefined, paths: string[]): Promise<ScanReport> {
  if (!client) return unavailableScan('No credential (SWFTE_API_KEY or SWFTE_PAT), so the compliance scan could not run.');
  let collected;
  try {
    collected = collectLocalFiles({ paths, root });
  } catch (err) {
    return unavailableScan(err instanceof Error ? err.message : String(err));
  }
  return scanFiles(client, { files: collected.files, notScanned: collected.notScanned, notes: collected.notes });
}

/** Scan files a tool just produced inline (hosted scaffold): same caps, no disk. */
export async function scanInline(client: SwfteClient, files: { path: string; content: string }[]): Promise<ScanReport> {
  const inline = collectInlineFiles(files);
  return scanFiles(client, { files: inline.files, notScanned: inline.notScanned });
}

/** One-line-per-finding rendering for the CLI. */
export function formatScan(r: ScanReport): string[] {
  const lines: string[] = [];
  for (const f of r.findings) lines.push(`  ${f.file}:${f.line}  ${f.severity.padEnd(8)} ${f.ruleId}  ${f.message}${f.controls?.length ? `  [${f.controls.join(', ')}]` : ''}`);
  for (const n of r.notScanned) lines.push(`  ${n.path}  not checked: ${n.reason}`);
  for (const e of r.batchErrors) lines.push(`  ${e}`);
  const s = r.summary;
  lines.push(`Compliance scan ${r.verdict}: ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low in ${r.filesScanned} file(s)${r.complete ? '' : ' — incomplete, some code not checked'}.`);
  return lines;
}

/* ── evidence records ─────────────────────────────────────────────────────── */

const SIGNED_FIELDS = [
  'id', 'recordType', 'workspaceId', 'target', 'assessmentId', 'contentHash', 'catalogVersion', 'frameworks',
  'controlsPassed', 'exceptions', 'attestedChecks', 'selfAttestedChecks', 'statement', 'disclaimer', 'segregation',
  'issuedAt', 'expiresAt', 'issuedBy', 'issuedVia', 'algorithm', 'keyId',
] as const;

/** Canonical bytes the record's signature covers (CONTRACT rev 7 "Signed payload"). */
export function signedPayload(record: Record<string, any>): string {
  const out: Record<string, unknown> = {};
  for (const k of SIGNED_FIELDS) {
    if (k === 'target') out.target = { kind: record.target?.kind, id: record.target?.id };
    else out[k] = record[k];
  }
  return stableStringify(out);
}

export interface SigningKey {
  available: boolean;
  algorithm: string;
  keyId: string;
  publicKeyHex: string | null;
  offlineVerifiable: boolean;
}

/** Verify an Ed25519 signature (hex) over `message` with a raw 32-byte public key (hex). */
export function verifyEd25519(message: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const raw = Buffer.from(publicKeyHex, 'hex');
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

/** Offline check of a record against the published key: 'valid' | 'invalid' | why it could not be done. */
export function localRecordCheck(record: Record<string, any>, key: SigningKey | null): { result: 'valid' | 'invalid' | 'not-possible'; detail: string } {
  if (!key || !key.available || !key.publicKeyHex) return { result: 'not-possible', detail: 'The signing key is not published; relying on the server check only.' };
  if (record.algorithm !== 'Ed25519' || !key.offlineVerifiable) return { result: 'not-possible', detail: `${record.algorithm ?? 'Unknown'} signatures cannot be checked offline; relying on the server check only.` };
  if (key.keyId && record.keyId && key.keyId !== record.keyId) return { result: 'not-possible', detail: `Record was signed with key ${record.keyId}; the published key is ${key.keyId}.` };
  const ok = verifyEd25519(signedPayload(record), String(record.signature ?? ''), key.publicKeyHex);
  return ok ? { result: 'valid', detail: 'Ed25519 signature verified locally against the published key.' } : { result: 'invalid', detail: 'Ed25519 signature does NOT verify locally against the published key.' };
}

export async function getEvidenceRecord(client: SwfteClient, id: string, opts: { verify?: boolean } = {}) {
  const enc = encodeURIComponent(id);
  const record = await client.request<Record<string, any>>({ method: 'GET', path: `${COMPLIANCE_BASE}/evidence-records/${enc}`, retries: 1 });
  const base = {
    recordId: record.id ?? id,
    recordType: 'control-evidence-record',
    target: record.target,
    assessmentId: record.assessmentId,
    contentHash: record.contentHash,
    frameworks: record.frameworks,
    controlsPassed: record.controlsPassed,
    exceptions: record.exceptions,
    attestedChecks: record.attestedChecks,
    selfAttestedChecks: record.selfAttestedChecks,
    segregation: record.segregation,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    issuedBy: record.issuedBy,
    recordStatus: record.status,
    revokedAt: record.revokedAt ?? null,
    revocationReason: record.revocationReason ?? null,
    statement: record.statement,
    disclaimer: record.disclaimer,
    wording: RECORD_WORDING,
  };
  if (opts.verify === false) return { ...base, verification: null, conclusion: 'NOT_VERIFIED', note: 'verify:false — the signature and freshness were not checked.' };

  const [server, key] = await Promise.all([
    client.request<Record<string, any>>({ method: 'GET', path: `${COMPLIANCE_BASE}/evidence-records/${enc}/verify`, retries: 1 }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
    client.request<SigningKey>({ method: 'GET', path: `${COMPLIANCE_BASE}/evidence-records/signing-key`, retries: 1 }).catch(() => null),
  ]);
  const local = localRecordCheck(record, key);
  const serverOk = !('error' in server);
  const expired = typeof record.expiresAt === 'string' && Date.parse(record.expiresAt) < Date.now();

  let conclusion: string;
  const reasons: string[] = [];
  if (local.result === 'invalid') {
    conclusion = 'INVALID_SIGNATURE';
    reasons.push(local.detail);
  } else if (!serverOk) {
    conclusion = local.result === 'valid' ? 'SIGNATURE_VALID_FRESHNESS_UNKNOWN' : 'UNVERIFIABLE';
    reasons.push(`Server verification failed: ${(server as { error: string }).error}`);
  } else {
    const s = server as Record<string, any>;
    reasons.push(...(Array.isArray(s.reasons) ? s.reasons : []));
    if (s.signatureValid === false || s.status === 'INVALID_SIGNATURE') conclusion = 'INVALID_SIGNATURE';
    else if (s.status === 'REVOKED' || record.status === 'REVOKED') conclusion = 'REVOKED';
    else if (s.status === 'EXPIRED' || expired) conclusion = 'EXPIRED';
    else if (s.status === 'STALE' || s.fresh === false) conclusion = 'STALE';
    else if (s.status === 'VALID' && s.fresh === true) conclusion = 'VALID_AND_CURRENT';
    else if (s.status === 'VALID') conclusion = 'VALID_FRESHNESS_UNKNOWN';
    else conclusion = 'UNVERIFIABLE';
  }
  const meaning: Record<string, string> = {
    VALID_AND_CURRENT: 'The signature verifies and the artifact still has the content hash the record was issued for.',
    VALID_FRESHNESS_UNKNOWN: 'The signature verifies, but the artifact\'s current content hash could not be read, so currency is unknown.',
    SIGNATURE_VALID_FRESHNESS_UNKNOWN: 'The signature verifies locally, but the server check failed, so status and currency are unknown.',
    STALE: 'The artifact changed after the record was issued. The record describes an earlier version; assess again.',
    EXPIRED: 'The record is past its expiry.',
    REVOKED: 'The record was revoked.',
    INVALID_SIGNATURE: 'The signature does not verify. Do not rely on this record.',
    UNVERIFIABLE: 'The record could not be verified.',
  };
  return {
    ...base,
    conclusion,
    meaning: meaning[conclusion],
    verification: serverOk
      ? {
          signatureValid: (server as any).signatureValid ?? null,
          status: (server as any).status ?? null,
          fresh: (server as any).fresh ?? null,
          recordedContentHash: (server as any).recordedContentHash ?? record.contentHash,
          currentContentHash: (server as any).currentContentHash ?? null,
          verifiedAt: (server as any).verifiedAt ?? null,
        }
      : null,
    localSignatureCheck: local,
    reasons,
  };
}

/* ── export ───────────────────────────────────────────────────────────────── */

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Check a JSON export's manifest: bodySha256 recomputed locally, signature checked when the key allows. */
export function checkJsonExport(body: Record<string, any>, key: SigningKey | null) {
  const manifest = body?.manifest ?? {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) if (k !== 'manifest') rest[k] = v;
  const computed = sha256Hex(stableStringify(rest));
  const declared = String(manifest.bodySha256 ?? '').replace(/^sha256:/, '');
  const bodyHashMatches = Boolean(declared) && declared === computed;
  let signature: { result: 'valid' | 'invalid' | 'not-possible'; detail: string };
  if (!manifest.signature) signature = { result: 'not-possible', detail: 'The manifest carries no signature.' };
  else if (manifest.algorithm !== 'Ed25519' || !key?.available || !key.publicKeyHex || !key.offlineVerifiable)
    signature = { result: 'not-possible', detail: `${manifest.algorithm ?? 'Unknown'} signature; not checkable offline with the published key.` };
  else if (key.keyId && manifest.keyId && key.keyId !== manifest.keyId) signature = { result: 'not-possible', detail: `Signed with key ${manifest.keyId}; the published key is ${key.keyId}.` };
  else
    signature = verifyEd25519(String(manifest.bodySha256), String(manifest.signature), key.publicKeyHex)
      ? { result: 'valid', detail: 'Manifest signature over bodySha256 verified locally.' }
      : { result: 'invalid', detail: 'Manifest signature does NOT verify against the published key.' };
  return { computedBodySha256: computed, declaredBodySha256: declared || null, bodyHashMatches, signature };
}

/** What a history point says, with UNAVAILABLE spelled as "not checked". */
export function describeVerdict(v: string): string {
  switch (v) {
    case 'PASS':
      return 'passing';
    case 'FAIL':
      return 'failing';
    case 'PARTIAL':
      return 'partially passing';
    case 'UNAVAILABLE':
      return NOT_CHECKED;
    case 'NOT_APPLICABLE':
      return 'not applicable';
    default:
      return `unknown (${v})`;
  }
}
