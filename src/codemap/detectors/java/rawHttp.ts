/**
 * Java raw HTTP call sites: Spring `RestTemplate`, `WebClient`/`RestClient` and `java.net.http.HttpClient`
 * requests whose URL is a Swfte API route (host `api.swfte.com`, or `SWFTE_BASE_URL`, possibly through a
 * same-file constant or a client configured with a Swfte `baseUrl`). The artifact id comes from the
 * literal path, or from the URI-template variable that fills a `{id}` placeholder; anything else is
 * reported unresolved. A request whose host is not Swfte's is not a site.
 */
import { inputKeys } from './keys.js';
import type { JavaSite } from './managed.js';
import { argsOf, declaredType, evalPieces, fieldValues, isBroken, lineOf, lookupName, nameOf, symbolOf, walk, type JNode } from './parse.js';
import { isSwfteBase, parseSwfteRoute, type SwfteRoute } from '../py/route.js';

/** RestTemplate method -> [index of the request body argument | null, index where URI variables start, fixed verb] */
const REST_METHODS: Record<string, { body: number | null; vars: number; verb: string | null }> = {
  getForObject: { body: null, vars: 2, verb: 'GET' },
  getForEntity: { body: null, vars: 2, verb: 'GET' },
  headForHeaders: { body: null, vars: 1, verb: 'HEAD' },
  postForObject: { body: 1, vars: 3, verb: 'POST' },
  postForEntity: { body: 1, vars: 3, verb: 'POST' },
  postForLocation: { body: 1, vars: 2, verb: 'POST' },
  patchForObject: { body: 1, vars: 3, verb: 'PATCH' },
  put: { body: 1, vars: 2, verb: 'PUT' },
  delete: { body: null, vars: 1, verb: 'DELETE' },
  exchange: { body: 2, vars: 4, verb: null },
  execute: { body: 2, vars: 4, verb: null },
};

const FLUENT_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const FLUENT_CLIENTS = /^(?:WebClient|RestClient)$/;

interface Emitted {
  route: SwfteRoute;
  call: JNode;
  verb: string;
  keys: string[];
}

