/**
 * A deployed workflow can be READY and useless. Until these tools existed the
 * server could report that a workflow shipped but nothing about how it behaves
 * once live — no success rate, no failing node, no per-run cost — while the
 * backend had all of it. These pin the two things that make that wiring real:
 * each tool asks the backend the path it claims to, and each one is actually
 * advertised in a stock install rather than hidden behind SWFTE_TOOLS.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { selectTools } from '../src/server.js';
import { workflowTools } from '../src/tools/workflows.js';

const OBSERVABILITY_TOOLS = [
  'swfte_workflows_executions',
  'swfte_workflows_execution_traces',
  'swfte_workflows_execution_status',
  'swfte_workflows_execution_cost',
  'swfte_workflows_stats',
];

/**
 * A client that answers exactly one path and throws on anything else, so a
 * wrong path cannot pass by silently reaching the network — the assertion is
 * on the request, never on a response shape we would be inventing anyway.
 */
function fakeClient(expectedPath: string) {
  const client = new SwfteClient(loadConfig({ SWFTE_PAT: 'pat_test' } as never));
  const seen: Array<{ method: string; path: string; headers?: unknown; workspaceId?: unknown }> = [];
  (client as any).request = async (opts: any) => {
    seen.push(opts);
    if (opts.path !== expectedPath) throw new Error(`unexpected request to ${opts.path}`);
    return { ok: true };
  };
  return { client, seen };
}

const tool = (name: string) => {
  const t = workflowTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
};

const call = async (name: string, input: unknown, expectedPath: string) => {
  const { client, seen } = fakeClient(expectedPath);
  await tool(name).execute(input as never, { client } as never);
  assert.equal(seen.length, 1);
  return seen[0]!;
};

describe('post-deploy observability tools hit the right endpoint', () => {
  test('execution history is per workflow', async () => {
    const req = await call('swfte_workflows_executions', { workflowId: 'wf-1' }, '/v2/workflows/wf-1/executions');
    assert.equal(req.method, 'GET');
  });

  test('traces, status and cost are addressed by executionId, not workflowId', async () => {
    // The three sit under /v2/workflows/executions/… rather than under the
    // workflow — passing a workflowId here would 404 on a live backend.
    await call('swfte_workflows_execution_traces', { executionId: 'ex-1' }, '/v2/workflows/executions/ex-1/traces');
    await call('swfte_workflows_execution_status', { executionId: 'ex-1' }, '/v2/workflows/executions/ex-1/status');
    await call('swfte_workflows_execution_cost', { executionId: 'ex-1' }, '/v2/workflows/executions/ex-1/billing');
  });

  test('stats is workspace-wide and takes no input', async () => {
    const req = await call('swfte_workflows_stats', {}, '/v2/workflows/stats');
    assert.equal(req.method, 'GET');
  });

  test('ids are URL-encoded into the path', async () => {
    // Execution ids are opaque; one carrying a slash would otherwise silently
    // rewrite the route and hit a different endpoint entirely.
    await call('swfte_workflows_executions', { workflowId: 'wf/1 a' }, '/v2/workflows/wf%2F1%20a/executions');
    await call(
      'swfte_workflows_execution_traces',
      { executionId: 'ex/1 a' },
      '/v2/workflows/executions/ex%2F1%20a/traces'
    );
  });

  test('no tool hand-sets a tenant header', async () => {
    // A PAT carries its own trusted workspace binding; setting one ourselves
    // breaks the authority model rather than helping (src/config.ts).
    for (const name of OBSERVABILITY_TOOLS) {
      const t = tool(name);
      const { client, seen } = fakeClient('*');
      (client as any).request = async (opts: any) => {
        seen.push(opts);
        return {};
      };
      await t.execute(
        ({ workflowId: 'w', executionId: 'e' } as never),
        { client } as never
      );
      assert.equal(seen[0]!.workspaceId, undefined, name);
      assert.equal((seen[0]!.headers as any)?.['X-Workspace-Id'], undefined, name);
    }
  });
});

describe('the observability tools are reachable', () => {
  test('all five are advertised in a stock install', () => {
    // Hidden behind SWFTE_TOOLS they would answer a question nobody can ask:
    // the whole point is the agent reaching for them unprompted after a deploy.
    const names = selectTools(allTools, loadConfig({ SWFTE_PAT: 'pat_test' } as never)).map((t) => t.name);
    for (const name of OBSERVABILITY_TOOLS) assert.ok(names.includes(name), `${name} not advertised`);
  });

  test('all five are read-only, so a client need not prompt', () => {
    for (const name of OBSERVABILITY_TOOLS) {
      assert.equal(allTools.find((t) => t.name === name)?.readOnly, true, name);
    }
  });

  test('they travel with the workflows group', () => {
    for (const name of OBSERVABILITY_TOOLS) {
      assert.equal(allTools.find((t) => t.name === name)?.group, 'workflows', name);
    }
  });
});

// Not covered: the response shapes. Traces, status and billing return whatever
// the backend hands back and these tools pass it through untouched, so a test
// would only assert that a fake echoes itself.
