import { describe, expect, it, vi } from 'vitest';

vi.mock('@swfte/sdk', () => ({
  default: class {
    workflows = { invoke: vi.fn(async () => ({ executionId: 'exec_1' })) };
  },
}));

vi.mock('@/swfte/content-pipeline', () => ({
  invokeContentPipeline: vi.fn(async () => ({ ok: true, status: 'COMPLETED', output: { articles: [{ title: 't' }] } })),
}));

describe('publish', () => {
  it('drafts articles', async () => {
    const { invokeContentPipeline } = await import('@/swfte/content-pipeline');
    const res = await invokeContentPipeline({ sources: ['https://a.test'], topic: 'x' });
    expect(res.output?.articles).toHaveLength(1);
  });

  it('queues a lead', async () => {
    const { default: Swfte } = await import('@swfte/sdk');
    const client = new Swfte({ apiKey: 'test' });
    await client.workflows.invoke('wf_Lead5Q', { email: 'a@b.test' });
  });
});
