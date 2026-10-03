// The in-house fork of an old SDK. Its package name is not @swfte/sdk and swfte.json lists nothing.
import { ForkClient } from '@acme/swfte-fork';

const fork = new ForkClient({ token: 'from-vault', host: 'https://swfte-proxy.acme.internal' });

export async function draft(topic: string) {
  return fork.workflows.invoke('wf_8K2mQ4', { sources: [], topic });
}

export async function ask(question: string) {
  return fork.agents.chat('ag_Supp9x', question);
}
