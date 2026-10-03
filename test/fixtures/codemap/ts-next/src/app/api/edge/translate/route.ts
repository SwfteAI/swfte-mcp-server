// Edge route: translate a help-centre answer with the public translator agent.
// Runs on the edge runtime, so it uses the public endpoint + publishable embed key (no SDK, no API key).
export const runtime = 'edge';

const PUBLIC_CHAT = 'https://api.swfte.com/agents/v1/public/agents/ag_Pub8Nq/chat';

export async function POST(req: Request): Promise<Response> {
  const { text, visitorId } = (await req.json()) as { text: string; visitorId: string };
  const upstream = await fetch(PUBLIC_CHAT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Swfte-Embed-Key': process.env.SWFTE_EMBED_KEY ?? '' },
    body: JSON.stringify({ message: `Translate to German: ${text}`, visitorId }),
  });
  const body = (await upstream.json()) as { content?: string; response?: string };
  return Response.json({ translated: body.content ?? body.response ?? '' });
}
