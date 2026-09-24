/**
 * Solution Hub tools (CONTRACT rev 3): pick up → tailor → deploy.
 *
 *   swfte_fit_check     POST /v2/catalog/{kind}/{id}/fit     does this entry fit my problem and stack?
 *   swfte_adopt         POST /v2/catalog/{kind}/{id}/adopt   copy it into my workspace, tailored; optionally propose a deploy
 *   swfte_get_timeline  GET  /v2/catalog/{kind}/{id}/timeline  its diary: created, forked, adopted, runs, reviews, deploys
 *
 * The stack is read from the local project when the caller does not give one
 * (src/stack.ts — manifests only, nothing leaves the machine but the tags).
 * Adopting never deploys: a deploy comes back as a PROPOSED action a human
 * approves in Studio, then swfte_execute_approved_action runs it.
 */
import { z } from 'zod';
import { SwfteApiError } from '../client.js';
import { CatalogRefArg, ENVIRONMENTS, catalogPath, parseCatalogRef } from '../catalog.js';
import { presentAction, type ActionRequest } from '../actions.js';
import { detectStack, type StackDetection } from '../stack.js';
import type { ToolDefinition } from './_types.js';

const StackArg = z
  .array(z.string().min(1).max(60))
  .max(40)
  .optional()
  .describe('Stack tags, e.g. ["nextjs","typescript","stripe","postgres"]. Omit to detect them from the local project (package.json, pyproject.toml, requirements*.txt).');

/** Given tags win; otherwise detect locally (stdio only). */
function resolveStack(given: string[] | undefined, local: boolean): { stack: string[]; source: 'given' | 'detected' | 'none'; detection: StackDetection | null } {
  if (given && given.length) return { stack: [...new Set(given.map((s) => s.trim().toLowerCase()).filter(Boolean))], source: 'given', detection: null };
  if (!local) return { stack: [], source: 'none', detection: null };
  const detection = detectStack(process.cwd());
  return { stack: detection.stack, source: 'detected', detection };
}

const connectHint = (provider: string) => ({
  provider,
  fix: `swfte_connect_start {provider:"${provider}"} — the user signs in through the returned URL; then swfte_connect_wait.`,
});

/** Provider slugs named by needsInput entries such as "connection:slack" or "connect gmail". */
function providersIn(needsInput: string[]): string[] {
  const out: string[] = [];
  for (const n of needsInput) {
    const m = /^(?:connection|oauth|connect|provider)\s*[:=\s]\s*([a-z0-9][a-z0-9_.-]*)/i.exec(n.trim());
    if (m) out.push(m[1]!.toLowerCase());
  }
  return out;
}

interface FitResponse {
  score?: number | null;
  verdict?: string;
  matches?: string[];
  gaps?: Array<{ kind: string; detail: string; fix: string | null }>;
  missingConnections?: string[];
  degraded?: string[];
}

interface AdoptResponse {
  catalogRef?: string;
  kind?: string;
  id?: string;
  forkedFrom?: string | null;
  tailoringApplied?: boolean;
  tailoringSummary?: string | null;
  needsInput?: string[];
  missingConnections?: string[];
  deployAction?: ActionRequest | null;
}

interface TimelineEvent {
  at?: string;
  type?: string;
  actor?: { id?: string; displayName?: string } | null;
  summary?: string;
  refId?: string | null;
}

export const TIMELINE_TYPES = ['created', 'version', 'forked', 'adopted', 'run', 'review', 'facet_review', 'deployed', 'action'] as const;

