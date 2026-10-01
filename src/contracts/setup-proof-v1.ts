/** Additive brief04 v1 wire types. Runtime ownership/evidence checks remain server-side. */
export type SetupArtifactKind = 'workflow' | 'chatflow' | 'agent' | 'widget' | 'application' | 'journey' | 'mcp' | 'finetune'
export type SetupArtifactRef = { kind: string; id: string }
export type SetupTaskScope = 'LISTING' | 'ARTIFACT' | 'SOLUTION'
export type SetupTaskState = 'UNMET' | 'AUTO_BOUND' | 'NEEDS_USER' | 'RESOLVING' | 'RESOLVED' | 'EXPIRED' | 'FAILED' | 'WAIVED'
export type BindingEnvironment = 'SANDBOX' | `LIVE:${string}`
export type BindingValue = { handle: string; literal?: null } | { literal: string; handle?: null }
export type ProofVerdict = 'PASS' | 'FAIL' | 'UNKNOWN'
export type ResolutionOptionType = 'REUSE_CONNECTION' | 'OAUTH_CONNECT' | 'API_KEY' | 'AWS_ROLE_LINK' | 'MANAGED_DEFAULT' | 'PROVISION' | 'ENTER_VALUE' | 'PICK_SUGGESTION' | 'SKIP_BRANCH'
export interface ResolutionOption { id: string; type: ResolutionOptionType; label: string; handle?: string | null }
export interface ResolutionEvidence { probeId: string; outcome: ProofVerdict; evidenceRefs: string[] }
export interface SetupTask {
  key: string | null
  kind: string | null
  title: string | null
  detail: string | null
  required: boolean
  provider: string | null
  role: string | null
  recordType: string | null
  /** Legacy choice answers retain their string vocabulary. */
  options: string[] | null
  placeholder: string | null
  derived: boolean
  status: string | null
  answerLabel: string | null
  scope?: SetupTaskScope | null
  artifactKind?: string | null
  artifactId?: string | null
  solutionId?: string | null
  subject?: { nodeId: string | null; field: string | null; label: string } | null
  authType?: string | null
  capability?: string | null
  state?: SetupTaskState | null
  blocksSandbox: boolean
  resolutionOptions?: ResolutionOption[] | null
  values?: Partial<Record<BindingEnvironment, BindingValue>> | null
  resolvedBy?: { option: string; actor: string; at: string; evidence: ResolutionEvidence } | null
}
export interface SetupTaskEntry { task: SetupTask; contentHash: string; revision: number; updatedAt: string }
export interface ResolveTaskRequest {
  optionId: string
  environment: BindingEnvironment
  value?: BindingValue | null
  expectedContentHash: string
  expectedRevision: number
}
export type ProofLevel = 'NONE' | 'OBSERVED' | 'CORROBORATED' | 'VALIDATED' | 'VERIFIED'
export interface ProofCheck { id: string; verdict: ProofVerdict; evidenceRefs: string[]; reason?: string | null }
export interface ProofRecord {
  id: string; workspaceId: string; artifactKind: string; artifactId: string; version: string; contentHash: string
  level: ProofLevel; checks: ProofCheck[]; executionIds: string[]; evidenceRefs: string[]; warnings: string[]; createdAt: string
}
export interface ProofRunInput { version: string; runs: number; fixtureSetId: string; seed: string; expectedContentHash?: string | null }
export interface ResolverBudget { maxSteps: number; maxWallSeconds: number; maxSpendUsd: number }
export interface StartResolverRequest { artifact: SetupArtifactRef; intent: 'prove' | 'fix'; expectedContentHash: string; budget?: ResolverBudget | null }
export type ResolverSessionState = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'NEEDS_USER' | 'CANCELLED'
export interface ResolverSession {
  id: string; workspaceId: string; actorId: string; artifact: SetupArtifactRef; contentHash: string
  intent: 'PROVE' | 'FIX'; budget: ResolverBudget; state: ResolverSessionState; steps: number
  unresolvedTaskKeys: string[]; startedAt: string | null; finishedAt: string | null
}
export interface ResolverVerification { verdict: ProofVerdict; evidenceRefs: string[]; reason: string | null }
export interface ResolverActionRecord {
  session: string; step: number; tool: string; inputsRedacted: unknown; outcome: string
  verification: ResolverVerification; ms: number; cost: number; model: string | null
}
export type StudioConversationLayout = 'floating' | 'docked'
