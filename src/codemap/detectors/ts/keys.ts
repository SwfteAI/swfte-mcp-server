/**
 * Field-name extraction for call sites (FIXTURES 4.1): which keys go in, which come out. Only names
 * ever leave this module (sorted, unique, dotted, at most 64); a value, a literal or a key that is not
 * a plain identifier never becomes one. `["*"]` (decision D8) means "cannot name them".
 */
import ts from 'typescript';
import { enclosingScope, findBinding, isFunctionLike, unwrap } from './common.js';

const KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const MAX_KEYS = 64;
const WILD = ['*'];

/** Result fields that hold the artifact output. */
export const OUTPUT_ROOTS = new Set(['output', 'outputs', 'outputData', 'output_data']);
/** Methods that end a field path: what follows belongs to the value, not to the artifact output. */
const VALUE_MEMBERS = new Set(['length', 'toString', 'toJSON', 'map', 'filter', 'forEach', 'find', 'some', 'every', 'reduce', 'slice', 'join', 'includes', 'indexOf', 'at', 'flatMap', 'concat', 'sort', 'entries', 'keys', 'values', 'trim', 'split', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith', 'substring']);

function finish(keys: Iterable<string>): string[] {
  const all = [...new Set(keys)].filter((k) => k === '*' || /^[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z_$][A-Za-z0-9_$-]*)*$/.test(k));
  if (all.includes('*')) return [...WILD];
  return all.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_KEYS);
}

function objectKeys(o: ts.ObjectLiteralExpression): string[] | null {
  const keys: string[] = [];
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) return null;
    if (ts.isShorthandPropertyAssignment(p)) {
      keys.push(p.name.text);
    } else if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) {
      const n = p.name;
      if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) keys.push(n.text);
      else return null;
    } else return null;
  }
  return keys.every((k) => KEY_PATTERN.test(k)) ? keys : null;
}

interface ScopeReferences {
  refs: Map<string, ts.Identifier[]>;
  assigned: Set<string>;
}
let referenceScopes = new WeakMap<ts.Node, ScopeReferences>();

/** End detector dispatch without keeping source-bearing index values reachable. */
export function releaseKeyAnalysis(): void {
  referenceScopes = new WeakMap();
}

/** Preserve the original full recursive scope walk, but index all names on that walk once. */
function scopeReferences(scope: ts.Node): ScopeReferences {
  const hit = referenceScopes.get(scope);
  if (hit) return hit;
  const index: ScopeReferences = { refs: new Map(), assigned: new Set() };
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(n.left)) index.assigned.add(n.left.text);
    if (ts.isIdentifier(n) && isReference(n)) {
      const refs = index.refs.get(n.text);
      if (refs) refs.push(n);
      else index.refs.set(n.text, [n]);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  referenceScopes.set(scope, index);
  return index;
}

/** Original assignment predicate includes nested scopes; do not change binding authority here. */
function neverReassigned(name: string, scope: ts.Node): boolean {
  return !scopeReferences(scope).assigned.has(name);
}

/** Top-level keys of an input object expression; `["*"]` when they cannot all be named. */
export function inputKeysOf(arg: ts.Expression | undefined): string[] {
  if (!arg) return [];
  const x = unwrap(arg);
  if (ts.isObjectLiteralExpression(x)) {
    const k = objectKeys(x);
    return k ? finish(k) : [...WILD];
  }
  if (ts.isIdentifier(x)) {
    const b = findBinding(x.text, x);
    if (b && (b.kind === 'const' || b.kind === 'let') && b.init && enclosingScope(b.init) === enclosingScope(x) && neverReassigned(x.text, enclosingScope(x))) {
      const init = unwrap(b.init);
      if (ts.isObjectLiteralExpression(init)) {
        const k = objectKeys(init);
        if (k) return finish(k);
      }
    }
  }
  return [...WILD];
}

/** The identifier references of `name` inside `scope` that resolve to `decl`'s binding. */
function referencesOf(name: string, scope: ts.Node, declNode: ts.Node): ts.Identifier[] {
  const home = findBinding(name, declNode);
  if (!home) return [];
  return (scopeReferences(scope).refs.get(name) ?? []).filter(n => {
    if (n === declNode) return false;
    const binding = findBinding(name, n);
    return !!binding && binding.scope === home.scope;
  });
}

function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if ((ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name === id) return false;
  return true;
}

type Level = 'result' | 'output';

interface Walk {
  keys: Set<string>;
  wild: boolean;
  seen: Set<ts.Node>;
}

function escapes(node: ts.Node): boolean {
  const p = node.parent;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) return p.arguments?.includes(node as ts.Expression) ?? false;
  return (
    ts.isReturnStatement(p) ||
    ts.isSpreadElement(p) ||
    ts.isSpreadAssignment(p) ||
    ts.isArrayLiteralExpression(p) ||
    ts.isPropertyAssignment(p) ||
    ts.isShorthandPropertyAssignment(p) ||
    ts.isExportAssignment(p) ||
    ts.isYieldExpression(p) ||
    (ts.isArrowFunction(p) && p.body === node) ||
    ts.isJsxExpression(p)
  );
}

