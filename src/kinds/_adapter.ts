import { z } from 'zod';
import type { SwfteClient } from '../client.js';

/**
 * Every Studio artifact this server can build. Adding one is a single adapter
 * file — the eight task tools pick it up automatically.
 */
export const KINDS = [
  'workflow',
  'agent',
  'chatflow',
  'widget',
  'application',
  'model',
  'module',
  'mcp-server',
  'custom-node',
] as const;

export type Kind = (typeof KINDS)[number];
export const KindEnum = z.enum(KINDS);

/**
 * Normalised wizard snapshot.
 *
 * Mirrors agents-service `WizardRunStore.Snapshot`, which every poll-based
 * wizard shares:
 *   (sessionId, wizardSessionId, status, message, progress, done, error,
 *    nodes[], edges[], speculativeNodes[], finalResponse)
 *
 * `finalResponse` is deliberately untyped upstream — one store serves every
 * wizard and each writes its own terminal DTO — so each adapter pulls its own
 * artifact out of it via `extractArtifact`.
 */
export interface BuildSnapshot {
  sessionId: string;
  wizardSessionId?: string | null;
  status: string;
  message?: string | null;
  progress: number;
  done: boolean;
  error?: string | null;
  nodes: unknown[];
  edges: unknown[];
  speculativeNodes: unknown[];
  finalResponse: unknown;
  /** Raw body, for anything an adapter hasn't modelled. */
  raw: unknown;
}

export interface BuildInput {
  prompt: string;
  /** Model override for the generator itself (not for the built artifact). */
  model?: string;
  /** Let the wizard persist the artifact itself, skipping a separate create. */
  autoCreate?: boolean;
  /** Kind-specific extras, merged into the wizard request body. */
  options?: Record<string, unknown>;
}

export interface ValidationFinding {
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  findings: ValidationFinding[];
  suggestions?: string[];
  raw?: unknown;
}

export interface RunInput {
  inputs?: Record<string, unknown>;
  /** Free-text turn, for conversational kinds (agent / chatflow). */
  message?: string;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  status: string;
  /** Backend load-shed or gateway timeout — infra, not artifact misconfiguration. */
  degraded?: boolean;
  output?: unknown;
  /** Per-node execution trace, for graph kinds. */
  nodeTraces?: Array<{ id: string; status: string; type?: string; error?: string }>;
  elapsedMs?: number;
  raw?: unknown;
}

export interface DeployOpts {
  /**
   * Capacity intent. Omit to use the unified deploy router, which runs the
   * dependency / GPU / runtime-profile analyzers and chooses the target itself
   * — that is the provider-agnostic path and the default.
   */
  option?: 'BYO' | 'shared' | 'dedicated';
  region?: string;
  /** Travels UPPERCASE on the wire — normalised by the adapter, not the caller. */
  gpuTier?: string;
  lifecycle?: 'ON_DEMAND' | 'ALWAYS_ON';
  secretId?: string;
  timeoutMs?: number;
}

export interface DeployPreview {
  /** Chosen by the backend pre-flight; never supplied by the caller. */
  target?: string;
  requiresGpu?: boolean;
  models?: unknown[];
  estimatedCost?: unknown;
  runtimeProfile?: unknown;
  managedDatabases?: unknown;
  raw?: unknown;
}

export interface DeployResult {
  deploymentId?: string;
  phase: string;
  url?: string;
  endpoint?: string;
  timedOut?: boolean;
  raw?: unknown;
}

export interface VerifyCheck {
  id: string;
  /** `null` means not applicable / skipped, which is not a failure. */
  ok: boolean | null;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  kind: Kind;
  id: string;
  checks: VerifyCheck[];
  nextActions: string[];
}

export interface VerifyOpts {
  /** Whether the sweep may actually execute the artifact (costs time and tokens). */
  run?: boolean;
  inputs?: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * Treat "draft only, never published" as a failure rather than as
   * information. Off by default: a freshly built artifact is legitimately
   * unpublished, and failing on it would make every good build look broken.
   * Turn it on when checking something that is supposed to be live.
   */
  requirePublished?: boolean;
}

/**
 * One adapter per kind. Optional members express genuine backend differences
 * rather than unfinished work — e.g. the widget wizard persists as part of
 * generation and has no separate `/create`, and the application blueprint
 * wizard exposes neither steer nor refine.
 */
export interface KindAdapter {
  kind: Kind;
  label: string;
  /** Surfaced in tool errors when a verb is unsupported for this kind. */
  notes?: string;

