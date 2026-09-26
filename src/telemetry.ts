/**
 * Usage telemetry: counts, never content.
 *
 * Four tools report that they ran — `swfte_find_existing` (a `search`, plus the
 * `reuse_decision` it recommended), `swfte_build` (`build`), `swfte_adopt` (`adopt`)
 * and `swfte_scaffold_client` (`scaffold`) — so the workspace's Insights view can
 * show whether reuse actually happens, instead of asserting that it saves anything.
 *
 * What is sent, and only this: `POST /v2/catalog/telemetry`
 *   `{ event, catalogRef?, decision?, client }`
 * where `catalogRef` is `<kind>:<id>` of the artifact involved, `decision` is the
 * catalog's recommendation (`reuse | inspect | build`) and `client` is `mcp/<version>`.
 * No query text, prompt, code, input, output, file path or user id — the body is
 * built from those four typed fields and nothing else, and the server refuses any
 * other field.
 *
 * Best effort, by construction:
 *   - fire-and-forget: the tool's result never waits for it;
 *   - never retried: one attempt, a short timeout, every failure swallowed;
 *   - never fails a tool: nothing here throws into the caller;
 *   - off with `SWFTE_TELEMETRY=0` (also `false`, `off`, `no`): nothing is sent at all.
 */
import type { SwfteClient } from './client.js';
import type { ServerConfig } from './config.js';
import { PACKAGE_VERSION } from './version.js';

export const TELEMETRY_PATH = '/v2/catalog/telemetry';
export const TELEMETRY_TIMEOUT_MS = 3_000;

export const TELEMETRY_EVENTS = [
  'search',
  'reuse_decision',
  'build',
  'adopt',
  'scaffold',
  'first_run',
  'deploy_proposed',
  'deploy_approved',
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];
export type TelemetryDecision = 'reuse' | 'inspect' | 'build';

export interface TelemetryEvent {
  event: TelemetryEventName;
  catalogRef?: string | null;
  decision?: TelemetryDecision;
}

const CATALOG_REF = /^[a-z][a-z-]{1,20}:[A-Za-z0-9_.-]{1,128}$/;
const OFF = new Set(['0', 'false', 'off', 'no']);

/** False when `SWFTE_TELEMETRY` is 0 / false / off / no. On otherwise. */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SWFTE_TELEMETRY?.trim().toLowerCase();
  return !(raw && OFF.has(raw));
}

/** The exact body sent. Built field by field: nothing the caller passes beyond these can travel. */
export function telemetryBody(e: TelemetryEvent): Record<string, string> | null {
  if (!(TELEMETRY_EVENTS as readonly string[]).includes(e.event)) return null;
  const body: Record<string, string> = { event: e.event, client: `mcp/${PACKAGE_VERSION}` };
  if (typeof e.catalogRef === 'string' && CATALOG_REF.test(e.catalogRef)) body.catalogRef = e.catalogRef;
  if (e.event === 'reuse_decision') {
    if (e.decision !== 'reuse' && e.decision !== 'inspect' && e.decision !== 'build') return null;
    body.decision = e.decision;
  }
  return body;
}

/**
 * Sends one event and returns immediately. Safe to call from any tool: it cannot
 * throw, cannot delay the tool's answer, and makes exactly one attempt.
 */
export function emitTelemetry(
  ctx: { client: Pick<SwfteClient, 'request'>; config: Pick<ServerConfig, 'telemetry'> },
  event: TelemetryEvent
): void {
  try {
    if (ctx.config.telemetry === false) return;
    const body = telemetryBody(event);
    if (!body) return;
    // Deferred to a microtask so even building the request happens after the tool returns control.
    void Promise.resolve()
      .then(() =>
        ctx.client.request({ method: 'POST', path: TELEMETRY_PATH, body, retries: 0, timeoutMs: TELEMETRY_TIMEOUT_MS })
      )
      .catch(() => undefined);
  } catch {
    // Telemetry never fails a tool.
  }
}

/** Maps `swfte_find_existing`'s recommendation onto the decision the server counts. */
export function decisionOf(action: string | undefined): TelemetryDecision | null {
  if (action === 'REUSE') return 'reuse';
  if (action === 'INSPECT_BEFORE_REUSE') return 'inspect';
  if (action === 'BUILD') return 'build';
  return null;
}
