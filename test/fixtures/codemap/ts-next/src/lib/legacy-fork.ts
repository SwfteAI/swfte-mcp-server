// Before @swfte/sdk 1.0 we maintained a fork; the translation queue still uses it.
// It is not a Swfte package and is not listed in swfte.json.
import { ForkClient } from '@acme/swfte-fork';

const fork = new ForkClient({ token: process.env.SWFTE_API_KEY ?? '', host: 'https://swfte-proxy.acme.internal' });

export async function queueTranslation(articleId: string): Promise<string> {
  const { executionId } = await fork.workflows.invoke('wf_8K2mQ4', { sources: [articleId], topic: 'translate' });
  return executionId;
}

export async function forkPing(): Promise<string> {
  return (await fork.agents.chat('ag_Supp9x', 'ping')).response;
}
