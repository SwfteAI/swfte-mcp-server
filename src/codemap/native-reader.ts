/** Internal scanner authority. A root label is for output only; all reads/listing use the held descriptor. */
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeFilesystem, NativeFilesystemError, type NativeDirectorySnapshot } from '../native-filesystem.js';

const INCOMPLETE = new Set(['PATH_REFUSED', 'SYMLINK_REFUSED', 'HARDLINK_REFUSED', 'STALE_CONTENT', 'SIZE_LIMIT', 'IO_ERROR']);
export function isNativeScanIncomplete(error: unknown): error is NativeFilesystemError {
  return error instanceof NativeFilesystemError && INCOMPLETE.has(error.code);
}

export class NativeScanReader {
  readonly root: string;
  private readonly capability: NativeFilesystem;
  private readonly observed = new Map<string, string>();
  constructor(root: string) {
    this.root = resolve(root);
    this.capability = NativeFilesystem.openRoot(root);
  }
  private relative(path: string): string {
    // No normalization that could erase traversal. Producer enforces its own component/byte bounds.
    if (path.includes('\0') || path.includes('\\') || path.startsWith('/')
      || path.split('/').some(part => part === '.' || part === '..' || part === '' && path !== '')) {
      throw new NativeFilesystemError('PATH_REFUSED');
    }
    return path;
  }
  private stable(key: string, value: string): void {
    const prior = this.observed.get(key);
    if (prior !== undefined && prior !== value) throw new NativeFilesystemError('STALE_CONTENT');
    this.observed.set(key, value);
  }
  list(path = ''): NativeDirectorySnapshot | null {
    const result = this.capability.list(this.relative(path));
    this.stable('directory:' + path, createHash('sha256').update(JSON.stringify(result)).digest('hex'));
    return result;
  }
  readText(path: string, maxBytes = 1024 * 1024): string | null {
    const snapshot = this.capability.read(this.relative(path), maxBytes);
    this.stable('file:' + path, snapshot === null ? 'ABSENT' : createHash('sha256').update(snapshot.bytes).digest('hex'));
    return snapshot?.bytes.toString('utf8') ?? null;
  }
  close(): void { this.capability.close(); }
}

export async function withNativeScanReader<T>(root: string, callback: (reader: NativeScanReader) => T | Promise<T>): Promise<T> {
  const reader = new NativeScanReader(root);
  try { return await callback(reader); } finally { reader.close(); }
}
