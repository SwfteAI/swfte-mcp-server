/**
 * The manifest allowlist serializer (docs/codemap/CONTRACT.md §3, agents-service manifest.schema.json).
 *
 * It is the one gate between the scanner and the wire. Every test asserts both that a violation is
 * refused and that the refusal names a JSON pointer, never the value (a value could be a snippet of
 * the customer's code, which must not reach a log line either).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pathHash, type AssignedSite } from '../src/codemap/fingerprint.js';
import { buildManifest, checkManifest, ManifestViolationError, serializeManifest } from '../src/codemap/manifest.js';
import type { DetectedSite, Manifest } from '../src/codemap/types.js';

const KEY = Buffer.alloc(32, 0x5c);
const REPO = 'r_0123456789abcdef0123456789abcdef';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SECRETISH = 'const token = readVault("prod")';

function validSite(i = 0): Record<string, unknown> {
  return {
    id: `cs_${i.toString(16).padStart(24, '0')}`,
    path: 'apps/web/src/checkout.ts',
    line: 12 + i,
    symbol: 'Checkout.submit',
    language: 'typescript',
    sdk: 'node',
    op: 'run',
    artifact: { kind: 'workflow', id: 'wf_123', unresolved: false, pinnedVersion: null, alias: 'order-flow', environment: null },
    contractHash: 'abcdef0123456789',
    inputKeys: ['customer.email', 'items'],
    outputKeys: ['*'],
    managed: 'typed-client',
  };
}

function valid(): Record<string, any> {
  return {
    schema: 'swfte.codemap/1',
    repo: { id: REPO, displayName: 'acme/web', provider: 'github', defaultBranch: 'main' },
    commitSha: SHA,
    ref: { kind: 'default' },
    scannedAt: '2026-09-27T10:00:00.000Z',
    scanner: 'cli',
    pathHashing: false,
    truncated: false,
    notAnalysed: { go: 3 },
    envVarNames: ['SWFTE_WORKFLOW_ID'],
    callSites: [validSite(0)],
  };
}

/** Assert a refusal at `pointer`, and that no part of the message repeats `value`. */
function refused(m: unknown, pointer: string, value?: string, code = 'ALLOWLIST_VIOLATION') {
  let caught: unknown;
  try {
    serializeManifest(m);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ManifestViolationError, `expected a ManifestViolationError at ${pointer}`);
  assert.equal(caught.code, code);
  assert.equal(caught.pointer, pointer);
  if (value) assert.ok(!caught.message.includes(value), 'the message must never carry the value');
}

describe('allowlist: only contract fields, copied by name', () => {
  test('a valid manifest serializes to exactly the contract keys, in contract order', () => {
    const out = JSON.parse(serializeManifest(valid()));
    assert.deepEqual(Object.keys(out), ['schema', 'repo', 'commitSha', 'ref', 'scannedAt', 'scanner', 'pathHashing', 'truncated', 'notAnalysed', 'envVarNames', 'callSites']);
    assert.deepEqual(Object.keys(out.callSites[0]), ['id', 'path', 'line', 'symbol', 'language', 'sdk', 'op', 'artifact', 'contractHash', 'inputKeys', 'outputKeys', 'managed']);
    assert.deepEqual(out, valid());
  });

  test('every non-contract field is refused at every level, with its pointer and without its value', () => {
    const cases: Array<[string, (m: Record<string, any>) => void]> = [
      ['/snippet', (m) => (m.snippet = SECRETISH)],
      ['/repo/url', (m) => (m.repo.url = SECRETISH)],
      ['/ref/branch', (m) => (m.ref.branch = SECRETISH)],
      ['/callSites/0/snippet', (m) => (m.callSites[0].snippet = SECRETISH)],
      ['/callSites/0/text', (m) => (m.callSites[0].text = SECRETISH)],
      ['/callSites/0/artifact/value', (m) => (m.callSites[0].artifact.value = SECRETISH)],
      ['/callSites/0/provenance/prompt', (m) => (m.callSites[0].provenance = { addedBy: 'human', via: 'cli', at: '2026-09-27T10:00:00Z', prompt: SECRETISH })],
      ['/callSites/0/toJSON', (m) => (m.callSites[0].toJSON = () => ({ ...validSite(0), snippet: SECRETISH }))],
    ];
    for (const [pointer, mutate] of cases) {
      const m = valid();
      mutate(m);
      refused(m, pointer, SECRETISH);
    }
  });

  test('the output is built from primitives, never from the input objects', () => {
    const input = valid();
    const out = checkManifest(input);
    assert.notEqual(out.callSites[0], input.callSites[0]);
    assert.notEqual(out.callSites[0]!.artifact, input.callSites[0].artifact);
    assert.notEqual(out.callSites[0]!.inputKeys, input.callSites[0].inputKeys);
    // Mutating the input afterwards cannot reach the checked copy.
    input.callSites[0].artifact.extra = SECRETISH;
    assert.ok(!JSON.stringify(out).includes(SECRETISH));
  });

  test('objects that are not plain (class instances, symbol keys, sparse arrays) are refused', () => {
    class Site {}
    const m1 = valid();
    m1.callSites[0] = Object.assign(new Site(), validSite(0));
    refused(m1, '/callSites/0');
    const m2 = valid();
    m2.callSites[0][Symbol('hidden')] = SECRETISH;
    refused(m2, '/callSites/0/(symbol)', SECRETISH);
    const m3 = valid();
    m3.envVarNames = ['SWFTE_A'];
    m3.envVarNames.note = SECRETISH;
    refused(m3, '/envVarNames', SECRETISH);
  });
});

