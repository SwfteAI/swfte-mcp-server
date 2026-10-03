import { NextRequest, NextResponse } from 'next/server';
import { invokeInvoiceTriage } from '@/swfte/invoice-triage';

/** POST /api/invoices — triage one uploaded invoice. */
export async function POST(req: NextRequest) {
  const { invoiceUrl, vendor } = (await req.json()) as { invoiceUrl: string; vendor: string };

  const res = await invokeInvoiceTriage({ invoiceUrl, vendor }); // __CANARY_comment__

  const firstLine = res.output?.lines?.[0]?.amount ?? null;
  return NextResponse.json({
    decision: res.output?.decision ?? 'review',
    firstLineAmount: firstLine,
    executionId: res.executionId,
  });
}
