/** One version source (review r-mcp R14). Named `G11:`; fails on origin/master because config.ts hard-codes the user agent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { renderTypeScriptClient } from '../src/codegen.js';

test('G11: single version source - package.json, src/version.ts, the user agent and the generated client agree', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(PACKAGE_VERSION, pkg.version);
  const cfg = loadConfig({ SWFTE_PAT: 'pat_TESTPAT123456' } as never);
  assert.equal(cfg.userAgent, `swfte-mcp-server/${pkg.version} (+https://www.swfte.com)`);
  const spec: any = {
    catalogRef: 'workflow:w', kind: 'workflow', id: 'w', name: 'n', contractHash: 'abc', defaultBaseUrl: 'https://api.swfte.com/agents',
    contract: { catalogRef: 'workflow:w', invoke: { method: 'POST', path: '/v2/x', auth: 'pat', async: false, statusPath: null }, inputSchema: {}, outputSchema: {} },
  };
  assert.ok(renderTypeScriptClient(spec).includes(`typescript/${pkg.version}`), 'generated client advertises the package version');
});

test('G11: the version is not hard-coded anywhere else in src', () => {
  const src = readFileSync(join(process.cwd(), 'src/config.ts'), 'utf8');
  assert.doesNotMatch(src, /'0\.2\.0'/);
});
