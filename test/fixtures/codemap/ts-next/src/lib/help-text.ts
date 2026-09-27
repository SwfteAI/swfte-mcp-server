// Copy for the in-app developer help panel. Strings only: nothing here calls Swfte.

export const HELP_PUBLISH =
  "To publish from your own backend, call client.workflows.invoke('wf_8K2mQ4', { sources, topic }).";

export const HELP_RAW =
  'Without the SDK: POST https://api.swfte.com/agents/v2/workflows/wf_8K2mQ4/invoke with your API key.';

export function logPlannedCall(topic: string): void {
  // Old approach, removed in 0.3: await swfte.workflows.invoke('wf_8K2mQ4', { sources: [], topic });
  console.info(`would draft "${topic}" via https://api.swfte.com/agents/v2/workflows/wf_Seo3Pz/invoke`);
}
