/**
 * Raw HTTP calls to the Swfte API in TypeScript/JavaScript (`fetch`, `axios`, `ky`, `got`, `undici`).
 * A URL counts only when its host is known to be Swfte: a literal `api.swfte.com`, the `SWFTE_BASE_URL`
 * variable, or a same-file constant that folds to either. The artifact id is the path segment after the
 * collection; a segment that is not a literal is unresolved (never guessed). Constant folding stays
 * inside the one file.
 */
import ts from 'typescript';
import { pathVersion } from '../../revisions.js';
import type { DetectContext, DetectedSite, DetectResult, Op, SourceFile } from '../../types.js';
import { ENV_NAME_PATTERN, ID_PATTERN, evalParts, findBinding, isTestPath, lineOf, mocksSwfte, unwrap, type Part } from './common.js';
import { isGeneratedByOtherTool } from '../../walk.js';
import { collectImports, isLocalModule, type ImportMap } from './imports.js';
import { inputKeysOf } from './keys.js';
import { hasGeneratedMarker } from './managed.js';
import { getParsed } from './parse.js';
import { symbolOf } from './symbols.js';

const DETECTOR_ID = 'ts.raw-http';
const HTTP_PACKAGES = new Set(['axios', 'ky', 'got', 'undici', 'node-fetch', 'cross-fetch', 'ofetch', 'undici-fetch']);
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'request', 'fetch', 'stream']);
const BODY_VERBS = new Set(['post', 'put', 'patch']);

const COLLECTIONS: Record<string, string> = { workflows: 'workflow', agents: 'agent', chatflows: 'chatflow', widgets: 'widget', applications: 'application' };

