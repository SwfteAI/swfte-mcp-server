/**
 * Typed client generation from a catalog contract.
 *
 * Input is the contract's JSON Schemas plus its invoke block; output is one
 * self-contained source file (TypeScript or Python) with no dependencies beyond
 * the language runtime — `fetch` on Node 18+, `urllib` in Python — so baking an
 * artifact into a codebase adds a file, not a package.
 *
 * Schemas come from a server that derives them from real graphs, so they are
 * frequently partial: empty, untyped, `$ref`-bearing, keyed by names that are
 * not identifiers. Every such case degrades to the honest loose type
 * (`unknown` / `Any`) rather than to a guess, and anything copied from the
 * contract into source (names, descriptions, enum values) is escaped so a
 * crafted description cannot close a comment or a string and inject code.
 *
 * Generated files are deterministic for a given contract (no timestamps), so
 * re-scaffolding an unchanged contract is a no-op instead of an overwrite.
 */
import { createHash } from 'node:crypto';
import type { CatalogContract, JsonSchema } from './catalog.js';
import { PACKAGE_VERSION } from './version.js';

const MAX_DEPTH = 8;

type S = JsonSchema | boolean | undefined;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** True when a schema constrains nothing — `{}`, `true`, missing, or only annotations. */
export function isUntyped(schema: S): boolean {
  if (schema === undefined || schema === true) return true;
  if (!isObj(schema)) return false;
  const shaping = ['type', 'properties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', '$ref', 'additionalProperties'];
  return !shaping.some((k) => k in schema);
}

function typesOf(schema: Record<string, unknown>): string[] {
  const t = schema.type;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  if (typeof t === 'string') return [t];
  if (isObj(schema.properties)) return ['object'];
  if ('items' in schema) return ['array'];
  return [];
}

/* ── naming ──────────────────────────────────────────────────────────────── */

const words = (s: string) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

export function pascal(s: string, fallback = 'Artifact'): string {
  const out = words(s)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('');
  const safe = out || fallback;
  return /^[0-9]/.test(safe) ? `${fallback}${safe}` : safe.slice(0, 60);
}

export function snake(s: string, fallback = 'artifact'): string {
  const out = words(s)
    .map((w) => w.toLowerCase())
    .join('_');
  const safe = out || fallback;
  return (/^[0-9]/.test(safe) ? `${fallback}_${safe}` : safe).slice(0, 60);
}

export function kebab(s: string, fallback = 'artifact'): string {
  return snake(s, fallback).replace(/_/g, '-');
}

const TS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const tsKey = (k: string) => (TS_IDENT.test(k) ? k : JSON.stringify(k));

/** Text safe inside a block comment. */
// U+2028/U+2029 end a `//` comment in JavaScript, so they are line breaks here too.
const tsComment = (s: unknown) => String(s ?? '').replace(/\*\//g, '*\\/').replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 300);
/** Text safe inside a `#` line comment. */
const pyComment = (s: unknown) => String(s ?? '').replace(/[\r\n\u2028\u2029\f\v]+/g, ' ').slice(0, 300);

/* ── TypeScript ──────────────────────────────────────────────────────────── */

function tsLiteral(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return typeof v === 'number' && !Number.isFinite(v) ? 'number' : JSON.stringify(v);
  }
  return 'unknown';
}

const union = (parts: string[]) => {
  const uniq = [...new Set(parts)];
  if (uniq.includes('unknown')) return 'unknown';
  return uniq.length ? uniq.join(' | ') : 'never';
};

export function tsType(schema: S, depth = 0, indent = ''): string {
  if (schema === false) return 'never';
  if (depth > MAX_DEPTH || isUntyped(schema) || !isObj(schema)) return 'unknown';
  const nullable = schema.nullable === true ? ' | null' : '';
  if ('$ref' in schema) return 'unknown';
  if ('const' in schema) return tsLiteral(schema.const) + nullable;
  if (Array.isArray(schema.enum)) return union(schema.enum.map(tsLiteral)) + nullable;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const alts = schema[key];
    if (Array.isArray(alts) && alts.length) return `(${union(alts.map((a) => tsType(a as S, depth + 1, indent)))})${nullable}`;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const parts = schema.allOf.map((a) => tsType(a as S, depth + 1, indent)).filter((p) => p !== 'unknown');
    return (parts.length ? `(${parts.join(' & ')})` : 'unknown') + nullable;
  }
  const types = typesOf(schema);
  if (!types.length) return 'unknown';
  return union(types.map((t) => tsSingle(t, schema, depth, indent))) + nullable;
}

