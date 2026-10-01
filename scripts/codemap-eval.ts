/**
 * Code map corpus evaluator and scanner-mutant runner (CM-G1 / CM-G2, docs/codemap/CONTRACT.md §7,
 * FIXTURES.md §4).
 *
 *   tsx scripts/codemap-eval.ts --fixtures test/fixtures/codemap [--oracle]
 *        [--min-sites-per-lang 40] [--floors managed=0.98/0.95,raw-http=0.95/0.85,widget=0.95/0.90,dynamic-site=0.80]
 *        [--max-wrong-artifact 0] [--max-decoy-fp 0] [--json]
 *        [--mutants all|name,name --expect-killed 6]
 *
 * It measures `detectProject` (or, with --oracle, the answer keys themselves standing in for the
 * detectors) against the hand-written answer keys, which it only ever reads. Metrics: per language
 * bucket (ts, python, java; html sites take the bucket of their nearest package root) and per
 * category (managed, raw-http, widget, dynamic): precision and recall on (path, line, category);
 * wrong-artifact attributions among matched sites (a guessed or different id); decoys reported as
 * sites; a minimum number of labelled sites per language. A floor written `p/r` bounds precision and
 * recall, a single number bounds recall (`dynamic-site` is the recall of unresolved sites).
 *
 * Tokens: CODEMAP_EVAL_OK only when every bound holds and no bound was vacuous; otherwise
 * CODEMAP_EVAL_FAIL and exit 1. With --mutants: CODEMAP_MUTANTS_KILLED k/n only when the unmutated
 * run passes, the identity mutant survives, at least --expect-killed mutants are killed on the metric
 * they should trip. Output carries paths, lines and counts only, never file contents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DetectOutcome } from '../src/codemap/detect.js';
import type { SourceFile } from '../src/codemap/types.js';

export type Bucket = 'ts' | 'py' | 'java';
export const BUCKETS: Bucket[] = ['ts', 'py', 'java'];
export const CATEGORIES = ['managed', 'raw-http', 'widget', 'dynamic'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ArtifactLike {
  kind: string;
  id: string | null;
  unresolved: boolean;
  envVarName?: string | null;
}
export interface SiteLike {
  relPath: string;
  line: number;
  language: string;
  category: string;
  artifact: ArtifactLike;
  symbol?: string;
  sdk?: string;
  op?: string;
  managed?: string;
  inputKeys?: string[];
  outputKeys?: string[];
  detector?: string;
  [k: string]: unknown;
}
export interface KeySite {
  path: string;
  line: number;
  language: string;
  category: string;
  symbol?: string;
  sdk?: string;
  op?: string;
  managed?: string;
  artifact: ArtifactLike;
  inputKeys?: string[];
  outputKeys?: string[];
  [k: string]: unknown;
}
export interface AnswerKey {
  fixture: string;
  sites: KeySite[];
  implementations?: { path: string; line: number }[];
  decoys?: { path: string; line: number; why?: string }[];
  notAnalysed?: Record<string, number>;
  envVarNames?: string[];
}
export interface ScanLike {
  sites: SiteLike[];
  envVarNames?: string[];
  notAnalysed?: Record<string, number>;
}
export type BucketOf = (relPath: string, language: string) => Bucket;

export interface Thresholds {
  minSitesPerLang: number;
  /** category -> [precision floor | null, recall floor]. */
  floors: Record<Category, [number | null, number]>;
  maxWrongArtifact: number;
  maxDecoyFp: number;
  /** Buckets and categories that must be judged (default: all). */
  langs?: Bucket[];
  categories?: Category[];
}

export const DEFAULT_FLOORS_SPEC = 'managed=0.98/0.95,raw-http=0.95/0.85,widget=0.95/0.90,dynamic-site=0.80';

export function parseFloors(spec: string): Thresholds['floors'] {
  const out = {} as Thresholds['floors'];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z-]+)=([0-9.]+)(?:\/([0-9.]+))?$/.exec(part);
    if (!m) throw new Error(`bad floor '${part}'`);
    const name = m[1] === 'dynamic-site' ? 'dynamic' : m[1]!;
    if (!(CATEGORIES as readonly string[]).includes(name)) throw new Error(`unknown floor category '${m[1]}'`);
    const a = Number(m[2]);
    const b = m[3] === undefined ? null : Number(m[3]);
    if (!(a >= 0 && a <= 1) || (b !== null && !(b >= 0 && b <= 1))) throw new Error(`floor out of [0,1]: '${part}'`);
    out[name as Category] = b === null ? [null, a] : [a, b];
  }
  if (!Object.keys(out).length) throw new Error('no floors given');
  return out;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minSitesPerLang: 40,
  floors: parseFloors(DEFAULT_FLOORS_SPEC),
  maxWrongArtifact: 0,
  maxDecoyFp: 0,
};

