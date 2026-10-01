/** Local, bounded Nexus data reader. Imported prose is untrusted rationalisation. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { catalogPath, parseCatalogRef, type CatalogRef } from './catalog.js';
import { assertLocalFilesystem, confineDirectory, confineReadableFile, isInside, SECRET_PATTERN } from './fsguard.js';
import { migrateLock, type LockArtifact } from './lock.js';

export const NEXUS_LIMITS = {
  bytes: 5 * 1024 * 1024,
  events: 5_000,
  entries: 10_000,
  lineBytes: 65_536,
  cardBytes: 131_072,
  statementBytes: 2_048,
  textBytes: 4_096,
  files: 20,
  constraints: 20,
} as const;
export const IMPORT_ITEM_LIMIT = 50;
export const IMPORT_BODY_LIMIT = 262_144;

export interface DecisionImportItem {
  sourceType: 'why' | 'model_card';
  externalId: string;
  title: string;
  statement?: string;
  consequences?: string;
  notes?: Record<string, string>;
  constraints?: Array<{ text: string; grounded: boolean; confirmed: false }>;
  appliesTo: Array<{ scope: 'artifact'; kind: string; ref: string }>;
  upstream: {
    source: 'llm' | 'llm_mined' | 'human_confirmed' | 'llm_synth';
    epistemicClass: 'rationalisation';
    repo: string;
    ref: string;
    model?: string;
    groundedCommit?: string;
    at?: string;
    files?: string[];
  };
}
export interface MappedDecision { catalogRef: string; item: DecisionImportItem }
export type SkipCode = 'malformed' | 'unsupported_schema' | 'unsupported_type' | 'invalid_shape'
  | 'secret_detected' | 'no_artifact_match' | 'ambiguous_artifact_match' | 'repo_mismatch'
  | 'duplicate_local' | 'oversized_record';
export interface NexusReadResult {
  decisions: MappedDecision[];
  inspected: number;
  bytesRead: number;
  skipped: Partial<Record<SkipCode, number>>;
  truncated: boolean;
}
export interface NexusReadOptions {
  from?: string;
  /** Exact upstream repo slug/store id, never inferred from a checkout name. */
  repo?: string;
  ref?: string;
  localFilesystem?: boolean;
  cwd?: string;
  /** Trusted embedding/test context only; not a tool input. */
  home?: string;
  credential?: string;
}
export class NexusIngestError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NexusIngestError'; }
}
const fail = (code: string, message: string): never => { throw new NexusIngestError(code, message); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const rawString = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;

/** Same clean-before-validation policy as the decision backend; never logs input. */
export function cleanDecisionText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/<[^>]*>/g, '')
    .replace(/<[^>]*$/g, '').trim();
}
function utf8Text(value: unknown, bytes: number = NEXUS_LIMITS.textBytes): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = cleanDecisionText(value);
  let out = '', length = 0;
  for (const char of clean) {
    const size = Buffer.byteLength(char, 'utf8');
    if (length + size > bytes) break;
    out += char; length += size;
  }
  return out || undefined;
}

/** Reject traversal rather than normalizing it into an apparently safe path. */
export function safeRepoPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined;
  const path = cleanDecisionText(value).replace(/\\/g, '/');
  if (!path || path.length > 200 || path.startsWith('/') || /^[A-Za-z]:/.test(path)
    || path.includes('://') || path.split('/').includes('..')) return undefined;
  const normalized = posix.normalize(path).replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized && normalized !== '.' && normalized !== '..' ? normalized : undefined;
}
function repoName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = cleanDecisionText(value);
  return name.length <= 160 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name)
    && !name.split('/').some(p => p === '.' || p === '..') ? name : undefined;
}
export function decisionCatalogRef(value: unknown): CatalogRef {
  if (typeof value !== 'string' || !/^[a-z-]+:[A-Za-z0-9_.:/-]{1,160}$/.test(value)
    || sourceHasSecret(value)) return fail('INVALID_REF', 'A supported catalog reference is required.');
  try { return parseCatalogRef(value); }
  catch { return fail('INVALID_REF', 'A supported catalog reference is required.'); }
}

