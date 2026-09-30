/**
 * Smaller pre-publish fixes (review r-mcp R12, R13, R18). Named `G14:` (base URL), `G15:` (Windows open),
 * `G16:` (fatal redaction); each fails against origin/master.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { cleanBaseUrl, ConfigError, loadConfig } from '../src/config.js';
import { windowsOpenCommand } from '../src/connections.js';
import { fatalLine } from '../src/fsguard.js';

describe('SWFTE_BASE_URL is https or loopback (R13)', () => {
  test('G14: plain http to a remote host is refused, https and loopback http are accepted', () => {
    for (const bad of ['http://api.example.com/agents', 'http://10.0.0.5:8080', 'ftp://x.example.com']) {
      assert.throws(() => cleanBaseUrl(bad), ConfigError, bad);
      assert.throws(() => loadConfig({ SWFTE_PAT: 'pat_TESTPAT123456', SWFTE_BASE_URL: bad } as never), ConfigError, bad);
    }
    for (const good of ['https://api.swfte.com/agents', 'http://localhost:8080/', 'http://127.0.0.1:9/agents', 'http://[::1]:8080']) {
      assert.doesNotThrow(() => cleanBaseUrl(good), good);
    }
  });

  test('G14: SWFTE_ALLOW_INSECURE_BASE_URL=1 is the explicit override, and the error says so', () => {
    assert.throws(() => cleanBaseUrl('http://api.example.com'), /SWFTE_ALLOW_INSECURE_BASE_URL/);
    assert.equal(loadConfig({ SWFTE_PAT: 'pat_TESTPAT123456', SWFTE_BASE_URL: 'http://api.example.com', SWFTE_ALLOW_INSECURE_BASE_URL: '1' } as never).baseUrl, 'http://api.example.com');
  });

  test('G14: the error never repeats the URL (it may carry a secret)', () => {
    try {
      cleanBaseUrl('http://secret-host.example.com/agents?k=sekret');
      assert.fail('should throw');
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /sekret|secret-host/);
    }
  });
});

describe('opening a server-supplied URL on Windows (R12)', () => {
  test('G15: the Windows opener never goes through cmd, and passes the URL as one argument', () => {
    const url = 'https://auth.example.com/authorize?a=1&b=2|calc^&x=%PATH%';
    const [cmd, args] = windowsOpenCommand(url);
    assert.notEqual(cmd.toLowerCase(), 'cmd');
    assert.ok(!args.includes('/c') && !args.includes('start'));
    assert.deepEqual(args.filter((a) => a.includes('&')), [url], 'the whole URL is exactly one argv entry');
  });
});

describe('fatal errors are redacted (R18)', () => {
  test('G16: a credential in an error stack never reaches stderr', () => {
    const pat = 'pat_abcdefghijklmnopqrstuvwxyz0123';
    const err = new Error(`request failed for token ${pat}`);
    const line = fatalLine('swfte-mcp', err, { SWFTE_PAT: pat } as never);
    assert.ok(!line.includes(pat));
    assert.match(line, /^\[swfte-mcp\] fatal: /);
    assert.match(line, /request failed/);
    const key = 'sk-swfte-abcdefghijklmnop123456';
    assert.ok(!fatalLine('swfte', new Error(`x ${key}`), { SWFTE_API_KEY: key } as never).includes(key));
  });
});
