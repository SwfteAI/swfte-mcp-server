import { swfte } from '@/lib/swfte';

/**
 * Hand a stuck conversation to the escalation agent. Which agent that is differs per
 * environment (staging uses a sandbox copy), so the id comes from the environment.
 */
export async function escalateToAgent(summary: string, customerId: string): Promise<string> {
  const reply = await swfte.agents.chat(process.env.SWFTE_SUPPORT_AGENT_ID ?? '', summary, { userId: customerId });
  return reply.response;
}
