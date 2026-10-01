import { NextRequest, NextResponse } from 'next/server';
import { swfte } from '@/lib/swfte';

/** GET /api/invoices/:id — the status of the triage run for one invoice. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runs = await swfte.workflows.getExecutionHistory('wf_Inv7Tr2');
  const run = runs.find((r) => r.executionId === id || r.id === id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ id: run.id, status: run.status, completedAt: run.completedAt ?? null });
}
