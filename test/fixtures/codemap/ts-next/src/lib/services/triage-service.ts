import { invokeInvoiceTriage, type InvokeResult, type InvoiceTriageOutput } from '@/swfte/invoice-triage';

type AuditSink = (result: InvokeResult<InvoiceTriageOutput>) => void;

/** Per-vendor triage with an audit trail (the audit sink stores the whole result). */
export class TriageService {
  constructor(
    private readonly vendor: string,
    private readonly audit: AuditSink,
  ) {}

  async run(url: string): Promise<boolean> {
    const result = await invokeInvoiceTriage({ invoiceUrl: url, vendor: this.vendor });
    this.audit(result);
    return result.ok;
  }
}
