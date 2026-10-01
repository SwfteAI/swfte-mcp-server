/**
 * Swfte Simulations — wire types (contract, wave 0).
 *
 * Mirrors agents-service `/v2/simulations` (OpenAPI stub:
 * agents-service src/main/resources/simulations/openapi/simulations-v2.yaml) and the simulation.yaml v1
 * schema (src/main/resources/simulations/schema/simulation.v1.schema.json). The Studio contains no
 * simulation logic: it renders what the Java API returns.
 *
 * Mirror of studio-web-app types/simulations.ts (keep in sync).
 * Provenance: original (Swfte Simulations). Not derived from MiroFish.
 */

export const SIMULATION_DIMENSIONS = [
  'FUNCTION',
  'COMPLETENESS',
  'ROBUSTNESS',
  'LOAD_COST',
  'SECURITY',
  'PRIVACY',
  'COMPLIANCE',
  'BEHAVIOUR',
] as const
export type SimulationDimension = typeof SIMULATION_DIMENSIONS[number]

export type SimulationOutcome = 'PASS' | 'FAIL' | 'UNKNOWN'
export type SimulationSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
export type SimulationRunStatus =
  | 'CREATED' | 'PLANNED' | 'GATED' | 'RUNNING' | 'DRAINING' | 'REPORTING'
  | 'DONE' | 'BUDGET_EXHAUSTED' | 'STOPPED' | 'FAILED'
export const TERMINAL_RUN_STATUSES: SimulationRunStatus[] = ['DONE', 'BUDGET_EXHAUSTED', 'STOPPED', 'FAILED']

export type SimulationModeValue = 'proving' | 'feature' | 'open_world'
export type SimulationProfileValue = 'quick' | 'standard' | 'deep' | 'adversarial' | 'custom'
export type SimulationTargetKind = 'workflow' | 'agent' | 'chatflow' | 'app' | 'widget' | 'worker_box'
export type SimulationPackKind = 'PERSONA' | 'SCENARIO' | 'FAULT' | 'REPORT'

/** simulation.yaml v1, as an object (field names identical to the YAML keys). */
export type SimulationSpec = {
  apiVersion: 'swfte.dev/simulation/v1'
  kind: 'Simulation'
  metadata: { name: string; labels?: Record<string, string> }
  spec: {
    mode: SimulationModeValue
    target: { kind: SimulationTargetKind; id: string; version?: number; environment?: 'sandbox' }
    profile: SimulationProfileValue
    seed?: number
    budget?: { usdPersonas?: number; usdSystemUnderTest?: number; usdReport?: number; maxSteps?: number }
    population?: {
      packs?: string[]
      archetypes?: Partial<Record<'user' | 'adversary' | 'chaos' | 'auditor' | 'stakeholder', number>>
    }
    interfaces?: string[]
    data?: { synthetic?: { fromSchemas?: boolean; locales?: string[] } }
    traffic?: { profile?: 'steady' | 'bursty' | 'diurnal' | 'abusive'; peakRps?: number; durationMinutes?: number }
    faults?: { packs?: string[] }
    scenarios?: { packs?: string[] }
    graders: string[]
    frameworks?: Array<'gdpr' | 'soc2' | 'iso27001' | 'eu-ai-act' | 'nist-ai-rmf' | 'owasp-asvs' | 'owasp-llm' | 'swfte-quality'>
    report?: { sections?: string[]; formats?: Array<'markdown' | 'json'> }
    stop?: { intervalHalfWidth?: number; onBudget?: 'report_unknowns' }
  }
}

export type SpecError = { path: string; code: string; message: string }
export type SpecValidationResult = { valid: boolean; specHash: string | null; errors: SpecError[] }

export type SimulationCoverageCell = {
  elementId: string
  dimension: SimulationDimension
  applicable: boolean
  passes: number
  fails: number
  unknowns: number
  outcome: SimulationOutcome
  evidenceIds: string[]
}

export type SimulationCounters = {
  personas: number
  sessionsPlanned: number
  sessionsDone: number
  sessionsUnknown: number
  steps: number
  findings: number
  usdPersonas: number
  usdSystemUnderTest: number
  usdReport: number
}

export type SimulationBudget = { usdPersonas: number; usdSystemUnderTest: number; usdReport: number; maxSteps: number }

