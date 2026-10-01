/**
 * TypeScript/JavaScript detectors (docs/codemap/CONTRACT.md §7, FIXTURES §4.1): typed-client callers,
 * `@swfte/sdk` calls, raw HTTP and widget embeds, run on small in-memory files plus the committed corpus.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DETECTORS } from '../src/codemap/detectors/ts/index.js';
import { detectProject } from '../src/codemap/detect.js';
import { DEFAULT_ENV_FILES } from '../src/codemap/walk.js';
import type { DetectContext, DetectedSite, LockBinding, SourceFile } from '../src/codemap/types.js';

const FIX = new URL('./fixtures/codemap/', import.meta.url).pathname;
const ENV_FILES = { secret: [...DEFAULT_ENV_FILES.secret, 'dot-env', 'dot-env.*'], names: [...DEFAULT_ENV_FILES.names, 'dot-env.example'] };

const LOCK: LockBinding = {
  alias: 'order',
  catalogRef: 'workflow:wf_order',
  language: 'typescript',
  pinnedVersion: '2',
  contractHash: 'hash-order',
  files: ['src/swfte/order.ts'],
};
const CHAT_LOCK: LockBinding = { alias: 'helper', catalogRef: 'agent:ag_help', language: 'typescript', pinnedVersion: null, contractHash: 'hash-help', files: ['src/swfte/helper.ts'] };

function run(text: string, relPath = 'src/a.ts', locks: LockBinding[] = [], lockDir: string | null = locks.length ? '' : null) {
  const file: SourceFile = { relPath, language: relPath.endsWith('.js') || relPath.endsWith('.mjs') ? 'javascript' : 'typescript', text };
  const ctx: DetectContext = { locks, lockDir };
  const sites: DetectedSite[] = [];
  const implementations = [];
  const envVarNames: string[] = [];
  for (const d of DETECTORS) {
    if (!d.languages.includes(file.language)) continue;
    const r = d.detect(file, ctx);
    sites.push(...r.sites);
    implementations.push(...r.implementations);
    envVarNames.push(...r.envVarNames);
  }
  return { sites, implementations, envVarNames };
}

const one = (text: string, relPath?: string, locks?: LockBinding[]) => {
  const { sites } = run(text, relPath, locks);
  assert.equal(sites.length, 1, JSON.stringify(sites.map((s) => [s.line, s.symbol])));
  return sites[0]!;
};

describe('@swfte/sdk calls', () => {
  test('workflow invoke: literal id, input keys, run op', () => {
    const s = one("import Swfte from '@swfte/sdk';\nconst c = new Swfte({ apiKey: 'x' });\nexport async function go(t: string) {\n  await c.workflows.invoke('wf_a', { topic: t, n: 1 });\n}\n");
    assert.deepEqual([s.category, s.op, s.sdk, s.managed, s.artifact.kind, s.artifact.id, s.inputKeys, s.artifact.alias], ['managed', 'run', 'node', 'typed-client', 'workflow', 'wf_a', ['n', 'topic'], null]);
    assert.equal(s.line, 4);
    assert.equal(s.symbol, 'go');
  });

  test('agents chat is op chat and the message is not an input key', () => {
    const s = one("import Swfte from '@swfte/sdk';\nconst c = new Swfte({});\nexport const ask = (q: string) => c.agents.chat('ag_x', q, { userId: 'u' });\n");
    assert.deepEqual([s.op, s.artifact.kind, s.artifact.id, s.inputKeys, s.symbol], ['chat', 'agent', 'ag_x', [], 'ask']);
  });

  test('chatflow startSession is chat, stats is read-output, history is read-output', () => {
    const { sites } = run("const c = new Swfte({});\nexport async function f() {\n  await c.chatflows.startSession('cf_1');\n  await c.chatflows.stats('cf_1');\n  await c.workflows.getExecutionHistory('wf_h');\n}\n");
    assert.deepEqual(sites.map((s) => s.op), ['chat', 'read-output', 'read-output']);
    assert.ok(sites.every((s) => s.inputKeys.length === 0 && s.outputKeys.length === 0));
  });

  test('same-file constant id is folded', () => {
    const s = one("const WF = 'wf_const';\nexport async function f() {\n  await c.workflows.execute(WF, { a: 1 });\n}\n");
    assert.equal(s.artifact.id, 'wf_const');
  });

  test('dynamic id parameter is unresolved and never guessed', () => {
    const s = one('export async function f(id: string) {\n  await c.workflows.invoke(id, {});\n}\n');
    assert.deepEqual([s.artifact.id, s.artifact.unresolved, s.category, s.artifact.envVarName], [null, true, 'dynamic', undefined]);
  });

  test('dynamic id env unresolved envVarName', () => {
    const s = one("export async function f() {\n  await c.agents.chat(process.env.SWFTE_AGENT_ID ?? 'ag_default', 'hi');\n}\n");
    assert.deepEqual([s.artifact.id, s.artifact.unresolved, s.artifact.envVarName], [null, true, 'SWFTE_AGENT_ID']);
  });

  test('dynamic id no envVarName when the env read is indirect', () => {
    const s = one("const id = `wf_${process.env.TENANT}`;\nexport async function f() {\n  await c.workflows.invoke(id, {});\n}\n");
    assert.deepEqual([s.artifact.unresolved, s.artifact.envVarName], [true, undefined]);
  });

  test('loop variable over a literal array stays unresolved', () => {
    const s = one("for (const id of ['ag_a', 'ag_b']) {\n  await c.agents.chat(id, 'x');\n}\n");
    assert.equal(s.artifact.unresolved, true);
  });

  test('a shadowing parameter beats the module constant', () => {
    const s = one("const WF = 'wf_outer';\nexport async function f(WF: string) {\n  await c.workflows.invoke(WF, {});\n}\n");
    assert.equal(s.artifact.unresolved, true);
  });

  test('a const declared in a switch case shadows the module constant', () => {
    const s = one("const id = 'wf_outer';\nexport function f(k: number) {\n  switch (k) {\n    case 1:\n      const id = x();\n      c.workflows.invoke(id, {});\n  }\n}\n");
    assert.equal(s.artifact.unresolved, true);
  });

  test('a let that is reassigned is never folded', () => {
    const s = one("let id = 'wf_a';\nexport function f() {\n  id = g();\n  c.workflows.invoke(id, {});\n}\n");
    assert.equal(s.artifact.unresolved, true);
  });

  test('fork package client is not Swfte', () => {
    const { sites } = run("import { ForkClient } from '@acme/swfte-fork';\nconst fork = new ForkClient({});\nexport const a = () => fork.workflows.invoke('wf_1', {});\n");
    assert.equal(sites.length, 0);
  });

  test('client held in a class field and constructor parameter', () => {
    const s = one("import Swfte from '@swfte/sdk';\nclass Svc {\n  constructor(private readonly client: Swfte) {}\n  async go() {\n    await this.client.workflows.invoke('wf_1', { a });\n  }\n}\n");
    assert.deepEqual([s.symbol, s.inputKeys], ['Svc.go', ['a']]);
  });

  test('class property typed as a foreign class is refused', () => {
    const { sites } = run("import { Other } from 'other-sdk';\nclass Svc {\n  client: Other = new Other();\n  go() {\n    return this.client.workflows.invoke('wf_1', {});\n  }\n}\n");
    assert.equal(sites.length, 0);
  });

  test('resource destructured from the client', () => {
    const s = one("const { agents } = eu;\nexport async function f() {\n  await agents.chat('ag_eu', 'hi');\n}\n");
    assert.equal(s.artifact.id, 'ag_eu');
  });

  test('a custom SDK-shaped call on an unrelated method is not a site', () => {
    const { sites } = run("export async function f() {\n  await c.workflows.create({ name: 'x' });\n  await c.agents.get('ag_1');\n}\n");
    assert.equal(sites.length, 0);
  });
});

describe('typed client callers', () => {
  const GEN = "import { invokeOrder, type OrderInput } from '@/swfte/order';\n";

  test('alias, pin and contract hash come from the lock binding', () => {
    const s = one(`${GEN}export async function POST() {\n  const res = await invokeOrder({ sku: 'a', qty: 1 });\n  return res.output?.total;\n}\n`, 'src/app/route.ts', [LOCK]);
    assert.deepEqual([s.artifact.alias, s.artifact.pinnedVersion, s.contractHash, s.artifact.id, s.op, s.managed, s.sdk, s.inputKeys, s.outputKeys, s.symbol], ['order', '2', 'hash-order', 'wf_order', 'run', 'typed-client', 'node', ['qty', 'sku'], ['total'], 'POST']);
  });

  test('import alias and namespace import both resolve', () => {
    const a = one("import { invokeOrder as go } from '../swfte/order';\nexport const f = () => go({});\n", 'src/lib/x.ts', [LOCK]);
    assert.equal(a.artifact.alias, 'order');
    const b = one("import * as order from '@/swfte/order';\nexport const f = () => order.invokeOrder({ a });\n", 'src/lib/y.ts', [LOCK]);
    assert.equal(b.artifact.alias, 'order');
  });

  test('chat client function gives op chat and takes the first argument as input', () => {
    const s = one("import { chatHelper } from '@/swfte/helper';\nexport const f = (message: string) => chatHelper({ message }, { userId: 'u' });\n", 'src/a.ts', [CHAT_LOCK]);
    assert.deepEqual([s.op, s.artifact.kind, s.inputKeys], ['chat', 'agent', ['message']]);
  });

  test('a module outside the lock files is not a generated client', () => {
    const { sites } = run("import { invokeOrder } from '@/lib/elsewhere';\nexport const f = () => invokeOrder({});\n", 'src/a.ts', [LOCK]);
    assert.equal(sites.length, 0);
  });

  test('without any lock binding nothing is a typed client', () => {
    assert.equal(run(`${GEN}export const f = () => invokeOrder({});\n`).sites.length, 0);
  });

  test('anonymous callback contributes nothing: symbols: anonymous callback uses named ancestor', () => {
    const s = one(`${GEN}export function publishAll(items: string[]) {\n  items.forEach((it) => {\n    invokeOrder({ it });\n  });\n}\n`, 'src/a.ts', [LOCK]);
    assert.equal(s.symbol, 'publishAll');
  });

  test('symbols: class method, arrow const, object literal method, default export, module level', () => {
    const src = `${GEN}class A { m() { invokeOrder({}); } }\nconst arrow = async () => { await invokeOrder({}); };\nconst o = { k() { invokeOrder({}); } };\nexport default async function () { invokeOrder({}); }\ninvokeOrder({});\n`;
    const { sites } = run(src, 'src/a.ts', [LOCK]);
    assert.deepEqual(sites.map((s) => s.symbol), ['A.m', 'arrow', 'o.k', 'default', '<module>']);
  });

  test('multiline call line is the first line of the call', () => {
    const s = one(`${GEN}export async function f() {\n  const r = await invokeOrder(\n    { a: 1 },\n    { timeoutMs: 5 },\n  );\n}\n`, 'src/a.ts', [LOCK]);
    assert.equal(s.line, 3);
  });

  test('generated client implementation not site', () => {
    const gen = "// Generated by @swfte/mcp-server (swfte add / swfte_scaffold_client). Do not edit by hand.\nexport async function invokeOrder(input: unknown) {\n  const f = opts.fetch ?? fetch;\n  const res = await f(url, { method: 'POST' });\n  return res;\n}\nexport async function call() {\n  return fetch('https://api.swfte.com/agents/v2/workflows/wf_order/invoke', { method: 'POST' });\n}\n";
    const r = run(gen, 'src/swfte/order.ts', [LOCK]);
    assert.equal(r.sites.length, 0);
    assert.deepEqual(r.implementations.map((i) => [i.line, i.alias]), [[4, 'order']]);
  });
});

describe('output and input keys', () => {
  const wrap = (body: string) => `${"import { invokeOrder } from '@/swfte/order';\n"}export async function f(input: any, body: any) {\n${body}\n}\n`;
  const keys = (body: string) => {
    const { sites } = run(wrap(body), 'src/a.ts', [LOCK]);
    assert.equal(sites.length, 1);
    return sites[0]!;
  };

  test('spread input gives wildcard keys', () => {
    assert.deepEqual(keys('  await invokeOrder({ ...body, extra: 1 });').inputKeys, ['*']);
    assert.deepEqual(keys('  await invokeOrder(input);').inputKeys, ['*']);
  });

  test('input bound to a literal in the same function gives the literal keys', () => {
    assert.deepEqual(keys('  const payload = { b: 1, a: 2 };\n  await invokeOrder(payload);').inputKeys, ['a', 'b']);
    assert.deepEqual(keys('  let payload = { a: 1 };\n  payload = other();\n  await invokeOrder(payload);').inputKeys, ['*']);
  });

  test('output passed whole', () => {
    assert.deepEqual(keys('  const res = await invokeOrder({});\n  audit(res);').outputKeys, ['*']);
    assert.deepEqual(keys('  return await invokeOrder({});').outputKeys, ['*']);
  });

  test('output cut at index access', () => {
    assert.deepEqual(keys('  const res = await invokeOrder({});\n  return res.output.articles[0].title;').outputKeys, ['articles']);
    assert.deepEqual(keys('  const res = await invokeOrder({});\n  return res.output?.lines?.map((l) => l.x);').outputKeys, ['lines']);
  });

  test('dotted paths, destructuring and envelope fields', () => {
    assert.deepEqual(keys('  const res = await invokeOrder({});\n  if (!res.ok) return res.status;\n  return [res.output.a.b, res.output.c, res.executionId];').outputKeys, ['a.b', 'c']);
    assert.deepEqual(keys('  const { output, status } = await invokeOrder({});\n  return output?.score;').outputKeys, ['score']);
    assert.deepEqual(keys('  const { output: { rows, total } } = await invokeOrder({});\n  return 1;').outputKeys, ['rows', 'total']);
  });

  test('result never read gives no keys; then-callback is followed', () => {
    assert.deepEqual(keys('  await invokeOrder({});').outputKeys, []);
    assert.deepEqual(keys('  return invokeOrder({}).then((r) => r.output?.decision);').outputKeys, ['decision']);
  });

  test('SDK outputs field is the output root', () => {
    const s = one("export async function f() {\n  const done = await c.workflows.invokeAndWait('wf_1', {});\n  const { issues, score } = done.outputs ?? {};\n  return [issues, score, done.status];\n}\n");
    assert.deepEqual(s.outputKeys, ['issues', 'score']);
  });
});

describe('raw HTTP', () => {
  test('fetch with a literal Swfte URL, body keys and symbol', () => {
    const s = one("export async function go() {\n  await fetch('https://api.swfte.com/agents/v2/workflows/wf_raw/invoke', { method: 'POST', body: JSON.stringify({ b: 1, a: 2 }) });\n}\n");
    assert.deepEqual([s.category, s.sdk, s.managed, s.op, s.artifact.kind, s.artifact.id, s.inputKeys, s.outputKeys, s.artifact.alias], ['raw-http', 'http', 'raw-http', 'run', 'workflow', 'wf_raw', ['a', 'b'], [], null]);
  });

  test('template literal with a constant host and SWFTE_BASE_URL', () => {
    const a = one("const BASE = 'https://api.swfte.com/agents';\nexport const f = () => fetch(`${BASE}/v1/agents/ag_1/chat/smoke`, { method: 'POST', body: JSON.stringify({ message: 'x' }) });\n");
    assert.deepEqual([a.op, a.artifact.id, a.inputKeys], ['chat', 'ag_1', ['message']]);
    const b = one("export const f = () => fetch(`${process.env.SWFTE_BASE_URL}/v2/chatflows/cf_1/sessions`, { method: 'POST' });\n");
    assert.deepEqual([b.artifact.kind, b.artifact.id, b.op], ['chatflow', 'cf_1', 'chat']);
  });

  test('literal /versions/N/invoke path sets pinnedVersion', () => {
    const s = one("import axios from 'axios';\nexport const f = (a: string) => axios.post('https://api.swfte.com/agents/v2/workflows/wf_1/versions/3/invoke', { a });\n");
    assert.deepEqual([s.artifact.pinnedVersion, s.inputKeys], ['3', ['a']]);
  });

  test('variable id is dynamic, env id records only the name', () => {
    const a = one("export const f = (id: string) => fetch(`https://api.swfte.com/agents/v2/workflows/${id}/invoke`, { method: 'POST' });\n");
    assert.deepEqual([a.artifact.unresolved, a.category, a.artifact.envVarName], [true, 'dynamic', undefined]);
    const b = one("export const f = () => fetch(`https://api.swfte.com/agents/v2/workflows/${process.env.SWFTE_WF}/invoke`, { method: 'POST' });\n");
    assert.equal(b.artifact.envVarName, 'SWFTE_WF');
  });

  test('body that is a parameter or spread gives wildcard keys', () => {
    assert.deepEqual(one("export const f = (b: unknown) => fetch('https://api.swfte.com/agents/v2/workflows/wf_1/invoke', { method: 'POST', body: JSON.stringify(b) });\n").inputKeys, ['*']);
    assert.deepEqual(one("import axios from 'axios';\nexport const f = (b: any) => axios.post('https://api.swfte.com/agents/v2/workflows/wf_1/invoke', { ...b });\n").inputKeys, ['*']);
  });

  test('URL of a host that is not Swfte, or whose host is unknown, is not a site', () => {
    assert.equal(run("export const f = () => fetch('https://api.swfte.com.evil.test/agents/v2/workflows/wf_1/invoke');\n").sites.length, 0);
    assert.equal(run("export const f = (base: string) => fetch(`${base}/v2/workflows/wf_1/invoke`);\n").sites.length, 0);
    assert.equal(run("export const f = () => fetch('https://example.com/v2/workflows/wf_1/invoke');\n").sites.length, 0);
  });

  test('a string that merely contains the URL is not a call', () => {
    assert.equal(run("export const URL_DOC = 'https://api.swfte.com/agents/v2/workflows/wf_1/invoke';\nconsole.log(`see ${URL_DOC}`);\n").sites.length, 0);
  });
});

describe('widgets in TS/JS', () => {
  const IMP = "import { ChatWidget, EmbeddedChat as Inline } from '@swfte/chat-widget/react';\n";

  test('React components, including an import alias, resolve the agent id', () => {
    const { sites } = run(`${IMP}export const A = () => <ChatWidget agentId="ag_1" />;\nexport const B = () => (\n  <Inline\n    agentId={'ag_2'}\n  />\n);\n`, 'src/w.tsx');
    assert.deepEqual(sites.map((s) => [s.line, s.artifact.id, s.op, s.category, s.symbol]), [[2, 'ag_1', 'embed', 'widget', 'A'], [4, 'ag_2', 'embed', 'widget', 'B']]);
  });

  test('agentId from an env var is unresolved with the name', () => {
    const s = one(`${IMP}export const T = () => <ChatWidget agentId={process.env.NEXT_PUBLIC_SWFTE_AGENT_ID ?? ''} />;\n`, 'src/t.tsx');
    assert.deepEqual([s.artifact.unresolved, s.artifact.envVarName, s.category], [true, 'NEXT_PUBLIC_SWFTE_AGENT_ID', 'dynamic']);
  });

  test('new SwfteChatWidget from the package', () => {
    const s = one("import { SwfteChatWidget } from '@swfte/chat-widget';\nexport function mount() {\n  const w = new SwfteChatWidget({\n    agentId: 'ag_7',\n  });\n  w.mount();\n}\n");
    assert.deepEqual([s.line, s.artifact.id, s.symbol], [3, 'ag_7', 'mount']);
  });

  test('a component of the same name from another package is not a widget', () => {
    assert.equal(run("import { ChatWidget } from 'other-lib';\nexport const A = () => <ChatWidget agentId=\"ag_1\" />;\n", 'src/w.tsx').sites.length, 0);
  });

  test('iframe markup in a template string and in JSX', () => {
    const a = one('export function GET() {\n  const html = `<div>\n  <iframe src="https://app.swfte.com/chat/ag_9" title="x"></iframe>\n</div>`;\n  return html;\n}\n');
    assert.deepEqual([a.line, a.artifact.id, a.symbol], [3, 'ag_9', 'GET']);
    const b = one('export const J = () => <iframe src="https://app.swfte.com/chat/ag_8" />;\n', 'src/j.tsx');
    assert.equal(b.artifact.id, 'ag_8');
    const c = one('export const f = (id: string) => `<iframe src="https://app.swfte.com/chat/${id}"></iframe>`;\n');
    assert.deepEqual([c.artifact.unresolved, c.category], [true, 'dynamic']);
  });
});

describe('decoys, robustness, env names', () => {
  test('comments, doc comments and string mentions are not sites', () => {
    const src = "/**\n * @example\n * await c.workflows.invoke('wf_doc', {});\n */\n// await c.agents.chat('ag_c', 'x');\nexport const s = \"c.workflows.invoke('wf_str', {})\";\n/* <ChatWidget agentId=\"ag_c\" /> */\n";
    assert.equal(run(src).sites.length, 0);
  });

  test('test files and mocks are not sites', () => {
    const src = "it('x', async () => {\n  await c.workflows.invoke('wf_t', {});\n});\n";
    assert.equal(run(src, 'src/__tests__/a.test.ts').sites.length, 0);
    assert.equal(run(src, 'src/lib/leads.spec.ts').sites.length, 0);
    assert.equal(run(src, 'tests/x.ts').sites.length, 0);
  });

  test('a non-test-named file that vi.mock/jest.mock replaces the SDK in is a mock, not a site', () => {
    const body = "const c = new Swfte({});\nexport async function f() { await c.workflows.invoke('wf_mock', {}); }\n";
    const mocked = "import { vi } from 'vitest';\nvi.mock('@swfte/sdk', () => ({ Swfte: class {} }));\n" + body;
    assert.equal(run(mocked, 'src/setup/swfte-stub.ts').sites.length, 0);
    assert.equal(run(mocked.replace('vi.mock', 'jest.mock'), 'src/setup/swfte-stub.ts').sites.length, 0);
    // control: the same body without the mock call is a site
    assert.equal(run(body, 'src/setup/swfte-stub.ts').sites.length, 1);
  });

  test('a file another tool generated is not scanned even when handed over', () => {
    const src = "// @generated by swagger\nexport const f = () => fetch('https://api.swfte.com/agents/v2/workflows/wf_1/invoke');\n";
    assert.equal(run(src).sites.length, 0);
  });

  test('invalid syntax does not throw', () => {
    const r = run("export async function f( {\n  await c.workflows.invoke('wf_1', { a: \n");
    assert.ok(Array.isArray(r.sites));
    assert.doesNotThrow(() => run('<<<< not code >>>>', 'src/b.tsx'));
    assert.doesNotThrow(() => run('', 'src/c.js'));
  });

  test('SWFTE env var names are collected, names only', () => {
    const r = run("const k = process.env.SWFTE_API_KEY;\nconst u = process.env['SWFTE_BASE_URL'];\nconst o = process.env.HOME;\n// process.env.SWFTE_IN_COMMENT\n");
    assert.deepEqual(r.envVarNames.sort(), ['SWFTE_API_KEY', 'SWFTE_BASE_URL']);
  });

  test('no site field holds source text', () => {
    const { sites } = run("export async function f() {\n  await c.workflows.invoke('wf_1', { secretKey: 'cm-canary-literal-7f3a' });\n}\n");
    assert.ok(!JSON.stringify(sites).includes('cm-canary-literal-7f3a'));
  });
});

