/**
 * Code map contract types (docs/codemap/CONTRACT.md, revision 1). Mirrors the agents-service manifest
 * schema `src/main/resources/codemap/manifest.schema.json` (schema id `swfte.codemap/1`).
 *
 * Only names and places ever cross the wire: paths (or their keyed hashes), lines, symbol names,
 * field names, env var NAMES, artifact refs and hashes. No type here has a field that could hold a
 * source line, a string literal from the code, or an env var value — keep it that way.
 */

export const MANIFEST_SCHEMA = 'swfte.codemap/1' as const;

export type Scanner = 'cli' | 'mcp' | 'ci' | 'agent';
export type Provider = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'other' | 'none';
export type SiteLanguage = 'typescript' | 'javascript' | 'python' | 'java' | 'html';
export type Sdk = 'node' | 'python' | 'java' | 'http' | 'widget-embed';
export type Op = 'run' | 'chat' | 'stream' | 'embed' | 'read-output' | 'webhook-receive';
export type Managed = 'typed-client' | 'raw-http';
export type AddedBy = 'claude-code' | 'codex' | 'human' | 'studio';

export interface ManifestRepo {
  /** `r_` + 32 hex: SHA-256 of the normalised remote (CONTRACT §2). */
  id: string;
  displayName?: string;
  provider: Provider;
  defaultBranch: string;
}

export interface ManifestArtifact {
  /** CatalogKind wire name: workflow, agent, chatflow, widget, … */
  kind: string;
  /** Null iff `unresolved`. Never guessed. */
  id: string | null;
  unresolved: boolean;
  /** Name (never value) of the env var the id comes from, when visible in code. */
  envVarName?: string;
  pinnedVersion: string | null;
  /** swfte.json alias of the generated client this site calls; null for SDK, raw HTTP and embeds. */
  alias: string | null;
  /** Filled by the backend on read; the scanner always sends null. */
  environment: string | null;
}

export interface Provenance {
  addedBy: AddedBy;
  via: 'mcp' | 'cli';
  pr?: number;
  at: string;
}

export interface CallSite {
  /** `cs_` + 24 hex keyed fingerprint (CONTRACT §2.1). */
  id: string;
  movedFrom?: string;
  /** Exactly one of `path` (plain mode) or `pathHash` (hashed mode). */
  path?: string;
  pathHash?: string;
  line: number;
  symbol: string;
  language: SiteLanguage;
  sdk: Sdk;
  op: Op;
  artifact: ManifestArtifact;
  contractHash: string | null;
  /** Dotted field names only, sorted and unique; `["*"]` when the scanner could not name them. */
  inputKeys: string[];
  outputKeys: string[];
  managed: Managed;
  provenance?: Provenance;
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  repo: ManifestRepo;
  commitSha: string;
  ref: { kind: 'default' | 'pr'; pr?: number };
  scannedAt: string;
  scanner: Scanner;
  pathHashing: boolean;
  truncated: boolean;
  notAnalysed: Record<string, number>;
  envVarNames: string[];
  callSites: CallSite[];
}

/** Evaluation bucket a detected site belongs to (fixtures' answer keys use the same names). */
export type SiteCategory = 'managed' | 'raw-http' | 'widget' | 'dynamic';

/** Languages a detector runs on; `html` templates are bucketed by their package root. */
export type SourceLanguage = 'typescript' | 'javascript' | 'python' | 'java' | 'html';

/** One source file handed to a detector. `text` stays in this process; it is never serialised. */
export interface SourceFile {
  /** POSIX path relative to the scan root. */
  relPath: string;
  language: SourceLanguage;
  text: string;
}

/** A swfte.json entry as the detectors need it (resolved per file: the nearest lock above it). */
export interface LockBinding {
  alias: string;
  catalogRef: string;
  language: 'typescript' | 'python';
  pinnedVersion: string | null;
  contractHash: string | null;
  /** Generated client files of this alias, relative to the scan root. */
  files: string[];
}

export interface DetectContext {
  /** Lock entries that apply to this file (nearest swfte.json above it); empty when none. */
  locks: LockBinding[];
  /** The directory of that lock, relative to the scan root ('' for the root). */
  lockDir: string | null;
}

/**
 * A site as a detector reports it, before fingerprinting. `line` is 1-based and is the line where the
 * call expression, embed element or URL-bearing call starts.
 */
export interface DetectedSite {
  relPath: string;
  line: number;
  /** Nearest named enclosing symbol (CONTRACT §2.1, decision D2). */
  symbol: string;
  language: SiteLanguage;
  category: SiteCategory;
  sdk: Sdk;
  op: Op;
  managed: Managed;
  artifact: Omit<ManifestArtifact, 'environment'>;
  contractHash: string | null;
  inputKeys: string[];
  outputKeys: string[];
  /** Id of the detector that produced it (for evaluation reports and mutants). */
  detector: string;
}

/** A generated client's own HTTP call: reported once as the implementation, never as a call site. */
export interface Implementation {
  relPath: string;
  line: number;
  alias: string;
}

export interface DetectResult {
  sites: DetectedSite[];
  implementations: Implementation[];
  /** `SWFTE_*` env var names referenced (names only). */
  envVarNames: string[];
}

export interface Detector {
  id: string;
  languages: SourceLanguage[];
  detect(file: SourceFile, ctx: DetectContext): DetectResult;
}

/** Wire header for per-call-site attribution (CONTRACT §6). */
export const CALLSITE_HEADER = 'X-Swfte-Callsite';
export const CALLSITE_ID_PATTERN = /^cs_[0-9a-f]{24}$/;
export const PATH_HASH_PATTERN = /^ph_[0-9a-f]{32}$/;
export const REPO_ID_PATTERN = /^r_[0-9a-f]{32}$/;
