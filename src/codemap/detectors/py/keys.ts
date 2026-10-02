/**
 * Input and output key extraction for Python call sites (docs/codemap/FIXTURES.md §4.1). Names only:
 * dictionary keys and dotted access paths, never a value. `["*"]` says the keys could not be named.
 */
import { children, enclosingScope, evalPieces, literalOf, lookupName, plainString, walk, type PyNode } from './parse.js';

const MAX_KEYS = 64;
const STAR = ['*'];

export const finishKeys = (keys: Iterable<string>): string[] => [...new Set(keys)].sort().slice(0, MAX_KEYS);

/** Top-level keys of a dict-like input expression; `["*"]` for spread, parameter or anything else. */
export function inputKeys(expr: PyNode | null, depth = 0): string[] {
  if (!expr || depth > 4) return STAR;
  switch (expr.type) {
    case 'parenthesized_expression': {
      const inner = children(expr)[0];
      return inputKeys(inner ?? null, depth + 1);
    }
    case 'dictionary': {
      const keys: string[] = [];
      for (const c of children(expr)) {
        if (c.type !== 'pair') return STAR;
        const k = c.childForFieldName('key');
        const s = k?.type === 'string' ? literalOf(evalPieces(k)) : null;
        if (s === null || s === undefined) return STAR;
        keys.push(s);
      }
      return finishKeys(keys);
    }
    case 'call': {
      const f = expr.childForFieldName('function');
      if (f?.text !== 'dict') return STAR;
      const args = expr.childForFieldName('arguments');
      const keys: string[] = [];
      for (const a of args ? children(args) : []) {
        if (a.type !== 'keyword_argument') return STAR;
        const nm = a.childForFieldName('name');
        if (!nm) return STAR;
        keys.push(nm.text);
      }
      return finishKeys(keys);
    }
    case 'identifier': {
      const v = lookupName(expr.text, expr);
      return v && v !== 'opaque' ? inputKeys(v, depth + 1) : STAR;
    }
    default:
      return STAR;
  }
}

// ---------------------------------------------------------------------------------------------
// Output keys: what the same function reads below the output root of the call's result.

const OUTPUT_ATTRS = new Set(['output', 'outputs', 'output_data', 'outputData']);

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

const literalKey = (n: PyNode | null): string | null => (n && n.type === 'string' ? plainString(n) : null);

