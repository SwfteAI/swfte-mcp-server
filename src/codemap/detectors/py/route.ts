/**
 * Swfte API route recognition shared by the Python and Java raw-HTTP detectors (no parser import, so the
 * Java side never loads the Python grammar). Input is a URL as pieces: literal text, an environment
 * variable NAME, or a dynamic hole. Output names the artifact only when the path spells the id out.
 */
import type { Op } from '../../types.js';
import { pathVersion } from '../../revisions.js';

export type Piece = { k: 'lit'; v: string } | { k: 'env'; name: string } | { k: 'dyn' };

export interface SwfteRoute {
  kind: string;
  op: Op;
  /** The literal id; null when unresolved or when the path holds a `{placeholder}` for the caller to fill. */
  id: string | null;
  unresolved: boolean;
  envVarName?: string;
  /** The segment is a `{name}` URI template variable (Spring RestTemplate fills it from trailing args). */
  placeholder: boolean;
  pinnedVersion: string | null;
}

const HOLE = '\u0000';
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;
const BASE_OK = /^https?:\/\/api\.swfte\.com(?::443)?(?:\/[A-Za-z0-9_.\-/]*)?$/i;
const BASE_PATH = /^(?:\/[A-Za-z0-9_.\-/]*)?$/;

export function mergePieces(ps: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of ps) {
    const last = out[out.length - 1];
    if (p.k === 'lit' && last && last.k === 'lit') out[out.length - 1] = { k: 'lit', v: last.v + p.v };
    else out.push(p);
  }
  return out;
}

export function flatten(ps: Piece[]): { text: string; holes: Piece[] } {
  let text = '';
  const holes: Piece[] = [];
  for (const p of ps) {
    if (p.k === 'lit') text += p.v;
    else {
      text += HOLE;
      holes.push(p);
    }
  }
  return { text, holes };
}

/** True when the pieces are a Swfte API base URL (`https://api.swfte.com[/agents]` or `$SWFTE_BASE_URL[/path]`). */
export function isSwfteBase(ps: Piece[]): boolean {
  const { text, holes } = flatten(mergePieces(ps));
  if (BASE_OK.test(text)) return true;
  return holes.length === 1 && holes[0]!.k === 'env' && holes[0]!.name === 'SWFTE_BASE_URL' && text.startsWith(HOLE) && BASE_PATH.test(text.slice(1));
}

const PREFIXES: { prefix: string; kind: string }[] = [
  { prefix: '/v2/workflows/', kind: 'workflow' },
  { prefix: '/v1/public/agents/', kind: 'agent' },
  { prefix: '/v1/agents/', kind: 'agent' },
  { prefix: '/v1/widgets/', kind: 'widget' },
  { prefix: '/v2/chatflows/', kind: 'chatflow' },
];

function opFor(kind: string, seg: string[]): { op: Op; version: string | null } | null {
  const s1 = seg[1];
  switch (kind) {
    case 'workflow':
      if (s1 === 'invoke' || s1 === 'execute') return { op: 'run', version: null };
      if (s1 === 'versions' && seg[3] === 'invoke') return { op: 'run', version: seg[2] ?? null };
      if (s1 === 'executions') return { op: 'read-output', version: null };
      return null;
    case 'agent':
      if (s1 === 'chat') return { op: seg[2] === 'stream' ? 'stream' : 'chat', version: null };
      return null;
    case 'widget':
      return s1 === 'public' && seg[2] === 'invoke' ? { op: 'run', version: null } : null;
    case 'chatflow':
      return s1 === 'sessions' ? { op: 'chat', version: null } : null;
    default:
      return null;
  }
}

/**
 * Recognise a Swfte artifact route. `relative` means the caller already established that a client base
 * URL is Swfte's, so the URL itself must start at the route.
 */
