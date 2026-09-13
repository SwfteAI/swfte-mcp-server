import { DesignContext, wizardContext } from '../guidance/index.js';
import { z } from 'zod';
import { SwfteApiError, type SwfteClient } from '../client.js';
import {
  BUILDABLE_KINDS,
  IMPLEMENTED_KINDS,
  getAdapter,
  requireVerb,
  type BuildSnapshot,
  type Kind,
  type KindAdapter,
} from '../kinds/index.js';
import { requiredConnections } from '../connections.js';
import { gate, withClientTransport } from '../preflight.js';
import { deriveFromLive } from '../preflight/derive.mjs';
import type { ToolDefinition } from './_types.js';

/**
 * Providers this workflow needs that nobody has signed in to yet.
 *
 * Best-effort, and deliberately silent about its own failures: if the catalog is
 * unreachable this returns nothing and the run proceeds. A false "you are
 * missing credentials" that blocks a good run is worse than a real failure,
 * which the trace explains anyway.
 */
async function missingConnections(client: SwfteClient, kind: Kind, id: string): Promise<string[]> {
  if (kind !== 'workflow') return [];
  try {
    const workflow = await getAdapter('workflow').get!(client, id);
    const required = await requiredConnections(client, workflow);
    return required.filter((r) => !r.connected).map((r) => r.provider);
  } catch {
    return [];
  }
}

/** Only advertise kinds that actually have an adapter. */
const KindArg = z.enum(IMPLEMENTED_KINDS as [Kind, ...Kind[]]);

/** Narrower enum for the build family — models are uploaded, not generated. */
const BuildableKindArg = z.enum(BUILDABLE_KINDS as [Kind, ...Kind[]]);

const kindList = BUILDABLE_KINDS.join(' | ');

/** Trim streamed graph payloads so a 40-node build doesn't flood the context. */
function summariseGraph(snapshot: BuildSnapshot) {
  return {
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    speculativeCount: snapshot.speculativeNodes.length,
  };
}

/** The terminal payload, with the wizard's own reasoning trail kept intact. */
function terminalPayload(adapter: KindAdapter, snapshot: BuildSnapshot) {
  const fr = snapshot.finalResponse as any;
  const artifact = adapter.extractArtifact?.(snapshot) ?? null;
  const id = adapter.extractId?.(snapshot);

  return {
    done: true,
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(id ? { id, persisted: true } : { persisted: false }),
    artifact,
    // These are the wizard's own account of what it did and what it missed.
    // They are the most useful thing in the response and are routinely dropped
    // by naive wrappers.
    insights: fr?.insights ?? null,
    coverage: fr?.insights?.coverage ?? fr?.coverage ?? null,
    processTrail: fr?.processTrail ?? fr?.insights?.processTrail ?? null,
    graph: summariseGraph(snapshot),
  };
}

async function pollToTerminal(
  client: SwfteClient,
  adapter: KindAdapter,
  sessionId: string,
  waitMs: number
) {
  const status = adapter.status;
  if (!status) throw new Error(`${adapter.kind} has no build status to poll.`);

  const { snapshot, timedOut, elapsedMs, polls } = await client.pollUntil<BuildSnapshot>(
    () => status.call(adapter, client, sessionId),
    (s) => s.done,
    { timeoutMs: waitMs, intervalMs: 2_000 }
  );

  if (timedOut) {
    return {
      done: false,
      sessionId,
      status: snapshot.status,
      progress: snapshot.progress,
      message: snapshot.message,
      graph: summariseGraph(snapshot),
      elapsedMs,
      polls,
      note:
        `Still building after ${Math.round(elapsedMs / 1000)}s. The build continues server-side — ` +
        `call swfte_build_status with sessionId "${sessionId}" to pick it up, or swfte_build_steer to redirect it.`,
    };
  }

  return { ...terminalPayload(adapter, snapshot), elapsedMs, polls };
}

