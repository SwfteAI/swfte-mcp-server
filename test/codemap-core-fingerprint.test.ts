/**
 * Keyed call-site fingerprints and path hashes (docs/codemap/CONTRACT.md §2, §2.1, §2.2).
 *
 * The properties that matter: the id is the contract's HMAC and nothing else (never the line), it is
 * stable under edits that do not move the call and changes under edits that do, it is keyed per
 * workspace, and a renamed file carries its previous id as movedFrom.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import {
  artifactKey,
  assignIds,
  callSiteId,
  FingerprintError,
  normaliseRemote,
  pathHash,
  providerOf,
  repoIdFromRemote,
  repoIdLocal,
} from '../src/codemap/fingerprint.js';
import type { DetectedSite } from '../src/codemap/types.js';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const REPO = 'r_0123456789abcdef0123456789abcdef';

function site(relPath: string, line: number, symbol: string, id: string | null = 'wf_1', extra: Partial<DetectedSite> = {}): DetectedSite {
  return {
    relPath,
    line,
    symbol,
    language: 'typescript',
    category: 'managed',
    sdk: 'node',
    op: 'run',
    managed: 'typed-client',
    artifact: { kind: 'workflow', id, unresolved: id === null, pinnedVersion: null, alias: null },
    contractHash: null,
    inputKeys: [],
    outputKeys: [],
    detector: 'fake.ts',
    ...extra,
  };
}

const places = (...paths: string[]) => new Map(paths.map((p) => [p, { pkgId: '@acme/web', pkgRelPath: p.replace(/^apps\/web\//, '') }]));

describe('callSiteId and pathHash follow the contract formula exactly', () => {
  test('id = cs_ + first 24 hex of HMAC-SHA256(key, "cs1\\n" + fields joined by newlines)', () => {
    const parts = { repoId: REPO, pkgId: '@acme/web', pkgRelPath: 'src/a.ts', symbol: 'Checkout.submit', artifactKey: 'workflow:wf_1', ordinal: 2 };
    const expected = `cs_${createHmac('sha256', KEY_A).update(`cs1\n${REPO}\n@acme/web\nsrc/a.ts\nCheckout.submit\nworkflow:wf_1\n2`).digest('hex').slice(0, 24)}`;
    assert.equal(callSiteId(KEY_A, parts), expected);
    assert.match(expected, /^cs_[0-9a-f]{24}$/);
  });

  test('pathHash = ph_ + first 32 hex of HMAC-SHA256(key, "path1\\n" + repoId + "\\n" + path)', () => {
    const expected = `ph_${createHmac('sha256', KEY_A).update(`path1\n${REPO}\napps/web/src/a.ts`).digest('hex').slice(0, 32)}`;
    assert.equal(pathHash(KEY_A, REPO, 'apps/web/src/a.ts'), expected);
    assert.match(expected, /^ph_[0-9a-f]{32}$/);
  });

  test('ids and path hashes are keyed per workspace: another key gives other values', () => {
    const parts = { repoId: REPO, pkgId: '.', pkgRelPath: 'a.ts', symbol: 'f', artifactKey: 'agent:ag_1', ordinal: 0 };
    assert.notEqual(callSiteId(KEY_A, parts), callSiteId(KEY_B, parts));
    assert.notEqual(pathHash(KEY_A, REPO, 'a.ts'), pathHash(KEY_B, REPO, 'a.ts'));
    const [a] = assignIds([site('a.ts', 3, 'f')], places('a.ts'), KEY_A, REPO);
    const [b] = assignIds([site('a.ts', 3, 'f')], places('a.ts'), KEY_B, REPO);
    assert.notEqual(a!.id, b!.id);
  });

  test('the key must be 32 raw bytes; a string or short key is refused', () => {
    const parts = { repoId: REPO, pkgId: '.', pkgRelPath: 'a.ts', symbol: 'f', artifactKey: 'agent:ag_1', ordinal: 0 };
    assert.throws(() => callSiteId(Buffer.alloc(16) as Uint8Array, parts), FingerprintError);
    assert.throws(() => callSiteId('a'.repeat(32) as unknown as Uint8Array, parts), FingerprintError);
    assert.throws(() => pathHash(Buffer.alloc(31), REPO, 'a.ts'), FingerprintError);
  });

  test('a component carrying a newline is refused (it could make two tuples hash alike)', () => {
    assert.throws(
      () => callSiteId(KEY_A, { repoId: REPO, pkgId: '.', pkgRelPath: 'a.ts', symbol: 'f\nworkflow:x', artifactKey: 'w:1', ordinal: 0 }),
      FingerprintError
    );
    assert.throws(() => pathHash(KEY_A, REPO, 'a.ts\nb.ts'), FingerprintError);
  });

  test('artifactKey is kind:id, or kind:? + env var name when unresolved', () => {
    assert.equal(artifactKey({ kind: 'workflow', id: 'wf_1', unresolved: false }), 'workflow:wf_1');
    assert.equal(artifactKey({ kind: 'workflow', id: null, unresolved: true, envVarName: 'SWFTE_WF' }), 'workflow:?SWFTE_WF');
    assert.equal(artifactKey({ kind: 'agent', id: null, unresolved: true }), 'agent:?');
  });
});

describe('stability: the line number is never an input', () => {
  test('inserted lines, comments and edits in other symbols leave every id unchanged', () => {
    const before = [site('apps/web/src/a.ts', 10, 'submit'), site('apps/web/src/a.ts', 14, 'submit'), site('apps/web/src/a.ts', 30, 'other', 'ag_2')];
    // 7 lines inserted at the top, one more in `other` above its call, a new call in a third symbol.
    const after = [
      site('apps/web/src/a.ts', 17, 'submit'),
      site('apps/web/src/a.ts', 21, 'submit'),
      site('apps/web/src/a.ts', 38, 'other', 'ag_2'),
      site('apps/web/src/a.ts', 50, 'third'),
    ];
    const p = places('apps/web/src/a.ts');
    const idsBefore = assignIds(before, p, KEY_A, REPO).map((s) => s.id);
    const idsAfter = assignIds(after, p, KEY_A, REPO).map((s) => s.id);
    assert.deepEqual(idsAfter.slice(0, 3), idsBefore);
    assert.equal(new Set(idsAfter).size, 4);
  });

  test('a rename of the enclosing symbol, a move to another file, or a new call before it changes the id', () => {
    const p = places('apps/web/src/a.ts', 'apps/web/src/b.ts');
    const [base] = assignIds([site('apps/web/src/a.ts', 10, 'submit')], p, KEY_A, REPO);
    const [renamed] = assignIds([site('apps/web/src/a.ts', 10, 'submitOrder')], p, KEY_A, REPO);
    const [moved] = assignIds([site('apps/web/src/b.ts', 10, 'submit')], p, KEY_A, REPO);
    const shifted = assignIds([site('apps/web/src/a.ts', 8, 'submit'), site('apps/web/src/a.ts', 10, 'submit')], p, KEY_A, REPO);
    assert.notEqual(renamed!.id, base!.id);
    assert.notEqual(moved!.id, base!.id);
    assert.notEqual(shifted[1]!.id, base!.id, 'the old call is now ordinal 1');
    assert.equal(shifted[0]!.id, base!.id, 'the new first call takes ordinal 0');
  });

  test('ordinals count per (file, symbol, artifactKey) in source order; same-line ties keep report order', () => {
    const p = places('a.ts');
    const sites = [
      site('a.ts', 20, 'f', 'wf_1'),
      site('a.ts', 5, 'f', 'wf_1'),
      site('a.ts', 5, 'f', 'wf_2'),
      site('a.ts', 5, 'f', null, { artifact: { kind: 'workflow', id: null, unresolved: true, envVarName: 'SWFTE_WF', pinnedVersion: null, alias: null } }),
    ];
    const out = assignIds(sites, p, KEY_A, REPO);
    assert.deepEqual(out.map((s) => s.site.line), [5, 5, 5, 20], 'source order');
    const id = (key: string, ordinal: number) => callSiteId(KEY_A, { repoId: REPO, pkgId: '@acme/web', pkgRelPath: 'a.ts', symbol: 'f', artifactKey: key, ordinal });
    assert.equal(out[0]!.id, id('workflow:wf_1', 0));
    assert.equal(out[1]!.id, id('workflow:wf_2', 0), 'another artifact starts its own count');
    assert.equal(out[2]!.id, id('workflow:?SWFTE_WF', 0));
    assert.equal(out[3]!.id, id('workflow:wf_1', 1));
  });

  test('a site in a file with no package place is a caller bug, not a silent fallback', () => {
    assert.throws(() => assignIds([site('x.ts', 1, 'f')], new Map(), KEY_A, REPO), FingerprintError);
  });
});

describe('movedFrom from a git rename map', () => {
  test('a site in a renamed file carries the id it had under the old path', () => {
    const oldLayout = new Map([
      ['apps/web/src/old.ts', { pkgId: '@acme/web', pkgRelPath: 'src/old.ts' }],
      ['apps/web/src/stay.ts', { pkgId: '@acme/web', pkgRelPath: 'src/stay.ts' }],
    ]);
    const newLayout = new Map([
      ['apps/web/src/new/name.ts', { pkgId: '@acme/web', pkgRelPath: 'src/new/name.ts' }],
      ['apps/web/src/stay.ts', { pkgId: '@acme/web', pkgRelPath: 'src/stay.ts' }],
    ]);
    const before = assignIds([site('apps/web/src/old.ts', 4, 'go'), site('apps/web/src/old.ts', 9, 'go'), site('apps/web/src/stay.ts', 2, 'h')], oldLayout, KEY_A, REPO);
    const after = assignIds(
      [site('apps/web/src/new/name.ts', 4, 'go'), site('apps/web/src/new/name.ts', 9, 'go'), site('apps/web/src/stay.ts', 2, 'h')],
      newLayout,
      KEY_A,
      REPO,
      { 'apps/web/src/old.ts': 'apps/web/src/new/name.ts' }
    );
    const moved = after.filter((s) => s.site.relPath.endsWith('name.ts'));
    assert.deepEqual(moved.map((s) => s.movedFrom), before.slice(0, 2).map((s) => s.id));
    assert.notEqual(moved[0]!.id, moved[0]!.movedFrom);
    const stay = after.find((s) => s.site.relPath.endsWith('stay.ts'))!;
    assert.equal(stay.movedFrom, undefined);
    assert.equal(stay.id, before[2]!.id);
  });

  test('a move across package roots resolves the old path against the old root (Map form accepted)', () => {
    const layout = new Map([
      ['packages/a/src/x.ts', { pkgId: 'pkg-a', pkgRelPath: 'src/x.ts' }],
      ['packages/b/src/y.ts', { pkgId: 'pkg-b', pkgRelPath: 'src/y.ts' }],
    ]);
    const old = callSiteId(KEY_A, { repoId: REPO, pkgId: 'pkg-a', pkgRelPath: 'src/gone.ts', symbol: 'f', artifactKey: 'workflow:wf_1', ordinal: 0 });
    const [s] = assignIds([site('packages/b/src/y.ts', 1, 'f')], layout, KEY_A, REPO, new Map([['packages/a/src/gone.ts', 'packages/b/src/y.ts']]));
    assert.equal(s!.movedFrom, old);
  });
});

describe('repo ids (unkeyed on purpose)', () => {
  test('every spelling of one remote normalises to host/path and one r_ id', () => {
    const spellings = [
      'https://github.com/Acme/Web.git',
      'git@github.com:Acme/Web.git',
      'ssh://git@github.com:22/Acme/Web',
      'https://user:token@GitHub.com/Acme/Web/',
      'git://GITHUB.COM/Acme/Web.git',
    ];
    for (const s of spellings) assert.equal(normaliseRemote(s), 'github.com/Acme/Web', s);
    const ids = new Set(spellings.map(repoIdFromRemote));
    assert.equal(ids.size, 1);
    const [id] = [...ids];
    assert.equal(id, `r_${createHash('sha256').update('github.com/Acme/Web').digest('hex').slice(0, 32)}`);
    assert.notEqual(repoIdFromRemote('https://github.com/Acme/Api'), id);
  });

  test('no remote: r_ + SHA-256 of "local:" + root basename + first commit', () => {
    const first = 'a'.repeat(40);
    assert.equal(repoIdLocal('/home/dev/projects/shop/', first), `r_${createHash('sha256').update(`local:shop${first}`).digest('hex').slice(0, 32)}`);
  });

  test('provider comes from the remote host; none without a remote', () => {
    assert.equal(providerOf('git@github.com:a/b.git'), 'github');
    assert.equal(providerOf('https://gitlab.com/a/b'), 'gitlab');
    assert.equal(providerOf('https://bitbucket.org/a/b'), 'bitbucket');
    assert.equal(providerOf('https://dev.azure.com/org/p/_git/r'), 'azure');
    assert.equal(providerOf('https://git.example.com/a/b'), 'other');
    assert.equal(providerOf(null), 'none');
  });
});
