import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { z, type ZodTypeAny } from 'zod';

import { buildServer, type BuildServerOptions } from '../src/server.js';
import { SwfteApiError, SwfteClient, type RequestOptions } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { UnsupportedKindError } from '../src/kinds/index.js';
import type { ToolDefinition } from '../src/tools/_types.js';
import { catalogTools } from '../src/tools/catalog.js';
import { contractHash, type CatalogContract } from '../src/catalog.js';
import { codeTools } from '../src/tools/code.js';
import { scaffoldTools } from '../src/tools/scaffold.js';
import { getEvidenceRecord, scanFiles, scanProject } from '../src/compliance.js';
import { assertNoSecrets } from '../src/fsguard.js';

// All credentials in this file are synthetic. Opaque ones deliberately defeat
// the generic known-shape scrubber, so the resolved caller identity matters.
const config = (credential = 'construction-placeholder-fixture') => ({
  ...loadConfig({ SWFTE_PAT: 'pat_synthetic_fixture' } as never), credential,
});
const auth = (token: string): AuthInfo => ({ token, clientId: 'test-client', scopes: [] });
const knownCredential = 'pat_SYNTHETIC12345678';

function tool(execute: ToolDefinition['execute'], name = 'fixture_tool', inputSchema: ZodTypeAny = z.object({})): ToolDefinition {
  return { name, description: 'synthetic protocol fixture', inputSchema, execute };
}

function apiFailure(...secrets: string[]) {
  return new SwfteApiError({
    status: 409, code: 'APPROVAL_REQUIRED', method: 'POST', path: '/safe/artifact',
    message: `Backend refused ${secrets.join(' | ')}`,
    reason: `approval needed ${secrets.join(' | ')}`,
    suggestedAction: 'Approve in Studio',
    envelope: { safe: 'diagnostic detail', nested: {
      warning: secrets.join(' | '), items: [{ message: secrets.join(' | '), count: 2, allowed: false }, null],
      [`credential ${secrets[0]}`]: 'safe keyed detail',
    } },
  });
}

type AuthFor = AuthInfo | ((message: JSONRPCMessage) => AuthInfo | undefined);
async function protocol(t: TestContext, options: BuildServerOptions, authFor?: AuthFor) {
  const server = buildServer(options);
  const client = new Client({ name: 'redaction-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const wire: string[] = [];
  const clientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, sendOptions) => clientSend(message, {
    ...sendOptions, authInfo: typeof authFor === 'function' ? authFor(message) : authFor,
  });
  const serverSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, sendOptions) => {
    // Serialize actual SDK responses and feed their decoded bytes to its real
    // client. Directly invoking private request handlers would miss error.data.
    const bytes = JSON.stringify(message);
    wire.push(bytes);
    return serverSend(JSON.parse(bytes), sendOptions);
  };
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  wire.length = 0;
  return { client, wire };
}

async function toolError(client: Client, name = 'fixture_tool', args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, 'the real SDK response must be a tool failure');
  assert.equal(result.content.length, 1);
  const content = result.content[0]!;
  assert.equal(content.type, 'text');
  assert.ok('text' in content);
  return content.text as string;
}

async function resourceError(client: Client, uri: string) {
  try { await client.readResource({ uri }); }
  catch (err) {
    assert.ok(err instanceof McpError, 'resource failure must cross the real SDK error serializer');
    return err;
  }
  assert.fail('resource read unexpectedly succeeded');
}

function noSecrets(value: unknown, ...secrets: string[]) {
  if (typeof value === 'string') {
    for (const secret of secrets) assert.equal(value.includes(secret), false, 'synthetic credential was reflected');
  } else if (Array.isArray(value)) {
    value.forEach((item) => noSecrets(item, ...secrets));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { noSecrets(key, ...secrets); noSecrets(item, ...secrets); }
  }
}

function safeEnvelope(body: Record<string, any>) {
  assert.equal(body.error, true);
  assert.equal(body.code, 'APPROVAL_REQUIRED');
  assert.equal(body.status, 409);
  assert.equal(body.suggestedAction, 'Approve in Studio');
  assert.equal(body.request, 'POST /safe/artifact');
  assert.equal(body.detail.safe, 'diagnostic detail');
  assert.equal(body.detail.nested.items[0].count, 2);
  assert.equal(body.detail.nested.items[0].allowed, false);
  assert.equal(body.detail.nested.items[1], null);
  assert.match(body.message, /Backend refused/);
  assert.match(body.reason, /approval needed/);
}

