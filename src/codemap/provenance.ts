/** Local write receipts describe who edited a site; they are never proof of its behavior. */
import { createHash } from 'node:crypto';
import { ConfinedWriter, NativeWriterCommitError, type PlannedWrite } from '../fsguard.js';
import { readConfined } from './walk.js';
import { checkManifest } from './manifest.js';
import type { AssignedSite } from './fingerprint.js';
import type { AddedBy, Provenance } from './types.js';
import { currentCall } from '../tracing.js';

const LEDGER = '.swfte/codemap/provenance.json';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
interface Receipt { path: string; hash: string; priorIds: string[]; provenance: Provenance }

function receipts(root: string): Receipt[] {
  const text = readConfined(new ConfinedWriter({ root }), LEDGER, 2 * 1024 * 1024);
  if (text === null) return [];
  return parseReceipts(text);
}

function parseReceipts(text: string): Receipt[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length > 1000) throw new Error('Invalid local provenance receipts.');
  for (const row of parsed) {
    if (!row || typeof row !== 'object' || typeof row.path !== 'string' || !/^[0-9a-f]{64}$/.test(row.hash)
      || !Array.isArray(row.priorIds) || row.priorIds.some((id: unknown) => typeof id !== 'string' || !/^cs_[0-9a-f]{24}$/.test(id))
      || !row.provenance || !['claude-code', 'codex', 'human', 'studio'].includes(row.provenance.addedBy)
      || !['cli', 'mcp'].includes(row.provenance.via) || !Number.isFinite(Date.parse(row.provenance.at))
      || (row.provenance.pr !== undefined && (!Number.isSafeInteger(row.provenance.pr) || row.provenance.pr < 1))) {
      throw new Error('Invalid local provenance receipts.');
    }
  }
  return parsed as Receipt[];
}

/** Call only after real writes commit. Unknown preexisting files cannot be attributed wholesale. */
export function recordWrittenFiles(root: string, writes: PlannedWrite[], addedBy: AddedBy, via: 'cli' | 'mcp', pr?: number): void {
  if (!['claude-code', 'codex', 'human', 'studio'].includes(addedBy) || (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1))) {
    throw new Error('Invalid provenance metadata.');
  }
  if (!writes.some(write => write.action !== 'unchanged')) return;
  const reader = new ConfinedWriter({ root });
  const manifestText = readConfined(reader, '.swfte/codemap/manifest.json', 2 * 1024 * 1024);
  const previous = manifestText ? checkManifest(JSON.parse(manifestText)) : null;
  const priorIds = previous?.callSites.map(site => site.id) ?? [];
  const latest = new Map(receipts(root).map(row => [row.path, row]));
  let changed = false;
  for (const write of writes) {
    if (write.action === 'unchanged' || (write.action !== 'create' && !previous)) continue;
    const text = readConfined(reader, write.path, 1024 * 1024);
    if (text === null) throw new Error('Written file is not readable inside the project.');
    latest.set(write.path, { path: write.path, hash: hash(text), priorIds,
      provenance: { addedBy, via, at: new Date().toISOString(), ...(pr ? { pr } : {}) } });
    changed = true;
  }
  if (!changed) return;
  const rows = [...latest.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(-1000);
  const writer = new ConfinedWriter({ root });
  writer.create(writer.resolve(LEDGER), JSON.stringify(rows) + '\n', true);
  writer.commit();
}

/** MCP host attribution describes the local writer, never a verified identity or behavior verdict. */
export function recordMcpWrittenFiles(writer: Pick<ConfinedWriter, 'root' | 'inline'>, writes: PlannedWrite[]): void {
  if (writer.inline) return;
  // Only scanner-supported source files can produce call sites. Never read env/VCS/binary exports
  // or oversized files merely to add a receipt; the scanner independently reports its own limits.
  const source = writes.filter(write => /\.(?:[cm]?[jt]sx?|py|java|html?)$/i.test(write.path)
    && write.bytes <= 1024 * 1024 && !/(?:^|\/)(?:\.git|\.env[^/]*)(?:\/|$)/.test(write.path));
  const caller = currentCall()?.client ?? '';
  const addedBy = /claude/i.test(caller) ? 'claude-code' : /codex/i.test(caller) ? 'codex' : 'human';
  recordWrittenFiles(writer.root, source, addedBy, 'mcp');
}

