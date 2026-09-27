// SEO audit triggers used by the CMS publish hook. Plain fetch: this module also runs in the CMS worker,
// which cannot bundle @swfte/sdk.

export async function auditOnPublish(pageUrl: string): Promise<string | null> {
  const res = await fetch('https://api.swfte.com/agents/v2/workflows/wf_Seo3Pz/invoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.SWFTE_API_KEY ?? ''}`,
      'X-Trace-Tag': '__CANARY_header__',
    },
    body: JSON.stringify({ url: pageUrl, depth: 1 }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { executionId?: string };
  return data.executionId ?? null;
}

/** The regression audit stays on published version 2 until the new scoring is signed off. */
export async function regressionAudit(pageUrl: string): Promise<number> {
  const res = await fetch(`${process.env.SWFTE_BASE_URL}/v2/workflows/wf_Seo3Pz/versions/2/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SWFTE_API_KEY ?? '' },
    body: JSON.stringify({ url: pageUrl }),
  });
  return res.status;
}