/** The names in a function scope that refer to a variable (excludes attribute names, kwargs, targets). */
interface ScopeReferences {
  refs: Map<string, PyNode[]>;
  assignments: Map<string, number[]>;
}
let referenceTrees = new WeakMap<PyNode['tree'], Map<number, ScopeReferences>>();

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
function scopeReferences(scope: PyNode): ScopeReferences {
  let scopes = referenceTrees.get(scope.tree);
  if (!scopes) { scopes = new Map(); referenceTrees.set(scope.tree, scopes); }
  const hit = scopes.get(scope.id);
  if (hit) return hit;
  const index: ScopeReferences = { refs: new Map(), assignments: new Map() };
  walk(scope, n => {
    if (n.type === 'assignment') {
      const left = n.childForFieldName('left');
      if (left?.type === 'identifier') add(index.assignments, left.text, n.startIndex);
    }
    if (n.type !== 'identifier') return undefined;
    const p = n.parent;
    if (!p) return undefined;
    if (p.type === 'attribute' && p.childForFieldName('attribute')?.id === n.id) return undefined;
    if (p.type === 'keyword_argument' && p.childForFieldName('name')?.id === n.id) return undefined;
    if (p.type === 'assignment' && p.childForFieldName('left')?.id === n.id) return undefined;
    if ((p.type === 'function_definition' || p.type === 'class_definition') && p.childForFieldName('name')?.id === n.id) return undefined;
    if (p.type === 'parameters' || p.type === 'default_parameter' || p.type === 'typed_parameter') return undefined;
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

function referencesAfter(scope: PyNode, name: string, after: number): PyNode[] {
  const index = scopeReferences(scope);
  const cutoff = firstAfter(index.assignments.get(name) ?? [], after);
  return (index.refs.get(name) ?? []).filter(n => n.startIndex > after && n.startIndex < cutoff);
}

function trackVariable(name: string, from: PyNode, visit: (ref: PyNode) => void): void {
  const scope = enclosingScope(from);
  if (!scope) return;
  for (const ref of referencesAfter(scope, name, from.endIndex)) visit(ref);
}

const IGNORED_USES = new Set(['expression_statement', 'comparison_operator', 'not_operator', 'boolean_operator', 'if_statement', 'elif_clause', 'while_statement', 'assert_statement']);

/** Uses of the output root (or a path below it). */
function rootUses(node: PyNode, path: string[], reads: Reads, depth: number): void {
  if (depth > 40) return reads.record(path);
  const p = node.parent;
  if (!p) return reads.record(path);
  switch (p.type) {
    case 'parenthesized_expression':
    case 'await':
      return rootUses(p, path, reads, depth + 1);
    case 'subscript': {
      if (p.childForFieldName('value')?.id !== node.id) return reads.record(path);
      const key = literalKey(p.childForFieldName('subscript'));
      if (key === null) return reads.record(path);
      return rootUses(p, [...path, key], reads, depth + 1);
    }
    case 'attribute': {
      if (p.childForFieldName('object')?.id !== node.id) return reads.record(path);
      const attr = p.childForFieldName('attribute')?.text ?? '';
      const call = p.parent;
      if (attr === 'get' && call?.type === 'call' && call.childForFieldName('function')?.id === p.id) {
        const args = call.childForFieldName('arguments');
        const first = args ? children(args)[0] : undefined;
        const key = literalKey(first ?? null);
        if (key !== null) return rootUses(call, [...path, key], reads, depth + 1);
      }
      return reads.record(path);
    }
    case 'assignment': {
      const left = p.childForFieldName('left');
      // a path already read below the root is a read, whatever becomes of the value; only the root itself
      // is followed into the variable it was stored in
      if (path.length === 0 && p.childForFieldName('right')?.id === node.id && left?.type === 'identifier') {
        trackVariable(left.text, p, (ref) => rootUses(ref, path, reads, depth + 1));
        return;
      }
      return reads.record(path);
    }
    default:
      if (IGNORED_USES.has(p.type)) return;
      return reads.record(path);
  }
}

/** Uses of a call's result object itself (the envelope): only the output root matters. */
function resultUses(node: PyNode, reads: Reads, depth: number): void {
  if (depth > 40) {
    reads.whole = true;
    return;
  }
  const p = node.parent;
  if (!p) return;
  switch (p.type) {
    case 'parenthesized_expression':
    case 'await':
      return resultUses(p, reads, depth + 1);
    case 'lambda': {
      // asyncio.to_thread(lambda: call()) hands the value straight back to the awaiter.
      const arglist = p.parent;
      const outer = arglist?.parent;
      const fn = outer?.type === 'call' ? outer.childForFieldName('function')?.text ?? '' : '';
      if (arglist?.type === 'argument_list' && outer && /(?:^|\.)(?:to_thread|run_in_executor)$/.test(fn)) return resultUses(outer, reads, depth + 1);
      reads.whole = true;
      return;
    }
    case 'attribute': {
      if (p.childForFieldName('object')?.id !== node.id) {
        reads.whole = true;
        return;
      }
      const attr = p.childForFieldName('attribute')?.text ?? '';
      const call = p.parent;
      if (attr === 'get' && call?.type === 'call' && call.childForFieldName('function')?.id === p.id) {
        const args = call.childForFieldName('arguments');
        const key = literalKey((args ? children(args)[0] : undefined) ?? null);
        if (key !== null && OUTPUT_ATTRS.has(key)) return rootUses(call, [], reads, depth + 1);
        return; // envelope field
      }
      if (OUTPUT_ATTRS.has(attr)) return rootUses(p, [], reads, depth + 1);
      return; // execution_id, status_raw, response, ... are envelope fields
    }
    case 'subscript': {
      if (p.childForFieldName('value')?.id !== node.id) {
        reads.whole = true;
        return;
      }
      const key = literalKey(p.childForFieldName('subscript'));
      if (key === null) {
        reads.whole = true;
        return;
      }
      if (OUTPUT_ATTRS.has(key)) return rootUses(p, [], reads, depth + 1);
      if (key === 'raw') reads.whole = true;
      return; // ok, status, execution_id, reply
    }
    case 'assignment': {
      const left = p.childForFieldName('left');
      if (p.childForFieldName('right')?.id === node.id && left?.type === 'identifier') {
        trackVariable(left.text, p, (ref) => resultUses(ref, reads, depth + 1));
        return;
      }
      reads.whole = true;
      return;
    }
    default:
      if (IGNORED_USES.has(p.type)) return;
      reads.whole = true;
  }
}

/** Output keys read from the result of `call` in the same function. */
export function outputKeys(call: PyNode): string[] {
  const reads = new Reads();
  resultUses(call, reads, 0);
  return reads.result();
}