function tsSingle(t: string, schema: Record<string, unknown>, depth: number, indent: string): string {
  switch (t) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = schema.items;
      if (Array.isArray(items)) return `[${items.map((i) => tsType(i as S, depth + 1, indent)).join(', ')}]`;
      return `Array<${tsType(items as S, depth + 1, indent)}>`;
    }
    case 'object':
      return tsObject(schema, depth, indent);
    default:
      return 'unknown';
  }
}

function tsObject(schema: Record<string, unknown>, depth: number, indent: string): string {
  const props = isObj(schema.properties) ? schema.properties : {};
  const keys = Object.keys(props);
  const addl = schema.additionalProperties;
  if (!keys.length) {
    if (addl === false) return 'Record<string, never>';
    if (isObj(addl) && !isUntyped(addl)) return `Record<string, ${tsType(addl, depth + 1, indent)}>`;
    return 'Record<string, unknown>';
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const inner = `${indent}  `;
  const lines = keys.map((k) => {
    const p = props[k] as S;
    const doc = isObj(p) && (p.description || p.title) ? `${inner}/** ${tsComment(p.description ?? p.title)} */\n` : '';
    return `${doc}${inner}${tsKey(k)}${required.has(k) ? '' : '?'}: ${tsType(p, depth + 1, inner)};`;
  });
  if (addl !== false) lines.push(`${inner}[key: string]: unknown;`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/* ── Python ──────────────────────────────────────────────────────────────── */

const PY_KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ')
);

function pyLiteral(v: unknown): string | null {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  // A JSON string literal is a valid Python string literal.
  if (typeof v === 'string') return JSON.stringify(v);
  return null;
}

export class PyTypes {
  readonly defs: string[] = [];
  private readonly used = new Set<string>();

  name(hint: string): string {
    let base = pascal(hint, 'Model');
    if (PY_KEYWORDS.has(base)) base = `${base}_`;
    let n = base;
    let i = 2;
    while (this.used.has(n)) n = `${base}${i++}`;
    this.used.add(n);
    return n;
  }

  type(schema: S, hint: string, depth = 0): string {
    if (schema === false) return 'Any';
    if (depth > MAX_DEPTH || isUntyped(schema) || !isObj(schema)) return 'Any';
    const wrap = (t: string) => (schema.nullable === true && t !== 'Any' ? `Optional[${t}]` : t);
    if ('$ref' in schema) return 'Any';
    if ('const' in schema) {
      const l = pyLiteral(schema.const);
      return wrap(l ? `Literal[${l}]` : 'Any');
    }
    if (Array.isArray(schema.enum)) {
      const lits = schema.enum.map(pyLiteral);
      return wrap(lits.every((l) => l !== null) && lits.length ? `Literal[${lits.join(', ')}]` : 'Any');
    }
    for (const key of ['anyOf', 'oneOf'] as const) {
      const alts = schema[key];
      if (Array.isArray(alts) && alts.length) {
        const parts = [...new Set(alts.map((a, i) => this.type(a as S, `${hint}Option${i + 1}`, depth + 1)))];
        return wrap(parts.includes('Any') ? 'Any' : parts.length === 1 ? parts[0]! : `Union[${parts.join(', ')}]`);
      }
    }
    if (Array.isArray(schema.allOf)) return 'Dict[str, Any]';
    const types = typesOf(schema);
    if (!types.length) return 'Any';
    const parts = [...new Set(types.map((t) => this.single(t, schema, hint, depth)))];
    if (parts.includes('Any')) return 'Any';
    return wrap(parts.length === 1 ? parts[0]! : `Union[${parts.join(', ')}]`);
  }

  private single(t: string, schema: Record<string, unknown>, hint: string, depth: number): string {
    switch (t) {
      case 'string':
        return 'str';
      case 'integer':
        return 'int';
      case 'number':
        return 'float';
      case 'boolean':
        return 'bool';
      case 'null':
        return 'None';
      case 'array':
        return Array.isArray(schema.items) ? 'List[Any]' : `List[${this.type(schema.items as S, `${hint}Item`, depth + 1)}]`;
      case 'object':
        return this.typedDict(schema, hint, depth);
      default:
        return 'Any';
    }
  }

  /** TypedDict via the functional syntax, which accepts any key string. */
  typedDict(schema: Record<string, unknown>, hint: string, depth: number, forcedName?: string): string {
    const props = isObj(schema.properties) ? schema.properties : {};
    const keys = Object.keys(props);
    if (!keys.length) {
      const addl = schema.additionalProperties;
      return isObj(addl) && !isUntyped(addl) ? `Dict[str, ${this.type(addl, `${hint}Value`, depth + 1)}]` : 'Dict[str, Any]';
    }
    const name = forcedName ?? this.name(hint);
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const field = (k: string) => `    ${JSON.stringify(k)}: ${this.type(props[k] as S, `${name}${pascal(k, 'Field')}`, depth + 1)},`;
    const req = keys.filter((k) => required.has(k)).map(field);
    const opt = keys.filter((k) => !required.has(k)).map(field);
    const doc = isObj(schema) && schema.description ? `# ${pyComment(schema.description)}\n` : '';
    if (!opt.length) {
      this.defs.push(`${doc}${name} = TypedDict(${JSON.stringify(name)}, {\n${req.join('\n')}\n})`);
    } else if (!req.length) {
      this.defs.push(`${doc}${name} = TypedDict(${JSON.stringify(name)}, {\n${opt.join('\n')}\n}, total=False)`);
    } else {
      this.defs.push(
        `_${name}Required = TypedDict(${JSON.stringify(`_${name}Required`)}, {\n${req.join('\n')}\n})\n` +
          `_${name}Optional = TypedDict(${JSON.stringify(`_${name}Optional`)}, {\n${opt.join('\n')}\n}, total=False)\n\n\n` +
          `${doc}class ${name}(_${name}Required, _${name}Optional):\n    pass`
      );
    }
    return name;
  }
}

/* ── client files ────────────────────────────────────────────────────────── */

export interface ClientSpec {
  catalogRef: string;
  kind: string;
  /** Artifact id; fills a self-referencing `{id}` placeholder the contract left in its paths. */
  id: string;
  name: string;
  /**
   * Stable local name (swfte.json `alias`). Function and type names derive from
   * it rather than from `name`, so renaming the artifact in Studio does not
   * rename the symbols a codebase imports. Defaults to the artifact name.
   */
  alias?: string;
  description?: string | null;
  contract: CatalogContract;
  contractHash: string;
  defaultBaseUrl: string;
  /** Version sent in the X-Swfte-Client header. Defaults to this package's version. */
  clientVersion?: string;
}

/** Marker every generated client carries; `swfte sync` only rewrites files that have it. */
export const GENERATED_MARKER = 'Generated by @swfte/mcp-server';

/** Header value identifying a generated client to the backend (CONTRACT rev 4). No payload, no secret. */
export function clientHeaderValue(
  language: 'typescript' | 'python',
  spec: Pick<ClientSpec, 'catalogRef' | 'contractHash' | 'clientVersion'>
): string {
  // Header-safe: a catalogRef or hash can never smuggle a CR/LF, `;` or `,` into the value.
  const clean = (s: string) => String(s).replace(/[^A-Za-z0-9:_.\-/@+]/g, '_').slice(0, 200);
  return `${language}/${clean(spec.clientVersion ?? PACKAGE_VERSION)}; ref=${clean(spec.catalogRef)}; hash=${clean(spec.contractHash)}`;
}

/**
 * A generated file ends with a checksum of everything above it, so `swfte
 * verify` can tell a regenerated client from one edited by hand (which the next
 * sync would silently discard). Line endings are normalised first, so a Windows
 * checkout with autocrlf does not read as an edit.
 */
const CHECKSUM_LINE = /^(?:\/\/|#) swfte-checksum: ([0-9a-f]{16})[ \t]*$/m;

function checksumOf(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

export function withChecksum(content: string, comment: '//' | '#'): string {
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `${body}${comment} swfte-checksum: ${checksumOf(body)}\n`;
}

/** Facts read back out of a generated file. */
export function inspectGenerated(content: string): {
  generated: boolean;
  catalogRef: string | null;
  contractHash: string | null;
  /** null when the file has no checksum line (written by an older version). */
  intact: boolean | null;
} {
  const text = content.replace(/\r\n/g, '\n');
  const generated = text.includes(GENERATED_MARKER);
  const ref = /^(?:export const )?CATALOG_REF = "([^"\n]*)"/m.exec(text)?.[1] ?? null;
  const hash = /^(?:export const )?CONTRACT_HASH = "([^"\n]*)"/m.exec(text)?.[1] ?? null;
  const m = CHECKSUM_LINE.exec(text);
  // The checksum line must be the last thing in the file: anything appended after it is an edit too.
  const intact = m ? checksumOf(text.slice(0, m.index)) === m[1] && text.slice(m.index + m[0].length).trim() === '' : null;
  return { generated, catalogRef: ref, contractHash: hash, intact };
}

