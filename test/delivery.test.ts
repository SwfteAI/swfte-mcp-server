/**
 * Cross-organisation delivery (leaf-2.24, agents-service #452): swfte_deliver,
 * swfte_handover_record, swfte_adopt's sourceWorkspaceId, and the default tool
 * surface they joined.
 *
 * Every test runs the real SwfteClient against a mocked global `fetch`, in a
 * throwaway project directory, so request paths, query strings, headers and
 * bodies are the ones that would go on the wire, and file writes are real.
 * File-safety cases assert the side effect that matters (nothing fetched,
 * nothing written, the outside file untouched), not only the error text.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';

import { loadConfig, DEFAULT_GROUPS } from '../src/config.js';
import { SwfteApiError, SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { buildServer, selectTools } from '../src/server.js';

const CREDENTIAL = 'pat_deliverercredential123';
// Telemetry off: these suites pin each tool's own requests.
const config = () => loadConfig({ SWFTE_PAT: CREDENTIAL, SWFTE_TELEMETRY: '0' } as never);

/* ── mocked fetch ────────────────────────────────────────────────────────── */

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>;
}
interface Reply {
  status?: number;
  body?: unknown;
  /** A raw (non-JSON) body, sent as-is with `contentType`. */
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

let seen: Seen[] = [];
let routes: Array<[string, RegExp, (req: Seen) => Reply]> = [];
const realFetch = globalThis.fetch;

function route(method: string, pattern: RegExp, reply: Reply | ((req: Seen) => Reply)) {
  routes.unshift([method, pattern, typeof reply === 'function' ? reply : () => reply]);
}

function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/agents/, '');
    const req: Seen = {
      method: String(init.method ?? 'GET'),
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers ?? {},
    };
    seen.push(req);
    const hit = routes.find(([m, re]) => m === req.method && re.test(path));
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE', message: `${req.method} ${path}` }), { status: 404 });
    const out = hit[2](req);
    if (out.text !== undefined) {
      return new Response(out.text, { status: out.status ?? 200, headers: { 'content-type': out.contentType ?? 'text/plain', ...out.headers } });
    }
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json', ...out.headers },
    });
  }) as typeof fetch;
}

const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
};
const run = (name: string, input: unknown, extra: Record<string, unknown> = {}) =>
  tool(name).execute(tool(name).inputSchema.parse(input) as never, { client: new SwfteClient(config()), config: config(), ...extra }) as Promise<any>;

/** The same call through the MCP server, as a client sees it (isError + text). */
async function viaServer(name: string, args: Record<string, unknown>) {
  const server: any = buildServer({ config: config(), resolveClient: () => new SwfteClient(config()) });
  const res = await server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, {});
  return { isError: Boolean(res.isError), text: String(res.content?.[0]?.text ?? '') };
}

