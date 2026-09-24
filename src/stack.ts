/**
 * Local stack detection (CONTRACT rev 4): which framework a project uses, read
 * from its manifests only. Pure and synchronous over a directory — nothing
 * leaves the machine, nothing is executed, and a manifest that does not parse
 * is a signal ("unreadable"), never a crash.
 *
 *   package.json deps   next → nextjs · express → express · @nestjs/core → nestjs (plain-ts adapter)
 *                       hono → plain-ts
 *   pyproject / requirements*.txt / Pipfile   fastapi → fastapi · flask, django → plain-python
 *   otherwise           plain-ts when tsconfig.json or package.json exists, else plain-python
 *
 * A repo with both a Node and a Python manifest (a Next.js front end with a
 * FastAPI service beside it) resolves to the web framework it finds first in
 * that order; the caller can always override with an explicit framework.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FRAMEWORKS = ['nextjs', 'express', 'fastapi', 'plain-ts', 'plain-python'] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export type Language = 'typescript' | 'python';

export function languageOf(framework: Framework): Language {
  return framework === 'fastapi' || framework === 'plain-python' ? 'python' : 'typescript';
}

export interface StackDetection {
  framework: Framework;
  language: Language;
  /** The finer-grained framework seen, when it maps onto a generic adapter (nestjs, hono, flask, django). */
  detected: string;
  /** Stack tags for /fit: framework, language, runtime and notable dependencies. */
  stack: string[];
  /** Why: one line per manifest fact used. */
  signals: string[];
  /** Layout facts adapters need. */
  layout: {
    /** Next.js App Router directory relative to the root ("app" or "src/app"), when present or implied. */
    appDir: string | null;
    /** Next.js Pages Router only (no app dir): adapters still use the App Router, which Next 13.4+ runs beside pages. */
    pagesOnly: boolean;
    hasSrcDir: boolean;
    hasTsconfig: boolean;
    /** A Python package directory holding the app (e.g. "app"), when one is obvious. */
    pythonPackage: string | null;
    /** package.json "type": "module" — relative imports in generated TypeScript then carry a `.js` extension. */
    esm: boolean;
  };
}

/** Dependencies worth telling /fit about, mapped to the tag the backend matches on. */
const NOTABLE_NODE: Record<string, string> = {
  stripe: 'stripe',
  '@stripe/stripe-js': 'stripe',
  prisma: 'prisma',
  '@prisma/client': 'prisma',
  'drizzle-orm': 'drizzle',
  pg: 'postgres',
  postgres: 'postgres',
  mysql2: 'mysql',
  mongodb: 'mongodb',
  mongoose: 'mongodb',
  redis: 'redis',
  ioredis: 'redis',
  '@supabase/supabase-js': 'supabase',
  firebase: 'firebase',
  'firebase-admin': 'firebase',
  '@clerk/nextjs': 'clerk',
  'next-auth': 'nextauth',
  '@auth/core': 'nextauth',
  '@workos-inc/node': 'workos',
  '@slack/web-api': 'slack',
  '@sendgrid/mail': 'sendgrid',
  resend: 'resend',
  twilio: 'twilio',
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  ai: 'vercel-ai-sdk',
  react: 'react',
  vue: 'vue',
  svelte: 'svelte',
  '@aws-sdk/client-s3': 'aws-s3',
  googleapis: 'google',
  '@hubspot/api-client': 'hubspot',
  jsforce: 'salesforce',
};

const NOTABLE_PY: Record<string, string> = {
  stripe: 'stripe',
  sqlalchemy: 'sqlalchemy',
  psycopg: 'postgres',
  psycopg2: 'postgres',
  'psycopg2-binary': 'postgres',
  asyncpg: 'postgres',
  pymongo: 'mongodb',
  redis: 'redis',
  celery: 'celery',
  pydantic: 'pydantic',
  openai: 'openai',
  anthropic: 'anthropic',
  langchain: 'langchain',
  'slack-sdk': 'slack',
  twilio: 'twilio',
  boto3: 'aws',
  pandas: 'pandas',
  supabase: 'supabase',
};