test('stdioToolErrorsPreserveSafeEnvelopeWithoutConfiguredCredential', async (t) => {
  for (const credential of ['stdio-opaque-fixture-credential', knownCredential]) {
    const { client, wire } = await protocol(t, { config: config(credential), tools: [tool(async (input) => {
      if (input.mode === 'generic') throw new Error(`ordinary error ${credential}`);
      if (input.mode === 'unsupported') throw new UnsupportedKindError(credential);
      throw apiFailure(credential);
    }, 'fixture_tool', z.object({ mode: z.string().optional() }))] });
    const body = JSON.parse(await toolError(client));
    safeEnvelope(body);
    noSecrets(body, credential);
    const generic = await toolError(client, 'fixture_tool', { mode: 'generic' });
    assert.match(generic, /ordinary error/);
    noSecrets(generic, credential);
    const unsupported = JSON.parse(await toolError(client, 'fixture_tool', { mode: 'unsupported' }));
    assert.equal(unsupported.code, 'UNSUPPORTED_CAPABILITY');
    assert.match(unsupported.nextAction, /swfte_capabilities/);
    noSecrets(unsupported, credential);
    noSecrets(wire, credential);
  }
});

test('hostedToolErrorsRedactResolvedCredentialAndIncomingBearer', async (t) => {
  const cases = [
    { bearer: 'oauth-opaque-incoming-fixture', resolved: 'resolved-opaque-hosted-fixture' },
    { bearer: knownCredential, resolved: 'resolved-opaque-hosted-fixture' },
    { bearer: 'oauth-length-three-client-fixture', resolved: 'r5X' },
    { bearer: 'oauth-single-character-client-fixture', resolved: '~' },
  ];
  for (const { bearer, resolved } of cases) {
    const placeholder = 'construction-placeholder-fixture';
    let resolutions = 0, executions = 0;
    const { client, wire } = await protocol(t, { config: config(placeholder),
      resolveClient: (info) => { resolutions++; assert.equal(info?.token, bearer); return new SwfteClient(config(resolved)); },
      tools: [tool(async () => { executions++; throw apiFailure(resolved, bearer, placeholder); })],
    }, auth(bearer));
    const text = await toolError(client);
    noSecrets(text, resolved, bearer, placeholder);
    const body = JSON.parse(text);
    safeEnvelope(body);
    assert.equal(body.detail.nested['credential [redacted]'], 'safe keyed detail');
    noSecrets(body, resolved, bearer, placeholder);
    noSecrets(wire, resolved, bearer, placeholder);
    noSecrets(wire.map((bytes) => JSON.parse(bytes)), resolved, bearer, placeholder);
    for (const bytes of wire) {
      for (const secret of [resolved, bearer, placeholder]) {
        assert.equal(Buffer.from(bytes, 'utf8').includes(Buffer.from(secret, 'utf8')), false, 'synthetic credential bytes crossed the SDK transport');
      }
    }
    assert.equal(resolutions, 1);
    assert.equal(executions, 1);
  }
});

test('protocolDiagnosticMarkerUsesCompleteCallLiteralSet', async (t) => {
  const { client } = await protocol(t, { config: config('E'),
    resolveClient: () => new SwfteClient(config('r')),
    tools: [tool(async () => { throw new SwfteApiError({ status: 503, code: 'HTTP_503',
      message: 'down r E *', method: 'POST', path: '/safe', envelope: {} }); })],
  }, auth('*'));
  const body = JSON.parse(await toolError(client));
  assert.equal(body.status, 503);
  assert.equal(body.code, 'HTTP_503');
  // Only diagnostic values are credential-bearing here. Fixed field/type
  // labels legitimately contain individual letters such as "r" and "E".
  noSecrets(body.message, 'r', 'E', '*');
  assert.match(body.message, /^down /);
});

test('resolverFailuresRedactIncomingBearerWithoutRetryingResolution', async (t) => {
  const bearer = 'unresolved-opaque-oauth-fixture';
  const placeholder = 'construction-placeholder-fixture';
  let resolutions = 0, executions = 0;
  const { client, wire } = await protocol(t, { config: config(placeholder), tools: [tool(async () => { executions++; })],
    resolveClient: () => { resolutions++; throw new Error(`Resolver unavailable ${bearer} ${placeholder}`); },
  }, auth(bearer));
  const message = await toolError(client);
  assert.match(message, /Resolver unavailable/);
  noSecrets(message, bearer, placeholder);
  noSecrets(wire, bearer, placeholder);
  assert.equal(resolutions, 1);
  assert.equal(executions, 0);
});

