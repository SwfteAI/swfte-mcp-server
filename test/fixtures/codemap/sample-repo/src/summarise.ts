import { invokeTicketSummary } from './swfte/ticket-summary';

/** Summarise a support ticket for the triage queue. */
export async function summariseTicket(ticketId: string, body: string): Promise<{ summary: string; priority: string }> {
  const res = await invokeTicketSummary({ ticketId, body });
  return { summary: res.output?.summary ?? '', priority: res.output?.priority ?? 'normal' };
}
