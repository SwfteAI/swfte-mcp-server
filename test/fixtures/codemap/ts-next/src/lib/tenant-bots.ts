import { db } from '@/lib/db';
import { swfte } from '@/lib/swfte';

/** Each tenant brings its own agent; the mapping lives in the tenant_bots table. */
export async function tenantReply(tenantId: string, text: string, userId: string): Promise<string> {
  const row = await db.tenantBot.findUnique({ tenantId });
  if (!row) throw new Error(`no bot configured for tenant ${tenantId}`);
  const reply = await swfte.agents.chat(row.agentId, text, { userId });
  return reply.response;
}
