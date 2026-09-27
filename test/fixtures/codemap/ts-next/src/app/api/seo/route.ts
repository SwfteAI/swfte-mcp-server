import { NextRequest, NextResponse } from 'next/server';
import { swfte } from '@/lib/swfte';

/** GET /api/seo?url=… — on-demand SEO audit of one page. */
export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('url');
  if (!target) return NextResponse.json({ error: 'url required' }, { status: 400 });

  const { outputs, status } = await swfte.workflows.invokeAndWait('wf_Seo3Pz', { url: target }, { timeoutMs: 90_000 });
  const { issues, score } = outputs ?? {};
  return NextResponse.json({ status, score: score ?? null, issueCount: (issues ?? []).length });
}
