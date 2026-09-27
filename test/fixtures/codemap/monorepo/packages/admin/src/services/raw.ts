// Admin tools that talk to the Swfte API without the SDK.
const SWFTE = 'https://api.swfte.com/agents';

/** Preview a round-up exactly as the pinned v4 runs it, bypassing the generated client's retries. */
export async function previewRoundup(sources: string[], topics: string[]): Promise<string | undefined> {
  const res = await fetch(`${SWFTE}/v2/workflows/wf_8K2mQ4/versions/4/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SWFTE_API_KEY ?? '' },
    body: JSON.stringify({ sources, topics, maxWords: 150 }),
  });
  const { executionId } = (await res.json()) as { executionId?: string };
  return executionId;
}

/** Re-run any workflow by id (ops tool; the id is typed into the admin console). */
export async function rerunWorkflow(workflowId: string, inputs: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${process.env.SWFTE_BASE_URL}/v2/workflows/${workflowId}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SWFTE_API_KEY ?? '' },
    body: JSON.stringify(inputs),
  });
  return res.status;
}

/** Pricing sanity check against the sales agent, run from the admin health page. */
export async function salesHealth(): Promise<boolean> {
  const res = await fetch('https://api.swfte.com/agents/v1/agents/ag_Sales3K/chat/admin-health', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SWFTE_API_KEY ?? '' },
    body: JSON.stringify({ message: 'What is the Pro plan price?' }),
  });
  return res.ok;
}