const KNOWN_SECRET = /(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) { const p = count / text.length; bits -= p * Math.log2(p); }
  return bits;
}
function entropyWindow(token: string): boolean {
  const size = 40, counts = new Map<string, number>();
  const contribution = (count: number) => count ? -(count / size) * Math.log2(count / size) : 0;
  let bits = 0;
  const change = (char: string, delta: number) => {
    const before = counts.get(char) ?? 0, after = before + delta;
    bits += contribution(after) - contribution(before);
    if (after) counts.set(char, after); else counts.delete(char);
  };
  for (let i = 0; i < size; i++) change(token[i]!, 1);
  if (bits >= 4.2) return true;
  for (let i = size; i < token.length; i++) {
    change(token[i - size]!, -1); change(token[i]!, 1);
    if (bits >= 4.2) return true;
  }
  return false;
}
/** Whole records are scanned before normalization/truncation or identity hashing. */
export function sourceHasSecret(text: string, credential?: string): boolean {
  if (credential && text.includes(credential)) return true;
  const clean = cleanDecisionText(text);
  for (const value of [text, clean]) {
    if (SECRET_PATTERN.test(value) || KNOWN_SECRET.test(value)) return true;
    for (const match of value.matchAll(/[A-Za-z0-9_+/=-]{40,}/g)) {
      const token = match[0];
      if (/^[0-9a-f]+$/i.test(token)) continue; // commit/source digests are benign controls
      if (entropy(token) >= 4.2 || entropyWindow(token)) return true;
    }
  }
  return false;
}
function recordHasSecret(value: unknown, credential?: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && sourceHasSecret(item, credential)) return true;
    if (Array.isArray(item)) pending.push(...item);
    else if (object(item)) for (const [key, val] of Object.entries(item)) {
      if (sourceHasSecret(key, credential)) return true;
      pending.push(val);
    }
  }
  return false;
}
function parseJson(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('poisoned');
    return value;
  });
}

function nexusRoot(options: NexusReadOptions): string {
  assertLocalFilesystem(options.localFilesystem, 'swfte_ingest_decisions'); // before any filesystem lookup
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const defaultRoot = resolve(home, '.nexus');
  const supplied = options.from === '~/.nexus' ? defaultRoot : options.from;
  const candidate = supplied === undefined ? defaultRoot : resolve(cwd, supplied);
  try {
    // The exact well-known data root is the sole exception to project confinement.
    if (candidate === defaultRoot) {
      const st = lstatSync(candidate);
      if (!st.isDirectory() || st.isSymbolicLink()) return fail('PATH_REFUSED', 'Nexus data root is not a real directory.');
      const real = realpathSync(candidate), realHome = realpathSync(home);
      if (real !== join(realHome, '.nexus')) return fail('PATH_REFUSED', 'Nexus data root is outside its allowed location.');
      return real;
    }
    return realpathSync(confineDirectory(candidate, cwd));
  } catch (error) {
    if (error instanceof NexusIngestError) throw error;
    return fail('PATH_REFUSED', 'Nexus data root must be a real directory inside the project or the default Nexus directory.');
  }
}

