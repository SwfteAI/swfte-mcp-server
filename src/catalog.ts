/**
 * The Studio catalog, read from the developer's side.
 *
 * Studio is the source of truth for what already exists and how well it is
 * proven. Everything here is a thin, typed reader over the catalog contract
 * (`/v2/catalog/*`) plus the few derivations the MCP tools share: parsing a
 * `catalogRef`, assembling the "context package" a coding agent needs before
 * it bakes an artifact into a codebase, and a stable hash of the contract so a
 * lock file can tell when the thing it generated against has moved.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SwfteClient } from './client.js';
import { SwfteApiError } from './client.js';

export const CATALOG_KINDS = [
  'workflow',
  'agent',
  'chatflow',
  'widget',
  'application',
  'mcp-server',
  'model',
  'module',
  'solution',
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const EVIDENCE_LEVELS = [
  'unmeasured',
  'observed',
  'corroborated',
  'validated',
  'verified',
  'stale',
  'disputed',
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const ACTION_CAPABILITIES = [
  'workflow.deploy',
  'app.host',
  'app.payments.enable',
  'connect.start',
  'analytics.enable',
] as const;
export type ActionCapability = (typeof ACTION_CAPABILITIES)[number];

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;

/** Rank used only to compare levels on the proven ladder; stale/disputed sit outside it. */
const LADDER: Record<string, number> = { unmeasured: 0, observed: 1, corroborated: 2, validated: 3, verified: 4 };

/** Levels strong enough to recommend reuse without a caveat. */
export const REUSABLE_LEVELS: ReadonlySet<string> = new Set(['corroborated', 'validated', 'verified']);

export const CatalogRefArg = z
  .string()
  .regex(/^[a-z-]+:[^\s:][^\s]*$/, 'catalogRef must look like "<kind>:<id>", e.g. "workflow:wf_123"')
  .describe('Catalog reference "<kind>:<id>", as returned by swfte_find_existing (e.g. "workflow:wf_123").');

export interface CatalogRef {
  kind: CatalogKind;
  id: string;
  ref: string;
}

