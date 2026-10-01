import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwfteApiError, SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { ConfinedWriter, OverwriteRefusedError } from '../src/fsguard.js';

const client = () => new SwfteClient(loadConfig({ SWFTE_PAT: 'pat_download_control' } as never));
const large = (error: unknown) => error instanceof SwfteApiError && error.code === 'RESPONSE_TOO_LARGE';
function replaceFetch(t: { after: (fn: () => void) => void }, response: Response) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response; };
  t.after(() => { globalThis.fetch = original; });
  return () => calls;
}
function countedStream(chunks: Uint8Array[]) {
  let reads = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { stream, reads: () => reads, cancelled: () => cancelled };
}

test('binary declared limit refuses before reading and cancels the body', async t => {
  const body = countedStream([Uint8Array.of(1, 2, 3)]);
  const calls = replaceFetch(t, new Response(body.stream, { headers: { 'content-length': '33554433' } }));
  await assert.rejects(client().getBinary('/export'), large);
  assert.equal(body.reads(), 0); assert.equal(body.cancelled(), 1); assert.equal(calls(), 1);
});
test('binary actual limit refuses understated and missing lengths before archive parsing', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const length of [undefined, '1']) {
    const chunk = new Uint8Array(1024 * 1024);
    const body = countedStream([...Array<Uint8Array>(32).fill(chunk), Uint8Array.of(1)]);
    globalThis.fetch = async () => new Response(body.stream, { headers: length ? { 'content-length': length } : {} });
    await assert.rejects(client().getBinary('/export'), large);
    assert.equal(body.reads(), 33); assert.equal(body.cancelled(), 1);
  }
});
test('binary success preserves the exact boundary and safe response metadata', async t => {
  const chunk = new Uint8Array(1024 * 1024).fill(42);
  const body = countedStream(Array<Uint8Array>(32).fill(chunk));
  replaceFetch(t, new Response(body.stream, { headers: { 'content-type': 'application/zip', 'x-swfte-emitter-version': '0.8.7' } }));
  const result = await client().getBinary('/export');
  assert.equal(result.bytes.byteLength, 32 * 1024 * 1024);
  assert.equal(result.bytes[0], 42); assert.equal(result.bytes[result.bytes.length - 1], 42);
  assert.equal(result.contentType, 'application/zip'); assert.equal(result.headers['x-swfte-emitter-version'], '0.8.7');
  assert.equal(body.cancelled(), 0);
});
test('binary error and redirect bodies cannot bypass the smaller error limit', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const status of [422, 302]) {
    const body = countedStream([new Uint8Array(1024 * 1024), Uint8Array.of(1)]);
    globalThis.fetch = async () => new Response(body.stream, { status, headers: { 'content-type': 'application/json' } });
    await assert.rejects(client().getBinary('/export'), large);
    assert.equal(body.reads(), 2); assert.equal(body.cancelled(), 1);
  }
});
test('binary bounded refusal preserves structured backend fields and does not retry', async t => {
  const calls = replaceFetch(t, Response.json({ error: 'TRANSLATION_REFUSED', refusals: [{ code: 'UNSUPPORTED_NODE' }] }, { status: 422 }));
  await assert.rejects(client().getBinary('/export'), error => {
    assert.ok(error instanceof SwfteApiError);
    assert.equal(error.status, 422); assert.equal(error.code, 'TRANSLATION_REFUSED');
    assert.deepEqual(error.envelope.refusals, [{ code: 'UNSUPPORTED_NODE' }]);
    return true;
  });
  assert.equal(calls(), 1);
});
test('binary operation deadline cancels a body that ignores the fetch signal', { timeout: 3000 }, async t => {
  let cancelled = 0;
  replaceFetch(t, new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => undefined); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 })));
  const c = client();
  await assert.rejects(c.withDeadline(Date.now() + 30, () => c.getBinary('/export')), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(cancelled, 1);
});

function directory(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'swfte-create-race-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('late regular-file collisions refuse the entire plan before any write', t => {
  const root = directory(t), writer = new ConfinedWriter({ root });
  const first = writer.resolve('first.ts'), collision = writer.resolve('raced.bin');
  writer.create(first, 'new code'); writer.createBytes(collision, Uint8Array.of(1, 2));
  fs.writeFileSync(collision, 'concurrent owner bytes');
  assert.throws(() => writer.commit(), OverwriteRefusedError);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'concurrent owner bytes');
  assert.equal(fs.existsSync(first), false);
});
test('exclusive create closes the ordinary-file race after the commit precheck', t => {
  const root = directory(t), writer = new ConfinedWriter({ root });
  const collision = writer.resolve('raced.ts');
  writer.create(collision, 'new code');
  const original = fs.openSync;
  let planted = false;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === collision && !planted) {
      planted = true; fs.writeFileSync(collision, 'concurrent owner bytes');
    }
    return original(...args);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => writer.commit(), OverwriteRefusedError);
    assert.equal(planted, true); assert.equal(fs.readFileSync(collision, 'utf8'), 'concurrent owner bytes');
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
});
test('late files also refuse create-only env and JSON merges', t => {
  const root = directory(t);
  for (const kind of ['env', 'json']) {
    const writer = new ConfinedWriter({ root });
    const path = writer.resolve(kind === 'env' ? '.env.local' : 'swfte.json', { allowEnvFile: true });
    if (kind === 'env') writer.mergeEnv(path, [{ key: 'API_URL', value: 'https://api.swfte.com' }]);
    else writer.mergeJson(path, () => ({ version: 1 }));
    fs.writeFileSync(path, 'concurrent owner bytes');
    assert.throws(() => writer.commit(), OverwriteRefusedError);
    assert.equal(fs.readFileSync(path, 'utf8'), 'concurrent owner bytes');
  }
});
test('normal creation explicit overwrite and hosted inline mode remain functional', t => {
  const root = directory(t), path = join(root, 'main.ts');
  const writer = new ConfinedWriter({ root });
  writer.create(writer.resolve('main.ts'), 'new code');
  assert.equal(writer.commit()[0].action, 'create'); assert.equal(fs.readFileSync(path, 'utf8'), 'new code');
  const replace = new ConfinedWriter({ root });
  replace.create(replace.resolve('main.ts'), 'replacement code', true);
  assert.equal(replace.commit()[0].action, 'overwrite'); assert.equal(fs.readFileSync(path, 'utf8'), 'replacement code');
  const hosted = new ConfinedWriter({ inline: true });
  hosted.create(hosted.resolve('main.ts'), 'inline code');
  assert.equal(hosted.commit()[0].content, 'inline code'); assert.equal(fs.readFileSync(path, 'utf8'), 'replacement code');
});