function readText(path: string): string | null {
  try {
    // Strip a UTF-8 BOM: editors on Windows write one, and JSON.parse rejects it (BT-N11).
    return statSync(path).isFile() ? readFileSync(path, 'utf8').replace(/^\uFEFF/, '') : null;
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Normalise a Python distribution name (PEP 503) so `FastAPI`, `fast_api` and `fastapi` compare equal. */
const pyName = (s: string) => s.trim().toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Distribution names mentioned by Python manifests. Deliberately a light
 * parse — requirement lines, PEP 621 `dependencies = [...]`, Poetry
 * `[tool.poetry.dependencies]` keys, Pipfile `[packages]` keys — because the
 * question is only "is fastapi in here", not a resolver.
 */
/**
 * The text of every array that holds requirement strings: `dependencies = [...]`
 * anywhere, and every array under an `optional-dependencies` / `dependency-groups`
 * table. Arrays may span lines; brackets inside quoted strings (extras like
 * `"uvicorn[standard]"`) do not end them.
 */
export function pyDependencyArrays(toml: string): string[] {
  const out: string[] = [];
  let table = '';
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    const m = /^\s*("?)([A-Za-z0-9_.-]+)\1\s*=\s*\[/.exec(line);
    if (!m) continue;
    const key = m[2]!.toLowerCase();
    const inGroupTable = /(^|\.)(optional-dependencies|dependency-groups)$/i.test(table);
    if (key !== 'dependencies' && key !== 'dev-dependencies' && !inGroupTable) continue;
    // Collect up to the matching close bracket, ignoring brackets in quotes.
    let text = line.slice(line.indexOf('[', m[0].length - 1) + 1);
    let depth = 1;
    let quote: string | null = null;
    let collected = '';
    for (let j = i; ; ) {
      for (const ch of text) {
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[') depth++;
        else if (ch === ']' && --depth === 0) break;
        collected += ch;
      }
      if (depth === 0 || ++j >= lines.length) {
        i = j;
        break;
      }
      collected += '\n';
      text = lines[j]!;
    }
    out.push(collected);
  }
  return out;
}

export function pythonDependencies(root: string): { deps: Set<string>; files: string[] } {
  const deps = new Set<string>();
  const files: string[] = [];
  const addReq = (line: string) => {
    const clean = line.replace(/#.*/, '').trim();
    if (!clean || clean.startsWith('-')) return;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(clean);
    if (m) deps.add(pyName(m[1]!));
  };
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return { deps, files };
  }
  for (const name of names.sort()) {
    if (!/^requirements.*\.(txt|in)$/i.test(name)) continue;
    const text = readText(join(root, name));
    if (text === null) continue;
    files.push(name);
    for (const line of text.split(/\r?\n/)) addReq(line);
  }
  const pyproject = readText(join(root, 'pyproject.toml'));
  if (pyproject !== null) {
    files.push('pyproject.toml');
    // Quoted requirement strings inside dependency arrays only (PEP 621 `dependencies = [...]`,
    // `[project.optional-dependencies]` groups, PEP 735 dependency-groups) — never `keywords`,
    // `classifiers` or any other string array that happens to name a framework (BT-N11).
    for (const block of pyDependencyArrays(pyproject)) {
      for (const m of block.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@ ]|["'])/g)) deps.add(pyName(m[1]!));
    }
    // Poetry / PDM tables: `name = "^1.0"` keys under a dependencies table.
    let inDeps = false;
    for (const line of pyproject.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) {
        inDeps = /dependencies/i.test(header[1]!);
        continue;
      }
      if (!inDeps) continue;
      const key = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      if (key && key[1]!.toLowerCase() !== 'python') deps.add(pyName(key[1]!));
    }
  }
  const pipfile = readText(join(root, 'Pipfile'));
  if (pipfile !== null) {
    files.push('Pipfile');
    let inPkgs = false;
    for (const line of pipfile.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) {
        inPkgs = /packages/i.test(header[1]!);
        continue;
      }
      const key = inPkgs ? /^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=/.exec(line) : null;
      if (key) deps.add(pyName(key[1]!));
    }
  }
  return { deps, files };
}

function nodeDependencies(root: string): { deps: Set<string> | null; unreadable: boolean; esm: boolean; workspaces: string[] } {
  const text = readText(join(root, 'package.json'));
  if (text === null) return { deps: null, unreadable: false, esm: false, workspaces: [] };
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const esm = pkg.type === 'module';
    const deps = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const block = pkg[field];
      if (block && typeof block === 'object') for (const k of Object.keys(block as object)) deps.add(k);
    }
    // npm/yarn `workspaces: [...]` or yarn's `{ packages: [...] }`.
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray((pkg.workspaces as { packages?: unknown })?.packages) ? (pkg.workspaces as { packages: unknown[] }).packages : [];
    return { deps, unreadable: false, esm, workspaces: ws.map(String) };
  } catch {
    return { deps: new Set(), unreadable: true, esm: false, workspaces: [] };
  }
}

