import { NextRequest, NextResponse } from 'next/server';
import { swfte } from '@/lib/swfte';

/** POST /api/leads — the marketing site's form posts the raw form fields here. */
export async function POST(req: NextRequest) {
  const fields = (await req.json()) as Record<string, string>;
  const { executionId } = await swfte.workflows.invoke('wf_Lead5Q', { ...fields, source: 'website' });
  return NextResponse.json({ queued: true, executionId }, { status: 202 });
}
