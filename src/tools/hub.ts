/**
 * Solution Hub tools (CONTRACT rev 3): pick up → tailor → deploy.
 *
 *   swfte_fit_check     POST /v2/catalog/{kind}/{id}/fit     does this entry fit my problem and stack?
 *   swfte_adopt         POST /v2/catalog/{kind}/{id}/adopt   copy it into my workspace, tailored; optionally propose a deploy
 *   swfte_get_timeline  GET  /v2/catalog/{kind}/{id}/timeline  its diary: created, forked, adopted, runs, reviews, deploys
 *
 * Cross-organisation delivery (agents-service #452, DEV-CROSS-ORG):
 *
 *   swfte_deliver          POST /v2/catalog/{kind}/{id}/deliver   push an entry into a customer's workspace on their delivery grant
 *   swfte_handover_record  GET  /v2/catalog/{kind}/{id}/handover?format=markdown   export the runbook of a handover taken in Studio
 *
 * The stack is read from the local project when the caller does not give one
 * (src/stack.ts — manifests only, nothing leaves the machine but the tags).
 * Adopting never deploys: a deploy comes back as a PROPOSED action a human
 * approves in Studio, then swfte_execute_approved_action runs it. Delivering
 * never deploys either, and the deliverer never runs it: the PROPOSED action
 * is the customer's, for the customer's approvers.
 *
 * adopt and deliver run the same server pipeline (CatalogHubService.adopt), so
 * they share how its answers are read here: the Art. 25 acknowledgement is a
 * question for the human, a proprietary licence means a hosted binding.
 */
import { z } from 'zod';
import { SwfteApiError } from '../client.js';
import { CatalogRefArg, ENVIRONMENTS, catalogPath, parseCatalogRef, type CatalogRef } from '../catalog.js';
import { presentAction, type ActionRequest } from '../actions.js';
import { ConfinedWriter, INLINE_NOTE } from '../fsguard.js';
import { detectStack, type StackDetection } from '../stack.js';
import { emitTelemetry } from '../telemetry.js';
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

interface BindingView {
  bindingId?: string;
  catalogRef?: string;
  kind?: string;
  licence?: string | null;
  pinnedVersion?: string | null;
  contractHash?: string | null;
  status?: string;
  invoke?: { method?: string; path?: string; auth?: string; async?: boolean } | null;
}

/** HubModels.Adopted — what adopt answers, and what deliver answers under `delivered`. */
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
  replayed?: boolean;
  /** "copy" (default) or "binding": a proprietary entry is bound, never copied. */
  mode?: string;
  binding?: BindingView | null;
  licence?: string | null;
  attributedTo?: unknown;
}

interface DeliverResponse {
  targetWorkspaceId?: string;
  grantId?: string;
  delivered?: AdoptResponse;
}

/** Workspace ids as the server accepts them (DeliveryService.WORKSPACE_ID). */
const WorkspaceIdArg = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'workspace id: 1-128 of [A-Za-z0-9_.:-]');

/** EU AI Act Art. 25 fields. adopt and deliver ask for them on the same condition (tailoring, or a public source). */
const providerRoleFields = (tool: string) => ({
  acknowledgeProviderRole: z.boolean().optional().describe(
    'EU AI Act Art. 25 acknowledgement, required by the server when tailoring or when the source is a PUBLIC entry. ' +
      'This is the HUMAN user\'s declaration: set true ONLY after the user has explicitly confirmed, in this ' +
      `conversation, that they accept they may become the provider. Never set it on your own — ${tool} first returns the notice to show them.`,
  ),
  intendedPurpose: z.string().min(3).max(1000).optional().describe('The user\'s own words for what they will use it for (human-declared, recorded with the acknowledgement).'),
  annexIII: z.string().max(200).optional().describe('User-declared Annex III category, "none" or "unsure". Optional.'),
});

interface AdoptLikeInput {
  name?: string;
  problem?: string;
  stack?: string[];
  notes?: string;
  deploy?: { environment: string };
  acknowledgeProviderRole?: boolean;
  intendedPurpose?: string;
  annexIII?: string;
}

