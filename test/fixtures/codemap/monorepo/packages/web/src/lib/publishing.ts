import { invokeContentPipeline, type ContentPipelineInput } from '../swfte/content-pipeline';

/** Publishing façade used by the CMS plugin. */
export class Publisher {
  async publish(sources: string[], topic: string): Promise<{ count: number; state: string }> {
    const res = await invokeContentPipeline({ sources, topic });
    const out = res.output;
    const articles = out?.articles ?? [];
    return { count: articles.length, state: out?.status ?? 'unknown' };
  }
}

/** Thin pass-through for callers that already built the input. */
export async function draftFrom(input: ContentPipelineInput): Promise<boolean> {
  const res = await invokeContentPipeline(input);
  return res.ok;
}