export function parseCatalogRef(ref: string): CatalogRef {
  const at = ref.indexOf(':');
  const kind = ref.slice(0, at) as CatalogKind;
  const id = ref.slice(at + 1).trim();
  if (at <= 0 || !id) throw new Error(`Invalid catalogRef "${ref}" — expected "<kind>:<id>".`);
  if (!(CATALOG_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown catalog kind "${kind}" in "${ref}". Known kinds: ${CATALOG_KINDS.join(', ')}.`);
  }
  return { kind, id, ref: `${kind}:${id}` };
}

export const catalogPath = (r: CatalogRef) => `/v2/catalog/${encodeURIComponent(r.kind)}/${encodeURIComponent(r.id)}`;

/* ── wire shapes (CONTRACT rev 2) ─────────────────────────────────────────── */

export interface Facet {
  key: string;
  value: string;
  confidence: number | null;
  status: 'PROPOSED' | 'CONFIRMED' | 'DISPUTED';
  source: string;
}

export interface EvidenceSummary {
  level: EvidenceLevel;
  runs?: { total: number; succeeded: number; failed: number };
  successRate?: number | null;
  lastRunAt?: string | null;
  evals?: number;
  reviews?: { approve: number; reject: number };
  reasons?: string[];
  /** Rev 5: evidence is computed from independent workspaces only; these say how much of it there is. */
  independentWorkspaces?: number;
  successRateInterval?: [number, number] | null;
  freshness?: 'fresh' | 'stale';
  /** Rev 4: distinct workspaces with a successful run through a generated client in 30 days. */
  adopters?: number;
  /** Rev 5: run split — the author's own workspace vs everybody else. */
  own?: { total?: number; succeeded?: number; failed?: number } | null;
  independent?: { total?: number; succeeded?: number; failed?: number } | null;
}

/** Rev 3: who made an entry and why, and where it came from. */
export interface Provenance {
  author?: { id?: string; displayName?: string | null; workspaceName?: string | null } | null;
  createdAt?: string | null;
  why?: string | null;
  forkedFrom?: string | null;
  forks?: number;
  adoptedBy?: number;
  version?: string | null;
}

export interface CatalogEntrySummary {
  catalogRef: string;
  kind: CatalogKind;
  id: string;
  workspaceId?: string | null;
  scope?: 'workspace' | 'public';
  name: string;
  description?: string | null;
  source?: string;
  listingId?: string | null;
  facets?: Facet[];
  evidence?: EvidenceSummary;
  updatedAt?: string;
  shapeHash?: string | null;
  /** Rev 5: SPDX id or "proprietary". */
  license?: string | null;
  /** Rev 3 detail field; some servers also project it onto summaries. */
  provenance?: Provenance | null;
}

export interface CatalogEntryDetail extends CatalogEntrySummary {
  /** Rev 5: a fork's inherited evidence, reported beside its own and never merged into it. */
  parentEvidence?: EvidenceSummary | null;
  rationale?: Record<string, unknown> | null;
  evidenceRecords?: Array<{ type: string; refId: string; status: string; at: string }>;
  dependencies?: Array<{ catalogRef: string; relation: string }>;
  reviews?: Array<{ id: string; verdict: string; role: string; note?: string; reviewerId?: string; at?: string }>;
}

export interface JsonSchema {
  [k: string]: unknown;
}

export interface CatalogContract {
  catalogRef: string;
  invoke: {
    method: string;
    path: string;
    auth: 'pat' | 'api_key' | 'public';
    async: boolean;
    statusPath: string | null;
  };
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  snippets?: Record<string, string>;
  embed?: { html: string } | null;
  /** Rev 4: the server's own contractHash (preferred over the local computation) and the artifact version. */
  contractHash?: string | null;
  version?: string | null;
}

export interface SearchResponse {
  items: CatalogEntrySummary[];
  nextCursor: string | null;
  degraded: string[];
}

/* ── readers ─────────────────────────────────────────────────────────────── */

export async function searchCatalog(
  client: SwfteClient,
  q: {
    query?: string;
    kinds?: string[];
    scope?: string;
    minEvidence?: string;
    domain?: string;
    capability?: string;
    industry?: string;
    limit?: number;
    cursor?: string;
  }
): Promise<SearchResponse> {
  const res = await client.request<Partial<SearchResponse>>({
    method: 'GET',
    path: '/v2/catalog/search',
    query: {
      q: q.query ?? '',
      kinds: q.kinds?.length ? q.kinds.join(',') : undefined,
      scope: q.scope,
      domain: q.domain,
      capability: q.capability,
      industry: q.industry,
      minEvidence: q.minEvidence,
      limit: q.limit,
      cursor: q.cursor,
    },
  });
  return {
    items: Array.isArray(res?.items) ? res!.items : [],
    nextCursor: res?.nextCursor ?? null,
    degraded: Array.isArray(res?.degraded) ? res!.degraded : [],
  };
}

export function getEntry(client: SwfteClient, r: CatalogRef): Promise<CatalogEntryDetail> {
  return client.request<CatalogEntryDetail>({ method: 'GET', path: catalogPath(r) });
}

export function getContract(client: SwfteClient, r: CatalogRef): Promise<CatalogContract> {
  return client.request<CatalogContract>({ method: 'GET', path: `${catalogPath(r)}/contract` });
}

/* ── derivations ─────────────────────────────────────────────────────────── */

/** JSON with sorted keys, so the hash does not move when the server reorders a map. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * CONTRACT rev 4 canonical contractHash: lowercase hex sha256 of the canonical
 * (sorted-key, no-whitespace) JSON of {invoke, inputSchema, outputSchema}.
 * Snippets and embed markup are excluded — they are presentation, and a copy
 * edit to a snippet must not read as drift.
 */
export function contractHash(contract: Pick<CatalogContract, 'invoke' | 'inputSchema' | 'outputSchema'>): string {
  const material = stableStringify({
    invoke: contract.invoke,
    inputSchema: contract.inputSchema ?? {},
    outputSchema: contract.outputSchema ?? {},
  });
  return createHash('sha256').update(material).digest('hex');
}

/** A hash with any `sha256:` prefix removed, lowercased. */
export function normalizeHash(h: string | null | undefined): string {
  return String(h ?? '').trim().replace(/^sha256:/i, '').toLowerCase();
}

/**
 * Whether two contract hashes name the same contract. Tolerates the `sha256:`
 * prefix and the 32-character truncation written by earlier versions of this
 * package (same material, same digest, shorter), so an old lock is not drift.
 */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeHash(a);
  const y = normalizeHash(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 32 && long.startsWith(short);
}

/**
 * The hash to record for a contract: the server's when it sends one (it is the
 * party that answers /v2/catalog/upgrades), else the local canonical one. A
 * disagreement is surfaced, not hidden — it means the two canonicalisations
 * differ and upgrade checks may misfire.
 */
export function effectiveContractHash(contract: CatalogContract): { hash: string; local: string; server: string | null; warning?: string } {
  const local = contractHash(contract);
  const server = typeof contract.contractHash === 'string' && contract.contractHash.trim() ? contract.contractHash.trim() : null;
  if (!server) return { hash: local, local, server: null };
  return sameHash(server, local)
    ? { hash: server, local, server }
    : {
        hash: server,
        local,
        server,
        warning: `The server's contractHash (${server.slice(0, 19)}…) differs from the locally computed canonical hash (${local.slice(0, 12)}…). Using the server's; report this if upgrade checks misfire.`,
      };
}

export function ladderRank(level: string | undefined): number {
  return level && level in LADDER ? LADDER[level]! : -1;
}

/** One sentence per level, so a model does not have to know the ladder to read it. */
export function interpretEvidence(level: string | undefined): string {
  switch (level) {
    case 'verified':
      return 'Verified: validated evidence plus a domain-expert approval and no rejection. Strongest reuse signal.';
    case 'validated':
      return 'Validated: repeated successful runs plus a passing eval or an approving review. Safe to reuse.';
    case 'corroborated':
      return 'Corroborated: at least 5 terminal runs with >=80% success. Reuse, and add an eval or review to raise it.';
    case 'observed':
      return 'Observed: it has run at least once. Reuse is plausible but the record is thin — run it on your own inputs first.';
    case 'stale':
      return 'Stale: its latest evidence is older than 30 days. Re-run it before relying on it.';
    case 'disputed':
      return 'Disputed: recent runs fail at >=50% or a domain expert rejected it. Do not reuse without reading the reasons.';
    case 'unmeasured':
      return 'Unmeasured: no runs, evals or reviews recorded. Existence is not evidence that it works.';
    default:
      return 'No evidence summary returned.';
  }
}

/**
 * Who made an entry, why, where it came from and under what licence — the
 * Solution Hub's authorship line (CONTRACT rev 3/5). Absent fields read as
 * unknown (null), never as a blank that looks like an answer.
 */
export function presentProvenance(entry: Pick<CatalogEntrySummary, 'provenance' | 'license' | 'scope'>) {
  const p = entry.provenance ?? null;
  const author = p?.author
    ? { id: p.author.id ?? null, displayName: p.author.displayName ?? null, workspaceName: p.author.workspaceName ?? null }
    : null;
  return {
    author,
    why: p?.why ?? null,
    createdAt: p?.createdAt ?? null,
    forkedFrom: p?.forkedFrom ?? null,
    forks: typeof p?.forks === 'number' ? p.forks : null,
    adoptedBy: typeof p?.adoptedBy === 'number' ? p.adoptedBy : null,
    version: p?.version ?? null,
    // Rev 5: workspace entries default to proprietary when the server says nothing.
    license: entry.license ?? (entry.scope === 'public' ? null : 'proprietary'),
    ...(p ? {} : { note: 'The server returned no provenance for this entry; authorship and rationale are unknown, not absent.' }),
  };
}

/** One line naming the author and the why, for result lists. */
export function provenanceLine(entry: Pick<CatalogEntrySummary, 'provenance'>): string | null {
  const p = entry.provenance;
  if (!p) return null;
  const who = p.author?.displayName ?? p.author?.id ?? null;
  const parts = [
    who ? `by ${who}${p.author?.workspaceName ? ` (${p.author.workspaceName})` : ''}` : null,
    p.why ? `why: ${String(p.why).slice(0, 160)}` : null,
    p.forkedFrom ? `forked from ${p.forkedFrom}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' — ') : null;
}

/**
 * Evidence as the server computed it, with the rev 5 fields made explicit: how
 * many independent workspaces the level rests on, the Wilson interval around
 * the success rate, freshness, and the author's own runs kept apart from
 * independent ones. A fork's inherited evidence is reported separately as
 * parentEvidence and never merged in.
 */
export function presentEvidence(ev: EvidenceSummary | null | undefined, parent?: EvidenceSummary | null) {
  const e = ev ?? ({ level: 'unmeasured' } as EvidenceSummary);
  const out = {
    ...e,
    level: e.level ?? 'unmeasured',
    independentWorkspaces: typeof e.independentWorkspaces === 'number' ? e.independentWorkspaces : null,
    successRateInterval: Array.isArray(e.successRateInterval) ? e.successRateInterval : null,
    freshness: e.freshness ?? null,
    adopters: typeof e.adopters === 'number' ? e.adopters : null,
    interpretation: interpretEvidence(e.level),
    note: 'Descriptive, not a guarantee: levels above "observed" need independent runs from >=2 other workspaces; the author\'s own runs are reported apart and do not raise the level.',
  };
  return parent
    ? {
        ...out,
        parentEvidence: { ...parent, interpretation: interpretEvidence(parent.level) },
        parentNote: 'This entry is a fork. parentEvidence belongs to the source it was copied from and says nothing yet about this copy.',
      }
    : out;
}

/**
 * Rough cost of generating an artifact of this kind from scratch, used to make
 * the reuse trade visible. These are planning estimates from typical wizard
 * sessions, not measurements of this workspace, and they are labelled as such
 * wherever they surface.
 */
export const GENERATION_ESTIMATE: Record<CatalogKind, { tokens: number; seconds: number } | null> = {
  workflow: { tokens: 60_000, seconds: 120 },
  agent: { tokens: 15_000, seconds: 30 },
  chatflow: { tokens: 30_000, seconds: 60 },
  widget: { tokens: 20_000, seconds: 45 },
  application: { tokens: 150_000, seconds: 300 },
  'mcp-server': { tokens: 40_000, seconds: 90 },
  module: { tokens: 25_000, seconds: 60 },
  solution: { tokens: 250_000, seconds: 600 },
  // Models are uploaded or fine-tuned, not generated by a wizard.
  model: null,
};

/**
 * The context package: everything a coding agent should read before it calls,
 * embeds or wraps an existing artifact. Detail and contract are fetched
 * together; a kind with no contract yet still returns its evidence and
 * dependencies, with the contract gap reported rather than thrown.
 */
export async function getContextPackage(
  client: SwfteClient,
  r: CatalogRef,
  opts: { includeEvidenceRecords?: boolean; includeSnippets?: boolean } = {}
) {
  const [detail, contractResult] = await Promise.all([
    getEntry(client, r),
    getContract(client, r).then(
      (c) => ({ ok: true as const, contract: c }),
      (err: unknown) => ({ ok: false as const, err })
    ),
  ]);
  const contract = contractResult.ok ? contractResult.contract : null;
  const contractError = contractResult.ok
    ? undefined
    : contractResult.err instanceof SwfteApiError
      ? { status: contractResult.err.status, code: contractResult.err.code, message: contractResult.err.message }
      : { message: contractResult.err instanceof Error ? contractResult.err.message : String(contractResult.err) };
  if (!contractResult.ok && !(contractResult.err instanceof SwfteApiError)) throw contractResult.err;

  const facets = detail.facets ?? [];
  const hashInfo = contract?.invoke ? effectiveContractHash(contract) : null;
  const nextSteps: string[] = [];
  if (contract) {
    nextSteps.push(
      `Bake it into the codebase: swfte_scaffold_client {catalogRef:"${r.ref}"} (framework detected from the project; or run \`npx -p @swfte/mcp-server swfte add ${r.ref}\`).`
    );
    if (contract.embed?.html) nextSteps.push(`Embed it in a page: swfte_embed_widget {catalogRef:"${r.ref}", targetFile?}.`);
  } else {
    nextSteps.push('No invocation contract is published for this artifact yet; reuse it inside Studio (reference it from a workflow/solution) rather than calling it from code.');
  }
  if (!REUSABLE_LEVELS.has(detail.evidence?.level ?? '')) {
    nextSteps.push(`Evidence is "${detail.evidence?.level ?? 'unknown'}" — run it on representative inputs (swfte_run) before shipping it.`);
  }
  if (r.kind === 'application') {
    nextSteps.push('Wire analytics / payments: swfte_wire_analytics, swfte_wire_payments (approval-gated).');
  }
  nextSteps.push(`Check it fits your problem and stack before adopting: swfte_fit_check {catalogRef:"${r.ref}", problem:"…"}; its history: swfte_get_timeline.`);

  return {
    catalogRef: r.ref,
    kind: detail.kind ?? r.kind,
    id: detail.id ?? r.id,
    name: detail.name,
    description: detail.description ?? null,
    scope: detail.scope,
    source: detail.source,
    updatedAt: detail.updatedAt,
    shapeHash: detail.shapeHash ?? null,
    provenance: presentProvenance(detail),
    evidence: presentEvidence(detail.evidence, detail.parentEvidence),
    facets: {
      confirmed: facets.filter((f) => f.status === 'CONFIRMED'),
      proposed: facets.filter((f) => f.status === 'PROPOSED'),
      disputed: facets.filter((f) => f.status === 'DISPUTED'),
      note: 'PROPOSED facets are Jev classifications nobody has confirmed yet; treat them as hints, not facts.',
    },
    rationale: detail.rationale ?? null,
    dependencies: detail.dependencies ?? [],
    reviews: detail.reviews ?? [],
    ...(opts.includeEvidenceRecords === false ? {} : { evidenceRecords: detail.evidenceRecords ?? [] }),
    contract: contract
      ? {
          invoke: contract.invoke,
          inputSchema: contract.inputSchema ?? {},
          outputSchema: contract.outputSchema ?? {},
          embed: contract.embed ?? null,
          ...(opts.includeSnippets === false ? {} : { snippets: contract.snippets ?? {} }),
        }
      : null,
    ...(contractError ? { contractError } : {}),
    contractHash: hashInfo?.hash ?? null,
    ...(hashInfo?.warning ? { contractHashWarning: hashInfo.warning } : {}),
    nextSteps,
  };
}