describe('bounds of CONTRACT §3', () => {
  test('symbol: at most 128 characters and no spaces, quotes or parentheses (a snippet cannot fit)', () => {
    const ok = valid();
    ok.callSites[0].symbol = 'a'.repeat(128);
    assert.doesNotThrow(() => serializeManifest(ok));
    for (const bad of ['a'.repeat(129), 'submit order', 'f("x")', "f'x'", 'call()']) {
      const m = valid();
      m.callSites[0].symbol = bad;
      refused(m, '/callSites/0/symbol', bad.length > 20 ? bad : undefined);
    }
  });

  test('path: at most 400 characters, safe characters only, no leading slash, no .. segment', () => {
    const ok = valid();
    ok.callSites[0].path = `src/${'a'.repeat(396)}`;
    assert.doesNotThrow(() => serializeManifest(ok));
    for (const bad of [`src/${'a'.repeat(397)}`, '/etc/passwd', 'src/../../etc/hosts', '..', 'src/a b.ts', 'src/a"b.ts', 'src\\a.ts']) {
      const m = valid();
      m.callSites[0].path = bad;
      refused(m, '/callSites/0/path');
    }
  });

  test('ids: call site, movedFrom, repo and pathHash patterns', () => {
    const cases: Array<[string, (m: Record<string, any>) => void]> = [
      ['/callSites/0/id', (m) => (m.callSites[0].id = 'cs_XYZ')],
      ['/callSites/0/movedFrom', (m) => (m.callSites[0].movedFrom = 'cs_short')],
      ['/repo/id', (m) => (m.repo.id = 'r_nothex')],
      ['/commitSha', (m) => (m.commitSha = 'abc')],
      ['/callSites/0/artifact/id', (m) => (m.callSites[0].artifact.id = 'wf 1')],
    ];
    for (const [pointer, mutate] of cases) {
      const m = valid();
      mutate(m);
      refused(m, pointer);
    }
  });

  test('every other string is bounded to 128 and its pattern or enum', () => {
    const long = 'x'.repeat(129);
    const cases: Array<[string, (m: Record<string, any>) => void]> = [
      ['/repo/displayName', (m) => (m.repo.displayName = long)],
      ['/repo/displayName', (m) => (m.repo.displayName = 'Acme Web')],
      ['/repo/defaultBranch', (m) => (m.repo.defaultBranch = long)],
      ['/repo/provider', (m) => (m.repo.provider = 'sourceforge')],
      ['/scanner', (m) => (m.scanner = 'ide')],
      ['/scannedAt', (m) => (m.scannedAt = '27/09/2026')],
      ['/callSites/0/language', (m) => (m.callSites[0].language = 'go')],
      ['/callSites/0/op', (m) => (m.callSites[0].op = 'delete')],
      ['/callSites/0/artifact/kind', (m) => (m.callSites[0].artifact.kind = 'Workflow')],
      ['/callSites/0/artifact/pinnedVersion', (m) => (m.callSites[0].artifact.pinnedVersion = 'v'.repeat(81))],
      ['/callSites/0/artifact/alias', (m) => (m.callSites[0].artifact.alias = 'Order Flow')],
      ['/callSites/0/contractHash', (m) => (m.callSites[0].contractHash = 'not-hex')],
    ];
    for (const [pointer, mutate] of cases) {
      const m = valid();
      mutate(m);
      refused(m, pointer, long);
    }
  });

  test('line 1..10^7 and pr 1..10^9, integers only', () => {
    for (const line of [0, 10_000_001, 1.5, '12']) {
      const m = valid();
      m.callSites[0].line = line;
      refused(m, '/callSites/0/line');
    }
    const pr = valid();
    pr.ref = { kind: 'pr', pr: 1_000_000_001 };
    refused(pr, '/ref/pr');
    const prOnDefault = valid();
    prOnDefault.ref = { kind: 'default', pr: 4 };
    refused(prOnDefault, '/ref/pr');
    const ok = valid();
    ok.ref = { kind: 'pr', pr: 42 };
    assert.equal(JSON.parse(serializeManifest(ok)).ref.pr, 42);
  });

  test('key names: pattern, 64 per side, unique, and the wildcard stands alone', () => {
    const cases: Array<[string, unknown]> = [
      ['/callSites/0/inputKeys/0', ['has space']],
      ['/callSites/0/inputKeys/0', ['a'.repeat(129)]],
      ['/callSites/0/inputKeys', Array.from({ length: 65 }, (_, i) => `k${i}`)],
      ['/callSites/0/inputKeys', ['a', 'a']],
      ['/callSites/0/inputKeys', ['*', 'a']],
    ];
    for (const [pointer, keys] of cases) {
      const m = valid();
      m.callSites[0].inputKeys = keys;
      refused(m, pointer);
    }
  });

  test('envVarNames: ≤128 unique names of ^[A-Z][A-Z0-9_]{0,63}$; notAnalysed ≤16 languages of non-negative counts', () => {
    const lower = valid();
    lower.envVarNames = ['swfte_id'];
    refused(lower, '/envVarNames/0');
    const many = valid();
    many.envVarNames = Array.from({ length: 129 }, (_, i) => `SWFTE_${i}`);
    refused(many, '/envVarNames');
    const dup = valid();
    dup.envVarNames = ['SWFTE_A', 'SWFTE_A'];
    refused(dup, '/envVarNames');
    const langs = valid();
    langs.notAnalysed = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`lang${i}`, 1]));
    refused(langs, '/notAnalysed');
    const neg = valid();
    neg.notAnalysed = { go: -1 };
    refused(neg, '/notAnalysed/go');
  });

  test('artifact: id is null exactly when unresolved; environment is always null from the scanner', () => {
    const a = valid();
    a.callSites[0].artifact.unresolved = true;
    refused(a, '/callSites/0/artifact/id');
    const b = valid();
    b.callSites[0].artifact.id = null;
    refused(b, '/callSites/0/artifact/id');
    const c = valid();
    c.callSites[0].artifact.environment = 'sandbox';
    refused(c, '/callSites/0/artifact/environment');
    const d = valid();
    delete d.callSites[0].artifact.alias;
    refused(d, '/callSites/0/artifact/alias');
  });

  test('call sites: at most 5000, ids unique', () => {
    const many = valid();
    many.callSites = Array.from({ length: 5001 }, (_, i) => validSite(i));
    refused(many, '/callSites');
    const dup = valid();
    dup.callSites = [validSite(0), validSite(0)];
    refused(dup, '/callSites/1/id');
  });

  test('a body over 2 MiB is MANIFEST_TOO_LARGE even when every field is in bounds', () => {
    const big = valid();
    big.callSites = Array.from({ length: 5000 }, (_, i) => ({ ...validSite(i), path: `src/${String(i).padStart(396, 'p')}` }));
    refused(big, '', undefined, 'MANIFEST_TOO_LARGE');
  });
});

