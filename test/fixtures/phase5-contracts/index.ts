import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CatalogContract } from '../../../src/catalog.js';

export const FIXTURE_ROOT = new URL('./', import.meta.url);
export interface BackendContract extends Omit<CatalogContract, 'invoke'> {
  invoke: CatalogContract['invoke'] | null;
  invokeUnavailableReason: string | null;
}
export interface CapturedCase {
  file: string;
  catalogRef: string;
  kind: string;
  variant: string;
  sha256: string;
  origin: string;
  contract: BackendContract;
  bytes: Buffer;
}
export interface Provenance {
  format: number;
  mode: string;
  backendCommit: string;
  sourceSha256: Record<string, string>;
  derivedGoldenSha256: string;
  captureSourceSha256: string;
  cases: Array<Omit<CapturedCase, 'contract' | 'bytes'>>;
}
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Semantic probes intentionally load independently of the dedicated fingerprint oracle. */
export function capturedFixtures(): { provenance: Provenance; cases: CapturedCase[] } {
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', FIXTURE_ROOT), 'utf8')) as Provenance;
  const cases = provenance.cases.map(row => {
    if (!/^[A-Za-z0-9_-]+\.contract\.json$/.test(row.file)) throw new Error('Invalid fixture name');
    const bytes = readFileSync(new URL(row.file, FIXTURE_ROOT));
    return { ...row, bytes, contract: JSON.parse(bytes.toString('utf8')) as BackendContract };
  });
  return { provenance, cases };
}
export function workflowGolden(): BackendContract {
  return JSON.parse(readFileSync(new URL('two-input-workflow.golden.json', FIXTURE_ROOT), 'utf8')) as BackendContract;
}
