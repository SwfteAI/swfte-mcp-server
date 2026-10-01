/**
 * Import bookkeeping for the TS/JS detectors: which local name came from which module. ES imports,
 * `require()` and awaited dynamic `import()` are read; type-only imports are not (they cannot be called).
 */
import ts from 'typescript';
import { posix } from 'node:path';
import { unwrap } from './common.js';

export interface ImportRef {
  module: string;
  /** Exported name, `default`, or `*` for a namespace. */
  imported: string;
}

export type ImportMap = Map<string, ImportRef>;

function specOf(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  const x = unwrap(e);
  return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;
}

/** `require('m')` / `await import('m')` / `(await import('m')).default`: the module, else null. */
function moduleOfInit(init: ts.Expression): string | null {
  let x = unwrap(init);
  if (ts.isAwaitExpression(x)) x = unwrap(x.expression);
  if (ts.isCallExpression(x)) {
    const callee = x.expression;
    if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) return specOf(x.arguments[0]);
  }
  return null;
}

export function collectImports(sf: ts.SourceFile): ImportMap {
  const map: ImportMap = new Map();
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && n.importClause && !n.importClause.isTypeOnly) {
      const m = specOf(n.moduleSpecifier);
      const c = n.importClause;
      if (m !== null) {
        if (c.name) map.set(c.name.text, { module: m, imported: 'default' });
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) map.set(c.namedBindings.name.text, { module: m, imported: '*' });
          else
            for (const el of c.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              map.set(el.name.text, { module: m, imported: (el.propertyName ?? el.name).text });
            }
        }
      }
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const m = specOf(n.moduleReference.expression);
      if (m !== null) map.set(n.name.text, { module: m, imported: '*' });
    } else if (ts.isVariableDeclaration(n) && n.initializer) {
      const inner = unwrap(n.initializer);
      const m = moduleOfInit(n.initializer);
      if (m !== null) {
        if (ts.isIdentifier(n.name)) map.set(n.name.text, { module: m, imported: '*' });
        else if (ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (!ts.isIdentifier(el.name) || el.dotDotDotToken) continue;
            const key = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : el.name.text;
            map.set(el.name.text, { module: m, imported: key });
          }
        }
      } else if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(n.name)) {
        // const X = require('m').default
        const base = moduleOfInit(inner.expression);
        if (base !== null) map.set(n.name.text, { module: base, imported: inner.name.text });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

export const SDK_MODULE = '@swfte/sdk';
export const WIDGET_MODULE = '@swfte/chat-widget';

export function isLocalModule(m: string): boolean {
  return m.startsWith('.') || m.startsWith('@/') || m.startsWith('~/') || m.startsWith('#') || m.startsWith('/');
}

export function isSdkModule(m: string): boolean {
  return m === SDK_MODULE || m.startsWith(`${SDK_MODULE}/`);
}

export function isWidgetModule(m: string): boolean {
  return m === WIDGET_MODULE || m.startsWith(`${WIDGET_MODULE}/`);
}

const EXT = /\.(?:[cm]?[jt]sx?)$/;

/** The scan-root-relative path (extension stripped) a relative or alias specifier points at; candidates only. */
export function resolveLocal(fromRel: string, spec: string, lockDir: string | null): string[] {
  const strip = (p: string) => p.replace(EXT, '');
  const out: string[] = [];
  if (spec.startsWith('.')) {
    out.push(strip(posix.normalize(posix.join(posix.dirname(fromRel), spec))));
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const rest = strip(spec.slice(2));
    out.push(`src/${rest}`, rest);
    if (lockDir) out.push(posix.join(lockDir, 'src', rest), posix.join(lockDir, rest));
    // the package that holds the importing file
    const segs = fromRel.split('/');
    for (let i = segs.length - 1; i > 0; i--) out.push(posix.join(segs.slice(0, i).join('/'), 'src', rest));
  }
  return out.map((p) => posix.normalize(p).replace(/^\.\//, ''));
}
