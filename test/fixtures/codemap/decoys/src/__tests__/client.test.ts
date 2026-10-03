import { it, vi } from 'vitest';

const swfte = { workflows: { invoke: vi.fn() }, agents: { chat: vi.fn() } };

it('mocks the SDK', async () => {
  await swfte.workflows.invoke('wf_8K2mQ4', { sources: [], topic: 't' });
  await swfte.agents.chat('ag_Supp9x', 'hi');
});
