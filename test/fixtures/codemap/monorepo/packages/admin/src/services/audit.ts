import { Swfte } from '@swfte/sdk';
import { config } from '../config/index';

const client = new Swfte({ apiKey: process.env.SWFTE_API_KEY ?? '__CANARY_swfte__' });

export class AuditService {
  /** Failed Content pipeline runs in the last page of history. */
  async failedDrafts(): Promise<number> {
    const runs = await client.workflows.getExecutionHistory('wf_8K2mQ4');
    return runs.filter((r) => r.status === 'FAILED').length;
  }

  /** Runs of whatever workflow the config service says is under audit. */
  async auditedRuns(): Promise<number> {
    const runs = await client.workflows.getExecutionHistory(config.workflowId);
    return runs.length;
  }

  async explainPricing(question: string): Promise<string> {
    const reply = await client.agents.chat('ag_Sales3K', question, { userId: 'admin-console' });
    return reply.response;
  }

  async dryRunInvoice(invoiceUrl: string): Promise<string> {
    const exec = await client.workflows.execute('wf_Inv7Tr2', { invoiceUrl, vendor: 'audit', testingFlag: true });
    return exec.status;
  }

  async onboardAdmin(): Promise<string> {
    const session = await client.chatflows.startSession('cf_Onb7Rz');
    return session.id;
  }

  async auditSite(url: string): Promise<string[]> {
    const done = await client.workflows.invokeAndWait('wf_Seo3Pz', { url });
    return (done.outputs?.issues ?? []).map((i: { code: string }) => i.code);
  }
}
