import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteApiError, SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { createHostedHandler } from '../src/http.js';
import { fatalLine, redactSecrets, withErrorSecrets } from '../src/fsguard.js';
import { launchCli } from '../src/cli-entry.js';
import { runCli } from '../src/cli.js';

const config = (credential: string) => ({ ...loadConfig({ SWFTE_PAT: 'pat_boundary_fixture', SWFTE_TELEMETRY: '0' }), credential, debug: true });
function noSecrets(text: string, ...secrets: string[]) {
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'known synthetic literal leaked');
}

test('debugRequestAndPollStderrScrubRawAndEncodedCallLiterals', async () => {
  const credential = 'opaque /query+fixture', bearer = 'incoming /opaque+fixture';
  const output: string[] = [];
  const write = process.stderr.write;
  const realFetch = globalThis.fetch;
  process.stderr.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as typeof write;
  globalThis.fetch = (async () => new Response(JSON.stringify({ publicValue: credential }), { status: 200 })) as typeof fetch;
  try {
    const api = new SwfteClient(config(credential));
    const result = await withErrorSecrets([bearer], () => api.request<{ publicValue: string }>({ method: 'GET',
      path: `/fixture/${encodeURIComponent(credential)}/${encodeURIComponent(bearer)}`, query: { publicLabel: credential }, retries: 0 }));
    assert.equal(result.publicValue, credential, 'ordinary successful payload stays intact');
    let calls = 0;
    const polled = await withErrorSecrets([bearer], () => api.pollUntil(async () => {
      calls++;
      if (calls === 2) throw new Error(`poll unavailable ${credential} ${bearer}`);
      return { done: calls >= 3 };
    }, (snapshot) => snapshot.done, { intervalMs: 1, timeoutMs: 1000 }));
    assert.equal(polled.timedOut, false);
    assert.equal(calls, 3, 'same polling behavior survives one failed read');
    const logs = output.join('');
    assert.match(logs, /poll error \(continuing\): poll unavailable/);
    assert.match(logs, /→ GET/);
    assert.match(logs, /← 200 GET/);
    noSecrets(logs, credential, bearer, encodeURIComponent(credential), encodeURIComponent(bearer), 'opaque+%2Fquery%2Bfixture');
    assert.match(logs, /\[redacted\]/);
  } finally { process.stderr.write = write; globalThis.fetch = realFetch; }
});

test('shortKnownLiteralsAreScrubbedFromFatalStacksAndActualCliEntry', async () => {
  const write = process.stderr.write, previousCode = process.exitCode;
  const previousPat = process.env.SWFTE_PAT, previousKey = process.env.SWFTE_API_KEY;
  const output: string[] = [];
  process.stderr.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as typeof write;
  try {
    for (const credential of ['~', 'r5X', 'sk_', 'pat_', 'pat_a', 'pat_ab', 'pat_abc']) {
      process.env.SWFTE_PAT = credential; delete process.env.SWFTE_API_KEY;
      const error = new Error(`entry failure ${credential}`);
      error.stack = `Error: entry failure ${credential}\n    at synthetic (${credential})`;
      await launchCli(async () => { throw error; });
      assert.equal(process.exitCode, 1);
      const line = output.pop()!;
      assert.match(line, /\[swfte\] fatal: Error: entry failure/);
      noSecrets(line, credential);
      noSecrets(fatalLine('fixture', error, { SWFTE_PAT: credential }), credential);
    }
  } finally {
    process.stderr.write = write; process.exitCode = previousCode;
    if (previousPat === undefined) delete process.env.SWFTE_PAT; else process.env.SWFTE_PAT = previousPat;
    if (previousKey === undefined) delete process.env.SWFTE_API_KEY; else process.env.SWFTE_API_KEY = previousKey;
  }
});

