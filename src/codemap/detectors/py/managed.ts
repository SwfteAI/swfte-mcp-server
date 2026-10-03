/**
 * Python managed call sites: the Swfte SDK (`client.workflows.invoke`, `agents.chat`, ...) and callers
 * of generated typed clients (imports that resolve to files listed in `swfte.json`). Also reports the
 * generated client's own HTTP call as an Implementation (never a site).
 */
import { posix } from 'node:path';
import { numericVersion, literalRevision } from '../../revisions.js';
import type { DetectedSite, DetectContext, Implementation, LockBinding, Op } from '../../types.js';
import { inputKeys, outputKeys } from './keys.js';
import { children, evalPieces, isBroken, lineOf, literalOf, symbolOf, walk, type PyNode, type Piece } from './parse.js';

export interface PySite extends Omit<DetectedSite, 'relPath' | 'detector'> {
  /** Which detector id suffix reports it. */
  source: 'managed' | 'raw-http' | 'widget';
}

const ID_OK = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;

export interface IdInfo {
  id: string | null;
  unresolved: boolean;
  envVarName?: string;
}

/** Artifact id from an expression: a literal, else unresolved (env name only when visible). */
export function idFromPieces(ps: Piece[]): IdInfo {
  const lit = literalOf(ps);
  if (lit !== null && ID_OK.test(lit)) return { id: lit, unresolved: false };
  if (ps.length === 1 && ps[0]!.k === 'env') return { id: null, unresolved: true, envVarName: ps[0]!.name };
  return { id: null, unresolved: true };
}

function argsOf(call: PyNode): { pos: PyNode[]; kw: Map<string, PyNode> } {
  const pos: PyNode[] = [];
  const kw = new Map<string, PyNode>();
  const a = call.childForFieldName('arguments');
  for (const c of a ? children(a) : []) {
    if (c.type === 'keyword_argument') {
      const n = c.childForFieldName('name');
      const v = c.childForFieldName('value');
      if (n && v) kw.set(n.text, v);
    } else if (c.type !== 'comment') pos.push(c);
  }
  return { pos, kw };
}

interface SdkMethod {
  kind: string;
  op: Op;
  idKw: string[];
  inputPos: number | null;
  inputKw: string[];
  versioned?: boolean;
}

const WF_ID = ['workflow_id', 'id'];
const SDK_METHODS: Record<string, Record<string, SdkMethod>> = {
  workflows: {
    invoke: { kind: 'workflow', op: 'run', idKw: WF_ID, inputPos: 1, inputKw: ['inputs', 'input_data', 'data', 'input'] },
    invoke_and_wait: { kind: 'workflow', op: 'run', idKw: WF_ID, inputPos: 1, inputKw: ['inputs', 'input_data', 'data', 'input'] },
    invoke_version: { kind: 'workflow', op: 'run', idKw: WF_ID, inputPos: 2, inputKw: ['inputs'], versioned: true },
    invoke_version_and_wait: { kind: 'workflow', op: 'run', idKw: WF_ID, inputPos: 2, inputKw: ['inputs'], versioned: true },
    invoke_async: { kind: 'workflow', op: 'run', idKw: WF_ID, inputPos: 1, inputKw: ['inputs', 'input_data', 'data', 'input'] },
    execute: { kind: 'workflow', op: 'run', idKw: WF_ID, inputPos: 1, inputKw: ['inputs', 'input_data', 'data', 'input'] },
    stream: { kind: 'workflow', op: 'stream', idKw: WF_ID, inputPos: 1, inputKw: ['inputs', 'input_data', 'data', 'input'] },
    invoke_stream: { kind: 'workflow', op: 'stream', idKw: WF_ID, inputPos: 1, inputKw: ['inputs', 'input_data', 'data', 'input'] },
    get_execution_history: { kind: 'workflow', op: 'read-output', idKw: WF_ID, inputPos: null, inputKw: [] },
  },
  agents: {
    chat: { kind: 'agent', op: 'chat', idKw: ['agent_id', 'id'], inputPos: null, inputKw: [] },
    chat_stream: { kind: 'agent', op: 'stream', idKw: ['agent_id', 'id'], inputPos: null, inputKw: [] },
    stream_chat: { kind: 'agent', op: 'stream', idKw: ['agent_id', 'id'], inputPos: null, inputKw: [] },
    stream: { kind: 'agent', op: 'stream', idKw: ['agent_id', 'id'], inputPos: null, inputKw: [] },
  },
  chatflows: {
    start_session: { kind: 'chatflow', op: 'chat', idKw: ['chatflow_id', 'chat_flow_id', 'id'], inputPos: 2, inputKw: ['context'] },
    test: { kind: 'chatflow', op: 'chat', idKw: ['chatflow_id', 'id'], inputPos: 1, inputKw: ['input'] },
  },
};

