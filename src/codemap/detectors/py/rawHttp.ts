/**
 * Python raw HTTP call sites: `requests`, `httpx`, `urllib`, `aiohttp` calls whose URL is a Swfte API
 * route. The artifact id comes from the literal path; an id from a variable, env var or config is
 * reported unresolved. A request whose host is not Swfte's is not a site.
 */
import { inputKeys } from './keys.js';
import type { PySite } from './managed.js';
import { children, enclosingScope, evalPieces, isBroken, lineOf, plainString, symbolOf, walk, type PyNode } from './parse.js';
import { isSwfteBase, parseSwfteRoute } from './route.js';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request', 'stream', 'urlopen', 'Request']);
const CLIENT_CTOR = /(?:^|\.)(?:Client|AsyncClient|Session|ClientSession)$/;

function callArgs(call: PyNode): { pos: PyNode[]; kw: Map<string, PyNode> } {
  const pos: PyNode[] = [];
  const kw = new Map<string, PyNode>();
  const a = call.childForFieldName('arguments');
  for (const c of a ? children(a) : []) {
    if (c.type === 'keyword_argument') {
      const n = c.childForFieldName('name');
      const v = c.childForFieldName('value');
      if (n && v) kw.set(n.text, v);
    } else if (c.type !== 'comment') pos.push(c);
  }
  return { pos, kw };
}

/** Names of modules, clients and sessions a request verb is called on (`requests.post`, `self.http.get`). */
const HTTP_RECEIVER = /(?:^|\.)(?:requests?|httpx|aiohttp|urllib3?|urllib\.request|\w*(?:client|session|http|api|pool)\w*)$/i;

/**
 * The httpx/requests/aiohttp client a receiver variable was built from: whether it was built from an HTTP
 * client constructor, and the `base_url=` it was given. A `dict.get("https://api.swfte.com/...")` or a
 * cache lookup keyed by a Swfte URL is not a request.
 */
function httpClient(recv: PyNode, root: PyNode): { ctor: boolean; base: PyNode | null } {
  if (recv.type !== 'identifier') return { ctor: false, base: null };
  const scope = enclosingScope(recv) ?? root;
  let ctor = false;
  let found: PyNode | null = null;
  const consider = (value: PyNode | null): void => {
    if (!value || value.type !== 'call') return;
    const f = value.childForFieldName('function')?.text ?? '';
    if (!CLIENT_CTOR.test(f)) return;
    ctor = true;
    const base = callArgs(value).kw.get('base_url') ?? callArgs(value).kw.get('baseUrl');
    if (base) found = base;
  };
  walk(scope, (n) => {
    if (n.type === 'assignment' && n.childForFieldName('left')?.text === recv.text) consider(n.childForFieldName('right'));
    if (n.type === 'with_item' || n.type === 'as_pattern') {
      const target = n.children.find((c) => c && c.type === 'as_pattern_target')?.text;
      const v = n.type === 'with_item' ? n.childForFieldName('value') : children(n)[0];
      const val = v?.type === 'as_pattern' ? children(v)[0] : v;
      if (target === recv.text) consider(val ?? null);
    }
    return undefined;
  });
  return { ctor, base: found };
}

export function detectRawHttp(root: PyNode): PySite[] {
  const sites: PySite[] = [];
  walk(root, (call) => {
    if (call.type !== 'call' || isBroken(call)) return undefined;
    const f = call.childForFieldName('function');
    if (!f) return undefined;
    const name = f.type === 'attribute' ? f.childForFieldName('attribute')?.text ?? '' : f.type === 'identifier' ? f.text : '';
    if (!VERBS.has(name)) return undefined;
    const recv = f.type === 'attribute' ? f.childForFieldName('object') : null;
    const client = recv ? httpClient(recv, root) : { ctor: false, base: null };
    // `urlopen(...)` / `Request(...)` stand alone; every other verb needs an HTTP-looking receiver
    if (recv && !HTTP_RECEIVER.test(recv.text) && !client.ctor) return undefined;
    const { pos, kw } = callArgs(call);
    // request("POST", url) puts the URL second
    let urlIdx = 0;
    if (name === 'request' && pos.length > 1 && plainString(pos[0]) !== null) urlIdx = 1;
    const urlExpr = kw.get('url') ?? pos[urlIdx];
    if (!urlExpr) return undefined;
    const pieces = evalPieces(urlExpr);
    let route = parseSwfteRoute(pieces, false);
    if (!route && client.base && isSwfteBase(evalPieces(client.base))) route = parseSwfteRoute(pieces, true); // relative path through a client built with base_url=...
    if (!route) return undefined;
    const get = /^(?:get|head)$/.test(name) || plainString(pos[0])?.toUpperCase() === 'GET';
    const body = kw.get('json') ?? kw.get('data');
    const keys = get ? [] : body ? inputKeys(body) : [];
    sites.push({
      source: 'raw-http',
      line: lineOf(call),
      symbol: symbolOf(call),
      language: 'python',
      category: route.unresolved || route.placeholder ? 'dynamic' : 'raw-http',
      sdk: 'http',
      op: route.op,
      managed: 'raw-http',
      artifact: { kind: route.kind, id: route.id, unresolved: route.id === null, ...(route.envVarName ? { envVarName: route.envVarName } : {}), pinnedVersion: route.pinnedVersion, alias: null },
      contractHash: null,
      inputKeys: keys,
      outputKeys: [],
    });
    return undefined;
  });
  return sites;
}