describe('corpus', () => {
  test('decoys produce no sites', async () => {
    const out = await detectProject(`${FIX}decoys`, { envFiles: ENV_FILES });
    assert.deepEqual(out.sites, []);
    assert.deepEqual(out.implementations, []);
  });

  test('monorepo nearest lock wins', async () => {
    const out = await detectProject(`${FIX}monorepo`, { envFiles: ENV_FILES });
    const pin = (p: string) => out.sites.filter((s) => s.relPath.startsWith(p) && s.artifact.alias === 'content-pipeline').map((s) => s.artifact.pinnedVersion);
    assert.ok(pin('packages/web/').length > 0 && pin('packages/web/').every((v) => v === '3'));
    assert.ok(pin('packages/admin/').length > 0 && pin('packages/admin/').every((v) => v === '4'));
  });

  test('ts-next: every answer-key site is found with the same path, line, artifact, inputKeys and outputKeys', async () => {
    const key = JSON.parse(readFileSync(`${FIX}ts-next/answer-key.json`, 'utf8')) as {
      sites: Array<{ path: string; line: number; artifact: { kind: string; id: string | null; unresolved: boolean; alias: string | null; pinnedVersion: string | null; envVarName: string | null }; inputKeys: string[]; outputKeys: string[] }>;
    };
    const out = await detectProject(`${FIX}ts-next`, { envFiles: ENV_FILES });
    const shape = (p: string, l: number, a: { kind: string; id: string | null; unresolved: boolean; alias: string | null; pinnedVersion: string | null; envVarName?: string | null }, i: string[], o: string[]) =>
      JSON.stringify([p, l, a.kind, a.id, a.unresolved, a.alias, a.pinnedVersion, a.envVarName ?? null, i, o]);
    const got = out.sites.map((s) => shape(s.relPath, s.line, s.artifact, s.inputKeys, s.outputKeys)).sort();
    const want = key.sites.map((s) => shape(s.path, s.line, s.artifact, s.inputKeys, s.outputKeys)).sort();
    assert.ok(want.length >= 50);
    assert.deepEqual(got, want);
  });

  test('ts-next: every typed-client site carries its alias and every implementation is reported once', async () => {
    const out = await detectProject(`${FIX}ts-next`, { envFiles: ENV_FILES });
    assert.deepEqual(out.implementations.map((i) => i.relPath), ['src/swfte/content-pipeline.ts', 'src/swfte/invoice-triage.ts', 'src/swfte/support-agent.ts']);
    assert.ok(out.sites.every((s) => !s.relPath.startsWith('src/swfte/')));
    assert.ok(out.envVarNames.includes('SWFTE_API_KEY') && out.envVarNames.includes('NEXT_PUBLIC_SWFTE_AGENT_ID'));
  });
});

