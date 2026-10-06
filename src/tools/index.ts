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
import { releaseTools } from './releases.js';
import { reviewTools } from './review.js';
import { reviewModeTools } from './review-mode.js';
import { connectTools } from './connect.js';
import { deploymentTools } from './deployments.js';
import { agentMailTools } from './agent-mail.js';
import { appWizardTools } from './app-wizard.js';
import { customNodeWizardTools } from './custom-node-wizard.js';
import { journeyTools } from './journeys.js';
import { relayRunTools } from './relay-runs.js';
import { relayMailboxTools } from './relay-mailboxes.js';
// Studio as source of truth: reuse-first, code bridge, approval-gated wiring.
import { catalogTools } from './catalog.js';
import { scaffoldTools } from './scaffold.js';
import { actionTools } from './actions.js';
import { wireTools } from './wire.js';
import { hubTools } from './hub.js';
import { complianceTools } from './compliance.js';
// Learning loop (brief 08): review-queue tools; the recipe book appends to the same module.
import { learningTools } from './learning.js';
import { simulationTools } from './simulations.js';
import { recipeTools } from './recipes.js';
import { codeMapTools } from './codemap.js';
import { provingVerdictTools } from './proving-source.js';
import { catalogProofTools } from './catalog-proof.js';
import { twinTools } from './twin.js';
import { setupTools } from './setup.js';
import { proveTools } from './prove.js';
import { selectedConfidenceReportTools } from './selected-confidence-report.js';
import { cloudLinkTools } from './cloud-link.js';
import { promotionTools } from './promotion.js';
import { runtimeExecTools } from './runtime-exec.js';
import { tourTools } from './tour.js';

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
  // `core` so no SWFTE_TOOLS filter hides them: reuse-before-build only works if
  // the reuse tools are always in front of the model.
  ...tag('core', catalogTools),
  ...tag('core', scaffoldTools),
  ...tag('core', actionTools),
  ...tag('core', wireTools),
  ...tag('core', hubTools),
  // Read-only deep link + step table for Studio's in-product Sandbox-first tour (no backend call).
  ...tag('core', tourTools),
  // Compliance control plane (CONTRACT rev 7): assess, scan code, evidence records.
  ...tag('core', complianceTools),
  ...tag('core', reviewTools),
  ...tag('review', reviewModeTools),
  ...tag('codemap', codeMapTools),
  ...tag('core', provingVerdictTools),
  ...tag('marketplace', catalogProofTools),
  ...tag('twins', twinTools),
  ...tag('runtime', setupTools),
  ...tag('runtime', proveTools),
  ...tag('runtime', selectedConfidenceReportTools),
  ...tag('runtime', cloudLinkTools),
  ...tag('runtime', promotionTools),
  ...tag('runtime', runtimeExecTools),
  // Learning loop (brief 08): report an outcome / propose a rule to the human review queue.
  ...tag('learning', learningTools),
  // Swfte Simulations: local spec check + /v2/simulations (no simulation logic here). Opt-in group.
  ...tag('simulations', simulationTools),
  ...tag('learning', recipeTools),
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
  ...tag('experiments', releaseTools),
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
