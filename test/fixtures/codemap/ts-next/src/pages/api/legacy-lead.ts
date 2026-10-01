// Pages-router endpoint kept for the old landing pages; new code uses /api/leads.
import { swfte } from '@/lib/swfte';

interface LegacyReq {
  body: { email?: string };
}
interface LegacyRes {
  status(code: number): { json(body: unknown): void };
}

export default async function (req: LegacyReq, res: LegacyRes) {
  if (!req.body.email) return res.status(400).json({ error: 'email required' });
  const run = await swfte.workflows.invoke('wf_Lead5Q', { email: req.body.email });
  return res.status(202).json({ executionId: run.executionId });
}
