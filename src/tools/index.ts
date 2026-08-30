import type { ToolDefinition, ToolGroup } from './_types.js';

// Task-shaped tools — the reason this server exists.
import { whoamiTools } from './whoami.js';
import { shipTools } from './ship.js';
import { verifyTools } from './verify.js';
import { solutionTools } from './solution.js';
import { codeTools } from './code.js';

// Domain tools.
import { agentTools } from './agents.js';
import { chatFlowTools } from './chatflows.js';
import { workflowTools } from './workflows.js';
import { conversationTools } from './conversations.js';
import { datasetTools } from './datasets.js';
import { fileTools } from './files.js';
import { ragTools } from './rag.js';
import { mcpTools } from './mcp.js';
import { moduleTools } from './modules.js';
import { marketplaceTools } from './marketplace.js';
import { voiceTools } from './voice.js';
import { auditTools } from './audit.js';
import { costControlTools } from './cost-control.js';
import { analyticsTools } from './analytics.js';
import { experimentTools } from './experiments.js';
import { connectTools } from './connect.js';
import { deploymentTools } from './deployments.js';

/**
 * Tag a whole module's tools with a group, so `SWFTE_TOOLS` can trim them
 * without every tool file having to repeat the label. An explicit `group` on an
 * individual tool wins.
 */
const tag = (group: ToolGroup, tools: ToolDefinition[]): ToolDefinition[] =>
  tools.map((t) => ({ ...t, group: t.group ?? group }));

export const allTools: ToolDefinition[] = [
  ...whoamiTools,
  ...shipTools,
  ...verifyTools,
  ...solutionTools,

  ...tag('agents', agentTools),
  ...tag('chatflows', chatFlowTools),
  ...tag('workflows', workflowTools),
  ...tag('workflows', codeTools),
  ...tag('conversations', conversationTools),
  ...tag('datasets', datasetTools),
  ...tag('files', fileTools),
  ...tag('rag', ragTools),
  ...tag('mcp', mcpTools),
  ...tag('modules', moduleTools),
  ...tag('marketplace', marketplaceTools),
  ...tag('voice', voiceTools),
  ...tag('audit', auditTools),
  ...tag('cost', costControlTools),
  ...tag('analytics', analyticsTools),
  ...tag('experiments', experimentTools),
  ...tag('connect', connectTools),
  ...tag('deployments', deploymentTools),
];

export type { ToolDefinition, ToolContext } from './_types.js';
