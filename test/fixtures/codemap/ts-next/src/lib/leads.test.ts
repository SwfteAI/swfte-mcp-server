import { expect, it, vi } from 'vitest';
import { swfte } from '@/lib/swfte';
import { askSales } from '@/lib/sales';

it('asks the sales agent', async () => {
  const spy = vi.spyOn(swfte.agents, 'chat').mockResolvedValue({ response: 'hi', conversationId: null });
  await expect(askSales('price?')).resolves.toBe('hi');
  await swfte.agents.chat('ag_Sales3K', 'direct call inside a test');
  expect(spy).toHaveBeenCalledTimes(2);
});
