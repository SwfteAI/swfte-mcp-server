import type { Request, Response } from 'express';
import { invokeContentPipeline } from '../swfte/content-pipeline';

/** POST /admin/drafts — editors draft multi-topic round-ups (Content pipeline pinned to v4: `topics`). */
export async function createDraft(req: Request, res: Response): Promise<void> {
  const { sources, topics } = req.body as { sources: string[]; topics: string[] };
  const result = await invokeContentPipeline({ sources, topics });
  res.json({ articles: result.output?.articles ?? [] });
}

/** POST /admin/drafts/regenerate — shorter re-draft of the same round-up. */
export async function regenerate(req: Request, res: Response): Promise<void> {
  const { sources, topics } = req.body as { sources: string[]; topics: string[] };
  const result = await invokeContentPipeline({ sources, topics, maxWords: 250 });
  res.json({ runId: result.output?.runId ?? null });
}
