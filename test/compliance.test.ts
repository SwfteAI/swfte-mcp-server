/**
 * Compliance control plane tools (CONTRACT rev 7), `swfte verify --compliance`,
 * the scan after `swfte add`, and the credential-host allow-list (black-hat H1).
 *
 * Everything runs against a mocked global fetch that records the full URL, so
 * "which host got the credential" and "which files were uploaded" are asserted
 * on what would actually go over the wire.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { runCli } from '../src/cli.js';
import { stableStringify } from '../src/catalog.js';
import { batchFiles, FORBIDDEN_WORDS, globToRegExp, scanVerdict, sha256Hex, signedPayload, SCAN_LIMITS } from '../src/compliance.js';
import { allowedHosts, assertLockBaseUrl, credentialBaseUrl, isAllowedHost, UntrustedHostError } from '../src/hosts.js';

const CREDENTIAL = 'pat_supersecretcredential123';
const config = () => loadConfig({ SWFTE_PAT: CREDENTIAL } as never);

/* ── mocked fetch ────────────────────────────────────────────────────────── */

interface Seen {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>;
}
type Handler = (req: Seen) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | undefined;
let seen: Seen[] = [];
let routes: Array<[string, RegExp, Handler]> = [];
const realFetch = globalThis.fetch;

function route(method: string, pattern: RegExp, handler: Handler | { status?: number; body?: unknown }) {
  routes.unshift([method, pattern, typeof handler === 'function' ? handler : () => handler]);
}
function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const req: Seen = {
      method: String(init.method ?? 'GET'),
      host: url.host,
      path: url.pathname.replace(/^\/agents/, ''),
      query: Object.fromEntries(url.searchParams.entries()),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers ?? {},
    };
    seen.push(req);
    const hit = routes.find(([m, re]) => m === req.method && re.test(req.path));
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE', message: `${req.method} ${req.path}` }), { status: 404 });
    const out = hit[2](req) ?? {};
    const text = out.text ?? (out.body === undefined ? '' : JSON.stringify(out.body));
    return new Response(text, { status: out.status ?? 200, headers: { 'content-type': out.text ? 'text/csv' : 'application/json', ...(out.headers ?? {}) } });
  }) as typeof fetch;
}

const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
};
const run = (name: string, input: unknown, extra: Record<string, unknown> = {}) =>
  tool(name).execute(input as never, { client: new SwfteClient(config()), config: config(), ...extra }) as Promise<any>;

