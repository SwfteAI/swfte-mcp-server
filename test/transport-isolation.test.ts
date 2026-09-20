import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, withTransport } from '../src/preflight/lib/api.mjs';

test('concurrent preflights retain caller identity for queued and later requests', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const alice = withTransport(async path => `alice:${path}`, async () => {
    const first = get('/first');
    await barrier;
    return [await first, await get('/later')];
  });
  const bob = withTransport(async path => `bob:${path}`, async () => {
    release();
    return [await get('/first'), await get('/later')];
  });
  assert.deepEqual(await alice, ['alice:/first', 'alice:/later']);
  assert.deepEqual(await bob, ['bob:/first', 'bob:/later']);
});

test('nested failing preflight restores the outer caller', async () => {
  await withTransport(async () => 'outer', async () => {
    await assert.rejects(withTransport(async () => { throw new Error('inner'); }, () => get('/')));
    assert.equal(await get('/'), 'outer');
  });
});