// ---------------------------------------------------------------------------------------------
// Bucketing

const PACKAGE_MARKERS: [string, Bucket][] = [
  ['package.json', 'ts'],
  ['pyproject.toml', 'py'],
  ['setup.cfg', 'py'],
  ['setup.py', 'py'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'java'],
  ['settings.gradle', 'java'],
  ['settings.gradle.kts', 'java'],
];

/** Bucket by file language; html by the nearest package root above it (fallback ts). */
export function fsBucketOf(root: string): BucketOf {
  const dirCache = new Map<string, Bucket>();
  const ofDir = (dir: string): Bucket => {
    const hit = dirCache.get(dir);
    if (hit) return hit;
    let found: Bucket | null = null;
    for (const [marker, b] of PACKAGE_MARKERS) {
      if (fs.existsSync(path.join(root, dir, marker))) {
        found = b;
        break;
      }
    }
    if (!found) found = dir === '' || dir === '.' ? 'ts' : ofDir(path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir));
    dirCache.set(dir, found);
    return found;
  };
  return (relPath, language) => {
    const direct = directBucket(language);
    if (direct) return direct;
    const d = path.posix.dirname(relPath);
    return ofDir(d === '.' ? '' : d);
  };
}

function directBucket(language: string): Bucket | null {
  if (language === 'typescript' || language === 'javascript') return 'ts';
  if (language === 'python') return 'py';
  if (language === 'java') return 'java';
  return null;
}

/** Bucketing for in-memory corpora: html goes by `htmlBucket(path)` or ts. */
export function memBucketOf(htmlBucket: (p: string) => Bucket = () => 'ts'): BucketOf {
  return (p, language) => directBucket(language) ?? htmlBucket(p);
}

// ---------------------------------------------------------------------------------------------
// Evaluation

export interface Cell {
  key: number;
  detected: number;
  tp: number;
  /** null = n/a: nothing to divide by. Never read as 1.0. */
  precision: number | null;
  recall: number | null;
}
export type FailureKind = 'recall' | 'precision' | 'wrong-artifact' | 'decoy-fp' | 'min-sites' | 'vacuous' | 'no-fixtures';
export interface Failure {
  kind: FailureKind;
  lang?: Bucket;
  cat?: Category;
  msg: string;
}
export interface Report {
  ok: boolean;
  cells: Record<string, Cell>;
  keySitesPerLang: Record<Bucket, number>;
  matched: number;
  wrongArtifact: number;
  wrongs: string[];
  unresolvedMisses: number;
  fp: number;
  decoyFp: number;
  decoyHits: string[];
  fieldAgreement: Record<string, number>;
  envNames: { missing: string[]; extra: string[] };
  notAnalysedMismatch: string[];
  failures: Failure[];
}

export interface FixtureInput {
  name: string;
  key: AnswerKey;
  scan: ScanLike;
  bucketOf: BucketOf;
}

const cellId = (b: Bucket, c: string) => `${b}/${c}`;
const locOf = (p: string, l: number) => `${p}\u0000${l}`;

const norm = (v: unknown): string => JSON.stringify(v ?? null);
const normKeys = (v: string[] | undefined): string => JSON.stringify([...(v ?? [])].sort());

/**
 * A detected site at a labelled (path, line) is correct when category, sdk, op, managed, artifact
 * (kind, id, unresolved, alias), inputKeys and outputKeys all equal the key's (FIXTURES 4.1).
 */
export function siteCorrect(k: KeySite, d: SiteLike): boolean {
  const ka = k.artifact, da = d.artifact as ArtifactLike & { alias?: string | null };
  return (
    k.category === d.category &&
    norm(k.sdk) === norm(d.sdk) &&
    norm(k.op) === norm(d.op) &&
    norm(k.managed) === norm(d.managed) &&
    ka.kind === da.kind &&
    (ka.id ?? null) === (da.id ?? null) &&
    !!ka.unresolved === !!da.unresolved &&
    ((ka as { alias?: string | null }).alias ?? null) === (da.alias ?? null) &&
    normKeys(k.inputKeys) === normKeys(d.inputKeys) &&
    normKeys(k.outputKeys) === normKeys(d.outputKeys)
  );
}

/** Wrong-artifact verdict for a matched pair: 'wrong' | 'unresolved-miss' | null. */
export function artifactVerdict(k: ArtifactLike, d: ArtifactLike): 'wrong' | 'unresolved-miss' | null {
  const kRes = !k.unresolved && k.id != null;
  const dRes = !d.unresolved && d.id != null;
  if (dRes) return !kRes || k.id !== d.id || k.kind !== d.kind ? 'wrong' : null; // a guess, or another artifact
  return kRes ? 'unresolved-miss' : null;
}

