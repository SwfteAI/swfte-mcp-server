'use server';

import { chatSupportAgent } from '@/swfte/support-agent';

interface Ticket {
  summary: string;
  thread?: string;
  customerId: string;
}

/** Escalate a ticket into the support agent's conversation with that customer. */
export async function escalate(ticket: Ticket): Promise<string | null> {
  const res = await chatSupportAgent({ message: ticket.summary, conversationId: ticket.thread }, { userId: ticket.customerId });
  return res.output?.conversationId ?? null;
}
