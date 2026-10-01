/**
 * Managed call sites in TypeScript/JavaScript: callers of a checked-in generated client (swfte.json
 * alias) and calls on the `@swfte/sdk` node client. The generated client's own HTTP call is reported
 * once as an implementation, never as a site. An id that is not a literal (or a same-file constant
 * folding to one) is reported unresolved; it is never guessed.
 */
import ts from 'typescript';
import { GENERATED_MARKER } from '../../../codegen.js';
import { isGeneratedByOtherTool } from '../../walk.js';
import type { DetectContext, DetectedSite, DetectResult, Implementation, LockBinding, Op, SourceFile } from '../../types.js';
import { collectEnvNames, findBinding, isFunctionLike, isTestPath, lineOf, mocksSwfte, resolveId, unwrap } from './common.js';
import { collectImports, isLocalModule, isSdkModule, resolveLocal, type ImportMap } from './imports.js';
import { inputKeysOf, outputKeysOf } from './keys.js';
import { getParsed } from './parse.js';
import { symbolOf } from './symbols.js';

const DETECTOR_ID = 'ts.managed';

type Resource = 'workflows' | 'agents' | 'chatflows';
const KIND: Record<Resource, string> = { workflows: 'workflow', agents: 'agent', chatflows: 'chatflow' };

/** SDK methods that name an artifact in their first argument, and what they do. */
const SDK_OPS: Record<Resource, Record<string, Op>> = {
  workflows: { invoke: 'run', invokeAndWait: 'run', execute: 'run', invokeStream: 'stream', stream: 'stream', getExecutionHistory: 'read-output' },
  agents: { chat: 'chat', chatStream: 'stream', streamChat: 'stream', stream: 'stream' },
  chatflows: { startSession: 'chat', stats: 'read-output', listSessions: 'read-output' },
};
/** SDK methods whose second argument is the artifact input object. */
const INPUT_ARG: Partial<Record<Resource, Set<string>>> = {
  workflows: new Set(['invoke', 'invokeAndWait', 'execute', 'invokeStream', 'stream']),
};

function splitRef(ref: string): { kind: string; id: string } | null {
  const i = ref.indexOf(':');
  return i > 0 && i < ref.length - 1 ? { kind: ref.slice(0, i), id: ref.slice(i + 1) } : null;
}

export function hasGeneratedMarker(text: string): boolean {
  return text.slice(0, 600).includes(GENERATED_MARKER);
}

function siteBase(file: SourceFile, sf: ts.SourceFile, node: ts.Node) {
  return {
    relPath: file.relPath,
    line: lineOf(sf, node),
    symbol: symbolOf(node),
    language: file.language === 'javascript' ? ('javascript' as const) : ('typescript' as const),
    sdk: 'node' as const,
    managed: 'typed-client' as const,
    detector: DETECTOR_ID,
  };
}

// ---------------------------------------------------------------------------------- generated client

function bindingForModule(fromRel: string, spec: string, ctx: DetectContext): LockBinding | null {
  const cands = resolveLocal(fromRel, spec, ctx.lockDir);
  if (!cands.length) return null;
  const strip = (p: string) => p.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  for (const b of ctx.locks) {
    if (b.language !== 'typescript') continue;
    for (const f of b.files) if (cands.includes(strip(f))) return b;
  }
  return null;
}

