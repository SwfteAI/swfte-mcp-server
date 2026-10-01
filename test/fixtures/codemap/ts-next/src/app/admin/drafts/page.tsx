import { swfte } from '@/lib/swfte';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: 'Ready',
  SUCCEEDED: 'Ready',
  RUNNING: 'Drafting',
  FAILED: 'Failed',
};

/** Admin view of recent Content pipeline runs: status only, never the drafted text. */
export default async function DraftsPage() {
  const runs = await swfte.workflows.getExecutionHistory('wf_8K2mQ4');
  const recent = runs.slice(0, 25);

  return (
    <main className="drafts">
      <h1>Recent drafts</h1>
      <table>
        <tbody>
          {recent.map((run) => (
            <tr key={run.id}>
              <td>{run.id}</td>
              <td>{STATUS_LABEL[run.status] ?? run.status}</td>
              <td>{run.startedAt ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
