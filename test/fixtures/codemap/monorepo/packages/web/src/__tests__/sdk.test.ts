import { expect, it, vi } from 'vitest';

vi.mock('@swfte/sdk', () => ({
  default: class {
    workflows = { invoke: vi.fn(async () => ({ executionId: 'exec_42' })) };
  },
}));

it('queues a draft', async () => {
  const { default: Swfte } = await import('@swfte/sdk');
  const mock = new Swfte({ apiKey: 'test' });
  await expect(mock.workflows.invoke('wf_8K2mQ4', { sources: [], topic: 't' })).resolves.toEqual({ executionId: 'exec_42' });
});
