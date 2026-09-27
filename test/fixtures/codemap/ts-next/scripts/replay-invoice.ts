/**
 * Replay a triage request captured from production logs:
 *   npx tsx scripts/replay-invoice.ts '{"invoiceUrl":"s3://…","vendor":"Globex"}'
 */
import { invokeInvoiceTriage, type InvoiceTriageInput } from '../src/swfte/invoice-triage';

async function replay(raw: string) {
  const captured = JSON.parse(raw) as InvoiceTriageInput;
  const res = await invokeInvoiceTriage(captured);
  console.log(res.status, res.output?.decision, res.output?.confidence);
}

replay(process.argv[2] ?? '{}').catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