export const shipTools: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  {
    name: 'swfte_build',
    title: 'Build from a description',
    group: 'core',
    description:
      `Build a Studio artifact from a natural-language description. Supported kinds: ${kindList}. ` +
      'First use swfte_solution_advise to distinguish a product, bounded workflow or agentic system; use swfte_capabilities for actual supported verbs/options. Reference cases can be injected with designContext. ' +
      'Starts the generator, polls it to completion, and returns the generated artifact along with ' +
      'the wizard\'s coverage report (what of your request it did and did not satisfy) and process ' +
      'trail. If the build outruns waitMs it returns a sessionId to resume with swfte_build_status ' +
      'rather than failing. Some kinds (chatflow, widget) persist as they build and return an id ' +
      'directly; the rest need swfte_create afterwards. A generated artifact or coverage report is not proof of execution, implemented product UI, or deployment.',
    inputSchema: z.object({
      kind: BuildableKindArg,
      designContext: DesignContext.optional(),
      prompt: z
        .string()
        .min(10)
        .describe('What to build, in plain language. Specific beats terse — name the trigger, the steps, the integrations, and the outcome.'),
      model: z.string().optional().describe('Override the model used by the generator itself (not the model inside the built artifact).'),
      autoCreate: z.boolean().optional().describe('Let the wizard persist the result itself instead of returning it for review. Default false.'),
      waitMs: z.number().int().min(5_000).optional().describe('How long to wait for completion before returning a resumable sessionId.'),
      options: z.record(z.unknown()).optional().describe('Kind-specific extras merged into the request (e.g. {attach:{kind:"agent",id:"…"}} for widgets).'),
    }),
    execute: async (input, { client, config }) => {
      const adapter = requireVerb(input.kind, 'build');
      const { sessionId } = await adapter.build(client, {
        prompt: wizardContext(input.prompt, input.designContext),
        model: input.model,
        autoCreate: input.autoCreate,
        options: input.options,
      });
      return pollToTerminal(client, adapter, sessionId, input.waitMs ?? config.defaultWaitMs);
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_build_status',
    title: 'Resume a running build',
    group: 'core',
    readOnly: true,
    description:
      'Resume polling a build that outran its wait window, and return it once terminal. Wizard ' +
      'sessions are held in memory and swept after a TTL, so a 404 here means the session expired, ' +
      'not that the build failed — check the artifact list before rebuilding.',
    inputSchema: z.object({
      kind: KindArg,
      sessionId: z.string(),
      waitMs: z.number().int().min(1_000).optional(),
    }),
    execute: async (input, { client, config }) => {
      const adapter = getAdapter(input.kind);
      try {
        return await pollToTerminal(client, adapter, input.sessionId, input.waitMs ?? config.defaultWaitMs);
      } catch (err) {
        if (err instanceof SwfteApiError && err.status === 404) {
          return {
            done: false,
            sessionId: input.sessionId,
            error: 'SESSION_NOT_FOUND',
            message:
              'This wizard session is no longer in the run store — it either expired or the build ' +
              'finished long enough ago to be swept. The artifact may still have been created: check ' +
              `swfte_${input.kind === 'mcp-server' ? 'mcp_artifacts' : `${input.kind}s`}_list before rebuilding.`,
          };
        }
        throw err;
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_build_steer',
    title: 'Steer a running build',
    group: 'core',
    description:
      'Send a mid-flight instruction to a build that is still running — e.g. "use Postgres, not ' +
      'MySQL" or "drop the Slack step". Returns 409/inactive if the build already finished, in ' +
      'which case use swfte_refine on the result instead.',
    inputSchema: z.object({
      kind: KindArg,
      sessionId: z.string(),
      instruction: z.string().min(3),
    }),
    execute: async (input, { client }) => {
      const adapter = requireVerb(input.kind, 'steer');
      const res = (await adapter.steer(client, input.sessionId, input.instruction)) as any;
      const inactive = res?.status === 'inactive';
      return {
        accepted: !inactive,
        ...res,
        ...(inactive
          ? { hint: 'The build has already finished. Use swfte_refine on the generated artifact instead.' }
          : {}),
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_validate',
    title: 'Validate without saving',
    group: 'core',
    readOnly: true,
    description:
      'Check a generated artifact before persisting it. Returns findings and suggestions. For ' +
      'workflows this also runs static graph analysis the backend does not — unwired nodes and ' +
      'edges pointing at non-existent ids — which are the defects most likely to survive to runtime.',
    inputSchema: z.object({
      kind: KindArg,
      artifact: z.record(z.unknown()).describe('The generated artifact, as returned by swfte_build.'),
    }),
    execute: async (input, { client }) => {
      const adapter = requireVerb(input.kind, 'validate');
      return adapter.validate(client, input.artifact);
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_create',
    title: 'Persist a generated artifact',
    group: 'core',
    description:
      'Persist an artifact produced by swfte_build. Validation runs first — a 422 comes back as ' +
      'structured findings you can act on rather than an opaque error, so fix them with swfte_refine ' +
      'and call this again. Not needed for kinds that persist during the build (chatflow, widget).',
    inputSchema: z.object({
      kind: KindArg,
      artifact: z.record(z.unknown()),
    }),
    execute: async (input, { client }) => {
      const adapter = requireVerb(input.kind, 'create');
      try {
        const { id, raw } = await adapter.create(client, input.artifact);
        return { created: true, kind: input.kind, id, raw };
      } catch (err) {
        if (err instanceof SwfteApiError && err.status === 422) {
          return {
            created: false,
            reason: 'VALIDATION_FAILED',
            findings: err.envelope.validationErrors ?? err.envelope.errors ?? [],
            suggestions: err.envelope.suggestions ?? [],
            nextAction: 'Fix the findings with swfte_refine, then call swfte_create again.',
          };
        }
        throw err;
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_refine',
    title: 'Refine an artifact',
    group: 'core',
    description:
      'Iterate on a generated artifact with plain-language feedback ("the email step should use the ' +
      'research output", "add retry on the HTTP call"). Returns the revised artifact — persist it ' +
      'with swfte_create, or validate it first.',
    inputSchema: z.object({
      kind: KindArg,
      artifact: z
        .record(z.unknown())
        .describe('The CURRENT artifact being refined. Required — the generator rebuilds its prompt from it, and omitting it fails.'),
      feedback: z.string().min(3),
    }),
    execute: async (input, { client }) => {
      const adapter = requireVerb(input.kind, 'refine');
      const result = (await adapter.refine(client, input.artifact, input.feedback)) as any;
      return {
        refined: true,
        status: result?.status,
        message: result?.message,
        // The refine response uses `generatedWorkflow`, not `workflow`.
        artifact: result?.generatedWorkflow ?? result?.generatedAgent ?? result?.chatFlow ?? result,
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_run',
    title: 'Run and collect the trace',
    group: 'core',
    description:
      'Execute a persisted artifact to a terminal state and return the result. For workflows that ' +
      'means per-node traces, and an unpublished workflow automatically falls back to the draft test ' +
      'path instead of erroring. For agents it sends a chat probe, retrying through backend ' +
      'load-shedding so a degraded platform is reported as such rather than as a broken agent. ' +
      'Stops before spending an execution when the workflow needs an OAuth provider nobody has ' +
      'signed in to, since that run can only fail — connect first, or pass force:true.',
    inputSchema: z.object({
      kind: KindArg,
      id: z.string(),
      inputs: z.record(z.unknown()).optional().describe('Workflow inputs.'),
      message: z.string().optional().describe('The turn to send, for conversational kinds.'),
      force: z
        .boolean()
        .optional()
        .describe('Run even when a required OAuth connection appears to be missing.'),
      timeoutMs: z.number().int().min(5_000).optional(),
    }),
    execute: async (input, { client }) => {
      const adapter = requireVerb(input.kind, 'run');

      // Executions are metered, and a workflow missing a credential fails at the
      // first integration node every time. Spending the execution to discover
      // that helps nobody, so check first and hand back the step that fixes it.
      // `force` exists because the check is best-effort: a credential stored
      // under a name that does not normalise to the provider would otherwise
      // block a run that would have worked.
      if (!input.force) {
        const missing = await missingConnections(client, input.kind, input.id);
        if (missing.length > 0) {
          return {
            ran: false,
            blocked: 'MISSING_CONNECTIONS',
            missing,
            summary:
              `Not run: this workflow needs ${missing.join(', ')}, which nobody has signed in to. ` +
              'Every run would fail at that node.',
            nextStep:
              `Call swfte_connect_start with provider "${missing[0]}" to open sign-in for the user, ` +
              'then run again. Pass force:true to run anyway.',
          };
        }
      }

      return adapter.run(client, input.id, {
        inputs: input.inputs,
        message: input.message,
        timeoutMs: input.timeoutMs,
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_deploy',
    title: 'Deploy (preview by default)',
    group: 'core',
    description:
      'Deploy a persisted artifact. PREVIEWS BY DEFAULT: returns the target the backend pre-flight ' +
      'chose, the runtime profile, and the estimated hourly cost, without provisioning anything. ' +
      'Pass confirm:true to actually provision — which also requires SWFTE_ALLOW_DEPLOY=1 on the ' +
      'server, so an unattended loop cannot spend money on its own. You never name a cloud provider: ' +
      'the unified deploy router analyses workflow artifacts; explicit workflow capacity options use the managed route. Other kinds have different lifecycle support: consult swfte_capabilities. Activation and accepted provisioning do not prove topology or endpoint health. Use action:"teardown" ' +
      'to release a deployment; that is always permitted.',
    inputSchema: z.object({
      kind: KindArg,
      id: z.string(),
      action: z.enum(['preview', 'deploy', 'teardown']).optional().describe('Default "preview".'),
      confirm: z.boolean().optional().describe('Required, with SWFTE_ALLOW_DEPLOY=1, to actually provision.'),
      deploymentId: z.string().optional().describe('Which deployment to tear down.'),
      option: z.enum(['BYO', 'shared', 'dedicated']).optional().describe('Workflow managed capacity intent; application dedicated maps to SERVER. Other adapters may not forward this option. Consult swfte_capabilities; verify resulting target/profile, not just this request.'),
      region: z.string().optional(),
      gpuTier: z.string().optional(),
      lifecycle: z.enum(['ON_DEMAND', 'ALWAYS_ON']).optional(),
      secretId: z.string().optional().describe('Legacy unsupported field. Rejected; use a cloudConnectionId or providerConfigName for managed credentials.'),
      provider: z.enum(['kubernetes', 'digitalocean', 'aws', 'awsLambda', 'gcp', 'azure', 'runpod']).optional().describe('Workflow managed provider; backend default kubernetes. This selects the managed route.'),
      cloudConnectionId: z.string().min(1).optional().describe('Existing tenant cloud connection for BYO deployment; not a raw secret.'),
      providerConfigName: z.string().min(1).optional().describe('Existing Crossplane ProviderConfig name.'),
      sizing: z.object({
        nodeCount: z.number().int().positive().optional(), gpuTier: z.enum(['NONE', 'T4', 'A10', 'A100', 'H100']).optional(),
        gpuCount: z.number().int().min(0).optional(), cpu: z.string().regex(/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]+|[1-9][0-9]*m)$/).optional(),
        memoryGi: z.number().int().positive().optional(), replicas: z.number().int().positive().optional(),
      }).strict().optional().describe('Managed workflow sizing. Cost estimates are computed by the backend, not supplied here.'),
      idleTimeoutSec: z.number().int().min(0).optional(),
      path: z.enum(['crossplane', 'terraform']).optional().describe('Managed backend provisioning path; availability must be verified.'),
      timeoutMs: z.number().int().min(10_000).optional(),
      skipPreflight: z
        .boolean()
        .optional()
        .describe('Provision without the preflight gate. Produces no evidence that the artifact does what it reports doing.'),
      force: z.boolean().optional().describe('Provision despite a blocking or inconclusive preflight. The override is recorded.'),
      forceReason: z.string().optional().describe('Why the override is justified. Recorded verbatim.'),
    }),
    execute: async (input, { client, config }) => {
      const action = input.action ?? 'preview';
      if (input.secretId !== undefined) throw new Error('UNSUPPORTED_DEPLOY_OPTION: secretId is not consumed by any deployment adapter; use an existing cloudConnectionId or providerConfigName for a managed workflow.');
      const managedFields = ['provider', 'cloudConnectionId', 'providerConfigName', 'sizing', 'idleTimeoutSec', 'path'];
      if (input.kind !== 'workflow' && managedFields.some(key => input[key] !== undefined)) throw new Error('UNSUPPORTED_DEPLOY_OPTION: managed provider/connection/sizing fields apply only to workflows.');
      const opts = {
        option: input.option,
        region: input.region,
        gpuTier: input.gpuTier,
        lifecycle: input.lifecycle,
        secretId: input.secretId,
        provider: input.provider, cloudConnectionId: input.cloudConnectionId, providerConfigName: input.providerConfigName,
        sizing: input.sizing, idleTimeoutSec: input.idleTimeoutSec, path: input.path,
        timeoutMs: input.timeoutMs,
      };

      if (action === 'teardown') {
        const adapter = requireVerb(input.kind, 'teardown');
        await adapter.teardown(client, input.id, input.deploymentId);
        return { tornDown: true, kind: input.kind, id: input.id, deploymentId: input.deploymentId ?? null };
      }

      if (action === 'preview') {
        const adapter = getAdapter(input.kind);
        if (!adapter.deployPreview) {
          return {
            dryRun: true,
            kind: input.kind,
            id: input.id,
            note: `${input.kind} has no deploy pre-flight — deploying it is a direct operation with no sizing or cost estimate.`,
            canDeploy: typeof adapter.deploy === 'function',
          };
        }
        const preview = await adapter.deployPreview(client, input.id, opts);
        return {
          dryRun: true,
          kind: input.kind,
          id: input.id,
          ...preview,
          note: 'Nothing has been provisioned. Pass confirm:true to deploy for real.',
        };
      }

      // action === 'deploy'
      if (!input.confirm) {
        return {
          dryRun: true,
          refused: true,
          reason: 'CONFIRMATION_REQUIRED',
          message: 'Deploying provisions billable capacity. Re-call with confirm:true once you have reviewed the preview.',
        };
      }
      if (!config.allowDeploy) {
        return {
          dryRun: true,
          refused: true,
          reason: 'DEPLOY_DISABLED',
          message:
            'This MCP server is configured preview-only. Set SWFTE_ALLOW_DEPLOY=1 in its environment ' +
            'to permit provisioning, then retry.',
        };
      }

      // The same gate publishing uses. Deploying a workflow whose templates all
      // resolve to the empty string provisions capacity to run nothing, at cost,
      // and every node still reports COMPLETED — so the deployment looks healthy
      // in exactly the way this rule set exists to disprove. Only workflows have
      // a rule set today; other kinds skip and say so rather than pretending.
      let preDeployEvidence: Record<string, unknown> | undefined;
      if (input.kind === 'workflow' && !input.skipPreflight) {
        const derived = await withClientTransport(client, () => deriveFromLive([['workflow', input.id]]));
        // This checks suitability BEFORE deployment. WF-PUBLISHED tests ACTIVE,
        // which deployment itself sets; requiring it here makes first deploy impossible.
        // Keep every other rule and report this lifecycle skip explicitly.
        const manifest = { ...derived, expectLive: false };
        const verdict = await gate(client, manifest as never, {
          force: input.force,
          forceReason: input.forceReason,
        });
        preDeployEvidence = { stage: 'PRE_DEPLOYMENT', expectLive: false, verdict: verdict.verdict, skippedRules: verdict.report?.skipped ?? [], nextActions: verdict.nextActions };
        if (!verdict.allowed) {
          return {
            dryRun: true,
            refused: true,
            reason: `PREFLIGHT_${verdict.verdict}`,
            message: verdict.reason,
            blocking: verdict.blocking,
            nextActions: verdict.nextActions,
            skippedRules: verdict.report?.skipped ?? [],
            note: 'Nothing was provisioned. Fix the findings, or pass force:true with forceReason.',
          };
        }
      }

      const adapter = requireVerb(input.kind, 'deploy');
      const result = await adapter.deploy(client, input.id, opts);
      return {
        dryRun: false,
        kind: input.kind,
        id: input.id,
        ...result,
        ...(preDeployEvidence ? { preflight: preDeployEvidence, readiness: 'DEPLOYMENT_RESULT_REQUIRES_RUNTIME_VERIFICATION', nextChecks: ['Read deployment phase, target/profile and endpoint', 'Verify enabled/ACTIVE workflow and published execution version', 'Run positive and negative inputs through the deployed endpoint and correlate traces/analytics'] } : {}),
        ...(result.timedOut
          ? { note: 'Provisioning is still running — it was not cancelled. Poll swfte_deployments_get for the final phase.' }
          : {}),
      };
    },
  },
];
