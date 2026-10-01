import { NextRequest, NextResponse } from 'next/server';
import { invokeContentPipeline } from '@/swfte/content-pipeline';

interface PublishBody {
  sources?: string[];
  topic?: string;
}

/**
 * POST /api/publish — drafts articles for a topic and returns them to the editor.
 * The Content pipeline workflow does the research and writing.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as PublishBody;
  const sources = (body.sources ?? []).filter((s) => s.startsWith('https://'));
  const topic = (body.topic ?? '').trim();
  if (!sources.length || !topic) {
    return NextResponse.json({ error: 'sources and topic are required' }, { status: 400 });
  }

  const res = await invokeContentPipeline({ sources, topic }, { timeoutMs: 120_000 });
  if (!res.ok) {
    return NextResponse.json({ error: `pipeline ended ${res.status}` }, { status: 502 });
  }

  const articles = res.output?.articles ?? [];
  return NextResponse.json({ count: articles.length, articles });
}
