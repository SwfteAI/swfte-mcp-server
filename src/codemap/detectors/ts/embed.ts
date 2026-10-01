/**
 * Widget embeds, shared by the TS/JS widget detector and the HTML template detector: the React
 * components and `new SwfteChatWidget({...})` of `@swfte/chat-widget`, `<iframe src=".../chat/<id>">`,
 * and the public agent chat endpoint in an inline script's config. One site per embed element or
 * expression, at the line it starts on. The loader `<script src>` is never the site.
 */
import ts from 'typescript';
import type { DetectedSite, SiteLanguage } from '../../types.js';
import { ID_PATTERN, directEnvName, evalParts, findBinding, lineOf, parseSource, unwrap } from './common.js';
import { collectImports, isLocalModule, isWidgetModule, type ImportMap } from './imports.js';
import { symbolOf } from './symbols.js';

export const COMPONENTS = new Set(['ChatWidget', 'EmbeddedChat']);
export const WIDGET_CLASS = 'SwfteChatWidget';

export interface EmbedContext {
  relPath: string;
  language: SiteLanguage;
  detector: string;
  /** Lines to add to a line inside the parsed text (inline scripts start mid-file). */
  lineOffset: number;
  /** When true only the JS forms (`new SwfteChatWidget`) count: a bare global is accepted (HTML). */
  global: boolean;
}

function site(ctx: EmbedContext, line: number, symbol: string, id: string | null, envVarName?: string): DetectedSite {
  const unresolved = id === null;
  return {
    relPath: ctx.relPath,
    line,
    symbol,
    language: ctx.language,
    category: unresolved ? 'dynamic' : 'widget',
    sdk: 'widget-embed',
    op: 'embed',
    managed: 'typed-client',
    artifact: { kind: 'agent', id, unresolved, ...(envVarName ? { envVarName } : {}), pinnedVersion: null, alias: null },
    contractHash: null,
    inputKeys: [],
    outputKeys: [],
    detector: ctx.detector,
  };
}

function idFromExpr(e: ts.Expression | undefined): { id: string | null; env?: string } {
  if (!e) return { id: null };
  const parts = evalParts(e);
  if (parts.length > 0 && parts.every((p) => p.k === 'lit')) {
    const v = parts.map((p) => (p as { v: string }).v).join('');
    return ID_PATTERN.test(v) ? { id: v } : { id: null };
  }
  const env = directEnvName(e);
  return env ? { id: null, env } : { id: null };
}

