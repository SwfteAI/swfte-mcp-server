/** Additive07 request/intake mirror of backend59fb73f86. Results remain existing confidence v1. */
export const CONFIDENCE_ARTIFACT_KINDS = ['WORKFLOW', 'AGENT', 'CHATFLOW', 'APPLICATION', 'WIDGET', 'WORKER', 'MODEL', 'SOLUTION', 'CODE_CHANGE', 'CODEBASE'] as const;
export const CONFIDENCE_PROFILES = ['QUICK', 'STANDARD', 'DEEP', 'ADVERSARIAL'] as const;
export interface ConfidenceCreate {
  artifactKind: typeof CONFIDENCE_ARTIFACT_KINDS[number]; artifactId: string;
  profile: typeof CONFIDENCE_PROFILES[number]; frameworks: string[]; seed: number;
  budget: { persona: number; systemUnderTest: number; report: number; maxSteps: number };
  expectedContentHash?: string;
}
export interface ConfidenceResult {
  schemaVersion: string;
  run: { runId: string; artifactKind: string; artifactId: string; contentHash: string; environment: 'SANDBOX'; status: string; calibrationVersion?: string | null };
  claims: unknown[]; completeness: unknown; findings: unknown[];
  summary: { overall: 'PASS' | 'FAIL' | 'UNKNOWN'; headline: string; unknownCount: number; evidenceLevel: string };
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