describe('raw HTTP URL authority', () => {
  for (const url of [
    'https://evil.example/x/api.swfte.com/v2/workflows/wf_x/invoke',
    'https://evil.example/x//api.swfte.com/v2/workflows/wf_x/invoke',
    'https://evil.example/v2/workflows/wf_x/invoke?next=https://api.swfte.com/',
    'https://evil.example/v2/workflows/wf_x/invoke#//api.swfte.com/',
    'https://api.swfte.com@evil.example/v2/workflows/wf_x/invoke',
    'https://api.swfte.com.evil.example/v2/workflows/wf_x/invoke',
    'api.swfte.com/v2/workflows/wf_x/invoke',
  ]) {
    test(`rejects foreign/relative authority: ${url}`, () => {
      assert.equal(run(`export const f = () => fetch(${JSON.stringify(url)}, { method: 'POST' });`).sites.length, 0);
    });
  }
  for (const host of ['https://api.swfte.com', 'HTTPS://api.swfte.com', '//api.swfte.com', 'https://api.swfte.com:8443']) {
    test(`keeps a real authority: ${host}`, () => {
      const r = run(`export const f = () => fetch('${host}/v2/workflows/wf_x/invoke', { method: 'POST' });`);
      assert.equal(r.sites.length, 1);
      assert.equal(r.sites[0]!.artifact.id, 'wf_x');
    });
  }
  test('an unknown authority suffix and an env base used as userinfo remain unknown', () => {
    assert.equal(run('export const f = (suffix: string) => fetch(`https://api.swfte.com${suffix}/v2/workflows/wf_x/invoke`);').sites.length, 0);
    assert.equal(run('export const f = () => fetch(`${process.env.SWFTE_BASE_URL}@evil.example/v2/workflows/wf_x/invoke`);').sites.length, 0);
  });
});
