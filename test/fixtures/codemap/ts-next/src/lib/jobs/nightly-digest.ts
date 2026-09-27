import type { WorkflowExecutionStatus } from '@swfte/sdk';
import { swfte } from '@/lib/swfte';
import { recordDigest } from '@/lib/jobs/digest-store';

const DIGEST_DEFAULTS = {
  sources: ['https://acme.test/changelog', 'https://acme.test/blog'],
  topic: 'What shipped this week',
};

/**
 * Nightly cron: drafts the weekly digest. Overrides come from the ops dashboard
 * (maxWords, a different topic) and are merged over the defaults.
 */
export async function runNightlyDigest(overrides: Record<string, unknown> = {}) {
  const done = await swfte.workflows.invokeAndWait('wf_8K2mQ4', { ...DIGEST_DEFAULTS, ...overrides }, { timeoutMs: 600_000 });
  await recordDigest(done);
  return done.status;
}

/** Same cron window: refresh the SEO audit of the marketing site. */
export async function runNightlySeoAudit(): Promise<number> {
  const audit: WorkflowExecutionStatus = await swfte.workflows.invokeAndWait(
    'wf_Seo3Pz',
    { url: 'https://acme.test', depth: 2 },
    { timeoutMs: 900_000, pollIntervalMs: 10_000 },
  );
  const issues: unknown[] = audit.outputs?.issues ?? [];
  return issues.length;
}
