/**
 * Shared parsing and scope helpers of the TypeScript/JavaScript detectors. Parsing only (no type
 * checker, no program): a file is one `ts.createSourceFile`, so scanning stays fast and cannot execute
 * or resolve anything on the customer's machine. Nothing here keeps source text beyond the call.
 */
import ts from 'typescript';
import { posix } from 'node:path';
import type { SourceFile } from '../../types.js';

/** Artifact ids as the wire allows them (same pattern as SwfteClientHeader.ID). */
export const ID_PATTERN = /^[A-Za-z0-9_.@:-]{1,128}$/;
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

export function parseSource(relPath: string, text: string, kind?: ts.ScriptKind): ts.SourceFile {
  const ext = posix.extname(relPath).toLowerCase();
  return ts.createSourceFile(relPath, text, ts.ScriptTarget.ES2022, true, kind ?? SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS);
}

/** Test doubles and fixtures are never call sites (the walker does not skip them; decision E5). */
export function isTestPath(relPath: string): boolean {
  const segs = relPath.split('/');
  const base = segs[segs.length - 1] ?? '';
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || /\.(test|spec)\.html?$/.test(base)) return true;
  return segs.slice(0, -1).some((s) => s === '__tests__' || s === '__mocks__' || s === 'tests' || s === 'test' || s === 'e2e' || s === 'cypress');
}

/** A file that replaces a Swfte package with a test double (`vi.mock('@swfte/sdk', …)`, `jest.mock`) is test scaffolding, never a call site. */
export function mocksSwfte(text: string): boolean {
  return /\b(?:vi|jest)\s*\.\s*(?:do)?[mM]ock\s*\(\s*['"`]@swfte\//.test(text);
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Strips parentheses, `as`, `satisfies`, `!` and `<T>` assertions. */
export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
    } else return cur;
  }
}

export function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

export type BindingKind = 'const' | 'let' | 'param' | 'import' | 'loop' | 'decl';

export interface Binding {
  kind: BindingKind;
  /** The initializer of a plain `const x = init` / `let x = init`. */
  init?: ts.Expression;
  /** For `const { a: { b } } = source`: the source and the property path down to this name. */
  destructured?: { source: ts.Expression; path: string[] };
  /** The scope node that owns the binding. */
  scope: ts.Node;
}

function bindingNames(name: ts.BindingName, out: Array<{ id: string; path: string[] | null }>, path: string[] | null): void {
  if (ts.isIdentifier(name)) {
    out.push({ id: name.text, path });
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : ts.isIdentifier(el.name) ? el.name.text : null;
      if (el.dotDotDotToken || key === null) bindingNames(el.name, out, null);
      else bindingNames(el.name, out, path === null ? null : [...path, key]);
    }
    return;
  }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out, null);
}

const scopeCache = new WeakMap<ts.Node, Map<string, Binding>>();

function declareVars(list: ts.VariableDeclarationList, scope: ts.Node, map: Map<string, Binding>): void {
  const flags = list.flags & ts.NodeFlags.BlockScoped;
  const kind: BindingKind = flags & ts.NodeFlags.Const ? 'const' : 'let';
  for (const d of list.declarations) {
    const names: Array<{ id: string; path: string[] | null }> = [];
    bindingNames(d.name, names, []);
    for (const { id, path } of names) {
      if (ts.isIdentifier(d.name)) map.set(id, { kind, init: d.initializer, scope });
      else if (path && d.initializer) map.set(id, { kind, destructured: { source: d.initializer, path }, scope });
      else map.set(id, { kind: 'decl', scope });
    }
  }
}

/** The names a scope node declares directly (function parameters, block statements, loop heads). */
export function scopeBindings(node: ts.Node): Map<string, Binding> | null {
  const hit = scopeCache.get(node);
  if (hit) return hit;
  let map: Map<string, Binding> | null = null;
  if (isFunctionLike(node)) {
    map = new Map();
    for (const p of node.parameters) {
      const names: Array<{ id: string; path: string[] | null }> = [];
      bindingNames(p.name, names, null);
      for (const n of names) map.set(n.id, { kind: 'param', scope: node });
    }
  } else if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    map = new Map();
    for (const st of node.statements) {
      if (ts.isVariableStatement(st)) declareVars(st.declarationList, node, map);
      else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) map.set(st.name.text, { kind: 'decl', scope: node });
      else if (ts.isImportDeclaration(st) && st.importClause) {
        const c = st.importClause;
        if (c.name) map.set(c.name.text, { kind: 'import', scope: node });
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) map.set(c.namedBindings.name.text, { kind: 'import', scope: node });
          else for (const el of c.namedBindings.elements) map.set(el.name.text, { kind: 'import', scope: node });
        }
      }
    }
  } else if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    map = new Map();
    const names: Array<{ id: string; path: string[] | null }> = [];
    for (const d of node.initializer.declarations) bindingNames(d.name, names, null);
    for (const n of names) map.set(n.id, { kind: 'loop', scope: node });
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    map = new Map();
    const names: Array<{ id: string; path: string[] | null }> = [];
    bindingNames(node.variableDeclaration.name, names, null);
    for (const n of names) map.set(n.id, { kind: 'param', scope: node });
  }
  if (map) scopeCache.set(node, map);
  return map;
}

/** The nearest declaration of `name` visible from `from` (lexical scope chain), or null (global). */
export function findBinding(name: string, from: ts.Node): Binding | null {
  for (let n: ts.Node | undefined = from; n; n = n.parent) {
    const m = scopeBindings(n);
    const b = m?.get(name);
    if (b) return b;
  }
  return null;
}

