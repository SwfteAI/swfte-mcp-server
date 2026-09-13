import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatFlowTools } from '../src/tools/chatflows.js';
const tool = chatFlowTools.find(value => value.name === 'swfte_chatflows_session_input')!;
test('chatflow billable turns require a bounded stable operation identity', () => {
  for (const operationId of [undefined, '', ' ', 'x'.repeat(129)])
    assert.throws(() => tool.inputSchema.parse({ sessionId: 's', input: 'hello', operationId }));
});
test('chatflow delivery retries preserve identity, body and workspace without automatic replay', async () => {
  const calls: any[] = [];
  const context: any = { client: { request: async (request: any) => { calls.push(request); return { success: true }; } } };
  const input = { sessionId: 's/1', workspaceId: '2', operationId: 'turn-1', input: 'hello' };
  await tool.execute(input, context); await tool.execute(input, context);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].path, '/v2/chatflows/sessions/s%2F1/input');
  assert.equal(calls[0].body.operationId, 'turn-1'); assert.equal(calls[0].retries, 0); assert.equal(calls[0].workspaceId, '2');
});
test('ambiguous turn failure is exposed without silently replacing the operation ID', async () => {
  const calls: any[] = [];
  const context: any = { client: { request: async (request: any) => { calls.push(request); throw new Error('timeout'); } } };
  await assert.rejects(() => tool.execute({ sessionId: 's', operationId: 'original', input: 'hello' }, context), /timeout/);
  assert.equal(calls.length, 1); assert.equal(calls[0].body.operationId, 'original');
});
const statusTool = chatFlowTools.find(value => value.name === 'swfte_chatflows_operation_status')!;
const abandonTool = chatFlowTools.find(value => value.name === 'swfte_chatflows_operation_abandon')!;
const receipt = (status = 'IN_FLIGHT') => ({ sessionId: 's/1', operationId: 'op/1', status, canAbandon: status === 'IN_FLIGHT', startNewSession: status === 'OPERATOR_ABANDONED' });
test('operation status uses read permission semantics and preserves encoded scoped identity', async () => {
  const calls: any[] = [];
  const context: any = { client: { request: async (request: any) => { calls.push(request); return receipt(); } } };
  const result: any = await statusTool.execute({ sessionId: 's/1', operationId: 'op/1', workspaceId: '2' }, context);
  assert.equal(result.status, 'IN_FLIGHT'); assert.equal(statusTool.readOnly, true);
  assert.deepEqual(calls, [{ method: 'GET', path: '/v2/chatflows/sessions/s%2F1/operations/op%2F1', workspaceId: '2', retries: 1 }]);
});
test('abandon requires explicit confirmation and a human reason before any call', async () => {
  let calls = 0; const context: any = { client: { request: async () => { calls++; } } };
  for (const extra of [{ reason: 'human reason' }, { confirm: false, reason: 'human reason' }, { confirm: true, reason: 'short' }, { confirm: true, reason: 'x'.repeat(501) }])
    await assert.rejects(() => abandonTool.execute({ sessionId: 's', operationId: 'op', ...extra }, context));
  assert.equal(calls, 0); assert.equal(abandonTool.destructive, true);
});
test('confirmed abandonment performs one guarded request and requires sealed-session receipt', async () => {
  const calls: any[] = [];
  const context: any = { client: { request: async (request: any) => { calls.push(request); return receipt('OPERATOR_ABANDONED'); } } };
  const result: any = await abandonTool.execute({ sessionId: 's/1', operationId: 'op/1', workspaceId: '2', confirm: true, reason: 'Operator verified interrupted turn' }, context);
  assert.equal(result.startNewSession, true);
  assert.deepEqual(calls, [{ method: 'POST', path: '/v2/chatflows/sessions/s%2F1/operations/op%2F1/abandon', body: { reason: 'Operator verified interrupted turn' }, workspaceId: '2', retries: 0 }]);
});
test('operation denial and live-lock conflict propagate without mutation retry or input execution', async () => {
  for (const status of [403, 404, 409]) {
    const calls: any[] = []; const context: any = { client: { request: async (request: any) => { calls.push(request); throw new Error(`HTTP ${status}`); } } };
    await assert.rejects(() => abandonTool.execute({ sessionId: 's', operationId: 'op', confirm: true, reason: 'Operator investigated interruption' }, context), new RegExp(String(status)));
    assert.equal(calls.length, 1); assert.equal(calls[0].retries, 0);
  }
});
test('malformed or unrelated receipts never establish completed abandonment', async () => {
  for (const reply of [receipt('IN_FLIGHT'), { ...receipt('OPERATOR_ABANDONED'), operationId: 'other' }, { ...receipt('OPERATOR_ABANDONED'), startNewSession: false }]) {
    const context: any = { client: { request: async () => reply } };
    await assert.rejects(() => abandonTool.execute({ sessionId: 's/1', operationId: 'op/1', confirm: true, reason: 'Operator investigated interruption' }, context));
  }
});
