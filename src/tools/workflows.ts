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
    description: 'Fetch a workflow by ID.',
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
    description: 'Create a new workflow.',
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
  {
    name: 'swfte_workflows_publish',
    title: 'Publish workflow',
    description: 'Snapshot the current draft as a new immutable workflow version and mark it current. A workflow must be published before swfte_workflows_execute will run it as a real (non-test) execution.',
    inputSchema: Workspace.extend({
      workflowId: z.string(),
      releaseNote: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/publish`,
        query: { releaseNote: input.releaseNote },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_deployment_status',
    title: 'Get workflow deployment status',
    description: 'Check where a workflow\'s deployment stands: full per-model-node readiness detail (READY/TIMEOUT/FAILED per model). This is distinct from the workflow\'s own lifecycle status field.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/deployment-status`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_deployment_status_simple',
    title: 'Get simplified workflow deployment status',
    description: 'Simplified deployment status with counts and model status strings — cheaper than swfte_workflows_deployment_status, good for dashboards and quick checks.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/deployment-status/simple`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_pre_deploy',
    title: 'Pre-deploy workflow models',
    description: 'Deploy all models referenced by a workflow ahead of time, so a later swfte_workflows_execute call does not pay cold-start latency.',
    inputSchema: Workspace.extend({
      workflowId: z.string(),
      timeoutSeconds: z.number().int().min(1).optional().describe('Defaults to 600.'),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/pre-deploy`,
        query: { timeoutSeconds: input.timeoutSeconds },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_execute',
    title: 'Execute workflow',
    description: 'Start a workflow execution with the given inputs. Returns immediately with an executionId — poll swfte_workflows_execution_status or swfte_workflows_execution_traces for progress. A draft that has never been published is rejected unless inputs.testingFlag is true.',
    inputSchema: Workspace.extend({
      workflowId: z.string(),
      inputs: z.record(z.unknown()).optional(),
      skipValidation: z.boolean().optional(),
      preDeploy: z.boolean().optional().describe('Deploy all models before starting, blocking until ready or preDeployTimeoutSeconds elapses.'),
      preDeployTimeoutSeconds: z.number().int().min(1).optional(),
      skipBilling: z.boolean().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/execute`,
        query: {
          skipValidation: input.skipValidation,
          preDeploy: input.preDeploy,
          preDeployTimeoutSeconds: input.preDeployTimeoutSeconds,
          skipBilling: input.skipBilling,
        },
        body: input.inputs ?? {},
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_executions_list',
    title: 'List workflow runs',
    description: 'List the execution history for a workflow — every run that has been started, most recent first.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/executions`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_execution_status',
    title: 'Get workflow execution status',
    description: 'Fetch a single execution\'s status, per-node execution records, and overall progress.',
    inputSchema: Workspace.extend({ executionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/executions/${encodeURIComponent(input.executionId)}/status`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_execution_traces',
    title: 'Get workflow execution node traces',
    description: 'Fetch node-level execution traces for a run — per-node timing, token usage, and error details, plus a stall diagnostic if the run appears stuck. Falls back to persisted traces for terminal/historical executions.',
    inputSchema: Workspace.extend({ executionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/executions/${encodeURIComponent(input.executionId)}/traces`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_execution_pause',
    title: 'Pause workflow execution',
    description: 'Pause a running workflow execution.',
    inputSchema: Workspace.extend({ executionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/workflows/executions/${encodeURIComponent(input.executionId)}/pause`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_execution_resume',
    title: 'Resume workflow execution',
    description: 'Resume a paused workflow execution.',
    inputSchema: Workspace.extend({ executionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/workflows/executions/${encodeURIComponent(input.executionId)}/resume`,
        workspaceId: input.workspaceId,
      }),
  },
];
