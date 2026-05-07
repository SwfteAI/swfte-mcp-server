import type { ToolDefinition } from './_types.js';
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

export const allTools: ToolDefinition[] = [
  ...agentTools,
  ...chatFlowTools,
  ...workflowTools,
  ...conversationTools,
  ...datasetTools,
  ...fileTools,
  ...ragTools,
  ...mcpTools,
  ...moduleTools,
  ...marketplaceTools,
  ...voiceTools,
  ...auditTools,
  ...costControlTools,
];

export type { ToolDefinition, ToolContext } from './_types.js';
