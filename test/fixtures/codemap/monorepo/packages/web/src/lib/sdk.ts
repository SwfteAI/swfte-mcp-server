import Swfte from '@swfte/sdk';

const swfte = new Swfte({ apiKey: process.env.SWFTE_API_KEY ?? '' });

/** Queue a draft without waiting (the CMS polls the run itself). */
export async function queueDraft(topic: string): Promise<string> {
  const { executionId } = await swfte.workflows.invoke('wf_8K2mQ4', { sources: ['https://acme.test/news'], topic });
  return executionId;
}

/** Marketing dashboard tile: how many drafts ran today. */
export async function draftsToday(): Promise<number> {
  const runs = await swfte.workflows.getExecutionHistory('wf_8K2mQ4');
  const today = new Date().toISOString().slice(0, 10);
  return runs.filter((r) => (r.startedAt ?? '').startsWith(today)).length;
}

export async function supportReply(message: string, visitor: string): Promise<string> {
  const reply = await swfte.agents.chat('ag_Supp9x', message, { userId: visitor });
  return reply.response;
}

export async function scoreLead(email: string): Promise<number> {
  const done = await swfte.workflows.invokeAndWait('wf_Lead5Q', { email }, { timeoutMs: 45_000 });
  return done.outputs?.score ?? 0;
}

/** Draft-path test run of the regional variant; its id is set per deployment. */
export async function testRegionalDraft(topic: string): Promise<string> {
  const run = await swfte.workflows.invoke(process.env.SWFTE_CONTENT_WORKFLOW_ID ?? '', { sources: [], topic });
  return run.executionId;
}

export async function rerunInvoiceDraft(invoiceUrl: string): Promise<string> {
  const exec = await swfte.workflows.execute('wf_Inv7Tr2', { invoiceUrl, vendor: 'web-upload', testingFlag: true });
  return exec.status;
}

export async function onboardingBacklog(): Promise<number> {
  const open = await swfte.chatflows.listSessions('cf_Onb7Rz', { status: 'ACTIVE' });
  return open.length;
}
