/**
 * Battle-test regressions (docs/studio-source-of-truth-20260922/BATTLE_TEST.md,
 * findings N1–N4 and N8–N11). Each test is the finding's repro, kept as a guard:
 * it drives the real `swfte` CLI (runCli) in a throwaway project against a
 * mocked global fetch, exactly as the battle harness did.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { effectiveContractHash } from '../src/catalog.js';
import { runCli } from '../src/cli.js';
import { ConfinedWriter, PathConfinementError } from '../src/fsguard.js';
import { detectStack } from '../src/stack.js';

const CREDENTIAL = 'pat_supersecretcredential123';

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
}
/** A handler returns a JSON body, a raw text body (for truncation), or hangs until aborted. */
type Reply = { status?: number; body?: unknown; raw?: string; hang?: boolean };
type Handler = (req: Seen) => Reply;

let seen: Seen[] = [];
let routes: Array<[string, RegExp, Handler]> = [];
const realFetch = globalThis.fetch;

function route(method: string, pattern: RegExp, handler: Handler | Reply) {
  routes.unshift([method, pattern, typeof handler === 'function' ? handler : () => handler]);
}

function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const req: Seen = { method: String(init.method ?? 'GET'), path: url.pathname.replace(/^\/agents/, ''), query: Object.fromEntries(url.searchParams.entries()) };
    seen.push(req);
    const hit = routes.find(([m, re]) => m === req.method && re.test(req.path));
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE', message: `${req.method} ${req.path}` }), { status: 404 });
    const out = hit[2](req);
    if (out.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const signal: AbortSignal | undefined = init.signal;
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      });
    }
    const text = out.raw !== undefined ? out.raw : out.body === undefined ? '' : JSON.stringify(out.body);
    return new Response(text, { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const WF_CONTRACT = {
  catalogRef: 'workflow:wf_1',
  invoke: { method: 'POST', path: '/v2/workflows/wf_1/invoke', auth: 'api_key', async: true, statusPath: '/v2/workflows/executions/{executionId}/status' },
  inputSchema: { type: 'object', properties: { lead: { type: 'string' } }, required: ['lead'] },
  outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
  snippets: {},
  embed: null,
  version: 'v3',
};

let contract: any;

function catalogRoutes() {
  route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, () => ({
    body: { catalogRef: 'workflow:wf_1', kind: 'workflow', id: 'wf_1', name: 'Lead Scorer', scope: 'workspace', facets: [], evidence: { level: 'observed' }, updatedAt: '2026-09-21T00:00:00Z' },
  }));
  route('GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, () => ({ body: contract }));
  // A published version's schemas are frozen the first time it is seen, like the backend's snapshot.
  const published = new Map<string, any>();
  route('GET', /^\/v2\/workflows\/wf_1\/versions\/[^/]+\/schema$/, (req) => {
    const version = decodeURIComponent(req.path.split('/')[5]!);
    if (version !== contract.version && !published.has(version)) return { status: 404, body: { error: 'VERSION_NOT_PUBLISHED' } };
    if (!published.has(version)) published.set(version, structuredClone(contract));
    const c = published.get(version);
    return { body: { workflowId: 'wf_1', version, published: true, inputSchema: c.inputSchema, outputSchema: c.outputSchema } };
  });
  route('GET', /^\/v2\/catalog\/upgrades$/, (req) => ({
    body: {
      items: String(req.query.refs ?? '')
        .split(',')
        .filter(Boolean)
        .map((pin) => {
          const at = pin.lastIndexOf(':');
          return { catalogRef: pin.slice(0, at), currentHash: pin.slice(at + 1), latestHash: effectiveContractHash(contract).hash, breaking: false, capabilityChanges: [], requiresReapproval: false, latestVersion: contract.version, summary: null };
        }),
    },
  }));
}

let tmp = '';
let outside = '';
beforeEach(() => {
  seen = [];
  routes = [];
  contract = structuredClone(WF_CONTRACT);
  installFetch();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-battle-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-outside-')));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function cli(args: string[], env: Record<string, string | undefined> = { SWFTE_API_KEY: CREDENTIAL }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l), env: env as NodeJS.ProcessEnv, cwd: tmp });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const read = (rel: string) => readFileSync(join(tmp, rel), 'utf8');
/** A plain TypeScript project: generated clients land in swfte/. */
const nodeProject = () => writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', dependencies: {} }));

/** A project with wf_1 baked in and verified clean (pinned to v3 unless unpinned). */
async function baked(...extra: string[]) {
  nodeProject();
  catalogRoutes();
  const r = await cli(['add', 'workflow:wf_1', ...extra]);
  assert.equal(r.code, 0, r.err);
  assert.equal((await cli(['verify'])).code, 0);
}

/* ── N1: no write through a dangling symlink ─────────────────────────────── */

describe('BT-N1 dangling symlinks are never written through', () => {
  test('a dangling symlink planted at the generated client path is refused; nothing is created outside', async () => {
    nodeProject();
    catalogRoutes();
    mkdirSync(join(tmp, 'swfte'));
    const target = join(outside, 'pwned.ts');
    symlinkSync(target, join(tmp, 'swfte/lead-scorer.ts'));
    const r = await cli(['add', 'workflow:wf_1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /symlink/i);
    assert.ok(!existsSync(target), 'wrote through the dangling symlink');
    assert.ok(!existsSync(join(tmp, 'swfte.json')), 'a refused plan must write nothing');
  });

  test('a dangling symlink named swfte.json is refused', async () => {
    catalogRoutes();
    const target = join(outside, 'x.json');
    symlinkSync(target, join(tmp, 'swfte.json'));
    const r = await cli(['add', 'workflow:wf_1']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /symlink/i);
    assert.ok(!existsSync(target));
  });

  test('a dangling directory symlink along the path is refused', async () => {
    nodeProject();
    catalogRoutes();
    symlinkSync(join(outside, 'not-yet'), join(tmp, 'swfte'));
    const r = await cli(['add', 'workflow:wf_1']);
    assert.notEqual(r.code, 0);
    assert.ok(!existsSync(join(outside, 'not-yet')));
  });

  test('a symlink inside the tree is not written through either (lstat of every component, including the last)', () => {
    mkdirSync(join(tmp, 'real'));
    writeFileSync(join(tmp, 'real/a.ts'), 'x');
    symlinkSync(join(tmp, 'real'), join(tmp, 'linked'));
    symlinkSync(join(tmp, 'real/a.ts'), join(tmp, 'b.ts'));
    const w = new ConfinedWriter({ root: tmp });
    assert.throws(() => w.create(w.resolve('linked/new.ts'), 'y'), PathConfinementError);
    assert.throws(() => w.create(w.resolve('b.ts'), 'y', true), PathConfinementError);
    assert.equal(lstatSync(join(tmp, 'b.ts')).isSymbolicLink(), true);
  });

  test('a symlink swapped in between plan and commit is refused at commit (O_NOFOLLOW + re-check)', () => {
    const w = new ConfinedWriter({ root: tmp });
    w.create(w.resolve('late.ts'), 'content');
    symlinkSync(join(outside, 'late.ts'), join(tmp, 'late.ts'));
    assert.throws(() => w.commit());
    assert.ok(!existsSync(join(outside, 'late.ts')));
  });
});

/* ── N2 / N3 / N10: verify fails closed on the upgrades answer ────────────── */

describe('BT-N2/N3/N10 swfte verify never passes on an answer it could not read', () => {
  test('a truncated upgrades body (200, invalid JSON) is UNCHECKED, exit 2', async () => {
    await baked();
    route('GET', /^\/v2\/catalog\/upgrades$/, { raw: '{"items": [ {"catalogRef": ' });
    const r = await cli(['verify']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /SWFTE_VERIFY_UNCHECKED/);
    assert.doesNotMatch(r.out, /SWFTE_VERIFY_OK/);
  });

  test('an upgrades body that is not {items: []} (truncated to an empty 200, a string, items not an array) is exit 2', async () => {
    await baked();
    for (const bad of [{ raw: '' }, { body: 'ok' }, { body: { items: 'nope' } }, { body: { items: [42] } }, { body: [] }]) {
      route('GET', /^\/v2\/catalog\/upgrades$/, bad);
      const r = await cli(['verify']);
      assert.equal(r.code, 2, `${JSON.stringify(bad)} → ${r.out}`);
    }
  });

  test('a pinned artifact that vanished (no upgrade item) fails verify with exit 1 and says so', async () => {
    await baked();
    route('GET', /^\/v2\/catalog\/upgrades$/, { body: { items: [] } });
    const r = await cli(['verify']);
    assert.equal(r.code, 1);
    assert.match(r.err, /workflow:wf_1.*(deleted|no longer|gone|not found)/i);
    assert.match(r.out, /SWFTE_VERIFY_FAILED/);
  });

  test('a pinned artifact the backend reports as 404 / "not found" fails verify with exit 1', async () => {
    await baked();
    route('GET', /^\/v2\/catalog\/upgrades$/, (req) => ({
      body: { items: [{ catalogRef: 'workflow:wf_1', currentHash: String(req.query.refs).split(':').pop(), latestHash: null, breaking: false, capabilityChanges: [], requiresReapproval: false, summary: 'not found' }] },
    }));
    const r = await cli(['verify']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[vanished\]/);
  });

  test('breaking:"true" and requiresReapproval:1 are read as true (fail closed)', async () => {
    await baked();
    route('GET', /^\/v2\/catalog\/upgrades$/, (req) => ({
      body: { items: [{ catalogRef: 'workflow:wf_1', currentHash: 'x', latestHash: 'sha256:ffff', breaking: 'true', requiresReapproval: 1, capabilityChanges: [], summary: 's' }] },
    }));
    const r = await cli(['verify']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[breaking\]/);
    assert.match(r.err, /\[reapproval\]/);
  });

  test('an unrecognised flag value ("maybe") is treated as true, never as false', async () => {
    await baked();
    route('GET', /^\/v2\/catalog\/upgrades$/, { body: { items: [{ catalogRef: 'workflow:wf_1', latestHash: 'sha256:ffff', breaking: 'maybe', requiresReapproval: false, capabilityChanges: [] }] } });
    assert.equal((await cli(['verify'])).code, 1);
  });
});

/* ── N4: sync never re-pins when upgrades is unavailable ──────────────────── */

describe('BT-N4 swfte sync holds a moved contract when the upgrades check is unavailable', () => {
  test('upgrades down (503): the moved contract is held, the pin does not move, exit is non-zero', async () => {
    await baked('--no-pin');
    const before = read('swfte.json');
    const client = read('swfte/lead-scorer.ts');
    contract.outputSchema = { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } } };
    route('GET', /^\/v2\/catalog\/upgrades$/, { status: 503, body: { code: 'STORE_UNAVAILABLE' } });
    const r = await cli(['sync']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /upgrade check unavailable|could not be vetted/i);
    assert.equal(read('swfte.json'), before, 'the pin moved without a capability check');
    assert.equal(read('swfte/lead-scorer.ts'), client);
    // …and the next verify is not silently green against a new pin.
    route('GET', /^\/v2\/catalog\/upgrades$/, (req) => ({
      body: { items: [{ catalogRef: 'workflow:wf_1', currentHash: String(req.query.refs).split(':').pop(), latestHash: effectiveContractHash(contract).hash, breaking: false, requiresReapproval: true, capabilityChanges: ['new egress: http'] }] },
    }));
    assert.equal((await cli(['verify'])).code, 1);
  });

  test('upgrades returning a truncated body is unavailable too: the moved contract is held', async () => {
    await baked('--no-pin');
    const before = read('swfte.json');
    contract.outputSchema = { type: 'object', properties: { score: { type: 'number' }, extra: { type: 'string' } } };
    route('GET', /^\/v2\/catalog\/upgrades$/, { raw: '{"items":[' });
    const r = await cli(['sync']);
    assert.notEqual(r.code, 0);
    assert.equal(read('swfte.json'), before);
  });

  test('upgrades down during `swfte upgrade`: the pin is not moved past an unvetted change', async () => {
    await baked();
    const before = read('swfte.json');
    contract.outputSchema = { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } } };
    contract.version = 'v4';
    route('GET', /^\/v2\/catalog\/upgrades$/, { status: 503, body: {} });
    const r = await cli(['upgrade', 'lead-scorer']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /could not be vetted/);
    assert.equal(read('swfte.json'), before);
    assert.equal(JSON.parse(before).artifacts[0].pinnedVersion, 'v3');
  });

  test('a pinned artifact is never re-pinned by sync, whatever upstream publishes', async () => {
    await baked();
    const before = read('swfte.json');
    contract.outputSchema = { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } } };
    contract.version = 'v4';
    route('GET', /^\/v2\/catalog\/upgrades$/, { status: 503, body: {} });
    const r = await cli(['sync']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Pinned to v3.*swfte upgrade lead-scorer/s);
    assert.equal(read('swfte.json'), before);
    assert.match(read('swfte/lead-scorer.ts'), /\/v2\/workflows\/wf_1\/versions\/v3\/invoke/);
  });

  test('upgrades down but nothing moved: sync is a clean no-op (exit 0)', async () => {
    await baked();
    route('GET', /^\/v2\/catalog\/upgrades$/, { status: 503, body: {} });
    const r = await cli(['sync']);
    assert.equal(r.code, 0, r.out);
  });
});

