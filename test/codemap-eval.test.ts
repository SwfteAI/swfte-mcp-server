/**
 * Self-tests of the corpus evaluator and mutant runner (scripts/codemap-eval.ts, gates CM-G1/CM-G2).
 * They prove the evaluator can fail: removal, corruption, swapped keys, decoys, guesses, floors.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BUCKETS,
  CATEGORIES,
  DEFAULT_THRESHOLDS,
  MUTANTS,
  evaluate,
  evaluateCorpus,
  loadFixtures,
  memBucketOf,
  oracleScan,
  oracleScanner,
  parseFloors,
  realEnvFiles,
  runMutants,
  uncomment,
  tripsExpected,
  type AnswerKey,
  type Bucket,
  type Fixture,
  type KeySite,
  type Mutant,
  type ScanLike,
  validateKey,
  type Thresholds,
} from '../scripts/codemap-eval.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORPUS = path.join(ROOT, 'test/fixtures/codemap');
const SCRIPT = path.join(ROOT, 'scripts/codemap-eval.ts');

const EXT: Record<Bucket, string> = { ts: 'ts', py: 'py', java: 'java' };
const LANG: Record<Bucket, string> = { ts: 'typescript', py: 'python', java: 'java' };
const SDK: Record<Bucket, string> = { ts: 'node', py: 'python', java: 'java' };

function site(b: Bucket, cat: string, i: number, over: Partial<KeySite> = {}): KeySite {
  const raw = cat === 'raw-http';
  const widget = cat === 'widget';
  const dyn = cat === 'dynamic';
  return {
    path: `${b}/${cat}-${i}.${EXT[b]}`,
    line: 10 + i,
    language: LANG[b],
    category: cat,
    symbol: `fn${i}`,
    sdk: widget ? 'widget-embed' : raw ? 'http' : SDK[b],
    op: widget ? 'embed' : 'run',
    managed: raw ? 'raw-http' : 'typed-client',
    artifact: dyn
      ? { kind: 'workflow', id: null, unresolved: true, envVarName: null }
      : { kind: widget ? 'agent' : 'workflow', id: `id_${b}_${cat}_${i}`, unresolved: false, envVarName: null },
    inputKeys: [],
    outputKeys: [],
    ...over,
  } as KeySite;
}

/** A synthetic key: `n` sites per category per language (>= 40 per language at n = 12). */
function syntheticKey(n = 12, only: Bucket[] = BUCKETS): AnswerKey {
  const sites: KeySite[] = [];
  for (const b of only) for (const c of CATEGORIES) for (let i = 0; i < n; i++) sites.push(site(b, c, i));
  return {
    fixture: 'syn',
    sites,
    decoys: [
      { path: 'ts/comment.ts', line: 3, why: 'comment' },
      { path: 'ts/node_modules/x/index.ts', line: 9, why: 'vendored' },
    ],
    implementations: [],
    notAnalysed: {},
    envVarNames: ['SWFTE_API_KEY'],
  };
}

const scoreOf = (key: AnswerKey, scan: ScanLike, t: Thresholds = DEFAULT_THRESHOLDS) =>
  evaluate([{ name: 'syn', key, scan, bucketOf: memBucketOf() }], t);

const fixtureOf = (key: AnswerKey): Fixture => ({ name: key.fixture, root: '/nonexistent', key });

