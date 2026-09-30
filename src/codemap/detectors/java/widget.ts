/**
 * Widget embeds held in Java string templates and text blocks: `<script>` bootstraps calling
 * `new SwfteChatWidget`, `<iframe src="https://app.swfte.com/chat/<id>">`, React component markup. Comments
 * are not strings and never count; a `String.format` hole (`%s`) makes the id dynamic.
 */
import { findEmbeds, hasEmbedMarker, type Seg } from '../py/embed.js';
import type { JavaSite } from './managed.js';
import { children, evalPieces, isBroken, symbolOf, unescapeJava, walk, type JNode } from './parse.js';

function segsOf(n: JNode, out: Seg[], depth: number): void {
  if (depth > 12) {
    out.push({ text: '', row: n.startPosition.row, dyn: true, multiline: false });
    return;
  }
  switch (n.type) {
    case 'string_literal':
      for (const c of children(n)) {
        if (c.type === 'string_fragment' || c.type === 'multiline_string_fragment') {
          out.push({ text: c.text, row: c.startPosition.row, dyn: false, multiline: c.type === 'multiline_string_fragment' });
        } else if (c.type === 'escape_sequence') {
          out.push({ text: unescapeJava(c.text), row: c.startPosition.row, dyn: false, multiline: false });
        }
      }
      return;
    case 'parenthesized_expression': {
      const inner = children(n)[0];
      if (inner) segsOf(inner, out, depth + 1);
      return;
    }
    case 'binary_expression': {
      const l = n.childForFieldName('left');
      const r = n.childForFieldName('right');
      if (n.childForFieldName('operator')?.text === '+' && l && r) {
        segsOf(l, out, depth + 1);
        segsOf(r, out, depth + 1);
        return;
      }
      out.push({ text: '', row: n.startPosition.row, dyn: true, multiline: false });
      return;
    }
    default: {
      const ps = evalPieces(n);
      if (ps.length > 0 && ps.every((p) => p.k === 'lit')) out.push({ text: ps.map((p) => (p as { v: string }).v).join(''), row: n.startPosition.row, dyn: false, multiline: false });
      else out.push({ text: '', row: n.startPosition.row, dyn: true, multiline: false });
    }
  }
}

function templateRoot(n: JNode): JNode {
  let cur = n;
  for (;;) {
    const p = cur.parent;
    if (p && p.type === 'binary_expression' && p.childForFieldName('operator')?.text === '+') cur = p;
    else if (p && p.type === 'parenthesized_expression') cur = p;
    else return cur;
  }
}

export function detectWidgets(root: JNode): JavaSite[] {
  const sites: JavaSite[] = [];
  const seen = new Set<number>();
  walk(root, (n) => {
    if (n.type === 'import_declaration' || n.type === 'package_declaration') return false;
    if (n.type !== 'string_literal') return undefined;
    const r = templateRoot(n);
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    if (!hasEmbedMarker(r.text) || isBroken(r)) return false;
    const segs: Seg[] = [];
    segsOf(r, segs, 0);
    for (const e of findEmbeds(segs)) {
      sites.push({
        source: 'widget',
        line: e.line,
        symbol: symbolOf(r),
        language: 'java',
        category: e.unresolved ? 'dynamic' : 'widget',
        sdk: 'widget-embed',
        op: 'embed',
        managed: 'typed-client',
        artifact: { kind: 'agent', id: e.id, unresolved: e.unresolved, pinnedVersion: null, alias: null },
        contractHash: null,
        inputKeys: [],
        outputKeys: [],
      });
    }
    return false;
  });
  return sites;
}
