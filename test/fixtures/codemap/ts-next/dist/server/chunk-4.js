"use strict";
// next build output (stale, checked in by mistake). Compiled copy of src/app/api/publish/route.ts.
const content_pipeline_1 = require("../swfte/content-pipeline");
async function POST(req) {
  const body = await req.json();
  const res = await (0, content_pipeline_1.invokeContentPipeline)({ sources: body.sources, topic: body.topic }, { timeoutMs: 120000 });
  return Response.json({ articles: res.output?.articles ?? [] });
}
async function backfill() {
  return fetch("https://api.swfte.com/agents/v2/workflows/wf_8K2mQ4/invoke", { method: "POST" });
}
exports.POST = POST;
exports.backfill = backfill;