/** Validate every child before enumeration/open; no credential-bearing path enters an error. */
function confinedChild(root: string, path: string, directory: boolean): string {
  try {
    const real = realpathSync(path), st = lstatSync(path);
    if (!isInside(root, real) || st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())) {
      return fail('PATH_REFUSED', 'A Nexus data path is not a confined regular file or directory.');
    }
    return real;
  } catch (error) {
    if (error instanceof NexusIngestError) throw error;
    return fail('PATH_REFUSED', 'A Nexus data path cannot be read safely.');
  }
}
interface Budget { bytes: number; inspected: number; entries: number; truncated: boolean }
function children(root: string, path: string, budget: Budget): string[] {
  let dir;
  try { dir = opendirSync(confinedChild(root, path, true)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  try {
    while (budget.entries < NEXUS_LIMITS.entries) {
      const next = dir.readSync();
      if (!next) return found.sort();
      budget.entries++;
      found.push(join(path, next.name));
    }
    budget.truncated = true;
    return found.sort();
  } finally { dir.closeSync(); }
}
function existsDirectory(root: string, path: string): boolean {
  try { confinedChild(root, path, true); return true; }
  catch (error) {
    // Optional store directories may be absent; unsafe existing paths still refuse the run.
    try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; }
    throw error;
  }
}
function readBounded(root: string, path: string, budget: Budget, maxBytes: number): { text: string; complete: boolean } {
  const safe = confinedChild(root, path, false);
  let fd: number | undefined;
  try {
    const before = lstatSync(safe);
    fd = openSync(safe, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) {
      return fail('PATH_REFUSED', 'A Nexus data file changed during validation.');
    }
    const amount = Math.min(st.size, maxBytes, NEXUS_LIMITS.bytes - budget.bytes);
    const buffer = Buffer.alloc(amount);
    let used = 0;
    while (used < amount) {
      const got = readSync(fd, buffer, used, amount - used, null);
      if (!got) break;
      used += got;
    }
    budget.bytes += used;
    const complete = used === st.size;
    if (!complete) budget.truncated = true;
    return { text: buffer.subarray(0, used).toString('utf8'), complete };
  } catch (error) {
    if (error instanceof NexusIngestError) throw error;
    return fail('READ_FAILED', 'A Nexus data file could not be read.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function artifactMapping(cwd: string, budget: Budget): LockArtifact[] {
  let lockPath: string;
  try { lockPath = confineReadableFile('swfte.json', cwd); }
  catch {
    try { lstatSync(join(cwd, 'swfte.json')); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    }
    return fail('LOCK_REFUSED', 'The project lock cannot be read safely.');
  }
  const read = readBounded(realpathSync(cwd), lockPath, budget, NEXUS_LIMITS.cardBytes);
  if (!read.complete) return fail('LOCK_REFUSED', 'The project lock exceeds the ingest limit.');
  try {
    const raw = parseJson(read.text);
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.artifacts) || recordHasSecret(raw)) throw new Error('invalid');
    const artifacts = raw.artifacts.map(artifact => {
      if (!object(artifact) || typeof artifact.catalogRef !== 'string' || typeof artifact.outDir !== 'string'
        || typeof artifact.alias !== 'string' || typeof artifact.language !== 'string' || typeof artifact.framework !== 'string'
        || !Array.isArray(artifact.files) || artifact.files.some(file => typeof file !== 'string')) throw new Error('invalid');
      decisionCatalogRef(artifact.catalogRef);
      return { ...artifact, outDir: safeRepoPath(artifact.outDir) ?? '.',
        files: artifact.files.map(safeRepoPath).filter((path): path is string => !!path) };
    });
    // Use the package's real migration helper, then validate mapping paths more strictly.
    return artifacts.flatMap(artifact => migrateLock({ ...raw, artifacts: [artifact] }, { baseUrl: '' }).lock.artifacts);
  } catch { return fail('LOCK_REFUSED', 'The project lock is malformed or unsupported.'); }
}
function mapping(paths: string[], artifacts: LockArtifact[]): { ref?: CatalogRef; code?: SkipCode } {
  const matches = new Map<string, CatalogRef>();
  for (const artifact of artifacts) {
    let ref: CatalogRef;
    try { ref = decisionCatalogRef(artifact.catalogRef); } catch { continue; }
    const out = safeRepoPath(artifact.outDir);
    const files = artifact.files.map(safeRepoPath).filter((p): p is string => !!p);
    if (paths.some(path => files.includes(path) || (out && (path === out || path.startsWith(`${out}/`))))) {
      matches.set(ref.ref, ref);
    }
  }
  return matches.size === 1 ? { ref: [...matches.values()][0] }
    : { code: matches.size ? 'ambiguous_artifact_match' : 'no_artifact_match' };
}

type Source = { repo: string; paths: string[]; identity: string; sourceType: 'why' | 'model_card';
  title: string; statement?: string; consequences?: string; notes: Record<string, string>;
  constraints: DecisionImportItem['constraints']; upstream: DecisionImportItem['upstream'] };
function sourceRecord(raw: Record<string, unknown>, cardRepo?: string): Source | SkipCode {
  if (raw.schema !== undefined && raw.schema !== '1') return 'unsupported_schema';
  const card = cardRepo !== undefined;
  const type = card ? 'model_card' : raw.type;
  if (type !== 'rationale' && type !== 'module_model' && type !== 'model_card') return 'unsupported_type';
  if (!card && (typeof raw.event_id !== 'string' || !raw.event_id || raw.event_id.length > 200
    || typeof raw.session_id !== 'string' || typeof raw.ts !== 'string')) return 'invalid_shape';
  const repo = repoName(raw.repo) ?? (raw.repo == null ? cardRepo ?? '' : undefined);
  if (repo === undefined || (card && raw.repo != null && repo !== cardRepo)) return 'invalid_shape';
  const files = raw.files;
  if (files != null && (!Array.isArray(files) || files.some(f => typeof f !== 'string'))) return 'invalid_shape';
  let paths = [...new Set((Array.isArray(files) ? files : []).map(safeRepoPath).filter((p): p is string => !!p))];
  const notes: Record<string, string> = {};
  for (const [key, value] of [['how', raw.how_note ?? raw.how_it_works], ['security', raw.security_note], ['change_class', raw.change_class]] as const) {
    const text = utf8Text(value); if (text) notes[key] = text;
  }
  const commit = utf8Text(raw.grounded_commit);
  const isWhy = type === 'rationale';
  const module = safeRepoPath(raw.module ?? raw.module_path);
  const statement = utf8Text(isWhy ? raw.rationale : raw.why ?? raw.why_note, NEXUS_LIMITS.statementBytes);
  const summary = utf8Text(isWhy ? raw.rationale : raw.summary, NEXUS_LIMITS.statementBytes);
  if (!summary || (!isWhy && !module)) return 'invalid_shape';
  if (!isWhy) paths = [module!, ...paths.filter(path => path !== module)];
  paths = paths.slice(0, NEXUS_LIMITS.files);
  // Joined upstream_files must also remain <=4096 UTF-8 bytes in the server's finalized notes.
  while (Buffer.byteLength(paths.join(', '), 'utf8') > NEXUS_LIMITS.textBytes) paths.pop();
  const source = isWhy ? raw.source ?? 'llm' : 'llm_synth';
  if (!['llm', 'llm_mined', 'human_confirmed', 'llm_synth'].includes(String(source))) return 'invalid_shape';
  const invariants = card && object(raw.security) ? raw.security.invariants : raw.invariants;
  if (card && raw.security != null && !object(raw.security)) return 'invalid_shape';
  if (invariants != null && !Array.isArray(invariants)) return 'invalid_shape';
  const constraints: NonNullable<DecisionImportItem['constraints']> = [];
  for (const inv of (Array.isArray(invariants) ? invariants : []).slice(0, NEXUS_LIMITS.constraints)) {
    const text = utf8Text(typeof inv === 'string' ? inv : object(inv) ? inv.text : undefined);
    if (!text) return 'invalid_shape';
    constraints.push({ text, grounded: object(inv) && inv.grounded === true, confirmed: false });
  }
  return {
    repo, paths, identity: isWhy ? String(raw.event_id) : JSON.stringify([module, commit ?? '']),
    sourceType: isWhy ? 'why' : 'model_card',
    title: Array.from(isWhy ? summary.split(/(?<=[.!?])\s/)[0]! : summary).slice(0, 120).join(''), statement,
    consequences: utf8Text(raw.risk_note), notes, constraints,
    upstream: { source: source as DecisionImportItem['upstream']['source'], epistemicClass: 'rationalisation',
      repo, ref: isWhy ? utf8Text(raw.event_id)! : module!, model: utf8Text(raw.model),
      groundedCommit: commit, at: utf8Text(card ? raw.updated : raw.ts), ...(paths.length ? { files: paths } : {}) },
  };
}

/** Does not return input text in errors. Returned decision content is internal apply data. */
export function readNexus(options: NexusReadOptions = {}): NexusReadResult {
  const root = nexusRoot(options);
  const cwd = options.cwd ?? process.cwd();
  const budget: Budget = { bytes: 0, inspected: 0, entries: 0, truncated: false };
  const skipped: NexusReadResult['skipped'] = {}, decisions: MappedDecision[] = [];
  const skip = (code: SkipCode) => { skipped[code] = (skipped[code] ?? 0) + 1; };
  const explicit = options.ref === undefined ? undefined : decisionCatalogRef(options.ref);
  const filter = options.repo === undefined ? undefined : repoName(options.repo);
  if (options.repo !== undefined && !filter) return fail('INVALID_REPO', 'Use an exact upstream repository slug or store id.');
  const artifacts = explicit ? [] : artifactMapping(cwd, budget);
  const seen = new Set<string>();
  const consume = (text: string, cardRepo?: string) => {
    if (budget.inspected >= NEXUS_LIMITS.events) { budget.truncated = true; return; }
    budget.inspected++;
    if (Buffer.byteLength(text, 'utf8') > (cardRepo === undefined ? NEXUS_LIMITS.lineBytes : NEXUS_LIMITS.cardBytes)) {
      skip('oversized_record'); return;
    }
    let parsed: unknown;
    try { parsed = parseJson(text); } catch { skip('malformed'); return; }
    if (!object(parsed)) { skip('invalid_shape'); return; }
    if (recordHasSecret(parsed, options.credential)) { skip('secret_detected'); return; }
    const source = sourceRecord(parsed, cardRepo);
    if (typeof source === 'string') { skip(source); return; }
    if (filter !== undefined && source.repo !== filter) { skip('repo_mismatch'); return; }
    const target = explicit ? { ref: explicit } : mapping(source.paths, artifacts);
    if (!target.ref) { skip(target.code ?? 'no_artifact_match'); return; }
    const externalId = createHash('sha256').update(JSON.stringify([source.repo, source.sourceType, source.identity])).digest('hex');
    const key = `${target.ref.ref}|${externalId}`;
    if (seen.has(key)) { skip('duplicate_local'); return; }
    seen.add(key);
    decisions.push({ catalogRef: target.ref.ref, item: {
      sourceType: source.sourceType, externalId, title: source.title, statement: source.statement,
      consequences: source.consequences, ...(Object.keys(source.notes).length ? { notes: source.notes } : {}),
      ...(source.constraints?.length ? { constraints: source.constraints } : {}),
      appliesTo: [{ scope: 'artifact', kind: target.ref.kind, ref: target.ref.ref }], upstream: source.upstream,
    } });
  };
  const stopped = () => budget.bytes >= NEXUS_LIMITS.bytes || budget.inspected >= NEXUS_LIMITS.events
    || budget.entries >= NEXUS_LIMITS.entries;
  // Full model cards precede digest events so all supported invariant detail wins deduplication.
  const model = join(root, 'model');
  if (existsDirectory(root, model)) for (const repoDir of children(root, model, budget)) {
    if (stopped()) { budget.truncated = true; break; }
    const rid = repoName(relative(model, repoDir));
    if (!rid || (filter !== undefined && rid !== filter)) continue;
    for (const path of children(root, repoDir, budget)) {
      if (stopped()) { budget.truncated = true; break; }
      if (!path.endsWith('.json') || path.endsWith('/index.json') || path.endsWith('/_repo.json')) continue;
      const read = readBounded(root, path, budget, NEXUS_LIMITS.cardBytes);
      if (read.complete) consume(read.text, rid); else skip('oversized_record');
    }
  }
  const ledger = join(root, 'ledger');
  if (!stopped() && existsDirectory(root, ledger)) for (const path of children(root, ledger, budget).reverse()) {
    if (stopped()) { budget.truncated = true; break; }
    if (!path.endsWith('.ndjson')) continue;
    const read = readBounded(root, path, budget, NEXUS_LIMITS.bytes);
    const lines = read.text.split('\n');
    if (!read.complete) lines.pop(); // a byte-truncated tail is never parsed as a complete event
    for (const line of lines) {
      if (budget.inspected >= NEXUS_LIMITS.events) { budget.truncated = true; break; }
      if (line.trim()) consume(line);
    }
  }
  return { decisions, inspected: budget.inspected, bytesRead: budget.bytes, skipped, truncated: budget.truncated };
}

export interface ImportBatch { catalogRef: string; path: string; body: { apply: true; items: DecisionImportItem[] } }
/** Exact serialized UTF-8 body size, including apply:true and JSON escaping. */
export function importBatches(decisions: MappedDecision[]): ImportBatch[] {
  const batches: ImportBatch[] = [];
  const groups = new Map<string, DecisionImportItem[]>();
  for (const decision of decisions) {
    const ref = decisionCatalogRef(decision.catalogRef);
    if (!/^[0-9a-f]{64}$/.test(decision.item.externalId)) return fail('INVALID_IMPORT', 'Invalid import identity.');
    const items = groups.get(ref.ref) ?? [];
    items.push(decision.item); groups.set(ref.ref, items);
  }
  for (const [refString, items] of groups) {
    const ref = decisionCatalogRef(refString);
    let current: DecisionImportItem[] = [];
    const flush = () => { if (current.length) {
      batches.push({ catalogRef: ref.ref, path: `${catalogPath(ref)}/decisions/import`, body: { apply: true, items: current } });
      current = [];
    } };
    for (const item of items) {
      const candidate = { apply: true as const, items: [...current, item] };
      if (candidate.items.length > IMPORT_ITEM_LIMIT || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > IMPORT_BODY_LIMIT) flush();
      if (Buffer.byteLength(JSON.stringify({ apply: true, items: [item] }), 'utf8') > IMPORT_BODY_LIMIT) {
        return fail('ITEM_TOO_LARGE', 'A normalized decision cannot fit within the import body limit.');
      }
      current.push(item);
    }
    flush();
  }
  return batches;
}

/** Preview deliberately exposes no ledger/card prose or file/metadata content. */
export function previewNexus(read: NexusReadResult) {
  return { dryRun: true, inspected: read.inspected, bytesRead: read.bytesRead, proposed: read.decisions.length,
    skipped: read.skipped, truncated: read.truncated,
    candidates: read.decisions.map(({ catalogRef, item }) => ({ catalogRef, externalId: item.externalId,
      sourceType: item.sourceType, status: 'PROPOSED' as const, constraints: item.constraints?.length ?? 0 })),
    note: 'Local preview only; no HTTP calls. Text is untrusted rationalisation. Explicit apply imports private PROPOSED decisions; confirmation requires a workspace member in Studio.' };
}
