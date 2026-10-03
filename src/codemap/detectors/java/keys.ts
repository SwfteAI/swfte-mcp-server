/**
 * Input and output key extraction for Java call sites (docs/codemap/FIXTURES.md §4.1). Names only: map
 * keys and dotted read paths, never a value. `["*"]` says the keys could not be named.
 */
import { argsOf, children, enclosingBlock, enclosingNamedMethod, evalPieces, literalOf, lookupName, nameOf, walk, type JNode } from './parse.js';

const MAX_KEYS = 64;
const STAR = ['*'];

export const finishKeys = (keys: Iterable<string>): string[] => [...new Set(keys)].sort().slice(0, MAX_KEYS);

const literalKey = (n: JNode | null | undefined): string | null => {
  if (!n) return null;
  const s = literalOf(evalPieces(n));
  return s !== null && s.length > 0 ? s : null;
};

const MAP_TYPES = /^(?:HashMap|LinkedHashMap|TreeMap|ConcurrentHashMap|Hashtable|WeakHashMap|IdentityHashMap|EnumMap)(?:<.*>)?$/;

const isMapFactory = (obj: JNode | null): boolean => !!obj && /^(?:java\.util\.)?(?:Map|ImmutableMap|Maps)$/.test(obj.text);

/** Whether `n` is `new HashMap<>()`-like; returns the copy source argument when there is one. */
function newMap(n: JNode): { ok: boolean; copy: JNode | null } {
  if (n.type !== 'object_creation_expression') return { ok: false, copy: null };
  if (n.children.some((c) => c && c.type === 'class_body')) return { ok: false, copy: null };
  const t = n.childForFieldName('type')?.text ?? '';
  if (!MAP_TYPES.test(t.replace(/^java\.util\./, ''))) return { ok: false, copy: null };
  const args = argsOf(n);
  return { ok: true, copy: args.length === 1 && !/^\d/.test(args[0]!.text) ? args[0]! : null };
}

/** The references to local `name` in the method after `after`, stopping at a reassignment. */
interface ScopeReferences {
  refs: Map<string, JNode[]>;
  assignments: Map<string, number[]>;
}
let referenceTrees = new WeakMap<JNode['tree'], Map<number, ScopeReferences>>();

/** Private Nodes are dispatch-scoped, never part of a detector result or public cache. */
export function releaseKeyAnalysis(): void {
  referenceTrees = new WeakMap();
}

function add<T>(map: Map<string, T[]>, name: string, value: T): void {
  const values = map.get(name);
  if (values) values.push(value);
  else map.set(name, [value]);
}

/** Keep the legacy recursive walk extent, reference inclusion and source order exactly. */
function scopeReferences(scope: JNode): ScopeReferences {
  let scopes = referenceTrees.get(scope.tree);
  if (!scopes) { scopes = new Map(); referenceTrees.set(scope.tree, scopes); }
  const hit = scopes.get(scope.id);
  if (hit) return hit;
  const index: ScopeReferences = { refs: new Map(), assignments: new Map() };
  walk(scope, n => {
    if (n.type === 'assignment_expression') {
      const left = n.childForFieldName('left');
      if (left?.type === 'identifier') add(index.assignments, left.text, n.startIndex);
    }
    if (n.type !== 'identifier') return undefined;
    const p = n.parent;
    if (!p) return undefined;
    if (p.type === 'method_invocation' && p.childForFieldName('name')?.id === n.id) return undefined;
    if (p.type === 'field_access' && p.childForFieldName('field')?.id === n.id) return undefined;
    if (p.type === 'variable_declarator' && p.childForFieldName('name')?.id === n.id) return undefined;
    if (p.type === 'formal_parameter' || p.type === 'method_reference') return undefined;
    add(index.refs, n.text, n);
    return undefined;
  });
  // Assignment positions are sorted independently; references retain original traversal order.
  for (const positions of index.assignments.values()) positions.sort((a,b) => a-b);
  scopes.set(scope.id, index);
  return index;
}

function firstAfter(positions: readonly number[], after: number): number {
  let low = 0, high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle]! <= after) low = middle + 1;
    else high = middle;
  }
  return positions[low] ?? Number.POSITIVE_INFINITY;
}

function referencesAfter(method: JNode, name: string, after: number): JNode[] {
  const index = scopeReferences(method);
  const cutoff = firstAfter(index.assignments.get(name) ?? [], after);
  return (index.refs.get(name) ?? []).filter(n => n.startIndex > after && n.startIndex < cutoff);
}

/**
 * Keys of a mutable map variable built with `new HashMap<>()` and filled by straight-line `put("k", v)`
 * statements in the declaring block before `use`. Any other use (conditional put, putAll, hand-off to
 * another method) makes the keys unknowable.
 */
