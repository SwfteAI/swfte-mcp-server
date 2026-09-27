import { default as SwfteSDK } from '@swfte/sdk';
import { swfte } from '@/lib/swfte';

/** Ask the sales agent a one-off question from the pricing page. */
export async function askSales(question: string): Promise<string> {
  const reply = await swfte.agents.chat('ag_Sales3K', question, { userId: 'pricing-page' });
  return reply.response;
}

/** Continue a sales conversation the visitor already started. */
export async function followUp(question: string, conversationId: string): Promise<string | null> {
  const reply = await swfte.agents.chat('ag_Sales3K', question, {
    userId: 'pricing-page',
    conversationId,
  });
  return reply.conversationId;
}

/** Health check used by the status page; the message is a fixed probe string. */
export async function ping(): Promise<boolean> {
  const reply = await swfte.agents.chat('ag_Sales3K', '__CANARY_literal__', { userId: 'healthcheck' });
  return reply.response.length > 0;
}

/** A second client bound to the EU workspace; only its agents resource is used. */
const eu = new SwfteSDK({ apiKey: process.env.SWFTE_API_KEY ?? '', apiBaseUrl: 'https://eu.api.swfte.com/agents' });
const { agents } = eu;

export async function askSalesEu(question: string): Promise<string> {
  const { response } = await agents.chat('ag_Sales3K', question);
  return response;
}

/** Object-literal handlers for the Slack bot. */
export const salesBot = {
  async reply(text: string): Promise<string> {
    return (await swfte.agents.chat('ag_Sales3K', text, { userId: 'slack' })).response;
  },
  async whoAmI(): Promise<string> {
    const agent = await swfte.agents.get('ag_Sales3K');
    return agent.name;
  },
};