export function detectStack(root: string = process.cwd()): StackDetection {
  const signals: string[] = [];
  const node = nodeDependencies(root);
  const py = pythonDependencies(root);
  const hasTsconfig = existsSync(join(root, 'tsconfig.json'));
  const hasSrcDir = isDir(join(root, 'src'));
  const appDir = isDir(join(root, 'src', 'app')) ? 'src/app' : isDir(join(root, 'app')) ? 'app' : null;
  const pagesDir = isDir(join(root, 'src', 'pages')) || isDir(join(root, 'pages'));
  const pythonPackage = ['app', 'src', 'api', 'backend'].find((d) => existsSync(join(root, d, '__init__.py')) || existsSync(join(root, d, 'main.py'))) ?? null;

  if (node.unreadable) signals.push('package.json exists but does not parse; ignoring its dependencies');
  // A monorepo root is rarely where the app lives: say so, and how to point at the app (BT-N11).
  const pnpmWs = readText(join(root, 'pnpm-workspace.yaml'));
  const wsGlobs = [...node.workspaces, ...(pnpmWs ? [...pnpmWs.matchAll(/^\s*-\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]!) : [])];
  if (wsGlobs.length || pnpmWs !== null || existsSync(join(root, 'turbo.json')) || existsSync(join(root, 'nx.json'))) {
    signals.push(
      `monorepo root (workspaces: ${[...new Set(wsGlobs)].join(', ') || 'see pnpm-workspace.yaml / turbo.json / nx.json'}); run swfte in the app's package instead, e.g. \`swfte add <ref> --cwd apps/web\`, or pass --framework`
    );
  }

  let framework: Framework | null = null;
  let detected = '';
  const d = node.deps;
  if (d && d.has('next')) {
    framework = 'nextjs';
    detected = 'nextjs';
    signals.push('package.json depends on "next"');
  } else if (d && d.has('express')) {
    framework = 'express';
    detected = 'express';
    signals.push('package.json depends on "express"');
  } else if (d && d.has('@nestjs/core')) {
    framework = 'plain-ts';
    detected = 'nestjs';
    signals.push('package.json depends on "@nestjs/core" (NestJS → plain TypeScript client; wire it into a provider)');
  } else if (d && d.has('hono')) {
    framework = 'plain-ts';
    detected = 'hono';
    signals.push('package.json depends on "hono" (→ plain TypeScript client)');
  } else if (py.deps.has('fastapi')) {
    framework = 'fastapi';
    detected = 'fastapi';
    signals.push(`${py.files.join(', ')} require "fastapi"`);
  } else if (py.deps.has('flask') || py.deps.has('django')) {
    framework = 'plain-python';
    detected = py.deps.has('django') ? 'django' : 'flask';
    signals.push(`${py.files.join(', ')} require "${detected}" (→ plain Python client)`);
  } else if (hasTsconfig || d) {
    framework = 'plain-ts';
    detected = 'node';
    signals.push(hasTsconfig ? 'tsconfig.json present' : 'package.json present, no known web framework');
  } else {
    framework = 'plain-python';
    detected = py.files.length ? 'python' : 'unknown';
    signals.push(py.files.length ? `${py.files.join(', ')} present, no known web framework` : 'no package.json, tsconfig.json or Python manifest found; defaulting to plain Python');
  }

  const language = languageOf(framework);
  const stack = new Set<string>([detected === 'unknown' ? framework : detected, language]);
  if (framework !== detected && detected !== 'unknown' && detected !== 'node' && detected !== 'python') stack.add(framework);
  if (d) {
    stack.add('node');
    for (const dep of d) if (NOTABLE_NODE[dep]) stack.add(NOTABLE_NODE[dep]!);
  }
  if (py.files.length) {
    stack.add('python');
    for (const dep of py.deps) if (NOTABLE_PY[dep]) stack.add(NOTABLE_PY[dep]!);
    if (framework !== 'fastapi' && py.deps.has('fastapi')) stack.add('fastapi');
  }
  if (language === 'typescript' && !hasTsconfig) {
    signals.push('no tsconfig.json: generated files are TypeScript, so run them through tsx/ts-node or add a tsconfig');
  }
  if (framework === 'nextjs' && !appDir && pagesDir) {
    signals.push('Pages Router only: the adapter uses the App Router (app/api/<alias>/route.ts), which Next.js 13.4+ serves beside pages');
  }

  return {
    framework,
    language,
    detected,
    stack: [...stack],
    signals,
    layout: {
      appDir: framework === 'nextjs' ? (appDir ?? (hasSrcDir ? 'src/app' : 'app')) : appDir,
      pagesOnly: framework === 'nextjs' && !appDir && pagesDir,
      hasSrcDir,
      hasTsconfig,
      pythonPackage,
      esm: node.esm,
    },
  };
}