function mutableMapKeys(decl: JNode, use: JNode): string[] {
  const name = decl.childForFieldName('name')?.text;
  const method = enclosingNamedMethod(decl);
  const declBlock = enclosingBlock(decl);
  if (!name || !method || !declBlock) return STAR;
  const keys: string[] = [];
  for (const ref of referencesAfter(method, name, decl.endIndex)) {
    if (ref.id === use.id) continue;
    const p = ref.parent;
    const isPut = p?.type === 'method_invocation' && p.childForFieldName('object')?.id === ref.id && nameOf(p) === 'put';
    const stmt = isPut ? p!.parent : null;
    if (!isPut || !stmt || stmt.type !== 'expression_statement' || stmt.parent?.id !== declBlock.id || p!.startIndex > use.startIndex) return STAR;
    const k = literalKey(argsOf(p!)[0]);
    if (k === null) return STAR;
    keys.push(k);
  }
  return finishKeys(keys);
}

/** Top-level keys of a map-like input expression; `["*"]` for anything whose keys are not spelled out. */
export function inputKeys(expr: JNode | null, depth = 0): string[] {
  if (!expr || depth > 4) return STAR;
  switch (expr.type) {
    case 'null_literal':
      return [];
    case 'parenthesized_expression':
      return inputKeys(children(expr)[0] ?? null, depth + 1);
    case 'cast_expression':
      return inputKeys(expr.childForFieldName('value'), depth + 1);
    case 'method_invocation': {
      const name = nameOf(expr);
      const obj = expr.childForFieldName('object');
      const args = argsOf(expr);
      if (isMapFactory(obj) && name === 'of') {
        if (args.length % 2 !== 0) return STAR;
        const keys: string[] = [];
        for (let i = 0; i < args.length; i += 2) {
          const k = literalKey(args[i]);
          if (k === null) return STAR;
          keys.push(k);
        }
        return finishKeys(keys);
      }
      if (isMapFactory(obj) && name === 'ofEntries') {
        const keys: string[] = [];
        for (const a of args) {
          const isEntry = a.type === 'method_invocation' && nameOf(a) === 'entry' && (!a.childForFieldName('object') || isMapFactory(a.childForFieldName('object')));
          const k = isEntry ? literalKey(argsOf(a)[0]) : null;
          if (k === null) return STAR;
          keys.push(k);
        }
        return finishKeys(keys);
      }
      if (obj?.text === 'Collections' && name === 'emptyMap' && args.length === 0) return [];
      if (obj?.text === 'Collections' && name === 'singletonMap' && args.length === 2) {
        const k = literalKey(args[0]);
        return k === null ? STAR : [k];
      }
      return STAR;
    }
    case 'object_creation_expression': {
      const m = newMap(expr);
      if (!m.ok) return STAR;
      return m.copy ? inputKeys(m.copy, depth + 1) : [];
    }
    case 'identifier': {
      const v = lookupName(expr.text, expr);
      if (!v || typeof v !== 'object' || 'env' in v) return STAR;
      const m = newMap(v);
      if (m.ok && !m.copy) {
        const decl = v.parent;
        return decl?.type === 'variable_declarator' ? mutableMapKeys(decl, expr) : STAR;
      }
      return inputKeys(v, depth + 1);
    }
    default:
      return STAR;
  }
}

// ---------------------------------------------------------------------------------------------
// Output keys: what the same method reads below the output root of the call's result.

const OUTPUT_GETTERS = new Set(['getOutputs', 'getOutput', 'getOutputData', 'getOutputMap']);
const READ_METHODS = new Set(['get', 'getOrDefault', 'containsKey']);
/** Functional interfaces whose single method returns void: a lambda of this type discards the call's result. */
const VOID_FUNCTIONAL = /^(?:Runnable|CommandLineRunner|ApplicationRunner|Consumer(?:<.*>)?|BiConsumer(?:<.*>)?|\w*Listener|\w*Runner|\w*Callback)$/;
const DISCARD_CONSUMERS = new Set(['forEach', 'forEachOrdered', 'ifPresent', 'ifPresentOrElse', 'peek', 'thenAccept', 'thenRun', 'subscribe', 'execute']);

class Reads {
  whole = false;
  paths = new Set<string>();
  record(path: string[]): void {
    if (path.length === 0) this.whole = true;
    else this.paths.add(path.join('.'));
  }
  result(): string[] {
    return this.whole ? STAR : finishKeys(this.paths);
  }
}

