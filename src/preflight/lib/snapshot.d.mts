/** Types for the vendored snapshot builder. See rules.d.mts for why these are declared, not ported. */
export interface PreflightManifest {
  id?: string;
  name?: string;
  workspaceId?: string | number;
  baseDir?: string;
  $dir?: string;
  tablePrefix?: string;
  expectLive?: boolean;
  components?: Array<{ key: string; kind: string; id?: string }>;
  dataTables?: string[];
  allowedIntegrations?: string[];
  allowedOutbound?: string[];
  wires?: Array<{ from: string; to: string; relation: string; note?: string }>;
  coverage?: unknown[];
  sourceDirs?: string[];
  provenance?: Record<string, unknown>;
}
export interface Snapshot {
  manifest: PreflightManifest;
  workspaceId: string;
  components: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
  executions: Record<string, unknown[]>;
  dataTablesLive: unknown;
  knowledgeModules: unknown;
  datasets: unknown;
  datasetDocs: Record<string, unknown>;
  sourceFiles?: Array<{ path: string; text: string }>;
  errors: string[];
}
export function buildSnapshot(
  manifest: PreflightManifest,
  opts?: { executionsPerWorkflow?: number; log?: (m: string) => void }
): Promise<Snapshot>;
export function get(path: string, opts?: { timeoutMs?: number }): Promise<unknown>;