function record(w: Walk, path: string[]): void {
  if (path.length) w.keys.add(path.join('.'));
}

/** Follows a value (the call result, or something derived from it) through the code that reads it. */
function follow(w: Walk, value: ts.Node, level: Level, path: string[]): void {
  let node: ts.Node = value;
  for (;;) {
    const p: ts.Node | undefined = node.parent;
    if (!p) return;
    if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) {
      node = p;
      continue;
    }
    if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken) && p.left === node) {
      node = p;
      continue;
    }
    break;
  }
  const p = node.parent;
  if (!p) return;

  // x.name  /  x?.name
  if (ts.isPropertyAccessExpression(p) && p.expression === node) {
    const name = p.name.text;
    const callee = ts.isCallExpression(p.parent) && p.parent.expression === p;
    if (level === 'result' && callee && name === 'then') {
      // call().then((r) => …): the callback parameter is the result
      const cb = (p.parent as ts.CallExpression).arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) {
        const prm = cb.parameters[0];
        if (ts.isIdentifier(prm.name)) for (const r of referencesOf(prm.name.text, cb, prm.name)) follow(w, r, 'result', []);
        else if (ts.isObjectBindingPattern(prm.name)) destructure(w, prm.name, 'result', [], cb);
      } else w.wild = true;
      return;
    }
    if (level === 'result') {
      if (OUTPUT_ROOTS.has(name) && !callee) return follow(w, p, 'output', []);
      if (callee && name === 'getOutput') return follow(w, p.parent, 'output', []);
      return; // envelope or unknown result field: not artifact output
    }
    if (callee || VALUE_MEMBERS.has(name)) {
      if (path.length === 0 && callee) w.wild = true; // a method on the whole output
      else record(w, path);
      return;
    }
    return follow(w, p, 'output', [...path, name]);
  }
  // x['name'] / x[0]
  if (ts.isElementAccessExpression(p) && p.expression === node) {
    const a = p.argumentExpression;
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) {
      if (level === 'result') {
        if (OUTPUT_ROOTS.has(a.text)) return follow(w, p, 'output', []);
        return;
      }
      if (KEY_PATTERN.test(a.text)) return follow(w, p, 'output', [...path, a.text]);
    }
    if (level === 'output') {
      if (path.length === 0) w.wild = true;
      else record(w, path); // cut at the first computed / index access
    }
    return;
  }
  // const x = <value>
  if (ts.isVariableDeclaration(p) && p.initializer === node) {
    const scope = enclosingScope(p);
    if (ts.isIdentifier(p.name)) {
      if (w.seen.has(p)) return;
      w.seen.add(p);
      const refs = referencesOf(p.name.text, scope, p.name);
      for (const r of refs) follow(w, r, level, path);
      return;
    }
    if (ts.isObjectBindingPattern(p.name)) return destructure(w, p.name, level, path, scope);
    if (level === 'output') path.length ? record(w, path) : (w.wild = true);
    else w.wild = true;
    return;
  }
  // ({ a } = <value>) and other assignments are not modelled
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node) {
    if (level === 'output' && path.length) record(w, path);
    else w.wild = true;
    return;
  }
  if (escapes(node)) {
    if (level === 'output' && path.length) record(w, path);
    else w.wild = true;
    return;
  }
  // a condition, comparison, expression statement or typeof: not an escape
  if (level === 'output' && path.length) record(w, path);
}

function destructure(w: Walk, pattern: ts.ObjectBindingPattern, level: Level, path: string[], scope: ts.Node): void {
  for (const el of pattern.elements) {
    if (el.dotDotDotToken) {
      if (level === 'output' && path.length === 0) w.wild = true;
      else if (level === 'output') record(w, path);
      continue;
    }
    const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : ts.isIdentifier(el.name) ? el.name.text : null;
    if (key === null) {
      if (level === 'output') w.wild = true;
      continue;
    }
    let nextLevel: Level = level;
    let nextPath = path;
    if (level === 'result') {
      if (!OUTPUT_ROOTS.has(key)) continue;
      nextLevel = 'output';
      nextPath = [];
    } else {
      nextPath = [...path, key];
    }
    if (ts.isIdentifier(el.name)) {
      const refs = referencesOf(el.name.text, scope, el.name);
      if (nextLevel === 'output' && nextPath.length) w.keys.add(nextPath.join('.')); // destructuring counts
      if (refs.length === 0 && nextLevel === 'output' && nextPath.length === 0) continue;
      for (const r of refs) follow(w, r, nextLevel, nextPath);
    } else if (ts.isObjectBindingPattern(el.name)) {
      destructure(w, el.name, nextLevel, nextPath, scope);
    } else if (nextLevel === 'output') {
      w.wild = true;
    }
  }
}

/**
 * Dotted output paths read from the result of `call` in the same function. `resultUse` is where the
 * call's value is consumed; callers pass the call expression node itself.
 */
export function outputKeysOf(call: ts.Node): string[] {
  const w: Walk = { keys: new Set(), wild: false, seen: new Set() };
  follow(w, call, 'result', []);
  if (w.wild) return [...WILD];
  return finish(w.keys);
}

export { isFunctionLike };