export function evaluate(inputs: FixtureInput[], t: Thresholds = DEFAULT_THRESHOLDS): Report {
  const cells: Record<string, Cell> = {};
  const cell = (b: Bucket, c: string): Cell => (cells[cellId(b, c)] ??= { key: 0, detected: 0, tp: 0, precision: null, recall: null });
  for (const b of BUCKETS) for (const c of CATEGORIES) cell(b, c);
  const keySitesPerLang: Record<Bucket, number> = { ts: 0, py: 0, java: 0 };
  const agree: Record<string, [number, number]> = {};
  const tally = (f: string, ok: boolean) => {
    const a = (agree[f] ??= [0, 0]);
    a[1]++;
    if (ok) a[0]++;
  };
  let matched = 0, wrong = 0, unresolvedMisses = 0, fp = 0, decoyFp = 0;
  const wrongs: string[] = [];
  const decoyHits: string[] = [];
  const missingNames = new Set<string>(), extraNames = new Set<string>();
  const notAnalysedMismatch: string[] = [];

  for (const fx of inputs) {
    const keyByLoc = new Map<string, KeySite[]>();
    const detByLoc = new Map<string, SiteLike[]>();
    for (const k of fx.key.sites) {
      const b = fx.bucketOf(k.path, k.language);
      cell(b, k.category).key++;
      keySitesPerLang[b]++;
      const l = locOf(k.path, k.line);
      (keyByLoc.get(l) ?? keyByLoc.set(l, []).get(l)!).push(k);
    }
    for (const d of fx.scan.sites) {
      const l = locOf(d.relPath, d.line);
      (detByLoc.get(l) ?? detByLoc.set(l, []).get(l)!).push(d);
    }
    const keyPaths = new Set(fx.key.sites.map((s) => s.path));
    const decoyLocs = new Set((fx.key.decoys ?? []).map((x) => locOf(x.path, x.line)));
    const decoyFiles = new Set((fx.key.decoys ?? []).map((x) => x.path).filter((p) => !keyPaths.has(p)));

    const unmatchedDet: SiteLike[] = [];
    for (const l of new Set([...keyByLoc.keys(), ...detByLoc.keys()])) {
      const ks = [...(keyByLoc.get(l) ?? [])];
      const ds = [...(detByLoc.get(l) ?? [])];
      const pair = (same: (k: KeySite, d: SiteLike) => boolean, correct: boolean) => {
        for (let i = 0; i < ks.length; i++) {
          const j = ds.findIndex((d) => same(ks[i]!, d));
          if (j < 0) continue;
          const k = ks[i]!, d = ds[j]!;
          ks.splice(i--, 1);
          ds.splice(j, 1);
          matched++;
          if (correct) {
            const c = cell(fx.bucketOf(k.path, k.language), k.category);
            c.tp++;
            c.detected++;
          } else {
            // Located at a labelled site but not the right answer: a miss for the key, a false positive here.
            cell(fx.bucketOf(d.relPath, d.language), d.category).detected++;
            fp++;
          }
          const v = artifactVerdict(k.artifact, d.artifact);
          if (v === 'wrong') {
            wrong++;
            if (wrongs.length < 20) wrongs.push(`${fx.name}:${k.path}:${k.line}`);
          } else if (v === 'unresolved-miss') unresolvedMisses++;
          tally('symbol', k.symbol === d.symbol);
        }
      };
      pair(siteCorrect, true);
      pair((k, d) => k.category === d.category, false);
      pair(() => true, false);
      unmatchedDet.push(...ds); // key sites left in ks are misses (already counted in key)
    }
    for (const d of unmatchedDet) {
      const b = fx.bucketOf(d.relPath, d.language);
      cell(b, d.category).detected++;
      fp++;
      const loc = locOf(d.relPath, d.line);
      if (decoyLocs.has(loc) || decoyFiles.has(d.relPath)) {
        decoyFp++;
        if (decoyHits.length < 20) decoyHits.push(`${fx.name}:${d.relPath}:${d.line}`);
      }
    }
    const keyNames = new Set(fx.key.envVarNames ?? []);
    const gotNames = new Set(fx.scan.envVarNames ?? []);
    for (const n of keyNames) if (!gotNames.has(n)) missingNames.add(n);
    for (const n of gotNames) if (!keyNames.has(n)) extraNames.add(n);
    const na = fx.key.notAnalysed ?? {};
    const gotNa = fx.scan.notAnalysed ?? {};
    for (const n of new Set([...Object.keys(na), ...Object.keys(gotNa)])) {
      if ((na[n] ?? 0) !== (gotNa[n] ?? 0)) notAnalysedMismatch.push(`${fx.name}:${n}`);
    }
  }

  for (const c of Object.values(cells)) {
    c.precision = c.detected ? c.tp / c.detected : null;
    c.recall = c.key ? c.tp / c.key : null;
  }

  const failures: Failure[] = [];
  const langs = t.langs ?? BUCKETS;
  const cats = t.categories ?? CATEGORIES;
  const totalKey = BUCKETS.reduce((n, b) => n + keySitesPerLang[b], 0);
  if (!inputs.length || totalKey === 0) failures.push({ kind: 'no-fixtures', msg: 'no labelled sites evaluated' });
  for (const b of langs) {
    if (keySitesPerLang[b] < t.minSitesPerLang)
      failures.push({ kind: 'min-sites', lang: b, msg: `${b}: ${keySitesPerLang[b]} labelled sites < floor ${t.minSitesPerLang}` });
  }
  for (const c of cats) {
    const f = t.floors[c];
    if (!f) continue;
    for (const b of langs) {
      const x = cells[cellId(b, c)]!;
      if (x.key === 0) {
        failures.push({ kind: 'vacuous', lang: b, cat: c, msg: `${b}/${c}: n/a (no labelled sites), a floor cannot be met vacuously` });
        continue;
      }
      if (f[0] !== null && (x.precision === null || x.precision < f[0]))
        failures.push({ kind: 'precision', lang: b, cat: c, msg: `${b}/${c}: precision ${x.precision === null ? 'n/a' : x.precision.toFixed(3)} < ${f[0]}` });
      if (x.recall === null || x.recall < f[1])
        failures.push({ kind: 'recall', lang: b, cat: c, msg: `${b}/${c}: recall ${x.recall === null ? 'n/a' : x.recall.toFixed(3)} < ${f[1]}` });
    }
  }
  if (wrong > t.maxWrongArtifact)
    failures.push({ kind: 'wrong-artifact', msg: `wrong-artifact ${wrong} > ${t.maxWrongArtifact} (${wrongs.slice(0, 3).join(', ')})` });
  if (decoyFp > t.maxDecoyFp)
    failures.push({ kind: 'decoy-fp', msg: `decoys reported as sites ${decoyFp} > ${t.maxDecoyFp} (${decoyHits.slice(0, 3).join(', ')})` });

  const fieldAgreement: Record<string, number> = {};
  for (const [f, [a, n]] of Object.entries(agree)) fieldAgreement[f] = n ? a / n : 1;
  return {
    ok: failures.length === 0,
    cells,
    keySitesPerLang,
    matched,
    wrongArtifact: wrong,
    wrongs,
    unresolvedMisses,
    fp,
    decoyFp,
    decoyHits,
    fieldAgreement,
    envNames: { missing: [...missingNames].sort(), extra: [...extraNames].sort() },
    notAnalysedMismatch,
    failures,
  };
}

