/**
 * Framework adapters: the thin, idiomatic entry point a project mounts in
 * front of a generated client (CONTRACT rev 4).
 *
 *   nextjs   App Router route handler   <appDir>/api/<alias>/route.ts
 *   express  Router module              <outDir>/<alias>.router.ts
 *   fastapi  APIRouter module           <outDir>/<alias>_router.py
 *   plain-*  no adapter — call the client directly
 *
 * Unlike the client, an adapter is the developer's file from the moment it is
 * written: its authorize() hook (deny by default, 401 until wired) is where their auth goes. `swfte sync` never rewrites one,
 * and `swfte add` never overwrites one without force. Its call into the client
 * uses names derived from the alias, which a contract change does not move,
 * so a regenerated client keeps compiling underneath it.
 */
import { posix } from 'node:path';
import type { ClientInfo } from './codegen.js';
import type { Framework } from './stack.js';

export interface AdapterFile {
  /** Path relative to the project root, forward slashes. */
  path: string;
  content: string;
  /** Written only when absent — never merged, never an overwrite conflict (e.g. a package `__init__.py`). */
  ifMissing?: boolean;
}

export interface AdapterPlan {
  files: AdapterFile[];
  /** How to mount / call it, for the tool result and CLI output. */
  usage: string;
}

export interface AdapterInput {
  framework: Framework;
  alias: string;
  catalogRef: string;
  info: ClientInfo;
  /** Client file path relative to the root, forward slashes. */
  clientPath: string;
  outDir: string;
  /** Next.js app directory relative to root ("app" | "src/app"). */
  appDir: string | null;
  /** Relative TS imports need a `.js` suffix (package.json "type": "module", not bundled). */
  esm: boolean;
}