export type SimulationRun = {
  id: string
  workspaceId: string
  name?: string
  mode: string
  profile: string
  status: SimulationRunStatus
  specHash: string
  specVersion: string
  seed: number
  target: { kind: string; id: string; version?: number | null; actualVersion?: string | null; contentHash?: string | null; environment: string; instanceIds?: string[] }
  budget: SimulationBudget
  counters: SimulationCounters
  coverage: SimulationCoverageCell[]
  completeness: number
  routing?: { chains?: Record<string, string[]>; residencyApplied?: boolean } | null
  createdAt: string
  startedAt?: string | null
  finishedAt?: string | null
  error?: string | null
}

export type SimulationRunSummary = Pick<SimulationRun, 'id' | 'mode' | 'profile' | 'status' | 'target' | 'createdAt'> & {
  name?: string
  overall?: SimulationOutcome | null
  completeness?: number | null
}

export type SimulationFinding = {
  id: string
  dimension: SimulationDimension
  severity: SimulationSeverity
  title: string
  description: string
  affectedElements: string[]
  sessionId: string | null
  step: number | null
  evidenceIds: string[]
  graderId: string
  suggestedFix: string | null
  rerunCommand: string | null
  gap: boolean
}

export type SimulationEstimate = {
  sessions: number
  steps: number
  usdByRole: Record<string, number>
  usdCeiling: number
  unpricedModels: string[]
  withinBudget: boolean
}

export type SimulationPack = {
  ref: string
  kind: SimulationPackKind
  manifestHash: string
  scope: 'PUBLIC' | 'WORKSPACE'
  enabled: boolean
  description: string
}

export type SimulationClaim = {
  id: string
  dimension: SimulationDimension
  statement: string
  outcome: SimulationOutcome
  interval: { low: number; high: number; successes: number; trials: number } | null
  evidenceIds: string[]
}

export type SimulationReportSection = { sectionId: string; title: string; order: number; markdown: string; evidenceIds: string[] }

export type SimulationReport = {
  runId: string
  overall: SimulationOutcome
  dimensions: Partial<Record<SimulationDimension, SimulationClaim>>
  claims: SimulationClaim[]
  gaps: SimulationCoverageCell[]
  completeness: number
  sections: SimulationReportSection[]
  groundingKept: number
  groundingDropped: number
  /** Always "Supports your audit; not an audit opinion." */
  disclaimer: string
  chainHeads: Record<string, string>
  generatedAt: string
}

export type SimulationChatTurn = { role: 'user' | 'assistant'; content: string }
export type SimulationChatReply = { text: string; evidenceIds: string[]; model: string }

/** SSE event names on GET /v2/simulations/{id}/events; `data` is JSON. */
export type SimulationEventName = 'status' | 'counters' | 'session' | 'finding' | 'coverage' | 'report' | 'heartbeat'
export type SimulationEvent =
  | { event: 'status'; data: { status: SimulationRunStatus; reason?: string | null } }
  | { event: 'counters'; data: SimulationCounters }
  | { event: 'session'; data: { id: string; personaId: string; interfaceId: string; status: string; steps: number } }
  | { event: 'finding'; data: SimulationFinding }
  | { event: 'coverage'; data: { cells: SimulationCoverageCell[]; completeness: number } }
  | { event: 'report'; data: { overall: SimulationOutcome } }
  | { event: 'heartbeat'; data: { at: string } }

export type SimulationPersonaSummary = {
  id: string
  archetype: 'USER' | 'ADVERSARY' | 'CHAOS' | 'AUDITOR' | 'STAKEHOLDER'
  name: string
  pack: string
  tacticId: string
  locale: string
}

export type SimulationGraph = {
  elements: Array<{ id: string; type: string; label: string; attrs: Record<string, unknown> }>
  edges: Array<{ from: string; to: string; relation: string }>
}

/** Actual redacted simulation records; never a production runtime receipt. */
export type SimulationValidationPack = {
  ref: string
  runId: string
  workspaceId: string
  contentHash: string
  payload: {
    schemaVersion: number
    sourceRunId: string
    evidenceKind: 'simulation'
    artifactKind: string
    industry: string
    target: SimulationRun['target']
    sourceSpecHash: string
    spec: SimulationSpec
    sourcePacks: Array<{ ref: string; kind: SimulationPackKind; manifestHash: string }>
    unavailableDeclarations: string[]
    scenarios: unknown[]
    faults: unknown[]
    findings: SimulationFinding[]
    evidenceHeads: Record<string, string>
    sourceStatus: SimulationRunStatus
  }
}
