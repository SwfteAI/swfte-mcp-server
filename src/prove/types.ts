export const PROOF_LEVELS = ['local', 'manifest', 'diff', 'tree'] as const;
export type ProofLevel = typeof PROOF_LEVELS[number];
export type ProofVerdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'UNAVAILABLE';
export interface ProofFile { path: string; sha256: string; status: string }
export interface ProofManifest { files: ProofFile[]; lockfiles: string[] }
export interface TreeSnapshot {
  root: string; run_key: string; repo_fingerprint: string; commit: string | null;
  dirty: boolean; manifest: ProofManifest;
}
export interface ProofCheck { name: string; ok: boolean | null; detail: string; evidence_ref?: string | null }
export interface ProofFinding {
  rule_id: string; severity: string; file: string; line: number; message: string;
  remediation: string; evidence_ref?: string | null;
}
export interface ProvingRunRequest {
  schema: 'nexus.proof.v1'; run_key: string; level: ProofLevel; repo_fingerprint: string;
  commit: string | null; dirty: boolean; session_id: string | null; baton_id: string | null;
  trigger: 'verified_edit' | 'stop' | 'handoff' | 'cli' | 'mcp' | 'ci';
  manifest: ProofManifest; payload_ref: string | null; requested_checks: string[];
}
export type ProofTrace = { category: 'proof_admission'; record_id?: null; content_hash: string }
  | { category: string; record_id: string; content_hash: string };
export interface ProvingRunResult {
  schema: 'nexus.proof.v1'; run_id: string; run_key: string; level: ProofLevel;
  status: 'PENDING' | 'COMPLETE'; verdict: ProofVerdict; checks: ProofCheck[];
  findings: ProofFinding[]; dependency_gaps: string[];
  behavior_trace: ProofTrace[];
  explained: string[]; confidence?: number; report_url?: string; evidence_record_id?: string;
  review_packet_url?: string;
}
export type VerdictToken = 'PROOF_PASS' | 'PROOF_FAIL' | 'PROOF_PENDING' | 'PROOF_UNPROVEN' | 'PROOF_REFUSED';
export interface VerdictResult { token: VerdictToken; exitCode: 0 | 1; reason?: string; run?: ProvingRunResult }

/** Only a real 07 intake adapter may implement these methods. No feature-owned substitute exists. */
export interface SourceIntake {
  resolveLevel(path: string, requested?: ProofLevel): Promise<ProofLevel>;
  authorizeSource(input: { path: string; level: ProofLevel; destination: string }): Promise<unknown>;
  prepareUpload(input: { path: string; level: ProofLevel; consent: unknown; snapshot: TreeSnapshot }):
    Promise<{ payloadRef: string; runKey: string; manifest: ProofManifest }>;
}
export interface ProofLearningBoundary {
  /** True only after the actual client/work-record pipeline enforces proof-origin exclusion. */
  proofOriginExcludedByDefault(): boolean;
  withProofOrigin<T>(action: () => Promise<T>): Promise<T>;
}
