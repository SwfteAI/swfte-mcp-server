/**
 * Java managed call sites: the Swfte Java SDK (`client.workflows().invoke(...)`, `client.agents().chat(...)`,
 * `client.chatflows().startSession(...)`). There is no generated Java client, so every managed site is an
 * SDK site (`alias: null`). An id that is not a literal or a same-file constant is unresolved, never guessed.
 */
import type { DetectedSite, Op } from '../../types.js';
import { numericVersion, literalRevision } from '../../revisions.js';
import { inputKeys, outputKeys } from './keys.js';
import { argsOf, evalPieces, isBroken, lineOf, literalOf, nameOf, symbolOf, walk, type JNode, type Piece } from './parse.js';

export interface JavaSite extends Omit<DetectedSite, 'relPath' | 'detector'> {
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

interface SdkMethod {
  kind: string;
  op: Op;
  /** index of the inputs argument, null when the call takes none */
  inputAt: number | null;
  versioned?: boolean;
}

const SDK_METHODS: Record<string, Record<string, SdkMethod>> = {
  workflows: {
    invoke: { kind: 'workflow', op: 'run', inputAt: 1 },
    invokeAndWait: { kind: 'workflow', op: 'run', inputAt: 1 },
    invokeVersion: { kind: 'workflow', op: 'run', inputAt: 2, versioned: true },
    invokeVersionAndWait: { kind: 'workflow', op: 'run', inputAt: 2, versioned: true },
    invokeAsync: { kind: 'workflow', op: 'run', inputAt: 1 },
    execute: { kind: 'workflow', op: 'run', inputAt: 1 },
    executeAsync: { kind: 'workflow', op: 'run', inputAt: 1 },
    stream: { kind: 'workflow', op: 'stream', inputAt: 1 },
    invokeStream: { kind: 'workflow', op: 'stream', inputAt: 1 },
    getExecutionHistory: { kind: 'workflow', op: 'read-output', inputAt: null },
  },
  agents: {
    chat: { kind: 'agent', op: 'chat', inputAt: null },
    chatStream: { kind: 'agent', op: 'stream', inputAt: null },
    stream: { kind: 'agent', op: 'stream', inputAt: null },
  },
  chatflows: {
    startSession: { kind: 'chatflow', op: 'chat', inputAt: 1 },
  },
};

/** `<expr>.workflows().invoke(...)`: the resource group and the method, when the shape matches. */
function sdkShape(call: JNode): SdkMethod | null {
  const recv = call.childForFieldName('object');
  if (!recv || recv.type !== 'method_invocation' || argsOf(recv).length !== 0 || !recv.childForFieldName('object')) return null;
  if (nameOf(recv) === 'builder' && nameOf(call) === 'test') {
    const group = recv.childForFieldName('object');
    return group?.type === 'method_invocation' && nameOf(group) === 'chatflows' && argsOf(group).length === 0
      && group.childForFieldName('object') ? { kind: 'chatflow', op: 'chat', inputAt: 1 } : null;
  }
  return SDK_METHODS[nameOf(recv)]?.[nameOf(call)] ?? null;
}

export function detectManaged(root: JNode, swfteImported: boolean): JavaSite[] {
  if (!swfteImported) return [];
  const sites: JavaSite[] = [];
  walk(root, (call) => {
    if (call.type !== 'method_invocation' || isBroken(call)) return undefined;
    const m = sdkShape(call);
    if (!m) return undefined;
    const args = argsOf(call);
    const idExpr = args[0];
    if (!idExpr) return undefined;
    const info = idFromPieces(evalPieces(idExpr));
    const version = args[1];
    const numeric = version?.type === 'decimal_integer_literal' && /^[1-9][0-9]*$/.test(version.text) ? Number(version.text) : NaN;
    const pin = m.versioned ? numericVersion(numeric) ?? (version ? literalRevision(literalOf(evalPieces(version))) : null) : null;
    const unresolved = info.unresolved || Boolean(m.versioned && pin === null);
    const inKeys = m.inputAt === null ? [] : args[m.inputAt] ? inputKeys(args[m.inputAt]!) : [];
    sites.push({
      source: 'managed',
      line: lineOf(call),
      symbol: symbolOf(call),
      language: 'java',
      category: unresolved ? 'dynamic' : 'managed',
      sdk: 'java',
      op: m.op,
      managed: 'typed-client',
      artifact: { kind: m.kind, id: unresolved ? null : info.id, unresolved, ...(info.envVarName ? { envVarName: info.envVarName } : {}), pinnedVersion: pin, alias: null },
      contractHash: null,
      inputKeys: inKeys,
      outputKeys: m.op === 'read-output' ? [] : outputKeys(call),
    });
    return undefined;
  });
  return sites;
}
