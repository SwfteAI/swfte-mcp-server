import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const BASE = '/v1/deployments';

/**
 * Generic deployment lifecycle, across whatever a deployment happens to be
 * fronting. Provider selection is never a parameter here: the deploy router
 * chose the target when the deployment was created, and these tools operate on
 * the resulting record.
 */
export const deploymentTools: ToolDefinition[] = [
  {
    name: 'swfte_deployments_list',
    title: 'List deployments',
    readOnly: true,
    description: 'List deployments for the workspace. Use this to find a deploymentId after an async provision.',
    inputSchema: z.object({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
      status: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: BASE,
        query: { page: input.page, size: input.size, status: input.status },
        retries: 1,
      }),
  },
  {
    name: 'swfte_deployments_get',
    title: 'Get a deployment',
    readOnly: true,
    description: 'Fetch one deployment: its phase, target, runtime profile, and connection details.',
    inputSchema: z.object({ deploymentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: `${BASE}/${encodeURIComponent(input.deploymentId)}`, retries: 1 }),
  },
  {
    name: 'swfte_deployments_for_agent',
    title: 'Deployments for an agent',
    readOnly: true,
    description: 'List every deployment belonging to a given agent.',
    inputSchema: z.object({ agentId: z.string(), activeOnly: z.boolean().optional() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: input.activeOnly
          ? `${BASE}/agent/${encodeURIComponent(input.agentId)}/active`
          : `${BASE}/agent/${encodeURIComponent(input.agentId)}`,
        retries: 1,
      }),
  },
  {
    name: 'swfte_deployments_trail',
    title: 'Deployment trail',
    readOnly: true,
    description:
      'The provisioning trail for a deployment — the ordered record of what happened. This is where ' +
      'to look first when a deployment reaches FAILED.',
    inputSchema: z.object({ deploymentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: `${BASE}/${encodeURIComponent(input.deploymentId)}/trail`, retries: 1 }),
  },
  {
    name: 'swfte_deployments_executions',
    title: 'Deployment executions',
    readOnly: true,
    description: 'Executions recorded against a deployment.',
    inputSchema: z.object({ deploymentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(input.deploymentId)}/executions`,
        retries: 1,
      }),
  },
  {
    name: 'swfte_deployments_activate',
    title: 'Activate a deployment',
    description: 'Bring a provisioned-but-inactive deployment into service.',
    inputSchema: z.object({ deploymentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(input.deploymentId)}/activate`,
        expectStatuses: [200, 202],
        retries: 0,
      }),
  },
  {
    name: 'swfte_deployments_terminate',
    title: 'Terminate a deployment',
    destructive: true,
    description:
      'Terminate a deployment and release its capacity, stopping the associated cost. Always ' +
      'permitted — releasing resources is never gated.',
    inputSchema: z.object({ deploymentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(input.deploymentId)}/terminate`,
        expectStatuses: [200, 202, 204],
        retries: 0,
      }),
  },
  {
    name: 'swfte_deployments_count',
    title: 'Count deployments',
    readOnly: true,
    description: 'How many deployments exist — a quick way to spot capacity left running by mistake.',
    inputSchema: z.object({}),
    execute: async (_input, { client }) =>
      client.request({ method: 'GET', path: `${BASE}/count`, retries: 1 }),
  },
];
