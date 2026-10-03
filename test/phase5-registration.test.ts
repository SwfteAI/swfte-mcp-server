import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allTools } from '../src/tools/index.js';
import { selectTools } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { runCli } from '../src/cli.js';

test('Phase5 registry exposes decision and OpenAPI tools under core and canvas check under workflows', () => {
  const config = loadConfig({ SWFTE_PAT: 'pat_TEST_REGISTRATION', SWFTE_TOOLS: 'core', SWFTE_TELEMETRY: '0' });
  const selected = selectTools(allTools, config);
  for (const [name, readOnly] of [
    ['swfte_get_decisions', true], ['swfte_ingest_decisions', false], ['swfte_get_openapi', true],
  ] as const) {
    const tools = selected.filter(tool => tool.name === name);
    assert.equal(tools.length, 1, `${name} registered once in core`);
    assert.equal(tools[0]!.readOnly, readOnly);
  }
  assert.equal(allTools.filter(tool => tool.name === 'swfte_translate_check').length, 1);
  assert.equal(allTools.find(tool => tool.name === 'swfte_translate_check')!.readOnly, true);
  assert.equal(allTools.find(tool => tool.name === 'swfte_translate_check')!.group, 'workflows');
});

test('real CLI dispatch previews Nexus before unrelated config or credential parsing and performs zero HTTP', async t => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-p5-cli-')));
  mkdirSync(join(cwd, '.nexus', 'ledger'), { recursive: true });
  writeFileSync(join(cwd, '.nexus', 'ledger', '2026-10-01.ndjson'), JSON.stringify({ schema: '1',
    type: 'rationale', event_id: 'one', session_id: 'session', ts: '2026-10-01T10:00:00Z',
    rationale: 'Private source prose.', repo: 'repo-a', source: 'llm', files: ['src/flow.ts'] }) + '\n');
  writeFileSync(join(cwd, 'swfte.json'), '{malformed private config');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const output: string[] = [], errors: string[] = [];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('preview must not call HTTP'); }) as typeof fetch;
  try {
    const code = await runCli(['decisions', 'ingest', '--from', '.nexus', '--ref', 'workflow:flow', '--json'], {
      cwd, env: { SWFTE_BASE_URL: 'invalid-config-with-no-token' },
      out: line => output.push(line), err: line => errors.push(line),
    });
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    const report = JSON.parse(output[0]!);
    assert.equal(report.dryRun, true);
    assert.equal(report.proposed, 1);
    assert.equal(calls, 0);
    assert.equal(output.join('').includes('Private source prose'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('real CLI decisions help works without credentials and rejects implicit apply values', async () => {
  const output: string[] = [], errors: string[] = [];
  const io = { cwd: process.cwd(), env: {}, out: (line: string) => output.push(line), err: (line: string) => errors.push(line) };
  assert.equal(await runCli(['decisions', '--help'], io), 0);
  assert.match(output.join('\n'), /zero HTTP/);
  assert.equal(await runCli(['decisions', 'ingest', '--apply=true'], io), 1);
  assert.match(errors.join('\n'), /USAGE/);
});
