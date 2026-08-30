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
    description: 'Fetch one knowledge module, including its attached resources and build state. A module with no resources compiles fine and then retrieves nothing.',
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
    description: 'Create an empty knowledge module. Attach resources and build it before use, or retrieval returns nothing. swfte_build with kind:"module" does create-and-build in one step.',
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
  {
    name: 'swfte_modules_delete',
    title: 'Delete module',
    description:
      'Permanently delete a knowledge module and its attached resources. Irreversible — there is ' +
      'no undelete and no trash. Workspaces have a per-tier module cap, so this is also the only ' +
      'way to free a slot when creation fails with "at module cap". Confirm the id with ' +
      'swfte_modules_list first: ids are opaque and a mistaken delete cannot be undone.',
    inputSchema: Workspace.extend({
      moduleId: z.string(),
      confirm: z
        .boolean()
        .describe('Must be true. Stops an unattended loop from destroying a workspace record.'),
    }),
    execute: async (input, { client }) => {
      if (!input.confirm) {
        return {
          deleted: false,
          reason: 'CONFIRMATION_REQUIRED',
          nextAction: 'Re-call with confirm:true once the module id has been verified.',
        };
      }
      await client.request({
        method: 'DELETE',
        path: `/v2/modules/${encodeURIComponent(input.moduleId)}`,
        workspaceId: input.workspaceId,
        expectStatuses: [200, 202, 204],
        retries: 0,
      });
      return { deleted: true, moduleId: input.moduleId };
    },
  },
];
