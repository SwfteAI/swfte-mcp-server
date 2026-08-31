/** Types for the vendored manifest derivation. See lib/rules.d.mts for why these are declared, not ported. */
import type { PreflightManifest } from './lib/snapshot.d.mts';

export type Seed = [kind: string, id: string];

export function commonTablePrefix(names: string[]): string | undefined;
export function referencesOf(kind: string, record: unknown): Seed[];
export function tableNamesIn(record: unknown): string[];
export function uuidsIn(value: unknown, key?: string, out?: Map<string, string>): Map<string, string>;
export function probeKind(
  id: string,
  hintKey: string,
  opts?: { log?: (m: string) => void }
): Promise<{ kind: string | null; record: unknown }>;
export function walkLive(
  seeds: Seed[],
  opts?: { log?: (m: string) => void; maxComponents?: number }
): Promise<{ components: Array<Record<string, unknown>>; errors: string[]; truncated: boolean }>;
export function seedsFromRegistry(
  registryPath: string,
  opts?: { log?: (m: string) => void }
): Promise<{ seeds: Seed[]; unresolved: string[] }>;
export function deriveFromLive(
  seeds: Seed[],
  opts?: {
    id?: string;
    name?: string;
    log?: (m: string) => void;
    registryUnresolved?: string[];
    source?: string;
    baseDir?: string;
    sourceDirs?: string[];
  }
): Promise<PreflightManifest>;
export function deriveFromSpec(specPath: string): PreflightManifest;
