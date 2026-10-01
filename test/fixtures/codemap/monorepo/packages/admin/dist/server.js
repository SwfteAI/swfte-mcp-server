// tsc output of src/ (stale build checked in by the old deploy script).
import { invokeContentPipeline } from "./swfte/content-pipeline.js";
export async function createDraft(req, res) {
    const result = await invokeContentPipeline({ sources: req.body.sources, topics: req.body.topics });
    res.json({ articles: result.output?.articles ?? [] });
}
