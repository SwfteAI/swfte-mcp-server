/** Complete additive confidence v1 wire mirror; observations/calibration admission remain server-owned. */
export const CONFIDENCE_ARTIFACT_KINDS = ['WORKFLOW', 'AGENT', 'CHATFLOW', 'APPLICATION', 'WIDGET', 'WORKER', 'MODEL', 'SOLUTION', 'CODE_CHANGE', 'CODEBASE'] as const;
export const CONFIDENCE_PROFILES = ['QUICK', 'STANDARD', 'DEEP', 'ADVERSARIAL'] as const;
export type ConfidenceDimension = 'FUNCTION'|'COMPLETENESS'|'ROBUSTNESS'|'LOAD_COST'|'SECURITY'|'PRIVACY'|'COMPLIANCE'|'BEHAVIOUR';
export type ConfidenceVerdict = 'PASS'|'FAIL'|'UNKNOWN';
export type UnknownReason = 'NOT_EXERCISED'|'CRASHED'|'NO_VERDICT'|'CASSETTE_BROKEN'|'UNASSESSED_CONTROL'|'UNCALIBRATED_GRADER'|'BUDGET'|'LANE_UNVERIFIED'|'STALE';
export type EvidenceLevel = 'NONE'|'OBSERVED'|'CORROBORATED'|'VALIDATED'|'VERIFIED';
export interface ConfidenceBudget { persona:number;systemUnderTest:number;report:number;maxSteps:number }
export interface ModelSnapshotEntry { role:string;modelId:string;inputUsdPerMTok?:number|null;outputUsdPerMTok?:number|null;priced:boolean }
export interface ConfidenceRun {
  runId:string;workspaceId:string;artifactKind:typeof CONFIDENCE_ARTIFACT_KINDS[number];artifactId:string;contentHash:string;environment:'SANDBOX';
  profile:typeof CONFIDENCE_PROFILES[number];frameworks:string[];seed:number;budget:ConfidenceBudget;
  status:'QUEUED'|'RUNNING'|'COMPLETE'|'BUDGET_EXHAUSTED'|'FAILED'|'CANCELLED';engineVersion:string;calibrationVersion?:string|null;
  modelSnapshot:ModelSnapshotEntry[];cassetteHead?:string|null;startedAt?:string|null;finishedAt?:string|null;
}
export interface EvidenceRef { kind:'CASSETTE'|'EXEC_LOG'|'LEDGER'|'CONTROL_RECORD'|'CAPTURE';hash:string }
export interface ConfidenceInterval { n:number;successes:number;low:number;high:number }
export interface ConfidenceClaim {
  dimension:ConfidenceDimension;elementId:string;verdict:ConfidenceVerdict;unknownReason?:UnknownReason|null;
  /** P(verdict is correct), not the interval success ratio; never display-round for admission. */
  statedConfidence?:number|null;interval?:ConfidenceInterval|null;evidenceRefs:EvidenceRef[];dependsOn:string[];stale:boolean;
}
export interface ConfidenceFinding {
  fingerprint:string;dimension:ConfidenceDimension;elementId:string;rootCauseKey:string;severity:'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'|'INFO';
  status:'OPEN'|'FIXED';title:string;reproduction:string[];evidenceRefs:EvidenceRef[];affectedElements:string[];
  suggestedFix?:string|null;rerunCommand?:string|null;gap:boolean;
}
export interface ConfidenceCompleteness {
  covered:number;applicable:number;
  uncovered:{elementId:string;dimension:ConfidenceDimension;reason:UnknownReason}[];
  inapplicable:{elementId:string;dimension:ConfidenceDimension;reason:string}[];
}
export interface ConfidenceSummary {
  overall:ConfidenceVerdict;headline:'NOT_RUN'|'IN_PROGRESS'|'ALL_MANDATORY_PASSED'|'FAILURES_FOUND'|'NOTHING_FAILED_SOME_UNTESTED'|'RUN_INCOMPLETE'|'STALE';
  dimensions:{dimension:ConfidenceDimension;verdict:ConfidenceVerdict;passCount:number;failCount:number;unknownCount:number;interval?:ConfidenceInterval|null;mandatory:boolean}[];
  completenessCovered:number;completenessApplicable:number;unknownCount:number;openCriticalFindings:number;lastRunAt?:string|null;evidenceLevel:EvidenceLevel;
}
export type ConfidenceReportSectionId = 'SUMMARY'|'WHAT_WAS_RUN'|'FINDINGS'|'COVERAGE_MAP'|'COMPLIANCE'|'PERFORMANCE_COST'|'BEHAVIOUR'|'CHANGES_SINCE'|'HOW_AND_WHY'|'CLAIMS_BOUNDARY';
export interface ConfidenceReport {
  runId:string;contentHash:string;generatedAt:string;baselineContentHash?:string|null;
  sections:{id:ConfidenceReportSectionId;title:string;markdown:string;data:Record<string,unknown>}[];
  unknowns:{elementId:string;dimension:ConfidenceDimension;reason:UnknownReason;title:string;detail:string}[];
  droppedSentences:{section:ConfidenceReportSectionId;sentenceHash:string;reason:string}[];
  claimsBoundary:'Supports your audit; not an audit opinion.';reportHash:string;
}
export interface ConfidenceCreate {
  artifactKind: typeof CONFIDENCE_ARTIFACT_KINDS[number]; artifactId: string;
  profile: typeof CONFIDENCE_PROFILES[number]; frameworks: string[]; seed: number;
  budget: ConfidenceBudget;
  expectedContentHash?: string;
}
export interface ConfidenceResult {
  schemaVersion: string;
  run: ConfidenceRun;claims:ConfidenceClaim[];completeness:ConfidenceCompleteness;findings:ConfidenceFinding[];summary:ConfidenceSummary;
}
export const CODE_LEVELS = ['LOCAL', 'MANIFEST', 'DIFF', 'TREE'] as const;
export type CodeLevel = typeof CODE_LEVELS[number];
export interface SourceFile { path: string; content: string }
export interface CodeIntakeRequest {
  level: CodeLevel; snapshotHash: string; manifest: Record<string, unknown>; files: SourceFile[];
  approvalActionId?: string; ttlSeconds: number;
}
export interface BundleRef {
  bundleId: string; workspaceId: string; level: CodeLevel; snapshotHash: string;
  expiresAt: string; sizeBytes: number; sourceRetained: boolean;
}

/** Server-owned identity; callers persist exact UUID/hash before first mutation. */
export interface BundleDeletionIdentity {workspaceId:string;actorId:string;commandId:string;bundleId:string;snapshotHash:string;reason:'USER_REQUEST';requestDigest:string}
export interface BundleDeletionReceipt {identity:BundleDeletionIdentity;level:CodeLevel;expiresAt:string;rowAbsentConfirmedAt:string;canonicalAuditHash:string;scope:'CODE_BUNDLE_STORAGE_ROW'}
