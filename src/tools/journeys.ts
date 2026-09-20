import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

const DefinitionJson = z.union([z.string(), z.record(z.unknown())]);

const segmentShapeNote =
  'definitionJson.segments[] items are discriminated by kind: NODE (deterministic integration call — type, operation, and templated params like "{{trigger.email}}"), BRANCH (condition + nested whenTrue[]/whenFalse[] segment arrays), SWITCH (cases[] each carrying its own nested segments, plus an optional fallback[]), AGENT_OBJECTIVE (objective, provider, model, responseOutputs typed field-extraction schema, knowledgeModuleIds), HUMAN_ACCOUNTABLE (objective, assignee/assignees, gate, condition, and branches[] the flow forks on after the human decides).';

export const journeyTools: ToolDefinition[] = [
  {
    name: 'swfte_journeys_list',
    title: 'List journey templates',
    description: 'List the journey template catalogue (built-in + custom) available in the workspace.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/journey-templates',
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_get',
    title: 'Get journey template',
    description: 'Fetch a journey template by ID, including its definitionJson segment graph.',
    inputSchema: Workspace.extend({ journeyTemplateId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/journey-templates/${encodeURIComponent(input.journeyTemplateId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_create',
    title: 'Create journey template',
    description: `Create a custom journey template. ${segmentShapeNote}`,
    inputSchema: Workspace.extend({
      name: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      definitionJson: DefinitionJson,
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/journey-templates',
        body: {
          name: input.name,
          description: input.description,
          category: input.category,
          definitionJson: input.definitionJson,
        },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_update',
    title: 'Update journey template',
    description: 'Update a custom journey template. Built-in templates are rejected by the API — clone them into a custom template first.',
    inputSchema: Workspace.extend({
      journeyTemplateId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      definitionJson: DefinitionJson.optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'PUT',
        path: `/v2/journey-templates/${encodeURIComponent(input.journeyTemplateId)}`,
        body: {
          name: input.name,
          description: input.description,
          category: input.category,
          definitionJson: input.definitionJson,
        },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_delete',
    title: 'Delete journey template',
    description: 'Delete a custom journey template. Irreversible; built-in templates cannot be deleted.',
    inputSchema: Workspace.extend({ journeyTemplateId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'DELETE',
        path: `/v2/journey-templates/${encodeURIComponent(input.journeyTemplateId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_generate',
    title: 'Generate journey blueprint from prompt',
    description: 'Use the journey wizard to draft a segment blueprint from a natural-language prompt. Not persisted — pass the result to swfte_journeys_create to save it.',
    inputSchema: Workspace.extend({
      prompt: z.string().min(1).describe('What the journey should do, in plain English.'),
      current: z.record(z.unknown()).optional().describe('The current draft blueprint, if refining an existing one.'),
      applicationName: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/journey-templates/generate',
        body: { prompt: input.prompt, current: input.current, applicationName: input.applicationName },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_deploy',
    title: 'Deploy a journey template',
    description: 'Compile a journey template into a live workflow-v2 graph and record the deployment. Required before swfte_journeys_run/test will work.',
    inputSchema: Workspace.extend({
      journeyTemplateId: z.string(),
      moduleId: z.string().describe('The application module this journey belongs to.'),
      target: z.enum(['SINGLE_PROCESS', 'CLOUD', 'ON_PREM', 'ON_DEVICE']).optional().describe('Runtime target. Defaults to CLOUD.'),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/relay/journeys/${encodeURIComponent(input.journeyTemplateId)}/deploy`,
        body: { moduleId: input.moduleId, target: input.target },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_run',
    title: 'Run a deployed journey',
    description: 'Start the top-level workflow of a deployed journey with live inputs. Returns 409 not_deployed if swfte_journeys_deploy has not been called yet. Use swfte_relay_runs_get with the returned workflowId to track progress.',
    inputSchema: Workspace.extend({
      journeyTemplateId: z.string(),
      inputs: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/relay/journeys/${encodeURIComponent(input.journeyTemplateId)}/run`,
        body: { inputs: input.inputs },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_test',
    title: 'Test-run a deployed journey',
    description: 'Same as swfte_journeys_run but tags the execution as a test so it can be filtered out of live-run views.',
    inputSchema: Workspace.extend({
      journeyTemplateId: z.string(),
      inputs: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/relay/journeys/${encodeURIComponent(input.journeyTemplateId)}/test`,
        body: { inputs: input.inputs },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_app_deploy',
    title: "Deploy an application's journeys",
    description: 'Deploy multiple journeys belonging to one application module in a single call, compiling each to its own workflow-v2 graph under one deployment record.',
    inputSchema: Workspace.extend({
      moduleId: z.string(),
      journeyIds: z.array(z.string()),
      target: z.enum(['SINGLE_PROCESS', 'CLOUD', 'ON_PREM', 'ON_DEVICE']).optional().describe('Runtime target. Defaults to CLOUD.'),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/applications/${encodeURIComponent(input.moduleId)}/deploy`,
        body: { journeyIds: input.journeyIds, target: input.target },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_journeys_app_deployments_list',
    title: "List an application's deployments",
    description: 'List Relay deployments for one application module — use this to check where a given journey/module was deployed and which workflow IDs it produced.',
    inputSchema: Workspace.extend({ moduleId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/applications/${encodeURIComponent(input.moduleId)}/deploy`,
        workspaceId: input.workspaceId,
      }),
  },
];