test('validationAndUnknownToolErrorsRedactWithoutResolvingClient', async (t) => {
  const bearer = 'validation-opaque-oauth-fixture';
  let resolutions = 0, executions = 0;
  const schema = z.object({ value: z.string().superRefine((value, ctx) => {
    if (value === 'throws') throw new Error(`Schema failed ${bearer}`);
    ctx.addIssue({ code: 'custom', message: `invalid value ${bearer}` });
  }) });
  const { client, wire } = await protocol(t, { config: config(),
    resolveClient: () => { resolutions++; return new SwfteClient(config()); },
    tools: [tool(async () => { executions++; }, 'fixture_tool', schema)],
  }, auth(bearer));
  const missing = await toolError(client, bearer);
  assert.match(missing, /Unknown tool/);
  noSecrets(missing, bearer);
  const invalid = await toolError(client, 'fixture_tool', { value: 'rejected' });
  assert.match(invalid, /Invalid input for fixture_tool/);
  assert.match(invalid, /invalid value/);
  noSecrets(invalid, bearer);
  const thrown = await toolError(client, 'fixture_tool', { value: 'throws' });
  assert.match(thrown, /Schema failed/);
  noSecrets(thrown, bearer);
  noSecrets(wire, bearer);
  assert.equal(resolutions, 0);
  assert.equal(executions, 0);
});

class ResourceClient extends SwfteClient {
  readonly reads: string[] = [];
  constructor(credential: string, private readonly failure: unknown | (() => Promise<unknown>)) { super(config(credential)); }
  override async request<T>(options: RequestOptions): Promise<T> {
    this.reads.push(options.path);
    // The context package fetches detail and contract concurrently. Preserve
    // that existing two-read behavior, and fail its mandatory detail fetch.
    if (options.path.endsWith('/contract')) return {} as T;
    throw typeof this.failure === 'function' ? await this.failure() : this.failure;
  }
}

test('resourceApiErrorsRedactMessageAndNestedData', async (t) => {
  const resolved = 'resource-resolved-opaque-fixture', bearer = 'resource-oauth-opaque-fixture';
  const placeholder = 'construction-placeholder-fixture';
  const backend = new ResourceClient(resolved, apiFailure(resolved, bearer, placeholder));
  let resolutions = 0;
  const { client, wire } = await protocol(t, { config: config(placeholder), tools: [], resolveClient: () => { resolutions++; return backend; } }, auth(bearer));
  const err = await resourceError(client, 'swfte://catalog/workflow/fixture');
  assert.equal(err.code, ErrorCode.InternalError);
  assert.match(err.message, /Backend refused/);
  safeEnvelope(err.data as Record<string, any>);
  noSecrets(err.message, resolved, bearer, placeholder);
  noSecrets(err.data, resolved, bearer, placeholder);
  noSecrets(wire, resolved, bearer, placeholder);
  assert.equal(resolutions, 1);
  assert.equal(backend.reads.length, 2);
  assert.equal(backend.reads.filter((path) => path.endsWith('/contract')).length, 1);
});

test('resourceGenericProtocolErrorsPreserveSafeCodeAndData', async (t) => {
  const credential = 'generic-resource-opaque-fixture', bearer = 'generic-resource-oauth-fixture';
  let resolutions = 0;
  const error = new McpError(-32041, `safe resource message ${credential} ${bearer}`, {
    action: 'Retry later', nested: { message: `${credential} ${bearer}`, [credential]: ['safe detail', 7, false] },
  });
  const originalMessage = error.message;
  const { client, wire } = await protocol(t, { config: config(credential),
    tools: [tool(async () => { throw error; }, 'swfte_capabilities')],
    resolveClient: () => { resolutions++; return new SwfteClient(config(credential)); },
  }, auth(bearer));
  const err = await resourceError(client, 'swfte://capabilities');
  assert.equal(err.code, -32041);
  assert.match(err.message, /safe resource message/);
  const data = err.data as Record<string, any>;
  assert.equal(data.action, 'Retry later');
  assert.deepEqual(data.nested['[redacted]'], ['safe detail', 7, false]);
  noSecrets(err.message, credential, bearer);
  noSecrets(err.data, credential, bearer);
  noSecrets(wire, credential, bearer);
  assert.equal(error.message, originalMessage, 'shared thrown error must not be mutated');
  assert.equal(resolutions, 0, 'local resource errors must not resolve a backend identity');
});