export function provenanceForSites(root: string, assigned: AssignedSite[]): Map<string, Provenance> {
  const reader = new ConfinedWriter({ root });
  const byPath = new Map(receipts(root).map(row => [row.path, row]));
  const hashes = new Map<string, string | null>();
  const out = new Map<string, Provenance>();
  for (const { site, id } of assigned) {
    const receipt = byPath.get(site.relPath);
    if (!receipt || receipt.priorIds.includes(id)) continue;
    if (!hashes.has(site.relPath)) {
      const text = readConfined(reader, site.relPath, 1024 * 1024);
      hashes.set(site.relPath, text === null ? null : hash(text));
    }
    if (hashes.get(site.relPath) === receipt.hash) out.set(id, { ...receipt.provenance });
  }
  return out;
}

/** Borrow the outer writer and bind attribution to sealed producer readback, never intended/path-reread bytes. */
export function recordNativeWrittenFiles(writer: ConfinedWriter, writes: PlannedWrite[], addedBy: AddedBy,
  via: 'cli' | 'mcp', pr?: number): void {
  if (writer.inline || !writes.some(write => write.action !== 'unchanged')) return;
  if (!writer.native) throw new Error('Native provenance requires the owning native writer.');
  try {
    if (!['claude-code', 'codex', 'human', 'studio'].includes(addedBy)
      || (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1))) throw new Error('Invalid provenance metadata.');
    const source = writes.filter(write => /\.(?:[cm]?[jt]sx?|py|java|html?)$/i.test(write.path)
      && write.bytes <= 1024 * 1024 && !/(?:^|\/)(?:\.git|\.env[^/]*)(?:\/|$)/.test(write.path));
    if (!source.some(write => write.action !== 'unchanged')) return;
    const manifestText = writer.readText(writer.resolve('.swfte/codemap/manifest.json'), 2 * 1024 * 1024);
    const previous = manifestText ? checkManifest(JSON.parse(manifestText)) : null;
    const priorIds = previous?.callSites.map(site => site.id) ?? [];
    const ledger = writer.readText(writer.resolve(LEDGER), 2 * 1024 * 1024);
    const latest = new Map((ledger === null ? [] : parseReceipts(ledger)).map(row => [row.path, row]));
    let changed = false;
    for (const write of source) {
      const receipt = writer.nativeReceipt(write);
      if (!receipt) throw new Error('Unsealed native write receipt.');
      if (receipt.action === 'unchanged' || (receipt.action !== 'create' && !previous)) continue;
      // Fresh descriptor validation only; the receipt hash remains the native commit's readback hash.
      // Never use a Node pathname reread or refresh any authorization preimage here.
      const current = writer.readCurrentSnapshot(writer.resolve(receipt.path), 1024 * 1024);
      if (!current || createHash('sha256').update(current.bytes).digest('hex') !== receipt.hash) continue;
      latest.set(receipt.path, { path: receipt.path, hash: receipt.hash, priorIds,
        provenance: { addedBy, via, at: new Date().toISOString(), ...(pr ? { pr } : {}) } });
      changed = true;
    }
    if (!changed) return;
    const rows = [...latest.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(-1000);
    writer.create(writer.resolve(LEDGER), JSON.stringify(rows) + '\n', true);
    writer.commit();
  } catch (error) {
    const confirmed = writes.filter(write => writer.nativeReceipt(write)?.action !== 'unchanged' && writer.nativeReceipt(write));
    if (error instanceof NativeWriterCommitError) {
      throw new NativeWriterCommitError([...confirmed, ...error.confirmedFiles], error.uncertainPaths,
        error.directoriesMayExist, error.code);
    }
    throw new NativeWriterCommitError(confirmed, [], false, 'PROVENANCE_FAILED');
  }
}

export function recordNativeMcpWrittenFiles(writer: ConfinedWriter, writes: PlannedWrite[]): void {
  const caller = currentCall()?.client ?? '';
  const addedBy = /claude/i.test(caller) ? 'claude-code' : /codex/i.test(caller) ? 'codex' : 'human';
  recordNativeWrittenFiles(writer, writes, addedBy, 'mcp');
}