let tmp = '';
let prevCwd = '';
beforeEach(() => {
  seen = [];
  routes = [];
  installFetch();
  prevCwd = process.cwd();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-compliance-')));
  process.chdir(tmp);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const write = (rel: string, content: string | Buffer) => {
  mkdirSync(join(tmp, rel, '..'), { recursive: true });
  writeFileSync(join(tmp, rel), content);
};

const scanCalls = () => seen.filter((s) => s.method === 'POST' && s.path === '/v2/compliance/scan');
const uploadedPaths = () => scanCalls().flatMap((s) => (s.body.files ?? []).map((f: any) => f.path)).sort();

/** A scan endpoint that flags any line containing `eval(` as HIGH and `console.log(ssn` as MEDIUM. */
function scanRoute() {
  route('POST', /^\/v2\/compliance\/scan$/, (req) => {
    const findings: any[] = [];
    for (const f of req.body.files ?? []) {
      String(f.content).split('\n').forEach((l: string, i: number) => {
        if (l.includes('eval(')) findings.push({ ruleId: 'eval', severity: 'HIGH', file: f.path, line: i + 1, excerpt: l, message: 'eval of dynamic input', remediation: 'Remove eval.', controls: ['OWASP_ASVS.V5.2.4'] });
        if (l.includes('console.log(ssn')) findings.push({ ruleId: 'pii-logging', severity: 'MEDIUM', file: f.path, line: i + 1, excerpt: l, message: 'PII logged', remediation: 'Do not log PII.', controls: ['SOC2.CC6.8'] });
      });
    }
    const summary = { critical: 0, high: findings.filter((x) => x.severity === 'HIGH').length, medium: findings.filter((x) => x.severity === 'MEDIUM').length, low: 0 };
    return {
      body: {
        scanId: `scn_${scanCalls().length}`,
        verdict: summary.high ? 'FAIL' : summary.medium ? 'PARTIAL' : 'PASS',
        findings,
        summary,
        filesScanned: (req.body.files ?? []).length,
        bytesScanned: 10,
        complete: true,
        coverageNotes: [],
        failingControls: [],
      },
    };
  });
}

/* ── assess ──────────────────────────────────────────────────────────────── */

const ASSESSMENT = {
  id: 'cas_1',
  workspaceId: 'ws1',
  target: { kind: 'workflow', id: 'wf_1' },
  contentHash: 'sha256:abc',
  catalogVersion: '2026.09.1',
  frameworks: ['SOC2', 'OWASP_LLM'],
  results: [
    { controlId: 'SOC2.CC6.1', frameworkId: 'SOC2', title: 'Access control', severity: 'HIGH', required: true, verdict: 'PASS', checks: [] },
    {
      controlId: 'OWASP_LLM.LLM01', frameworkId: 'OWASP_LLM', title: 'Prompt injection', severity: 'CRITICAL', required: true, verdict: 'FAIL',
      remediation: 'Add an input guard before the LLM node.',
      checks: [{ checkId: 'graph:guard-before-llm', verdict: 'FAIL', source: 'DETERMINISTIC', summary: 'LLM node n3 has no guard upstream', evidence: [{ type: 'node', ref: 'n3' }] }],
    },
    {
      controlId: 'SOC2.CC7.2', frameworkId: 'SOC2', title: 'Monitoring', severity: 'MEDIUM', required: true, verdict: 'UNAVAILABLE', remediation: 'Attest to monitoring.',
      checks: [{ checkId: 'attest:monitoring', verdict: 'UNAVAILABLE', source: 'ATTESTATION', summary: 'needs a person', unavailableReason: 'ATTESTATION_REQUIRED' }],
    },
  ],
  summary: { pass: 1, fail: 1, partial: 0, unavailable: 1, notApplicable: 0, requiredTotal: 3, requiredPassing: 1 },
  recordEligible: false,
  blockingControls: ['OWASP_LLM.LLM01', 'SOC2.CC7.2'],
  createdAt: '2026-09-23T10:00:00Z',
  assessedBy: 'u1',
  assessedVia: 'pat',
  ledgerHash: null,
  notes: [],
  verdictSource: 'deterministic',
};

describe('swfte_compliance_assess', () => {
  test('reports failing controls with remediation and shows UNAVAILABLE as not checked, never passing', async () => {
    route('POST', /^\/v2\/compliance\/assess$/, { body: ASSESSMENT });
    const out = await run('swfte_compliance_assess', { catalogRef: 'workflow:wf_1', frameworks: ['SOC2'] });
    const req = seen.find((s) => s.path === '/v2/compliance/assess')!;
    assert.deepEqual(req.body, { target: { kind: 'workflow', id: 'wf_1' }, frameworks: ['SOC2'] });
    assert.equal(out.ok, false);
    assert.equal(out.outcome, 'NOT_RECORD_ELIGIBLE');
    assert.equal(out.summary.passing, 1, 'UNAVAILABLE must not be folded into passing');
    assert.equal(out.summary.notChecked, 1);
    assert.deepEqual(out.failing.map((f: any) => f.controlId), ['OWASP_LLM.LLM01']);
    assert.equal(out.failing[0].remediation, 'Add an input guard before the LLM node.');
    assert.deepEqual(out.failing[0].failingChecks[0].evidence, [{ type: 'node', ref: 'n3' }]);
    assert.equal(out.notChecked[0].controlId, 'SOC2.CC7.2');
    assert.match(out.notChecked[0].status, /not checked/);
    assert.deepEqual(out.notChecked[0].reasons, ['ATTESTATION_REQUIRED']);
    assert.ok(out.nextSteps.some((s: string) => s.includes('studio.swfte.com/v2/studio/compliance?target=workflow%3Awf_1')));
    assert.doesNotMatch(JSON.stringify(out), FORBIDDEN_WORDS);
  });

  test('a record-eligible assessment is ok and names the record with its disclaimer', async () => {
    route('POST', /^\/v2\/compliance\/assess$/, { body: { ...ASSESSMENT, results: [ASSESSMENT.results[0]], recordEligible: true, blockingControls: [] } });
    const out = await run('swfte_compliance_assess', { target: { kind: 'agent', id: 'ag_1' } });
    assert.equal(out.ok, true);
    assert.match(out.wording, /Control Evidence Record — supports your audit; not an audit opinion\./);
  });

  test('an unassessable kind is refused before any request', async () => {
    await assert.rejects(run('swfte_compliance_assess', { catalogRef: 'widget:w1' }), /not assessable/);
    await assert.rejects(run('swfte_compliance_assess', { target: 'code:x' }), /Unknown kind/);
    assert.equal(seen.length, 0);
  });

  test('no compliance tool description uses forbidden wording', () => {
    for (const t of allTools.filter((x) => /compliance|evidence_record/.test(x.name))) {
      assert.doesNotMatch(t.description, FORBIDDEN_WORDS, t.name);
      assert.equal(t.group, 'core', `${t.name} must be core`);
    }
  });
});

/* ── scan_code ───────────────────────────────────────────────────────────── */

describe('swfte_compliance_scan_code', () => {
  test('reads local files through fsguard and returns findings by file, line and control', async () => {
    scanRoute();
    write('src/a.ts', 'const x = 1;\neval(userInput);\n');
    write('src/b.ts', 'console.log(ssn);\n');
    write('src/.env', 'SWFTE_API_KEY=pat_leakleakleak');
    write('src/big.ts', 'x'.repeat(SCAN_LIMITS.fileBytes + 1));
    write('src/img.ts', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    write('.gitignore', 'src/gen/\n');
    write('src/gen/skip.ts', 'eval(1)');
    const out = await run('swfte_compliance_scan_code', { paths: ['src'] });
    assert.deepEqual(uploadedPaths(), ['src/a.ts', 'src/b.ts']);
    assert.equal(out.verdict, 'FAIL');
    assert.equal(out.ok, false);
    assert.deepEqual(out.byFile['src/a.ts'], ['src/a.ts:2 HIGH eval [OWASP_ASVS.V5.2.4] eval of dynamic input']);
    assert.equal(out.findings[0].file, 'src/a.ts', 'HIGH sorts before MEDIUM');
    const reasons = Object.fromEntries(out.notScanned.map((n: any) => [n.path, n.reason]));
    assert.match(reasons['src/.env'], /credential file/);
    assert.match(reasons['src/big.ts'], /over 200 KB/);
    assert.match(reasons['src/img.ts'], /binary/);
    assert.equal(out.complete, false);
    assert.ok(!JSON.stringify(scanCalls()).includes('pat_leakleakleak'), 'a credential file was uploaded');
  });

  test('never reads outside the working directory: traversal, absolute paths and symlink escapes', async () => {
    scanRoute();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-outside-')));
    try {
      writeFileSync(join(outside, 'secret.ts'), 'eval(1)');
      symlinkSync(join(outside, 'secret.ts'), join(tmp, 'link.ts'));
      symlinkSync(outside, join(tmp, 'linkdir'));
      await assert.rejects(run('swfte_compliance_scan_code', { paths: ['../x.ts'] }), /outside the working directory/);
      await assert.rejects(run('swfte_compliance_scan_code', { paths: [join(outside, 'secret.ts')] }), /outside the working directory/);
      await assert.rejects(run('swfte_compliance_scan_code', { paths: ['linkdir/secret.ts'] }), /symlink|outside/);
      await assert.rejects(run('swfte_compliance_scan_code', { globs: ['../**/*.ts'] }), /may not contain/);
      write('ok.ts', 'const y = 2;');
      const out = await run('swfte_compliance_scan_code', { globs: ['**/*.ts'] });
      assert.deepEqual(uploadedPaths(), ['ok.ts'], 'a symlinked file or directory was followed');
      assert.equal(out.verdict, 'PASS');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('hosted mode refuses paths before any request but scans inline files', async () => {
    scanRoute();
    await assert.rejects(run('swfte_compliance_scan_code', { paths: ['src'] }, { localFilesystem: false }), /hosted MCP server/);
    assert.equal(seen.length, 0);
    const out = await run('swfte_compliance_scan_code', { files: [{ path: 'x.py', content: 'eval(a)' }] }, { localFilesystem: false });
    assert.equal(out.verdict, 'FAIL');
    assert.deepEqual(uploadedPaths(), ['x.py']);
  });

  test('batches at 50 files / 600 KB per request and merges the results', async () => {
    scanRoute();
    const files = Array.from({ length: 120 }, (_, i) => ({ path: `f${i}.ts`, content: 'a'.repeat(15_000) }));
    const batches = batchFiles(files);
    for (const b of batches) {
      assert.ok(b.length <= SCAN_LIMITS.batchFiles);
      assert.ok(b.reduce((n, f) => n + f.content.length + f.path.length, 0) <= SCAN_LIMITS.batchBytes);
    }
    const out = await run('swfte_compliance_scan_code', { files });
    assert.equal(scanCalls().length, batches.length);
    assert.ok(scanCalls().length >= 3);
    assert.equal(out.filesScanned, 120);
    assert.equal(out.verdict, 'PASS');
  });

  test('a batch the server could not scan makes the result UNAVAILABLE, never PASS', async () => {
    let n = 0;
    route('POST', /^\/v2\/compliance\/scan$/, () => (n++ === 0 ? { body: { scanId: 's', verdict: 'PASS', findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0 }, filesScanned: 50, bytesScanned: 1, complete: true } } : { status: 413, body: { error: 'SCAN_TOO_LARGE', message: 'too large' } }));
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.ts`, content: 'ok' }));
    const out = await run('swfte_compliance_scan_code', { files });
    assert.equal(out.verdict, 'UNAVAILABLE');
    assert.equal(out.ok, false);
    assert.equal(out.batchErrors.length, 1);
    assert.equal(scanVerdict({ critical: 0, high: 0, medium: 0, low: 0 }, false), 'UNAVAILABLE');
  });

  test('glob matcher', () => {
    assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
    assert.ok(globToRegExp('src/**/*.ts').test('src/c.ts'));
    assert.ok(!globToRegExp('src/*.ts').test('src/a/c.ts'));
    assert.ok(globToRegExp('*.{ts,py}').test('x.py'));
  });
});

/* ── evidence records, export, history ───────────────────────────────────── */

function ed25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { publicKeyHex: raw.toString('hex'), sign: (msg: string) => sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex') };
}

function signedRecord(k: ReturnType<typeof ed25519>, extra: Record<string, unknown> = {}) {
  const rec: Record<string, any> = {
    id: 'cer_1', recordType: 'control-evidence-record', workspaceId: 'ws1', target: { kind: 'workflow', id: 'wf_1' }, assessmentId: 'cas_1',
    contentHash: 'sha256:abc', catalogVersion: '2026.09.1', frameworks: ['SOC2'], controlsPassed: ['SOC2.CC6.1'], exceptions: [], attestedChecks: [],
    selfAttestedChecks: [], statement: 'Reviewed.', disclaimer: 'Supports your audit; not an audit opinion.', segregation: 'enforced',
    issuedAt: '2026-09-23T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z', issuedBy: 'u2', issuedVia: 'session', algorithm: 'Ed25519', keyId: 'k1',
    status: 'VALID', revokedAt: null, revokedBy: null, revocationReason: null, staleAt: null, ledgerHash: null,
  };
  rec.signature = k.sign(signedPayload(rec));
  return { ...rec, ...extra };
}

describe('swfte_get_evidence_record', () => {
  test('verifies the signature locally and reports freshness from the server', async () => {
    const k = ed25519();
    route('GET', /^\/v2\/compliance\/evidence-records\/signing-key$/, { body: { available: true, algorithm: 'Ed25519', keyId: 'k1', publicKeyHex: k.publicKeyHex, offlineVerifiable: true } });
    route('GET', /^\/v2\/compliance\/evidence-records\/cer_1$/, { body: signedRecord(k) });
    route('GET', /^\/v2\/compliance\/evidence-records\/cer_1\/verify$/, { body: { recordId: 'cer_1', signatureValid: true, status: 'VALID', fresh: true, recordedContentHash: 'sha256:abc', currentContentHash: 'sha256:abc', reasons: [] } });
    const out = await run('swfte_get_evidence_record', { id: 'cer_1' });
    assert.equal(out.localSignatureCheck.result, 'valid');
    assert.equal(out.conclusion, 'VALID_AND_CURRENT');
    assert.doesNotMatch(JSON.stringify(out), FORBIDDEN_WORDS);
  });

  test('a tampered record fails the local check even when the server says VALID; a moved hash reads STALE', async () => {
    const k = ed25519();
    route('GET', /^\/v2\/compliance\/evidence-records\/signing-key$/, { body: { available: true, algorithm: 'Ed25519', keyId: 'k1', publicKeyHex: k.publicKeyHex, offlineVerifiable: true } });
    route('GET', /^\/v2\/compliance\/evidence-records\/cer_1$/, { body: signedRecord(k, { controlsPassed: ['SOC2.CC6.1', 'SOC2.CC7.2'] }) });
    route('GET', /^\/v2\/compliance\/evidence-records\/cer_1\/verify$/, { body: { signatureValid: true, status: 'VALID', fresh: true } });
    assert.equal((await run('swfte_get_evidence_record', { id: 'cer_1' })).conclusion, 'INVALID_SIGNATURE');

    route('GET', /^\/v2\/compliance\/evidence-records\/cer_1$/, { body: signedRecord(k) });
    route('GET', /^\/v2\/compliance\/evidence-records\/cer_1\/verify$/, { body: { signatureValid: true, status: 'STALE', fresh: false, currentContentHash: 'sha256:def' } });
    const stale = await run('swfte_get_evidence_record', { id: 'cer_1' });
    assert.equal(stale.conclusion, 'STALE');
    assert.equal(stale.verification.currentContentHash, 'sha256:def');
  });
});

describe('swfte_compliance_export and swfte_compliance_history', () => {
  test('recomputes the JSON export body hash and checks the manifest signature', async () => {
    const k = ed25519();
    const rest = { controlMatrix: [{ controlId: 'SOC2.CC6.1', verdict: 'PASS' }], assessmentEvents: [], attestations: [], evidenceRecords: [] };
    const bodySha256 = sha256Hex(stableStringify(rest));
    route('GET', /^\/v2\/compliance\/evidence-records\/signing-key$/, { body: { available: true, algorithm: 'Ed25519', keyId: 'k1', publicKeyHex: k.publicKeyHex, offlineVerifiable: true } });
    route('GET', /^\/v2\/compliance\/export$/, { body: { manifest: { bodySha256, algorithm: 'Ed25519', keyId: 'k1', signature: k.sign(bodySha256) }, ...rest } });
    const out = await run('swfte_compliance_export', { format: 'json', framework: 'SOC2' });
    assert.equal(seen.find((s) => s.path === '/v2/compliance/export')!.query.framework, 'SOC2');
    assert.equal(out.integrity.bodyHashMatches, true);
    assert.equal(out.integrity.signature.result, 'valid');
    assert.equal(out.counts.controlMatrix, 1);

    route('GET', /^\/v2\/compliance\/export$/, { body: { manifest: { bodySha256, algorithm: 'Ed25519', keyId: 'k1', signature: k.sign(bodySha256) }, ...rest, controlMatrix: [] } });
    const bad = await run('swfte_compliance_export', {});
    assert.equal(bad.integrity.bodyHashMatches, false);
    assert.match(bad.integrityConclusion, /does NOT match/);
  });

  test('CSV export checks the declared CSV hash; savePath is refused on a hosted server', async () => {
    const csv = 'controlId,verdict\nSOC2.CC6.1,PASS\n';
    route('GET', /^\/v2\/compliance\/export$/, () => ({ text: csv, headers: { 'X-Swfte-Export-Csv-Sha256': sha256Hex(csv) } }));
    const out = await run('swfte_compliance_export', { format: 'csv', savePath: 'evidence/export.csv' });
    assert.equal(out.integrity.csvHashMatches, true);
    assert.equal(readFileSync(join(tmp, 'evidence/export.csv'), 'utf8'), csv);
    await assert.rejects(run('swfte_compliance_export', { format: 'csv', savePath: 'x.csv' }, { localFilesystem: false }), /hosted MCP server/);
    await assert.rejects(run('swfte_compliance_export', { format: 'csv', savePath: '../x.csv' }), /outside the working directory/);
  });

  test('history spells UNAVAILABLE as not checked', async () => {
    route('GET', /^\/v2\/compliance\/controls\/SOC2\.CC7\.2\/history$/, (req) => {
      assert.equal(req.query.target, 'workflow:wf_1');
      return { body: { controlId: 'SOC2.CC7.2', target: 'workflow:wf_1', points: [{ assessmentId: 'cas_1', assessedAt: 't1', contentHash: 'h', verdict: 'PASS' }, { assessmentId: 'cas_2', assessedAt: 't2', contentHash: 'h2', verdict: 'UNAVAILABLE' }], intervals: [{ verdict: 'UNAVAILABLE', from: 't2', to: null }], truncated: false } };
    });
    const out = await run('swfte_compliance_history', { controlId: 'SOC2.CC7.2', target: 'workflow:wf_1' });
    assert.equal(out.current.verdict, 'UNAVAILABLE');
    assert.match(out.current.meaning, /not checked — this is not a pass/);
    assert.match(out.intervals[0].meaning, /not checked/);
  });
});

/* ── CLI: verify --compliance, add scan ──────────────────────────────────── */

const WF_CONTRACT = {
  catalogRef: 'workflow:wf_1',
  invoke: { method: 'POST', path: '/v2/workflows/wf_1/invoke', auth: 'api_key', async: true, statusPath: '/v2/workflows/executions/{executionId}/status' },
  inputSchema: { type: 'object', properties: { invoiceUrl: { type: 'string' } }, required: ['invoiceUrl'] },
  outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
  snippets: {},
  embed: null,
  version: 'v3',
};
function catalogRoutes() {
  route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, { body: { catalogRef: 'workflow:wf_1', kind: 'workflow', id: 'wf_1', workspaceId: 'ws1', scope: 'workspace', name: 'Invoice Extractor', description: 'x', facets: [], evidence: { level: 'observed' }, updatedAt: '2026-09-21T00:00:00Z' } });
  route('GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, { body: WF_CONTRACT });
  // One item per pinned ref, as the backend answers; an empty list now means the artifact vanished (BT-N3).
  route('GET', /^\/v2\/catalog\/upgrades$/, (req: any) => ({
    body: { items: String(req.query.refs ?? '').split(',').filter(Boolean).map((pin: string) => ({ catalogRef: pin.slice(0, pin.lastIndexOf(':')), currentHash: pin.slice(pin.lastIndexOf(':') + 1), latestHash: pin.slice(pin.lastIndexOf(':') + 1), breaking: false, capabilityChanges: [], requiresReapproval: false })) },
  }));
}

async function cli(args: string[], env: Record<string, string | undefined> = { SWFTE_API_KEY: CREDENTIAL }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l), env: env as NodeJS.ProcessEnv, cwd: tmp });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('swfte add scan and swfte verify --compliance', () => {
  test('add scans what it wrote and prints findings, advisory unless --strict', async () => {
    catalogRoutes();
    scanRoute();
    write('package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    const r = await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts']);
    assert.equal(r.code, 0, r.err);
    const uploaded = uploadedPaths();
    assert.ok(uploaded.length >= 1 && uploaded.every((p) => p.endsWith('.ts')), `scanned ${uploaded.join(', ')}`);
    assert.ok(!uploaded.includes('swfte.json'));
    assert.match(r.out + r.err, /Compliance scan PASS/);

    // A finding in freshly written code: advisory by default, fatal with --strict.
    routes = routes.filter(([m, re]) => !(m === 'POST' && re.test('/v2/compliance/scan')));
    route('POST', /^\/v2\/compliance\/scan$/, (req) => ({ body: { scanId: 's', verdict: 'FAIL', findings: [{ ruleId: 'ssrf', severity: 'HIGH', file: req.body.files[0].path, line: 3, excerpt: null, message: 'SSRF', remediation: 'x', controls: ['OWASP_ASVS.V12.6.1'] }], summary: { critical: 0, high: 1, medium: 0, low: 0 }, filesScanned: 1, bytesScanned: 1, complete: true } }));
    const advisory = await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts', '--alias', 'second']);
    assert.equal(advisory.code, 0, advisory.err);
    assert.match(advisory.err, /HIGH\s+ssrf/);
    assert.match(advisory.err, /advisory/);
    const strict = await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts', '--alias', 'third', '--strict']);
    assert.equal(strict.code, 1);
  });

  test('verify --compliance scans swfte.json files plus --paths and exits 1 on a high finding', async () => {
    catalogRoutes();
    scanRoute();
    write('package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    assert.equal((await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts'])).code, 0);
    const lock = JSON.parse(readFileSync(join(tmp, 'swfte.json'), 'utf8'));
    const generated: string[] = lock.artifacts.flatMap((a: any) => a.files);
    write('lib/handler.ts', 'export const h = (s: string) => eval(s);\n');
    write('lib/.env', 'SECRET=1');
    seen = [];
    const r = await cli(['verify', '--compliance', '--paths', 'lib']);
    assert.deepEqual(uploadedPaths(), [...generated, 'lib/handler.ts'].sort());
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /lib\/handler\.ts:1\s+HIGH\s+eval/);
    assert.match(r.out, /SWFTE_VERIFY_FAILED — compliance scan/);
  });

  test('verify --compliance exits 2 when the scan could not check the code, and refuses --offline', async () => {
    catalogRoutes();
    scanRoute();
    write('package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    assert.equal((await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts'])).code, 0);
    assert.equal((await cli(['verify', '--compliance'])).code, 0);
    routes = routes.filter(([m, re]) => !(m === 'POST' && re.test('/v2/compliance/scan')));
    route('POST', /^\/v2\/compliance\/scan$/, { status: 503, body: { error: 'ENGINE_UNAVAILABLE', message: 'down' } });
    const r = await cli(['verify', '--compliance', '--json']);
    assert.equal(r.code, 2);
    const j = JSON.parse(r.out);
    assert.equal(j.compliance.verdict, 'UNAVAILABLE');
    assert.equal(j.verdict, 'SWFTE_VERIFY_UNCHECKED');
    assert.equal((await cli(['verify', '--compliance', '--offline'])).code, 2);
  });
});

/* ── H1: credential host allow-list ──────────────────────────────────────── */

describe('credential host allow-list (H1)', () => {
  const lockWith = (baseUrl: string) =>
    write('swfte.json', JSON.stringify({ version: 1, baseUrl, workspaceId: null, artifacts: [] }, null, 2));

  test('credential is never sent to a swfte.json baseUrl host outside the allow-list', async () => {
    lockWith('https://attacker.example.net/agents');
    const r = await cli(['verify']);
    assert.equal(r.code, 2);
    assert.match(r.err, /Refusing to use swfte\.json baseUrl "https:\/\/attacker\.example\.net\/agents"/);
    assert.match(r.err, /SWFTE_ALLOWED_HOSTS/);
    assert.equal(seen.length, 0, 'a request went out');
    // verify --compliance and sync refuse too.
    assert.equal((await cli(['verify', '--compliance'])).code, 2);
    assert.equal((await cli(['sync'])).code, 2);
    assert.equal(seen.length, 0);
  });

  test('baseUrl host allowed by default (api.swfte.com, localhost) and by SWFTE_ALLOWED_HOSTS', async () => {
    catalogRoutes();
    write('package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    lockWith('https://api.swfte.com/agents');
    assert.equal((await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts'])).code, 0);
    assert.ok(seen.length > 0 && seen.every((s) => s.host === 'api.swfte.com'));

    seen = [];
    lockWith('https://swfte.internal.corp/agents');
    await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts', '--force'], { SWFTE_API_KEY: CREDENTIAL, SWFTE_ALLOWED_HOSTS: 'api.swfte.com, *.internal.corp, swfte.internal.corp' });
    assert.ok(seen.length > 0 && seen.every((s) => s.host === 'swfte.internal.corp'));
    assert.equal(seen[0]!.headers.Authorization ?? seen[0]!.headers.authorization, `Bearer ${CREDENTIAL}`);
  });

  test('SWFTE_BASE_URL from the environment is trusted over the lock baseUrl', async () => {
    catalogRoutes();
    write('package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    const env = { SWFTE_API_KEY: CREDENTIAL, SWFTE_BASE_URL: 'https://staging.operator.dev/agents' };
    assert.equal((await cli(['add', 'workflow:wf_1', '--framework', 'plain-ts'], env)).code, 0);
    const lock = JSON.parse(readFileSync(join(tmp, 'swfte.json'), 'utf8'));
    assert.equal(lock.baseUrl, 'https://staging.operator.dev/agents');

    // A PR rewrites the lock's baseUrl: the env still decides where the key goes...
    lock.baseUrl = 'https://attacker.example.net/agents';
    writeFileSync(join(tmp, 'swfte.json'), JSON.stringify(lock, null, 2));
    seen = [];
    await cli(['verify'], env);
    assert.ok(seen.length > 0 && seen.every((s) => s.host === 'staging.operator.dev'));
    // ...and the tampered host is never baked into a generated client.
    seen = [];
    assert.equal((await cli(['sync', '--force'], env)).code, 2);
    assert.equal(seen.length, 0);
  });

  test('credential baseUrl host rules: https only off loopback, lock host never baked into a client', async () => {
    assert.deepEqual(allowedHosts({}), ['api.swfte.com', 'localhost', '127.0.0.1']);
    assert.equal(isAllowedHost('https://api.swfte.com/agents', {}), true);
    assert.equal(isAllowedHost('http://localhost:8080/api', {}), true);
    assert.equal(isAllowedHost('http://api.swfte.com/agents', {}), false, 'plain http off loopback');
    assert.equal(isAllowedHost('https://api.swfte.com.evil.net/agents', {}), false);
    assert.equal(isAllowedHost('https://evil.internal.corp', { SWFTE_ALLOWED_HOSTS: '*.internal.corp' }), true);
    assert.equal(isAllowedHost('https://internal.corp', { SWFTE_ALLOWED_HOSTS: '*.internal.corp' }), false);
    assert.throws(() => assertLockBaseUrl('https://attacker.example.net', {}), UntrustedHostError);
    assert.equal(assertLockBaseUrl('https://mine.dev/agents', {}, 'https://mine.dev/agents'), 'https://mine.dev/agents', 'the operator-set URL is trusted');
    assert.equal(credentialBaseUrl({ SWFTE_BASE_URL: 'https://x.dev' }, 'https://attacker.example.net'), 'https://x.dev');
    assert.throws(() => credentialBaseUrl({}, 'https://attacker.example.net'), UntrustedHostError);

    // The MCP scaffold (config from env) refuses to bake a tampered lock host as DEFAULT_BASE_URL.
    catalogRoutes();
    lockWith('https://attacker.example.net/agents');
    write('package.json', JSON.stringify({ name: 'app', dependencies: {} }));
    await assert.rejects(run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', framework: 'plain-ts' }), UntrustedHostError);
    assert.ok(seen.every((s) => s.host === 'api.swfte.com'));
  });
});
