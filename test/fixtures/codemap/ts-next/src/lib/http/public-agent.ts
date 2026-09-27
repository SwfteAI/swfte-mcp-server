import { settings } from '@/config/settings';

const SWFTE = process.env.SWFTE_BASE_URL ?? 'https://api.swfte.com/agents';

/** Anonymous visitor chat through the public endpoint of whichever agent the settings service names. */
export async function publicChat(message: string, visitorId: string): Promise<string> {
  const res = await fetch(`${SWFTE}/v1/public/agents/${settings.publicAgentId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Swfte-Embed-Key': settings.embedKey },
    body: JSON.stringify({ message, visitorId }),
  });
  const body = (await res.json()) as { content?: string };
  return body.content ?? '';
}
