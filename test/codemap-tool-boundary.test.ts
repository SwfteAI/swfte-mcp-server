import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { codeMapTools } from '../src/tools/codemap.js';
import type { ToolContext } from '../src/tools/_types.js';

const impact = codeMapTools.find(tool => tool.name === 'swfte_code_impact')!;
const fix = codeMapTools.find(tool => tool.name === 'swfte_code_fix')!;
const base = { artifactRef: 'workflow:wf_a', from: 'custom@v3:release+build', to: 'v4' };
const fixBase = { ...base, repoId: 'r_' + 'a'.repeat(32), callSiteId: 'cs_' + 'b'.repeat(24), strategy: 'upgrade' };

// Match actual MCP dispatch: parse the tool schema before calling execute.
async function dispatch(tool: typeof impact, input: unknown, context: ToolContext): Promise<unknown> {
  return tool.execute(tool.inputSchema.parse(input), context);
}

test('actual impact and fix tool schemas reject raw control suffixes with zero GET/POST', async () => {
  let requests = 0;
  const context = { client: { request: async () => { requests++; throw new Error('unexpected request'); } } } as unknown as ToolContext;
  for (const [tool, input] of [[impact, base], [fix, fixBase]] as const) {
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029', '\0', '\t', '\nend', '\x7f']) {
      for (const field of Object.keys(input).filter(key => key !== 'strategy')) {
        const value = { ...input, [field]: (input as Record<string,string>)[field] + suffix };
        await assert.rejects(dispatch(tool, value, context));
        assert.equal(requests, 0);
      }
    }
  }
});

test('advertised JSON schema patterns retain exact-end refusal and raw positive labels', () => {
  for (const [tool, input] of [[impact, base], [fix, fixBase]] as const) {
    const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' }) as { properties: Record<string,{ pattern?: string }> };
    for (const [field, value] of Object.entries(input)) {
      if (field === 'strategy') continue;
      const pattern = schema.properties[field]!.pattern;
      assert.equal(typeof pattern, 'string');
      const regex = new RegExp(pattern!);
      assert(regex.test(value));
      for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029', '\0', '\t', '\x7f']) assert(!regex.test(value + suffix), field + ' generated schema suffix');
    }
  }
});

test('positive actual tool dispatch preserves raw identities and correct GET/POST', async () => {
  const seen: Array<Record<string,unknown>> = [];
  const context = { client: { request: async (request: Record<string,unknown>) => {
    seen.push(request);
    return request.method === 'GET' ? { ...(request.query as object), verdict: 'known', breaking: [], cannotCheck: [], safe: [], pinned: [], unknownReasons: [] } : { proposalId: 'fixture-only' };
  } } } as unknown as ToolContext;
  for (const label of ['custom@v3:release+build', '0', '-1', 'a'.repeat(128)]) {
    const input = { ...base, from: label, to: label };
    await dispatch(impact, input, context);
    assert.deepEqual(seen.at(-1), { method: 'GET', path: '/v2/codemap/impact', query: input });
    const body = { ...fixBase, ...input };
    await dispatch(fix, body, context);
    assert.deepEqual(seen.at(-1), { method: 'POST', path: '/v2/codemap/fix-proposals', body, retries: 0 });
  }
  const count = seen.length;
  await assert.rejects(dispatch(impact, { ...base, from: 'a'.repeat(129) }, context));
  await assert.rejects(dispatch(fix, { ...fixBase, repoId: 'r_' + 'a'.repeat(33) }, context));
  assert.equal(seen.length, count);
});
