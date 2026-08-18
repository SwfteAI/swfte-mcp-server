import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const workflowTools: ToolDefinition[] = [
  {
    name: 'swfte_workflows_list',
    title: 'List workflows',
    description: 'List workflows in the workspace.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/workflows',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_get',
    title: 'Get workflow',
    description: 'Fetch one workflow, including its node graph and connections. Use swfte_verify with kind:"workflow" to check the graph is actually sound rather than merely present.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_create',
    title: 'Create workflow',
    description: 'Create a workflow from a full graph definition. To build one from a description instead, use swfte_build with kind:"workflow". Note that this endpoint accepts graphs whose nodes are never wired together, so validate before relying on it.',
    inputSchema: Workspace.extend({ workflow: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/workflows',
        body: input.workflow,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_validate',
    title: 'Validate workflow JSON',
    description: 'Validate a workflow definition without persisting it.',
    inputSchema: Workspace.extend({ workflow: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/workflows/validate',
        body: input.workflow,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_clone',
    title: 'Clone workflow',
    description: 'Clone an existing workflow into a new one.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/clone`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_export',
    title: 'Export workflow JSON',
    description: 'Export a workflow as a portable JSON document.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/export`,
        workspaceId: input.workspaceId,
      }),
  },

  // Post-deploy observability. Everything above answers "does this workflow
  // exist and is it well-formed"; a deployed workflow fails for reasons none of
  // it can see. These five read the execution record, which is the only place
  // that says whether the thing actually works once it is live.
  //
  // None takes a workspaceId: these are all path-addressed, and on a PAT the
  // gateway injects the trusted tenant headers anyway (see src/config.ts) — a
  // workspace id we set by hand is at best ignored.
  {
    name: 'swfte_workflows_executions',
    title: 'Workflow execution history',
    readOnly: true,
    description:
      'Every recorded run of one workflow, with status, timing, and result. A deployment reaching ' +
      'READY only says the workflow shipped; this says whether it is working. Read it after a deploy, ' +
      'then take a failing executionId to swfte_workflows_execution_traces to find out which node broke.',
    inputSchema: z.object({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/executions`,
        retries: 1,
      }),
  },
  {
    name: 'swfte_workflows_execution_traces',
    title: 'Execution traces',
    readOnly: true,
    description:
      'Per-node traces for a single run — timing, token usage, and the error text of the node that ' +
      'failed. The execution status tells you a run failed; only the traces tell you which node did ' +
      'it, which is the question you actually have. Also carries a stallDiagnostic when a run stopped ' +
      'making progress instead of erroring outright. Works on historical runs, not just live ones: ' +
      'once the in-memory state is gone the traces are served from the persisted execution record.',
    inputSchema: z.object({ executionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/executions/${encodeURIComponent(input.executionId)}/traces`,
        retries: 1,
      }),
  },
  {
    name: 'swfte_workflows_execution_status',
    title: 'Execution status and result',
    readOnly: true,
    description:
      'The full execution record for one run: status, progress, the inputs it received, the output it ' +
      'produced, and its billing summary. Reach for this when you hold an executionId but not the ' +
      'workflow it came from, or to read back what a finished run actually returned — the traces tool ' +
      'covers per-node failure detail but never the run output.',
    inputSchema: z.object({ executionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/executions/${encodeURIComponent(input.executionId)}/status`,
        retries: 1,
      }),
  },
  {
    name: 'swfte_workflows_execution_cost',
    title: 'Execution cost',
    readOnly: true,
    description:
      'What one run cost: tokens in and out, per-node token usage, platform cost and the amount ' +
      'billed. This answers "why is this workflow expensive" for a specific run, where ' +
      'swfte_analytics_workspace_costs only reports the workspace aggregate. A run that was never ' +
      'billed — a draft test, or one that failed before spending anything — returns NOT_FOUND, which ' +
      'is an answer rather than a fault. A NOT_FOUND carrying `lookupError` means the cost could not ' +
      'be read at all, which is a different thing from a run that cost nothing. Against a backend ' +
      'older than the billing fix this endpoint answers 500 for every execution, billed or not, so ' +
      'treat a 500 here as a stale deployment rather than as a broken workflow.',
    inputSchema: z.object({ executionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/executions/${encodeURIComponent(input.executionId)}/billing`,
        retries: 1,
      }),
  },
  {
    name: 'swfte_workflows_stats',
    title: 'Workflow execution stats',
    readOnly: true,
    description:
      'Execution count, success/failure split, average duration and last-run status for every ' +
      'workflow in the workspace that has ever run. The fastest way to find the deployed workflow ' +
      'that is quietly failing, without opening them one at a time. Workflows with zero executions ' +
      'are omitted entirely — so a workflow missing from this list has never run, which after a ' +
      'deploy is itself the finding.',
    inputSchema: z.object({}),
    execute: async (_input, { client }) =>
      client.request({ method: 'GET', path: '/v2/workflows/stats', retries: 1 }),
  },
];
