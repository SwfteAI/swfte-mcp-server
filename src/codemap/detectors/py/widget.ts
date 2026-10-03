/**
 * Widget embeds held in Python string templates: `<script>` bootstraps calling `new SwfteChatWidget`,
 * `<iframe src="https://app.swfte.com/chat/<id>">`, React component markup. Docstrings and bare string
 * statements are not code and never count.
 */
import { findEmbeds, hasEmbedMarker, type Seg } from './embed.js';
import type { PySite } from './managed.js';
import { children, evalPieces, isBroken, symbolOf, walk, type PyNode } from './parse.js';

const isStringish = (n: PyNode): boolean => n.type === 'string' || n.type === 'concatenated_string';

function segsOf(n: PyNode, out: Seg[], depth: number): void {
  if (depth > 12) {
    out.push({ text: '', row: n.startPosition.row, dyn: true, multiline: false });
    return;
  }
  switch (n.type) {
    case 'string': {
      const prefix = (n.child(0)?.text ?? '').replace(/["']+$/, '').toLowerCase();
      const isF = prefix.includes('f');
      const triple = /^[a-zA-Z]*("""|''')/.test(n.child(0)?.text ?? '');
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (!c) continue;
        if (c.type === 'string_content') {
          let v = c.text.replace(/\\(["'\\])/g, '$1');
          if (isF) v = v.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
          out.push({ text: v, row: c.startPosition.row, dyn: false, multiline: triple });
        } else if (c.type === 'interpolation') {
          const e = c.childForFieldName('expression');
          const ps = e ? evalPieces(e) : [];
          if (ps.length > 0 && ps.every((p) => p.k === 'lit')) out.push({ text: ps.map((p) => (p as { v: string }).v).join(''), row: c.startPosition.row, dyn: false, multiline: false });
          else out.push({ text: '', row: c.startPosition.row, dyn: true, multiline: false });
        }
      }
      return;
    }
    case 'concatenated_string':
      for (const c of children(n)) segsOf(c, out, depth + 1);
      return;
    case 'parenthesized_expression': {
      const inner = children(n)[0];
      if (inner) segsOf(inner, out, depth + 1);
      return;
    }
    case 'binary_operator': {
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

function templateRoot(n: PyNode): PyNode {
  let cur = n;
  for (;;) {
    const p = cur.parent;
    if (p && p.type === 'binary_operator' && p.childForFieldName('operator')?.text === '+') cur = p;
    else if (p && p.type === 'parenthesized_expression') cur = p;
    else if (p && p.type === 'concatenated_string') cur = p;
    else return cur;
  }
}

export function detectWidgets(root: PyNode): PySite[] {
  const sites: PySite[] = [];
  const seen = new Set<number>();
  walk(root, (n) => {
    if (!isStringish(n)) return undefined;
    const r = templateRoot(n);
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    // a string nested in an f-string hole is part of its parent template
    for (let p = n.parent; p; p = p.parent) if (p.type === 'interpolation') return false;
    const stmt = r.parent;
    if (stmt && stmt.type === 'expression_statement') return false; // docstring / bare string: not code
    if (!hasEmbedMarker(r.text) || isBroken(r)) return false;
    const segs: Seg[] = [];
    segsOf(r, segs, 0);
    for (const e of findEmbeds(segs)) {
      sites.push({
        source: 'widget',
        line: e.line,
        symbol: symbolOf(r),
        language: 'python',
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
