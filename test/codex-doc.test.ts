/**
 * G-DOC: docs/CODEX.md holds a config.toml MCP server entry (published package and local stdio build),
 * env-var auth with no literal token, the trailer behaviour, and a join-verification procedure. The
 * names it quotes are checked against the code, so the page cannot drift from what the server does.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LOCAL_STEPS_PATH,
  MCP_CLIENT_HEADER,
  MCP_SESSION_HEADER,
  MCP_TOOL_HEADER,
  TRACE_META_KEY,
  TRACE_TRAILER_PREFIX,
  TRACE_TRAILER_RE,
  TRACEPARENT_HEADER,
  UNREACHED_QUEUE_MAX,
  normaliseClientName,
} from '../src/learning-contract.js';
import { allTools } from '../src/tools/index.js';

const doc = readFileSync('docs/CODEX.md', 'utf8');

/** Fenced blocks of one language. */
function blocks(lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  for (let m = re.exec(doc); m; m = re.exec(doc)) out.push(m[1]!);
  return out;
}

/** The key = value lines of one TOML table, parsed just enough to check them. */
function table(toml: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inside = header[1] === name;
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    assert.ok(kv, `not a TOML key/value line: ${line}`);
    if (inside) out.set(kv[1]!, kv[2]!);
  }
  return out;
}

const tomlEntries = blocks('toml').map((t) => table(t, 'mcp_servers.swfte'));

/** Strings shaped like a real credential (a PAT or an API key), as opposed to a variable name. */
const LITERAL_TOKEN = /\b(pat_[A-Za-z0-9]{6,}|sk[-_][A-Za-z0-9][A-Za-z0-9_-]{7,})/;

describe('docs/CODEX.md (G-DOC)', () => {
  test('holds [mcp_servers.swfte] entries for the published package and the local stdio build', () => {
    assert.ok(tomlEntries.length >= 2, 'expected two config.toml blocks');
    const published = tomlEntries.find((e) => e.get('command') === '"npx"');
    const local = tomlEntries.find((e) => e.get('command') === '"node"');
    assert.ok(published, 'no npx entry');
    assert.ok(local, 'no local node entry');
    assert.match(published!.get('args') ?? '', /"@swfte\/mcp-server"/);
    assert.match(local!.get('args') ?? '', /dist\/index\.js"/);
    for (const e of [published!, local!]) {
      assert.match(e.get('startup_timeout_sec') ?? '', /^\d+$/);
      assert.match(e.get('tool_timeout_sec') ?? '', /^\d+$/);
    }
  });

  test('authenticates by forwarding environment variables by name, never by value', () => {
    for (const e of tomlEntries) {
      const vars = e.get('env_vars');
      assert.ok(vars, 'an entry does not forward the credential with env_vars');
      assert.match(vars!, /"SWFTE_PAT"/);
      assert.match(vars!, /"SWFTE_API_KEY"/);
      assert.equal(e.get('env'), undefined, 'an entry sets env = { ... }, which stores values in the file');
      for (const [k, v] of e) assert.ok(!/SWFTE_PAT|SWFTE_API_KEY/.test(k), `${k} = ${v} assigns the credential`);
    }
    for (const t of blocks('toml')) assert.doesNotMatch(t, /\benv\s*=/, 'a TOML block assigns env values');
    assert.doesNotMatch(doc, LITERAL_TOKEN, 'the page contains a credential-shaped literal');
    assert.match(doc, /export SWFTE_PAT=/);
    assert.match(doc, /Authorization: Bearer \$SWFTE_PAT/);
  });

  test('the literal-token check itself catches a pasted token', () => {
    // Negative control for the check above, built at runtime so this file holds no token-shaped literal.
    const pasted = `env = { SWFTE_PAT = "${['pat', 'a1B2c3D4e5F6g7H8'].join('_')}" }`;
    assert.match(pasted, LITERAL_TOKEN);
  });

  test('explains the trailer exactly as the server emits it, and why it exists', () => {
    assert.ok(doc.includes('`swfte-trace: `'), 'the exact trailer prefix is not quoted');
    assert.equal(TRACE_TRAILER_PREFIX, 'swfte-trace: ');
    const examples = blocks('text').map((b) => b.trim()).filter((b) => b.startsWith(TRACE_TRAILER_PREFIX.trim()));
    assert.ok(examples.length >= 1, 'no trailer example');
    for (const ex of examples) assert.match(ex, TRACE_TRAILER_RE, `trailer example is malformed: ${ex}`);
    assert.ok(doc.includes('`_meta`'));
    assert.ok(doc.includes(`\`${TRACE_META_KEY}\``), `the _meta key ${TRACE_META_KEY} is not named`);
    assert.match(doc, /last/i);
    assert.match(doc, /success or error/i);
    assert.match(doc, /hooks/i, 'the page does not say why the trailer exists (hooks may not see _meta)');
    assert.ok(doc.includes(TRACE_TRAILER_RE.source), 'the parse pattern differs from the contract');
  });

  test('names the headers, the local-step path and the queue bound the code uses', () => {
    for (const h of [TRACEPARENT_HEADER, MCP_SESSION_HEADER, MCP_CLIENT_HEADER, MCP_TOOL_HEADER]) {
      assert.ok(doc.includes(`\`${h}\``), `${h} is not documented`);
    }
    assert.ok(doc.includes(LOCAL_STEPS_PATH));
    assert.ok(doc.includes(`${UNREACHED_QUEUE_MAX} steps`), 'the queue bound in the page differs from the contract');
    assert.equal(normaliseClientName('codex-mcp-client'), 'codex', 'the page says Codex is sent as codex');
    assert.ok(doc.includes('`codex-mcp-client`'));
  });

  test('gives a numbered join-verification procedure against /v2/learning/records', () => {
    const steps = doc.split('## 5.')[1] ?? '';
    assert.ok(steps, 'no verification section');
    const numbered = steps.match(/^\d+\. /gm) ?? [];
    assert.ok(numbered.length >= 5, 'the procedure is not step by step');
    assert.match(steps, /\/v2\/learning\/records/);
    assert.match(steps, /swfte-trace/);
    // Records are selected by a step carrying the trailer's trace id, not by channel or recency.
    assert.match(steps, /select\(any\(\.steps\[\];\s*\.traceId == \$t\)\)/, 'the procedure does not select the record by trace id');
    assert.match(steps, /--arg t "\$TRACE"/);
    assert.match(steps, /"channel": "mcp"/);
    assert.match(steps, /"client": "codex"/);
    // Every tool the procedure names is a real tool.
    for (const name of new Set(steps.match(/swfte_[a-z_]+/g) ?? [])) {
      assert.ok(allTools.some((t) => t.name === name), `the procedure names a tool that does not exist: ${name}`);
    }
  });
});