/* ── N8 / N9: no secret in logs, bounded wait ────────────────────────────── */

describe('BT-N8/N9 CLI hygiene', () => {
  test('a credential embedded in SWFTE_BASE_URL is refused and never echoed', async () => {
    const key = 'sk-swfte-embeddedsecretvalue123';
    const r = await cli(['add', 'workflow:wf_1'], { SWFTE_API_KEY: CREDENTIAL, SWFTE_BASE_URL: `http://u:${key}@127.0.0.1:9/agents` });
    assert.notEqual(r.code, 0);
    assert.ok(!(r.out + r.err).includes(key), 'the embedded credential reached stderr');
    assert.ok(!(r.out + r.err).includes(CREDENTIAL));
    assert.equal(seen.length, 0, 'a request went out with the embedded credential');
  });

  test('network errors are printed without the configured credential', async () => {
    catalogRoutes();
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED (Bearer ${CREDENTIAL})`);
    }) as typeof fetch;
    const r = await cli(['add', 'workflow:wf_1']);
    assert.notEqual(r.code, 0);
    assert.ok(!r.err.includes(CREDENTIAL), r.err);
  });

  test('verify gives up on a backend that never answers within the SWFTE_TIMEOUT_MS budget (exit 2)', async () => {
    await baked();
    route('GET', /^\/v2\/catalog\/upgrades$/, { hang: true });
    const started = Date.now();
    const r = await cli(['verify'], { SWFTE_API_KEY: CREDENTIAL, SWFTE_TIMEOUT_MS: '400' });
    assert.equal(r.code, 2, r.out + r.err);
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  });
});

/* ── N11: stack detection ────────────────────────────────────────────────── */

describe('BT-N11 stack detection', () => {
  test('a package.json with a UTF-8 BOM is read', () => {
    writeFileSync(join(tmp, 'package.json'), `﻿${JSON.stringify({ dependencies: { express: '4' } })}`);
    assert.equal(detectStack(tmp).framework, 'express');
  });

  test('"fastapi" in pyproject keywords is not a dependency', () => {
    writeFileSync(
      join(tmp, 'pyproject.toml'),
      '[project]\nname = "svc"\nkeywords = ["fastapi", "demo"]\ndependencies = ["flask>=3"]\n'
    );
    const d = detectStack(tmp);
    assert.equal(d.framework, 'plain-python');
    assert.equal(d.detected, 'flask');
  });

  test('a monorepo root says where the workspaces are', () => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
    const d = detectStack(tmp);
    assert.ok(d.signals.some((s) => /workspaces|monorepo/i.test(s) && /--cwd/.test(s)), d.signals.join('\n'));
  });
});
