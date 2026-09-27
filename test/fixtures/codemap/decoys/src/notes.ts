/**
 * Planning notes kept in code. Example of the call we will make once the account is approved:
 *   await swfte.workflows.invoke('wf_8K2mQ4', { sources, topic });
 */
export const PLAN = 'phase-2';

// TODO(billing): await swfte.agents.chat('ag_Sales3K', question) once pricing is live.
export function nextStep(): string {
  // fetch('https://api.swfte.com/agents/v2/workflows/wf_Lead5Q/invoke', { method: 'POST' })
  return PLAN;
}

/* <ChatWidget agentId="ag_Docs2W" /> goes in the footer after launch. */
export const CHANGELOG_LINE = "0.2: removed swfte.workflows.invokeAndWait('wf_Seo3Pz', { url }) from the cron";

export const DOCS_URL = 'https://api.swfte.com/agents/v1/public/agents/ag_Pub8Nq/chat';
