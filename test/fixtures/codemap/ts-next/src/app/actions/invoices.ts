'use server';

import { invokeInvoiceTriage as runTriage } from '@/swfte/invoice-triage';

/** Server action behind the "Triage" button on the invoice inbox. */
export async function triageInvoice(formData: FormData): Promise<number> {
  const payload = {
    invoiceUrl: String(formData.get('url') ?? ''),
    vendor: String(formData.get('vendor') ?? 'unknown'),
  };
  const { output } = await runTriage(payload);
  return output?.confidence ?? 0;
}