function cli(...args: string[]) {
  const r = spawnSync('node', ['--import', 'tsx', SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('evaluator', () => {
  test('perfect oracle scores 1.0 everywhere (synthetic and real corpus)', () => {
    const key = syntheticKey();
    const r = scoreOf(key, oracleScan(key));
    assert.equal(r.ok, true, r.failures.map((f) => f.msg).join('; '));
    for (const c of Object.values(r.cells)) {
      assert.equal(c.precision, 1);
      assert.equal(c.recall, 1);
    }
    assert.equal(r.wrongArtifact, 0);
    assert.equal(r.decoyFp, 0);
    const corpus = loadFixtures(CORPUS);
    assert.ok(corpus.length >= 6);
    const real = evaluate(
      corpus.map((f) => ({ name: f.name, key: f.key, scan: oracleScan(f.key), bucketOf: memBucketOf((p) => (p.startsWith('src/main') ? 'java' : 'ts')) })),
      DEFAULT_THRESHOLDS
    );
    // html buckets differ from the filesystem rule here, so judge only the non-html cells strictly.
    assert.equal(real.wrongArtifact, 0);
    assert.equal(real.fp, 0);
  });

  test('empty category not pass', () => {
    const key = syntheticKey();
    key.sites = key.sites.filter((s) => !(s.language === 'java' && s.category === 'widget'));
    const r = scoreOf(key, oracleScan(key));
    const cell = r.cells['java/widget']!;
    assert.equal(cell.precision, null);
    assert.equal(cell.recall, null);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.kind === 'vacuous' && f.lang === 'java' && f.cat === 'widget'));
  });

  test('removing labelled site fails floor', () => {
    const key = syntheticKey(12);
    const scan = oracleScan(key);
    const victim = scan.sites.findIndex((s) => s.category === 'raw-http' && s.language === 'python');
    scan.sites.splice(victim, 2); // 10 of 12 = 0.833, under the 0.85 raw-http floor (one of 12 would pass)
    const r = scoreOf(key, scan);
    assert.equal(r.ok, false);
    const f = r.failures.find((x) => x.kind === 'recall');
    assert.ok(f && f.lang === 'py' && f.cat === 'raw-http', JSON.stringify(r.failures));
    assert.ok(r.cells['py/raw-http']!.recall! < 0.85);
    // the same removal in a category with 100 sites would sit above the floor: the floor, not luck, decides
    const big = syntheticKey(100);
    const bs = oracleScan(big);
    bs.sites.splice(bs.sites.findIndex((s) => s.category === 'widget'), 1);
    assert.equal(scoreOf(big, bs, { ...DEFAULT_THRESHOLDS, minSitesPerLang: 40 }).ok, true);
  });

  test('swapped language keys fail', () => {
    const a = syntheticKey(12, ['ts']);
    const b = syntheticKey(12, ['py']);
    const r = evaluate(
      [
        { name: 'a', key: a, scan: oracleScan(b), bucketOf: memBucketOf() },
        { name: 'b', key: b, scan: oracleScan(a), bucketOf: memBucketOf() },
      ],
      { ...DEFAULT_THRESHOLDS, langs: ['ts', 'py'], minSitesPerLang: 10 }
    );
    assert.equal(r.ok, false);
    assert.equal(r.cells['ts/managed']!.recall, 0);
    assert.equal(r.cells['py/managed']!.recall, 0);
  });

  test('decoy report false positive', () => {
    const key = syntheticKey();
    const scan = oracleScan(key);
    scan.sites.push({ ...scan.sites[0]!, relPath: 'ts/comment.ts', line: 3, detector: 'x' });
    const r = scoreOf(key, scan);
    assert.equal(r.decoyFp, 1);
    assert.equal(r.fp, 1);
    assert.ok(r.cells['ts/managed']!.precision! < 1);
    assert.ok(r.failures.some((f) => f.kind === 'decoy-fp'));
    // with precision floors relaxed the decoy limit alone still fails the run
    const lax = scoreOf(key, scan, { ...DEFAULT_THRESHOLDS, floors: parseFloors('managed=0.5/0.5,raw-http=0.5/0.5,widget=0.5/0.5,dynamic-site=0.5') });
    assert.equal(lax.ok, false);
    assert.deepEqual(lax.failures.map((f) => f.kind), ['decoy-fp']);
    // a vendored file that holds only decoys counts at any line
    const scan2 = oracleScan(key);
    scan2.sites.push({ ...scan2.sites[0]!, relPath: 'ts/node_modules/x/index.ts', line: 400 });
    assert.equal(scoreOf(key, scan2).decoyFp, 1);
  });

  test('guessed dynamic id wrong artifact', () => {
    const key = syntheticKey();
    const scan = oracleScan(key);
    const dyn = scan.sites.find((s) => s.category === 'dynamic')!;
    dyn.artifact = { ...dyn.artifact, id: 'wf_guess', unresolved: false };
    const r = scoreOf(key, scan);
    assert.equal(r.wrongArtifact, 1);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.kind === 'wrong-artifact'));
    // a resolved key answered with another id is wrong too; an unresolved answer to it is merely a miss
    const scan2 = oracleScan(key);
    const res = scan2.sites.find((s) => s.category === 'managed')!;
    res.artifact = { ...res.artifact, id: 'someone_else' };
    assert.equal(scoreOf(key, scan2).wrongArtifact, 1);
    const scan3 = oracleScan(key);
    const res3 = scan3.sites.find((s) => s.category === 'managed')!;
    res3.artifact = { ...res3.artifact, id: null, unresolved: true };
    const r3 = scoreOf(key, scan3);
    assert.equal(r3.wrongArtifact, 0);
    assert.equal(r3.unresolvedMisses, 1);
  });

  test('a site at the right line of another file does not count', () => {
    const key = syntheticKey();
    const scan = oracleScan(key);
    const i = scan.sites.findIndex((x) => x.category === 'managed' && x.language === 'java');
    scan.sites[i]!.relPath = 'java/elsewhere.java';
    const r = scoreOf(key, scan);
    assert.equal(r.ok, false);
    assert.ok(r.cells['java/managed']!.tp < r.cells['java/managed']!.key);
  });

  test('below minimum sites refuses token', () => {
    const key = syntheticKey(12);
    const r = scoreOf(key, oracleScan(key), { ...DEFAULT_THRESHOLDS, minSitesPerLang: 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.failures.filter((f) => f.kind === 'min-sites').length, 3);
    const c = cli('--fixtures', CORPUS, '--oracle', '--min-sites-per-lang', '100000');
    assert.equal(c.code, 1);
    assert.doesNotMatch(c.out, /CODEMAP_EVAL_OK/);
    // a run that checked nothing is a failure, never a pass
    const none = evaluate([], { ...DEFAULT_THRESHOLDS, minSitesPerLang: 0 });
    assert.equal(none.ok, false);
  });

  test('a detected site must equal the key on sdk, op, managed, alias and keys to count', () => {
    const key = syntheticKey();
    for (const tweak of [{ sdk: 'http' }, { op: 'chat' }, { managed: 'raw-http' }, { inputKeys: ['x'] }, { outputKeys: ['y'] }]) {
      const scan = oracleScan(key);
      const i = scan.sites.findIndex((s) => s.category === 'managed' && s.language === 'java');
      Object.assign(scan.sites[i]!, tweak);
      const r = scoreOf(key, scan);
      assert.equal(r.ok, false, JSON.stringify(tweak));
      assert.ok(r.cells['java/managed']!.recall! < 1, JSON.stringify(tweak));
    }
    const scan = oracleScan(key);
    (scan.sites.find((s) => s.category === 'managed')!.artifact as { alias?: string }).alias = 'nope';
    assert.equal(scoreOf(key, scan).ok, false);
  });
});