/** Relative module specifier from one root-relative file to another, extension handled per language. */
function importPath(fromFile: string, toFile: string, ext: '' | '.js'): string {
  let rel = posix.relative(posix.dirname(fromFile), toFile).replace(/\.ts$/, ext);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

const HEADER_TS = (ref: string) =>
  `// Created by @swfte/mcp-server (swfte add) for ${ref}. This file is yours: \`swfte sync\` never rewrites it.\n` +
  '// Deny by default: every request gets 401 until authorize() below recognises the caller. Anyone who can reach\n' +
  '// this endpoint spends your Swfte credits through it, so wire authorize() to your own auth before exposing it.\n';
const HEADER_PY = (ref: string) =>
  `# Created by @swfte/mcp-server (swfte add) for ${ref}. This file is yours: \`swfte sync\` never rewrites it.\n` +
  '# Deny by default: every request gets 401 until authorize() below recognises the caller. Anyone who can reach\n' +
  '# this endpoint spends your Swfte credits through it, so wire authorize() to your own auth before exposing it.\n';

/** The authorize() hook every TypeScript adapter starts with: it refuses everyone until the app wires it. */
const TS_AUTHORIZE = (requestType: string, example: string) => `
/** The caller authorize() recognised. \`userId\` also owns the conversation when the artifact is an agent. */
export interface Caller {
  userId: string;
}

/**
 * Who may call this route. Return the caller for an authenticated request, or null to refuse it (401).
 * It refuses everyone until you connect it to your auth, e.g. ${example}
 */
export async function authorize(_request: ${requestType}): Promise<Caller | null> {
  return null;
}
`;

const UNAUTHORIZED = 'Unauthorized: this route refuses every request until authorize() is connected to your auth.';

/** Uniform response body and HTTP status for every adapter: 200 done, 202 accepted/waiting, 502 failed. */
const TS_RESULT_STATUS = `const httpStatus = (r: { ok: boolean; status: string }) =>
  r.ok ? 200 : r.status === 'ACCEPTED' || /WAIT|PAUSE|AWAIT/.test(r.status) ? 202 : 502;`;

function tsCall(info: ClientInfo, pathParamsExpr: string): string {
  const opts = [
    ...(info.pathParams.length ? [`pathParams: ${pathParamsExpr}`] : []),
    // Conversation owner: the caller authorize() recognised, never the request body (a caller could name someone else's).
    ...(info.hasUserId ? ['userId: caller.userId'] : []),
  ];
  return `await ${info.fn}(input${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
}

function nextRoute(a: AdapterInput): AdapterFile {
  const appDir = a.appDir ?? 'app';
  const path = `${appDir}/api/${a.alias}/route.ts`;
  const spec = importPath(path, a.clientPath, '');
  const { info } = a;
  const params = info.pathParams.length
    ? `{ ${info.pathParams.map((p) => `${JSON.stringify(p)}: url.searchParams.get(${JSON.stringify(p)}) ?? ''`).join(', ')} }`
    : '';
  const content = `${HEADER_TS(a.catalogRef)}// POST /api/${a.alias} → ${info.fn}. Runs on the server only, so SWFTE_API_KEY never reaches the browser.
import { NextResponse } from 'next/server';
import { ${info.fn}, type ${info.inputType} } from ${JSON.stringify(spec)};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

${TS_RESULT_STATUS}
${TS_AUTHORIZE('Request', 'read the session cookie or verify a bearer token.')}
export async function POST(request: Request) {
  const caller = await authorize(request);
  if (!caller) return NextResponse.json({ error: ${JSON.stringify(UNAUTHORIZED)} }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }
  const input = body as unknown as ${info.inputType};${info.pathParams.length ? '\n  const url = new URL(request.url);' : ''}
  try {
    const result = ${tsCall(info, params)};
    return NextResponse.json(
      { ok: result.ok, status: result.status, executionId: result.executionId ?? null, output: result.output ?? null${info.chat ? ', reply: result.reply ?? null' : ''} },
      { status: httpStatus(result) }
    );
  } catch (err) {
    // Details stay in the server log; the caller gets a generic failure.
    console.error('[swfte] ${a.alias} failed', err);
    return NextResponse.json({ error: 'Upstream Swfte call failed.' }, { status: 502 });
  }
}
`;
  return { path, content };
}

function expressRouter(a: AdapterInput): AdapterFile {
  const path = `${a.outDir}/${a.alias}.router.ts`;
  const spec = importPath(path, a.clientPath, a.esm ? '.js' : '');
  const { info } = a;
  const routerName = `${info.fn.replace(/^(invoke|chat)/, '').replace(/^./, (c) => c.toLowerCase())}Router`;
  const params = info.pathParams.length
    ? `{ ${info.pathParams.map((p) => `${JSON.stringify(p)}: String(req.query[${JSON.stringify(p)}] ?? '')`).join(', ')} }`
    : '';
  const content = `${HEADER_TS(a.catalogRef)}// Mount it: app.use('/api/${a.alias}', ${routerName}); then POST /api/${a.alias} with the input as JSON.
import { Router, json, type Request, type Response } from 'express';
import { ${info.fn}, type ${info.inputType} } from ${JSON.stringify(spec)};

${TS_RESULT_STATUS}
${TS_AUTHORIZE('Request', 'return { userId: req.user.id } after your session or JWT middleware ran.')}
export const ${routerName} = Router();
${routerName}.use(json());

${routerName}.post('/', async (req: Request, res: Response) => {
  const caller = await authorize(req);
  if (!caller) {
    res.status(401).json({ error: ${JSON.stringify(UNAUTHORIZED)} });
    return;
  }
  const body: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {};
  const input = body as unknown as ${info.inputType};
  try {
    const result = ${tsCall(info, params)};
    res
      .status(httpStatus(result))
      .json({ ok: result.ok, status: result.status, executionId: result.executionId ?? null, output: result.output ?? null${info.chat ? ', reply: result.reply ?? null' : ''} });
  } catch (err) {
    // Details stay in the server log; the caller gets a generic failure.
    console.error('[swfte] ${a.alias} failed', err);
    res.status(502).json({ error: 'Upstream Swfte call failed.' });
  }
});

export default ${routerName};
`;
  return { path, content };
}

function fastapiRouter(a: AdapterInput): AdapterFile[] {
  const moduleName = posix.basename(a.clientPath).replace(/\.py$/, '');
  const path = `${a.outDir}/${moduleName}_router.py`;
  const { info } = a;
  const call = [
    info.fn,
    'body',
    ...(info.pathParams.length ? [`{${info.pathParams.map((p) => `${JSON.stringify(p)}: request.query_params.get(${JSON.stringify(p)}, "")`).join(', ')}}`] : []),
  ];
  // Conversation owner: the caller authorize() recognised, never the request body (a caller could name someone else's).
  const userArg = info.hasUserId ? ', user_id=caller["user_id"]' : '';
  const content = `${HEADER_PY(a.catalogRef)}# Mount it: app.include_router(router) from this module; then POST /swfte/${a.alias} with the input as JSON.
from __future__ import annotations

import functools
import logging
from typing import Any, Dict, Optional, TypedDict

from fastapi import APIRouter, Body, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

try:  # the output directory is a package (it has __init__.py)
    from .${moduleName} import ${info.fn}
except ImportError:  # the output directory is on sys.path instead
    from ${moduleName} import ${info.fn}  # type: ignore[no-redef]

logger = logging.getLogger("swfte")
router = APIRouter(prefix="/swfte/${a.alias}", tags=["swfte"])


def _http_status(result: Dict[str, Any]) -> int:
    if result.get("ok"):
        return 200
    status = str(result.get("status") or "")
    if status == "ACCEPTED" or any(w in status for w in ("WAIT", "PAUSE", "AWAIT")):
        return 202
    return 502


class Caller(TypedDict):
    \"\"\"The caller authorize() recognised. user_id also owns the conversation when the artifact is an agent.\"\"\"

    user_id: str


async def authorize(request: Request) -> Optional[Caller]:
    \"\"\"Who may call this route: the caller for an authenticated request, or None to refuse it (401).

    It refuses everyone until you connect it to your auth, e.g. verify the session or bearer token on request.
    \"\"\"
    return None


@router.post("")
async def ${info.fn}_route(request: Request, body: Dict[str, Any] = Body(...)) -> JSONResponse:
    caller = await authorize(request)
    if caller is None:
        return JSONResponse({"error": ${JSON.stringify(UNAUTHORIZED)}}, status_code=401)
    try:
        # The generated client is synchronous (stdlib urllib); keep it off the event loop.
        result = await run_in_threadpool(functools.partial(${call.join(', ')}${userArg}))
    except Exception:  # details stay in the server log; the caller gets a generic failure
        logger.exception("swfte ${a.alias} failed")
        return JSONResponse({"error": "Upstream Swfte call failed."}, status_code=502)
    return JSONResponse(
        {
            "ok": result["ok"],
            "status": result["status"],
            "executionId": result.get("execution_id"),
            "output": result.get("output"),${info.chat ? '\n            "reply": result.get("reply"),' : ''}
        },
        status_code=_http_status(result),
    )
`;
  return [
    { path, content },
    // Makes the relative import above work; never overwrites an existing package marker.
    { path: `${a.outDir}/__init__.py`, content: '', ifMissing: true },
  ];
}

export function planAdapter(a: AdapterInput): AdapterPlan {
  switch (a.framework) {
    case 'nextjs': {
      const f = nextRoute(a);
      return { files: [f], usage: `POST /api/${a.alias} (route handler ${f.path}); or import ${a.info.fn} from ${a.clientPath} in server code.` };
    }
    case 'express': {
      const f = expressRouter(a);
      return { files: [f], usage: `Mount the router from ${f.path}: app.use('/api/${a.alias}', router). Or call ${a.info.fn} from ${a.clientPath} directly.` };
    }
    case 'fastapi': {
      const files = fastapiRouter(a);
      return { files, usage: `app.include_router(router) from ${files[0]!.path} → POST /swfte/${a.alias}. Or call ${a.info.fn} from ${a.clientPath} directly.` };
    }
    default:
      return {
        files: [],
        usage:
          a.info.language === 'python'
            ? `from ${posix.basename(a.clientPath, '.py')} import ${a.info.fn}; ${a.info.fn}({...}) — server-side only.`
            : `import { ${a.info.fn} } from './${posix.basename(a.clientPath, '.ts')}'; await ${a.info.fn}({...}) — server-side only.`,
      };
  }
}
