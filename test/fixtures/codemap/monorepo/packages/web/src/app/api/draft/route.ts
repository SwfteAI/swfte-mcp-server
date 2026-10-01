import { NextRequest, NextResponse } from 'next/server';
import { invokeContentPipeline } from '../../../swfte/content-pipeline';

/** POST /api/draft — the marketing site's draft button (Content pipeline, pinned to v3). */
export async function POST(req: NextRequest) {
  const { sources, topic } = (await req.json()) as { sources: string[]; topic: string };
  const res = await invokeContentPipeline({ sources, topic });
  return NextResponse.json({ articles: res.output?.articles ?? [] });
}