/** Tailoring from problem/stack/notes; the stack is detected locally when a problem comes without one. */
function tailoringOf(input: AdoptLikeInput, local: boolean) {
  const wanted = Boolean(input.problem || input.notes || input.stack?.length);
  const { stack, source, detection } = input.problem || input.stack?.length
    ? resolveStack(input.stack, local)
    : { stack: [] as string[], source: 'none' as const, detection: null };
  const tailoring = wanted
    ? {
        ...(input.problem ? { problem: input.problem } : {}),
        ...(stack.length ? { stack } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
      }
    : undefined;
  return { wanted, tailoring, stack, source, detection };
}

/** HubModels.AdoptRequest. The acknowledgement goes on the wire only when the human gave it (true, explicitly). */
function adoptBody(input: AdoptLikeInput, tailoring: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...(input.name ? { name: input.name } : {}),
    ...(tailoring ? { tailoring } : {}),
    ...(input.deploy ? { deploy: { environment: input.deploy.environment } } : {}),
    ...(input.acknowledgeProviderRole === true ? { acknowledgeProviderRole: true } : {}),
    ...(input.intendedPurpose ? { intendedPurpose: input.intendedPurpose } : {}),
    ...(input.annexIII ? { annexIII: input.annexIII } : {}),
  };
}

/**
 * The pipeline's 422s that are answers for a human, not failures: Art. 25 needs the HUMAN's acknowledgement
 * (surfaced as a question, never acknowledged here), and a proprietary licence allows a hosted binding only,
 * which tailoring cannot be applied to.
 */
function pipelineRefusal(e: unknown, tool: 'swfte_adopt' | 'swfte_deliver'): Record<string, unknown> | null {
  if (!(e instanceof SwfteApiError) || e.status !== 422) return null;
  const notice = String((e.envelope as Record<string, unknown>)?.message ?? e.message);
  if (e.code === 'PROVIDER_ROLE_ACK_REQUIRED') {
    return {
      needsAcknowledgement: true,
      notice,
      nextStep: `Show this notice to the user and ASK them. Only if they explicitly accept, call ${tool} again with ` +
        'acknowledgeProviderRole:true and intendedPurpose in their own words. Do not acknowledge on their behalf.',
    };
  }
  if (e.code === 'LICENCE_FORBIDS_COPY') {
    return {
      licenceForbidsCopy: true,
      notice,
      nextStep: `This entry is proprietary: it can be used hosted, never copied, and tailoring needs a copy. Call ${tool} again ` +
        'WITHOUT problem, stack and notes to get a hosted binding instead (mode "binding": nothing is copied; it is called through the binding\'s invoke path).',
    };
  }
  return null;
}

/** The same failure with a plain-words next step, so the model branches on it instead of retrying into it. */
function withHint(e: SwfteApiError, suggestedAction: string): SwfteApiError {
  return new SwfteApiError({
    status: e.status,
    code: e.code,
    message: e.message,
    reason: e.reason,
    envelope: e.envelope,
    method: e.method,
    path: e.path,
    suggestedAction,
  });
}

/** Failures of the pipeline adopt and deliver share. */
const PIPELINE_HINTS: Record<string, string> = {
  BINDING_UNAVAILABLE:
    'This entry is proprietary and can only be used through a hosted binding, which is unavailable right now. Nothing was ' +
    'copied — a copy is never the fallback. Retry shortly.',
  ADOPT_UNSUPPORTED: 'This kind of entry cannot be copied or delivered. Reuse it through its contract (swfte_get_context, swfte_scaffold_client) instead.',
  IDEMPOTENCY_KEY_REUSED: 'That idempotency key was already used for a different request. Use a new key for a new request; reuse a key only to retry the identical one.',
};