describe('hashed mode and buildManifest', () => {
  test('pathHashing true: path is refused and pathHash required; false: the reverse', () => {
    const hashed = valid();
    hashed.pathHashing = true;
    refused(hashed, '/callSites/0/path');
    delete hashed.callSites[0].path;
    refused(hashed, '/callSites/0/pathHash');
    hashed.callSites[0].pathHash = pathHash(KEY, REPO, 'apps/web/src/checkout.ts');
    assert.doesNotThrow(() => serializeManifest(hashed));
    const plain = valid();
    plain.callSites[0].pathHash = hashed.callSites[0].pathHash;
    refused(plain, '/callSites/0/pathHash');
  });

  const detected = (relPath: string, line: number, extra: Partial<DetectedSite> = {}): DetectedSite => ({
    relPath,
    line,
    symbol: 'handler',
    language: 'python',
    category: 'managed',
    sdk: 'python',
    op: 'chat',
    managed: 'typed-client',
    artifact: { kind: 'agent', id: 'ag_1', unresolved: false, pinnedVersion: '3', alias: null },
    contractHash: null,
    inputKeys: ['b', 'a', 'b'],
    outputKeys: [],
    detector: 'py.managed',
    ...extra,
  });
  const assigned = (s: DetectedSite, n: number): AssignedSite => ({ site: s, id: `cs_${n.toString(16).padStart(24, 'a')}` });

  test('hashed mode emits pathHash (keyed, per the contract) and never path', () => {
    const m = buildManifest({
      repo: { id: REPO, provider: 'none', defaultBranch: 'main' },
      commitSha: SHA,
      scanner: 'ci',
      pathHashing: true,
      truncated: false,
      notAnalysed: {},
      envVarNames: [],
      sites: [assigned(detected('svc/app.py', 4), 1)],
      key: KEY,
    });
    const wire = serializeManifest(m);
    assert.ok(!wire.includes('svc/app.py'), 'the path never appears in hashed mode');
    const site = JSON.parse(wire).callSites[0];
    assert.equal(site.path, undefined);
    assert.equal(site.pathHash, pathHash(KEY, REPO, 'svc/app.py'));
    assert.throws(() => buildManifest({ repo: m.repo, commitSha: SHA, scanner: 'ci', pathHashing: true, truncated: false, notAnalysed: {}, envVarNames: [], sites: [] }));
  });

  test('buildManifest drops scanner-only fields, sorts keys and names, and orders sites deterministically', () => {
    const input = {
      repo: { id: REPO, provider: 'github' as const, defaultBranch: 'main' },
      commitSha: SHA,
      scannedAt: '2026-09-27T10:00:00Z',
      scanner: 'cli' as const,
      pathHashing: false,
      truncated: true,
      notAnalysed: { ruby: 1, go: 2 },
      envVarNames: ['SWFTE_B', 'SWFTE_A', 'SWFTE_B'],
      sites: [assigned(detected('z.py', 1), 3), assigned(detected('a.py', 9), 2), assigned(detected('a.py', 2), 1)],
    };
    const m = buildManifest(input);
    assert.deepEqual(m.callSites.map((s) => `${s.path}:${s.line}`), ['a.py:2', 'a.py:9', 'z.py:1']);
    assert.deepEqual(m.callSites[0]!.inputKeys, ['a', 'b']);
    assert.deepEqual(m.envVarNames, ['SWFTE_A', 'SWFTE_B']);
    assert.deepEqual(Object.keys(m.notAnalysed), ['go', 'ruby']);
    const wire = serializeManifest(m);
    for (const scannerOnly of ['detector', 'category', 'relPath', 'py.managed']) assert.ok(!wire.includes(scannerOnly), scannerOnly);
    assert.equal(serializeManifest(buildManifest({ ...input, sites: [...input.sites].reverse() })), wire);
  });

  test('buildManifest refuses a site the allowlist would refuse (the manifest never exists unchecked)', () => {
    assert.throws(
      () =>
        buildManifest({
          repo: { id: REPO, provider: 'github', defaultBranch: 'main' },
          commitSha: SHA,
          scanner: 'cli',
          pathHashing: false,
          truncated: false,
          notAnalysed: {},
          envVarNames: [],
          sites: [assigned(detected('a.py', 1, { symbol: 'print("hello")' }), 1)],
        }),
      (err: unknown) => err instanceof ManifestViolationError && err.pointer === '/callSites/0/symbol'
    );
  });

  test('a manifest typed as Manifest round-trips unchanged', () => {
    const m = valid() as unknown as Manifest;
    assert.deepEqual(JSON.parse(serializeManifest(checkManifest(m))), valid());
  });
});