/** The error a rejected promise carried, for asserting on its fields. */
async function failure(p: Promise<unknown>): Promise<SwfteApiError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SwfteApiError, `expected a SwfteApiError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected the call to fail');
}

/* ── fixtures ────────────────────────────────────────────────────────────── */

const DELIVER_PATH = /^\/v2\/catalog\/workflow\/wf_1\/deliver$/;
const TARGET = 'ws_customer';

const adopted = (extra: Record<string, unknown> = {}) => ({
  catalogRef: 'workflow:wf_77',
  kind: 'workflow',
  id: 'wf_77',
  forkedFrom: 'workflow:wf_1',
  tailoringApplied: false,
  tailoringSummary: null,
  needsInput: [],
  deployAction: null,
  replayed: false,
  degraded: [],
  euAiActNotice: 'Tailoring this … may make you its provider under the EU AI Act (Article 25).',
  providerRoleAcknowledged: false,
  mode: 'copy',
  binding: null,
  licence: 'MIT',
  attributedTo: { catalogRef: 'workflow:wf_1', licence: 'MIT' },
  ...extra,
});

const delivered = (extra: Record<string, unknown> = {}) => ({ targetWorkspaceId: TARGET, grantId: 'dg_1', delivered: adopted(extra) });

const NOT_FOUND = { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Catalog entry workflow:wf_1 not found', status: 404 };
const ACK_REQUIRED = {
  error: 'UNPROCESSABLE_ENTITY',
  code: 'PROVIDER_ROLE_ACK_REQUIRED',
  message: 'Tailoring this, or using it for a different purpose than its author intended, may make you its provider under the EU AI Act (Article 25). Send acknowledgeProviderRole: true to continue.',
  status: 422,
};

const HANDOVER_PATH = /^\/v2\/catalog\/workflow\/wf_77\/handover$/;
const RUNBOOK = '# Handover: workflow:wf_77\n\n| | |\n|---|---|\n| Artifact | workflow `wf_77` |\n\n## Contract\n\n- Licence: `MIT`\n';
const markdownReply = (text = RUNBOOK): Reply => ({
  text,
  contentType: 'text/markdown;charset=UTF-8',
  headers: { 'content-disposition': 'attachment; filename="HANDOVER-workflow-wf_77.md"' },
});

/* ── lifecycle ───────────────────────────────────────────────────────────── */

let tmp = '';
let outside = '';
let prevCwd = '';
beforeEach(() => {
  seen = [];
  routes = [];
  installFetch();
  prevCwd = process.cwd();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-deliver-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-deliver-outside-')));
  process.chdir(tmp);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/* ── swfte_deliver ───────────────────────────────────────────────────────── */

describe('swfte_deliver', () => {
  test('swfte_deliver happy path (copy): one POST to /deliver with the target, reported as a copy in the customer workspace', async () => {
    route('POST', DELIVER_PATH, { status: 201, body: delivered({ needsInput: ['connection:slack', 'approvalChannel'] }) });
    const res = await run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, name: 'Claims router' });

    assert.equal(seen.length, 1, 'a delivery is one POST; nothing else is called');
    const req = seen[0]!;
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.body, { targetWorkspaceId: TARGET, name: 'Claims router' });
    // Works with a PAT: bearer only, no X-API-Key copy of the secret.
    assert.equal(req.headers.Authorization, `Bearer ${CREDENTIAL}`);
    assert.equal(req.headers['X-API-Key'], undefined);

    assert.equal(res.delivered, true);
    assert.equal(res.mode, 'copy');
    assert.equal(res.targetWorkspaceId, TARGET);
    assert.equal(res.grantId, 'dg_1');
    assert.equal(res.catalogRef, 'workflow:wf_77');
    assert.equal(res.forkedFrom, 'workflow:wf_1');
    assert.equal(res.licence, 'MIT');
    assert.deepEqual(res.missingConnections, ['slack']);
    const steps = res.nextSteps.join('\n');
    assert.match(steps, /customer's workspace ws_customer/);
    assert.match(steps, /The customer connects slack in their own workspace/);
    assert.match(steps, /swfte_connect_start here would connect YOUR workspace/);
    assert.match(steps, /approvalChannel/);
    assert.match(steps, /swfte_handover_record \{catalogRef:"workflow:wf_77"\}/);
  });

  test('swfte_deliver binding mode: a proprietary entry is bound, nothing copied, the invoke path surfaced', async () => {
    route('POST', DELIVER_PATH, {
      status: 201,
      body: delivered({
        catalogRef: 'workflow:wf_1',
        id: 'wf_1',
        forkedFrom: null,
        mode: 'binding',
        licence: 'proprietary',
        needsInput: [],
        binding: {
          bindingId: 'bnd_1',
          catalogRef: 'workflow:wf_1',
          kind: 'workflow',
          licence: 'proprietary',
          pinnedVersion: 'v3',
          contractHash: 'abc',
          status: 'ACTIVE',
          createdAt: '2026-09-24T00:00:00Z',
          invoke: { method: 'POST', path: '/v2/catalog/bindings/bnd_1/invoke', auth: 'pat', async: true },
          notice: 'This entry is proprietary: you can use it hosted, not copy it.',
        },
      }),
    });
    const res = await run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, deploy: { environment: 'staging' } });
    assert.equal(res.delivered, true);
    assert.equal(res.mode, 'binding');
    assert.equal(res.deployAction, null);
    assert.match(res.deployNote, /nothing to deploy in the customer's workspace/, 'a binding has no deploy to propose');
    assert.equal(res.forkedFrom, null, 'a binding is not a fork');
    assert.equal(res.binding.bindingId, 'bnd_1');
    assert.equal(res.binding.invoke.path, '/v2/catalog/bindings/bnd_1/invoke');
    assert.match(res.bindingNote, /Nothing was copied/);
    assert.match(res.bindingNote, /The customer calls it with POST \/v2\/catalog\/bindings\/bnd_1\/invoke \(auth: pat; async/);
    assert.ok(!res.nextSteps.some((s: string) => /swfte_handover_record|swfte_scaffold_client/.test(s)), 'no copy-only steps for a binding');
  });

  test('swfte_deliver 404 no-grant: explained in words (ask for a delivery grant), without claiming which cause', async () => {
    route('POST', DELIVER_PATH, { status: 404, body: NOT_FOUND });
    const err = await failure(run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET }));
    assert.equal(err.status, 404);
    assert.equal(err.code, 'NOT_FOUND');
    const hint = String(err.suggestedAction);
    assert.match(hint, /deliberately indistinguishable/);
    assert.match(hint, /Studio → Settings → Delivery grants/);
    assert.match(hint, /at most 30 days/);
    assert.match(hint, /does not say which, so this tool cannot either/);
    assert.equal(seen.length, 1, 'a 404 is an answer, not something to retry');

    // What an MCP client sees: an error carrying the explanation, not a bare 404.
    const surfaced = await viaServer('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET });
    assert.equal(surfaced.isError, true);
    assert.match(JSON.parse(surfaced.text).suggestedAction, /delivery grant/);
  });

  test('swfte_deliver Art. 25: a 422 becomes a question for the human, and only the acknowledged retry sends acknowledgeProviderRole + intendedPurpose', async () => {
    route('POST', DELIVER_PATH, { status: 422, body: ACK_REQUIRED });
    const asked = await run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, problem: 'route motor claims' });
    assert.equal(asked.delivered, false);
    assert.equal(asked.needsAcknowledgement, true);
    assert.match(asked.notice, /Article 25/);
    assert.match(asked.nextStep, /ASK them/);
    assert.match(asked.nextStep, /call swfte_deliver again with acknowledgeProviderRole:true and intendedPurpose/);
    assert.match(asked.nextStep, /Do not acknowledge on their behalf/);
    assert.equal(seen[0]!.body.acknowledgeProviderRole, undefined, 'never acknowledged on the user\'s behalf');
    assert.equal(seen[0]!.body.intendedPurpose, undefined);

    // Surfaced as a question, not an error.
    const surfaced = await viaServer('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, problem: 'route motor claims' });
    assert.equal(surfaced.isError, false);

    // The human said yes, in their own words.
    route('POST', DELIVER_PATH, { status: 201, body: delivered({ tailoringApplied: true, providerRoleAcknowledged: true }) });
    const res = await run('swfte_deliver', {
      catalogRef: 'workflow:wf_1',
      targetWorkspaceId: TARGET,
      problem: 'route motor claims',
      acknowledgeProviderRole: true,
      intendedPurpose: 'Route motor claims for the customer\'s brokerage',
      annexIII: 'none',
    });
    const last = seen[seen.length - 1]!;
    assert.equal(last.body.acknowledgeProviderRole, true);
    assert.equal(last.body.intendedPurpose, 'Route motor claims for the customer\'s brokerage');
    assert.equal(last.body.annexIII, 'none');
    assert.equal(last.body.tailoring.problem, 'route motor claims');
    assert.equal(res.delivered, true);

    // false is not an acknowledgement either.
    await run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, problem: 'p', acknowledgeProviderRole: false });
    assert.equal(seen[seen.length - 1]!.body.acknowledgeProviderRole, undefined);
  });

  test('swfte_deliver LICENCE_FORBIDS_COPY: tailoring a proprietary entry is explained — deliver without tailoring for a binding', async () => {
    route('POST', DELIVER_PATH, {
      status: 422,
      body: { error: 'UNPROCESSABLE_ENTITY', code: 'LICENCE_FORBIDS_COPY', message: 'This entry is proprietary: you can use it hosted, not copy it. Tailoring needs a copy, and the licence (proprietary) does not allow one.', status: 422 },
    });
    const res = await run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, problem: 'p', acknowledgeProviderRole: true, intendedPurpose: 'our purpose' });
    assert.equal(res.delivered, false);
    assert.equal(res.licenceForbidsCopy, true);
    assert.match(res.notice, /proprietary/);
    assert.match(res.nextStep, /call swfte_deliver again WITHOUT problem, stack and notes/i);
    assert.match(res.nextStep, /hosted binding/);
  });

  test('swfte_deliver sends the idempotency key as the Idempotency-Key header and in the body; a replay is reported', async () => {
    route('POST', DELIVER_PATH, { status: 200, body: delivered({ replayed: true }) });
    const res = await run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, idempotencyKey: 'dlv-2026-09-24-001' });
    const req = seen[0]!;
    assert.equal(req.headers['Idempotency-Key'], 'dlv-2026-09-24-001');
    assert.equal(req.body.idempotencyKey, 'dlv-2026-09-24-001');
    assert.equal(res.replayed, true);
    // The server's key grammar is enforced before anything is sent.
    const schema = tool('swfte_deliver').inputSchema as z.ZodTypeAny;
    assert.equal(schema.safeParse({ catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, idempotencyKey: 'short' }).success, false);
    assert.equal(schema.safeParse({ catalogRef: 'workflow:wf_1', targetWorkspaceId: 'ws/../x' }).success, false);
  });

  test('swfte_deliver deploy is only PROPOSED for the customer\'s approvers — never executed, never approvable by the deliverer', async () => {
    route('POST', DELIVER_PATH, {
      status: 201,
      body: delivered({
        deployAction: { id: 'act_9', capability: 'workflow.deploy', target: { kind: 'workflow', id: 'wf_77' }, params: {}, environment: 'staging', status: 'PROPOSED', requiresApproval: true, requestedBy: 'fde_1', approvedBy: null, expiresAt: '2026-10-01T00:00:00Z', result: null },
      }),
    });
    const res = await run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, deploy: { environment: 'staging' } });
    assert.equal(seen.length, 1, 'nothing is executed');
    assert.deepEqual(seen[0]!.body.deploy, { environment: 'staging' });
    assert.equal(res.deployAction.status, 'PROPOSED');
    assert.match(res.deployAction.instructions, /CUSTOMER's workspace, for the customer's approvers/);
    assert.match(res.deployAction.instructions, /do not call swfte_execute_approved_action/);
    assert.match(res.deployNote, /only PROPOSED/);
    assert.ok(!JSON.stringify(res).includes('swfte_execute_approved_action {actionId'), 'the deliverer is never told to execute it');
  });

  test('swfte_deliver: a rate limit and an unavailable binding are explained, and never blindly retried', async () => {
    route('POST', DELIVER_PATH, { status: 429, body: { error: 'TOO_MANY_REQUESTS', code: 'RATE_LIMITED', message: 'Too many deliveries; try again in a minute', status: 429 } });
    const limited = await failure(run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET, idempotencyKey: 'dlv-key-0001' }));
    assert.match(String(limited.suggestedAction), /30 per minute/);
    assert.match(String(limited.suggestedAction), /SAME idempotencyKey/);
    assert.equal(seen.length, 1, 'a delivery POST is not retried');

    route('POST', DELIVER_PATH, { status: 503, body: { error: 'SERVICE_UNAVAILABLE', code: 'BINDING_UNAVAILABLE', message: 'unavailable', status: 503 } });
    const down = await failure(run('swfte_deliver', { catalogRef: 'workflow:wf_1', targetWorkspaceId: TARGET }));
    assert.match(String(down.suggestedAction), /a copy is never the fallback/);
    assert.equal(seen.length, 2);
  });
});

/* ── swfte_handover_record ───────────────────────────────────────────────── */

describe('swfte_handover_record', () => {
  test('swfte_handover_record writes the Markdown runbook inside the project root, under the server\'s file name', async () => {
    route('GET', HANDOVER_PATH, markdownReply());
    const res = await run('swfte_handover_record', { catalogRef: 'workflow:wf_77' });
    const req = seen[0]!;
    assert.equal(req.method, 'GET');
    assert.equal(req.query.format, 'markdown');
    assert.match(req.headers.Accept, /text\/markdown/);
    assert.equal(readFileSync(join(tmp, 'HANDOVER-workflow-wf_77.md'), 'utf8'), RUNBOOK);
    assert.equal(res.file, 'HANDOVER-workflow-wf_77.md');
    assert.deepEqual(res.written.map((w: any) => [w.path, w.action]), [['HANDOVER-workflow-wf_77.md', 'create']]);

    // A targetFile inside the root is honoured, directories created.
    await run('swfte_handover_record', { catalogRef: 'workflow:wf_77', targetFile: 'docs/handover/HANDOVER.md' });
    assert.equal(readFileSync(join(tmp, 'docs/handover/HANDOVER.md'), 'utf8'), RUNBOOK);
  });

  test('swfte_handover_record refuses an absolute path outside the project root, fetching and writing nothing', async () => {
    route('GET', HANDOVER_PATH, markdownReply());
    const victim = join(outside, 'HANDOVER.md');
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77', targetFile: victim }), /outside the working directory/);
    assert.equal(existsSync(victim), false);
    assert.equal(seen.length, 0, 'confinement is checked before anything is fetched');
  });

  test('swfte_handover_record refuses a ../ escape out of the project root', async () => {
    route('GET', HANDOVER_PATH, markdownReply());
    const rel = join('..', outside.split('/').pop()!, 'HANDOVER.md');
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77', targetFile: rel }), /outside the working directory/);
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77', targetFile: 'docs/../../escape.md' }), /outside the working directory/);
    assert.equal(existsSync(join(outside, 'HANDOVER.md')), false);
    assert.equal(seen.length, 0);
  });

  test('swfte_handover_record refuses a symlink that points outside the project root (directory or file)', async () => {
    route('GET', HANDOVER_PATH, markdownReply());
    // A directory link leading out of the tree.
    symlinkSync(outside, join(tmp, 'docs-link'));
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77', targetFile: 'docs-link/HANDOVER.md' }), /symlink/);
    assert.equal(existsSync(join(outside, 'HANDOVER.md')), false);

    // A file link at the default name, pointing at a file outside: never written through.
    writeFileSync(join(outside, 'victim.md'), 'untouched');
    symlinkSync(join(outside, 'victim.md'), join(tmp, 'HANDOVER-workflow-wf_77.md'));
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77', force: true }), /symlink/);
    assert.equal(readFileSync(join(outside, 'victim.md'), 'utf8'), 'untouched');
  });

  test('swfte_handover_record never overwrites a different existing file unless force:true (the writers\' overwrite rule)', async () => {
    route('GET', HANDOVER_PATH, markdownReply());
    writeFileSync(join(tmp, 'HANDOVER-workflow-wf_77.md'), '# my notes\n');
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77' }), /Refusing to overwrite existing file\(s\): HANDOVER-workflow-wf_77\.md/);
    assert.equal(readFileSync(join(tmp, 'HANDOVER-workflow-wf_77.md'), 'utf8'), '# my notes\n');

    const forced = await run('swfte_handover_record', { catalogRef: 'workflow:wf_77', force: true });
    assert.equal(forced.written[0].action, 'overwrite');
    assert.equal(readFileSync(join(tmp, 'HANDOVER-workflow-wf_77.md'), 'utf8'), RUNBOOK);

    // Identical content is not an overwrite at all.
    const again = await run('swfte_handover_record', { catalogRef: 'workflow:wf_77' });
    assert.equal(again.written[0].action, 'unchanged');
  });

  test('swfte_handover_record 404 with no handover taken yet explains that the handover is taken in Studio first', async () => {
    route('GET', HANDOVER_PATH, { status: 404, body: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Handover record not found', status: 404 } });
    const err = await failure(run('swfte_handover_record', { catalogRef: 'workflow:wf_77' }));
    assert.equal(err.status, 404);
    assert.match(String(err.suggestedAction), /No handover has been taken for this entry yet/);
    assert.match(String(err.suggestedAction), /interactive session only/);
    assert.equal(existsSync(join(tmp, 'HANDOVER-workflow-wf_77.md')), false);
  });

  test('swfte_handover_record 404 for an entry outside this workspace says the record lives in the customer workspace', async () => {
    route('GET', HANDOVER_PATH, { status: 404, body: { error: 'NOT_FOUND', code: 'NOT_FOUND', message: 'Catalog entry workflow:wf_77 not found', status: 404 } });
    const err = await failure(run('swfte_handover_record', { catalogRef: 'workflow:wf_77' }));
    assert.match(String(err.suggestedAction), /not in the workspace this credential is bound to/);
    assert.match(String(err.suggestedAction), /CUSTOMER's workspace/);
  });

  test('swfte_handover_record says the handover itself is Studio-only (403 SESSION_REQUIRED) and only ever reads', async () => {
    const t = tool('swfte_handover_record');
    assert.match(t.description, /Studio-only/);
    assert.match(t.description, /403 SESSION_REQUIRED/);
    route('GET', HANDOVER_PATH, markdownReply());
    const res = await run('swfte_handover_record', { catalogRef: 'workflow:wf_77' });
    assert.match(res.handover, /Studio-only/);
    assert.match(res.handover, /403 SESSION_REQUIRED/);
    assert.ok(seen.every((r) => r.method === 'GET'), 'no tool call takes a handover');
    assert.ok(!allTools.some((x) => /handover/.test(x.name) && x.name !== 'swfte_handover_record'), 'there is no tool that takes a handover');
  });

  test('swfte_handover_record on a hosted server returns the file inline and writes nothing to its own disk', async () => {
    route('GET', HANDOVER_PATH, markdownReply());
    const res = await run('swfte_handover_record', { catalogRef: 'workflow:wf_77' }, { localFilesystem: false });
    assert.equal(res.inline, true);
    assert.equal(res.written[0].content, RUNBOOK);
    assert.equal(existsSync(join(tmp, 'HANDOVER-workflow-wf_77.md')), false);
  });

  test('swfte_handover_record refuses a non-Markdown answer or secret-shaped content, writing nothing', async () => {
    route('GET', HANDOVER_PATH, { body: { handoverId: 'hov_1' } });
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77' }), /Expected a Markdown runbook/);
    route('GET', HANDOVER_PATH, markdownReply(`${RUNBOOK}\nkey: sk-swfte-LEAKEDLEAKED123\n`));
    await assert.rejects(run('swfte_handover_record', { catalogRef: 'workflow:wf_77' }), /secret-shaped/);
    assert.equal(existsSync(join(tmp, 'HANDOVER-workflow-wf_77.md')), false);
  });
});

/* ── swfte_adopt: sourceWorkspaceId, and the readings it shares with deliver ─ */

describe('swfte_adopt from another workspace', () => {
  test('swfte_adopt sends sourceWorkspaceId as a query parameter, never in the body', async () => {
    route('POST', /^\/v2\/catalog\/workflow\/wf_1\/adopt$/, { status: 201, body: adopted({ catalogRef: 'workflow:wf_8', id: 'wf_8' }) });
    const res = await run('swfte_adopt', { catalogRef: 'workflow:wf_1', sourceWorkspaceId: 'ws_team' });
    assert.equal(seen[0]!.query.sourceWorkspaceId, 'ws_team');
    assert.equal(seen[0]!.body.sourceWorkspaceId, undefined);
    assert.equal(res.catalogRef, 'workflow:wf_8');
    // Without it, no query string at all.
    await run('swfte_adopt', { catalogRef: 'workflow:wf_1' });
    assert.deepEqual(seen[1]!.query, {});
  });

  test('swfte_adopt with sourceWorkspaceId: a 404 says "not there, or not a member" without choosing', async () => {
    route('POST', /\/adopt$/, { status: 404, body: NOT_FOUND });
    const err = await failure(run('swfte_adopt', { catalogRef: 'workflow:wf_1', sourceWorkspaceId: 'ws_team' }));
    assert.match(String(err.suggestedAction), /or you are not a member of it/);
  });

  test('swfte_adopt reads a binding and LICENCE_FORBIDS_COPY exactly as swfte_deliver does', async () => {
    route('POST', /\/adopt$/, {
      status: 201,
      body: adopted({ catalogRef: 'workflow:wf_1', forkedFrom: null, mode: 'binding', needsInput: ['deploy: a binding runs the author\'s published version; there is nothing to deploy in your workspace'], binding: { bindingId: 'bnd_2', licence: 'proprietary', invoke: { method: 'POST', path: '/v2/catalog/bindings/bnd_2/invoke', auth: 'pat', async: false } } }),
    });
    const bound = await run('swfte_adopt', { catalogRef: 'workflow:wf_1' });
    assert.equal(bound.mode, 'binding');
    assert.equal(bound.forkedFrom, null);
    assert.match(bound.bindingNote, /Nothing was copied/);
    assert.ok(bound.nextSteps.some((s: string) => /Call it through the binding: POST \/v2\/catalog\/bindings\/bnd_2\/invoke/.test(s)));
    assert.ok(!bound.nextSteps.some((s: string) => /swfte_scaffold_client|swfte_request_approval|Answer the open inputs/.test(s)));

    route('POST', /\/adopt$/, { status: 422, body: { error: 'UNPROCESSABLE_ENTITY', code: 'LICENCE_FORBIDS_COPY', message: 'proprietary', status: 422 } });
    const refused = await run('swfte_adopt', { catalogRef: 'workflow:wf_1', problem: 'p', acknowledgeProviderRole: true });
    assert.equal(refused.adopted, false);
    assert.equal(refused.licenceForbidsCopy, true);
    assert.match(refused.nextStep, /call swfte_adopt again WITHOUT problem/i);
  });
});

/* ── default tool surface ────────────────────────────────────────────────── */

describe('default tool groups with the delivery tools', () => {
  test('DEFAULT_GROUPS is unchanged; swfte_deliver and swfte_handover_record are core and advertised in a stock install, and the change is documented', () => {
    assert.deepEqual(DEFAULT_GROUPS, ['core', 'workflows', 'agents', 'chatflows', 'datasets', 'modules', 'deployments', 'connect']);
    for (const name of ['swfte_deliver', 'swfte_handover_record']) assert.equal(tool(name).group, 'core', `${name} is core`);

    const stock = selectTools(allTools, config()).map((t) => t.name);
    assert.ok(stock.includes('swfte_deliver') && stock.includes('swfte_handover_record'));
    assert.equal(stock.length, 105, 'the default surface grew by exactly the two delivery tools');

    // Core: no group filter hides them.
    const voiceOnly = selectTools(allTools, loadConfig({ SWFTE_PAT: CREDENTIAL, SWFTE_TOOLS: 'voice' } as never)).map((t) => t.name);
    assert.ok(voiceOnly.includes('swfte_deliver') && voiceOnly.includes('swfte_handover_record'));

    const configText = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    assert.match(configText, /swfte_deliver/);
    assert.match(configText, /ceiling moved 103 → 105/);
    const attach = readFileSync(new URL('../docs/ATTACH.md', import.meta.url), 'utf8');
    assert.match(attach, /default surface grew from 103 to 105 because `swfte_deliver` and\n`swfte_handover_record` joined `core`/);
  });
});