// ---------------------------------------------------------------------------------------------
// Corpus loading and scanners

export interface Fixture {
  name: string;
  root: string;
  key: AnswerKey;
}

const KEY_FIELDS = ['fixture', 'labelledBy', 'reviewedBy', 'sites', 'implementations', 'decoys', 'notAnalysed', 'envVarNames'];
const SITE_FIELDS = ['path', 'line', 'language', 'category', 'symbol', 'sdk', 'op', 'managed', 'artifact', 'inputKeys', 'outputKeys'];
const ARTIFACT_FIELDS = ['kind', 'id', 'unresolved', 'envVarName', 'alias', 'pinnedVersion'];
const KEY_LANGUAGES = ['typescript', 'javascript', 'python', 'java', 'html'];

/** Fail loudly on a malformed key: unknown field, unknown category or language, wrong types (FIXTURES 4). */
export function validateKey(key: unknown, where: string): AnswerKey {
  const bad = (m: string): never => {
    throw new Error(`${where}: ${m}`);
  };
  const obj = (v: unknown, what: string): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${what} is not an object`);
  const only = (o: Record<string, unknown>, allowed: string[], what: string) => {
    for (const f of Object.keys(o)) if (!allowed.includes(f)) bad(`unknown field '${f}' in ${what}`);
  };
  const k = obj(key, 'key');
  only(k, KEY_FIELDS, 'key');
  if (!Array.isArray(k.sites)) bad('no sites array');
  (k.sites as unknown[]).forEach((raw, i) => {
    const s = obj(raw, `sites[${i}]`);
    only(s, SITE_FIELDS, `sites[${i}]`);
    if (typeof s.path !== 'string' || !Number.isInteger(s.line) || (s.line as number) < 1) bad(`sites[${i}] needs a path and a 1-based line`);
    if (!(CATEGORIES as readonly string[]).includes(s.category as string)) bad(`sites[${i}] unknown category '${String(s.category)}'`);
    if (!KEY_LANGUAGES.includes(s.language as string)) bad(`sites[${i}] unknown language '${String(s.language)}'`);
    const a = obj(s.artifact, `sites[${i}].artifact`);
    only(a, ARTIFACT_FIELDS, `sites[${i}].artifact`);
    if (typeof a.kind !== 'string' || typeof a.unresolved !== 'boolean') bad(`sites[${i}].artifact needs kind and unresolved`);
    if ((a.id === null) !== (a.unresolved === true)) bad(`sites[${i}].artifact: id is null exactly when unresolved`);
  });
  for (const [n, list] of [['decoys', k.decoys], ['implementations', k.implementations]] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) bad(`${n} is not an array`);
    (list as unknown[]).forEach((raw, i) => {
      const o = obj(raw, `${n}[${i}]`);
      only(o, n === 'decoys' ? ['path', 'line', 'why'] : ['path', 'line'], `${n}[${i}]`);
      if (typeof o.path !== 'string' || !Number.isInteger(o.line)) bad(`${n}[${i}] needs a path and a line`);
    });
  }
  return key as AnswerKey;
}

export function loadFixtures(dir: string): Fixture[] {
  const out: Fixture[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const kp = path.join(dir, e.name, 'answer-key.json');
    if (!fs.existsSync(kp)) continue;
    const key = validateKey(JSON.parse(fs.readFileSync(kp, 'utf8')), kp);
    out.push({ name: e.name, root: path.join(dir, e.name), key });
  }
  return out;
}

/** The answer key standing in for the detectors. */
export function oracleScan(key: AnswerKey): ScanLike {
  return {
    sites: key.sites.map((s) => {
      const { path: p, ...rest } = structuredClone(s); // a copy: a mutation of the scan must never reach the key
      return { ...rest, relPath: p, detector: 'oracle' } as SiteLike;
    }),
    envVarNames: [...(key.envVarNames ?? [])],
    notAnalysed: { ...(key.notAnalysed ?? {}) },
  };
}

/** Env plants live under neutral names (CONTRACT D10); the scan treats them as the real env files. */
export async function realEnvFiles() {
  const { DEFAULT_ENV_FILES } = await import('../src/codemap/walk.js');
  return {
    secret: [...DEFAULT_ENV_FILES.secret, 'dot-env', 'dot-env.*'],
    names: [...DEFAULT_ENV_FILES.names, 'dot-env.example'],
  };
}

// ---------------------------------------------------------------------------------------------
// Mutants

/**
 * Turns comments and docstrings into code, keeping every line and column (markers become spaces),
 * so a detector that would have skipped them no longer can. Strings are tracked so a `//` inside a
 * URL is left alone.
 */
export function uncomment(text: string, language: string): string {
  const out = text.split('');
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  if (language === 'html') {
    const re = /<!--|-->/g;
    for (let m = re.exec(text); m; m = re.exec(text)) blank(m.index, m.index + m[0].length);
    return out.join('');
  }
  const py = language === 'python';
  let i = 0;
  let lineStart = true; // only whitespace seen on this line so far
  while (i < n) {
    const ch = text[i]!;
    if (ch === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    const three = text.slice(i, i + 3);
    if (py && ch === '#') {
      blank(i, i + 1);
      i++;
      continue;
    }
    if (!py && two === '//') {
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (!py && two === '/*') {
      blank(i, i + 2);
      i += 2;
      let atLineStart = false;
      while (i < n && text.slice(i, i + 2) !== '*/') {
        if (text[i] === '\n') atLineStart = true;
        else if (atLineStart && text[i] === '*') {
          blank(i, i + 1);
          atLineStart = false;
        } else if (!/\s/.test(text[i]!)) atLineStart = false;
        i++;
      }
      if (i < n) blank(i, i + 2);
      i += 2;
      lineStart = false;
      continue;
    }
    if (py && (three === '"""' || three === "'''")) {
      const docstring = lineStart;
      const end = text.indexOf(three, i + 3);
      const stop = end < 0 ? n : end + 3;
      if (docstring) blank(i, i + 3), end >= 0 && blank(end, end + 3);
      i = stop;
      lineStart = false;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && !py)) {
      if (!py && language === 'java' && three === '"""') {
        const end = text.indexOf('"""', i + 3);
        i = end < 0 ? n : end + 3;
        lineStart = false;
        continue;
      }
      i++;
      while (i < n && text[i] !== ch) {
        if (text[i] === '\\') i++;
        else if (text[i] === '\n' && ch !== '`') break;
        i++;
      }
      i++;
      lineStart = false;
      continue;
    }
    if (!/\s/.test(ch)) lineStart = false;
    i++;
  }
  return out.join('');
}

export interface Mutant {
  name: string;
  /** Failure that proves the evaluator noticed this mutant for the right reason (any of). */
  expect: { kind: FailureKind; lang?: Bucket; cat?: Category }[];
  /** Real-mode options handed to detectProject. */
  options?: { skipDirs?: string[]; preprocess?: (f: SourceFile) => SourceFile };
  /** Real mode: drop detectors by the languages they run on. */
  dropDetectorLanguage?: string;
  /** Real mode: drop detectors whose id (`<lang>.<category>[.<variant>]`) matches. */
  dropDetectorId?: RegExp;
  /** Applied to the outcome in both modes (a detector's output vanishing, a dynamic id guessed). */
  post?: (s: ScanLike) => ScanLike;
  /** Oracle mode only: what the real detectors would additionally report once the guard is gone. */
  oracleExtra?: (key: AnswerKey) => SiteLike[];
}

const phantom = (relPath: string, line: number): SiteLike => ({
  relPath,
  line,
  language: /\.py$/.test(relPath) ? 'python' : /\.java$/.test(relPath) ? 'java' : /\.html?$/.test(relPath) ? 'html' : 'typescript',
  category: 'managed',
  symbol: '<module>',
  sdk: 'node',
  op: 'run',
  managed: 'typed-client',
  artifact: { kind: 'workflow', id: 'wf_phantom', unresolved: false, envVarName: null },
  detector: 'mutant',
});

const phantomsFor = (key: AnswerKey, why: string[]): SiteLike[] =>
  (key.decoys ?? []).filter((d) => d.why && why.includes(d.why)).map((d) => phantom(d.path, d.line));

const guessId = (s: SiteLike, all: SiteLike[]): string => {
  const known = all.find((x) => x.artifact.kind === s.artifact.kind && x.artifact.id)?.artifact.id;
  return known ?? 'guessed_id';
};

export const MUTANTS: Mutant[] = [
  {
    name: 'drop-raw-http',
    dropDetectorId: /\.raw-http(\.|$)/,
    expect: [{ kind: 'recall', cat: 'raw-http' }],
    post: (s) => ({ ...s, sites: s.sites.filter((x) => x.managed !== 'raw-http') }),
  },
  {
    name: 'drop-widget',
    dropDetectorId: /\.widget(\.|$)/,
    expect: [{ kind: 'recall', cat: 'widget' }],
    post: (s) => ({ ...s, sites: s.sites.filter((x) => x.sdk !== 'widget-embed') }),
  },
  {
    name: 'scan-vendored',
    expect: [{ kind: 'decoy-fp' }, { kind: 'precision' }],
    options: { skipDirs: [] },
    oracleExtra: (k) => phantomsFor(k, ['vendored']),
  },
  {
    name: 'scan-comments',
    expect: [{ kind: 'decoy-fp' }, { kind: 'precision' }],
    options: { preprocess: (f) => ({ ...f, text: uncomment(f.text, f.language) }) },
    oracleExtra: (k) => phantomsFor(k, ['comment', 'docstring']),
  },
  {
    name: 'guess-dynamic',
    expect: [{ kind: 'wrong-artifact' }],
    post: (s) => ({
      ...s,
      sites: s.sites.map((x) =>
        x.artifact.unresolved || x.artifact.id == null
          ? { ...x, artifact: { ...x.artifact, id: guessId(x, s.sites), unresolved: false } }
          : x
      ),
    }),
  },
  {
    name: 'drop-java',
    expect: [{ kind: 'recall', lang: 'java' }],
    dropDetectorLanguage: 'java',
    post: (s) => ({ ...s, sites: s.sites.filter((x) => x.language !== 'java') }),
  },
];

export const IDENTITY_MUTANT: Mutant = { name: 'identity', expect: [] };

export interface Scanner {
  (fx: Fixture, m: Mutant | null): Promise<ScanLike>;
}

export const oracleScanner: Scanner = async (fx, m) => {
  let s = oracleScan(fx.key);
  if (m?.oracleExtra) s = { ...s, sites: [...s.sites, ...m.oracleExtra(fx.key)] };
  return m?.post ? m.post(s) : s;
};

export const realScanner: Scanner = async (fx, m) => {
  const { detectProject } = await import('../src/codemap/detect.js');
  const envFiles = await realEnvFiles();
  const opts: Record<string, unknown> = { envFiles };
  if (m?.options?.skipDirs) opts.skipDirs = m.options.skipDirs;
  if (m?.options?.preprocess) opts.preprocess = m.options.preprocess;
  if (m?.dropDetectorLanguage || m?.dropDetectorId) {
    const { DETECTORS } = await import('../src/codemap/detectors/index.js');
    const lang = m.dropDetectorLanguage;
    opts.detectors = DETECTORS.filter((d) => !(lang && d.languages.includes(lang as never)) && !m.dropDetectorId?.test(d.id));
  }
  const out: DetectOutcome = await detectProject(fx.root, opts);
  const s: ScanLike = { sites: out.sites as unknown as SiteLike[], envVarNames: out.envVarNames, notAnalysed: out.notAnalysed };
  return m?.post ? m.post(s) : s;
};

export async function evaluateCorpus(fixtures: Fixture[], scanner: Scanner, m: Mutant | null, t: Thresholds) {
  const inputs: FixtureInput[] = [];
  const scans: ScanLike[] = [];
  for (const fx of fixtures) {
    const scan = await scanner(fx, m);
    scans.push(scan);
    inputs.push({ name: fx.name, key: fx.key, scan, bucketOf: fsBucketOf(fx.root) });
  }
  return { report: evaluate(inputs, t), scans };
}

export interface MutantVerdict {
  name: string;
  status: 'killed' | 'survived' | 'killed-wrong-metric';
  /** Survived because the mutation changed nothing in this corpus (proves nothing either way). */
  inert: boolean;
  /** How many sites the mutation added or removed against the unmutated scan. */
  changes: number;
  tripped: string[];
  report: Report;
}

const siteKey = (s: SiteLike) => `${s.relPath}:${s.line}:${s.category}:${s.artifact.id ?? '?'}`;
function changeCount(a: ScanLike[], b: ScanLike[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const x = new Set(a[i]!.sites.map(siteKey));
    const y = new Set(b[i]!.sites.map(siteKey));
    for (const k of x) if (!y.has(k)) n++;
    for (const k of y) if (!x.has(k)) n++;
  }
  return n;
}

export function tripsExpected(m: Mutant, r: Report): boolean {
  return r.failures.some((f) =>
    m.expect.some((e) => e.kind === f.kind && (e.lang === undefined || e.lang === f.lang) && (e.cat === undefined || e.cat === f.cat))
  );
}

export async function runMutants(fixtures: Fixture[], scanner: Scanner, t: Thresholds, names: string[] | 'all') {
  const base = await evaluateCorpus(fixtures, scanner, null, t);
  const chosen = names === 'all' ? MUTANTS : names.map((n) => {
    const m = MUTANTS.find((x) => x.name === n) ?? (n === 'identity' ? IDENTITY_MUTANT : undefined);
    if (!m) throw new Error(`unknown mutant '${n}'`);
    return m;
  });
  const verdicts: MutantVerdict[] = [];
  for (const m of chosen) {
    const r = await evaluateCorpus(fixtures, scanner, m, t);
    const changes = changeCount(base.scans, r.scans);
    const tripped = r.report.failures.map((f) => f.kind + (f.lang ? `:${f.lang}` : '') + (f.cat ? `/${f.cat}` : ''));
    const status: MutantVerdict['status'] = r.report.ok
      ? 'survived'
      : m === IDENTITY_MUTANT || tripsExpected(m, r.report) ? 'killed' : 'killed-wrong-metric';
    verdicts.push({ name: m.name, status, inert: changes === 0 && m !== IDENTITY_MUTANT, changes, tripped: [...new Set(tripped)], report: r.report });
  }
  const identity = await evaluateCorpus(fixtures, scanner, IDENTITY_MUTANT, t);
  return { base: base.report, verdicts, identity: identity.report };
}

// ---------------------------------------------------------------------------------------------
// CLI

const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));

