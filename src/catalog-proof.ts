import { z } from 'zod';
import { catalogPath, parseCatalogRef, type CatalogEntrySummary, type EvidenceSummary } from './catalog.js';
import type { SwfteClient } from './client.js';

export const ContentHash = z.string().regex(/^[a-f0-9]{64}$/, 'Expected lowercase SHA256');
export const ScenarioDefinition = z.object({
  scenarioId: z.string().min(1).max(1000),
  definition: z.record(z.unknown()),
  nodeIds: z.array(z.string().min(1).max(1000)).max(2000).default([]),
  contractFields: z.array(z.string().min(1).max(1000)).max(2000).default([]),
  coverageElementIds: z.array(z.string().min(1).max(1000)).max(2000).default([]),
  severity: z.enum(['INFO', 'MINOR', 'MAJOR', 'CRITICAL']),
}).strict();
export type ScenarioInput = z.input<typeof ScenarioDefinition>;
export type Scenario = z.output<typeof ScenarioDefinition> & { definitionHash: string; inherited: boolean };
export interface ProofSuite {
  suiteId: string; entryRef: string; version: number; suiteHash: string; scenarios: Scenario[];
  fixturesRef: string | null; checks: string[]; criteria: string[]; dealbreakers: string[]; rubricRef: string | null;
  origin: { parentEntryRef: string | null; parentSuiteHash: string | null; adoptedAt: string | null } | null;
}
export interface DeltaCoverage {
  changes: Array<{ id: string; kind: string; nodeId: string | null; field: string | null }>;
  scenariosByChange: Record<string, string[]>; uncovered: string[]; unresolvedElements: string[];
}
export interface ForkProofResult {
  pass: boolean; inherited: number; rerun: number; declared: number;
  scenarioFailures: string[]; delta: DeltaCoverage; dependencyGaps: string[];
}
export interface CatalogDeltaView { entryRef: string; contentHash: string; suiteHash: string; proof: ForkProofResult }
export interface CatalogProofView {
  entryRef: string; contentHash: string; suite: ProofSuite;
  deviations: Array<{ scenarioIds: string[]; reason: string; declaredBy: string; declaredAt: string }>;
  parentEvidence: unknown | null; parentSuiteOnCopy: ForkProofResult | null;
  ownEvidence: EvidenceSummary; confidence: unknown | null;
  bundle: { entryRef: string; contentHash: string; bundleDigest: string; signatureValid: boolean; downloadPath: string } | null;
  dependencyGaps: string[];
}
export interface ShelfPage {
  items: Array<{ entry: CatalogEntrySummary; contentHash: string; suiteHash: string; validationPacks: string[];
    tailoredFrom: string | null; independentProductionReleases: number; industryExpert: boolean }>;
  eligibleCount: number; countIsComplete: boolean; nextCursor: string | null; dependencyGaps: string[];
}

export class CatalogProofBindingError extends Error {
  readonly code = 'CATALOG_PROOF_CONTENT_MISMATCH';
  readonly status = 409;
  constructor() { super('Returned checks do not belong to the requested catalog content.'); }
}
function boundSuite(suite: ProofSuite, ref: string): ProofSuite {
  if (!suite || suite.entryRef !== ref || !ContentHash.safeParse(suite.suiteHash).success) throw new CatalogProofBindingError();
  return suite;
}
export async function getCatalogProof(client: SwfteClient, catalogRef: string, contentHash: string): Promise<CatalogProofView> {
  ContentHash.parse(contentHash);
  const ref = parseCatalogRef(catalogRef);
  const view = await client.request<CatalogProofView>({ method: 'GET', path: `${catalogPath(ref)}/proof-suite`, query: { contentHash } });
  if (!view || view.entryRef !== ref.ref || view.contentHash !== contentHash) throw new CatalogProofBindingError();
  boundSuite(view.suite, ref.ref);
  if (view.bundle && (view.bundle.entryRef !== ref.ref || view.bundle.contentHash !== contentHash)) throw new CatalogProofBindingError();
  return view;
}
export async function getCatalogDelta(client: SwfteClient, catalogRef: string, contentHash: string): Promise<CatalogDeltaView> {
  ContentHash.parse(contentHash);
  const ref = parseCatalogRef(catalogRef);
  const view = await client.request<CatalogDeltaView>({ method: 'GET', path: `${catalogPath(ref)}/delta`, query: { contentHash } });
  if (!view || view.entryRef !== ref.ref || view.contentHash !== contentHash || !ContentHash.safeParse(view.suiteHash).success) throw new CatalogProofBindingError();
  return view;
}
export async function extendCatalogSuite(client: SwfteClient, catalogRef: string,
    body: { expectedContentHash: string; expectedSuiteHash: string; scenarios: ScenarioInput[] }): Promise<ProofSuite> {
  ContentHash.parse(body.expectedContentHash); ContentHash.parse(body.expectedSuiteHash);
  const ref = parseCatalogRef(catalogRef);
  const scenarios = z.array(ScenarioDefinition).min(1).max(2000).parse(body.scenarios).map(s => ({ ...s, inherited: false }));
  const suite = await client.request<ProofSuite>({ method: 'POST', path: `${catalogPath(ref)}/proof-suite/extend`,
    body: { expectedContentHash: body.expectedContentHash, expectedSuiteHash: body.expectedSuiteHash, scenarios }, retries: 0 });
  return boundSuite(suite, ref.ref);
}
export async function declareCatalogDeviation(client: SwfteClient, catalogRef: string,
    body: { expectedContentHash: string; expectedSuiteHash: string; scenarioIds: string[]; reason: string }): Promise<ProofSuite> {
  const input = z.object({ expectedContentHash: ContentHash, expectedSuiteHash: ContentHash,
    scenarioIds: z.array(z.string().min(1).max(1000)).min(1).max(2000), reason: z.string().trim().min(1).max(1000) }).strict().parse(body);
  const ref = parseCatalogRef(catalogRef);
  return boundSuite(await client.request<ProofSuite>({ method: 'POST', path: `${catalogPath(ref)}/proof-suite/deviations`, body: input, retries: 0 }), ref.ref);
}
export function rerunParentSuite(client: SwfteClient, catalogRef: string, expectedContentHash: string, expectedParentSuiteHash: string): Promise<{ actionId: string }> {
  ContentHash.parse(expectedContentHash); ContentHash.parse(expectedParentSuiteHash);
  return client.request({ method: 'POST', path: `${catalogPath(parseCatalogRef(catalogRef))}/proof-suite/rerun`,
    body: { expectedContentHash, expectedParentSuiteHash }, retries: 0 });
}
export const ShelfQuery = z.object({ industry: z.string().regex(/^[a-z0-9-]+$/).max(100), task: z.string().regex(/^[a-z0-9-]+$/).max(100),
  kind: z.enum(['model', 'agent', 'mcp-server', 'solution', 'application']).optional(),
  cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict();
export function getCatalogShelves(client: SwfteClient, query: z.input<typeof ShelfQuery>): Promise<ShelfPage> {
  return client.request({ method: 'GET', path: '/v2/catalog/shelves', query: ShelfQuery.parse(query) });
}
