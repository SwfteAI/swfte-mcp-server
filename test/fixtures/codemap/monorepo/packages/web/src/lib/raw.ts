import axios from 'axios';

// Partner feed importer: calls the pinned v3 invoke directly because it runs inside the partner's Lambda.
export async function importPartnerFeed(sources: string[], topic: string): Promise<string> {
  const { data } = await axios.post(
    'https://api.swfte.com/agents/v2/workflows/wf_8K2mQ4/versions/3/invoke',
    { sources, topic },
    { headers: { 'X-API-Key': process.env.SWFTE_API_KEY ?? '' } },
  );
  return data.executionId;
}

/** Newsletter footer widget, proxied server-side. */
export async function footerWidget(question: string): Promise<unknown> {
  const res = await fetch(`https://api.swfte.com/agents/v1/widgets/wg_Help4M/public/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  return res.json();
}
