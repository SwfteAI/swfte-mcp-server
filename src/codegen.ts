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
import type { CatalogContract, JsonSchema } from './catalog.js';

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
const tsComment = (s: unknown) => String(s ?? '').replace(/\*\//g, '*\\/').replace(/[\r\n]+/g, ' ').slice(0, 300);
/** Text safe inside a `#` line comment. */
const pyComment = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);

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
  description?: string | null;
  contract: CatalogContract;
  contractHash: string;
  defaultBaseUrl: string;
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
    ? { type: 'object', properties: { response: { type: 'string' }, conversationId: { type: 'string' } } }
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
  const base = pascal(spec.name, pascal(spec.kind));
  const fn = `${isChat(spec) ? 'chat' : 'invoke'}${base}`;
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

  return `// Generated by @swfte/mcp-server (swfte_scaffold_client). Do not edit by hand — re-run the tool.
// Source of truth: Swfte Studio catalog entry ${tsComment(spec.catalogRef)}
// Artifact: ${tsComment(spec.name)}${spec.description ? `\n// ${tsComment(spec.description)}` : ''}
// Contract hash: ${spec.contractHash} (recorded in swfte.json; a different hash means the contract moved).
//
// ${isPublic ? 'Public endpoint: no credential is sent.' : 'Server-side only: reads SWFTE_API_KEY from the environment. Never bundle this file into browser code.'}
// Configure via .env: SWFTE_API_KEY, SWFTE_BASE_URL, SWFTE_WORKSPACE_ID.

export const CATALOG_REF = ${JSON.stringify(spec.catalogRef)};
export const CONTRACT_HASH = ${JSON.stringify(spec.contractHash)};

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
  raw: unknown;
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

async function call(opts: ClientOptions, method: string, path: string, body?: unknown, deadline = Date.now() + 30_000): Promise<any> {
  const f = opts.fetch ?? fetch;
  const baseUrl = (opts.baseUrl ?? env('SWFTE_BASE_URL') ?? ${JSON.stringify(spec.defaultBaseUrl)}).replace(/\\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
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
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(30_000, deadline - Date.now())));
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
    return { ok: true, status: 'COMPLETED', output: started as ${base}Output, raw: started };
  }
  const executionId = String(started?.executionId ?? started?.id ?? '');
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
`;
}

export function renderPythonClient(spec: ClientSpec): string {
  const base = pascal(spec.name, pascal(spec.kind));
  const fn = `${isChat(spec) ? 'chat' : 'invoke'}_${snake(spec.name, snake(spec.kind))}`;
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

  return `# Generated by @swfte/mcp-server (swfte_scaffold_client). Do not edit by hand - re-run the tool.
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
    headers = {"Accept": "application/json"}
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
        with urllib.request.urlopen(req, timeout=max(1.0, min(30.0, timeout_s))) as res:
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
        return {"ok": True, "status": "COMPLETED", "execution_id": None, "output": started, "raw": started}
    execution_id = ""
    if isinstance(started, dict):
        execution_id = str(started.get("executionId") or started.get("id") or "")
    if not execution_id or not STATUS_PATH:
        return {"ok": False, "status": "ACCEPTED", "execution_id": execution_id or None, "output": None, "raw": started}
    status_path = _fill(STATUS_PATH, {"executionId": execution_id, "id": execution_id})
    while True:
        remaining = deadline - time.monotonic()
        snapshot = _call("GET", status_path, None, api_key, base_url, workspace_id, remaining)
        status = _status(snapshot)
        if status in TERMINAL or status in WAITING:
            return {"ok": status in SUCCESS, "status": status, "execution_id": execution_id, "output": _output(snapshot), "raw": snapshot}
        if time.monotonic() + poll_interval_s > deadline:
            raise TimeoutError(f"Timed out waiting for execution {execution_id} (last status {status}); poll {status_path}.")
        time.sleep(poll_interval_s)
`;
}