  /**
   * Optional because not every kind has a generator: model-vault models are
   * uploaded, not written, so there is nothing for a wizard to build.
   */
  build?(client: SwfteClient, input: BuildInput): Promise<{ sessionId: string }>;
  status?(client: SwfteClient, sessionId: string): Promise<BuildSnapshot>;
  /** Pull the finished artifact out of a terminal snapshot. */
  extractArtifact?(snapshot: BuildSnapshot): unknown;
  /** Id of the persisted artifact, when the wizard created it itself. */
  extractId?(snapshot: BuildSnapshot): string | undefined;

  steer?(client: SwfteClient, sessionId: string, instruction: string): Promise<unknown>;
  validate?(client: SwfteClient, artifact: unknown): Promise<ValidationReport>;
  create?(client: SwfteClient, artifact: unknown): Promise<{ id: string; raw: unknown }>;
  refine?(client: SwfteClient, artifact: unknown, feedback: string): Promise<unknown>;
  run?(client: SwfteClient, id: string, input: RunInput): Promise<RunResult>;

  deployPreview?(client: SwfteClient, id: string, opts: DeployOpts): Promise<DeployPreview>;
  deploy?(client: SwfteClient, id: string, opts: DeployOpts): Promise<DeployResult>;
  teardown?(client: SwfteClient, id: string, deploymentId?: string): Promise<void>;

  verify(client: SwfteClient, id: string, opts: VerifyOpts): Promise<VerifyReport>;

  get?(client: SwfteClient, id: string): Promise<unknown>;
  list?(client: SwfteClient): Promise<unknown[]>;
  remove?(client: SwfteClient, id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Terminal run statuses. The backend is not consistent about which it emits. */
const TERMINAL_RUN = new Set([
  'COMPLETED',
  'SUCCESS',
  'SUCCEEDED',
  'FAILED',
  'ERROR',
  'CANCELLED',
  'CANCELED',
  'TIMEOUT',
  'TIMED_OUT',
]);

const SUCCEEDED_RUN = new Set(['COMPLETED', 'SUCCESS', 'SUCCEEDED']);

export const isTerminalRunStatus = (s: unknown): boolean =>
  TERMINAL_RUN.has(String(s).toUpperCase());
export const isSucceededRunStatus = (s: unknown): boolean =>
  SUCCEEDED_RUN.has(String(s).toUpperCase());

/**
 * Coerce a raw `/status` body into a `BuildSnapshot`.
 *
 * Wizard runs live in an in-memory, single-instance store that sweeps entries
 * after a TTL — so a 404 here means "expired or swept", not "never existed".
 * Callers distinguish those.
 */
export function toSnapshot(raw: any, sessionId: string): BuildSnapshot {
  return {
    sessionId: raw?.sessionId ?? sessionId,
    wizardSessionId: raw?.wizardSessionId ?? null,
    status: String(raw?.status ?? 'UNKNOWN'),
    message: raw?.message ?? null,
    progress: Number(raw?.progress ?? 0) || 0,
    // `done` is authoritative: some wizards leave `status` on a stage label
    // even after they've finished.
    done: Boolean(raw?.done),
    error: raw?.error ?? null,
    nodes: raw?.nodes ?? [],
    edges: raw?.edges ?? [],
    speculativeNodes: raw?.speculativeNodes ?? [],
    finalResponse: raw?.finalResponse ?? null,
    raw,
  };
}

/** Normalise the several shapes backends use for validation errors. */
export function toFindings(errors: unknown): ValidationFinding[] {
  if (!errors) return [];
  const list = Array.isArray(errors) ? errors : [errors];
  return list.map((e: any): ValidationFinding => {
    if (typeof e === 'string') return { severity: 'error', message: e };
    const severity = String(e?.severity ?? 'error').toLowerCase();
    return {
      severity: severity === 'warning' || severity === 'info' ? severity : 'error',
      message: String(e?.message ?? e?.error ?? JSON.stringify(e)),
      path: e?.path ?? e?.field ?? e?.nodeId,
    };
  });
}

/** Pull an id out of the many spellings backends return it under. */
export function pickId(body: any): string | undefined {
  return (
    body?.id ??
    body?.workflowId ??
    body?.agentId ??
    body?.chatflowId ??
    body?.widgetId ??
    body?.moduleId ??
    body?.modelId ??
    body?.artifactId ??
    body?.data?.id ??
    undefined
  );
}

/** Pull an item array out of a list response, across the shapes in use. */
export function pickList(body: any): unknown[] {
  if (Array.isArray(body)) return body;
  return body?.content ?? body?.items ?? body?.data ?? body?.agents ?? body?.workflows ?? [];
}
