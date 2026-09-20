import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widgetAdapter } from '../src/kinds/widget.js';
function client(record: any, source: any) {
  const calls: string[] = [];
  return { calls, request: async ({ path }: any) => {
    calls.push(path);
    if (path.endsWith('/deployments')) return [{ id: 'd', status: 'LIVE' }];
    if (path.startsWith('/v1/widget-bindings/')) return source;
    if (path === '/v1/widgets/w') return { id: 'w' };
    if (path === '/api/v2/widgets/w') return record;
    throw Error(`Unsupported path ${path}`);
  } } as any;
}
const widget = { id: 'w', workspaceId: '1', viewType: 'MIXED', binding: 'PULL', dataBindingId: 'b', active: true, deploymentId: 'd' };
test('graphical binding does not require a brain or an invented embed endpoint', async () => {
  const c = client(widget, { id: 'b', workspaceId: '1', sourceType: 'STUDIO_OPERATIONS' });
  const r = await widgetAdapter.verify!(c, 'w', { requirePublished: true });
  assert.equal(r.checks.find(x => x.id === 'bound')?.ok, true);
  assert.equal(r.checks.find(x => x.id === 'rendering')?.ok, null);
  assert(r.nextActions.some(x => x.includes('authenticated')));
  assert(!c.calls.some((p: string) => p.endsWith('/embed')));
});
test('foreign data binding fails verification', async () => {
  const r = await widgetAdapter.verify!(client(widget, { id: 'b', workspaceId: '2', sourceType: 'STUDIO_OPERATIONS' }), 'w', {});
  assert.equal(r.ok, false);
});
test('PULL labels do not pretend to be a conversational brain', async () => {
  const r = await widgetAdapter.verify!(client({ id: 'w', viewType: 'CHAT', binding: 'PULL' }, null), 'w', {});
  assert.equal(r.checks.find(x => x.id === 'bound')?.ok, false);
});
test('unconfigured graphical source stays explicitly unverified', async () => {
  const r = await widgetAdapter.verify!(client({ id: 'w', viewType: 'TABLE', binding: 'PUSH' }, null), 'w', {});
  assert.equal(r.checks.find(x => x.id === 'bound')?.ok, null);
  assert(r.nextActions.some(x => x.includes('PUSH')));
});