test('cliArgumentErrorScrubsKnownLiteralBeforeConfiguration', async () => {
  const output: string[] = [];
  const credential = 'opaque-cli-argument-unique';
  const result = await runCli([`--${credential}`], { env: { SWFTE_PAT: credential }, cwd: process.cwd(), out: () => {}, err: (line) => output.push(line) });
  assert.equal(result, 2);
  assert.match(output.join(''), /Unknown option/);
  assert.match(output.join(''), /\.swfte\/fixtures\//, 'ordinary usage paths stay intact');
  noSecrets(output.join(''), credential);
});

test('hostedAwaitedMcpFailureReturnsScrubbedJsonAndStderr', async () => {
  const bearer = 'q7Z', configured = 'pat_hosted_fixture';
  const handler = createHostedHandler({ env: { SWFTE_MCP_PUBLIC_URL: 'https://mcp.test',
    SWFTE_MCP_OAUTH_SECRET: 'synthetic-signing-secret', SWFTE_BASE_URL: 'https://api.test/agents', SWFTE_PAT: configured } });
  const request = new Request('https://mcp.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
  // The real async MCP authentication path enumerates headers after OAuth declines
  // /mcp. A rejected transport input must reach the outer catch, not escape it.
  request.headers.forEach = () => { throw new Error(`header processing failed ${bearer} ${configured}`); };
  const logs: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => { logs.push(parts.map((part) => part instanceof Error ? part.stack ?? part.message : String(part)).join(' ')); };
  try {
    let rejected: unknown;
    const response = await handler(request).catch((error) => { rejected = error; return null; });
    assert.equal(rejected, undefined, 'async MCP rejection must be caught by the real hosted handler');
    assert.ok(response);
    assert.equal(response.status, 500);
    const body: any = await response.json();
    assert.equal(body.error, 'server_error');
    assert.match(body.error_description, /header processing failed/);
    noSecrets(body.error_description, bearer, configured);
    assert.equal(logs.length, 1);
    noSecrets(logs.join(''), bearer, configured);
    assert.match(logs[0]!, /header processing failed/);
  } finally { console.error = original; }
});

test('hostedDiagnosticMarkerUsesAllBearerAndConfiguredLiterals', async () => {
  const handler = createHostedHandler({ env: { SWFTE_MCP_PUBLIC_URL: 'https://mcp.test',
    SWFTE_MCP_OAUTH_SECRET: 'synthetic-signing-secret', SWFTE_BASE_URL: 'https://api.test/agents', SWFTE_PAT: 'r', SWFTE_API_KEY: 'E' } });
  const request = new Request('https://mcp.test/mcp', { method: 'POST', headers: { authorization: 'Bearer *' } });
  request.headers.forEach = () => { throw new Error('down r E *'); };
  const logs: string[] = [], original = console.error;
  console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  try {
    const response = await handler(request);
    assert.equal(response.status, 500);
    const body: any = await response.json();
    assert.equal(body.error, 'server_error');
    noSecrets(body.error_description, 'r', 'E', '*');
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /down /);
    const diagnostic = logs[0]!.split('down ')[1]!.split('\n')[0]!;
    noSecrets(diagnostic, 'r', 'E', '*');
  } finally { console.error = original; }
});

test('knownLiteralFormsNeverBreakOnMalformedUnicodeAndContextsStayIsolated', async () => {
  const malformed = 'pat_\ud800';
  const safe = redactSecrets(`failed ${malformed}`, [malformed]);
  noSecrets(safe, malformed);
  const first = withErrorSecrets(['opaque-a-fixture'], async () => { await Promise.resolve(); return redactSecrets('failed opaque-a-fixture opaque-b-fixture'); });
  const second = withErrorSecrets(['opaque-b-fixture'], async () => { await Promise.resolve(); return redactSecrets('failed opaque-a-fixture opaque-b-fixture'); });
  assert.equal(await first, 'failed [redacted] opaque-b-fixture');
  assert.equal(await second, 'failed opaque-a-fixture [redacted]');
});

test('diagnosticMarkersNeverReintroduceShortKnownLiterals', async () => {
  for (const literals of [['r'], ['E'], ['*'], ['r', 'E', '*'], ['r', 'E', '*', '#', '\u2588']]) {
    const diagnostic = redactSecrets(`down ${literals.join(' ')}`, literals);
    noSecrets(diagnostic, ...literals);
    assert.ok(diagnostic.startsWith('down '));
  }
  assert.equal(redactSecrets('down opaque-marker-fixture', ['opaque-marker-fixture']), 'down [redacted]');
  noSecrets(redactSecrets('down ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890', ['r']), 'r');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 'HTTP_503', message: 'down r E *' }), { status: 503 })) as typeof fetch;
  try {
    const api = new SwfteClient({ ...config('r'), debug: false });
    let failure: unknown;
    await api.withErrorSecrets(['E', '*'], () => api.request({ method: 'POST', path: '/safe', retries: 0 })).catch((error) => { failure = error; });
    assert.ok(failure instanceof SwfteApiError);
    assert.equal(failure.status, 503);
    assert.equal(failure.code, 'HTTP_503');
    noSecrets(failure.message, 'r', 'E', '*');
  } finally { globalThis.fetch = realFetch; }
});

