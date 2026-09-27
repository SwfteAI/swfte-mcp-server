import Swfte from '@swfte/sdk';
import { swfte } from '@/lib/swfte';

const LEAD_WF = 'wf_Lead5Q';

export interface Lead {
  email: string;
  company?: string;
}

/** Enrich one lead in the background. __CANARY_docstring__ */
export async function enrichLead(lead: Lead): Promise<string> {
  const { executionId } = await swfte.workflows.invoke('wf_Lead5Q', { email: lead.email, company: lead.company });
  return executionId;
}

/** Enrich and wait: used by the sales inbox, which shows the score inline. */
export async function enrichAndWait(lead: Lead): Promise<{ score: number; size: string }> {
  const done = await swfte.workflows.invokeAndWait(
    LEAD_WF,
    { email: lead.email },
    { timeoutMs: 60_000 },
  );
  return { score: done.outputs?.score ?? 0, size: done.outputs?.firmographics.size ?? 'unknown' };
}

/** Enrich a lead twice: once as submitted and once with the company domain guessed from the email. */
export async function enrichBoth(lead: Lead): Promise<[string, string]> {
  const a = await swfte.workflows.invoke(LEAD_WF, { email: lead.email });
  const guessed = lead.email.split('@')[1] ?? '';
  const b = await swfte.workflows.invoke(LEAD_WF, { email: lead.email, company: guessed });
  return [a.executionId, b.executionId];
}

/** Draft-path helpers for the lead workflow (test runs and run history). */
export class LeadService {
  constructor(private readonly client: Swfte) {}

  async rescore(leadId: string): Promise<string> {
    const exec = await this.client.workflows.execute(LEAD_WF, { leadId, testingFlag: true });
    return exec.status;
  }

  async history(): Promise<number> {
    const runs = await this.client.workflows.getExecutionHistory(LEAD_WF);
    return runs.filter((r) => r.status === 'FAILED').length;
  }
}