export function parseSwfteRoute(ps: Piece[], relative = false): SwfteRoute | null {
  const folded = flatten(mergePieces(ps));
  const envBase = !relative && folded.text.startsWith(HOLE)
    && folded.holes[0]?.k === 'env' && folded.holes[0].name === 'SWFTE_BASE_URL';
  if (!relative && !envBase && !/^https?:\/\/api\.swfte\.com(?::443)?(?=[/?#]|$)/i.test(folded.text)) return null;
  let stem = '~swfte-hole-';
  while (folded.text.includes(stem)) stem += '_';
  let nextHole = 0;
  const templates: string[] = [];
  const symbolic = folded.text.replace(/\u0000/g, () => `${stem}${nextHole++}~`)
    .replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, value => { templates.push(value); return `${stem}template${templates.length - 1}~`; });
  const source = envBase ? `https://api.swfte.com${symbolic.slice(`${stem}0~`.length)}` : symbolic;
  let parsed: URL;
  try { parsed = new URL(source, relative ? 'https://api.swfte.com' : undefined); } catch { return null; }
  if (!BASE_OK.test(parsed.origin)) return null;
  const holes: Piece[] = envBase ? [folded.holes[0]!] : [];
  const path = parsed.pathname.replace(new RegExp(`${stem}(\\d+)~`, 'g'), (_marker, index: string) => {
    holes.push(folded.holes[Number(index)]!); return HOLE;
  }).replace(new RegExp(`${stem}template(\\d+)~`, 'g'), (_marker, index: string) => templates[Number(index)]!);
  const text = (relative ? '' : envBase ? HOLE : parsed.origin) + path;
  let best: { idx: number; prefix: string; kind: string } | null = null;
  for (const p of PREFIXES) {
    const idx = text.indexOf(p.prefix);
    if (idx >= 0 && (!best || idx < best.idx)) best = { idx, ...p };
  }
  if (!best) return null;
  const base = text.slice(0, best.idx);
  if (relative) {
    if (base !== '') return null;
  } else if (!(BASE_OK.test(base) || (holes[0]?.k === 'env' && holes[0].name === 'SWFTE_BASE_URL' && base.startsWith(HOLE) && base.split(HOLE).length === 2 && BASE_PATH.test(base.slice(1))))) {
    return null;
  }
  const afterPrefix = best.idx + best.prefix.length;
  const rest = text.slice(afterPrefix).split(/[?#]/)[0]!;
  const seg = rest.split('/');
  const holeAt = (segIndex: number): Piece | null => {
    // which hole a segment holds: count holes before it
    const before = text.slice(0, afterPrefix) + seg.slice(0, segIndex).join('/') + (segIndex ? '/' : '');
    const n = before.split(HOLE).length - 1;
    return holes[n] ?? null;
  };
  const shape = opFor(best.kind, seg);
  if (!shape) return null;
  const idSeg = seg[0] ?? '';
  let id: string | null = null;
  let unresolved = false;
  let envVarName: string | undefined;
  let placeholder = false;
  if (idSeg === HOLE) {
    unresolved = true;
    const h = holeAt(0);
    if (h && h.k === 'env') envVarName = h.name;
  } else if (idSeg.includes(HOLE)) {
    unresolved = true;
  } else if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(idSeg)) {
    placeholder = true;
  } else if (ID_OK.test(idSeg)) {
    id = idSeg;
  } else {
    return null;
  }
  const version = shape.version;
  const pinned = pathVersion(version);
  // Preserve a literal artifact ID when only its runtime version is dynamic.
  // No pin is certified, and raw HTTP impact remains cannot-check.
  const dynamicVersion = version?.includes(HOLE) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(version ?? '');
  if (seg[1] === 'versions' && pinned === null && !dynamicVersion) { id = null; unresolved = true; envVarName = undefined; }
  return { kind: best.kind, op: shape.op, id, unresolved, ...(envVarName ? { envVarName } : {}), placeholder, pinnedVersion: pinned };
}