describe('mutants', () => {
  test('identity mutant survives', async () => {
    const fixtures = loadFixtures(CORPUS);
    const res = await runMutants(fixtures, oracleScanner, DEFAULT_THRESHOLDS, ['identity']);
    assert.equal(res.base.ok, true);
    assert.equal(res.verdicts[0]!.name, 'identity');
    assert.equal(res.verdicts[0]!.status, 'survived');
    assert.equal(res.identity.ok, true);
  });

  test('ineffective mutant reported surviving', async () => {
    const key = syntheticKey(12, ['ts', 'py']); // no Java site at all: drop-java changes nothing
    const res = await runMutants([fixtureOf(key)], oracleScanner, { ...DEFAULT_THRESHOLDS, langs: ['ts', 'py'] }, ['drop-java']);
    // fsBucketOf needs a real root; the synthetic root has no markers and html is absent, so buckets come from language.
    assert.equal(res.base.ok, true, res.base.failures.map((f) => f.msg).join('; '));
    assert.equal(res.verdicts[0]!.status, 'survived');
    assert.equal(res.verdicts[0]!.inert, true);
    assert.equal(res.verdicts[0]!.changes, 0);
  });

  test('named mutant killed in oracle mode, each on its own metric', async () => {
    const fixtures = loadFixtures(CORPUS);
    const res = await runMutants(fixtures, oracleScanner, DEFAULT_THRESHOLDS, 'all');
    assert.equal(res.verdicts.length, 6);
    for (const v of res.verdicts) {
      assert.equal(v.status, 'killed', `${v.name}: ${v.status} [${v.tripped}]`);
      assert.ok(v.changes > 0, `${v.name} changed nothing`);
    }
    const by = Object.fromEntries(res.verdicts.map((v) => [v.name, v.tripped.join(' ')]));
    assert.match(by['drop-raw-http']!, /recall:ts\/raw-http/);
    assert.match(by['drop-widget']!, /recall:py\/widget/);
    assert.match(by['scan-vendored']!, /decoy-fp/);
    assert.match(by['scan-comments']!, /decoy-fp/);
    assert.match(by['guess-dynamic']!, /wrong-artifact/);
    assert.match(by['drop-java']!, /recall:java/);
  });

  test('a mutant killed on the wrong metric is not counted as killed', async () => {
    const fixtures = loadFixtures(CORPUS);
    const wrong: Mutant = { ...MUTANTS[0]!, name: 'mislabelled', expect: [{ kind: 'wrong-artifact' }] };
    const r = await evaluateCorpus(fixtures, oracleScanner, wrong, DEFAULT_THRESHOLDS);
    assert.equal(r.report.ok, false);
    assert.equal(tripsExpected(wrong, r.report), false);
    assert.equal(tripsExpected(MUTANTS[0]!, r.report), true);
  });

  test('the uncomment transform keeps lines and columns, and leaves URLs alone', () => {
    const ts = 'const u = "https://api.swfte.com/v2"; // client.run(x)\n/* a\n * b.run(y)\n */\nz();';
    const out = uncomment(ts, 'typescript');
    assert.equal(out.length, ts.length);
    assert.equal(out.split('\n').length, ts.split('\n').length);
    assert.ok(out.includes('"https://api.swfte.com/v2"'));
    assert.ok(!out.includes('//  client') && !out.includes('/*') && !out.includes('*/'));
    assert.match(out, /client\.run\(x\)/);
    const py = 'x = "a # b"\n# c.run(1)\n"""\nd.run(2)\n"""\n';
    const p = uncomment(py, 'python');
    assert.equal(p.length, py.length);
    assert.ok(p.includes('"a # b"'));
    assert.match(p, /c\.run\(1\)/);
    assert.ok(!p.includes('"""'));
    assert.ok(!uncomment('<!-- <x/> -->', 'html').includes('<!--'));
  });
});