function typedClientSites(file: SourceFile, sf: ts.SourceFile, imports: ImportMap, ctx: DetectContext, out: DetectedSite[]): void {
  if (!ctx.locks.length) return;
  const byLocal = new Map<string, { b: LockBinding; fn: string }>();
  const byNs = new Map<string, LockBinding>();
  for (const [local, ref] of imports) {
    if (!isLocalModule(ref.module)) continue;
    const b = bindingForModule(file.relPath, ref.module, ctx);
    if (!b) continue;
    if (ref.imported === '*') byNs.set(local, b);
    else if (/^(?:invoke|chat)[A-Z0-9_]/.test(ref.imported)) byLocal.set(local, { b, fn: ref.imported });
  }
  if (!byLocal.size && !byNs.size) return;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      let hit: { b: LockBinding; fn: string } | null = null;
      if (ts.isIdentifier(callee)) {
        const h = byLocal.get(callee.text);
        // a local declaration that shadows the import is not the client
        if (h && findBinding(callee.text, callee)?.kind === 'import') hit = h;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const b = byNs.get(callee.expression.text);
        if (b && /^(?:invoke|chat)[A-Z0-9_]/.test(callee.name.text)) hit = { b, fn: callee.name.text };
      }
      if (hit) {
        const ref = splitRef(hit.b.catalogRef);
        if (ref) {
          out.push({
            ...siteBase(file, sf, n),
            category: 'managed',
            op: hit.fn.startsWith('chat') ? 'chat' : 'run',
            artifact: { kind: ref.kind, id: ref.id, unresolved: false, pinnedVersion: hit.b.pinnedVersion, alias: hit.b.alias },
            contractHash: hit.b.contractHash,
            inputKeys: inputKeysOf(n.arguments[0]),
            outputKeys: outputKeysOf(n),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** The generated client's own `fetch` (reported once, line of the call that performs it). */
function implementationsOf(file: SourceFile, sf: ts.SourceFile, ctx: DetectContext): Implementation[] {
  if (!hasGeneratedMarker(file.text)) return [];
  const strip = (p: string) => p.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const binding = ctx.locks.find((b) => b.language === 'typescript' && b.files.some((f) => strip(f) === strip(file.relPath)));
  const alias = binding?.alias ?? file.relPath.split('/').pop()!.replace(/\.[cm]?[jt]sx?$/, '');
  const impls: Implementation[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const b = findBinding(n.expression.text, n.expression);
      const init = b?.kind === 'const' ? b.init : undefined;
      const viaFetch = n.expression.text === 'fetch' || (init !== undefined && mentionsFetch(init));
      if (viaFetch && n.arguments.length >= 2 && isInsideNamedFunction(n)) impls.push({ relPath: file.relPath, line: lineOf(sf, n), alias });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return impls.slice(0, 1);
}

function isInsideNamedFunction(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (isFunctionLike(p) && ts.isFunctionDeclaration(p)) return true;
  return false;
}

function mentionsFetch(e: ts.Expression): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'fetch' && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) hit = true;
    else if (ts.isPropertyAccessExpression(n) && n.name.text === 'fetch') hit = true;
    if (!hit) ts.forEachChild(n, visit);
  };
  visit(e);
  return hit;
}

// -------------------------------------------------------------------------------------- @swfte/sdk

/** True when `name` was imported from a package that is not @swfte/sdk (a fork, another client). */
function foreignImport(imports: ImportMap, name: string): boolean {
  const ref = imports.get(name);
  return !!ref && !isLocalModule(ref.module) && !isSdkModule(ref.module);
}

function typeNameOf(t: ts.TypeNode | undefined): string | null {
  if (!t) return null;
  if (ts.isTypeReferenceNode(t)) return ts.isIdentifier(t.typeName) ? t.typeName.text : ts.isQualifiedName(t.typeName) && ts.isIdentifier(t.typeName.left) ? t.typeName.left.text : null;
  return null;
}

function classOf(n: ts.Node): ts.ClassLikeDeclaration | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isClassLike(p)) return p;
  return null;
}

/** Whether the receiver expression is (or may be) an @swfte/sdk client and is certainly not a foreign one. */
function receiverOk(root: ts.Expression, imports: ImportMap, depth = 0): boolean {
  if (depth > 6) return true;
  const x = unwrap(root);
  if (ts.isIdentifier(x)) {
    if (foreignImport(imports, x.text)) return false;
    const b = findBinding(x.text, x);
    if (!b) return true;
    if (b.kind === 'param') {
      const fn = b.scope;
      if (isFunctionLike(fn)) {
        const p = fn.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === x.text);
        const tn = typeNameOf(p?.type);
        if (tn && foreignImport(imports, tn)) return false;
      }
      return true;
    }
    if (b.init) {
      const init = unwrap(b.init);
      if (ts.isNewExpression(init) && ts.isIdentifier(init.expression)) return !foreignImport(imports, init.expression.text);
      if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) return receiverOk(init, imports, depth + 1);
    }
    return true;
  }
  if (ts.isPropertyAccessExpression(x) && unwrap(x.expression).kind === ts.SyntaxKind.ThisKeyword) {
    const cls = classOf(x);
    if (!cls) return true;
    for (const m of cls.members) {
      if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === x.name.text) {
        const tn = typeNameOf(m.type);
        if (tn && foreignImport(imports, tn)) return false;
        if (m.initializer && ts.isNewExpression(unwrap(m.initializer))) {
          const ne = unwrap(m.initializer) as ts.NewExpression;
          if (ts.isIdentifier(ne.expression) && foreignImport(imports, ne.expression.text)) return false;
        }
      }
      if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) {
          if (ts.isIdentifier(p.name) && p.name.text === x.name.text) {
            const tn = typeNameOf(p.type);
            if (tn && foreignImport(imports, tn)) return false;
          }
        }
        const visit = (n: ts.Node): boolean => {
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === x.name.text && unwrap(n.left.expression).kind === ts.SyntaxKind.ThisKeyword) {
            const r = unwrap(n.right);
            if (ts.isNewExpression(r) && ts.isIdentifier(r.expression) && foreignImport(imports, r.expression.text)) return true;
          }
          return ts.forEachChild(n, (c) => (visit(c) ? true : undefined)) ?? false;
        };
        if (visit(m)) return false;
      }
    }
    return true;
  }
  if (ts.isPropertyAccessExpression(x)) return receiverOk(x.expression, imports, depth + 1);
  return true;
}