function trackVariable(declarator: JNode, visit: (ref: JNode) => void): void {
  const name = declarator.childForFieldName('name')?.text;
  const method = enclosingNamedMethod(declarator);
  if (!name || !method) return;
  for (const ref of referencesAfter(method, name, declarator.endIndex)) visit(ref);
}

/** The variable a value is bound to: `T x = <node>;` or `x = <node>;`. */
function boundVariable(node: JNode): { declarator: JNode } | { name: string; at: JNode } | null {
  const p = node.parent;
  if (!p) return null;
  if (p.type === 'variable_declarator' && p.childForFieldName('value')?.id === node.id) return { declarator: p };
  if (p.type === 'assignment_expression' && p.childForFieldName('right')?.id === node.id && p.childForFieldName('left')?.type === 'identifier' && p.childForFieldName('operator')?.text === '=') {
    return { name: p.childForFieldName('left')!.text, at: p };
  }
  return null;
}

function trackBound(b: { declarator: JNode } | { name: string; at: JNode }, visit: (ref: JNode) => void): void {
  if ('declarator' in b) return trackVariable(b.declarator, visit);
  const method = enclosingNamedMethod(b.at);
  if (!method) return;
  for (const ref of referencesAfter(method, b.name, b.at.endIndex)) visit(ref);
}

/** Uses of the output root (or a path below it). */
function rootUses(node: JNode, path: string[], reads: Reads, depth: number): void {
  if (depth > 40) return reads.record(path);
  const p = node.parent;
  if (!p) return reads.record(path);
  switch (p.type) {
    case 'parenthesized_expression':
      return rootUses(p, path, reads, depth + 1);
    case 'cast_expression':
      return rootUses(p, path, reads, depth + 1);
    case 'method_invocation': {
      if (p.childForFieldName('object')?.id !== node.id) return reads.record(path);
      const name = nameOf(p);
      if (READ_METHODS.has(name)) {
        const key = literalKey(argsOf(p)[0]);
        if (key !== null) return name === 'containsKey' ? reads.record([...path, key]) : rootUses(p, [...path, key], reads, depth + 1);
      }
      return reads.record(path);
    }
    case 'variable_declarator':
    case 'assignment_expression': {
      const b = boundVariable(node);
      // a path already read below the root is a read, whatever becomes of the value; only the root itself
      // is followed into the variable it was stored in
      if (b && path.length === 0) return trackBound(b, (ref) => rootUses(ref, path, reads, depth + 1));
      return reads.record(path);
    }
    case 'expression_statement':
      return;
    default:
      return reads.record(path);
  }
}

const isEnvelopeGetter = (name: string): boolean => /^(?:get|is)[A-Z]/.test(name) || name === 'toString' || name === 'hashCode' || name === 'equals';

/** Uses of a call's result object itself (the envelope): only the output root matters. */
function resultUses(node: JNode, reads: Reads, depth: number): void {
  if (depth > 40) {
    reads.whole = true;
    return;
  }
  const p = node.parent;
  if (!p) return;
  switch (p.type) {
    case 'parenthesized_expression':
    case 'cast_expression':
      return resultUses(p, reads, depth + 1);
    case 'method_invocation': {
      if (p.childForFieldName('object')?.id !== node.id) {
        reads.whole = true; // passed as an argument of another call
        return;
      }
      const name = nameOf(p);
      if (OUTPUT_GETTERS.has(name)) return rootUses(p, [], reads, depth + 1);
      if (isEnvelopeGetter(name)) return; // getExecutionId, getStatusRaw, getResponse, ...
      reads.whole = true;
      return;
    }
    case 'lambda_expression': {
      // `forEach(x -> call())` drops the value; `supplyAsync(() -> call())` hands it on.
      if (p.childForFieldName('body')?.id !== node.id) return;
      const args = p.parent;
      const outer = args?.type === 'argument_list' ? args.parent : null;
      if (outer?.type === 'method_invocation' && DISCARD_CONSUMERS.has(nameOf(outer))) return;
      // `return args -> call();` from a method typed as a void-returning functional interface drops it
      if (args?.type === 'return_statement') {
        const m = enclosingNamedMethod(args);
        if (m && VOID_FUNCTIONAL.test(m.childForFieldName('type')?.text ?? '')) return;
      }
      reads.whole = true;
      return;
    }
    case 'variable_declarator':
    case 'assignment_expression': {
      const b = boundVariable(node);
      if (b) return trackBound(b, (ref) => resultUses(ref, reads, depth + 1));
      reads.whole = true;
      return;
    }
    case 'expression_statement':
      return;
    default:
      reads.whole = true;
  }
}

/** Output keys read from the result of `call` in the same method. */
export function outputKeys(call: JNode): string[] {
  const reads = new Reads();
  resultUses(call, reads, 0);
  return reads.result();
}
