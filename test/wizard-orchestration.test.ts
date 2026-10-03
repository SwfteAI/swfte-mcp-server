/**
 * Actual swfte_solution_build through SDK MCP, actual SwfteClient HTTP,
 * actual orchestration, adapters, create and live-state verification.
 * All backend responses below are isolated local transport fixtures.
 * No fixture is a receipt of real model, validator, save or execution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { buildServer } from '../src/server.js';
import { orchestrateTools } from '../src/tools/orchestrate.js';

const SESSION = 'workflow_orchestration_fixture';
const CREATED = 'fixture_created_workflow';
const SAVED = 'fixture_saved_workflow_draft';
const AGENT = 'fixture_agent';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const GRAPH = {
  name: 'Selected transport workflow',
  nodes: [
    { id: 'trigger-node', type: 'CRON_TRIGGER', configuration: { schedule: '0 9 * * *' } },
    { id: 'review-node', type: 'AGENT', configuration: {
      prompt: 'Keep the selected choice.', modelName: 'fixture-model',
      source: '{{trigger-node.output}}', userChoice: { provider: 'selected-provider', strategy: 'retain' },
    } },
  ],
  connections: [{ sourceNodeId: 'trigger-node', targetNodeId: 'review-node', sourcePort: 'output', targetPort: 'input' }],
  approvals: [{ nodeId: 'review-node', contentHash: 'fixture-approval-binding', decision: 'keep' }],
};
const CHOICES = [{
  nodeId: 'review-node', field: 'credential', label: 'Connect the selected provider', kind: 'credential',
  message: 'Choose the credential to use.', provider: 'selected-provider', authType: 'API_KEY',
  secretKey: 'selected-secret-reference',
}];
const single = {
  name: 'Isolated orchestration solution',
  components: [{ key: 'flow', kind: 'workflow', prompt: 'Build the selected fixture workflow.', entry: true, terminal: true }],
};
const dependent = {
  ...single,
  components: [...single.components, { key: 'dependent', kind: 'agent', prompt: 'Call the selected workflow.', terminal: true }],
  wiring: [{ from: 'dependent', to: 'flow', relation: 'invokes' }],
};
function clean(): Record<string, unknown> {
  return { status: 'READY', generatedWorkflow: clone(GRAPH), validationAvailable: true,
    needsInput: null, needsAttention: [], repairs: [], userMessage: 'Your draft is ready.' };
}
function outage(): Record<string, unknown> {
  return { ...clean(), status: 'NEEDS_INPUT', validationAvailable: false,
    needsInput: clone(CHOICES),
    needsAttention: [{ nodeId: 'review-node', kind: 'CONFIG', label: 'Try validation again',
      retryableReason: 'VALIDATION_UNAVAILABLE', retryable: true }],
    repairs: [{ kind: 'PLACEHOLDER_TO_ASK', nodeId: 'review-node', round: 0 }],
    userMessage: 'Validation is temporarily unavailable. Your draft is kept. Try again.',
    retryableReason: 'VALIDATION_UNAVAILABLE', retryable: true };
}
function terminal(finalResponse: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return { sessionId: SESSION, done: true, progress: 100, status: 'COMPLETED',
    nodes: clone(GRAPH.nodes), edges: clone(GRAPH.connections), speculativeNodes: [], finalResponse, ...extra };
}
type Seen = { method: string; path: string; body: unknown };
type Harness = {
  seen: Seen[];
  call: (plan?: Record<string, unknown>) => Promise<any>;
  polls: () => number;
};

async function withTransport(
  snapshots: Array<Record<string, unknown>>,
  action: (h: Harness) => Promise<void>,
) {
  let polls = 0;
  const seen: Seen[] = [];
  let agentBody: Record<string, unknown> = { id: AGENT, name: 'Fixture agent', tier: 'AGENTIC', linkedWorkflows: [] };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const entry = { method: req.method ?? '', path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
      body: text ? JSON.parse(text) : undefined };
    seen.push(entry);
    let status = 200;
    let body: unknown;
    if (entry.method === 'POST' && entry.path === '/v2/workflows/wizard/generate/async') {
      status = 202; body = { sessionId: SESSION };
    } else if (entry.method === 'GET' && entry.path === '/v2/workflows/wizard/' + SESSION + '/status') {
      body = snapshots[Math.min(polls++, snapshots.length - 1)];
    } else if (entry.method === 'POST' && entry.path === '/v2/workflows/wizard/create') {
      status = 201; body = { id: CREATED };
    } else if (entry.method === 'GET' && (entry.path === '/v2/workflows/' + CREATED || entry.path === '/v2/workflows/' + SAVED)) {
      body = { ...clone(GRAPH), id: entry.path.split('/').at(-1), status: 'DRAFT' };
    } else if (entry.method === 'POST' && entry.path === '/v2/agents/wizard/generate/async') {
      status = 202; body = { sessionId: 'agent_fixture_session' };
    } else if (entry.method === 'GET' && entry.path === '/v2/agents/wizard/agent_fixture_session/status') {
      body = { done: true, progress: 100, status: 'COMPLETED',
        finalResponse: { id: AGENT, status: 'READY', generatedAgent: clone(agentBody) } };
    } else if (entry.method === 'GET' && (entry.path === '/v1/agents/' + AGENT || entry.path === '/v2/agents/' + AGENT)) {
      body = clone(agentBody);
    } else if (entry.method === 'PUT' && entry.path === '/v2/agents/' + AGENT) {
      // If an unresolved endpoint reaches the actual writer, retain its actual
      // request as an observable failure. This is local fixture state only.
      agentBody = { ...agentBody, ...(entry.body as Record<string, unknown>) }; body = clone(agentBody);
    } else {
      status = 400; body = { code: 'UNEXPECTED_FIXTURE_REQUEST', message: entry.method + ' ' + entry.path };
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const traceparent = req.headers.traceparent;
    if (typeof traceparent === 'string') {
      const trace = /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/.exec(traceparent)?.[1];
      if (trace) headers['X-Swfte-Trace-Id'] = trace;
    }
    res.writeHead(status, headers); res.end(JSON.stringify(body));
  }
  const http = createServer((req, res) => {
    void handle(req, res).catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'FIXTURE_TRANSPORT_ERROR', message: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const config = loadConfig({
    SWFTE_PAT: ['pat', 'orchestration', 'fixture'].join('_'),
    SWFTE_BASE_URL: 'http://127.0.0.1:' + (http.address() as AddressInfo).port,
    SWFTE_TELEMETRY: '0', SWFTE_TOOLS: 'core',
  } as never);
  const swfte = new SwfteClient(config);
  const server = buildServer({ config, tools: orchestrateTools.filter(tool => tool.name === 'swfte_solution_build'),
    resolveClient: () => swfte });
  const mcp = new Client({ name: 'wizard-orchestration-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide); await mcp.connect(clientSide);
    await action({ seen, polls: () => polls, call: async (plan = single) => {
      const result: any = await mcp.callTool({ name: 'swfte_solution_build', arguments: {
        plan, waitMs: 6_000, totalWaitMs: 20_000, includeComponentVerify: false,
      } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return JSON.parse(result.content.find((item: any) => item.type === 'text').text);
    } });
  } finally {
    await mcp.close(); await server.close(); http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
}
const mutations = (h: Harness) => h.seen.filter(entry => entry.method !== 'GET' && !entry.path.endsWith('/generate/async'));
function unresolved(report: any, final: Record<string, unknown>) {
  assert.equal(report.ok, false); assert.equal(report.status, 'NEEDS_INPUT');
  const component = report.components.find((entry: any) => entry.key === 'flow');
  assert.equal(component.state, 'needs-input');
  assert.equal(component.sessionId, SESSION);
  assert.equal(component.wizardStatus, final.status);
  assert.equal(JSON.stringify(component.artifact), JSON.stringify(GRAPH), 'Full draft, approvals or user choices changed');
  for (const key of ['needsInput', 'needsAttention', 'repairs', 'userMessage', 'validationAvailable',
    'retryableReason', 'retryable', 'createdWorkflow']) {
    assert.equal(Object.hasOwn(component, key), Object.hasOwn(final, key), 'Missing/unknown metadata fabricated: ' + key);
    if (Object.hasOwn(final, key)) assert.deepEqual(component[key], final[key], 'Terminal metadata dropped: ' + key);
  }
  return component;
}

test('solution build preserves a late validation outage and skips its dependent', async () => {
  const final = outage();
  await withTransport([{ ...terminal(null), status: 'READY', progress: 85, done: false }, terminal(final)], async h => {
    const report = await h.call(dependent);
    unresolved(report, final);
    assert.equal(h.polls(), 2);
    assert.equal(report.components.find((c: any) => c.key === 'dependent').state, 'skipped');
    assert.equal(h.seen.filter(entry => entry.path.endsWith('/generate/async')).length, 1);
    assert.deepEqual(mutations(h), []);
    assert.equal(report.verification, undefined);
  });
});

test('solution build retains a save-guard draft id without admitting it as usable', async () => {
  const final = { ...outage(), retryableReason: 'SAVE_GUARD_UNAVAILABLE',
    createdWorkflow: { id: SAVED, status: 'DRAFT', version: 0 } };
  await withTransport([terminal(final)], async h => {
    const report = await h.call(); const component = unresolved(report, final);
    assert.equal(component.id, SAVED);
    assert.equal(component.blockingReason, 'SAVE_GUARD_UNAVAILABLE');
    assert.equal(report.verification, undefined);
    assert.equal(h.seen.some(entry => entry.path === '/v2/workflows/' + SAVED), false);
    assert.deepEqual(mutations(h), []);
  });
});

test('available clean workflow creates once and passes the original live-state verification', async () => {
  await withTransport([terminal(clean())], async h => {
    const report = await h.call();
    assert.equal(report.ok, true); assert.equal(report.status, 'READY');
    assert.equal(report.components[0].state, 'built'); assert.equal(report.components[0].id, CREATED);
    const creates = mutations(h);
    assert.equal(creates.length, 1); assert.equal(creates[0]?.path, '/v2/workflows/wizard/create');
    assert.equal(JSON.stringify((creates[0]?.body as any).workflow), JSON.stringify(GRAPH));
    assert.equal(JSON.stringify(report.components[0].artifact), JSON.stringify(GRAPH));
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.components[0].readable, true);
    assert(h.seen.some(entry => entry.method === 'GET' && entry.path === '/v2/workflows/' + CREATED));
  });
});

test('available clean persisted workflow avoids duplicate creation', async () => {
  const final = { ...clean(), status: 'CREATED', createdWorkflow: { id: SAVED, status: 'DRAFT' } };
  await withTransport([terminal(final)], async h => {
    const report = await h.call();
    assert.equal(report.status, 'READY'); assert.equal(report.ok, true);
    assert.equal(report.components[0].id, SAVED); assert.equal(report.components[0].state, 'built');
    assert.deepEqual(report.components[0].createdWorkflow, final.createdWorkflow);
    assert.deepEqual(mutations(h), []);
    assert.equal(report.verification.ok, true);
  });
});

const missing = clean(); delete missing.validationAvailable;
const choices = { ...clean(), status: 'NEEDS_INPUT', needsInput: clone(CHOICES) };
const budget = { ...clean(), status: 'NEEDS_INPUT',
  needsAttention: [{ nodeId: 'review-node', kind: 'REFERENCE', label: 'Choose the tool', retryable: false }],
  repairs: [1, 2, 3].map(round => ({ kind: 'LLM_ROUND', nodeId: 'review-node', round })) };
const refused = [
  { name: 'workflow with missing validation availability stays unknown and cannot create', final: missing },
  { name: 'workflow with null validation availability remains unresolved', final: { ...clean(), validationAvailable: null } },
  { name: 'exhausted repair budget retains residual attention and refuses orchestration create', final: budget },
  { name: 'workflow user choices remain NEEDS_INPUT with exact provider and auth type', final: choices },
  { name: 'READY with actual attention cannot become a usable workflow', final: { ...clean(), needsAttention: clone(budget.needsAttention) } },
  { name: 'available INCOMPLETE cannot become a usable workflow', final: { ...clean(), status: 'INCOMPLETE' } },
];
for (const { name, final } of refused) {
  test(name, async () => {
    await withTransport([terminal(final)], async h => {
      const report = await h.call(); unresolved(report, final);
      assert.deepEqual(mutations(h), []);
      assert.equal(report.verification, undefined);
      assert.equal(h.seen.filter(entry => entry.path.endsWith('/generate/async')).length, 1);
    });
  });
}

test('failed workflow terminal retains the generation session and cannot create', async () => {
  const final = { status: 'FAILED', generatedWorkflow: clone(GRAPH), userMessage: 'The build did not complete.' };
  await withTransport([terminal(final, { status: 'FAILED', error: 'Isolated fixture generation failure' })], async h => {
    const report = await h.call();
    assert.equal(report.status, 'BROKEN'); assert.equal(report.ok, false);
    assert.equal(report.components[0].state, 'failed'); assert.equal(report.components[0].sessionId, SESSION);
    assert.equal(report.components[0].wizardStatus, 'FAILED');
    assert.equal(JSON.stringify(report.components[0].artifact), JSON.stringify(GRAPH));
    assert.equal(Object.hasOwn(report.components[0], 'validationAvailable'), false);
    assert.deepEqual(mutations(h), []);
  });
});

test('legacy non-workflow wizard remains usable without workflow validation metadata', async () => {
  await withTransport([], async h => {
    const report = await h.call({ name: 'Legacy agent transport fixture',
      components: [{ key: 'agent', kind: 'agent', prompt: 'Build the isolated agent.', entry: true, terminal: true }] });
    assert.equal(report.status, 'READY'); assert.equal(report.ok, true);
    assert.equal(report.components[0].state, 'built'); assert.equal(report.components[0].id, AGENT);
    assert.equal(Object.hasOwn(report.components[0], 'validationAvailable'), false);
    assert.equal(report.verification.ok, true);
    assert.deepEqual(mutations(h), []);
  });
});

test('unresolved saved draft cannot satisfy a blocking dependency', async () => {
  const final = { ...outage(), createdWorkflow: { id: SAVED, status: 'DRAFT' } };
  await withTransport([terminal(final)], async h => {
    const report = await h.call(dependent); const component = unresolved(report, final);
    assert.equal(component.id, SAVED);
    assert.equal(report.components.find((c: any) => c.key === 'dependent').state, 'skipped');
    assert.equal(h.seen.some(entry => entry.path.startsWith('/v2/agents/wizard/')), false,
      'An unresolved saved draft admitted dependent generation');
    assert.deepEqual(mutations(h), []);
  });
});

test('orchestration never calls a wire writer for an unresolved draft endpoint', async () => {
  const final = { ...outage(), createdWorkflow: { id: SAVED, status: 'DRAFT' } };
  const plan = { ...single,
    components: [...single.components, { key: 'consumer', kind: 'agent', id: AGENT, entry: true, terminal: true }],
    wiring: [{ from: 'consumer', to: 'flow', relation: 'invokes' }] };
  await withTransport([terminal(final)], async h => {
    const report = await h.call(plan); unresolved(report, final);
    assert.equal(report.components.find((c: any) => c.key === 'consumer').state, 'adopted');
    assert.equal(report.wires[0].state, 'target-missing');
    assert.equal(h.seen.some(entry => entry.path === '/v2/workflows/' + SAVED), false,
      'Actual writer preflight read the unresolved draft endpoint');
    assert.equal(h.seen.some(entry => entry.method === 'PUT' || entry.method === 'PATCH'), false,
      'Actual writer changed a consumer before the workflow was usable');
    assert(report.verification.components.every((c: any) => c.id !== SAVED));
    assert.deepEqual(mutations(h), []);
  });
});
