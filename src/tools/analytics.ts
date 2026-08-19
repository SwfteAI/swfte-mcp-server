import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Period = z
  .string()
  .optional()
  .describe('Reporting period, e.g. "7d", "30d", "current_month". Backend default applies when omitted.');

const Range = z.object({
  startDate: z.string().optional().describe('ISO date, inclusive.'),
  endDate: z.string().optional().describe('ISO date, inclusive.'),
});

export const analyticsTools: ToolDefinition[] = [
  {
    name: 'swfte_analytics_workspace_usage',
    title: 'Workspace usage',
    readOnly: true,
    description: 'Token, request, and execution volume for the workspace over a period.',
    inputSchema: z.object({ period: Period }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/v1/workspace-analytics/usage', query: { period: input.period }, retries: 1 }),
  },
  {
    name: 'swfte_analytics_workspace_costs',
    title: 'Workspace costs',
    readOnly: true,
    description: 'Spend for the workspace over a period, broken down by source.',
    inputSchema: z.object({ period: Period }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/v1/workspace-analytics/costs', query: { period: input.period }, retries: 1 }),
  },
  {
    name: 'swfte_analytics_workspace_models',
    title: 'Model mix',
    readOnly: true,
    description: 'Which models the workspace actually used, with volume and cost per model.',
    inputSchema: z.object({ period: Period }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/v1/workspace-analytics/models', query: { period: input.period }, retries: 1 }),
  },
  {
    name: 'swfte_analytics_timeseries',
    title: 'Usage timeseries',
    readOnly: true,
    description: 'Usage over time at a chosen granularity — for spotting when something changed.',
    inputSchema: Range.extend({
      granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v1/workspace-analytics/timeseries',
        query: { granularity: input.granularity, startDate: input.startDate, endDate: input.endDate },
        retries: 1,
      }),
  },
  {
    name: 'swfte_analytics_top_consumers',
    title: 'Top consumers',
    readOnly: true,
    description: 'The agents, workflows, and users driving the most usage. Start here when a bill jumps.',
    inputSchema: z.object({ period: Period, limit: z.number().int().min(1).max(100).optional() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v1/workspace-analytics/top-consumers',
        query: { period: input.period, limit: input.limit },
        retries: 1,
      }),
  },
  {
    name: 'swfte_analytics_agent',
    title: 'Agent analytics',
    readOnly: true,
    description: 'Per-agent volume, latency, cost, and error rate.',
    inputSchema: Range.extend({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v1/analytics/agents/${encodeURIComponent(input.agentId)}`,
        query: { startDate: input.startDate, endDate: input.endDate },
        retries: 1,
      }),
  },
  {
    name: 'swfte_analytics_agent_tools',
    title: 'Agent tool usage',
    readOnly: true,
    description:
      'Which tools an agent actually invoked, and how often. The direct way to confirm an agent is ' +
      'really calling its tools rather than describing them — a silent failure below capability tier AGENTIC.',
    inputSchema: Range.extend({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v1/analytics/agents/${encodeURIComponent(input.agentId)}/tools`,
        query: { startDate: input.startDate, endDate: input.endDate },
        retries: 1,
      }),
  },
  {
    name: 'swfte_analytics_agent_conversations',
    title: 'Agent conversation analytics',
    readOnly: true,
    description: 'Conversation-level metrics for an agent: turns, resolution, abandonment.',
    inputSchema: Range.extend({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v1/analytics/agents/${encodeURIComponent(input.agentId)}/conversations`,
        query: { startDate: input.startDate, endDate: input.endDate },
        retries: 1,
      }),
  },
  {
    name: 'swfte_analytics_agent_realtime',
    title: 'Agent realtime',
    readOnly: true,
    description: 'Live activity for an agent — in-flight conversations and recent throughput.',
    inputSchema: z.object({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v1/analytics/agents/${encodeURIComponent(input.agentId)}/realtime`,
        retries: 1,
      }),
  },
  {
    name: 'swfte_analytics_anomalies',
    title: 'Anomalies',
    readOnly: true,
    description: 'Detected usage or cost anomalies for the workspace.',
    inputSchema: z.object({ period: Period }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/v1/analytics/enterprise/anomalies', query: { period: input.period }, retries: 1 }),
  },
  {
    name: 'swfte_analytics_cost_analysis',
    title: 'Cost analysis',
    readOnly: true,
    description: 'Cost-optimisation analysis: where spend is going and what would reduce it.',
    inputSchema: z.object({ period: Period }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/v1/analytics/enterprise/cost-analysis', query: { period: input.period }, retries: 1 }),
  },
  {
    name: 'swfte_analytics_forecast',
    title: 'Usage forecast',
    readOnly: true,
    description: 'Projected usage and spend for the current period.',
    inputSchema: z.object({ period: Period }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/v1/analytics/enterprise/forecast', query: { period: input.period }, retries: 1 }),
  },
  {
    name: 'swfte_analytics_prompt_summary',
    title: 'Prompt patterns',
    readOnly: true,
    description: 'What users are actually asking an agent, clustered into patterns.',
    inputSchema: Range.extend({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v1/analytics/prompts/${encodeURIComponent(input.agentId)}/summary`,
        query: { startDate: input.startDate, endDate: input.endDate },
        retries: 1,
      }),
  },
];
