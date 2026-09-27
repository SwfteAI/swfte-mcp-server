import { invokeContentPipeline, type ContentPipelineInput } from '../swfte/content-pipeline';

interface QueuedJob {
  id: string;
  input: ContentPipelineInput;
}

/** Retry drafts whose first run failed; the stored input is replayed as-is. */
export async function retryFailed(jobs: QueuedJob[]): Promise<number> {
  let ok = 0;
  for (const job of jobs) {
    const result = await invokeContentPipeline({ ...job.input });
    if (result.ok) ok += 1;
  }
  return ok;
}
