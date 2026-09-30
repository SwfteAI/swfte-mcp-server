/**
 * Release pipeline (review r-mcp R9, the in-repo part): actions pinned to full SHAs,
 * id-token/packages scoped to the job that needs them, publish only from master, audit in CI.
 * Named `G12:`. The judge functions are also run on known-bad text so they are shown to be able to fail.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const wf = (n: string) => readFileSync(join(process.cwd(), '.github/workflows', n), 'utf8');

export function unpinned(yml: string): string[] {
  return [...yml.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)]
    .map((m) => m[1]!)
    .filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}$/.test(u));
}
export function topLevelPermissions(yml: string): string {
  const m = /^permissions:\n((?:[ \t]+.*\n|[ \t]*#.*\n)+)/m.exec(yml);
  return m ? m[1]! : '';
}
export function jobBlock(yml: string, job: string): string {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('release pipeline hardening (R9)', () => {
  test('G12: the judges can fail (negative control)', () => {
    assert.deepEqual(unpinned('      - uses: actions/checkout@v4\n'), ['actions/checkout@v4']);
    assert.match(topLevelPermissions('permissions:\n  id-token: write\n\njobs:\n'), /id-token/);
    assert.equal(jobBlock('jobs:\n  a:\n    steps: x\n', 'nope'), '');
  });

  test('G12: every external action in every workflow is pinned to a full commit SHA', () => {
    for (const f of ['release.yml', 'ci.yml', 'release-on-merge.yml']) assert.deepEqual(unpinned(wf(f)), [], f);
  });

  test('G12: id-token and packages are not workflow-wide; id-token only on npm-publish, packages only on docker-publish', () => {
    const r = wf('release.yml');
    const top = topLevelPermissions(r);
    assert.doesNotMatch(top, /id-token|packages/);
    assert.match(jobBlock(r, 'npm-publish'), /id-token: write/);
    assert.doesNotMatch(jobBlock(r, 'docker-publish'), /id-token/);
    assert.match(jobBlock(r, 'docker-publish'), /packages: write/);
    assert.doesNotMatch(jobBlock(r, 'npm-publish'), /packages: write/);
    assert.doesNotMatch(jobBlock(r, 'guard'), /id-token|packages/);
  });

  test('G12: the guard refuses anything that is not on master', () => {
    const g = jobBlock(wf('release.yml'), 'guard');
    assert.match(g, /refs\/heads\/master/);
    assert.match(g, /merge-base --is-ancestor/);
  });

  test('G12: the npm token is read only in the environment-gated publish job, with provenance', () => {
    const r = wf('release.yml');
    const np = jobBlock(r, 'npm-publish');
    assert.match(np, /environment:\s*\n\s+name: npm-publish-prod/);
    assert.match(np, /secrets\.NPM_TOKEN/);
    assert.match(np, /--provenance/);
    assert.equal((r.match(/secrets\.NPM_TOKEN/g) ?? []).length, 1);
  });

  test('G12: CI fails on a high or critical production advisory', () => {
    assert.match(wf('ci.yml'), /npm audit --omit=dev --audit-level=high/);
  });
});
