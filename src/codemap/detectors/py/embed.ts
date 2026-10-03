/**
 * Widget embed recognition inside string templates, shared by the Python and Java detectors (no parser
 * import). A template is a list of segments (literal text or a dynamic hole); the embed's line is the
 * line of its element (`<iframe`, `new SwfteChatWidget(`, `<ChatWidget`).
 */
export interface Seg {
  text: string;
  /** 0-based source row where the segment starts. */
  row: number;
  dyn: boolean;
  /** Triple-quoted / text-block segment: newlines in `text` are real source lines. */
  multiline: boolean;
}

export interface Embed {
  /** 1-based line. */
  line: number;
  id: string | null;
  unresolved: boolean;
}

const HOLE = '\u0000';
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;

function rowOf(segs: Seg[], starts: number[], offset: number): number {
  let i = 0;
  while (i + 1 < segs.length && starts[i + 1]! <= offset) i++;
  const s = segs[i]!;
  if (!s.multiline || s.dyn) return s.row;
  const upTo = s.text.slice(0, Math.max(0, offset - starts[i]!));
  return s.row + (upTo.match(/\n/g)?.length ?? 0);
}

function idFrom(raw: string): { id: string | null; unresolved: boolean } {
  if (raw.length > 0 && !raw.includes(HOLE) && ID_OK.test(raw)) return { id: raw, unresolved: false };
  return { id: null, unresolved: true };
}

/** Text of the balanced parentheses starting at the `(` at `open`. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

export const hasEmbedMarker = (text: string): boolean => /SwfteChatWidget|app\.swfte\.com\/chat\/|<ChatWidget|<EmbeddedChat/.test(text);

export function findEmbeds(segs: Seg[]): Embed[] {
  const starts: number[] = [];
  let text = '';
  for (const s of segs) {
    starts.push(text.length);
    text += s.dyn ? HOLE : s.text;
  }
  if (!hasEmbedMarker(text)) return [];
  const out: Embed[] = [];
  const add = (offset: number, raw: string | null): void => {
    const r = raw === null ? { id: null, unresolved: true } : idFrom(raw);
    out.push({ line: rowOf(segs, starts, offset) + 1, ...r });
  };

  for (const m of text.matchAll(/new\s+SwfteChatWidget\s*\(/g)) {
    const opts = balanced(text, m.index! + m[0].length - 1);
    const p = /\bagentId\s*:\s*/.exec(opts);
    if (!p) continue;
    const rest = opts.slice(p.index + p[0].length);
    const q = /^(["'`])([^"'`]*)\1/.exec(rest);
    add(m.index!, q ? q[2]! : null);
  }

  for (const m of text.matchAll(/<iframe\b[^>]*?\bsrc\s*=\s*["']https?:\/\/app\.swfte\.com\/chat\/([^"'\s>?#/]*)/gi)) {
    add(m.index!, m[1] ?? '');
  }

  for (const m of text.matchAll(/<(?:ChatWidget|EmbeddedChat)\b[^>]*?\bagentId\s*=\s*(?:"([^"]*)"|\{\s*["'`]([^"'`]*)["'`]\s*\}|\{)/g)) {
    add(m.index!, m[1] ?? m[2] ?? null);
  }
  return out.sort((a, b) => a.line - b.line);
}