/** A binding answer: what the caller (or the customer) calls, since nothing was copied. */
function bindingOf(res: AdoptResponse, caller: 'you' | 'the customer') {
  if (res.mode !== 'binding') return null;
  const b = res.binding ?? {};
  const inv = b.invoke ?? null;
  const licence = b.licence ?? res.licence ?? 'proprietary';
  const how = inv?.path
    ? `${inv.method ?? 'POST'} ${inv.path} (auth: ${inv.auth ?? 'pat'}${inv.async ? '; async — poll for the result' : ''})`
    : 'the binding\'s invoke path';
  return {
    binding: {
      bindingId: b.bindingId ?? null,
      catalogRef: b.catalogRef ?? res.catalogRef ?? null,
      licence,
      pinnedVersion: b.pinnedVersion ?? null,
      contractHash: b.contractHash ?? null,
      status: b.status ?? null,
      invoke: inv,
    },
    bindingNote:
      `Nothing was copied: the licence (${licence}) allows hosted use only, so this is a binding that runs the author's ` +
      `published version${b.pinnedVersion ? ` (pinned ${b.pinnedVersion})` : ''}. ${caller === 'you' ? 'Call' : 'The customer calls'} it with ${how}.`,
    invokeStep: `${caller === 'you' ? 'Call' : 'The customer calls'} it through the binding: ${how}. There is nothing to run, refine or scaffold as a copy.`,
  };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/* ── delivery (DEV-CROSS-ORG) ────────────────────────────────────────────── */

const NO_GRANT =
  'Not found — and deliberately indistinguishable. Either the entry is not one your workspace can see (check the catalogRef ' +
  'with swfte_get_context), or the target workspace holds no LIVE delivery grant covering it for your organisation: no grant, ' +
  'an expired or revoked one, one ended by a handover or narrowed to support-only, one issued to another account, one listing ' +
  'other entries — or the target is your own workspace. The server does not say which, so this tool cannot either. Ask the ' +
  'customer\'s workspace owner or admin to issue a delivery grant in Studio → Data → Delivery grants (/v2/studio/delivery-grants) naming your ' +
  'organisation\'s account (valid at most 30 days, optionally listing this catalogRef), then deliver again.';

const DELIVER_HINTS: Record<string, string> = {
  ...PIPELINE_HINTS,
  RATE_LIMITED:
    'Deliveries are limited to 30 per minute per deliverer. Wait a minute, then retry with the SAME idempotencyKey so a ' +
    'delivery that did land is replayed instead of duplicated.',
};

const CUSTOMER_DEPLOY =
  'Proposed in the CUSTOMER\'s workspace, for the customer\'s approvers (their Studio → Actions). You delivered it, so you ' +
  'cannot approve it, and running it is not yours: do not call swfte_execute_approved_action on it.';

const DEPLOY_ONLY_PROPOSED =
  'A deploy in a delivery is only PROPOSED — in the customer\'s workspace, for the customer\'s approvers. It is never ' +
  'executed by the delivery, you cannot approve it, and you must not try swfte_execute_approved_action on it.';

const HANDOVER_STUDIO_ONLY =
  'This only exports the record of a handover already taken. The handover itself (POST /v2/catalog/{kind}/{id}/handover: ' +
  're-assigns the deliverers\' open requests, revokes their credentials, ends or narrows the grant) is Studio-only — the ' +
  'server refuses a PAT or API key with 403 SESSION_REQUIRED, and only an owner or admin of the customer workspace, in an ' +
  'interactive Studio session, can take it.';

const NO_HANDOVER_YET =
  'No handover has been taken for this entry yet, so there is no record to export. A handover is made in Studio by an owner ' +
  'or admin of the customer workspace (interactive session only; the API refuses tokens with 403 SESSION_REQUIRED). Run this ' +
  'again once it has been taken.';

const NOT_THIS_WORKSPACE =
  'This entry is not in the workspace this credential is bound to (or does not exist). A Handover Record lives in the ' +
  'CUSTOMER\'s workspace, beside the delivered copy: use a credential bound to that workspace and the copy\'s catalogRef ' +
  '(the one swfte_deliver returned), not the source entry\'s.';

/** The file name the server proposes (Content-Disposition), when it is a plain name; else the same rule locally. */
function handoverFileName(r: CatalogRef, disposition: string | undefined): string {
  const m = /filename="([^"]+)"/i.exec(disposition ?? '');
  if (m && /^HANDOVER-[A-Za-z0-9_.-]+\.md$/.test(m[1]!)) return m[1]!;
  return `HANDOVER-${r.kind}-${r.id.replace(/[^A-Za-z0-9_.-]/g, '_')}.md`;
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
      'The copy starts with no evidence of its own. sourceWorkspaceId adopts from another workspace you are a MEMBER of ' +
      '(a 404 then means not found there or not a member — the server does not say which). A proprietary entry comes back ' +
      'as mode "binding": nothing is copied, it is called through the binding\'s invoke path, and it cannot be tailored.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg,
      name: z.string().min(1).max(200).optional().describe('Name for the copy.'),
      problem: z.string().max(4000).optional().describe('The developer\'s problem, used to tailor the copy.'),
      stack: StackArg,
      notes: z.string().max(4000).optional().describe('Extra tailoring instructions.'),
      deploy: z.object({ environment: z.enum(ENVIRONMENTS) }).optional().describe('Also propose (not perform) a deploy of the copy.'),
      sourceWorkspaceId: WorkspaceIdArg.optional().describe(
        'Adopt from ANOTHER workspace you are a verified member of (sent as the ?sourceWorkspaceId= query parameter). ' +
          'Omit for your own workspace or a public entry.',
      ),
      ...providerRoleFields('swfte_adopt'),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const r = parseCatalogRef(input.catalogRef);
      const { wanted: wantsTailoring, tailoring, stack, source, detection } = tailoringOf(input, localFilesystem !== false);
      const outcome = await client.request<AdoptResponse>({
        method: 'POST',
        path: `${catalogPath(r)}/adopt`,
        ...(input.sourceWorkspaceId ? { query: { sourceWorkspaceId: input.sourceWorkspaceId } } : {}),
        body: adoptBody(input, tailoring),
        // Adoption creates an artifact; a retried POST could create two.
        retries: 0,
      }).then(
        (res) => ({ res: res ?? {}, refusal: null }),
        (e: unknown) => {
          // Art. 25 / licence: answers for the human, surfaced as such rather than as errors.
          const refusal = pipelineRefusal(e, 'swfte_adopt');
          if (refusal) return { res: {} as AdoptResponse, refusal };
          if (e instanceof SwfteApiError && e.status === 404 && input.sourceWorkspaceId) {
            throw withHint(e, `Not found in workspace ${input.sourceWorkspaceId} — or you are not a member of it; the server answers both the same way. Check the id with a member of that workspace.`);
          }
          if (e instanceof SwfteApiError && PIPELINE_HINTS[e.code]) throw withHint(e, PIPELINE_HINTS[e.code]!);
          throw e;
        },
      );
      if (outcome.refusal) return { adopted: false, ...outcome.refusal };
      const res = outcome.res;

      const newRef = res.catalogRef ?? (res.kind && res.id ? `${res.kind}:${res.id}` : null);
      // Counts only. The server records the adopt itself; this names the channel (MCP).
      emitTelemetry({ client, config }, { event: 'adopt', catalogRef: newRef });
      const bound = bindingOf(res, 'you');
      const needsInput = list(res.needsInput);
      const providers = [...new Set([...list(res.missingConnections), ...providersIn(needsInput)])];
      const deployAction = res.deployAction ? presentAction(res.deployAction) : null;
      const nextSteps: string[] = [];
      if (providers.length) nextSteps.push(`Connect ${providers.join(', ')}: ${providers.map((p) => `swfte_connect_start {provider:"${p}"}`).join('; ')}.`);
      const asks = needsInput.filter((n) => !providersIn([n]).length);
      if (bound) {
        // A binding's needsInput are notes (e.g. "nothing to deploy"), not {{ASK}} fields of a copy.
        nextSteps.push(bound.invokeStep);
      } else {
        if (asks.length) nextSteps.push(`Answer the open inputs (${asks.join(', ')}) — in Studio, or swfte_refine the copy — before running it.`);
        if (newRef) {
          nextSteps.push(`Run it on representative inputs (swfte_run) — the copy starts with no evidence of its own.`);
          nextSteps.push(`Bake it into the code: swfte_scaffold_client {catalogRef:"${newRef}"} (or \`swfte add ${newRef}\`).`);
        }
      }
      if (deployAction) {
        nextSteps.push(
          deployAction.status === 'PROPOSED'
            ? `Deploy is PROPOSED (action ${deployAction.actionId}). Ask the user to approve it in Studio → Actions; then swfte_execute_approved_action {actionId:"${deployAction.actionId}"}. Do not execute it before approval.`
            : `Deploy action ${deployAction.actionId} is ${deployAction.status}; check it with swfte_get_action_status.`
        );
      } else if (!input.deploy && newRef && !bound) {
        nextSteps.push(`To deploy later: swfte_request_approval {capability:"workflow.deploy", target:"${newRef}", environment:"development"}.`);
      }
      return {
        catalogRef: newRef,
        kind: res.kind ?? r.kind,
        id: res.id ?? null,
        // A binding is not a fork: nothing was copied.
        forkedFrom: bound ? null : (res.forkedFrom ?? r.ref),
        mode: bound ? 'binding' : 'copy',
        tailoringApplied: res.tailoringApplied === true,
        tailoringSummary: res.tailoringSummary ?? null,
        ...(wantsTailoring && res.tailoringApplied !== true
          ? { tailoringNote: 'Tailoring was requested but not applied (the refine path was unavailable or failed); this is a plain copy.' }
          : {}),
        stack: tailoring ? { tags: stack, source, ...(detection ? { framework: detection.framework } : {}) } : null,
        needsInput,
        missingConnections: providers.map(connectHint),
        deployAction,
        ...(bound ? { binding: bound.binding, bindingNote: bound.bindingNote } : {}),
        ...(res.licence ? { licence: res.licence } : {}),
        ...(res.attributedTo ? { attributedTo: res.attributedTo } : {}),
        nextSteps,
      };
    },
  },
  {
    name: 'swfte_deliver',
    title: 'Deliver a catalog entry into a customer\'s workspace (delivery grant)',
    description:
      'Push an entry from YOUR workspace into a CUSTOMER\'s workspace on the delivery grant they issued your organisation ' +
      '(POST /v2/catalog/{kind}/{id}/deliver). Works with a PAT. It runs the adopt pipeline end to end in the target: a ' +
      'copy with lineage (optionally tailored with problem/stack/notes), or — for a proprietary entry — a hosted binding ' +
      '(mode "binding": nothing copied; the customer calls it through the binding\'s invoke path). Same EU AI Act Art. 25 ' +
      'flow as swfte_adopt: tailoring or a public source needs the HUMAN\'s acknowledgement, which comes back as a notice ' +
      'to show them, never acknowledged here. A 404 means the entry is not visible to you OR there is no live grant ' +
      'covering it (deliberately indistinguishable): the customer\'s owner/admin issues one in Studio → Data → ' +
      'Delivery grants (/v2/studio/delivery-grants) naming your organisation\'s account (≤30 days). deploy is only PROPOSED in the customer\'s ' +
      'workspace for THEIR approvers — you cannot approve it and must not run swfte_execute_approved_action on it. ' +
      'Pass idempotencyKey (sent as the Idempotency-Key header and in the body) and reuse it to retry safely.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg.describe('The entry to deliver: one of your workspace\'s own, or a public entry.'),
      targetWorkspaceId: WorkspaceIdArg.describe('The customer\'s workspace id — the one holding a delivery grant for your organisation.'),
      name: z.string().min(1).max(200).optional().describe('Name for the delivered copy.'),
      problem: z.string().max(4000).optional().describe('The customer\'s problem, used to tailor the copy.'),
      stack: StackArg,
      notes: z.string().max(4000).optional().describe('Extra tailoring instructions.'),
      deploy: z
        .object({ environment: z.enum(ENVIRONMENTS) })
        .optional()
        .describe('Also PROPOSE a deploy in the customer\'s workspace, for the customer\'s approvers. Never executed by the delivery.'),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9_.:-]{8,128}$/, 'idempotencyKey: 8-128 of [A-Za-z0-9_.:-]')
        .optional()
        .describe('Replay key: the same key with the same request answers the same delivery (replayed:true) instead of a second copy.'),
      ...providerRoleFields('swfte_deliver'),
    }),
    execute: async (input, { client, localFilesystem }) => {
      const r = parseCatalogRef(input.catalogRef);
      const { wanted: wantsTailoring, tailoring, stack, source, detection } = tailoringOf(input, localFilesystem !== false);
      const outcome = await client.request<DeliverResponse>({
        method: 'POST',
        path: `${catalogPath(r)}/deliver`,
        body: {
          targetWorkspaceId: input.targetWorkspaceId,
          ...adoptBody(input, tailoring),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        },
        ...(input.idempotencyKey ? { headers: { 'Idempotency-Key': input.idempotencyKey } } : {}),
        // A delivery creates an artifact in someone else's workspace; a blind retry could create two.
        retries: 0,
      }).then(
        (res) => ({ res: res ?? {}, refusal: null }),
        (e: unknown) => {
          const refusal = pipelineRefusal(e, 'swfte_deliver');
          if (refusal) return { res: {} as DeliverResponse, refusal };
          if (e instanceof SwfteApiError && e.status === 404) throw withHint(e, NO_GRANT);
          if (e instanceof SwfteApiError && DELIVER_HINTS[e.code]) throw withHint(e, DELIVER_HINTS[e.code]!);
          throw e;
        },
      );
      if (outcome.refusal) return { delivered: false, targetWorkspaceId: input.targetWorkspaceId, ...outcome.refusal };

      const d = outcome.res.delivered ?? {};
      const target = outcome.res.targetWorkspaceId ?? input.targetWorkspaceId;
      const newRef = d.catalogRef ?? (d.kind && d.id ? `${d.kind}:${d.id}` : null);
      const bound = bindingOf(d, 'the customer');
      const needsInput = list(d.needsInput);
      const providers = [...new Set([...list(d.missingConnections), ...providersIn(needsInput)])];
      const asks = needsInput.filter((n) => !providersIn([n]).length);
      const deployAction = d.deployAction ? { ...presentAction(d.deployAction), instructions: CUSTOMER_DEPLOY } : null;

      const nextSteps: string[] = [];
      if (bound) {
        nextSteps.push(bound.invokeStep);
      } else if (newRef) {
        nextSteps.push(
          `${newRef} now lives in the customer's workspace ${target}. This credential acts in YOUR workspace, so running, ` +
            'refining or scaffolding the copy happens there (Studio, or a credential bound to that workspace), not with these tools.'
        );
      }
      if (providers.length) {
        nextSteps.push(
          `The customer connects ${providers.join(', ')} in their own workspace (Studio → Connections). swfte_connect_start here ` +
            'would connect YOUR workspace, not theirs.'
        );
      }
      if (asks.length && !bound) nextSteps.push(`Open inputs (${asks.join(', ')}) are answered in the customer's workspace before it runs.`);
      // A binding runs the author's published version: there is no deploy to propose at all.
      const deployNote = bound
        ? input.deploy
          ? 'A binding runs the author\'s published version: there is nothing to deploy in the customer\'s workspace, so no deploy was proposed.'
          : null
        : input.deploy || deployAction
          ? DEPLOY_ONLY_PROPOSED
          : null;
      if (deployNote) nextSteps.push(deployNote);
      if (newRef && !bound) {
        nextSteps.push(
          `When the customer takes it over, their owner/admin takes the handover in Studio (interactive session only); ` +
            `then swfte_handover_record {catalogRef:"${newRef}"}, run with a credential bound to the customer's workspace, writes the runbook into their repo.`
        );
      }

      return {
        delivered: true,
        targetWorkspaceId: target,
        grantId: outcome.res.grantId ?? null,
        replayed: d.replayed === true,
        mode: bound ? 'binding' : 'copy',
        catalogRef: newRef,
        kind: d.kind ?? r.kind,
        id: d.id ?? null,
        forkedFrom: bound ? null : (d.forkedFrom ?? r.ref),
        tailoringApplied: d.tailoringApplied === true,
        tailoringSummary: d.tailoringSummary ?? null,
        ...(wantsTailoring && d.tailoringApplied !== true && !bound
          ? { tailoringNote: 'Tailoring was requested but not applied (the refine path was unavailable or failed); this is a plain copy.' }
          : {}),
        stack: tailoring ? { tags: stack, source, ...(detection ? { framework: detection.framework } : {}) } : null,
        needsInput,
        missingConnections: providers,
        deployAction,
        ...(deployNote ? { deployNote } : {}),
        ...(bound ? { binding: bound.binding, bindingNote: bound.bindingNote } : {}),
        ...(d.licence ? { licence: d.licence } : {}),
        ...(d.attributedTo ? { attributedTo: d.attributedTo } : {}),
        nextSteps,
      };
    },
  },
  {
    name: 'swfte_handover_record',
    title: 'Export a Handover Record (runbook) into the repo',
    description:
      'Fetch the newest Handover Record of a delivered entry as Markdown (GET /v2/catalog/{kind}/{id}/handover?format=markdown) ' +
      'and write it into the project — by default HANDOVER-<kind>-<id>.md at the project root, or targetFile. Same file rules ' +
      'as the other writers: confined to the working directory (no absolute paths elsewhere, no `..`, no symlinks), never ' +
      'overwriting a different existing file unless force:true, no secrets on disk; a hosted server returns the file inline ' +
      'instead. ' + HANDOVER_STUDIO_ONLY + ' The record lives in the customer\'s workspace: run this with a credential bound ' +
      'to it, on the delivered copy\'s catalogRef. A 404 means no handover has been taken yet, or the entry is not in this ' +
      'workspace — the result says which.',
    inputSchema: z.object({
      catalogRef: CatalogRefArg.describe('The delivered copy in this (the customer\'s) workspace.'),
      targetFile: z.string().optional().describe('Where to write it, relative to the project root (e.g. "docs/HANDOVER.md"). Default: the server\'s file name at the root.'),
      force: z.boolean().optional().describe('Replace an existing file whose content differs. Default false.'),
    }),
    execute: async (input, { client, config, localFilesystem }) => {
      const writer = new ConfinedWriter({ forbidden: [config.credential], inline: localFilesystem === false });
      const r = parseCatalogRef(input.catalogRef);
      // Confine a caller-given path before anything is fetched.
      const given = input.targetFile ? writer.resolve(input.targetFile) : null;
      let doc: Awaited<ReturnType<typeof client.getBinary>>;
      try {
        doc = await client.getBinary(`${catalogPath(r)}/handover`, {
          query: { format: 'markdown' },
          accept: 'text/markdown, text/plain;q=0.9',
          timeoutMs: 60_000,
        });
      } catch (e) {
        if (e instanceof SwfteApiError && e.status === 404) {
          throw withHint(e, /handover record/i.test(e.message) ? NO_HANDOVER_YET : NOT_THIS_WORKSPACE);
        }
        throw e;
      }
      if (!/^text\/(markdown|plain)\b/i.test(doc.contentType)) {
        throw new Error(
          `Expected a Markdown runbook (text/markdown) but the server answered ${doc.contentType || 'no content type'}; ` +
            'nothing was written. The backend may predate the handover export (?format=markdown).'
        );
      }
      const markdown = new TextDecoder('utf-8').decode(doc.bytes);
      const target = given ?? writer.resolve(handoverFileName(r, doc.headers['content-disposition']));
      writer.create(target, markdown, input.force);
      const written = writer.commit();
      return {
        catalogRef: r.ref,
        file: writer.rel(target),
        written,
        bytes: Buffer.byteLength(markdown),
        handover: HANDOVER_STUDIO_ONLY,
        ...(writer.inline ? { inline: true, note: INLINE_NOTE } : {}),
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
