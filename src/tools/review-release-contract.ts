import { SwfteApiError } from '../client.js';

export const releaseKinds = ['WORKFLOW', 'AGENT', 'CHATFLOW', 'MODEL', 'APPLICATION', 'WIDGET', 'STUDIO_CHANGE'] as const;
const kinds = ['workflow', 'agent', 'chatflow', 'model', 'application', 'widget', 'studio-change'];
const stages = ['SHADOW', 'CANARY', 'AB', 'RAMP', 'COMPLETE', 'ROLLED_BACK', 'PAUSED'];
type RecordValue = Record<string, any>;
export const record = (v: unknown): v is RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
export const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 512 && v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v);
export const canonicalHash = (v: unknown): v is string => typeof v === 'string' && v.length === 71 && /^sha256:[0-9a-f]{64}$/.test(v);
const whole = (v: unknown, minimum = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum;
const weight = (v: unknown) => whole(v) && v <= 10000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nullableText = (v: unknown) => v === null || text(v);
const nullableDecimal = (v: unknown) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 512 && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(v) && Number.isFinite(Number(v)));
const nullableHash = (v: unknown) => v === null || canonicalHash(v);
const member = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);
const strings = (v: unknown) => record(v) && Object.entries(v).every(([key, value]) => text(key) && typeof value === 'string');
function refused(path: string, code: string, mutation = false): never {
  throw new SwfteApiError({ status: 503, code, method: mutation ? 'POST' : 'GET', path,
    message: mutation ? 'Outcome is unconfirmed. Reconcile the authoritative release or action before retrying.' : 'Exact bound release evidence is unavailable or inconsistent.' });
}
function scope(v: RecordValue, workspace?: string): boolean {
  return text(v.workspaceId) && (!workspace || v.workspaceId === workspace) && text(v.artifactId)
    && member(v.subject, ['ARTIFACT_TRAFFIC', 'STUDIO_CHANGE_AUDIENCE']) && member(v.kind, releaseKinds) && member(v.stage, stages);
}
function plan(v: unknown): boolean {
  if (!record(v) || !Array.isArray(v.steps) || !v.steps.length || !v.steps.every(s => record(s) && member(s.stage, stages.slice(0, 5)) && weight(s.candidateWeight) && whole(s.minimumUnits))
      || !record(v.assignment) || !member(v.assignment.unit, ['END_USER', 'SESSION', 'TENANT', 'RECORD_KEY', 'RUN']) || !text(v.assignment.saltRef)
      || !Array.isArray(v.cohorts) || !v.cohorts.every(c => record(c) && strings(c.match) && Object.keys(c.match).length > 0
        && ((weight(c.candidateWeight) && c.pin === null) || (c.candidateWeight === null && member(c.pin, ['baseline', 'candidate']))))
      || !text(v.primaryMetric) || ![v.baselineRate, v.mde, v.alpha, v.power].every(finite)
      || !whole(v.minDurationDays) || !whole(v.maxDurationDays, 1) || !whole(v.expectedDailyUnits) || typeof v.userFacing !== 'boolean'
      || !Array.isArray(v.guardrails) || !v.guardrails.every(g => record(g) && text(g.metric) && member(g.comparison, ['RELATIVE', 'ABSOLUTE'])
        && finite(g.threshold) && g.threshold >= 0 && member(g.effect, ['PAUSE', 'ROLLBACK']) && whole(g.minimumUnits) && nullableText(g.sourceRef) && nullableText(g.sourceMetric))) return false;
  const i = v.inference;
  return record(i) && text(i.designId) && whole(i.fixedHorizonPerArm, 1) && whole(i.maximumPerArm, i.fixedHorizonPerArm)
    && Array.isArray(i.informationFractions) && Array.isArray(i.boundaries) && i.boundaries.length > 0
    && i.boundaries.length === i.informationFractions.length && i.boundaries.every(finite) && i.informationFractions.every(finite)
    && record(i.allocation) && text(i.allocation.designId) && finite(i.allocation.alpha) && finite(i.allocation.admissionFraction);
}
export function releaseStatus(v: unknown, id: string, workspace: string | undefined, path: string): RecordValue {
  const version = (p: unknown) => record(p) && text(p.version) && canonicalHash(p.contentHash) && nullableHash(p.bundleHash);
  if (!record(v) || v.releaseId !== id || !scope(v, workspace) || !text(v.targetId) || !text(v.environment)
      || !version(v.baseline) || !version(v.candidate) || !canonicalHash(v.planHash) || !plan(v.plan)
      || !weight(v.candidateWeight) || !whole(v.revision) || !whole(v.ledgerSeq) || typeof v.underpowered !== 'boolean' || typeof v.allocationMismatch !== 'boolean'
      || (['SHADOW', 'PAUSED', 'ROLLED_BACK'].includes(v.stage) && v.candidateWeight !== 0)) refused(path, 'RELEASE_STATUS_BINDING_INVALID');
  return v;
}
export function releaseSummary(v: unknown, id: string, workspace: string | undefined, path: string): RecordValue {
  if (!record(v) || v.releaseId !== id || !scope(v, workspace) || !canonicalHash(v.contentHash) || !canonicalHash(v.planHash)
      || !whole(v.baselineUnits) || !whole(v.candidateUnits) || !whole(v.requiredPerArm, 1) || !whole(v.ledgerSeq)
      || typeof v.underpowered !== 'boolean' || !member(v.withheld, ['NONE', 'ALLOCATION_MISMATCH', 'DEPENDENCY_UNAVAILABLE'])
      || !nullableText(v.baselineCost) || !nullableText(v.candidateCost) || !nullableText(v.bundleVersion)
      || !Array.isArray(v.guardrails) || !v.guardrails.every(g => record(g) && text(g.key) && member(g.status, ['UNKNOWN', 'MISSING_MANDATORY', 'INSUFFICIENT', 'BREACHED', 'PASS']) && nullableText(g.observed) && nullableText(g.threshold) && nullableText(g.effect))
      || (v.withheld !== 'NONE' && v.primary !== null)
      || (v.primary !== null && (!record(v.primary) || !member(v.primary.outcome, ['BETTER', 'NO_DETECTABLE_DIFFERENCE', 'WORSE', 'STOPPED_FOR_HARM', 'INCONCLUSIVE_UNDERPOWERED', 'SAFE_NOT_SHOWN_BETTER', 'PENDING'])
        || !nullableDecimal(v.primary.difference) || !nullableDecimal(v.primary.intervalLow) || !nullableDecimal(v.primary.intervalHigh) || !nullableText(v.primary.wording)
        || (v.primary.outcome === 'BETTER' && v.underpowered)))) refused(path, 'RELEASE_SUMMARY_BINDING_INVALID');
  return v;
}
export function releaseTransition(v: unknown, id: string, control: 'pause' | 'rollback', path: string): RecordValue {
  if (!record(v) || v.releaseId !== id || !whole(v.ledgerSeq) || v.candidateWeight !== 0
      || !member(v.stage, control === 'pause' ? ['PAUSED', 'ROLLED_BACK'] : ['ROLLED_BACK'])) refused(path, 'RELEASE_CONTROL_UNCONFIRMED', true);
  return v;
}
export type ReleaseProposalAuthority = { releaseId: string; workspaceId: string; target: { kind: string; id: string }; environment: string; contentHash: string; planHash: string };
// Java String.trim removes only code units <= U+0020. JS trim would admit different native identities.
const javaTrim = (value: string) => value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
export function releaseProposalAuthority(v: unknown, input: RecordValue, workspace: string | undefined, path: string): ReleaseProposalAuthority {
  if (!record(v) || typeof v.environment !== 'string' || v.environment.length > 512) refused(path, 'RELEASE_AUTHORITY_UNCONFIRMED');
  if (typeof v.artifactId !== 'string' || v.artifactId.length < 1 || v.artifactId.length > 200 || /[^A-Za-z0-9_.:@-]/.test(v.artifactId)) refused(path, 'RELEASE_AUTHORITY_UNCONFIRMED');
  const environment = javaTrim(v.environment).toLowerCase();
  if (!member(environment, ['development', 'staging', 'production'])) refused(path, 'RELEASE_AUTHORITY_UNCONFIRMED');
  // Validate the native full row while handling environment exactly as inherited ActionService does.
  const native = releaseStatus({ ...v, environment }, input.releaseId, workspace, path);
  if (native.candidate.contentHash !== input.expectedContentHash || native.planHash !== input.expectedPlanHash) refused(path, 'RELEASE_AUTHORITY_UNCONFIRMED');
  return { releaseId: native.releaseId, workspaceId: native.workspaceId, target: { kind: native.kind.toLowerCase().replace('_', '-'), id: native.artifactId },
    environment, contentHash: native.candidate.contentHash, planHash: native.planHash };
}
export function releaseProposal(v: unknown, input: RecordValue, authority: ReleaseProposalAuthority, path: string): RecordValue {
  if (!record(v) || !text(v.id) || v.id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v.id)
      || !record(v.target) || !member(v.target.kind, kinds) || v.target.kind !== authority.target.kind || v.target.id !== authority.target.id
      || v.environment !== authority.environment || !strings(v.params) || Object.values(v.params).some(value => (value as string).length > 2048)
      || authority.releaseId !== input.releaseId || authority.contentHash !== input.expectedContentHash || authority.planHash !== input.expectedPlanHash
      || v.status !== 'PROPOSED' || v.requiresApproval !== true || v.contentHash !== input.expectedContentHash || v.planHash !== input.expectedPlanHash
      || v.capability !== (input.desiredStage === 'COMPLETE' ? 'release.complete' : 'release.ramp')
      || v.params.releaseId !== input.releaseId || v.params.stage !== input.desiredStage || v.params.planHash !== input.expectedPlanHash
      || v.params.candidateWeight !== String(input.candidateWeight)) refused(path, 'RELEASE_PROPOSAL_UNCONFIRMED', true);
  return v;
}