test('escapedAndMixedPercentLiteralFormsAreScrubbedWithoutChangingOrdinarySuccess', async () => {
  const credential = 'pat_a/"\\Z';
  const escaped = JSON.stringify(credential).slice(1, -1);
  const mixed = encodeURIComponent(credential).replace('%2F', '%2f');
  assert.notEqual(mixed, encodeURIComponent(credential));
  assert.notEqual(mixed, encodeURIComponent(credential).replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
  assert.match(mixed, /pat_a%2f%22%5CZ/, 'mixed percent hex keeps ordinary credential letters intact');
  const api = new SwfteClient({ ...config(credential), debug: false });
  for (const form of [escaped, mixed]) assert.equal(api.redactError(`down ${form}`), 'down [redacted]');
  assert.equal(redactSecrets('down pat_a\\nZ', ['pat_a\nZ']), 'down [redacted]');
  const differentCase = credential.replace('pat_a', 'PAT_a');
  assert.equal(api.redactError(`ordinary ${differentCase}`), `ordinary ${differentCase}`, 'percent folding must not fold ordinary credential letters');
  const payload = { publicValue: escaped, ordinaryUrl: 'https://example.test/public%2Froute' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  try { assert.deepEqual(await api.request({ method: 'GET', path: '/safe', retries: 0 }), payload); }
  finally { globalThis.fetch = realFetch; }
});

test('backendErrorBodyScrubsKnownLiteralsBeforeBoundAndKeepsStructuredControls', async () => {
  const credential = 'opaque-quote-"-backslash-\\-fixture', bearer = 'incoming-opaque-body-fixture';
  const realFetch = globalThis.fetch;
  try {
    const api = new SwfteClient({ ...config(credential), debug: false });
    for (const plain of [false, true]) {
      const body = plain ? `${'x'.repeat(490)}${bearer} ${credential}` : JSON.stringify({ code: 'PAYMENT_METHOD_REQUIRED',
        message: `backend refused ${credential} ${bearer}`, reason: `approval ${credential}`, nested: { [credential]: [bearer, 7, false] } });
      globalThis.fetch = (async () => new Response(body, { status: 400, statusText: 'Bad Request' })) as typeof fetch;
      let failure: unknown;
      await withErrorSecrets([bearer], () => api.request({ method: 'POST', path: '/safe', retries: 0 })).catch((error) => { failure = error; });
      assert.ok(failure instanceof SwfteApiError);
      assert.equal(failure.status, 400);
      noSecrets(failure.message, credential, bearer);
      noSecrets(JSON.stringify(failure.envelope), bearer, bearer.slice(0, 10));
      if (plain) assert.match(String(failure.envelope.body), /\[redacted\]/);
      else {
        assert.equal(failure.code, 'PAYMENT_METHOD_REQUIRED');
        assert.match(failure.suggestedAction ?? '', /Studio → Billing/);
        assert.deepEqual((failure.envelope.nested as Record<string, unknown>)['[redacted]'], ['[redacted]', 7, false]);
        noSecrets(String(failure.envelope.reason), credential);
      }
    }
  } finally { globalThis.fetch = realFetch; }
});
