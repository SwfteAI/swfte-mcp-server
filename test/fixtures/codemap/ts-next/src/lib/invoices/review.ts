import { invokeInvoiceTriage, type InvoiceTriageInput } from '@/swfte/invoice-triage';

export interface ReviewLine {
  description: string;
  amount: number;
}

/** Re-run triage for a euro invoice a human flagged, and return its line items for review. */
export async function linesForReview(url: string, vendor: string): Promise<ReviewLine[]> {
  const input: InvoiceTriageInput = { invoiceUrl: url, vendor, currency: 'EUR' };
  const res = await invokeInvoiceTriage(input, {
    timeoutMs: 120_000,
  });
  return (res.output?.lines ?? []).map((l) => ({ description: l.description ?? '', amount: l.amount ?? 0 }));
}
