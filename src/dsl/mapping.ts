/**
 * Translation between the DSL spec shape and the backend's own record shapes.
 *
 * The DSL (swfte-python `swfte/dsl.py`) is written to read well in a diff. The
 * backend's records are written to execute. They are deliberately not the same
 * shape, so ALL translation lives here — one place to look when they disagree,
 * and one place to fix it.
 *
 * Contract, depended on by both the exporter and the applier:
 *
 *   fromBackend(kind, record)  →  ResourceSpec     (server → DSL)
 *   toBackend(spec)            →  BackendPayload   (DSL → server)
 *
 * Round-trip invariant: `toBackend(fromBackend(k, r))` must produce a payload
 * the server accepts as an update to `r` with no semantic change. Anything that
 * cannot survive that trip belongs in `lossy` so it is reported rather than
 * silently dropped.
 */

/** Kinds the DSL can express. Mirrors swfte/dsl.py. */
export type SpecKind =
  | 'module'
  | 'agent'
  | 'workflow'
  | 'chatflow'
  | 'widget'
  | 'application'
  | 'model'
  | 'mcp-server'
  | 'deployment';

/** A `{"$ref": {kind, key}}` pointer, as emitted by the DSL. */
export interface SpecRef {
  $ref: { kind: SpecKind; key: string };
}

export const isRef = (v: unknown): v is SpecRef =>
  typeof v === 'object' && v !== null && '$ref' in (v as Record<string, unknown>);

export const makeRef = (kind: SpecKind, key: string): SpecRef => ({ $ref: { kind, key } });

/** One declared resource, as it appears in the DSL's exported JSON. */
export interface ResourceSpec {
  kind: SpecKind;
  /** Stable local identifier. Survives in VCS; references resolve against it. */
  key: string;
  name: string;
  description?: string;
  /** Server-assigned id. Present once pushed, so a re-push updates in place. */
  id?: string;
  [field: string]: unknown;
}

export interface SpecDocument {
  version: number;
  resources: ResourceSpec[];
  unresolvedRefs?: string[];
}

/** A payload ready to send, plus the route to send it on. */
export interface BackendPayload {
  kind: SpecKind;
  /** Path for a create (POST). */
  createPath: string;
  /** Path for an update, given an id. */
  updatePath: (id: string) => string;
  /** Update verb — some kinds only accept PUT, and PATCH would wipe fields. */
  updateMethod: 'PUT' | 'PATCH';
  body: Record<string, unknown>;
  /**
   * Fields that could not be represented on the wire. Surfaced to the caller
   * rather than dropped, because a silently-lost field is indistinguishable
   * from one that was never set.
   */
  lossy: string[];
}

export interface FromBackendResult {
  spec: ResourceSpec;
  /** Backend fields with no DSL equivalent. Reported, not discarded. */
  lossy: string[];
}

export class MappingError extends Error {
  constructor(
    readonly kind: string,
    message: string
  ) {
    super(`[${kind}] ${message}`);
    this.name = 'MappingError';
  }
}

/**
 * Resolve `$ref` pointers to server ids using a key→id map built during a push.
 * Returns the ids and the refs that could not be resolved, so an unresolvable
 * reference becomes a reported decision instead of a null on the wire.
 */
export function resolveRefs(
  value: unknown,
  idsByKey: Map<string, string>
): { value: unknown; unresolved: string[] } {
  const unresolved: string[] = [];

  const walk = (v: unknown): unknown => {
    if (isRef(v)) {
      const { kind, key } = v.$ref;
      const id = idsByKey.get(key);
      if (!id) {
        unresolved.push(`${kind}:${key}`);
        return null;
      }
      return id;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };

  return { value: walk(value), unresolved };
}

// ---------------------------------------------------------------------------
// Registry — one mapper per kind.
// ---------------------------------------------------------------------------

export interface KindMapper {
  kind: SpecKind;
  fromBackend(record: Record<string, unknown>): FromBackendResult;
  toBackend(spec: ResourceSpec): BackendPayload;
  /** How to fetch this kind's dependencies when exporting a whole graph. */
  dependencyIds?(record: Record<string, unknown>): Array<{ kind: SpecKind; id: string }>;
}

const MAPPERS = new Map<SpecKind, KindMapper>();

export function registerMapper(mapper: KindMapper): void {
  MAPPERS.set(mapper.kind, mapper);
}

export function getMapper(kind: SpecKind): KindMapper {
  const m = MAPPERS.get(kind);
  if (!m) {
    throw new MappingError(
      kind,
      `No mapper registered. Implemented: ${[...MAPPERS.keys()].join(', ') || '(none)'}`
    );
  }
  return m;
}

export const mappedKinds = (): SpecKind[] => [...MAPPERS.keys()];

export function fromBackend(kind: SpecKind, record: Record<string, unknown>): FromBackendResult {
  return getMapper(kind).fromBackend(record);
}

export function toBackend(spec: ResourceSpec): BackendPayload {
  return getMapper(spec.kind).toBackend(spec);
}