/** `X.<resource>` or an identifier destructured from `X.<resource>` / `X`: the resource and the client root. */
function resourceOf(recv: ts.Expression): { resource: Resource; root: ts.Expression } | null {
  const x = unwrap(recv);
  if (ts.isPropertyAccessExpression(x) && (x.name.text === 'workflows' || x.name.text === 'agents' || x.name.text === 'chatflows')) {
    return { resource: x.name.text as Resource, root: x.expression };
  }
  if (ts.isIdentifier(x)) {
    const b = findBinding(x.text, x);
    if (b?.destructured && b.destructured.path.length === 1) {
      const r = b.destructured.path[0]!;
      if (r === 'workflows' || r === 'agents' || r === 'chatflows') return { resource: r, root: b.destructured.source };
    }
  }
  return null;
}

function sdkSites(file: SourceFile, sf: ts.SourceFile, imports: ImportMap, out: DetectedSite[]): void {
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const rc = resourceOf(callee.expression);
        const op = rc ? SDK_OPS[rc.resource][callee.name.text] : undefined;
        if (rc && op && receiverOk(rc.root, imports)) {
          const r = resolveId(n.arguments[0]);
          const unresolved = r.id === null;
          const name = callee.name.text;
          out.push({
            ...siteBase(file, sf, n),
            category: unresolved ? 'dynamic' : 'managed',
            op,
            artifact: {
              kind: KIND[rc.resource],
              id: r.id,
              unresolved,
              ...(r.envVarName ? { envVarName: r.envVarName } : {}),
              pinnedVersion: null,
              alias: null,
            },
            contractHash: null,
            inputKeys: INPUT_ARG[rc.resource]?.has(name) ? inputKeysOf(n.arguments[1]) : [],
            outputKeys: op === 'read-output' ? [] : outputKeysOf(n),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** Every managed site of a file, resolved or not (the index splits them by category). */
export function managedSites(file: SourceFile, ctx: DetectContext): DetectResult {
  const empty: DetectResult = { sites: [], implementations: [], envVarNames: [] };
  if (isTestPath(file.relPath) || mocksSwfte(file.text) || isGeneratedByOtherTool(file.text)) return empty;
  const sf = getParsed(file);
  const imports = collectImports(sf);
  const sites: DetectedSite[] = [];
  const implementations = implementationsOf(file, sf, ctx);
  if (!hasGeneratedMarker(file.text)) {
    typedClientSites(file, sf, imports, ctx, sites);
    sdkSites(file, sf, imports, sites);
  }
  return { sites, implementations, envVarNames: [...collectEnvNames(sf)] };
}