/* ── shape: top-level fields, for sync diffs and local breaking checks ───── */

/** field name → JSON type, with a trailing "!" when required. Top level only. */
export type Shape = Record<string, string>;

export function shapeOf(schema: unknown): Shape {
  if (!isObj(schema) || !isObj(schema.properties)) return {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const out: Shape = {};
  for (const k of Object.keys(schema.properties).sort()) {
    const p = schema.properties[k];
    const t = isObj(p) ? (typesOf(p).sort().join('|') || (Array.isArray(p.enum) ? 'enum' : 'any')) : 'any';
    out[k] = `${t}${required.has(k) ? '!' : ''}`;
  }
  return out;
}

export interface ShapePair {
  in: Shape;
  out: Shape;
}

/** The shapes a client was generated against — chat defaults included, so they match what the client types. */
export function specShape(spec: ClientSpec): ShapePair {
  const { input, output } = schemasFor(spec);
  return { in: shapeOf(input), out: shapeOf(output) };
}

const SHAPE_LINE = /^(?:\/\/|#) swfte-shape: (\{.*\})[ \t]*$/m;

/** One comment line carrying the shape; JSON with line separators escaped so it cannot end the comment. */
function shapeComment(spec: ClientSpec, comment: '//' | '#'): string {
  const json = JSON.stringify(specShape(spec)).replace(/[\u2028\u2029\r\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${comment} swfte-shape: ${json}`;
}

export function readShape(content: string): ShapePair | null {
  const m = SHAPE_LINE.exec(content.replace(/\r\n/g, '\n'));
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!);
    return isObj(v) && isObj(v.in) && isObj(v.out) ? (v as unknown as ShapePair) : null;
  } catch {
    return null;
  }
}

export interface ShapeDiff {
  inputAdded: string[];
  inputRemoved: string[];
  inputChanged: string[];
  outputAdded: string[];
  outputRemoved: string[];
  outputChanged: string[];
  /** CONTRACT rev 4 definition: a required input added or removed, or an output field removed or retyped. */
  breaking: boolean;
  reasons: string[];
}

export function diffShapes(before: ShapePair, after: ShapePair): ShapeDiff {
  const side = (a: Shape, b: Shape) => ({
    added: Object.keys(b).filter((k) => !(k in a)).sort(),
    removed: Object.keys(a).filter((k) => !(k in b)).sort(),
    changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]).sort(),
  });
  const i = side(before.in, after.in);
  const o = side(before.out, after.out);
  const reasons: string[] = [];
  for (const k of i.added) if (after.in[k]!.endsWith('!')) reasons.push(`required input "${k}" added`);
  for (const k of i.removed) if (before.in[k]!.endsWith('!')) reasons.push(`required input "${k}" removed`);
  for (const k of i.changed) {
    const was = before.in[k]!;
    const now = after.in[k]!;
    if (now.endsWith('!') && !was.endsWith('!')) reasons.push(`input "${k}" became required`);
    else if (was.replace(/!$/, '') !== now.replace(/!$/, '')) reasons.push(`input "${k}" changed type ${was} → ${now}`);
  }
  for (const k of o.removed) reasons.push(`output "${k}" removed`);
  for (const k of o.changed) if (before.out[k]!.replace(/!$/, '') !== after.out[k]!.replace(/!$/, '')) reasons.push(`output "${k}" changed type ${before.out[k]} → ${after.out[k]}`);
  return {
    inputAdded: i.added,
    inputRemoved: i.removed,
    inputChanged: i.changed,
    outputAdded: o.added,
    outputRemoved: o.removed,
    outputChanged: o.changed,
    breaking: reasons.length > 0,
    reasons,
  };
}

/** One human line per diff, for `swfte sync` output. */
export function describeDiff(d: ShapeDiff): string {
  const parts: string[] = [];
  const list = (label: string, xs: string[]) => xs.length && parts.push(`${label} ${xs.join(', ')}`);
  list('+in', d.inputAdded);
  list('-in', d.inputRemoved);
  list('~in', d.inputChanged);
  list('+out', d.outputAdded);
  list('-out', d.outputRemoved);
  list('~out', d.outputChanged);
  return parts.length ? parts.join('; ') : 'no field changes (invoke path, auth or nested schema only)';
}

/** Names and call shape of a generated client, for the framework adapters that wrap it. */
export interface ClientInfo {
  language: 'typescript' | 'python';
  base: string;
  fn: string;
  inputType: string;
  outputType: string;
  chat: boolean;
  /** Path placeholders (other than the artifact itself and userId) the caller must supply. */
  pathParams: string[];
  hasUserId: boolean;
}

export function clientInfo(spec: ClientSpec, language: 'typescript' | 'python'): ClientInfo {
  const label = spec.alias ?? spec.name;
  const base = pascal(label, pascal(spec.kind));
  const chat = isChat(spec);
  const all = pathPlaceholders(resolvedInvoke(spec).path);
  return {
    language,
    base,
    fn: language === 'typescript' ? `${chat ? 'chat' : 'invoke'}${base}` : `${chat ? 'chat' : 'invoke'}_${snake(label, snake(spec.kind))}`,
    inputType: `${base}Input`,
    outputType: `${base}Output`,
    chat,
    pathParams: all.filter((p) => p !== 'userId'),
    hasUserId: all.includes('userId'),
  };
}

/** `{placeholder}` segments the caller must supply, in path order. */
export function pathPlaceholders(path: string): string[] {
  return [...new Set([...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))];
}

const TERMINAL = ['COMPLETED', 'SUCCEEDED', 'SUCCESS', 'FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMEOUT', 'TIMED_OUT', 'TERMINATED', 'REJECTED'];
const WAITING = ['PAUSED', 'WAITING_FOR_INPUT', 'AWAITING_HUMAN'];
const SUCCESS = ['COMPLETED', 'SUCCEEDED', 'SUCCESS'];

function isChat(spec: ClientSpec): boolean {
  return spec.kind === 'agent' || /\/chat(\/|$)/.test(spec.contract.invoke.path);
}

/** Loose defaults when a chat contract ships no schemas — the contract's documented agent shape. */
function chatDefaults(spec: ClientSpec) {
  const input: JsonSchema = isUntyped(spec.contract.inputSchema)
    ? { type: 'object', properties: { message: { type: 'string' }, conversationId: { type: 'string' } }, required: ['message'] }
    : spec.contract.inputSchema;
  const output: JsonSchema = isUntyped(spec.contract.outputSchema)
    ? {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The reply (canonical key).' },
          response: { type: 'string', description: 'Legacy alias of content.' },
          conversationId: { type: 'string' },
        },
      }
    : spec.contract.outputSchema;
  return { input, output };
}

const SELF_PLACEHOLDERS: Record<string, string[]> = {
  workflow: ['workflowId'],
  agent: ['agentId'],
  widget: ['widgetId'],
  chatflow: ['chatFlowId', 'chatflowId'],
  application: ['applicationId', 'appId'],
};

/** The contract's paths with placeholders that name this artifact itself filled in. */
function resolvedInvoke(spec: ClientSpec): CatalogContract['invoke'] {
  const self = new Set(['id', ...(SELF_PLACEHOLDERS[spec.kind] ?? [])]);
  const sub = (p: string) => p.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => (self.has(k) ? encodeURIComponent(spec.id) : m));
  const inv = spec.contract.invoke;
  return { ...inv, path: sub(String(inv.path ?? '')), statusPath: inv.statusPath ?? null };
}

function schemasFor(spec: ClientSpec) {
  return isChat(spec) ? chatDefaults(spec) : { input: spec.contract.inputSchema, output: spec.contract.outputSchema };
}

export function renderTypeScriptClient(spec: ClientSpec): string {
  const info = clientInfo(spec, 'typescript');
  const { base, fn, chat } = info;
  const { input, output } = schemasFor(spec);
  const inputType = isUntyped(input) ? 'Record<string, unknown>' : tsType(input);
  const outputType = tsType(output);
  const inv = resolvedInvoke(spec);
  const placeholders = pathPlaceholders(inv.path).filter((p) => p !== 'userId');
  const hasUserId = pathPlaceholders(inv.path).includes('userId');
  const isPublic = inv.auth === 'public';
  const method = String(inv.method || 'POST').toUpperCase();

  const pathParamsOpt = placeholders.length
    ? `  /** Values for the {placeholders} in the invoke path. */\n  pathParams: { ${placeholders.map((p) => `${tsKey(p)}: string`).join('; ')} };\n`
    : '';
  const userIdOpt = hasUserId ? `  /** Conversation owner for the chat endpoint. Default "swfte-client". */\n  userId?: string;\n` : '';
  const optsRequired = placeholders.length > 0;

  return withChecksum(`// ${GENERATED_MARKER} (swfte add / swfte_scaffold_client). Do not edit by hand — run \`swfte sync\`.
// Source of truth: Swfte Studio catalog entry ${tsComment(spec.catalogRef)}
// Artifact: ${tsComment(spec.name)}${spec.description ? `\n// ${tsComment(spec.description)}` : ''}
// Contract hash: ${spec.contractHash} (recorded in swfte.json; a different hash means the contract moved).
//
// ${isPublic ? 'Public endpoint: no credential is sent.' : 'Server-side only: reads SWFTE_API_KEY from the environment. Never bundle this file into browser code.'}
// Configure via .env: SWFTE_API_KEY, SWFTE_BASE_URL, SWFTE_WORKSPACE_ID.

export const CATALOG_REF = ${JSON.stringify(spec.catalogRef)};
export const CONTRACT_HASH = ${JSON.stringify(spec.contractHash)};
/** Identifies this generated client to Swfte (counts adopter runs; never carries payloads). */
export const SWFTE_CLIENT = ${JSON.stringify(clientHeaderValue('typescript', spec))};
${shapeComment(spec, '//')}

const INVOKE: { method: string; path: string; auth: "pat" | "api_key" | "public"; async: boolean; statusPath: string | null } = {
  method: ${JSON.stringify(method)},
  path: ${JSON.stringify(inv.path)},
  auth: ${JSON.stringify(inv.auth)},
  async: ${Boolean(inv.async)},
  statusPath: ${JSON.stringify(inv.statusPath ?? null)},
};

export type ${base}Input = ${inputType};

export type ${base}Output = ${outputType};

export interface InvokeResult<T> {
  /** True when the call (and, for async artifacts, the run) completed successfully. */
  ok: boolean;
  /** Terminal status, "WAITING_FOR_INPUT"-style pause, or "ACCEPTED" when there is no status to poll. */
  status: string;
  executionId?: string;
  output: T | undefined;
${chat ? `  /** The reply text: \`content\`, falling back to the legacy \`response\` key. */
  reply?: string;
` : ''}  raw: unknown;
}

export interface ClientOptions {
  /** Defaults to process.env.SWFTE_API_KEY. A PAT (pat_…) or API key (sk-swfte-…). */
  apiKey?: string;
  /** Defaults to process.env.SWFTE_BASE_URL, then ${JSON.stringify(spec.defaultBaseUrl)}. */
  baseUrl?: string;
  /** Defaults to process.env.SWFTE_WORKSPACE_ID. Sent with API keys; PATs carry their own binding. */
  workspaceId?: string;
${pathParamsOpt}${userIdOpt}  /** Overall budget for invoke + polling. Default 300000 ms. */
  timeoutMs?: number;
  /** Delay between status polls. Default 2000 ms. */
  pollIntervalMs?: number;
  fetch?: typeof fetch;
}

export class SwfteRequestError extends Error {
  constructor(readonly status: number, readonly body: string, readonly path: string) {
    super(\`Swfte request failed: \${status} on \${path}: \${body.slice(0, 300)}\`);
    this.name = 'SwfteRequestError';
  }
}

const TERMINAL = new Set(${JSON.stringify(TERMINAL)});
const WAITING = new Set(${JSON.stringify(WAITING)});
const SUCCESS = new Set(${JSON.stringify(SUCCESS)});

function env(name: string): string | undefined {
  // globalThis keeps this compiling in projects without @types/node.
  return (globalThis as any).process?.env?.[name];
}

function fill(path: string, values: Record<string, string>): string {
  return path.replace(/\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined || v === '') throw new Error(\`Missing value for path placeholder {\${key}}\`);
    return encodeURIComponent(v);
  });
}

async function call(opts: ClientOptions, method: string, path: string, body: unknown, deadline: number): Promise<any> {
  const f = opts.fetch ?? fetch;
  const baseUrl = (opts.baseUrl ?? env('SWFTE_BASE_URL') ?? ${JSON.stringify(spec.defaultBaseUrl)}).replace(/\\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Swfte-Client': SWFTE_CLIENT };
  if (INVOKE.auth !== 'public') {
    const key = opts.apiKey ?? env('SWFTE_API_KEY');
    if (!key) throw new Error('SWFTE_API_KEY is not set (see .env.example).');
    headers.Authorization = \`Bearer \${key}\`;
    if (!key.startsWith('pat_')) {
      headers['X-API-Key'] = key;
      const ws = opts.workspaceId ?? env('SWFTE_WORKSPACE_ID');
      if (ws) headers['X-Workspace-ID'] = ws;
    }
  }
  let url = baseUrl + path;
  let payload: string | undefined;
  if (body !== undefined) {
    if (method === 'GET') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  try {
    const res = await f(url, { method, headers, body: payload, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new SwfteRequestError(res.status, text, path);
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

const statusOf = (s: any): string => String(s?.execution?.status ?? s?.status ?? 'UNKNOWN').toUpperCase();
const outputOf = (s: any): unknown => s?.execution?.outputData ?? s?.outputData ?? s?.output ?? s?.result;

/**
 * ${tsComment(spec.description || `Call ${spec.name}.`)}
 */
export async function ${fn}(input: ${base}Input, opts: ClientOptions${optsRequired ? '' : ' = {}'}): Promise<InvokeResult<${base}Output>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  const path = fill(INVOKE.path, { ${hasUserId ? "userId: opts.userId ?? 'swfte-client', " : ''}${placeholders.length ? '...opts.pathParams' : ''} });
  const started = await call(opts, INVOKE.method, path, input, deadline);
  if (!INVOKE.async) {
${chat ? `    const reply = started?.content ?? started?.response;
    return { ok: true, status: 'COMPLETED', output: started as ${base}Output, reply: typeof reply === 'string' ? reply : undefined, raw: started };` : `    return { ok: true, status: 'COMPLETED', output: started as ${base}Output, raw: started };`}
  }
  const executionId = String(started?.executionId ?? started?.execution?.id ?? started?.id ?? '');
  if (!executionId || !INVOKE.statusPath) {
    return { ok: false, status: 'ACCEPTED', executionId: executionId || undefined, output: undefined, raw: started };
  }
  const statusPath = fill(INVOKE.statusPath, { executionId, id: executionId });
  for (;;) {
    const snapshot = await call(opts, 'GET', statusPath, undefined, deadline);
    const status = statusOf(snapshot);
    if (TERMINAL.has(status) || WAITING.has(status)) {
      return { ok: SUCCESS.has(status), status, executionId, output: outputOf(snapshot) as ${base}Output | undefined, raw: snapshot };
    }
    if (Date.now() + (opts.pollIntervalMs ?? 2_000) > deadline) {
      throw new Error(\`Timed out waiting for execution \${executionId} (last status \${status}). It may still finish; poll \${statusPath}.\`);
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? 2_000));
  }
}
`, '//');
}

export function renderPythonClient(spec: ClientSpec): string {
  const info = clientInfo(spec, 'python');
  const { base, fn, chat } = info;
  const { input, output } = schemasFor(spec);
  const types = new PyTypes();
  const inputName = `${base}Input`;
  const outputName = `${base}Output`;
  let inputAlias: string | null = null;
  if (isUntyped(input) || !(isObj(input) && isObj(input.properties) && Object.keys(input.properties).length)) {
    inputAlias = `${inputName} = Dict[str, Any]`;
    types.name(inputName);
  } else {
    types.name(inputName);
    types.typedDict(input as Record<string, unknown>, inputName, 0, inputName);
  }
  types.name(outputName);
  const outType = isObj(output) && isObj(output.properties) && Object.keys(output.properties).length
    ? (types.typedDict(output as Record<string, unknown>, outputName, 0, outputName), null)
    : types.type(output, `${outputName}Value`);
  const outputAlias = outType === null ? null : `${outputName} = ${outType}`;

  const inv = resolvedInvoke(spec);
  const placeholders = pathPlaceholders(inv.path).filter((p) => p !== 'userId');
  const hasUserId = pathPlaceholders(inv.path).includes('userId');
  const isPublic = inv.auth === 'public';
  const method = String(inv.method || 'POST').toUpperCase();
  const pyStr = (v: unknown) => (v === null || v === undefined ? 'None' : JSON.stringify(String(v)));
  const pathArgs = placeholders.length ? ', path_params: Dict[str, str]' : '';
  const userArg = hasUserId ? ', user_id: str = "swfte-client"' : '';
  const fillValues = [
    ...(hasUserId ? ['"userId": user_id'] : []),
    ...(placeholders.length ? ['**path_params'] : []),
  ].join(', ');

  return withChecksum(`# ${GENERATED_MARKER} (swfte add / swfte_scaffold_client). Do not edit by hand - run \`swfte sync\`.
# Source of truth: Swfte Studio catalog entry ${pyComment(spec.catalogRef)}
# Artifact: ${pyComment(spec.name)}${spec.description ? `\n# ${pyComment(spec.description)}` : ''}
# Contract hash: ${spec.contractHash} (recorded in swfte.json; a different hash means the contract moved).
#
# ${isPublic ? 'Public endpoint: no credential is sent.' : 'Server-side only: reads SWFTE_API_KEY from the environment.'}
# Configure via .env: SWFTE_API_KEY, SWFTE_BASE_URL, SWFTE_WORKSPACE_ID. Standard library only (Python 3.8+).
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Literal, Optional, TypedDict, Union

CATALOG_REF = ${pyStr(spec.catalogRef)}
CONTRACT_HASH = ${pyStr(spec.contractHash)}
# Identifies this generated client to Swfte (counts adopter runs; never carries payloads).
SWFTE_CLIENT = ${pyStr(clientHeaderValue('python', spec))}
${shapeComment(spec, '#')}

INVOKE_METHOD = ${pyStr(method)}
INVOKE_PATH = ${pyStr(inv.path)}
INVOKE_AUTH = ${pyStr(inv.auth)}
INVOKE_ASYNC = ${inv.async ? 'True' : 'False'}
STATUS_PATH = ${pyStr(inv.statusPath)}
DEFAULT_BASE_URL = ${pyStr(spec.defaultBaseUrl)}

TERMINAL = {${TERMINAL.map((s) => JSON.stringify(s)).join(', ')}}
WAITING = {${WAITING.map((s) => JSON.stringify(s)).join(', ')}}
SUCCESS = {${SUCCESS.map((s) => JSON.stringify(s)).join(', ')}}


${[inputAlias, ...types.defs, outputAlias].filter(Boolean).join('\n\n\n')}


class InvokeResult(TypedDict):
    ok: bool
    status: str
    execution_id: Optional[str]
    output: Any
    reply: Optional[str]
    raw: Any


class SwfteRequestError(Exception):
    def __init__(self, status: int, body: str, path: str) -> None:
        super().__init__(f"Swfte request failed: {status} on {path}: {body[:300]}")
        self.status = status
        self.body = body
        self.path = path


def _fill(path: str, values: Dict[str, str]) -> str:
    def repl(m: "re.Match[str]") -> str:
        key = m.group(1)
        if not values.get(key):
            raise ValueError(f"Missing value for path placeholder {{{key}}}")
        return urllib.parse.quote(str(values[key]), safe="")

    return re.sub(r"\\{([A-Za-z_][A-Za-z0-9_]*)\\}", repl, path)


def _call(method: str, path: str, body: Any, api_key: Optional[str], base_url: Optional[str], workspace_id: Optional[str], timeout_s: float) -> Any:
    base = (base_url or os.environ.get("SWFTE_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    headers = {"Accept": "application/json", "X-Swfte-Client": SWFTE_CLIENT}
    if INVOKE_AUTH != "public":
        key = api_key or os.environ.get("SWFTE_API_KEY")
        if not key:
            raise RuntimeError("SWFTE_API_KEY is not set (see .env.example).")
        headers["Authorization"] = f"Bearer {key}"
        if not key.startswith("pat_"):
            headers["X-API-Key"] = key
            ws = workspace_id or os.environ.get("SWFTE_WORKSPACE_ID")
            if ws:
                headers["X-Workspace-ID"] = ws
    url = base + path
    data = None
    if body is not None:
        if method == "GET":
            query = urllib.parse.urlencode({k: v for k, v in dict(body).items() if v is not None})
            if query:
                url += ("&" if "?" in url else "?") + query
        else:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=max(1.0, timeout_s)) as res:
            text = res.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        raise SwfteRequestError(err.code, err.read().decode("utf-8", "replace"), path) from None
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def _status(snapshot: Any) -> str:
    if isinstance(snapshot, dict):
        execution = snapshot.get("execution")
        if isinstance(execution, dict) and execution.get("status"):
            return str(execution["status"]).upper()
        return str(snapshot.get("status") or "UNKNOWN").upper()
    return "UNKNOWN"


def _output(snapshot: Any) -> Any:
    if not isinstance(snapshot, dict):
        return None
    execution = snapshot.get("execution")
    if isinstance(execution, dict) and execution.get("outputData") is not None:
        return execution["outputData"]
    for key in ("outputData", "output", "result"):
        if snapshot.get(key) is not None:
            return snapshot[key]
    return None


def ${fn}(
    inputs: ${inputName}${pathArgs}${userArg},
    *,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    workspace_id: Optional[str] = None,
    timeout_s: float = 300.0,
    poll_interval_s: float = 2.0,
) -> InvokeResult:
    """${pyComment(spec.description || `Call ${spec.name}.`).replace(/\\/g, '\\\\').replace(/"/g, "'")}"""
    deadline = time.monotonic() + timeout_s
    path = _fill(INVOKE_PATH, {${fillValues}})
    started = _call(INVOKE_METHOD, path, inputs, api_key, base_url, workspace_id, timeout_s)
    if not INVOKE_ASYNC:
        reply = None
        if ${chat ? 'True' : 'False'} and isinstance(started, dict):
            # content is canonical; response is the legacy alias.
            value = started.get("content") if started.get("content") is not None else started.get("response")
            reply = value if isinstance(value, str) else None
        return {"ok": True, "status": "COMPLETED", "execution_id": None, "output": started, "reply": reply, "raw": started}
    execution_id = ""
    if isinstance(started, dict):
        nested = started.get("execution") if isinstance(started.get("execution"), dict) else {}
        execution_id = str(started.get("executionId") or nested.get("id") or started.get("id") or "")
    if not execution_id or not STATUS_PATH:
        return {"ok": False, "status": "ACCEPTED", "execution_id": execution_id or None, "output": None, "reply": None, "raw": started}
    status_path = _fill(STATUS_PATH, {"executionId": execution_id, "id": execution_id})
    while True:
        remaining = deadline - time.monotonic()
        snapshot = _call("GET", status_path, None, api_key, base_url, workspace_id, remaining)
        status = _status(snapshot)
        if status in TERMINAL or status in WAITING:
            return {"ok": status in SUCCESS, "status": status, "execution_id": execution_id, "output": _output(snapshot), "reply": None, "raw": snapshot}
        if time.monotonic() + poll_interval_s > deadline:
            raise TimeoutError(f"Timed out waiting for execution {execution_id} (last status {status}); poll {status_path}.")
        time.sleep(poll_interval_s)
`, '#');
}
