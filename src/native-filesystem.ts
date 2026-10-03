/**
 * Descriptor-relative POSIX producer. Requires an explicitly built, trusted
 * package artifact; never compiles, downloads, searches PATH or falls back to
 * pathname writes. The held capability may move with its directory inode.
 * Same-UID namespace/temp-inode attacks and target replacement CAS are outside
 * this producer's trust boundary. See 09-native-filesystem-contract-r7.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir, release as osRelease } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_PROTOCOL = 'SWFTE_CF1';
export const NATIVE_FILE_LIMIT = 4 * 1024 * 1024;
const MAGIC = Buffer.from('SWFTECF1', 'ascii');
const META_SIZE = 60;
const ERRORS = new Set(['UNSUPPORTED_PLATFORM', 'NATIVE_ARTIFACT_MISSING_OR_INVALID', 'PROTOCOL_INVALID',
  'PATH_REFUSED', 'SYMLINK_REFUSED', 'HARDLINK_REFUSED', 'STALE_CONTENT', 'CONFLICT', 'SIZE_LIMIT', 'PARTIAL_COMMIT', 'IO_ERROR', 'ROOT_CLOSED']);

export class NativeFilesystemError extends Error {
  constructor(readonly code: string, readonly committed = false) { super(code); this.name = 'NativeFilesystemError'; }
}
export interface NativeIdentity {
  readonly dev: string; readonly ino: string; readonly mode: number; readonly nlink: string; readonly size: string;
  readonly mtimeSec: string; readonly mtimeNsec: number; readonly ctimeSec: string; readonly ctimeNsec: number;
}
export interface NativeSnapshot extends NativeIdentity { readonly bytes: Buffer }
export interface NativeCommit extends NativeIdentity {
  readonly action: 'create' | 'overwrite' | 'merge' | 'unchanged'; readonly bytesReadBack: Buffer;
}
export interface NativeReplace {
  rel: string; expected: NativeSnapshot | null; bytes: Uint8Array;
  policy: 'create-only' | 'authorized-replace' | 'merge';
}

export interface NativeDirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly identity: NativeIdentity;
}
export interface NativeDirectorySnapshot {
  readonly identity: NativeIdentity;
  readonly entries: readonly NativeDirectoryEntry[];
}
export interface NativeListLimits { maxEntries?: number; maxBytes?: number }
export interface NativeUnlink { rel: string; expected: NativeSnapshot }
export interface NativeUnlinkResult { readonly removed: boolean }
const NATIVE_LIST_ENTRIES_LIMIT = 20_000;

function glibcVersion(): string | undefined {
  const report = process.report?.getReport();
  return report && typeof report === 'object' ? (report as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime : undefined;
}
/** Pure selection is exported for explicit unsupported-tuple controls, not as a runtime override. */
export function nativePlatformTuple(platform: string = process.platform, arch: string = process.arch, glibc: string | undefined = glibcVersion()): string {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`;
  if (platform === 'linux' && arch === 'x64' && glibc && /^\d+\.\d+(?:\.\d+)?$/.test(glibc)) return 'linux-x64-glibc';
  throw new NativeFilesystemError('UNSUPPORTED_PLATFORM');
}
export function nativeArtifactPaths(): { executable: string; manifest: string; tuple: string } {
  const tuple = nativePlatformTuple();
  const here = dirname(fileURLToPath(import.meta.url));
  // Source tests and the actual bundled dist/index.js or dist/swfte.js layout.
  const folder = join(basename(here) === 'src' ? join(here, '..', 'dist') : here, 'native', tuple);
  return { executable: join(folder, 'confined-fs'), manifest: join(folder, 'manifest.json'), tuple };
}
function requireFlags(): number {
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new NativeFilesystemError('UNSUPPORTED_PLATFORM');
  return constants.O_NOFOLLOW | constants.O_DIRECTORY;
}
function readArtifact(path: string, maxBytes: number, executable = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > maxBytes || (st.mode & 0o022)
      || (executable && !(st.mode & 0o111))) throw new Error('Invalid trusted artifact');
    const bytes = Buffer.alloc(st.size + 1); let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) break; at += n; }
    const after = fstatSync(fd);
    if (at !== st.size || after.size !== st.size || after.nlink !== 1 || after.mode !== st.mode
      || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw new Error('Changed trusted artifact');
    return bytes.subarray(0, at);
  } finally { closeSync(fd); }
}
function atLeastVersion(actual: string, minimum: string): boolean {
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}
function admittedArtifact(): ReturnType<typeof nativeArtifactPaths> {
  requireFlags();
  const artifact = nativeArtifactPaths();
  try {
    const manifest: unknown = JSON.parse(readArtifact(artifact.manifest, 16 * 1024).toString('utf8'));
    if (!manifest || typeof manifest !== 'object') throw new Error('Invalid manifest');
    const m = manifest as Record<string, unknown>;
    if (m.schema !== 'swfte-native-artifact/1' || m.protocol !== NATIVE_PROTOCOL || m.wireVersion !== 1
      || m.tuple !== artifact.tuple || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)
      || typeof m.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sourceSha256)
      || typeof m.bytes !== 'number' || !Number.isSafeInteger(m.bytes) || m.bytes < 1) throw new Error('Invalid manifest');
    if (artifact.tuple === 'linux-x64-glibc') {
      if (typeof m.glibcMinimum !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(m.glibcMinimum)
        || !atLeastVersion(glibcVersion() ?? '0.0', m.glibcMinimum)) throw new NativeFilesystemError('UNSUPPORTED_PLATFORM');
    } else if (m.macosMinimum !== '11.0' || Number(osRelease().split('.')[0]) < 20) {
      throw new NativeFilesystemError('UNSUPPORTED_PLATFORM');
    }
    const executable = readArtifact(artifact.executable, 8 * 1024 * 1024, true);
    if (executable.length !== m.bytes || createHash('sha256').update(executable).digest('hex') !== m.sha256) throw new Error('Artifact hash mismatch');
    return artifact;
  } catch (error) {
    if (error instanceof NativeFilesystemError) throw error;
    throw new NativeFilesystemError('NATIVE_ARTIFACT_MISSING_OR_INVALID');
  }
}
function components(rel: string): Buffer[] {
  if (typeof rel !== 'string' || !rel || Buffer.byteLength(rel) > 4096 || /[\\\x00-\x1f\x7f]/.test(rel)) throw new NativeFilesystemError('PATH_REFUSED');
  const parts = rel.split('/');
  if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..')) throw new NativeFilesystemError('PATH_REFUSED');
  return parts.map(part => {
    const out = Buffer.from(part, 'utf8');
    if (out.length > 255 || out.toString('utf8') !== part) throw new NativeFilesystemError('PATH_REFUSED');
    return out;
  });
}
function integer(value: string, signed = false): bigint {
  if (typeof value !== 'string' || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) throw new NativeFilesystemError('PROTOCOL_INVALID');
  const n = BigInt(value);
  if (signed ? n < -(1n << 63n) || n >= (1n << 63n) : n < 0n || n >= (1n << 64n)) throw new NativeFilesystemError('PROTOCOL_INVALID');
  return n;
}
function metaBytes(m: NativeIdentity): Buffer {
  const out = Buffer.alloc(META_SIZE);
  for (const value of [m.mode, m.mtimeNsec, m.ctimeNsec]) if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new NativeFilesystemError('PROTOCOL_INVALID');
  if (m.mtimeNsec >= 1e9 || m.ctimeNsec >= 1e9) throw new NativeFilesystemError('PROTOCOL_INVALID');
  out.writeBigUInt64BE(integer(m.dev), 0); out.writeBigUInt64BE(integer(m.ino), 8); out.writeUInt32BE(m.mode, 16);
  out.writeBigUInt64BE(integer(m.nlink), 20); out.writeBigUInt64BE(integer(m.size), 28);
  out.writeBigInt64BE(integer(m.mtimeSec, true), 36); out.writeUInt32BE(m.mtimeNsec, 44);
  out.writeBigInt64BE(integer(m.ctimeSec, true), 48); out.writeUInt32BE(m.ctimeNsec, 56);
  return out;
}
class Decoder {
  private at = 0;
  constructor(private readonly bytes: Buffer, private readonly committed: boolean) {}
  take(n: number): Buffer {
    if (n < 0 || n > this.bytes.length - this.at) throw new NativeFilesystemError('PROTOCOL_INVALID', this.committed);
    const out = this.bytes.subarray(this.at, this.at + n); this.at += n; return out;
  }
  identity(): NativeIdentity {
    const b = this.take(META_SIZE);
    const m = { dev: b.readBigUInt64BE(0).toString(), ino: b.readBigUInt64BE(8).toString(), mode: b.readUInt32BE(16),
      nlink: b.readBigUInt64BE(20).toString(), size: b.readBigUInt64BE(28).toString(),
      mtimeSec: b.readBigInt64BE(36).toString(), mtimeNsec: b.readUInt32BE(44), ctimeSec: b.readBigInt64BE(48).toString(), ctimeNsec: b.readUInt32BE(56) };
    if (m.mtimeNsec >= 1e9 || m.ctimeNsec >= 1e9) throw new NativeFilesystemError('PROTOCOL_INVALID', this.committed);
    return Object.freeze(m);
  }
  content(m: NativeIdentity): Buffer {
    const length = this.take(4).readUInt32BE();
    if (length > NATIVE_FILE_LIMIT || String(length) !== m.size || m.nlink !== '1' || (m.mode & 0o170000) !== 0o100000) throw new NativeFilesystemError('PROTOCOL_INVALID', this.committed);
    return Buffer.from(this.take(length));
  }
  end(): void { if (this.at !== this.bytes.length) throw new NativeFilesystemError('PROTOCOL_INVALID', this.committed); }
}

export class NativeFilesystem {
  private closed = false;
  private constructor(private readonly fd: number, readonly identity: NativeIdentity,
    private readonly artifact: ReturnType<typeof nativeArtifactPaths>) {}

  static openRoot(root: string): NativeFilesystem {
    const artifact = admittedArtifact(); // Missing producer refuses before project access/effects.
    let canonical: string;
    try { canonical = realpathSync(resolve(root)); } catch { throw new NativeFilesystemError('PATH_REFUSED'); }
    const home = (() => { try { return realpathSync(homedir()); } catch { return resolve(homedir()); } })();
    if (canonical === parse(canonical).root || canonical === home || /^\/(?:proc|dev|sys)(?:\/|$)/.test(canonical)) throw new NativeFilesystemError('PATH_REFUSED');
    let fd: number;
    try { fd = openSync(canonical, constants.O_RDONLY | requireFlags()); } catch { throw new NativeFilesystemError('PATH_REFUSED'); }
    try {
      const st = fstatSync(fd, { bigint: true });
      if (!st.isDirectory()) throw new NativeFilesystemError('PATH_REFUSED');
      // Handshake validates protocol and actual inherited root dev/ino before adoption.
      const provisional = new NativeFilesystem(fd, { dev: st.dev.toString(), ino: st.ino.toString() } as NativeIdentity, artifact);
      const response = provisional.invoke(0, []); const decode = new Decoder(response.payload, false);
      const identity = decode.identity(); decode.end();
      if (identity.dev !== st.dev.toString() || identity.ino !== st.ino.toString() || (identity.mode & 0o170000) !== 0o040000) throw new NativeFilesystemError('PROTOCOL_INVALID');
      return new NativeFilesystem(fd, identity, artifact);
    } catch (error) { closeSync(fd); throw error; }
  }

  private invoke(op: number, parts: Buffer[], tail: Buffer = Buffer.alloc(0)): { payload: Buffer; committed: boolean } {
    if (this.closed) throw new NativeFilesystemError('ROOT_CLOSED');
    const header = Buffer.alloc(34); MAGIC.copy(header); header.writeUInt32BE(1, 8); header[12] = op;
    header.writeBigUInt64BE(integer(this.identity.dev), 16); header.writeBigUInt64BE(integer(this.identity.ino), 24); header.writeUInt16BE(parts.length, 32);
    const path = parts.flatMap(part => { const size = Buffer.alloc(2); size.writeUInt16BE(part.length); return [size, part]; });
    const input = Buffer.concat([header, ...path, tail]);
    if (input.length > 2 * NATIVE_FILE_LIMIT + 65536) throw new NativeFilesystemError('SIZE_LIMIT');
    const mutating = op === 2 || op === 3 || op === 5;
    const result = spawnSync(this.artifact.executable, [], { shell: false, input,
      stdio: ['pipe', 'pipe', 'pipe', this.fd], timeout: 30_000, maxBuffer: NATIVE_FILE_LIMIT + 4096,
      env: { LANG: 'C', LC_ALL: 'C' } });
    if (result.error || result.status !== 0 || result.signal) {
      // Unknown after launch: never report a failed mutator as zero physical effects.
      throw new NativeFilesystemError(op === 0 ? 'NATIVE_ARTIFACT_MISSING_OR_INVALID' : mutating ? 'PARTIAL_COMMIT' : 'IO_ERROR', mutating);
    }
    const out = result.stdout;
    if (out.length < 16 || !out.subarray(0, 8).equals(MAGIC)) throw new NativeFilesystemError('PROTOCOL_INVALID', mutating);
    const status = out.readUInt16BE(8), committed = out[10] === 1;
    if (status > 1 || out[10]! > 1 || out[11] !== 0 || out.readUInt32BE(12) !== out.length - 16) throw new NativeFilesystemError('PROTOCOL_INVALID', mutating);
    if (!mutating && committed) throw new NativeFilesystemError('PROTOCOL_INVALID');
    const payload = out.subarray(16);
    if (status) {
      const code = payload.toString('ascii');
      // Unknown/malformed launched-mutator errors cannot certify zero effects. The C producer
      // converts every acknowledged-effect error to PARTIAL_COMMIT; other typed refusals are pre-effect.
      if (!Buffer.from(code, 'ascii').equals(payload) || !ERRORS.has(code)
        || committed !== (code === 'PARTIAL_COMMIT')) throw new NativeFilesystemError('PROTOCOL_INVALID', mutating);
      throw new NativeFilesystemError(code, committed);
    }
    return { payload, committed };
  }

  read(rel: string, maxBytes = NATIVE_FILE_LIMIT): NativeSnapshot | null {
    const parts = components(rel);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > NATIVE_FILE_LIMIT) throw new NativeFilesystemError('SIZE_LIMIT');
    const cap = Buffer.alloc(4); cap.writeUInt32BE(maxBytes);
    const response = this.invoke(1, parts, cap); const decode = new Decoder(response.payload, response.committed);
    if (response.committed) throw new NativeFilesystemError('PROTOCOL_INVALID', true);
    const present = decode.take(1)[0];
    if (present === 0) { decode.end(); return null; }
    if (present !== 1 || response.committed) throw new NativeFilesystemError('PROTOCOL_INVALID', response.committed);
    const identity = decode.identity(), bytes = decode.content(identity); decode.end();
    return Object.freeze({ ...identity, bytes });
  }

  /** One bounded directory observation. This is not an immutable tree snapshot. */
  list(rel = '', limits: NativeListLimits = {}): NativeDirectorySnapshot | null {
    const parts = rel === '' ? [] : components(rel);
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new NativeFilesystemError('PROTOCOL_INVALID');
    const maxEntries = limits.maxEntries === undefined ? NATIVE_LIST_ENTRIES_LIMIT : limits.maxEntries;
    const maxBytes = limits.maxBytes === undefined ? NATIVE_FILE_LIMIT : limits.maxBytes;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > NATIVE_LIST_ENTRIES_LIMIT
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > NATIVE_FILE_LIMIT) throw new NativeFilesystemError('SIZE_LIMIT');
    const tail = Buffer.alloc(8); tail.writeUInt32BE(maxEntries); tail.writeUInt32BE(maxBytes, 4);
    const response = this.invoke(4, parts, tail);
    if (response.committed || response.payload.length > maxBytes) throw new NativeFilesystemError('PROTOCOL_INVALID');
    const decode = new Decoder(response.payload, false), present = decode.take(1)[0];
    if (present === 0) { decode.end(); return null; }
    if (present !== 1) throw new NativeFilesystemError('PROTOCOL_INVALID');
    const identity = decode.identity();
    if ((identity.mode & 0o170000) !== 0o040000 || BigInt(identity.nlink) < 1n) throw new NativeFilesystemError('PROTOCOL_INVALID');
    if (parts.length === 0 && (identity.dev !== this.identity.dev || identity.ino !== this.identity.ino)) throw new NativeFilesystemError('PROTOCOL_INVALID');
    const count = decode.take(4).readUInt32BE();
    if (count > maxEntries || count > Math.floor((response.payload.length - 65) / 64)) throw new NativeFilesystemError('PROTOCOL_INVALID');
    const entries: NativeDirectoryEntry[] = [], names = new Set<string>();
    const kinds = ['file', 'directory', 'symlink', 'other'] as const;
    for (let i = 0; i < count; i++) {
      const length = decode.take(2).readUInt16BE();
      if (length < 1 || length > 255) throw new NativeFilesystemError('PROTOCOL_INVALID');
      const bytes = decode.take(length), name = bytes.toString('utf8');
      // Round-trip rejects malformed UTF-8; component parsing rejects separators/dot/control names.
      if (!Buffer.from(name, 'utf8').equals(bytes)) throw new NativeFilesystemError('PROTOCOL_INVALID');
      let valid = false;
      try { const parsed = components(name); valid = parsed.length === 1 && parsed[0]!.equals(bytes); } catch { /* refused below */ }
      if (!valid || names.has(name)) throw new NativeFilesystemError('PROTOCOL_INVALID');
      names.add(name);
      const kind = decode.take(1)[0], entry = decode.identity(), mode = entry.mode & 0o170000;
      const actualKind = mode === 0o100000 ? 1 : mode === 0o040000 ? 2 : mode === 0o120000 ? 3 : 4;
      if (!kind || kind > 4 || kind !== actualKind || BigInt(entry.nlink) < 1n) throw new NativeFilesystemError('PROTOCOL_INVALID');
      entries.push(Object.freeze({ name, kind: kinds[kind - 1]!, identity: Object.freeze(entry) }));
    }
    decode.end();
    entries.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return Object.freeze({ identity: Object.freeze(identity), entries: Object.freeze(entries) });
  }

  /** Expected bytes/identity are checked before unlinkat, without a kernel target-CAS guarantee. */
  unlink(input: NativeUnlink): NativeUnlinkResult {
    const parts = components(input.rel), snapshot = input.expected;
    if (!snapshot || !(snapshot.bytes instanceof Uint8Array) || snapshot.bytes.length > NATIVE_FILE_LIMIT
      || String(snapshot.bytes.length) !== snapshot.size || snapshot.nlink !== '1'
      || !Number.isInteger(snapshot.mode) || (snapshot.mode & 0o170000) !== 0o100000) throw new NativeFilesystemError('PROTOCOL_INVALID');
    const expected = Buffer.from(snapshot.bytes), length = Buffer.alloc(4); length.writeUInt32BE(expected.length);
    const response = this.invoke(5, parts, Buffer.concat([metaBytes(snapshot), length, expected]));
    // Malformed launched mutator payloads cannot certify zero effects, even without an acknowledgement.
    const decode = new Decoder(response.payload, true), removed = decode.take(1)[0]; decode.end();
    if ((removed !== 0 && removed !== 1) || response.committed !== (removed === 1)) throw new NativeFilesystemError('PROTOCOL_INVALID', true);
    return Object.freeze({ removed: removed === 1 });
  }

  replace(input: NativeReplace): NativeCommit {
    const parts = components(input.rel);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length > NATIVE_FILE_LIMIT) throw new NativeFilesystemError('SIZE_LIMIT');
    const policy = { 'create-only': 1, 'authorized-replace': 2, merge: 3 }[input.policy];
    if (!policy || input.expected === undefined) throw new NativeFilesystemError('PROTOCOL_INVALID');
    if (policy === 1 && input.expected) throw new NativeFilesystemError('CONFLICT');
    const content = Buffer.from(input.bytes); const size = Buffer.alloc(4); size.writeUInt32BE(content.length);
    const tail: Buffer[] = [Buffer.from([policy, input.expected ? 1 : 0])];
    if (input.expected) {
      if (!(input.expected.bytes instanceof Uint8Array) || input.expected.bytes.length > NATIVE_FILE_LIMIT) throw new NativeFilesystemError('PROTOCOL_INVALID');
      const expected = Buffer.from(input.expected.bytes);
      if (expected.length > NATIVE_FILE_LIMIT || String(expected.length) !== input.expected.size || input.expected.nlink !== '1') throw new NativeFilesystemError('PROTOCOL_INVALID');
      const length = Buffer.alloc(4); length.writeUInt32BE(expected.length); tail.push(metaBytes(input.expected), length, expected);
    }
    tail.push(size, content);
    const response = this.invoke(2, parts, Buffer.concat(tail)); const decode = new Decoder(response.payload, response.committed);
    const action = decode.take(1)[0]; const actions = ['create', 'overwrite', 'merge', 'unchanged'] as const;
    if (!action || action > 4 || (action === 4 ? response.committed : !response.committed)) throw new NativeFilesystemError('PROTOCOL_INVALID', response.committed);
    const identity = decode.identity(), bytesReadBack = decode.content(identity); decode.end();
    if (!bytesReadBack.equals(content)) throw new NativeFilesystemError('STALE_CONTENT', response.committed);
    return Object.freeze({ ...identity, action: actions[action - 1]!, bytesReadBack });
  }

  mkdir(rel: string): NativeIdentity {
    const response = this.invoke(3, components(rel)); const decode = new Decoder(response.payload, response.committed);
    const identity = decode.identity(); decode.end();
    if ((identity.mode & 0o170000) !== 0o040000) throw new NativeFilesystemError('PROTOCOL_INVALID', response.committed);
    return identity;
  }

  close(): void { if (!this.closed) { this.closed = true; closeSync(this.fd); } }
}