test('missingAndLocalResourcesNeverResolveAnUnneededClient', async (t) => {
  const bearer = 'missing-resource-oauth-fixture';
  let resolutions = 0;
  const { client, wire } = await protocol(t, { config: config(), tools: [], resolveClient: () => { resolutions++; return new SwfteClient(config()); } }, auth(bearer));
  const missing = await resourceError(client, `swfte://missing/${bearer}`);
  assert.equal(missing.code, ErrorCode.InvalidParams);
  assert.match(missing.message, /Unknown resource/);
  assert.match(missing.message, /swfte:\/\/capabilities/);
  noSecrets(missing.message, bearer);
  const local = await client.readResource({ uri: 'swfte://capabilities' });
  assert.equal(local.contents[0]?.mimeType, 'application/json');
  assert.match((local.contents[0] as { text: string }).text, /reuseFirst/);
  assert.equal(resolutions, 0);
  noSecrets(wire, bearer);
});

test('resourceResolverFailureUsesIncomingBearerWithoutSecondResolution', async (t) => {
  const bearer = 'resource-unresolved-oauth-fixture';
  let resolutions = 0;
  const { client, wire } = await protocol(t, { config: config(), tools: [], resolveClient: () => {
    resolutions++; throw Object.assign(new Error(`Resolver not ready ${bearer}`), { code: -32042, data: { safe: 'try later', token: bearer } });
  } }, auth(bearer));
  const err = await resourceError(client, 'swfte://catalog/workflow/fixture');
  assert.equal(err.code, -32042);
  assert.match(err.message, /Resolver not ready/);
  assert.equal((err.data as Record<string, unknown>).safe, 'try later');
  noSecrets(err.message, bearer);
  noSecrets(err.data, bearer);
  noSecrets(wire, bearer);
  assert.equal(resolutions, 1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function callerAuth(message: JSONRPCMessage) {
  if (!('method' in message)) return undefined;
  const params = message.params as { arguments?: { caller?: string }; uri?: string } | undefined;
  const caller = params?.arguments?.caller ?? params?.uri?.split('/').at(-1);
  return caller === 'a' || caller === 'b' ? auth(`oauth-opaque-${caller}-fixture`) : undefined;
}

test('overlappingHostedToolsKeepTheirOwnResolvedRedactor', { timeout: 5000 }, async (t) => {
  const started = { a: deferred<void>(), b: deferred<void>() };
  const finish = { a: deferred<void>(), b: deferred<void>() };
  const credential = { a: 'resolved-opaque-a-fixture', b: 'resolved-opaque-b-fixture' };
  const clients = { a: new SwfteClient(config(credential.a)), b: new SwfteClient(config(credential.b)) };
  let resolutions = 0;
  const { client, wire } = await protocol(t, { config: config(), resolveClient: (info) => {
    resolutions++; return info?.token === 'oauth-opaque-a-fixture' ? clients.a : clients.b;
  }, tools: [tool(async (input, context) => {
    const caller = input.caller as 'a' | 'b';
    assert.equal(context.client, clients[caller]);
    started[caller].resolve();
    await finish[caller].promise;
    throw new Error(`failed ${credential[caller]} oauth-opaque-${caller}-fixture safe marker ${credential[caller === 'a' ? 'b' : 'a']}`);
  }, 'fixture_tool', z.object({ caller: z.enum(['a', 'b']) }))] }, callerAuth);
  t.after(() => { finish.a.resolve(); finish.b.resolve(); });
  const first = toolError(client, 'fixture_tool', { caller: 'a' });
  await started.a.promise;
  const second = toolError(client, 'fixture_tool', { caller: 'b' });
  await started.b.promise;
  finish.b.resolve();
  const resultB = await second;
  finish.a.resolve();
  const resultA = await first;
  noSecrets(resultA, credential.a, 'oauth-opaque-a-fixture');
  noSecrets(resultB, credential.b, 'oauth-opaque-b-fixture');
  assert.ok(resultA.includes(credential.b), 'unrelated opaque diagnostic text must survive caller A redaction');
  assert.ok(resultB.includes(credential.a), 'unrelated opaque diagnostic text must survive caller B redaction');
  assert.equal(resolutions, 2);
  assert.equal(wire.filter((line) => line.includes('"isError":true')).length, 2);
});

test('overlappingHostedResourcesKeepTheirOwnResolvedRedactor', { timeout: 5000 }, async (t) => {
  const started = { a: deferred<void>(), b: deferred<void>() };
  const finish = { a: deferred<void>(), b: deferred<void>() };
  const credential = { a: 'resource-resolved-opaque-a-fixture', b: 'resource-resolved-opaque-b-fixture' };
  const clients = Object.fromEntries((['a', 'b'] as const).map((caller) => [caller,
    new ResourceClient(credential[caller], async () => {
      started[caller].resolve();
      await finish[caller].promise;
      return new McpError(-32043, `failed ${credential[caller]} oauth-opaque-${caller}-fixture`, {
        secret: credential[caller], bearer: `oauth-opaque-${caller}-fixture`,
        safeMarker: credential[caller === 'a' ? 'b' : 'a'],
      });
    }),
  ])) as Record<'a' | 'b', ResourceClient>;
  let resolutions = 0;
  const { client } = await protocol(t, { config: config(), tools: [], resolveClient: (info) => {
    resolutions++; return info?.token === 'oauth-opaque-a-fixture' ? clients.a : clients.b;
  } }, callerAuth);
  t.after(() => { finish.a.resolve(); finish.b.resolve(); });
  const first = resourceError(client, 'swfte://catalog/workflow/a');
  await started.a.promise;
  const second = resourceError(client, 'swfte://catalog/workflow/b');
  await started.b.promise;
  finish.b.resolve();
  const resultB = await second;
  finish.a.resolve();
  const resultA = await first;
  for (const [caller, result] of [['a', resultA], ['b', resultB]] as const) {
    assert.equal(result.code, -32043);
    noSecrets(result.message, credential[caller], `oauth-opaque-${caller}-fixture`);
    noSecrets(result.data, credential[caller], `oauth-opaque-${caller}-fixture`);
    assert.equal((result.data as Record<string, string>).safeMarker, credential[caller === 'a' ? 'b' : 'a']);
    assert.equal(clients[caller].reads.length, 2);
  }
  assert.equal(resolutions, 2);
});

test('structuredErrorsRedactBeforeJsonEscapingAndPreserveSafeFields', async (t) => {
  const resolved = 'opaque-quote-"-backslash-\\-line-\n-fixture';
  const bearer = 'oauth-quote-"-backslash-\\-fixture';
  const failure = apiFailure(resolved, bearer);
  const { client, wire } = await protocol(t, { config: config(), tools: [tool(async () => { throw failure; })],
    resolveClient: () => new SwfteClient(config(resolved)),
  }, auth(bearer));
  const body = JSON.parse(await toolError(client));
  safeEnvelope(body);
  noSecrets(body, resolved, bearer);
  assert.equal(body.detail.nested['credential [redacted]'], 'safe keyed detail');
  assert.ok(Object.hasOwn(failure.envelope.nested as object, `credential ${resolved}`), 'redaction must not mutate backend envelopes');
  noSecrets(wire.map((bytes) => JSON.parse(bytes)), resolved, bearer);
});

test('shortOpaqueIncomingBearerIsRedactedBeforeResolution', async (t) => {
  const bearer = 'q7Z';
  let resolutions = 0;
  const { client, wire } = await protocol(t, { config: config(), tools: [tool(async () => assert.fail('must not execute'))],
    resolveClient: () => { resolutions++; throw new Error(`Resolver refused ${bearer}`); },
  }, auth(bearer));
  const message = await toolError(client);
  assert.match(message, /Resolver refused/);
  assert.match(message, /\[redacted\]/);
  noSecrets(message, bearer);
  noSecrets(wire, bearer);
  assert.equal(resolutions, 1);
});

test('unknownPromptRedactsConfiguredAndIncomingOpaqueLiteralsOnActualSdkWire', async (t) => {
  const credential = 'prompt-config-opaque-fixture', bearer = 'prompt-bearer-opaque-fixture';
  let resolutions = 0;
  const { client, wire } = await protocol(t, { config: config(credential), tools: [],
    resolveClient: () => { resolutions++; return new SwfteClient(config(credential)); } }, auth(bearer));
  try { await client.getPrompt({ name: `${credential}/${bearer}` }); assert.fail('unknown prompt succeeded'); }
  catch (error) {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, /Unknown prompt/);
    noSecrets(error.message, credential, bearer);
  }
  noSecrets(wire, credential, bearer);
  assert.equal(resolutions, 0, 'unknown local prompt must not resolve a backend client');
});

class DiagnosticClient extends SwfteClient {
  constructor(private readonly literal: string, private readonly bearer: string) { super(config(literal)); }
  override async request<T>(request: RequestOptions): Promise<T> {
    if (request.path.endsWith('/contract')) throw new SwfteApiError({ status: 503, code: 'STORE_UNAVAILABLE',
      message: `contract unavailable ${this.literal} ${this.bearer}`, method: 'GET', path: request.path });
    if (request.path.endsWith('/verify') || request.path.endsWith('/scan')) throw new Error(`verification unavailable ${this.literal} ${this.bearer}`);
    if (request.path.endsWith('/signing-key')) return null as T;
    if (request.path.includes('/compliance/')) return { id: 'record', status: 'ISSUED', statement: 'safe statement' } as T;
    if (request.path.endsWith('/translate-to-execution')) return { translatable: false, refusals: [
      { nodeId: 'input', code: 'CONFIG_VALUE_INVALID', reason: `refused ${this.literal} ${this.bearer}`, nested: { [this.literal]: this.bearer } },
      { nodeId: 'output', code: 'CONFIG_SEMANTICS_DIVERGE', reason: 'safe output refusal' },
    ], warnings: [`warning ${this.literal} ${this.bearer}`], sourceContentHash: 'safe-hash', translatorVersion: '2' } as T;
    return { catalogRef: 'workflow:fixture', kind: 'workflow', id: 'fixture', name: 'safe name',
      description: `intentional success data ${this.literal} ${this.bearer}`, scope: 'workspace', evidence: { level: 'unmeasured' } } as T;
  }
  override async getBinary() {
    throw new SwfteApiError({ status: 422, code: 'TRANSLATION_REFUSED', message: 'translation refused', method: 'GET', path: '/fixture',
      envelope: { refusals: [{ nodeId: 'input', code: 'CREDENTIAL_IN_CONFIG', reason: `refused ${this.literal} ${this.bearer}` },
        { nodeId: 'output', code: 'CONFIG_SEMANTICS_DIVERGE', reason: 'safe reason' }], warnings: [`warning ${this.literal} ${this.bearer}`] } });
  }
}

test('degradedContractScrubsOnlyFailureFieldsAndPreservesSuccessfulCatalogData', async (t) => {
  const credential = 'contract-opaque-fixture', bearer = 'contract-bearer-fixture';
  const backend = new DiagnosticClient(credential, bearer);
  const actual = catalogTools.find((item) => item.name === 'swfte_get_context')!;
  const { client } = await protocol(t, { config: config(), tools: [actual], resolveClient: () => backend }, auth(bearer));
  const result = await client.callTool({ name: actual.name, arguments: { catalogRef: 'workflow:fixture' } });
  assert.notEqual(result.isError, true);
  const body = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(body.contractError.status, 503);
  assert.equal(body.contractError.code, 'STORE_UNAVAILABLE');
  assert.match(body.contractError.message, /contract unavailable/);
  noSecrets(body.contractError, credential, bearer);
  assert.equal(body.description, `intentional success data ${credential} ${bearer}`);
  assert.equal(body.contract, null);
  assert.ok(body.nextSteps.length > 0);
});

test('degradedVerificationAndScanErrorsScrubBothCallIdentitiesWithoutClaimingPass', async (t) => {
  const credential = 'verify-opaque-fixture', bearer = 'verify-bearer-fixture';
  const backend = new DiagnosticClient(credential, bearer);
  const { client, wire } = await protocol(t, { config: config(), resolveClient: () => backend, tools: [
    tool(async (_input, { client: api }) => getEvidenceRecord(api, 'record'), 'fixture_record'),
    tool(async (_input, { client: api }) => scanFiles(api, { files: [{ path: 'src/main.ts', content: 'export const publicValue = 1;' }] }), 'fixture_scan'),
  ] }, auth(bearer));
  const record = await client.callTool({ name: 'fixture_record', arguments: {} });
  const recordBody = JSON.parse((record.content[0] as { text: string }).text);
  assert.equal(recordBody.conclusion, 'UNVERIFIABLE');
  assert.match(JSON.stringify(recordBody), /verification unavailable/);
  noSecrets(recordBody, credential, bearer);
  const scan = await client.callTool({ name: 'fixture_scan', arguments: {} });
  const scanBody = JSON.parse((scan.content[0] as { text: string }).text);
  assert.equal(scanBody.complete, false);
  assert.equal(scanBody.batchErrors.length, 1);
  assert.match(scanBody.batchErrors[0], /verification unavailable/);
  noSecrets(scanBody, credential, bearer);
  noSecrets(wire, credential, bearer);
});

test('translationRefusalAndDryRunScrubCompleteNestedDiagnosticsOnActualSdkWire', async (t) => {
  const credential = 'refusal-opaque-fixture', bearer = 'refusal-bearer-fixture';
  const backend = new DiagnosticClient(credential, bearer);
  const tools = codeTools.filter((item) => ['swfte_export_src', 'swfte_translate_check'].includes(item.name));
  const { client, wire } = await protocol(t, { config: config(), tools, resolveClient: () => backend }, auth(bearer));
  for (const [name, args] of [['swfte_export_src', { workflowId: 'fixture', source: 'canvas', destDir: 'refused-source' }],
    ['swfte_translate_check', { workflowId: 'fixture' }]] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(body.refusals.length, 2);
    assert.deepEqual(body.refusals.map((item: any) => item.nodeId), ['input', 'output']);
    assert.match(body.nextStep, /Keep this workflow hosted/);
    noSecrets(body, credential, bearer);
  }
  noSecrets(wire, credential, bearer);
});

test('ordinarySuccessfulToolPayloadIsNotRewrittenByDiagnosticRedaction', async (t) => {
  const credential = 'success-opaque-fixture', bearer = 'success-bearer-fixture';
  const payload = { token: credential, message: bearer, nested: { ordinaryData: `${credential}/${bearer}` }, count: 3 };
  const { client } = await protocol(t, { config: config(credential), tools: [tool(async () => payload)] }, auth(bearer));
  const result = await client.callTool({ name: 'fixture_tool', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), payload);
});

test('invokeOutputPathMetadataRemainsInContextAndContractHash', async (t) => {
  const contract: CatalogContract = { catalogRef: 'workflow:fixture',
    invoke: { method: 'POST', path: '/v2/workflows/fixture/invoke', auth: 'api_key', async: true,
      statusPath: '/v2/workflows/executions/{executionId}/status', outputPath: ['execution', 'outputData', 'parameters', 'end'] },
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };
  class ContextClient extends SwfteClient {
    override async request<T>(request: RequestOptions): Promise<T> {
      return (request.path.endsWith('/contract') ? contract : { catalogRef: 'workflow:fixture', kind: 'workflow', id: 'fixture', name: 'public fixture' }) as T;
    }
  }
  const actual = catalogTools.find((item) => item.name === 'swfte_get_context')!;
  const { client } = await protocol(t, { config: config(), tools: [actual], resolveClient: () => new ContextClient(config()) });
  const result = await client.callTool({ name: actual.name, arguments: { catalogRef: 'workflow:fixture' } });
  assert.notEqual(result.isError, true);
  const body = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(body.contract.invoke, contract.invoke);
  assert.equal(body.contractHash, contractHash(contract));
  const { outputPath: _path, ...withoutResultPath } = contract.invoke;
  assert.notEqual(contractHash(contract), contractHash({ ...contract, invoke: withoutResultPath }));
});

test('degradedProjectScanScrubsRefusedPathsAndNeverClaimsChecked', async (t) => {
  const credential = 'project-opaque-fixture', bearer = 'project-bearer-fixture';
  const backend = new DiagnosticClient(credential, bearer);
  const { client, wire } = await protocol(t, { config: config(), resolveClient: () => backend, tools: [
    tool(async (_input, { client: api }) => scanProject(api, process.cwd(), [`/outside/${credential}/${bearer}`]), 'fixture_project_scan'),
  ] }, auth(bearer));
  const result = await client.callTool({ name: 'fixture_project_scan', arguments: {} });
  const body = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(body.complete, false);
  assert.equal(body.verdict, 'UNAVAILABLE');
  assert.equal(body.filesScanned, 0);
  assert.equal(body.batchErrors.length, 1);
  assert.match(body.batchErrors[0], /outside the working directory/);
  noSecrets(body, credential, bearer);
  noSecrets(wire, credential, bearer);
});

test('degradedDependencyErrorsScrubBothDirectionsOnActualSdkWire', async (t) => {
  const credential = 'dependency-opaque-fixture', bearer = 'dependency-bearer-fixture';
  class DependencyClient extends SwfteClient {
    override async request<T>(request: RequestOptions): Promise<T> {
      if (request.path === '/v2/catalog/search') return { items: [{ kind: 'workflow', id: 'referrer', catalogRef: 'workflow:referrer', name: 'safe referrer' }], degraded: [] } as T;
      throw new Error(`dependency read unavailable ${credential} ${bearer}`);
    }
  }
  const actual = catalogTools.find((item) => item.name === 'swfte_trace_dependencies')!;
  const { client, wire } = await protocol(t, { config: config(), resolveClient: () => new DependencyClient(config(credential)), tools: [actual] }, auth(bearer));
  for (const direction of ['downstream', 'upstream']) {
    const result = await client.callTool({ name: actual.name, arguments: { catalogRef: 'workflow:fixture', direction, depth: 1, maxScan: 1 } });
    assert.notEqual(result.isError, true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0], /dependency read unavailable/);
    assert.equal(body.direction, direction);
    if (direction === 'downstream') assert.deepEqual(body.edges, []);
    else { assert.equal(body.scanned, 1); assert.deepEqual(body.dependents, []); }
    noSecrets(body.errors, credential, bearer);
  }
  noSecrets(wire, credential, bearer);
});

test('inlineScaffoldScanFailureStaysAdvisoryAndScrubsCallIdentities', async (t) => {
  const credential = 'scaffold-scan-opaque-fixture', bearer = 'scaffold-scan-bearer-fixture';
  let scans = 0;
  class ScaffoldClient extends SwfteClient {
    override async request<T>(request: RequestOptions): Promise<T> {
      if (request.path.endsWith('/contract')) return { catalogRef: 'agent:fixture',
        invoke: { method: 'POST', path: '/v1/agents/fixture/chat/{userId}', auth: 'api_key', async: false, statusPath: null },
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } }, outputSchema: {} } as T;
      if (request.path.endsWith('/scan')) { scans++; throw new Error(`advisory unavailable ${credential} ${bearer}`); }
      return { catalogRef: 'agent:fixture', kind: 'agent', id: 'fixture', name: 'public fixture', scope: 'workspace' } as T;
    }
  }
  const actual = scaffoldTools.find((item) => item.name === 'swfte_scaffold_client')!;
  const { client, wire } = await protocol(t, { config: { ...config(), telemetry: false }, localFilesystem: false,
    resolveClient: () => new ScaffoldClient(config(credential)), tools: [actual] }, auth(bearer));
  const result = await client.callTool({ name: actual.name, arguments: { catalogRef: 'agent:fixture', framework: 'plain-ts' } });
  assert.notEqual(result.isError, true);
  const body = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(body.inline, true);
  assert.ok(body.files.some((file: any) => file.path.endsWith('.ts') && typeof file.content === 'string'));
  assert.equal(scans, 1);
  assert.equal(body.complianceScan.complete, false);
  assert.equal(body.complianceScan.verdict, 'UNAVAILABLE');
  assert.equal(body.complianceScan.batchErrors.length, 1);
  assert.match(body.complianceScan.batchErrors[0], /advisory unavailable/);
  noSecrets(body.complianceScan, credential, bearer);
  noSecrets(wire, credential, bearer);
});

test('resolvedCallIdentityAndIncomingBearerGuardContentBeforeOutbound', async (t) => {
  const credential = 'resolved-content-opaque-fixture', bearer = 'incoming-content-opaque-fixture';
  let outbound = 0;
  const { client, wire } = await protocol(t, { config: config(), resolveClient: () => new SwfteClient(config(credential)), tools: [
    tool(async (input) => {
      const content = input.mode === 'resolved' ? credential : input.mode === 'incoming' ? bearer : 'ordinary public source';
      assertNoSecrets('to upload fixture content', content);
      outbound++;
      return { id: 'safe-upload', content };
    }, 'fixture_content', z.object({ mode: z.enum(['resolved', 'incoming', 'public']) })),
  ] }, auth(bearer));
  for (const mode of ['resolved', 'incoming']) {
    const error = await toolError(client, 'fixture_content', { mode });
    assert.match(error, /configured Swfte credential/);
    assert.equal(outbound, 0);
  }
  noSecrets(wire, credential, bearer);
  const result = await client.callTool({ name: 'fixture_content', arguments: { mode: 'public' } });
  assert.notEqual(result.isError, true);
  assert.equal(outbound, 1);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), { id: 'safe-upload', content: 'ordinary public source' });
});
