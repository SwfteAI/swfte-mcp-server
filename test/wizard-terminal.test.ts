/**
 * Original01 MCP consumer: actual SDK transport, actual server/tool registry,
 * actual SwfteClient HTTP and polling, with an isolated local response sequence.
 * These are transport fixtures, never receipts that a real artifact validator,
 * model, save, repair or execution ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { shipTools } from '../src/tools/ship.js';

const SESSION = 'wizard_transport_fixture';
const STATUS_PATH = '/v2/workflows/wizard/' + SESSION + '/status';
const GENERATE_PATH = '/v2/workflows/wizard/generate/async';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const GRAPH = {
  name: 'Isolated transport draft',
  nodes: [
    { id: 'trigger-node', type: 'CRON_TRIGGER', configuration: { schedule: '0 9 * * *' } },
    { id: 'review-node', type: 'AGENT', configuration: {
      prompt: 'Review the chosen source.',
      source: '{{trigger-node.output}}',
      credential: '{{secret:credential-choice}}',
      userChoice: { provider: 'chosen-provider', strategy: 'keep-selected' },
    } },
  ],
  connections: [{ sourceNodeId: 'trigger-node', targetNodeId: 'review-node', sourcePort: 'output', targetPort: 'input' }],
  approvals: [{ nodeId: 'review-node', contentHash: 'fixture-content-binding', decision: 'retain-user-choice' }],
};
const INPUTS = [{
  nodeId: 'review-node', fieldName: 'credential', inputType: 'CREDENTIAL', required: true,
  provider: 'chosen-provider', authType: 'API_KEY', secretKey: 'credential-choice',
  label: 'Connect your chosen provider',
}];

function unavailable() {
  return {
    status: 'NEEDS_INPUT', generatedWorkflow: clone(GRAPH),
    needsInput: clone(INPUTS),
    needsAttention: [{
      nodeId: 'review-node', kind: 'CONFIG', label: 'Validation needs another try',
      retryableReason: 'VALIDATION_UNAVAILABLE', retryable: true,
    }],
    repairs: [{ kind: 'PLACEHOLDER_TO_ASK', nodeId: 'review-node', round: 0 }],
    userMessage: 'Validation is temporarily unavailable. Your draft is kept. Try again.',
    validationAvailable: false, retryableReason: 'VALIDATION_UNAVAILABLE', retryable: true,
    insights: { coverage: { status: 'FULL', score: 1 } },
    processTrail: [{ phase: 'VALIDATING', summary: 'Waiting for validation to be available' }],
  };
}
function clean() {
  return {
    status: 'READY', generatedWorkflow: clone(GRAPH), needsInput: [], needsAttention: [], repairs: [],
    userMessage: 'Your draft is ready.', validationAvailable: true,
    insights: { coverage: { status: 'FULL', score: 1 } },
    processTrail: [{ phase: 'VALIDATING', summary: 'Validation completed' }],
  };
}
function terminal(finalResponse: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION, status: 'COMPLETED', done: true, progress: 100,
    nodes: clone(GRAPH.nodes), edges: clone(GRAPH.connections), speculativeNodes: [], finalResponse,
    ...extra,
  };
}
function progress(extra: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION, status: 'READY', done: false, progress: 85, message: 'Coverage completed',
    nodes: clone(GRAPH.nodes), edges: clone(GRAPH.connections), speculativeNodes: [{ id: 'considering-node' }],
    finalResponse: null, ...extra,
  };
}

type Seen = { method: string; path: string; body: unknown };
type Harness = {
  seen: Seen[];
  polls: () => number;
  call: (tool: 'swfte_build' | 'swfte_build_status', waitMs?: number, autoCreate?: boolean) => Promise<any>;
};

async function withTransport(
  snapshots: Array<Record<string, unknown>>,
  action: (harness: Harness) => Promise<void>,
) {
  const seen: Seen[] = [];
  let polls = 0;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const entry = {
      method: req.method ?? '',
      path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname,
      body: text ? JSON.parse(text) : undefined,
    };
    seen.push(entry);
    let body: unknown;
    let status = 200;
    if (entry.method === 'POST' && entry.path === GENERATE_PATH) {
      status = 202;
      body = { sessionId: SESSION };
    } else if (entry.method === 'GET' && entry.path === STATUS_PATH) {
      body = snapshots[Math.min(polls++, snapshots.length - 1)];
    } else {
      status = 400;
      body = { code: 'UNEXPECTED_FIXTURE_REQUEST', message: entry.method + ' ' + entry.path };
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const traceparent = req.headers.traceparent;
    if (typeof traceparent === 'string') {
      const trace = /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/.exec(traceparent)?.[1];
      if (trace) headers['X-Swfte-Trace-Id'] = trace;
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }
  const http = createServer((req, res) => {
    void handle(req, res).catch(error => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'FIXTURE_TRANSPORT_ERROR', message: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  // Explicit values only: no process environment, credential or account mutation.
  const config = loadConfig({
    SWFTE_PAT: ['pat', 'wizard', 'transport', 'fixture'].join('_'),
    SWFTE_BASE_URL: 'http://127.0.0.1:' + (http.address() as AddressInfo).port,
    SWFTE_TELEMETRY: '0',
    SWFTE_TOOLS: 'core',
  } as never);
  const swfte = new SwfteClient(config);
  const tools = shipTools.filter(tool => tool.name === 'swfte_build' || tool.name === 'swfte_build_status');
  const server = buildServer({ config, tools, resolveClient: () => swfte });
  const mcp = new Client({ name: 'wizard-transport-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await mcp.connect(clientSide);
    await action({
      seen, polls: () => polls,
      call: async (tool, waitMs = 8_000, autoCreate = false) => {
        const result: any = await mcp.callTool({
          name: tool,
          arguments: tool === 'swfte_build'
            ? { kind: 'workflow', prompt: 'Build an isolated transport draft with the selected provider.', autoCreate, waitMs }
            : { kind: 'workflow', sessionId: SESSION, waitMs },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
        const text = result.content.find((item: any) => item.type === 'text')?.text;
        assert.equal(typeof text, 'string');
        return JSON.parse(text);
      },
    });
  } finally {
    await mcp.close();
    await server.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
}

function onlyWizardRequests(harness: Harness, generated: boolean) {
  assert.deepEqual(harness.seen.filter(entry => entry.method === 'POST').map(entry => entry.path),
    generated ? [GENERATE_PATH] : []);
  assert(harness.seen.every(entry => entry.path === STATUS_PATH || (generated && entry.path === GENERATE_PATH)),
    'Tool invoked an unrelated model, save, refine or revalidation path');
}
function preserved(result: any, expected: ReturnType<typeof unavailable>) {
  assert.equal(result.done, true);
  assert.equal(result.status, expected.status);
  assert.equal(result.persisted, false);
  assert.equal(Object.hasOwn(result, 'id'), false);
  assert.equal(JSON.stringify(result.artifact), JSON.stringify(GRAPH), 'Full graph bytes and user choices changed');
  for (const key of ['needsInput', 'needsAttention', 'repairs', 'userMessage',
    'validationAvailable', 'retryableReason', 'retryable'] as const) {
    assert.deepEqual(result[key], expected[key], 'Final outcome metadata lost: ' + key);
  }
  assert.deepEqual(result.coverage, expected.insights.coverage);
  assert.deepEqual(result.processTrail, expected.processTrail);
}

test('late validation outage survives swfte_build after premature coverage READY', async () => {
  const final = unavailable();
  await withTransport([progress(), terminal(final)], async h => {
    const result = await h.call('swfte_build');
    assert.equal(h.polls(), 2, 'Coverage progress settled before the real validation result');
    preserved(result, final);
    assert.deepEqual(result.graph, { nodeCount: 2, edgeCount: 1, speculativeCount: 0 });
    assert.equal((h.seen[0]?.body as any).autoCreate, false);
    onlyWizardRequests(h, true);
  });
});

test('swfte_build_status preserves actual clean unsaved validation without persistence', async () => {
  const final = clean();
  await withTransport([progress({ status: 'VALIDATING', progress: 97 }), terminal(final)], async h => {
    const result = await h.call('swfte_build_status');
    assert.equal(h.polls(), 2);
    assert.equal(result.status, 'READY');
    assert.equal(result.validationAvailable, true);
    assert.equal(result.persisted, false);
    assert.equal(Object.hasOwn(result, 'id'), false);
    assert.deepEqual(result.needsInput, []);
    assert.deepEqual(result.needsAttention, []);
    assert.deepEqual(result.repairs, []);
    assert.equal(Object.hasOwn(result, 'retryableReason'), false);
    assert.equal(Object.hasOwn(result, 'retryable'), false);
    assert.equal(JSON.stringify(result.artifact), JSON.stringify(GRAPH));
    onlyWizardRequests(h, false);
  });
});

test('validation recovery replaces outage only when a later real terminal response reports clean', async () => {
  const outage = unavailable();
  await withTransport([terminal(outage), progress(), terminal(clean())], async h => {
    preserved(await h.call('swfte_build_status'), outage);
    const recovered = await h.call('swfte_build_status');
    assert.equal(h.polls(), 3);
    assert.equal(recovered.status, 'READY');
    assert.equal(recovered.validationAvailable, true);
    assert.deepEqual(recovered.needsAttention, []);
    assert.deepEqual(recovered.needsInput, []);
    assert.equal(Object.hasOwn(recovered, 'retryableReason'), false);
    assert.equal(Object.hasOwn(recovered, 'retryable'), false);
    assert.equal(recovered.persisted, false);
    assert.equal(JSON.stringify(recovered.artifact), JSON.stringify(GRAPH));
    onlyWizardRequests(h, false);
  });
});

test('exhausted repair budget preserves available validation and residual attention', async () => {
  const final = {
    ...clean(), status: 'NEEDS_INPUT', workflowId: 'fixture_saved_draft', workflowStatus: 'DRAFT',
    needsAttention: [{ nodeId: 'review-node', kind: 'REFERENCE', label: 'Pick the tool to use', retryable: false }],
    repairs: [1, 2, 3].map(round => ({ kind: 'LLM_ROUND', nodeId: 'review-node', round })),
    userMessage: 'Your draft is kept. One step needs your attention.',
  };
  await withTransport([terminal(final)], async h => {
    const result = await h.call('swfte_build_status');
    assert.equal(result.status, 'NEEDS_INPUT');
    assert.equal(result.validationAvailable, true);
    assert.deepEqual(result.needsAttention, final.needsAttention);
    assert.deepEqual(result.repairs, final.repairs);
    assert.equal(result.userMessage, final.userMessage);
    assert.equal(result.persisted, true);
    assert.equal(result.id, final.workflowId);
    assert.equal(Object.hasOwn(result, 'retryableReason'), false);
    assert.equal(JSON.stringify(result.artifact), JSON.stringify(GRAPH));
    onlyWizardRequests(h, false);
  });
});

test('user-choice terminal retains INPUT requirements even with available validation', async () => {
  const final = { ...clean(), status: 'NEEDS_INPUT', needsInput: clone(INPUTS) };
  await withTransport([terminal(final)], async h => {
    const result = await h.call('swfte_build_status');
    assert.equal(result.status, 'NEEDS_INPUT');
    assert.equal(result.validationAvailable, true);
    assert.deepEqual(result.needsInput, INPUTS);
    assert.deepEqual(result.needsAttention, []);
    assert.equal(result.persisted, false);
    assert.equal(JSON.stringify(result.artifact), JSON.stringify(GRAPH));
    onlyWizardRequests(h, false);
  });
});

test('absent availability and retryability stay absent rather than becoming clean', async () => {
  const final = { status: 'NEEDS_INPUT', generatedWorkflow: clone(GRAPH), needsInput: clone(INPUTS),
    needsAttention: [], repairs: [], userMessage: 'Connect your chosen provider.' };
  await withTransport([terminal(final)], async h => {
    const result = await h.call('swfte_build_status');
    assert.equal(result.status, 'NEEDS_INPUT');
    for (const key of ['validationAvailable', 'retryableReason', 'retryable']) assert.equal(Object.hasOwn(result, key), false, key);
    assert.deepEqual(result.needsInput, INPUTS);
    assert.equal(result.persisted, false);
    onlyWizardRequests(h, false);
  });
});

test('actual createdWorkflow id survives saved CREATED build and status without duplicate create', async () => {
  const final = { ...clean(), status: 'CREATED', createdWorkflow: {
    id: 'fixture_created_record', status: 'DRAFT', version: 1,
  } };
  await withTransport([terminal(final)], async h => {
    const built = await h.call('swfte_build', 8_000, true);
    const resumed = await h.call('swfte_build_status');
    for (const result of [built, resumed]) {
      assert.equal(result.status, 'CREATED');
      assert.equal(result.id, final.createdWorkflow.id, 'Actual saved record id was lost');
      assert.equal(result.persisted, true);
      assert.equal(result.validationAvailable, true);
      assert.deepEqual(result.needsAttention, []);
      assert.equal(Object.hasOwn(result, 'retryableReason'), false);
      assert.equal(JSON.stringify(result.artifact), JSON.stringify(GRAPH));
    }
    assert.equal(h.polls(), 2);
    assert.equal((h.seen[0]?.body as any).autoCreate, true);
    onlyWizardRequests(h, true);
  });
});

test('actual createdWorkflow id preserves unresolved saved DRAFT without clean promotion', async () => {
  const final = { ...unavailable(), createdWorkflow: {
    id: 'fixture_unresolved_record', status: 'DRAFT', version: 1,
  } };
  await withTransport([terminal(final)], async h => {
    const built = await h.call('swfte_build', 8_000, true);
    const resumed = await h.call('swfte_build_status');
    for (const result of [built, resumed]) {
      assert.equal(result.done, true);
      assert.equal(result.status, 'NEEDS_INPUT');
      assert.equal(result.id, final.createdWorkflow.id);
      assert.equal(result.persisted, true, 'Saved identity was mistaken for an unsaved graph');
      assert.equal(result.validationAvailable, false, 'Saved identity fabricated clean validation');
      assert.equal(result.retryableReason, 'VALIDATION_UNAVAILABLE');
      assert.equal(result.retryable, true);
      assert.deepEqual(result.needsInput, INPUTS);
      assert.deepEqual(result.needsAttention, final.needsAttention);
      assert.deepEqual(result.repairs, final.repairs);
      assert.equal(result.userMessage, final.userMessage);
      assert.equal(JSON.stringify(result.artifact), JSON.stringify(GRAPH));
    }
    assert.equal(h.polls(), 2);
    assert.equal((h.seen[0]?.body as any).autoCreate, true);
    onlyWizardRequests(h, true);
  });
});

const premature: Array<{ name: string; snapshot: Record<string, unknown> }> = [
  { name: 'premature boolean done without a terminal DTO does not settle before late outage',
    snapshot: progress({ done: true }) },
  { name: 'truthy string done cannot settle before actual final outage',
    snapshot: progress({ done: 'false', progress: 100, finalResponse: clean() }) },
  { name: 'truthy numeric done cannot settle before actual final outage',
    snapshot: progress({ done: 1 }) },
  { name: 'truthy object done cannot settle before actual final outage',
    snapshot: progress({ done: {}, progress: 100, finalResponse: clean() }) },
  { name: 'empty final DTO at progress85 is not a terminal result',
    snapshot: progress({ done: true, finalResponse: {} }) },
  { name: 'explicit false completion remains nonterminal even with a partial final payload',
    snapshot: progress({ done: false, finalResponse: clean() }) },
];
for (const { name, snapshot } of premature) {
  test(name, async () => {
    const final = unavailable();
    await withTransport([snapshot, terminal(final)], async h => {
      const result = await h.call('swfte_build_status');
      assert.equal(h.polls(), 2, 'Malformed/premature flag prevented consuming the authoritative final response');
      preserved(result, final);
      onlyWizardRequests(h, false);
    });
  });
}

test('done100 infrastructure failure remains terminal with no invented validation', async () => {
  await withTransport([terminal(null, { status: 'FAILED', error: 'Isolated fixture transport failure' })], async h => {
    const result = await h.call('swfte_build_status');
    assert.equal(h.polls(), 1);
    assert.equal(result.done, true);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error, 'Isolated fixture transport failure');
    assert.equal(result.persisted, false);
    assert.equal(result.artifact, null);
    for (const key of ['validationAvailable', 'retryableReason', 'retryable']) assert.equal(Object.hasOwn(result, key), false, key);
    onlyWizardRequests(h, false);
  });
});

test('nonterminal coverage timeout stays resumable and preserves partial graph counts', async () => {
  await withTransport([progress({ status: 'NEEDS_INPUT' })], async h => {
    const result = await h.call('swfte_build_status', 1_000);
    assert.equal(h.polls(), 1);
    assert.equal(result.done, false);
    assert.equal(result.sessionId, SESSION);
    assert.equal(result.status, 'NEEDS_INPUT');
    assert.deepEqual(result.graph, { nodeCount: 2, edgeCount: 1, speculativeCount: 1 });
    assert.match(result.note, /swfte_build_status/);
    assert.equal(Object.hasOwn(result, 'validationAvailable'), false);
    assert.equal(Object.hasOwn(result, 'artifact'), false);
    onlyWizardRequests(h, false);
  });
});
