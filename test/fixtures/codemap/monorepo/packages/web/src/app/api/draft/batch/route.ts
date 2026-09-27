import { NextRequest, NextResponse } from 'next/server';
import { invokeContentPipeline } from '../../../../swfte/content-pipeline';

/** POST /api/draft/batch — one short draft per topic, sequentially (rate limits). */
export async function POST(req: NextRequest) {
  const { sources, topics } = (await req.json()) as { sources: string[]; topics: string[] };
  const runIds: string[] = [];
  for (const topic of topics) {
    const r = await invokeContentPipeline({
      sources,
      topic,
      maxWords: 300,
    });
    runIds.push(r.output?.runId ?? '');
  }
  return NextResponse.json({ runIds });
}