function sdkShape(call: PyNode): { method: SdkMethod } | null {
  const f = call.childForFieldName('function');
  if (!f || f.type !== 'attribute') return null;
  const name = f.childForFieldName('attribute')?.text ?? '';
  const recv = f.childForFieldName('object');
  if (!recv || recv.type !== 'attribute') return null;
  const group = recv.childForFieldName('attribute')?.text ?? '';
  const m = SDK_METHODS[group]?.[name];
  return m ? { method: m } : null;
}

// ---------------------------------------------------------------------------------------------
// Typed clients: imports resolved against the lock's generated files.

interface ImportBinding {
  local: string;
  /** candidate repo-relative module paths (without extension), most specific first */
  module: string[];
  /** set when `from M import f` (f a name inside M), null when the binding is a module itself */
  member: string | null;
}

function dotted(n: PyNode | null): string {
  return n ? n.text.replace(/\s+/g, '') : '';
}

function resolveModule(mod: string, relPath: string): string | null {
  const m = /^(\.*)(.*)$/.exec(mod)!;
  const dots = m[1]!.length;
  const rest = m[2]!.replace(/\./g, '/');
  if (dots === 0) return rest;
  let dir = posix.dirname(relPath);
  for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
  return posix.normalize(posix.join(dir === '.' ? '' : dir, rest));
}

function importBindings(root: PyNode, relPath: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  walk(root, (st) => {
    if (st.type === 'import_from_statement') {
      const modNode = st.childForFieldName('module_name');
      const base = resolveModule(dotted(modNode), relPath);
      if (base === null) return false;
      for (const nm of st.childrenForFieldName('name')) {
        if (!nm) continue;
        const orig = nm.type === 'aliased_import' ? nm.childForFieldName('name') : nm;
        const alias = nm.type === 'aliased_import' ? nm.childForFieldName('alias') : nm;
        if (!orig || !alias) continue;
        const o = orig.text;
        // `from pkg import mod` (module) or `from pkg.mod import func` (member)
        out.push({ local: alias.text, module: [base], member: o });
        out.push({ local: alias.text, module: [`${base ? `${base}/` : ''}${o}`], member: null });
      }
      return false;
    }
    if (st.type === 'import_statement') {
      for (const nm of st.childrenForFieldName('name')) {
        if (!nm) continue;
        if (nm.type === 'aliased_import') {
          const orig = nm.childForFieldName('name');
          const alias = nm.childForFieldName('alias');
          if (orig && alias) out.push({ local: alias.text, module: [dotted(orig).replace(/\./g, '/')], member: null });
        }
      }
      return false;
    }
    return undefined;
  });
  return out;
}

function lockForModule(modulePath: string, locks: LockBinding[]): LockBinding | null {
  const cands = [`${modulePath}.py`, `${modulePath}/__init__.py`];
  for (const l of locks) {
    for (const f of l.files) {
      if (cands.some((c) => f === c || f.endsWith(`/${c}`))) return l;
    }
  }
  return null;
}

const TYPED_FN = /^(invoke|chat)_[A-Za-z0-9_]+$/;

function splitRef(ref: string): { kind: string; id: string } | null {
  const i = ref.indexOf(':');
  return i > 0 && i < ref.length - 1 ? { kind: ref.slice(0, i), id: ref.slice(i + 1) } : null;
}

