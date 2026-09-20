import type { ToolDefinition, ToolGroup } from './_types.js';

// Task-shaped tools — the reason this server exists.
import { guidanceTools } from './guidance.js';
import { whoamiTools } from './whoami.js';
import { shipTools } from './ship.js';
import { verifyTools } from './verify.js';
import { preflightTools } from './preflight.js';
import { solutionTools } from './solution.js';
import { orchestrateTools } from './orchestrate.js';
import { codeTools } from './code.js';

// Domain tools.
import { widgetTools } from './widgets.js';
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
import { solutionPublishTools } from './solution-publish.js';
import { voiceTools } from './voice.js';
import { auditTools } from './audit.js';
import { costControlTools } from './cost-control.js';
import { analyticsTools } from './analytics.js';
import { experimentTools } from './experiments.js';
import { connectTools } from './connect.js';
import { deploymentTools } from './deployments.js';
import { agentMailTools } from './agent-mail.js';
import { appWizardTools } from './app-wizard.js';
import { customNodeWizardTools } from './custom-node-wizard.js';
import { journeyTools } from './journeys.js';
import { relayRunTools } from './relay-runs.js';
import { relayMailboxTools } from './relay-mailboxes.js';

/**
 * Tag a whole module's tools with a group, so `SWFTE_TOOLS` can trim them
 * without every tool file having to repeat the label. An explicit `group` on an
 * individual tool wins.
 */
const tag = (group: ToolGroup, tools: ToolDefinition[]): ToolDefinition[] =>
  tools.map((t) => ({ ...t, group: t.group ?? group }));

export const allTools: ToolDefinition[] = [
  ...guidanceTools(() => allTools),
  ...whoamiTools,
  ...shipTools,
  ...verifyTools,
  ...preflightTools,
  ...solutionTools,
  ...orchestrateTools,
  ...tag('apps', appWizardTools),
  ...tag('custom-nodes', customNodeWizardTools),

  ...tag('widgets', widgetTools),
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
  ...tag('marketplace', solutionPublishTools),
  ...tag('voice', voiceTools),
  ...tag('audit', auditTools),
  ...tag('cost', costControlTools),
  ...tag('analytics', analyticsTools),
  ...tag('experiments', experimentTools),
  ...tag('connect', connectTools),
  ...tag('deployments', deploymentTools),
  ...tag('agent-mail', agentMailTools),

  // Grouped rather than left untagged so SWFTE_TOOLS can trim them like
  // everything else — an untagged tool is advertised unconditionally.
  ...tag('journeys', journeyTools),
  ...tag('relay', relayRunTools),
  ...tag('relay', relayMailboxTools),
];

export type { ToolDefinition, ToolContext } from './_types.js';