function objectProp(o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** A URL string that addresses a hosted Swfte chat page: `https://<host>.swfte.com/chat/<id>`. */
const CHAT_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*swfte\.com\/chat\/([^/?#\s"']*)/i;
/** The public agent chat endpoint of the Swfte API. */
const PUBLIC_ENDPOINT = /^https?:\/\/(?:[a-z0-9-]+\.)*api\.swfte\.com\/[^\s"']*?\/v1\/public\/agents\/([^/?#\s"']*)\/chat(?:[/?#]|$)/i;

function idFromUrlSegment(seg: string): string | null {
  return ID_PATTERN.test(seg) ? seg : null;
}

function isWidgetComponent(tag: ts.JsxTagNameExpression, imports: ImportMap): boolean {
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
    const ns = imports.get(tag.expression.text);
    return !!ns && ns.imported === '*' && isWidgetModule(ns.module) && COMPONENTS.has(tag.name.text);
  }
  if (!ts.isIdentifier(tag)) return false;
  const ref = imports.get(tag.text);
  if (ref) return isWidgetModule(ref.module) && COMPONENTS.has(ref.imported);
  return false;
}

function jsxAttr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  for (const a of el.attributes.properties) if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name) return a;
  return undefined;
}

/** Literal string of a JSX attribute: `attr="x"`, `attr={'x'}`, `attr={CONST}`; anything else is an expression. */
function jsxAttrId(a: ts.JsxAttribute | undefined): { id: string | null; env?: string } {
  if (!a || !a.initializer) return { id: null };
  if (ts.isStringLiteral(a.initializer)) return ID_PATTERN.test(a.initializer.text) ? { id: a.initializer.text } : { id: null };
  if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return idFromExpr(a.initializer.expression);
  return { id: null };
}

/** Attribute names that carry an iframe URL (plain, Thymeleaf, Vue, Angular). */
const SRC_ATTRS = new Set(['src', 'th:src', 'data-th-src', ':src', 'v-bind:src', 'ng-src', '[src]']);
/** A chat page URL anywhere in a template-expression value (`@{https://host/chat/{id}(…)}`). */
const CHAT_URL_LOOSE = /https?:\/\/(?:[a-z0-9-]+\.)*swfte\.com\/chat\/([^/?#\s"'(]*)/i;

function scanIframeText(text: string): Array<{ index: number; id: string | null; host: boolean }> {
  const out: Array<{ index: number; id: string | null; host: boolean }> = [];
  const re = /<iframe\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attr = /([:@[\]\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = attr.exec(m[0]))) {
      const name = (a[1] ?? '').toLowerCase();
      if (!SRC_ATTRS.has(name)) continue;
      const url = a[2] ?? a[3] ?? '';
      const u = name === 'src' ? CHAT_URL.exec(url) : CHAT_URL_LOOSE.exec(url);
      if (u) {
        out.push({ index: m.index, id: idFromUrlSegment(u[1] ?? ''), host: true });
        break;
      }
    }
  }
  return out;
}

export interface TextEmbed {
  /** 0-based newline count before the element. */
  lineDelta: number;
  id: string | null;
}

const blank = (c: string) => c.replace(/[^\n]/g, ' ');

/** Comments of HTML and of the template languages that share `.html` files (Jinja `{# #}`, Django `{% comment %}`). */
export function blankComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\{#[\s\S]*?#\}/g, blank)
    .replace(/\{%-?\s*comment\b[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, blank);
}

/** `<iframe src="https://<host>.swfte.com/chat/<id>">` in markup text; comments are blanked first. */
export function iframeEmbeds(text: string): TextEmbed[] {
  const blanked = blankComments(text);
  return scanIframeText(blanked).map((h) => ({ lineDelta: (blanked.slice(0, h.index).match(/\n/g) ?? []).length, id: h.id }));
}

/** Thymeleaf inline expression with its prototype fallback: computed server-side, so it is a placeholder. */
const THYMELEAF_INLINE = /\/\*\[[[(][\s\S]*?[\])]\]\*\/\s*(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|[\w.-]+)?/g;

/** Inline `<script>` bodies (no `src`) with the 0-based line their text starts on. Comments are blanked first. */
export function inlineScripts(text: string): Array<{ body: string; lineDelta: number }> {
  const blanked = blankComments(text);
  const out: Array<{ body: string; lineDelta: number }> = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked))) {
    if (/\bsrc\s*=/i.test(m[1] ?? '')) continue;
    if (/\btype\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(m[1] ?? '')) continue;
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    out.push({ body: (m[2] ?? '').replace(THYMELEAF_INLINE, (c) => '__TPL__' + c.replace(/[^\n]/g, (ch) => (ch === '\n' ? ch : ''))), lineDelta: (blanked.slice(0, bodyStart).match(/\n/g) ?? []).length });
  }
  return out;
}

/** JS-level embeds of a parsed file: JSX components, `new SwfteChatWidget`, iframe markup in strings and JSX. */
export function jsEmbedSites(sf: ts.SourceFile, ctx: EmbedContext, allowStrings: boolean): DetectedSite[] {
  const imports = collectImports(sf);
  const out: DetectedSite[] = [];
  const at = (n: ts.Node) => lineOf(sf, n) + ctx.lineOffset;
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (isWidgetComponent(n.tagName, imports)) {
        const r = jsxAttrId(jsxAttr(n, 'agentId'));
        out.push(site(ctx, at(n), symbolOf(n), r.id, r.env));
      } else if (ts.isIdentifier(n.tagName) && n.tagName.text === 'iframe') {
        const src = jsxAttr(n, 'src');
        const lit = src?.initializer && ts.isStringLiteral(src.initializer) ? src.initializer.text : src?.initializer && ts.isJsxExpression(src.initializer) && src.initializer.expression ? foldText(src.initializer.expression) : null;
        const u = lit !== null ? CHAT_URL.exec(lit) : null;
        if (u) out.push(site(ctx, at(n), symbolOf(n), idFromUrlSegment(u[1] ?? '')));
      }
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.arguments) {
      const ref = imports.get(n.expression.text);
      const b = findBinding(n.expression.text, n.expression);
      const viaImport = ref && isWidgetModule(ref.module) && ref.imported === WIDGET_CLASS;
      const viaGlobal = ctx.global && n.expression.text === WIDGET_CLASS && !b && !ref;
      if (viaImport || viaGlobal) {
        const cfg = n.arguments[0] && unwrap(n.arguments[0]);
        const r = cfg && ts.isObjectLiteralExpression(cfg) ? idFromExpr(objectProp(cfg, 'agentId')) : { id: null };
        out.push(site(ctx, at(n), symbolOf(n), r.id, r.env));
      }
    } else if (allowStrings && (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || ts.isStringLiteral(n))) {
      const isTemplate = !ts.isStringLiteral(n);
      const raw = ts.isTemplateExpression(n) ? foldText(n) ?? '' : n.text;
      if (raw.includes('<iframe') && !isInsideJsxAttribute(n)) {
        const base = lineOf(sf, n);
        for (const e of iframeEmbeds(raw)) out.push(site(ctx, (isTemplate ? base + e.lineDelta : base) + ctx.lineOffset, symbolOf(n), e.id));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Text of a string-like expression; unknown parts become a NUL so a dynamic id is seen as dynamic. */
function foldText(e: ts.Expression): string | null {
  const parts = evalParts(e);
  return parts.map((p) => (p.k === 'lit' ? p.v : '\u0000')).join('');
}

function isInsideJsxAttribute(n: ts.Node): boolean {
  return ts.isJsxAttribute(n.parent);
}

/** The line of the statement that holds an inline-script config naming the public agent chat endpoint. */
export function endpointConfigSites(sf: ts.SourceFile, ctx: EmbedContext): DetectedSite[] {
  const out: DetectedSite[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const m = PUBLIC_ENDPOINT.exec(n.text);
      if (m && !insideCall(n)) {
        let anchor: ts.Node = n;
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if (ts.isVariableStatement(p)) {
            anchor = p;
            break;
          }
          if (ts.isBlock(p) || ts.isSourceFile(p)) break;
        }
        out.push(site(ctx, lineOf(sf, anchor) + ctx.lineOffset, symbolOf(anchor), idFromUrlSegment(m[1] ?? '')));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The string is an argument of a call (an HTTP call, handled by the raw-http detector), not an inline config. */
function insideCall(n: ts.Node): boolean {
  return ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent);
}

export { parseSource, isLocalModule };
