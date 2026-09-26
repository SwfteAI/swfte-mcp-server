import { z } from 'zod';
import { linkAgentKnowledge, linkAgentTools } from '../kinds/index.js';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({
  workspaceId: z.string().optional().describe('Workspace ID. Ignored for PAT credentials, which carry their own binding.'),
});

/**
 * Agents live behind two controllers with different capabilities:
 *   /v2/agents  — GET, PATCH, DELETE (no PUT)
 *   /v1/agents  — GET, PUT, DELETE, chat, tools, teams
 *
 * Reads use v2. Updates use v1, because the v2 PATCH replaces the record rather
 * than merging into it.
 */
const AGENTS_V2 = '/v2/agents';
const AGENTS_V1 = '/v1/agents';

export const agentTools: ToolDefinition[] = [
  {
    name: 'swfte_agents_list',
    title: 'List agents',
    readOnly: true,
    description:
      'List agents in the workspace. Pages through automatically — the backend caps page size at ' +
      '20 and silently ignores larger values, so a single request would quietly miss anything past ' +
      'the first page.',
    inputSchema: Workspace.extend({
      all: z.boolean().optional().describe('Fetch every page (default). Set false for just the first page.'),
      page: z.number().int().min(0).optional().describe('Specific page, when all:false.'),
    }),
    execute: async (input, { client }) => {
      if (input.all === false) {
        return client.request({
          method: 'GET',
          path: AGENTS_V1,
          query: { page: input.page ?? 0, pageSize: 20 },
          workspaceId: input.workspaceId,
          retries: 1,
        });
      }
      const agents = await client.paginate({ path: AGENTS_V1, pageSize: 20, workspaceId: input.workspaceId });
      return { total: agents.length, agents };
    },
  },
  {
    name: 'swfte_agents_get',
    title: 'Get agent',
    readOnly: true,
    description: 'Fetch one agent, including its model, capability tier, linked tools and knowledge. Use swfte_verify with kind:"agent" to check whether that configuration actually works.',
    inputSchema: Workspace.extend({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `${AGENTS_V2}/${encodeURIComponent(input.agentId)}`,
        workspaceId: input.workspaceId,
        retries: 1,
      }),
  },
  {
    name: 'swfte_agents_create',
    title: 'Create agent',
    description:
      'Create an agent from a full agent JSON body. To build one from a description instead, use ' +
      'swfte_build with kind:"agent".',
    inputSchema: Workspace.extend({ agent: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: AGENTS_V2,
        body: input.agent,
        workspaceId: input.workspaceId,
        expectStatuses: [200, 201],
        retries: 0,
      }),
  },
  {
    name: 'swfte_agents_update',
    title: 'Update agent (partial)',
    description:
      'Partially update an agent. Reads the full record, overlays your fields, and writes it back — ' +
      'because the raw PATCH endpoint REPLACES the record, so patching just `temperature` would blank ' +
      '`systemPrompt` and everything else you omitted.',
    inputSchema: Workspace.extend({ agentId: z.string(), patch: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.mergePut(`${AGENTS_V1}/${encodeURIComponent(input.agentId)}`, input.patch, {
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_delete',
    title: 'Delete agent',
    destructive: true,
    description: 'Delete an agent. Irreversible.',
    inputSchema: Workspace.extend({ agentId: z.string() }),
    execute: async (input, { client }) => {
      await client.request({
        method: 'DELETE',
        path: `${AGENTS_V2}/${encodeURIComponent(input.agentId)}`,
        workspaceId: input.workspaceId,
        expectStatuses: [200, 202, 204],
        retries: 0,
      });
      return { deleted: true, agentId: input.agentId };
    },
  },
  {
    name: 'swfte_agents_chat',
    // Same endpoint as swfte_run {kind:"agent"}, which also retries through load-shedding.
    // Redundant with a default tool (see 'extras' in src/config.ts); opt in with SWFTE_TOOLS=…,extras.
    group: 'extras',
    title: 'Chat with an agent',
    description:
      'Send one turn to an agent and return its reply. Prefer swfte_run with kind:"agent", which ' +
      'additionally retries through backend load-shedding so a degraded platform is not mistaken for ' +
      'a broken agent.',
    inputSchema: Workspace.extend({
      agentId: z.string(),
      message: z.string(),
      userId: z.string().optional().describe('Conversation identity. Defaults to "mcp-probe".'),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `${AGENTS_V1}/${encodeURIComponent(input.agentId)}/chat/${encodeURIComponent(input.userId ?? 'mcp-probe')}`,
        body: { message: input.message },
        workspaceId: input.workspaceId,
        retries: 0,
        timeoutMs: 120_000,
      }),
  },
  {
    name: 'swfte_agents_link_tools',
    title: 'Link tools to an agent',
    description:
      'Attach tools to an existing agent. Note that tools only actually fire at capabilityTier ' +
      'AGENTIC or above — below that the agent describes calling them instead. swfte_verify checks this.',
    inputSchema: z.object({ agentId: z.string(), toolIds: z.array(z.string()).min(1) }),
    execute: async (input, { client }) => linkAgentTools(client, input.agentId, input.toolIds),
  },
  {
    name: 'swfte_agents_link_knowledge',
    title: 'Link knowledge to an agent',
    description: 'Attach knowledge bases / datasets to an existing agent.',
    inputSchema: z.object({ agentId: z.string(), knowledgeIds: z.array(z.string()).min(1) }),
    execute: async (input, { client }) => linkAgentKnowledge(client, input.agentId, input.knowledgeIds),
  },
  {
    name: 'swfte_agents_wizard_quick',
    // swfte_build {kind:"agent"} + swfte_create does the same with a review step.
    // Redundant with a default tool (see 'extras' in src/config.ts); opt in with SWFTE_TOOLS=…,extras.
    group: 'extras',
    title: 'Quick-create an agent',
    description:
      'Generate AND persist an agent from a description in one synchronous call. Fast, but it skips ' +
      'the review step — swfte_build with kind:"agent" returns the draft for inspection first, and ' +
      'streams progress instead of blocking.',
    inputSchema: Workspace.extend({
      description: z.string().min(10).describe('What the agent should do, in plain language.'),
      model: z.string().optional(),
      toolIds: z.array(z.string()).optional(),
      knowledgeIds: z.array(z.string()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `${AGENTS_V2}/wizard/quick`,
        // The endpoint's DTO field is `description`; sending `prompt` fails validation.
        body: {
          description: input.description,
          model: input.model,
          toolIds: input.toolIds,
          knowledgeIds: input.knowledgeIds,
        },
        workspaceId: input.workspaceId,
        retries: 0,
        timeoutMs: 300_000,
      }),
  },
  {
    name: 'swfte_agents_wizard_templates',
    title: 'List agent templates',
    readOnly: true,
    description: 'List the agent templates the wizard can start from.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `${AGENTS_V2}/wizard/templates`,
        workspaceId: input.workspaceId,
        retries: 1,
      }),
  },
  {
    name: 'swfte_agents_find',
    title: 'Find existing agents by name/type/capability',
    description:
      'Search agents with richer filters than swfte_agents_list (name substring, agent type, and per-channel capability flags). Use this to pick a real agentId for a journey\'s AGENT_OBJECTIVE segment instead of creating a new agent — agent creation can be blocked by billing/tier caps in some workspaces.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(1).optional().describe('1-based page number.'),
      size: z.number().int().min(1).max(100).optional(),
      name: z.string().optional().describe('Substring match against agentName.'),
      type: z.string().optional(),
      hasVoice: z.boolean().optional(),
      hasSms: z.boolean().optional(),
      hasTelegram: z.boolean().optional(),
      hasWhatsapp: z.boolean().optional(),
      hasTwilio: z.boolean().optional(),
      hasA2A: z.boolean().optional(),
      marketplaceOnly: z.boolean().optional(),
      hasSafetyGuards: z.boolean().optional(),
      hasCostBudget: z.boolean().optional(),
      sortBy: z.enum(['modifiedDate', 'creationDate', 'agentName']).optional(),
      sortOrder: z.enum(['asc', 'desc']).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v1/agents',
        query: {
          page: input.page,
          size: input.size,
          name: input.name,
          type: input.type,
          hasVoice: input.hasVoice,
          hasSms: input.hasSms,
          hasTelegram: input.hasTelegram,
          hasWhatsapp: input.hasWhatsapp,
          hasTwilio: input.hasTwilio,
          hasA2A: input.hasA2A,
          marketplaceOnly: input.marketplaceOnly,
          hasSafetyGuards: input.hasSafetyGuards,
          hasCostBudget: input.hasCostBudget,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
        },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_types',
    title: 'List agent types and providers',
    readOnly: true,
    description: 'The agent types and model providers available for building agents.',
    inputSchema: Workspace,
    execute: async (input, { client }) => {
      const [types, providers] = await Promise.all([
        client.request({ method: 'GET', path: `${AGENTS_V2}/wizard/agent-types`, workspaceId: input.workspaceId, retries: 1 }),
        client.request({ method: 'GET', path: `${AGENTS_V2}/wizard/providers`, workspaceId: input.workspaceId, retries: 1 }),
      ]);
      return { agentTypes: types, providers };
    },
  },
];