function calleeTyped(call: PyNode, bindings: ImportBinding[], locks: LockBinding[]): { lock: LockBinding; fn: string } | null {
  const f = call.childForFieldName('function');
  if (!f) return null;
  if (f.type === 'identifier') {
    for (const b of bindings) {
      if (b.local !== f.text || b.member === null || !TYPED_FN.test(b.member)) continue;
      const lock = lockForModule(b.module[0]!, locks);
      if (lock) return { lock, fn: b.member };
    }
    return null;
  }
  if (f.type === 'attribute') {
    const obj = f.childForFieldName('object');
    const fn = f.childForFieldName('attribute')?.text ?? '';
    if (obj?.type !== 'identifier' || !TYPED_FN.test(fn)) return null;
    for (const b of bindings) {
      if (b.local !== obj.text || b.member !== null) continue;
      const lock = lockForModule(b.module[0]!, locks);
      if (lock) return { lock, fn };
    }
  }
  return null;
}

function mkSite(call: PyNode, fields: Omit<PySite, 'line' | 'symbol' | 'language' | 'source'>): PySite {
  return { line: lineOf(call), symbol: symbolOf(call), language: 'python', source: 'managed', ...fields };
}

export function detectManaged(root: PyNode, relPath: string, ctx: DetectContext, swfteImported: boolean): { sites: PySite[]; implementations: Implementation[] } {
  const sites: PySite[] = [];
  const implementations: Implementation[] = [];

  // A file the lock lists is the generated client: its own urlopen is the implementation.
  const own = ctx.locks.find((l) => l.files.includes(relPath));
  if (own) {
    walk(root, (n) => {
      if (n.type === 'call' && /(?:^|\.)urlopen$/.test(n.childForFieldName('function')?.text ?? '')) implementations.push({ relPath, line: lineOf(n), alias: own.alias });
      return undefined;
    });
    return { sites, implementations };
  }

  const bindings = importBindings(root, relPath);
  walk(root, (call) => {
    if (call.type !== 'call' || isBroken(call)) return undefined;
    const typed = calleeTyped(call, bindings, ctx.locks);
    if (typed) {
      const ref = splitRef(typed.lock.catalogRef);
      if (!ref) return undefined;
      const { pos, kw } = argsOf(call);
      const isChat = typed.fn.startsWith('chat_');
      const input = pos[0] ?? kw.get('inputs') ?? null;
      sites.push(
        mkSite(call, {
          category: 'managed',
          sdk: 'python',
          op: isChat ? 'chat' : 'run',
          managed: 'typed-client',
          artifact: { kind: ref.kind, id: ref.id, unresolved: false, pinnedVersion: typed.lock.pinnedVersion, alias: typed.lock.alias },
          contractHash: typed.lock.contractHash,
          inputKeys: input ? inputKeys(input) : [],
          outputKeys: outputKeys(call),
        }),
      );
      return undefined;
    }
    if (!swfteImported) return undefined;
    const sdk = sdkShape(call);
    if (!sdk) return undefined;
    const m = sdk.method;
    const { pos, kw } = argsOf(call);
    const idExpr = pos[0] ?? m.idKw.map((k) => kw.get(k)).find(Boolean) ?? null;
    if (!idExpr) return undefined;
    const info = idFromPieces(evalPieces(idExpr));
    const version = pos[1] ?? kw.get('version');
    const numeric = version?.type === 'integer' && /^[1-9][0-9]*$/.test(version.text) ? Number(version.text) : NaN;
    const pin = m.versioned ? numericVersion(numeric) ?? (version ? literalRevision(literalOf(evalPieces(version))) : null) : null;
    const unresolved = info.unresolved || Boolean(m.versioned && pin === null);
    let inKeys: string[] = [];
    if (m.inputPos !== null || m.inputKw.length) {
      const inputExpr = (m.inputPos !== null ? pos[m.inputPos] : undefined) ?? m.inputKw.map((k) => kw.get(k)).find(Boolean) ?? null;
      inKeys = inputExpr ? inputKeys(inputExpr) : [];
    }
    sites.push(
      mkSite(call, {
        category: unresolved ? 'dynamic' : 'managed',
        sdk: 'python',
        op: m.op,
        managed: 'typed-client',
        artifact: { kind: m.kind, id: unresolved ? null : info.id, unresolved, ...(info.envVarName ? { envVarName: info.envVarName } : {}), pinnedVersion: pin, alias: null },
        contractHash: null,
        inputKeys: inKeys,
        outputKeys: m.op === 'read-output' ? [] : outputKeys(call),
      }),
    );
    return undefined;
  });
  return { sites, implementations };
}
