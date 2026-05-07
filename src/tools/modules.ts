import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const moduleTools: ToolDefinition[] = [
  {
    name: 'swfte_modules_list',
    title: 'List modules',
    description: 'List Swfte modules — bundles of agents, workflows, tools and prompts that can be packaged and shared.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/modules',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_modules_get',
    title: 'Get module',
    description: 'Fetch a single module by ID.',
    inputSchema: Workspace.extend({ moduleId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/modules/${encodeURIComponent(input.moduleId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_modules_create',
    title: 'Create module',
    description: 'Create a new module.',
    inputSchema: Workspace.extend({ module: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/modules',
        body: input.module,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_modules_build',
    title: 'Build module',
    description: 'Trigger a module build (runs the QA bank, packages versioned artifacts).',
    inputSchema: Workspace.extend({ moduleId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/modules/${encodeURIComponent(input.moduleId)}/build`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_modules_versions',
    title: 'List module versions',
    description: 'List the versions of a module.',
    inputSchema: Workspace.extend({ moduleId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/modules/${encodeURIComponent(input.moduleId)}/versions`,
        workspaceId: input.workspaceId,
      }),
  },
];