function fmtReport(r: Report): string[] {
  const lines: string[] = [];
  for (const b of BUCKETS) {
    lines.push(`${b}: ${r.keySitesPerLang[b]} labelled sites`);
    for (const c of CATEGORIES) {
      const x = r.cells[cellId(b, c)]!;
      lines.push(`  ${c.padEnd(9)} key=${String(x.key).padStart(3)} det=${String(x.detected).padStart(3)} tp=${String(x.tp).padStart(3)} precision=${fmt(x.precision)} recall=${fmt(x.recall)}`);
    }
  }
  lines.push(`matched=${r.matched} false-positives=${r.fp} decoys-as-sites=${r.decoyFp} wrong-artifact=${r.wrongArtifact} unresolved-misses=${r.unresolvedMisses}`);
  lines.push(`field agreement: ${Object.entries(r.fieldAgreement).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')}`);
  if (r.envNames.missing.length || r.envNames.extra.length) lines.push(`envVarNames missing=[${r.envNames.missing}] extra=[${r.envNames.extra}]`);
  if (r.notAnalysedMismatch.length) lines.push(`notAnalysed mismatch: ${r.notAnalysedMismatch.join(', ')}`);
  return lines;
}

function parseList<T extends string>(spec: string, allowed: Record<string, T>, what: string): T[] {
  const out = spec.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const v = allowed[x];
    if (!v) throw new Error(`unknown ${what} '${x}'`);
    return v;
  });
  if (!out.length) throw new Error(`empty ${what} list`);
  return [...new Set(out)];
}

