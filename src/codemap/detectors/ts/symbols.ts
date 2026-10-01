/**
 * The symbol of a node (CONTRACT 2.1, decision D2): the nearest NAMED enclosing symbol. Anonymous
 * functions, arrow callbacks and function expressions contribute nothing, so a call inside
 * `items.map((x) => call())` inside `function save()` has the symbol `save`.
 *
 *   function f()                 -> f
 *   const f = () => …            -> f
 *   class C { m() {} }           -> C.m          (constructor -> C.constructor)
 *   const o = { k() {}, j: () => … } -> o.k, o.j
 *   export default function () {}    -> default
 *   module top level             -> <module>
 */
import ts from 'typescript';
import { isFunctionLike } from './common.js';

const SYMBOL_PATTERN = /^[A-Za-z0-9_$.<>#:-]{1,128}$/;

function nameText(n: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text.replace(/^#/, '');
  return null;
}

function className(c: ts.ClassLikeDeclaration): string {
  if (c.name) return c.name.text;
  const p = c.parent;
  if (ts.isVariableDeclaration(p)) return nameText(p.name) ?? 'default';
  return 'default';
}

function objectName(o: ts.ObjectLiteralExpression): string | null {
  let p: ts.Node = o.parent;
  while (ts.isAsExpression(p) || ts.isParenthesizedExpression(p) || ts.isSatisfiesExpression(p)) p = p.parent;
  if (ts.isVariableDeclaration(p)) return nameText(p.name);
  if (ts.isExportAssignment(p)) return 'default';
  return null;
}

/** The symbol one function-like contributes, or null when it is anonymous. */
function nameOfFunction(fn: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn)) {
    if (fn.name) return fn.name.text;
    return fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : null;
  }
  if (ts.isConstructorDeclaration(fn)) return ts.isClassLike(fn.parent) ? `${className(fn.parent)}.constructor` : 'constructor';
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
    const key = nameText(fn.name);
    if (!key) return null;
    if (ts.isClassLike(fn.parent)) return `${className(fn.parent)}.${key}`;
    if (ts.isObjectLiteralExpression(fn.parent)) {
      const o = objectName(fn.parent);
      return o ? `${o}.${key}` : key;
    }
    return key;
  }
  // function expression / arrow: named by what it is assigned to, else anonymous
  if (ts.isFunctionExpression(fn) && fn.name) return fn.name.text;
  let p: ts.Node = fn.parent;
  while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p)) p = p.parent;
  if (ts.isVariableDeclaration(p) && p.initializer && p.initializer.pos <= fn.pos) return nameText(p.name);
  if (ts.isPropertyAssignment(p)) {
    const key = nameText(p.name);
    if (!key) return null;
    if (ts.isObjectLiteralExpression(p.parent)) {
      const o = objectName(p.parent);
      return o ? `${o}.${key}` : key;
    }
    return key;
  }
  if (ts.isPropertyDeclaration(p)) {
    const key = nameText(p.name);
    if (!key) return null;
    return ts.isClassLike(p.parent) ? `${className(p.parent)}.${key}` : key;
  }
  if (ts.isExportAssignment(p)) return 'default';
  return null;
}

export function symbolOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (isFunctionLike(n)) {
      const name = nameOfFunction(n);
      if (name && SYMBOL_PATTERN.test(name)) return name;
      continue;
    }
    // Class field initialisers and static blocks run in the class, not the module.
    if (ts.isPropertyDeclaration(n) && ts.isClassLike(n.parent)) {
      const key = nameText(n.name);
      if (key && n.initializer && !isFunctionLike(n.initializer)) {
        const s = `${className(n.parent)}.${key}`;
        if (SYMBOL_PATTERN.test(s)) return s;
      }
    }
  }
  return '<module>';
}