/** Resolve a `{name}` placeholder id from the URI variables that follow the response type. */
function fillPlaceholder(route: SwfteRoute, varArgs: JNode[], urlText: string): SwfteRoute {
  if (!route.placeholder) return route;
  const name = /\/(?:v2\/workflows|v1\/agents|v1\/public\/agents|v1\/widgets|v2\/chatflows)\/\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(urlText)?.[1];
  const placeholders = [...urlText.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
  let valueExpr: JNode | null = null;
  const first = varArgs[0];
  if (first && first.type === 'method_invocation' && nameOf(first) === 'of' && /^(?:java\.util\.)?Map$/.test(first.childForFieldName('object')?.text ?? '')) {
    // Map.of("id", value, ...): by name
    const a = argsOf(first);
    for (let i = 0; i + 1 < a.length; i += 2) if (evalPieces(a[i]!).map((p) => (p.k === 'lit' ? p.v : '')).join('') === name) valueExpr = a[i + 1]!;
  } else {
    const idx = name ? placeholders.indexOf(name) : -1;
    valueExpr = idx >= 0 ? (varArgs[idx] ?? null) : null;
  }
  if (!valueExpr) return { ...route, placeholder: false, unresolved: true, id: null };
  const ps = evalPieces(valueExpr);
  if (ps.length === 1 && ps[0]!.k === 'lit' && /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/.test(ps[0]!.v)) return { ...route, placeholder: false, unresolved: false, id: ps[0]!.v };
  const env = ps.length === 1 && ps[0]!.k === 'env' ? ps[0]!.name : undefined;
  return { ...route, placeholder: false, unresolved: true, id: null, ...(env ? { envVarName: env } : {}) };
}

/** Body keys of a RestTemplate request argument: `new HttpEntity<>(body, headers)`, a bare Map, or a variable. */
function restBodyKeys(arg: JNode | undefined, depth = 0): string[] {
  if (!arg) return [];
  if (depth > 3) return ['*'];
  if (arg.type === 'identifier') {
    const v = lookupName(arg.text, arg);
    if (v && typeof v === 'object' && !('env' in v) && v.type === 'object_creation_expression') return restBodyKeys(v, depth + 1);
    return inputKeys(arg);
  }
  if (arg.type === 'object_creation_expression' && /^HttpEntity\b/.test(arg.childForFieldName('type')?.text ?? '')) {
    const a = argsOf(arg);
    if (a.length >= 2) return inputKeys(a[0]!);
    if (a.length === 1) {
      const only = a[0]!;
      // one argument is either the body or the headers; only a Map literal is surely a body
      return only.type === 'method_invocation' && /^(?:java\.util\.)?Map$/.test(only.childForFieldName('object')?.text ?? '') ? inputKeys(only) : ['*'];
    }
    return [];
  }
  return inputKeys(arg);
}

const httpMethodArg = (args: JNode[]): string | null => {
  for (const a of args) {
    if (a.type === 'field_access' && a.childForFieldName('object')?.text === 'HttpMethod') return a.childForFieldName('field')?.text ?? null;
    if (a.type === 'method_invocation' && nameOf(a) === 'valueOf' && a.childForFieldName('object')?.text === 'HttpMethod') {
      const s = evalPieces(argsOf(a)[0]!).map((p) => (p.k === 'lit' ? p.v : '')).join('');
      return s ? s.toUpperCase() : null;
    }
  }
  return null;
};

function restTemplate(call: JNode): Emitted | null {
  const spec = REST_METHODS[nameOf(call)];
  const obj = call.childForFieldName('object');
  const args = argsOf(call);
  if (!spec || !obj || args.length === 0) return null;
  // `put`, `delete` and `execute` are everyday Map/Executor names: demand a RestTemplate-typed receiver
  if (spec.verb === 'PUT' || spec.verb === 'DELETE' || nameOf(call) === 'execute') {
    const recvName = obj.type === 'identifier' ? obj.text : obj.type === 'field_access' && obj.childForFieldName('object')?.type === 'this' ? (obj.childForFieldName('field')?.text ?? '') : '';
    const type = recvName ? declaredType(recvName, obj) : null;
    if (!type || !/Rest(?:Template|Operations|Client)\b/.test(type)) return null;
  }
  const pieces = evalPieces(args[0]!);
  const route0 = parseSwfteRoute(pieces, false);
  if (!route0) return null;
  const urlText = pieces.map((p) => (p.k === 'lit' ? p.v : '\u0000')).join('');
  const route = fillPlaceholder(route0, args.slice(spec.vars), urlText);
  const verb = spec.verb ?? httpMethodArg(args) ?? 'POST';
  const isRead = verb === 'GET' || verb === 'HEAD' || verb === 'DELETE';
  const keys = isRead ? [] : nameOf(call) === 'execute' ? ['*'] : restBodyKeys(spec.body !== null ? args[spec.body] : undefined);
  return { route, call, verb, keys };
}

// ---------------------------------------------------------------------------------------------
// WebClient / RestClient fluent chains: `webClient.post().uri(url).bodyValue(body)...`

function chainValueHasBase(v: JNode): JNode | null {
  let found: JNode | null = null;
  walk(v, (n) => {
    if (n.type !== 'method_invocation') return undefined;
    const name = nameOf(n);
    const a = argsOf(n);
    if ((name === 'baseUrl' && a[0]) || (name === 'create' && FLUENT_CLIENTS.test(n.childForFieldName('object')?.text ?? '') && a[0])) found = a[0]!;
    return undefined;
  });
  return found;
}

/** The base URL a client variable or field was configured with, when it is a Swfte one. */
function clientBaseIsSwfte(recv: JNode): boolean {
  const name = recv.type === 'identifier' ? recv.text : recv.type === 'field_access' && recv.childForFieldName('object')?.type === 'this' ? (recv.childForFieldName('field')?.text ?? '') : '';
  if (!name) return false;
  const v = lookupName(name, recv);
  const values: JNode[] = v && typeof v === 'object' && !('env' in v) ? [v] : [];
  values.push(...fieldValues(name, recv));
  for (const val of values) {
    const base = chainValueHasBase(val);
    if (base && isSwfteBase(evalPieces(base))) return true;
  }
  return false;
}

function fluent(uri: JNode): Emitted | null {
  const verbCall = uri.childForFieldName('object');
  if (!verbCall || verbCall.type !== 'method_invocation') return null;
  let verb = nameOf(verbCall);
  const recv = verbCall.childForFieldName('object');
  if (verb === 'method') verb = httpMethodArg(argsOf(verbCall)) ?? '';
  if (!recv || !FLUENT_VERBS.has(verb.toLowerCase()) || (nameOf(verbCall) !== 'method' && argsOf(verbCall).length !== 0)) return null;
  const args = argsOf(uri);
  if (args.length === 0) return null;
  const pieces = evalPieces(args[0]!);
  let route = parseSwfteRoute(pieces, false);
  if (!route && clientBaseIsSwfte(recv)) route = parseSwfteRoute(pieces, true);
  if (!route) return null;
  route = fillPlaceholder(route, args.slice(1), pieces.map((p) => (p.k === 'lit' ? p.v : '\u0000')).join(''));
  // the body: the nearest `.bodyValue(x)` / `.body(BodyInserters.fromValue(x))` further down the chain
  let keys: string[] = [];
  const isRead = /^(?:get|head|delete|options)$/i.test(verb);
  if (!isRead) {
    for (let cur = uri, p = uri.parent; p && p.type === 'method_invocation' && p.childForFieldName('object')?.id === cur.id; cur = p, p = p.parent) {
      const name = nameOf(p);
      const a = argsOf(p);
      if ((name === 'bodyValue' || name === 'syncBody') && a[0]) {
        keys = inputKeys(a[0]);
        break;
      }
      if (name === 'body' && a[0]) {
        const inner = a[0];
        const wrapped = inner.type === 'method_invocation' && /^(?:fromValue|just)$/.test(nameOf(inner)) ? argsOf(inner)[0] : undefined;
        keys = wrapped ? inputKeys(wrapped) : ['*'];
        break;
      }
    }
  }
  return { route, call: uri, verb: verb.toUpperCase(), keys };
}

// ---------------------------------------------------------------------------------------------
// java.net.http: `HttpRequest.newBuilder(URI.create(url))...build()`

function jdkRequest(nb: JNode): Emitted | null {
  if (nameOf(nb) !== 'newBuilder' || nb.childForFieldName('object')?.text !== 'HttpRequest') return null;
  let urlExpr: JNode | undefined = argsOf(nb)[0];
  let verb = 'GET';
  let keys: string[] = [];
  for (let cur = nb, p = nb.parent; p && p.type === 'method_invocation' && p.childForFieldName('object')?.id === cur.id; cur = p, p = p.parent) {
    const name = nameOf(p);
    const a = argsOf(p);
    if (name === 'uri' && a[0]) urlExpr = a[0];
    else if (/^(?:POST|PUT|PATCH)$/.test(name)) {
      verb = name;
      const pub = a[0];
      keys = pub && pub.type === 'method_invocation' && nameOf(pub) === 'noBody' ? [] : ['*'];
    } else if (name === 'DELETE' || name === 'GET') verb = name;
    else if (name === 'method' && a[0]) {
      verb = evalPieces(a[0]).map((x) => (x.k === 'lit' ? x.v : '')).join('').toUpperCase() || 'POST';
      keys = verb === 'GET' || verb === 'DELETE' ? [] : ['*'];
    }
  }
  if (!urlExpr) return null;
  const route = parseSwfteRoute(evalPieces(urlExpr), false);
  if (!route) return null;
  return { route, call: nb, verb, keys };
}

export function detectRawHttp(root: JNode): JavaSite[] {
  const sites: JavaSite[] = [];
  const seen = new Set<number>();
  walk(root, (call) => {
    if (call.type !== 'method_invocation' || isBroken(call)) return undefined;
    const name = nameOf(call);
    let hit: Emitted | null = null;
    if (name === 'newBuilder') hit = jdkRequest(call);
    else if (name === 'uri') hit = fluent(call);
    else if (REST_METHODS[name]) hit = restTemplate(call);
    if (!hit || seen.has(hit.call.id)) return undefined;
    seen.add(hit.call.id);
    const { route } = hit;
    const unresolved = route.id === null;
    sites.push({
      source: 'raw-http',
      line: lineOf(hit.call),
      symbol: symbolOf(hit.call),
      language: 'java',
      category: unresolved ? 'dynamic' : 'raw-http',
      sdk: 'http',
      op: route.op,
      managed: 'raw-http',
      artifact: { kind: route.kind, id: route.id, unresolved, ...(route.envVarName ? { envVarName: route.envVarName } : {}), pinnedVersion: route.pinnedVersion, alias: null },
      contractHash: null,
      inputKeys: hit.keys,
      outputKeys: [],
    });
    return undefined;
  });
  return sites;
}