/** The function-like (or source file) whose body holds `node`; the "same function" of the labelling rules. */
export function enclosingScope(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (isFunctionLike(n) || ts.isSourceFile(n)) return n;
  }
  return node.getSourceFile();
}

export type Part = { k: 'lit'; v: string } | { k: 'env'; name: string } | { k: 'dyn' };

/** `process.env.X`, `process.env['X']`, `import.meta.env.X`, `Deno.env.get('X')`: the variable NAME, else null. */
export function envNameOf(e: ts.Expression): string | null {
  const x = unwrap(e);
  let name: string | null = null;
  if (ts.isPropertyAccessExpression(x)) {
    if (isEnvObject(x.expression)) name = x.name.text;
  } else if (ts.isElementAccessExpression(x)) {
    const arg = x.argumentExpression;
    if (isEnvObject(x.expression) && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) name = arg.text;
  } else if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'get' && isDenoEnv(x.expression.expression)) {
    const arg = x.arguments[0];
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) name = arg.text;
  }
  return name !== null && ENV_NAME_PATTERN.test(name) ? name : null;
}

function isDenoEnv(e: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(e) && e.name.text === 'env' && ts.isIdentifier(e.expression) && e.expression.text === 'Deno';
}

function isEnvObject(e: ts.Expression): boolean {
  const x = unwrap(e);
  if (!ts.isPropertyAccessExpression(x) || x.name.text !== 'env') return false;
  const o = unwrap(x.expression);
  if (ts.isIdentifier(o) && o.text === 'process') return true;
  return ts.isMetaProperty(o) && o.keywordToken === ts.SyntaxKind.ImportKeyword;
}

/** `process.env.X` as an expression, directly or as the left side of `??` / `||`. The one place an env NAME is taken. */
export function directEnvName(e: ts.Expression): string | null {
  const x = unwrap(e);
  if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return directEnvName(x.left);
  if (ts.isTemplateExpression(x) && x.head.text === '' && x.templateSpans.length === 1 && x.templateSpans[0]!.literal.text === '') return directEnvName(x.templateSpans[0]!.expression);
  return envNameOf(x);
}

const MAX_EVAL_DEPTH = 8;

/**
 * Folds an expression into string parts: literals, env names, and unknowns. Constants fold only within
 * the file (`const` with an initializer); a parameter, import, loop variable or property is unknown.
 */
export function evalParts(e: ts.Expression, depth = 0, seen: Set<ts.Node> = new Set()): Part[] {
  if (depth > MAX_EVAL_DEPTH) return [{ k: 'dyn' }];
  const x = unwrap(e);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return [{ k: 'lit', v: x.text }];
  if (ts.isTemplateExpression(x)) {
    const out: Part[] = [{ k: 'lit', v: x.head.text }];
    for (const s of x.templateSpans) {
      out.push(...evalParts(s.expression, depth + 1, seen), { k: 'lit', v: s.literal.text });
    }
    return out;
  }
  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return [...evalParts(x.left, depth + 1, seen), ...evalParts(x.right, depth + 1, seen)];
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      const left = evalParts(x.left, depth + 1, seen);
      // A default never replaces a value that comes from outside the file: the left side decides.
      return left;
    }
    return [{ k: 'dyn' }];
  }
  const env = envNameOf(x);
  if (env !== null) return [{ k: 'env', name: env }];
  if (ts.isIdentifier(x)) {
    const b = findBinding(x.text, x);
    if (b && b.kind === 'const' && b.init && !seen.has(b.init)) {
      const next = new Set(seen).add(b.init);
      return evalParts(b.init, depth + 1, next);
    }
    return [{ k: 'dyn' }];
  }
  if (ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === 'URL' && x.arguments?.length) {
    const [p, base] = x.arguments;
    return base ? [...evalParts(base, depth + 1, seen), ...evalParts(p!, depth + 1, seen)] : evalParts(p!, depth + 1, seen);
  }
  if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && (x.expression.text === 'String' || x.expression.text === 'encodeURIComponent') && x.arguments.length === 1) {
    return evalParts(x.arguments[0]!, depth + 1, seen);
  }
  if (ts.isPropertyAccessExpression(x) && (x.name.text === 'href' || x.name.text === 'origin')) return evalParts(x.expression, depth + 1, seen);
  if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'toString' && x.arguments.length === 0) {
    return evalParts(x.expression.expression, depth + 1, seen);
  }
  return [{ k: 'dyn' }];
}

export interface ResolvedId {
  id: string | null;
  envVarName?: string;
}

/**
 * The artifact id an argument names. A string (or a same-file `const` folding to one) resolves; anything
 * else is unresolved, and only a direct `process.env.X` argument records the variable NAME. Never guessed.
 */
export function resolveId(e: ts.Expression | undefined): ResolvedId {
  if (!e) return { id: null };
  const parts = evalParts(e);
  if (parts.length > 0 && parts.every((p) => p.k === 'lit')) {
    const v = parts.map((p) => (p as { v: string }).v).join('');
    if (ID_PATTERN.test(v)) return { id: v };
    return { id: null };
  }
  const env = directEnvName(e);
  return env !== null ? { id: null, envVarName: env } : { id: null };
}

/** Collects `process.env.NAME` style names that mention SWFTE (names only). */
export function collectEnvNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) {
      const name = envNameOf(n as ts.Expression);
      if (name !== null && name.includes('SWFTE')) out.add(name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