export const hubTools: ToolDefinition[] = [
  {
    name: 'swfte_fit_check',
    title: 'Does a catalog entry fit this problem and stack?',
    readOnly: true,
    description:
      'Ask the Solution Hub how well an entry fits the developer\'s problem and stack (POST /v2/catalog/{kind}/{id}/fit): ' +
      'score (0..1, null when Jev is unavailable), verdict strong|partial|weak|unknown, what matches, gaps with fixes ' +
      '(connection / integration / input / capability), and OAuth providers the workspace still lacks — each with the ' +
      'swfte_connect_start call that fixes it. stack is detected from the local project when omitted. Run it between ' +
      'swfte_find_existing and swfte_adopt.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      problem: z.string().min(3).max(4000).describe('The problem in the developer\'s words — what they need this for.'),
      stack: StackArg,
    }),
    execute: async (input, { client, localFilesystem }) => {
      const r = parseCatalogRef(input.catalogRef);
      const { stack, source, detection } = resolveStack(input.stack, localFilesystem !== false);
      const res = (await client.request<FitResponse>({
        method: 'POST',
        path: `${catalogPath(r)}/fit`,
        body: { problem: input.problem, stack },
      })) ?? {};
      const missing = Array.isArray(res.missingConnections) ? res.missingConnections : [];
      const verdict = res.verdict ?? 'unknown';
      return {
        catalogRef: r.ref,
        score: typeof res.score === 'number' ? res.score : null,
        verdict,
        matches: res.matches ?? [],
        gaps: res.gaps ?? [],
        missingConnections: missing.map(connectHint),
        degraded: res.degraded ?? [],
        stack: { tags: stack, source, ...(detection ? { framework: detection.framework, signals: detection.signals } : {}) },
        nextStep:
          verdict === 'strong' || verdict === 'partial'
            ? `swfte_adopt {catalogRef:"${r.ref}", problem:<same problem>} copies it into your workspace, tailored${missing.length ? '; connect the missing providers first' : ''}.`
            : verdict === 'weak'
              ? 'Weak fit: look at the next swfte_find_existing result, or build (swfte_solution_advise → swfte_build).'
              : 'Fit is unknown (scoring unavailable): read swfte_get_context and judge the contract against the problem yourself.',
        ...(res.score == null ? { note: 'score is null when semantic scoring (Jev) is unavailable — that is "not measured", not "no fit".' } : {}),
      };
    },
  },
  {
    name: 'swfte_adopt',
    title: 'Adopt a catalog entry into this workspace, tailored',
    description:
      'Copy an entry into the caller\'s workspace (POST /v2/catalog/{kind}/{id}/adopt) with lineage recorded (forkedFrom; ' +
      '"adopted" on the source, "forked" on the copy). With problem/stack/notes it is tailored through the refine path ' +
      '(tailoringApplied=false means a plain copy). stack is detected from the local project when a problem is given ' +
      'without one. Returns the new catalogRef, needsInput (unanswered {{ASK}} fields, missing connections), ' +
      'missingConnections with swfte_connect_start hints, and — when deploy is set — a PROPOSED deploy action: it is ' +
      'never executed here; a human approves it in Studio → Actions, then swfte_execute_approved_action runs it. ' +
      'The copy starts with no evidence of its own.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      name: z.string().min(1).max(200).optional().describe('Name for the copy.'),
      problem: z.string().max(4000).optional().describe('The developer\'s problem, used to tailor the copy.'),
      stack: StackArg,
      notes: z.string().max(4000).optional().describe('Extra tailoring instructions.'),
      deploy: z.object({ environment: z.enum(ENVIRONMENTS) }).optional().describe('Also propose (not perform) a deploy of the copy.'),
      acknowledgeProviderRole: z.boolean().optional().describe(
        'EU AI Act Art. 25 acknowledgement, required by the server when tailoring or adopting a PUBLIC entry. ' +
          'This is the HUMAN user\'s declaration: set true ONLY after the user has explicitly confirmed, in this ' +
          'conversation, that they accept they may become the provider. Never set it on your own.',
      ),
      intendedPurpose: z.string().min(3).max(1000).optional().describe('The user\'s own words for what they will use it for (human-declared, recorded with the acknowledgement).'),
      annexIII: z.string().max(200).optional().describe('User-declared Annex III category, "none" or "unsure". Optional.'),
    }),
    execute: async (input, { client, localFilesystem }) => {
      const r = parseCatalogRef(input.catalogRef);
      const wantsTailoring = Boolean(input.problem || input.notes || input.stack?.length);
      const { stack, source, detection } = input.problem || input.stack?.length ? resolveStack(input.stack, localFilesystem !== false) : { stack: [], source: 'none' as const, detection: null };
      const tailoring = wantsTailoring
        ? {
            ...(input.problem ? { problem: input.problem } : {}),
            ...(stack.length ? { stack } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
          }
        : undefined;
      const res = (await client.request<AdoptResponse>({
        method: 'POST',
        path: `${catalogPath(r)}/adopt`,
        body: {
          ...(input.name ? { name: input.name } : {}),
          ...(tailoring ? { tailoring } : {}),
          ...(input.deploy ? { deploy: { environment: input.deploy.environment } } : {}),
          ...(input.acknowledgeProviderRole === true ? { acknowledgeProviderRole: true } : {}),
          ...(input.intendedPurpose ? { intendedPurpose: input.intendedPurpose } : {}),
          ...(input.annexIII ? { annexIII: input.annexIII } : {}),
        },
        // Adoption creates an artifact; a retried POST could create two.
        retries: 0,
      }).catch((e: unknown) => {
        // Art. 25: the server refuses until the HUMAN acknowledges. Surface it as a question, not an error.
        if (e instanceof SwfteApiError && e.status === 422 && e.code === 'PROVIDER_ROLE_ACK_REQUIRED') {
          return { __needsAck: String((e.envelope as Record<string, unknown>)?.message ?? e.message) } as AdoptResponse & { __needsAck: string };
        }
        throw e;
      })) ?? {};
      if ((res as { __needsAck?: string }).__needsAck) {
        return {
          adopted: false,
          needsAcknowledgement: true,
          notice: (res as { __needsAck: string }).__needsAck,
          nextStep: 'Show this notice to the user and ASK them. Only if they explicitly accept, call swfte_adopt again with ' +
            'acknowledgeProviderRole:true and intendedPurpose in their own words. Do not acknowledge on their behalf.',
        };
      }

      const newRef = res.catalogRef ?? (res.kind && res.id ? `${res.kind}:${res.id}` : null);
      const needsInput = Array.isArray(res.needsInput) ? res.needsInput : [];
      const providers = [...new Set([...(Array.isArray(res.missingConnections) ? res.missingConnections : []), ...providersIn(needsInput)])];
      const deployAction = res.deployAction ? presentAction(res.deployAction) : null;
      const nextSteps: string[] = [];
      if (providers.length) nextSteps.push(`Connect ${providers.join(', ')}: ${providers.map((p) => `swfte_connect_start {provider:"${p}"}`).join('; ')}.`);
      const asks = needsInput.filter((n) => !providersIn([n]).length);
      if (asks.length) nextSteps.push(`Answer the open inputs (${asks.join(', ')}) — in Studio, or swfte_refine the copy — before running it.`);
      if (newRef) {
        nextSteps.push(`Run it on representative inputs (swfte_run) — the copy starts with no evidence of its own.`);
        nextSteps.push(`Bake it into the code: swfte_scaffold_client {catalogRef:"${newRef}"} (or \`swfte add ${newRef}\`).`);
      }
      if (deployAction) {
        nextSteps.push(
          deployAction.status === 'PROPOSED'
            ? `Deploy is PROPOSED (action ${deployAction.actionId}). Ask the user to approve it in Studio → Actions; then swfte_execute_approved_action {actionId:"${deployAction.actionId}"}. Do not execute it before approval.`
            : `Deploy action ${deployAction.actionId} is ${deployAction.status}; check it with swfte_get_action_status.`
        );
      } else if (!input.deploy && newRef) {
        nextSteps.push(`To deploy later: swfte_request_approval {capability:"workflow.deploy", target:"${newRef}", environment:"development"}.`);
      }
      return {
        catalogRef: newRef,
        kind: res.kind ?? r.kind,
        id: res.id ?? null,
        forkedFrom: res.forkedFrom ?? r.ref,
        tailoringApplied: res.tailoringApplied === true,
        tailoringSummary: res.tailoringSummary ?? null,
        ...(wantsTailoring && res.tailoringApplied !== true
          ? { tailoringNote: 'Tailoring was requested but not applied (the refine path was unavailable or failed); this is a plain copy.' }
          : {}),
        stack: tailoring ? { tags: stack, source, ...(detection ? { framework: detection.framework } : {}) } : null,
        needsInput,
        missingConnections: providers.map(connectHint),
        deployAction,
        nextSteps,
      };
    },
  },
  {
    name: 'swfte_get_timeline',
    title: 'Timeline (diary) of a catalog entry',
    readOnly: true,
    description:
      'The entry\'s diary, newest first (GET /v2/catalog/{kind}/{id}/timeline): created, version, forked, adopted, ' +
      'run, review, facet_review, deployed and action events, each with actor, summary and refId. Workspace-filtered by ' +
      'the server. Use it to see who changed what and why before reusing or changing something others depend on.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      types: z.array(z.enum(TIMELINE_TYPES)).optional().describe('Only these event types.'),
      limit: z.number().int().min(1).max(200).optional().describe('Newest N events after filtering. Default 50.'),
    }),
    execute: async (input, { client }) => {
      const r = parseCatalogRef(input.catalogRef);
      const res = await client.request<{ events?: TimelineEvent[] } | TimelineEvent[]>({ method: 'GET', path: `${catalogPath(r)}/timeline` });
      const all: TimelineEvent[] = Array.isArray(res) ? res : Array.isArray(res?.events) ? res!.events! : [];
      const wanted = input.types?.length ? new Set<string>(input.types) : null;
      const filtered = all.filter((e) => !wanted || wanted.has(String(e.type)));
      const limit = input.limit ?? 50;
      const events = filtered.slice(0, limit).map((e) => ({
        at: e.at ?? null,
        type: e.type ?? 'unknown',
        actor: e.actor ? (e.actor.displayName ?? e.actor.id ?? null) : null,
        summary: e.summary ?? '',
        refId: e.refId ?? null,
      }));
      const counts: Record<string, number> = {};
      for (const e of all) counts[String(e.type)] = (counts[String(e.type)] ?? 0) + 1;
      return {
        catalogRef: r.ref,
        count: events.length,
        total: all.length,
        truncated: filtered.length > events.length,
        counts,
        events,
      };
    },
  },
];