function parseArgs(argv: string[]) {
  const a = [...argv];
  const flag = (n: string) => {
    const i = a.indexOf(n);
    if (i < 0) return false;
    a.splice(i, 1);
    return true;
  };
  const val = (n: string): string | null => {
    const i = a.indexOf(n);
    if (i < 0) return null;
    const v = a[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${n} needs a value`);
    a.splice(i, 2);
    return v;
  };
  const num = (n: string, d: number) => {
    const v = val(n);
    if (v === null) return d;
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new Error(`${n} must be a non-negative number`);
    return x;
  };
  const o = {
    fixtures: val('--fixtures'),
    oracle: flag('--oracle'),
    json: flag('--json'),
    minSites: num('--min-sites-per-lang', DEFAULT_THRESHOLDS.minSitesPerLang),
    floors: val('--floors') ?? DEFAULT_FLOORS_SPEC,
    maxWrong: num('--max-wrong-artifact', 0),
    maxDecoy: num('--max-decoy-fp', 0),
    langs: val('--langs'),
    categories: val('--categories'),
    mutants: val('--mutants'),
    expectKilled: val('--expect-killed'),
  };
  if (a.length) throw new Error(`unknown arguments: ${a.join(' ')}`);
  return o;
}

export async function main(argv: string[]): Promise<number> {
  let o: ReturnType<typeof parseArgs>;
  let t: Thresholds;
  try {
    o = parseArgs(argv);
    if (!o.fixtures) throw new Error('--fixtures <dir> is required');
    t = { minSitesPerLang: o.minSites, floors: parseFloors(o.floors), maxWrongArtifact: o.maxWrong, maxDecoyFp: o.maxDecoy };
    if (o.langs !== null) t.langs = parseList(o.langs, { ts: 'ts', py: 'py', python: 'py', java: 'java' }, 'language');
    if (o.categories !== null)
      t.categories = parseList(o.categories, { managed: 'managed', 'raw-http': 'raw-http', widget: 'widget', dynamic: 'dynamic', 'dynamic-site': 'dynamic' }, 'category');
  } catch (e) {
    console.log(`CODEMAP_EVAL_FAIL usage: ${(e as Error).message}`);
    return 1;
  }
  const fixtures = loadFixtures(path.resolve(o.fixtures!));
  if (!fixtures.length) {
    console.log('CODEMAP_EVAL_FAIL no fixtures with an answer-key.json');
    return 1;
  }
  const scanner = o.oracle ? oracleScanner : realScanner;
  console.log(`mode=${o.oracle ? 'oracle' : 'detectProject'} fixtures=${fixtures.map((f) => f.name).join(',')}`);

  if (o.mutants !== null) {
    const names = o.mutants === 'all' ? 'all' : o.mutants.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await runMutants(fixtures, scanner, t, names);
    const real = res.verdicts.filter((v) => v.name !== 'identity');
    const total = names === 'all' ? MUTANTS.length : real.length;
    for (const v of res.verdicts) console.log(`MUTANT ${v.name} ${v.status.toUpperCase()}${v.inert ? ' (mutation changed nothing)' : ''} changes=${v.changes} tripped=[${v.tripped.join(' ')}]`);
    const killed = real.filter((v) => v.status === 'killed').length;
    const want = o.expectKilled === null ? total : Number(o.expectKilled);
    const problems: string[] = [];
    if (!res.base.ok) problems.push(`unmutated run fails its own thresholds (${res.base.failures[0]?.msg})`);
    if (!res.identity.ok) problems.push('identity mutant did not survive');
    if (!Number.isFinite(want)) problems.push('--expect-killed must be a number');
    if (killed !== want) problems.push(`killed ${killed}, expected exactly ${want}`);
    if (real.length < total) problems.push('not every mutant ran');
    if (total === 0) problems.push('no mutant was run');
    if (problems.length) {
      console.log(`CODEMAP_MUTANTS_FAIL ${problems.join('; ')}`);
      return 1;
    }
    console.log(`CODEMAP_MUTANTS_KILLED ${killed}/${total}`);
    return 0;
  }

  const { report } = await evaluateCorpus(fixtures, scanner, null, t);
  if (o.json) console.log(JSON.stringify(report));
  else for (const l of fmtReport(report)) console.log(l);
  if (!report.ok) {
    for (const f of report.failures) console.log(`  FAILED ${f.kind}: ${f.msg}`);
    console.log(`CODEMAP_EVAL_FAIL ${report.failures.length} bound(s) violated`);
    return 1;
  }
  console.log('CODEMAP_EVAL_OK');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.log(`CODEMAP_EVAL_FAIL ${(e as Error).message}`);
      process.exit(1);
    }
  );
}
