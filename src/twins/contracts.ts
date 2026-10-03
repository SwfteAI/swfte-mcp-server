import { z } from 'zod';
import { TwinIntakeRefusal } from './intake.js';

export const TWIN_INTAKE_PATH = '/v2/twins/intake';

function plainHttpUrl(value: string): URL | null {
  // URL() normalizes spaces and empty query/fragment delimiters; refuse them before parsing.
  if (!value || /[\x00-\x20\x7f?#]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(value)) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    return (url.protocol === 'https:' || url.protocol === 'http:' && loopback) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
/** Match SwfteClient.buildUrl: append the path to the full configured base, then serialize URL. */
export function intakeDestination(baseUrl: string): string {
  if (typeof baseUrl !== 'string' || !plainHttpUrl(baseUrl)) throw new TwinIntakeRefusal('TWIN_TREE_CONSENT_REQUIRED');
  const destination = plainHttpUrl(`${baseUrl}${TWIN_INTAKE_PATH}`);
  if (!destination) throw new TwinIntakeRefusal('TWIN_TREE_CONSENT_REQUIRED');
  return destination.toString();
}
function exactDestination(value: string): boolean {
  return plainHttpUrl(value)?.toString() === value;
}

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Instant = z.string().refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
});
const Consent = z.object({ recordId: Id, workspaceId: Id, repoId: Id, level: z.literal('tree'),
  destination: z.string().min(1).max(1024).refine(exactDestination), retentionSeconds: z.literal(86400), principalId: Id,
  expiresAt: Instant, revoked: z.literal(false) });
const Readiness = z.object({ workspaceId: Id, sourcePolicy: z.literal('synthetic-reference-only'),
  dependencies: z.array(z.string().min(1).max(256)).max(256), consent: z.unknown().optional() });
const Snapshot = z.object({ snapshotId: Id, workspaceId: Id, repoId: Id, snapshotHash: Hash,
  commitShas: z.array(z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)).max(256),
  consentRecordId: Id, bundleId: Id, receivedAt: Instant, codeExpiresAt: Instant, synthetic: z.literal(true) });
const Proposal = z.object({ snapshot: Snapshot, proposalId: Id, proposalHash: Hash,
  requiredConfirmations: z.array(z.enum(['services', 'build', 'test', 'seed', 'fidelity'])).length(5) });
const Twin = z.object({ twinId: Id, workspaceId: Id, creatorId: Id, changeAuthorId: Id,
  snapshotId: Id, snapshotHash: Hash, twinSpecHash: Hash, phase: z.enum(['INTAKE', 'BUILD', 'RUN', 'IDLE', 'TORN_DOWN']),
  hostHandle: Id.nullable(), surInstanceId: Id.nullable(), confidenceRunId: Id.nullable(),
  createdAt: Instant, hardExpiresAt: Instant, idleExpiresAt: Instant });
export type TwinConsentBinding = { workspaceId: string; consent: z.infer<typeof Consent> };
function instantParts(value: string): [number, number] {
  return [Date.parse(value.slice(0, 19) + 'Z'), Number((/\.(\d+)/.exec(value)?.[1] ?? '').padEnd(9, '0'))];
}
function compareInstants(a: string, b: string): number {
  const left = instantParts(a), right = instantParts(b);
  return left[0] - right[0] || left[1] - right[1];
}
function live(value: string): boolean {
  const parts = instantParts(value), now = Date.now(), whole = now - now % 1000;
  return parts[0] > whole || parts[0] === whole && parts[1] > (now % 1000) * 1000000;
}
function withinRetention(receivedAt: string, expiresAt: string): boolean {
  const before = instantParts(receivedAt), after = instantParts(expiresAt), delta = after[0] - before[0];
  return compareInstants(expiresAt, receivedAt) > 0 && (delta < 86400000 || delta === 86400000 && after[1] <= before[1]);
}

export function requireId(value: unknown): string {
  const parsed = Id.safeParse(value);
  if (!parsed.success) throw new TwinIntakeRefusal('INVALID_TWIN_ID');
  return parsed.data;
}
/** Generic discovery contains no source grant. Only the actual targeted current server record permits packing. */
export function requireTreeReadiness(value: unknown, workspaceId: string | undefined, repoId: string, consentId: string, destination: string): TwinConsentBinding {
  const parsed = Readiness.safeParse(value);
  if (!parsed.success || parsed.data.dependencies.length || (workspaceId && parsed.data.workspaceId !== workspaceId)) {
    throw new TwinIntakeRefusal('TWIN_INTAKE_DEPENDENCY_GAP');
  }
  const consent = Consent.safeParse(parsed.data.consent);
  if (!consent.success || consent.data.workspaceId !== parsed.data.workspaceId || consent.data.repoId !== repoId
    || consent.data.recordId !== consentId || consent.data.destination !== destination || !live(consent.data.expiresAt)) {
    throw new TwinIntakeRefusal('TWIN_TREE_CONSENT_REQUIRED');
  }
  return { workspaceId: parsed.data.workspaceId, consent: consent.data };
}
export function requireSameConsent(before: TwinConsentBinding, after: TwinConsentBinding): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new TwinIntakeRefusal('TWIN_TREE_CONSENT_REQUIRED');
}
export function requireIntakeProposal(value: unknown, binding: TwinConsentBinding, snapshotHash: string, commitShas: string[]) {
  const parsed = Proposal.safeParse(value);
  if (!parsed.success) throw new TwinIntakeRefusal('INVALID_TWIN_RESPONSE');
  const snapshot = parsed.data.snapshot;
  if (snapshot.workspaceId !== binding.workspaceId || snapshot.repoId !== binding.consent.repoId
    || snapshot.consentRecordId !== binding.consent.recordId || snapshot.snapshotHash !== snapshotHash
    || snapshot.commitShas.length !== commitShas.length || snapshot.commitShas.some((commit, i) => commit !== commitShas[i])
    || new Set(parsed.data.requiredConfirmations).size !== 5 || !withinRetention(snapshot.receivedAt, snapshot.codeExpiresAt) || !live(snapshot.codeExpiresAt)) {
    throw new TwinIntakeRefusal('INVALID_TWIN_RESPONSE');
  }
  return parsed.data;
}
export function requireTwin(value: unknown, workspaceId: string | undefined, twinId: string) {
  const parsed = Twin.safeParse(value);
  if (!parsed.success) throw new TwinIntakeRefusal('INVALID_TWIN_RESPONSE');
  const twin = parsed.data;
  if (twin.twinId !== twinId || (workspaceId && twin.workspaceId !== workspaceId) || compareInstants(twin.hardExpiresAt, twin.createdAt) <= 0
    || compareInstants(twin.idleExpiresAt, twin.createdAt) <= 0 || compareInstants(twin.idleExpiresAt, twin.hardExpiresAt) > 0
    || ((twin.phase === 'RUN' || twin.phase === 'IDLE') && (!twin.hostHandle || !twin.surInstanceId))) {
    throw new TwinIntakeRefusal('INVALID_TWIN_RESPONSE');
  }
  return twin;
}
