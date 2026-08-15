import { z } from 'zod';
import { SwfteApiError, type SwfteClient } from '../client.js';
import {
  IMPLEMENTED_KINDS,
  getAdapter,
  requireVerb,
  type BuildSnapshot,
  type Kind,
  type KindAdapter,
} from '../kinds/index.js';
import type { ToolDefinition } from './_types.js';

/** Only advertise kinds that actually have an adapter. */
const KindArg = z.enum(IMPLEMENTED_KINDS as [Kind, ...Kind[]]);

const kindList = IMPLEMENTED_KINDS.join(' | ');

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
  const artifact = adapter.extractArtifact(snapshot);
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
  const { snapshot, timedOut, elapsedMs, polls } = await client.pollUntil<BuildSnapshot>(
    () => adapter.status(client, sessionId),
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
      'Starts the generator, polls it to completion, and returns the generated artifact along with ' +
      'the wizard\'s coverage report (what of your request it did and did not satisfy) and process ' +
      'trail. If the build outruns waitMs it returns a sessionId to resume with swfte_build_status ' +
      'rather than failing. Some kinds (chatflow, widget) persist as they build and return an id ' +
      'directly; the rest need swfte_create afterwards.',
    inputSchema: z.object({
      kind: KindArg,
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
      const adapter = getAdapter(input.kind);
      const { sessionId } = await adapter.build(client, {
        prompt: input.prompt,
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
      'load-shedding so a degraded platform is reported as such rather than as a broken agent.',
    inputSchema: z.object({
      kind: KindArg,
      id: z.string(),
      inputs: z.record(z.unknown()).optional().describe('Workflow inputs.'),
      message: z.string().optional().describe('The turn to send, for conversational kinds.'),
      timeoutMs: z.number().int().min(5_000).optional(),
    }),
    execute: async (input, { client }) => {
      const adapter = requireVerb(input.kind, 'run');
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
      'the unified deploy router analyses the artifact and picks the target. Use action:"teardown" ' +
      'to release a deployment; that is always permitted.',
    inputSchema: z.object({
      kind: KindArg,
      id: z.string(),
      action: z.enum(['preview', 'deploy', 'teardown']).optional().describe('Default "preview".'),
      confirm: z.boolean().optional().describe('Required, with SWFTE_ALLOW_DEPLOY=1, to actually provision.'),
      deploymentId: z.string().optional().describe('Which deployment to tear down.'),
      option: z.enum(['BYO', 'shared', 'dedicated']).optional().describe('Capacity intent. Omit to let the router decide.'),
      region: z.string().optional(),
      gpuTier: z.string().optional(),
      lifecycle: z.enum(['ON_DEMAND', 'ALWAYS_ON']).optional(),
      secretId: z.string().optional(),
      timeoutMs: z.number().int().min(10_000).optional(),
    }),
    execute: async (input, { client, config }) => {
      const action = input.action ?? 'preview';
      const opts = {
        option: input.option,
        region: input.region,
        gpuTier: input.gpuTier,
        lifecycle: input.lifecycle,
        secretId: input.secretId,
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

      const adapter = requireVerb(input.kind, 'deploy');
      const result = await adapter.deploy(client, input.id, opts);
      return {
        dryRun: false,
        kind: input.kind,
        id: input.id,
        ...result,
        ...(result.timedOut
          ? { note: 'Provisioning is still running — it was not cancelled. Poll swfte_deployments_get for the final phase.' }
          : {}),
      };
    },
  },
];