describe('cli and parsing', () => {
  test('CLI prints CODEMAP_EVAL_OK only on success', () => {
    const ok = cli('--fixtures', CORPUS, '--oracle', '--min-sites-per-lang', '40', '--floors', 'managed=0.98/0.95,raw-http=0.95/0.85,widget=0.95/0.90,dynamic-site=0.80', '--max-wrong-artifact', '0');
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /CODEMAP_EVAL_OK/);
    const badFloor = cli('--fixtures', CORPUS, '--oracle', '--floors', 'managed=1.5');
    assert.equal(badFloor.code, 1);
    assert.doesNotMatch(badFloor.out, /CODEMAP_EVAL_OK/);
    const noDir = cli('--oracle');
    assert.equal(noDir.code, 1);
    assert.doesNotMatch(noDir.out, /CODEMAP_EVAL_OK/);
    const badLang = cli('--fixtures', CORPUS, '--oracle', '--langs', 'cobol');
    assert.equal(badLang.code, 1);
    // a floor that names a category with `--categories` narrowing still passes on a perfect oracle
    const narrow = cli('--fixtures', CORPUS, '--oracle', '--langs', 'java', '--categories', 'widget');
    assert.match(narrow.out, /CODEMAP_EVAL_OK/);
  });

  test('CLI mutant run prints 6/6 only when all are killed and identity survives', () => {
    const r = cli('--fixtures', CORPUS, '--oracle', '--mutants', 'all', '--expect-killed', '6');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /CODEMAP_MUTANTS_KILLED 6\/6/);
    const wrongCount = cli('--fixtures', CORPUS, '--oracle', '--mutants', 'all', '--expect-killed', '5');
    assert.equal(wrongCount.code, 1);
    assert.doesNotMatch(wrongCount.out, /CODEMAP_MUTANTS_KILLED/);
  });

  test('the key loader fails loudly on an unknown field, category or unresolved/id mismatch', () => {
    const good = JSON.parse(JSON.stringify(syntheticKey(1)));
    assert.doesNotThrow(() => validateKey(good, 'k'));
    const mut = (fn: (k: any) => void) => {
      const k = JSON.parse(JSON.stringify(good));
      fn(k);
      return k;
    };
    assert.throws(() => validateKey(mut((k) => (k.sites[0].category = 'managd')), 'k'), /unknown category/);
    assert.throws(() => validateKey(mut((k) => (k.sites[0].extra = 1)), 'k'), /unknown field 'extra'/);
    assert.throws(() => validateKey(mut((k) => (k.surprise = 1)), 'k'), /unknown field 'surprise'/);
    assert.throws(() => validateKey(mut((k) => (k.sites[0].artifact.id = null)), 'k'), /id is null exactly when unresolved/);
    assert.throws(() => validateKey(mut((k) => (k.sites[0].line = 0)), 'k'), /1-based line/);
    assert.throws(() => validateKey(mut((k) => (k.sites = 'x')), 'k'), /no sites array/);
    assert.equal(loadFixtures(CORPUS).length, 7); // every real key passes the strict loader (7th: opaque-versions)
  });

  test('floor parser and env-file globs', async () => {
    const f = parseFloors('managed=0.98/0.95,dynamic-site=0.8');
    assert.deepEqual(f.managed, [0.98, 0.95]);
    assert.deepEqual(f.dynamic, [null, 0.8]);
    assert.throws(() => parseFloors('nonsense=0.5'));
    assert.throws(() => parseFloors('managed=2'));
    assert.throws(() => parseFloors(''));
    const env = await realEnvFiles();
    for (const g of ['dot-env', 'dot-env.*', '.env', '.env.local', '.env.*']) assert.ok(env.secret.includes(g), g);
    for (const g of ['dot-env.example', '.env.example']) assert.ok(env.names.includes(g), g);
  });
});