// Match only a URL authority. An API hostname in a foreign path, query, fragment or userinfo
// cannot make that foreign request a Swfte call. Unknown authority suffixes stay unknown.
const HOST_RE = /^(?:https?:\/\/|\/\/)(?:[a-z0-9-]+\.)*api\.swfte\.com(?::[0-9]+)?(?=[/?#]|$)/i;
const PLACE = '\u0000';

interface Folded {
  text: string;
  /** Env var name of each placeholder, in order (null: unknown). */
  places: Array<string | null>;
  hostKnown: boolean;
}

function fold(parts: Part[]): Folded {
  let text = '';
  const places: Array<string | null> = [];
  let hostKnown = false;
  for (const p of parts) {
    if (p.k === 'lit') text += p.v;
    else {
      if (p.k === 'env' && p.name === 'SWFTE_BASE_URL' && text === '') hostKnown = true;
      text += PLACE;
      places.push(p.k === 'env' ? p.name : null);
    }
  }
  if (hostKnown && !text.startsWith(`${PLACE}/`)) hostKnown = false;
  if (HOST_RE.test(text)) hostKnown = true;
  return { text, places, hostKnown };
}

interface Route {
  kind: string;
  id: string | null;
  envVarName?: string;
  pinnedVersion: string | null;
  op: Op;
}

/** The artifact a folded URL addresses, or null when it is not a Swfte artifact route. */
function routeOf(f: Folded): Route | null {
  // Normalize the actual path before identifying a collection. Keep every surviving
  // dynamic hole's original identity even when a preceding segment was removed.
  let stem = '~swfte-hole-';
  while (f.text.includes(stem)) stem += '_';
  let nextHole = 0;
  const symbolic = f.text.replace(/\u0000/g, () => `${stem}${nextHole++}~`);
  const envBase = f.text.startsWith(PLACE);
  const source = envBase ? `https://api.swfte.com${symbolic.slice(`${stem}0~`.length)}`
    : symbolic.startsWith('//') ? `https:${symbolic}` : symbolic;
  let normalized: string;
  try { normalized = new URL(source).pathname; } catch { return null; }
  const places: Array<string | null> = envBase ? [f.places[0] ?? null] : [];
  const path = (envBase ? PLACE : '') + normalized.replace(new RegExp(`${stem}(\\d+)~`, 'g'), (_marker, index: string) => {
    places.push(f.places[Number(index)] ?? null);
    return PLACE;
  });
  const segs = path.split('/');
  // the collection segment, not the host: look for /<v1|v2>/<collection>/<id>
  let placeIdx = 0;
  const placeBefore = (upTo: number) => {
    let n = 0;
    for (let i = 0; i < upTo; i++) n += (segs[i]!.match(/\u0000/g) ?? []).length;
    return n;
  };
  for (let i = 0; i < segs.length - 2; i++) {
    const seg = segs[i]!;
    const kind = COLLECTIONS[seg];
    if (!kind) continue;
    const v = segs[i - 1];
    const pub = segs[i - 1] === 'public' || (segs[i - 2] === 'v1' && segs[i - 1] === 'public');
    if (!(v === 'v1' || v === 'v2' || pub)) continue;
    const idSeg = segs[i + 1]!;
    if (idSeg === '') continue;
    placeIdx = placeBefore(i + 1);
    let id: string | null = null;
    let envVarName: string | undefined;
    if (idSeg.includes(PLACE)) {
      const only = idSeg === PLACE;
      const env = only ? places[placeIdx] ?? null : null;
      if (env && ENV_NAME_PATTERN.test(env)) envVarName = env;
    } else if (ID_PATTERN.test(idSeg)) id = idSeg;
    const tail = segs.slice(i + 2);
    let pinned: string | null = null;
    if (tail[0] === 'versions') {
      const version = tail[1];
      pinned = pathVersion(version);
      // A dynamic version does not make a literal artifact ID dynamic. Its pin is
      // unverified; raw HTTP callers remain cannot-check in impact evaluation.
      if (pinned === null && !version?.includes(PLACE)) { id = null; envVarName = undefined; }
    }
    const rest = tail.join('/');
    let op: Op = kind === 'agent' || kind === 'chatflow' ? 'chat' : 'run';
    if (/(^|\/)(executions|history|status|output|runs)(\/|$)/.test(rest) && !/invoke|execute$/.test(rest)) op = 'read-output';
    else if (/(^|\/)stream(\/|$)/.test(rest)) op = 'stream';
    else if (kind === 'agent' && /(^|\/)chat(\/|$)/.test(rest)) op = 'chat';
    return { kind, id, ...(envVarName ? { envVarName } : {}), pinnedVersion: pinned, op };
  }
  return null;
}

type Http = { url: ts.Expression; init: ts.Expression | undefined; verb: string | null; call: ts.CallExpression };

/** Recognises an HTTP client call and splits it into url and options. */
function httpCall(n: ts.CallExpression, imports: ImportMap): Http | null {
  const callee = unwrap(n.expression);
  const args = n.arguments;
  if (ts.isIdentifier(callee)) {
    const ref = imports.get(callee.text);
    const b = findBinding(callee.text, callee);
    const fetchLike = callee.text === 'fetch' && (!b || b.kind === 'import');
    const pkg = ref && !isLocalModule(ref.module) && HTTP_PACKAGES.has(ref.module);
    if (fetchLike || pkg) {
      const a0 = args[0];
      if (!a0) return null;
      const first = unwrap(a0);
      if (ts.isObjectLiteralExpression(first) && !fetchLike) {
        const url = propOf(first, 'url');
        return url ? { url, init: first, verb: null, call: n } : null;
      }
      return { url: a0, init: args[1], verb: null, call: n };
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(callee) && VERBS.has(callee.name.text)) {
    const root = unwrap(callee.expression);
    if (ts.isIdentifier(root)) {
      const ref = imports.get(root.text);
      const isClient = ref && !isLocalModule(ref.module) && HTTP_PACKAGES.has(ref.module);
      const isInstance = (() => {
        const b = findBinding(root.text, root);
        if (!b?.init) return false;
        const init = unwrap(b.init);
        if (!ts.isCallExpression(init)) return false;
        const c = unwrap(init.expression);
        // axios.create(...), ky.create(...), got.extend(...)
        return ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && !!imports.get(c.expression.text) && HTTP_PACKAGES.has(imports.get(c.expression.text)!.module) && (c.name.text === 'create' || c.name.text === 'extend');
      })();
      if (!isClient && !isInstance) return null;
      const a0 = args[0];
      if (!a0) return null;
      const verb = callee.name.text;
      const first = unwrap(a0);
      if ((verb === 'request' || verb === 'fetch') && ts.isObjectLiteralExpression(first)) {
        const url = propOf(first, 'url');
        return url ? { url, init: first, verb: null, call: n } : null;
      }
      return { url: a0, init: args[1], verb, call: n };
    }
  }
  return null;
}

function propOf(o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** Keys of the JSON body sent: `JSON.stringify({...})`, an object literal, `json:` / `data:` options. */
function bodyKeys(h: Http): string[] {
  const initObj = h.init && unwrap(h.init);
  const initLit = initObj && ts.isObjectLiteralExpression(initObj) ? initObj : undefined;
  let method: string | null = h.verb;
  if (initLit) {
    const m = propOf(initLit, 'method');
    if (m) {
      const parts = evalParts(m);
      method = parts.length === 1 && parts[0]!.k === 'lit' ? parts[0]!.v.toLowerCase() : 'post';
    }
  }
  const isPackageVerb = h.verb !== null;
  if (isPackageVerb) {
    if (!BODY_VERBS.has(h.verb!)) return [];
    // axios.post(url, data, cfg) / ky.post(url, { json }) / got.post(url, { json })
    const a1 = h.call.arguments[1];
    if (!a1) return [];
    const obj = unwrap(a1);
    if (ts.isObjectLiteralExpression(obj)) {
      const json = propOf(obj, 'json') ?? propOf(obj, 'body');
      if (json && (propOf(obj, 'json') !== undefined || propOf(obj, 'headers') !== undefined || propOf(obj, 'body') !== undefined)) return bodyOf(json);
      if (propOf(obj, 'headers') !== undefined || propOf(obj, 'searchParams') !== undefined || propOf(obj, 'timeout') !== undefined) return [];
    }
    return inputKeysOf(a1);
  }
  if (!initLit) return h.init ? ['*'] : [];
  const data = propOf(initLit, 'body') ?? propOf(initLit, 'json') ?? propOf(initLit, 'data');
  if (!data) return [];
  return bodyOf(data);
}

function bodyOf(e: ts.Expression): string[] {
  let x = unwrap(e);
  if (ts.isIdentifier(x)) {
    const b = findBinding(x.text, x);
    if (b && b.kind === 'const' && b.init) x = unwrap(b.init);
  }
  if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === 'JSON' && x.expression.name.text === 'stringify') {
    return inputKeysOf(x.arguments[0]);
  }
  if (ts.isObjectLiteralExpression(x)) return inputKeysOf(x);
  return ['*'];
}

/** Every raw-HTTP site of a file, resolved or not (the index splits them by category). */
export function rawHttpSites(file: SourceFile, _ctx: DetectContext): DetectResult {
  const empty: DetectResult = { sites: [], implementations: [], envVarNames: [] };
  if (isTestPath(file.relPath) || mocksSwfte(file.text) || hasGeneratedMarker(file.text) || isGeneratedByOtherTool(file.text)) return empty;
  const sf = getParsed(file);
  const imports = collectImports(sf);
  const sites: DetectedSite[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const h = httpCall(n, imports);
      if (h) {
        const f = fold(evalParts(h.url));
        const route = f.hostKnown ? routeOf(f) : null;
        if (route) {
          const unresolved = route.id === null;
          sites.push({
            relPath: file.relPath,
            line: lineOf(sf, n),
            symbol: symbolOf(n),
            language: file.language === 'javascript' ? 'javascript' : 'typescript',
            category: unresolved ? 'dynamic' : 'raw-http',
            sdk: 'http',
            op: route.op,
            managed: 'raw-http',
            artifact: {
              kind: route.kind,
              id: route.id,
              unresolved,
              ...(route.envVarName ? { envVarName: route.envVarName } : {}),
              pinnedVersion: route.pinnedVersion,
              alias: null,
            },
            contractHash: null,
            inputKeys: route.op === 'read-output' ? [] : bodyKeys(h),
            outputKeys: [],
            detector: DETECTOR_ID,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sites, implementations: [], envVarNames: [] };
}
