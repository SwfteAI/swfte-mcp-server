/**
 * The rule set.
 *
 * Every rule is a pure function of a SNAPSHOT — a plain object holding the live
 * records that were fetched once, up front. That is not a stylistic choice: it
 * is what makes the negative controls real. `mutation.mjs` takes the same
 * snapshot, breaks one thing in it, and re-runs the *identical rule body*. A
 * rule that cannot be made to fire that way is reported as broken rather than
 * as passing, because a check that cannot fail is worse than no check.
 *
 * Each rule declares:
 *   id         stable identifier, used by the mutation harness
 *   catalogue  the numbered failure mode from the X Broker engagement, or null
 *   severity   'block' | 'warn'
 *   needs      snapshot fields required; missing ones make the rule 'skip', not 'pass'
 *   run(snap)  -> Finding[]
 *
 * A rule that cannot run returns a `skip` marker. Reporting "skipped" is the
 * whole point — the X Broker gates reported reachability as passing when the
 * URL was undefined.
 */
import { classify, RESULT_ROOTED } from './taxonomy.mjs';

/* ── small helpers ───────────────────────────────────────────────────────── */

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export const tokensIn = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return [...s.matchAll(TOKEN)].map((m) => m[1].trim());
};

export const hasToken = (v) => TOKEN.test(typeof v === 'string' ? v : JSON.stringify(v ?? '')) && (TOKEN.lastIndex = 0, true);

export function* allNodes(snap) {
  for (const wf of snap.workflows ?? []) {
    const nodes = wf.record?.nodes ?? {};
    for (const [nid, node] of Object.entries(nodes)) yield { wf, nid, node };
  }
}

const cfg = (node) => node?.configuration ?? node?.config ?? {};

const find = (rule, where, detail, fix) => ({ rule: rule.id, severity: rule.severity, catalogue: rule.catalogue, where, detail, fix });

const skip = (reason) => ({ $skip: reason });

/**
 * Strip line and block comments from JS source.
 *
 * Without this, a rule that greps code for `require('crypto')` fires on a
 * comment explaining why you must not write `require('crypto')` — which is
 * precisely the substring-over-a-blob mistake the X Broker method audit found
 * thirteen times. It was found here the same way: by running the rule against a
 * real solution and reading the finding.
 */
export function stripComments(code) {
  let out = '';
  let i = 0;
  let s = null;
  while (i < code.length) {
    const ch = code[i];
    const nx = code[i + 1];
    if (s) {
      out += ch;
      if (ch === '\\') { out += nx ?? ''; i += 2; continue; }
      if (ch === s) s = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { s = ch; out += ch; i++; continue; }
    if (ch === '/' && nx === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue; }
    out += ch;
    i++;
  }
  return out;
}

const lastWord = (s) => String(s).trim().replace(/^["']|["']$/g, '').split(/[\s\n]+/).pop() ?? '';

/** Levenshtein, capped — only used to spot a table-name typo. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let carry = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, carry + (a[i - 1] === b[j - 1] ? 0 : 1));
      carry = t;
    }
  }
  return prev[b.length];
}

/**
 * Top-level keys of the object a JS/code node returns.
 *
 * Needed because `{{node.field}}` is only *definitely* wrong when `field` is a
 * key of the returned object — the executor files that under `outputs.result`
 * (CodeNodeExecutor.java:99) while also merging genuinely-exported variables at
 * the same level (:103). Restricting the rule to returned keys keeps it from
 * firing on a legitimate exported variable.
 */
export function returnedKeys(rawCode) {
  if (typeof rawCode !== 'string') return [];
  // Comments first. A comment inside the returned object literal that happens
  // to contain a ":" or a "," swallowed the key that followed it, so a
  // correctly-written node came back as "cannot determine" and produced a
  // warning on a correct artifact. Found on solution two.
  const code = stripComments(rawCode);
  const keys = new Set();
  const re = /return\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let inStr = null;
    let start = i + 1;
    let atTop = true;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '{' || ch === '[' || ch === '(') { depth++; continue; }
      if (ch === '}' || ch === ']' || ch === ')') {
        depth--;
        if (depth === 0) break;
        continue;
      }
    }
    const body = code.slice(start, i);
    // top-level `key:` / `"key":` / shorthand `key,` at nesting depth 0 of body
    let d = 0;
    let s = null;
    let tok = '';
    for (let k = 0; k < body.length; k++) {
      const ch = body[k];
      if (s) { if (ch === '\\') k++; else if (ch === s) s = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { s = ch; tok += ch === '`' ? '' : ''; continue; }
      if ('{[('.includes(ch)) { d++; tok = ''; continue; }
      if ('}])'.includes(ch)) { d--; tok = ''; continue; }
      // Take the LAST word before the delimiter, not the whole accumulation:
      // leading whitespace, newlines and stripped-comment remnants otherwise
      // make a perfectly good key fail the identifier test.
      if (d === 0 && ch === ':') { const t = lastWord(tok); if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.add(t); tok = ''; continue; }
      if (d === 0 && ch === ',') { const t = lastWord(tok); if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.add(t); tok = ''; continue; }
      tok += ch;
    }
    const t = lastWord(tok);
    if (d === 0 && /^[A-Za-z_$][\w$]*$/.test(t)) keys.add(t);
    atTop; // eslint no-unused
  }
  return [...keys];
}

/* ── the rules ───────────────────────────────────────────────────────────── */

export const RULES = [];
const rule = (r) => { RULES.push(r); return r; };

/* --- 1. CODE node results live under `.result.` ------------------------- */
rule({
  id: 'DT-CODE-RESULT-ROOT',
  catalogue: 1,
  severity: 'block',
  title: 'a {{node.field}} reference to a code node that files that field under .result',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const wf of snap.workflows ?? []) {
      const nodes = wf.record?.nodes ?? {};
      const returns = {};
      for (const [nid, n] of Object.entries(nodes)) {
        if (RESULT_ROOTED.has(String(n.type).toUpperCase())) returns[nid] = returnedKeys(cfg(n).code);
      }
      if (Object.keys(returns).length === 0) continue;
      for (const [nid, n] of Object.entries(nodes)) {
        for (const tok of tokensIn(cfg(n))) {
          const parts = tok.split('.').map((p) => p.trim());
          if (parts.length < 2) continue;
          const [head, second] = parts;
          if (!(head in returns)) continue;
          if (second === 'result') continue;
          if (!returns[head].includes(second)) continue;
          out.push(
            find(
              this,
              `${wf.key}/${nid}`,
              `{{${tok}}} — "${second}" is a key of the object node "${head}" returns, and the executor files that object under outputs.result (CodeNodeExecutor.java:99). This path resolves to null, is written as "", and the node still reports COMPLETED.`,
              `use {{${head}.result.${parts.slice(1).join('.')}}}`
            )
          );
        }
      }
    }
    return out;
  },
});

/* --- 2. rows given as an object/array bypasses template resolution ------- */
rule({
  id: 'DT-ROWS-NOT-STRING',
  catalogue: 2,
  severity: 'block',
  title: 'DATA_TABLE rows carrying {{…}} while not being a String',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const { wf, nid, node } of allNodes(snap)) {
      if (String(node.type).toUpperCase() !== 'DATA_TABLE') continue;
      const c = cfg(node);
      if (!('rows' in c)) continue;
      if (typeof c.rows === 'string') continue;
      const toks = tokensIn(c.rows);
      if (toks.length === 0) continue;
      out.push(
        find(
          this,
          `${wf.key}/${nid}`,
          `rows is a ${Array.isArray(c.rows) ? 'JSON array' : 'JSON object'} containing ${toks.length} template token(s) (${toks.slice(0, 3).join(', ')}). extractRows only calls resolveTemplate when rows is a String (DataTableNodeExecutor.java:270); a non-String is passed through untouched, so the literal text "{{…}}" lands in the column and the insert reports success.`,
          'send rows as a JSON *string* whose {{…}} tokens the executor resolves before parsing'
        )
      );
    }
    return out;
  },
});

/* --- 3. rows as a bare {{ref}} stringifies a Java List ------------------- */
rule({
  id: 'DT-ROWS-BARE-REF',
  catalogue: 3,
  severity: 'block',
  title: 'DATA_TABLE rows that is a single bare {{ref}}',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const { wf, nid, node } of allNodes(snap)) {
      if (String(node.type).toUpperCase() !== 'DATA_TABLE') continue;
      const c = cfg(node);
      if (typeof c.rows !== 'string') continue;
      const t = c.rows.trim();
      if (!/^\{\{[^{}]+\}\}$/.test(t)) continue;
      // A bare reference is only broken when what it resolves to is not JSON
      // TEXT. `{{shape.result.rowsJson}}` where the upstream code node returns
      // `rowsJson: JSON.stringify(rows)` is the correct idiom and must not be
      // flagged — a rule that fires on correct artifacts teaches people to skip
      // it, and then it misses the real one too.
      const path = t.slice(2, -2).trim().split('.').map((p) => p.trim());
      const src = wf.record?.nodes?.[path[0]];
      const verdict = emitsJsonText(src, path);
      if (verdict === 'json-text') continue;
      out.push({
        ...find(
          this,
          `${wf.key}/${nid}`,
          verdict === 'not-text'
            ? `rows = ${t} — a bare reference to a value that is not a string. resolveTemplate substitutes val.toString(), so a Java List becomes "[{a=b, c=d}]", which is not JSON. parseJson returns null (DataTableNodeExecutor.java:272,309), extractRows yields an empty list, and the node reports {inserted: 0, success: true}.`
            : `rows = ${t} — a bare reference whose resolved type cannot be determined statically. If it is anything but JSON *text*, resolveTemplate stringifies it with Java toString(), parseJson returns null, zero rows are inserted and the node still reports success. Read the table back before believing it.`,
          'have the upstream node return JSON.stringify(rows) and reference that key, or inline literal JSON around the tokens'
        ),
        severity: verdict === 'not-text' ? 'block' : 'warn',
      });
    }
    return out;
  },
});

/**
 * Does `{{head.result.key}}` resolve to JSON *text*?
 *
 * 'json-text'  the upstream code node returns `key: JSON.stringify(…)`
 * 'not-text'   the upstream code node returns `key: [ … ]` or an array variable
 * 'unknown'    cannot be determined statically — reported as a warning, never
 *              silently passed
 */
export function emitsJsonText(srcNode, path) {
  if (!srcNode || !RESULT_ROOTED.has(String(srcNode.type).toUpperCase())) return 'unknown';
  if (path[1] !== 'result' || path.length !== 3) return 'unknown';
  const code = (srcNode.configuration ?? srcNode.config ?? {}).code;
  if (typeof code !== 'string') return 'unknown';
  const key = path[2];
  if (!returnedKeys(code).includes(key)) return 'unknown';

  // `key: <expr>` — an explicit value in the returned object
  const explicit = new RegExp(`(?:^|[\\s,{])["']?${key}["']?\\s*:\\s*([^,\\n]+)`).exec(code);
  const classifyExpr = (raw) => {
    const expr = String(raw).trim();
    if (/JSON\s*\.\s*stringify\s*\(/.test(expr)) return 'json-text';
    if (/^\[|^\{/.test(expr)) return 'not-text';
    if (/^['"`]/.test(expr)) return 'json-text';
    return null;
  };
  if (explicit) {
    const v = classifyExpr(explicit[1]);
    if (v) return v;
  }

  // shorthand `{ key }`, or `key: someVar` — follow one local assignment
  const varName = explicit && /^[A-Za-z_$][\w$]*$/.test(explicit[1].trim()) ? explicit[1].trim() : key;
  const asg = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*([^;\\n]+)`).exec(code);
  if (asg) {
    const v = classifyExpr(asg[1]);
    if (v) return v;
    if (/\.map\s*\(|\.filter\s*\(|\.slice\s*\(/.test(asg[1])) return 'not-text';
  }
  return 'unknown';
}

/* --- 4. filter and set are never template-resolved ----------------------- */
rule({
  id: 'DT-FILTER-SET-TEMPLATED',
  catalogue: 4,
  severity: 'block',
  title: 'DATA_TABLE filter/set carrying template tokens',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const { wf, nid, node } of allNodes(snap)) {
      if (String(node.type).toUpperCase() !== 'DATA_TABLE') continue;
      const c = cfg(node);
      for (const key of ['filter', 'set']) {
        if (!(key in c)) continue;
        const toks = tokensIn(c[key]);
        if (toks.length === 0) continue;
        out.push(
          find(
            this,
            `${wf.key}/${nid}`,
            `${key} contains ${toks.length} template token(s) (${toks.slice(0, 3).join(', ')}). extractMapList/parseMap never call resolveTemplate (DataTableNodeExecutor.java:289,305), so the query matches the literal string "{{…}}" and returns/updates nothing.`,
            `resolve the value upstream and inline it, or use a query the executor can express without templating ${key}`
          )
        );
      }
    }
    return out;
  },
});

/* --- 5. tables are addressed by name; a typo mints a new empty one ------- */
rule({
  id: 'DT-TABLE-NAME',
  catalogue: 5,
  severity: 'block',
  title: 'a DATA_TABLE tableName that is undeclared, templated, or a near-duplicate',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    const used = new Map(); // name -> [where]
    for (const { wf, nid, node } of allNodes(snap)) {
      if (String(node.type).toUpperCase() !== 'DATA_TABLE') continue;
      const name = cfg(node).tableName;
      if (typeof name !== 'string' || !name.trim()) {
        out.push(find(this, `${wf.key}/${nid}`, 'tableName is absent or blank — the node fails at runtime with "data-table requires a tableName".', 'set configuration.tableName'));
        continue;
      }
      if (tokensIn(name).length) {
        out.push(
          find(this, `${wf.key}/${nid}`, `tableName "${name}" is templated. createTable is get-or-create (DataTableNodeExecutor.java:192), so any resolution you did not expect silently mints a brand-new empty table and reports success.`, 'use a literal table name')
        );
        continue;
      }
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(`${wf.key}/${nid}`);
    }
    const declared = snap.manifest?.dataTables;
    if (Array.isArray(declared) && declared.length) {
      for (const [name, wheres] of used) {
        if (declared.includes(name)) continue;
        out.push(find(this, wheres.join(', '), `tableName "${name}" is not in the manifest's declared table set (${declared.join(', ')}). Tables are addressed by name and created on demand, so an undeclared name is indistinguishable from a typo.`, `declare "${name}" in the manifest, or correct it`));
      }
    }
    const names = [...used.keys()];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = editDistance(names[i], names[j]);
        if (d > 0 && d <= 2) {
          out.push(find(this, `${used.get(names[i])[0]} / ${used.get(names[j])[0]}`, `"${names[i]}" and "${names[j]}" differ by ${d} character(s). One of them is almost certainly a typo that has minted an empty table and reported success.`, 'pick one name'));
        }
      }
    }
    return out;
  },
});

/* --- 5b. live: declared tables that do not exist or hold nothing --------- */
rule({
  id: 'DT-TABLE-LIVE',
  catalogue: 5,
  severity: 'warn',
  title: 'live data tables: present, and holding more than a schema seed',
  needs: ['dataTablesLive'],
  run(snap) {
    if (!snap.dataTablesLive) return skip('data-table listing unavailable');
    const declared = snap.manifest?.dataTables ?? [];
    if (!declared.length) return skip('manifest declares no dataTables');
    const byName = new Map(snap.dataTablesLive.map((t) => [t.name, t]));
    const out = [];
    for (const name of declared) {
      const t = byName.get(name);
      if (!t) { out.push(find(this, name, 'declared table does not exist in the workspace — nothing has written to it.', 'run the workflow, then re-check')); continue; }
      if ((t.rowCount ?? 0) <= 1) {
        out.push(find(this, `${name} (${t.id})`, `rowCount=${t.rowCount ?? 0}. A count of 0 or 1 is a schema seed, not data: the DATA_TABLE node reports COMPLETED and success:true whether it wrote rows or not, so the table is the only honest signal.`, 'read the rows back, do not trust the node status'));
      }
    }
    // an undeclared table whose name shares this solution's prefix is a stray mint
    const prefix = snap.manifest?.tablePrefix;
    if (prefix) {
      for (const t of snap.dataTablesLive) {
        if (!t.name.startsWith(prefix)) continue;
        if (declared.includes(t.name)) continue;
        out.push(find(this, `${t.name} (${t.id})`, `a table with this solution's prefix exists but is not declared — rowCount=${t.rowCount ?? 0}. This is the signature of a name typo that minted a new table and reported success.`, 'delete it or declare it'));
      }
    }
    return out;
  },
});

/* --- 11. generated {{TODO}} and example endpoints ------------------------ */
const PLACEHOLDER_PATTERNS = [
  { re: /\{\{\s*TODO[^}]*\}\}/gi, what: 'a generated {{TODO}} stub' },
  { re: /https?:\/\/(?:api\.)?example\.(?:com|org)[^"'\s]*/gi, what: 'an example.com endpoint' },
  { re: /\b(?:REPLACE_ME|CHANGEME|CHANGE_ME|YOUR_[A-Z_]+_HERE|xxx-your-)\b/g, what: 'a placeholder literal' },
];
rule({
  id: 'GEN-UNRESOLVED-PLACEHOLDER',
  catalogue: 11,
  severity: 'block',
  title: 'unresolved generated configuration',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const { wf, nid, node } of allNodes(snap)) {
      const s = JSON.stringify(cfg(node));
      for (const p of PLACEHOLDER_PATTERNS) {
        p.re.lastIndex = 0;
        const hits = s.match(p.re);
        if (!hits) continue;
        out.push(find(this, `${wf.key}/${nid}`, `${hits.length} × ${p.what}: ${[...new Set(hits)].slice(0, 3).join(', ')}. This passes every structural check the platform makes — sound graph, no dangling edges, no unwired nodes — and fails on first execution.`, 'fill the value, or delete the node'));
      }
    }
    return out;
  },
});

/* --- 12. unrequested integrations ---------------------------------------- */
rule({
  id: 'GEN-UNDECLARED-INTEGRATION',
  catalogue: 12,
  severity: 'block',
  title: 'a third-party integration node the manifest did not ask for',
  needs: ['workflows'],
  run(snap) {
    const allowed = new Set((snap.manifest?.allowedIntegrations ?? []).map((s) => s.toUpperCase()));
    const out = [];
    const seen = new Set();
    for (const { wf, nid, node } of allNodes(snap)) {
      const t = String(node.type).toUpperCase();
      if (classify(t) !== 'integration') continue;
      if (allowed.has(t)) continue;
      const k = `${wf.key}/${t}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(find(this, `${wf.key}/${nid}`, `node type ${t} is a third-party integration that the manifest does not declare. The wizard prompt tells the model not to stop at the literal request and the coverage judge is told to invent hardening requirements, so integrations nobody asked for appear routinely — each one is an unowned credential and an unowned data egress.`, `remove the node, or add "${t}" to allowedIntegrations with a reason`));
    }
    return out;
  },
});

/* --- 12b. outbound channels the manifest did not authorise -------------- */
rule({
  id: 'GEN-UNDECLARED-OUTBOUND',
  catalogue: 12,
  severity: 'block',
  title: 'a node that can reach a human without the manifest authorising it',
  needs: ['workflows'],
  run(snap) {
    const allowed = new Set((snap.manifest?.allowedOutbound ?? []).map((s) => s.toUpperCase()));
    const out = [];
    for (const { wf, nid, node } of allNodes(snap)) {
      const t = String(node.type).toUpperCase();
      if (classify(t) !== 'outbound') continue;
      if (allowed.has(t)) continue;
      out.push(find(this, `${wf.key}/${nid}`, `node type ${t} can send to a person. It is not in allowedOutbound. The X Broker "no automatic outreach" gate was checked against a hand-written forbid list that did not contain the platform's own EMAIL_SEND, so it could not fail; this is the same assertion written as an allow-list.`, `authorise "${t}" in allowedOutbound, or route through HUMAN_INPUT first`));
    }
    return out;
  },
});

/* --- 13. condition expressions the evaluator cannot parse ---------------- */
const CONDITION_KEYS = ['condition', 'conditions', 'expression', 'cases', 'rules', 'when'];
rule({
  id: 'GEN-UNPARSEABLE-CONDITION',
  catalogue: 13,
  severity: 'block',
  title: 'a branch condition the ConditionExpressionEvaluator cannot parse',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    const BRANCHY = new Set(['IF_ELSE', 'SWITCH', 'FILTER', 'CONDITION', 'LOOP', 'ITERATION']);
    for (const { wf, nid, node } of allNodes(snap)) {
      const t = String(node.type).toUpperCase();
      if (!BRANCHY.has(t)) continue;
      const c = cfg(node);
      const blob = JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => CONDITION_KEYS.includes(k))));
      if (blob === '{}') continue;
      const regexLiterals = blob.match(/\/(?:[^/\\"]|\\.){2,}\//g) ?? [];
      const alternation = regexLiterals.filter((r) => r.includes('|'));
      if (alternation.length) {
        out.push(find(this, `${wf.key}/${nid}`, `condition contains a regex literal with alternation (${alternation[0].slice(0, 60)}). The evaluator's tokeniser has kinds IDENT/STRING/NUMBER/BOOLEAN/NULL/OPERATOR/AND/OR only (ConditionExpressionEvaluator.java:169) — there is no regex token, and a single "|" is not "||". The condition raises ConditionSyntaxException at runtime.`, 'expand to `x contains "a" || x contains "b" || x contains "c"`'));
      }
      const badOps = blob.match(/"(matches|regex|rlike|~=)"/g) ?? [];
      if (badOps.length) {
        out.push(find(this, `${wf.key}/${nid}`, `condition uses operator ${[...new Set(badOps)].join(', ')}. BINARY_WORD_OPERATORS is {equals,eq,not_equals,ne,greater_than,gt,greater_equal,ge,less_than,lt,less_equal,le,contains,starts_with,ends_with,in} (ConditionExpressionEvaluator.java:118-122) — none of these is in it.`, 'use contains / starts_with / ends_with / in'));
      }
    }
    return out;
  },
});

/* --- 14. crypto is not available in the GraalVM sandbox ------------------ */
rule({
  id: 'GEN-SANDBOX-CRYPTO',
  catalogue: 14,
  severity: 'block',
  title: 'a code node reaching for a module the sandbox does not have',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    const BANNED = [
      { re: /\brequire\s*\(\s*['"](?:node:)?crypto['"]\s*\)/, what: "require('crypto')" },
      { re: /\bcreateHash\s*\(/, what: 'createHash(' },
      { re: /\bcrypto\s*\.\s*(?:subtle|randomUUID|createHash|randomBytes)\b/, what: 'crypto.*' },
      { re: /\brequire\s*\(\s*['"](?:node:)?(fs|child_process|http|https|net)['"]\s*\)/, what: 'a node builtin' },
    ];
    for (const { wf, nid, node } of allNodes(snap)) {
      if (!RESULT_ROOTED.has(String(node.type).toUpperCase())) continue;
      const raw = cfg(node).code;
      if (typeof raw !== 'string') continue;
      // Comments are stripped first: a comment explaining why you must not
      // write require('crypto') is not a call to require('crypto').
      const code = stripComments(raw);
      for (const b of BANNED) {
        if (!b.re.test(code)) continue;
        out.push(find(this, `${wf.key}/${nid}`, `code uses ${b.what}. The GraalVM sandbox has no module system and no crypto module, so this throws at runtime — after the node has been reported as a valid graph member by every static check.`, 'implement the primitive in pure JS inside the node, or move it to a node type that has the capability'));
      }
    }
    return out;
  },
});

/* --- graph soundness ----------------------------------------------------- */
rule({
  id: 'WF-GRAPH-SOUND',
  catalogue: null,
  severity: 'block',
  title: 'dangling edges, unwired nodes, no entry point',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const wf of snap.workflows ?? []) {
      const nodes = wf.record?.nodes ?? {};
      const edges = wf.record?.edges ?? [];
      const ids = new Set(Object.keys(nodes));
      if (ids.size === 0) { out.push(find(this, wf.key, 'workflow has no nodes.', 'build it')); continue; }
      const dangling = edges.filter((e) => !ids.has(e.sourceNodeId) || !ids.has(e.targetNodeId));
      if (dangling.length) out.push(find(this, wf.key, `${dangling.length} dangling edge(s): ${dangling.slice(0, 3).map((e) => `${e.sourceNodeId}->${e.targetNodeId}`).join(', ')}`, 'remove or repoint them'));
      const touched = new Set();
      for (const e of edges) { touched.add(e.sourceNodeId); touched.add(e.targetNodeId); }
      const unwired = [...ids].filter((i) => !touched.has(i));
      if (unwired.length && ids.size > 1) out.push(find(this, wf.key, `${unwired.length} unwired node(s): ${unwired.join(', ')} — they exist on the canvas and never execute.`, 'wire them or delete them'));
      const targets = new Set(edges.map((e) => e.targetNodeId));
      const entries = [...ids].filter((i) => !targets.has(i));
      if (entries.length === 0) out.push(find(this, wf.key, 'no entry point — every node is the target of an edge, so nothing can start.', 'add a trigger or a start node'));
    }
    return out;
  },
});

/* ══════════════════════════════════════════════════════════════════════════
 * Failure modes found by running this preflight against a SECOND solution.
 * None of these is in the X Broker catalogue; all four came out of one
 * wizard-generated workflow, and all four are silent.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Roots a template may legitimately name besides a node id. */
const CONTEXT_ROOTS = new Set([
  'inputs', 'input', 'trigger', 'payload', 'env', 'secrets', 'vars', 'variables',
  'context', 'workflow', 'execution', 'now', 'current_time', 'currentTime',
  'today', 'uuid', 'item', 'items', 'loop', 'iteration', 'error', 'json', 'binary',
  'TODO',
]);

rule({
  id: 'REF-UNRESOLVABLE-HEAD',
  catalogue: null,
  severity: 'block',
  title: 'a {{token}} whose root names neither a node nor a context variable',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const wf of snap.workflows ?? []) {
      const ids = new Set(Object.keys(wf.record?.nodes ?? {}));
      for (const [nid, n] of Object.entries(wf.record?.nodes ?? {})) {
        const seen = new Set();
        for (const tok of tokensIn(cfg(n))) {
          const head = tok.split('.')[0].trim().split(/[[\s(]/)[0];
          if (!head || ids.has(head) || CONTEXT_ROOTS.has(head)) continue;
          if (seen.has(head)) continue;
          seen.add(head);
          out.push(find(this, `${wf.key}/${nid}`, `{{${tok}}} — "${head}" is not a node in this graph and not a context root. resolveVariable misses, the catch falls through to "", and the node runs with an empty value: an HTTP node calls the empty URL, a table column lands blank. Nothing raises.`, `point it at a real node id, or declare "${head}" as a workflow input`));
        }
      }
    }
    return out;
  },
});

/**
 * Output keys a node type actually produces, for the executors whose source has
 * been read. Deliberately partial: asserting against a type whose outputs are
 * unknown would produce false failures, and a check that fires on correct
 * artifacts is the thing this tool exists to prevent.
 */
const DECLARED_OUTPUTS = {
  DATA_TABLE: {
    // DataTableNodeExecutor.java:183-247 — the key set differs per operation.
    common: ['operation', 'scope', 'tableName', 'tableId', 'success', 'error', 'rowCount'],
    insert: ['inserted', 'rowIds'],
    upsert: ['written'],
    query: ['rows'],
    update: ['updated'],
    deleteRows: ['deleted'],
    createTable: ['created'],
    dropTable: ['dropped'],
  },
};

rule({
  id: 'REF-UNDECLARED-OUTPUT-KEY',
  catalogue: null,
  severity: 'block',
  title: 'a reference to an output key the node type does not produce',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const wf of snap.workflows ?? []) {
      const nodes = wf.record?.nodes ?? {};
      for (const [nid, n] of Object.entries(nodes)) {
        for (const tok of tokensIn(cfg(n))) {
          const parts = tok.split('.').map((p) => p.trim());
          if (parts.length < 2) continue;
          const target = nodes[parts[0]];
          if (!target) continue;
          const spec = DECLARED_OUTPUTS[String(target.type).toUpperCase()];
          if (!spec) continue;
          const op = String((target.configuration ?? target.config ?? {}).operation ?? 'insert');
          const legal = new Set([...spec.common, ...(spec[op] ?? [])]);
          if (legal.has(parts[1])) continue;
          out.push(find(this, `${wf.key}/${nid}`, `{{${tok}}} — node "${parts[0]}" is a ${target.type} running operation "${op}", whose outputs are {${[...legal].join(', ')}}. "${parts[1]}" is not among them; the path resolves to null and is written as "".`, `reference one of ${[...legal].join(', ')}`));
        }
      }
    }
    return out;
  },
});

rule({
  id: 'WF-EDGE-PORT-UNDEFINED',
  catalogue: null,
  severity: 'block',
  title: 'an edge with no usable port id',
  needs: ['workflows'],
  run(snap) {
    const BRANCHING = new Set(['IF_ELSE', 'SWITCH', 'FILTER', 'CONDITION']);
    const out = [];
    for (const wf of snap.workflows ?? []) {
      const nodes = wf.record?.nodes ?? {};
      for (const e of wf.record?.edges ?? []) {
        const fromBranch = BRANCHING.has(String(nodes[e.sourceNodeId]?.type).toUpperCase());
        for (const side of ['sourcePortId', 'targetPortId']) {
          const v = e[side];
          if (v && v !== 'undefined' && v !== 'null') continue;
          const literal = v === 'undefined' || v === 'null';
          // Three distinct cases, and they do not deserve the same severity.
          // Calling an absent port on a linear edge the same as a serialised
          // "undefined" would be the over-claiming this tool exists to prevent.
          if (literal) {
            out.push(find(this, `${wf.key} ${e.sourceNodeId}\u2192${e.targetNodeId}`, `${side} is the STRING ${JSON.stringify(v)}. The generator serialised a missing port as text; the graph still validates because both node ids exist, and the branch routes to whatever the engine defaults to.`, 'name the real port (out / true / false / error)'));
          } else if (fromBranch && side === 'sourcePortId') {
            out.push(find(this, `${wf.key} ${e.sourceNodeId}\u2192${e.targetNodeId}`, `sourcePortId is absent on an edge leaving a ${nodes[e.sourceNodeId].type} node${e.label ? `, which carries label ${JSON.stringify(e.label)} instead` : ''}. A branch chooses its successor by port; a label is documentation. Which side of the branch this edge is on is not expressed.`, 'set sourcePortId to true / false / the case id'));
          } else {
            out.push({ ...find(this, `${wf.key} ${e.sourceNodeId}\u2192${e.targetNodeId}`, `${side} is absent on a linear edge. The engine has a default, so this may route correctly — but the graph does not say so, and a later branch on the same node would be ambiguous.`, 'set the port explicitly'), severity: 'warn' });
          }
        }
      }
    }
    return out;
  },
});

rule({
  id: 'DT-BRANCHES-WRITE-SAME-SOURCE',
  catalogue: null,
  severity: 'block',
  title: 'two exclusive branches persisting the identical rows expression',
  needs: ['workflows'],
  run(snap) {
    const out = [];
    for (const wf of snap.workflows ?? []) {
      const nodes = wf.record?.nodes ?? {};
      const edges = wf.record?.edges ?? [];
      const byRows = new Map();
      for (const [nid, n] of Object.entries(nodes)) {
        if (String(n.type).toUpperCase() !== 'DATA_TABLE') continue;
        const c = cfg(n);
        if (!['insert', 'upsert'].includes(String(c.operation ?? 'insert'))) continue;
        const key = JSON.stringify(c.rows ?? null);
        if (key === 'null') continue;
        if (!byRows.has(key)) byRows.set(key, []);
        byRows.get(key).push({ nid, table: c.tableName });
      }
      for (const [rows, uses] of byRows) {
        if (uses.length < 2) continue;
        const tables = new Set(uses.map((u) => u.table));
        if (tables.size < 2) continue;
        // Only a finding when the two writes sit on mutually exclusive ports of
        // the same branch node: writing the same set to two tables on purpose
        // is legitimate, splitting a set into two tables from one expression is not.
        const exclusive = uses.some((a) => uses.some((b) => a !== b && sharesExclusiveBranch(edges, a.nid, b.nid)));
        if (!exclusive) continue;
        out.push(find(this, `${wf.key}/${uses.map((u) => u.nid).join(' + ')}`, `${uses.length} DATA_TABLE nodes on mutually exclusive branches all write rows = ${rows.slice(0, 60)} into different tables (${[...tables].join(', ')}). Whatever the branch decides, both tables receive the same set — the split the workflow claims to make never happens, and both inserts report success.`, 'have the upstream node emit one JSON string per destination and reference each separately'));
      }
    }
    return out;
  },
});

function sharesExclusiveBranch(edges, a, b) {
  const inA = edges.filter((e) => e.targetNodeId === a);
  const inB = edges.filter((e) => e.targetNodeId === b);
  for (const ea of inA) {
    for (const eb of inB) {
      if (ea.sourceNodeId !== eb.sourceNodeId) continue;
      if (ea.sourcePortId !== eb.sourcePortId) return true;
    }
  }
  return false;
}

/* --- 6. the execution header lies in both directions -------------------- */
rule({
  id: 'RUN-HEADER-VS-TRACES',
  catalogue: 6,
  severity: 'block',
  title: 'execution header status disagreeing with per-node traces',
  needs: ['executions'],
  run(snap) {
    if (!snap.executions) return skip('no executions fetched');
    const keys = Object.keys(snap.executions);
    if (keys.length === 0) return skip('no executions fetched');
    const out = [];
    let anyRun = false;
    for (const key of keys) {
      const runs = snap.executions[key] ?? [];
      if (runs.length) anyRun = true;
      for (const r of runs) {
        const header = String(r.header?.status ?? '').toUpperCase();
        const envelope = String(r.envelopeStatus ?? '').toUpperCase();
        const traces = r.traces ?? [];
        const at = `${key}/${r.header?.id ?? '?'}`;
        if (!traces.length) {
          out.push(find(this, at, `execution reports ${header || 'UNKNOWN'} with zero per-node traces — there is nothing to corroborate the header with.`, 'read GET /v2/workflows/executions/{id}/traces before believing any status'));
          continue;
        }
        const failed = traces.filter((t) => /FAIL|ERROR/i.test(String(t.status ?? '')));
        const okStatuses = new Set(['COMPLETED', 'SUCCEEDED', 'SUCCESS']);
        const completed = traces.filter((t) => okStatuses.has(String(t.status ?? '').toUpperCase()));
        if (/SUCCE|COMPLETED/i.test(header) && failed.length) {
          out.push(find(this, at, `the executions header says ${header} while ${failed.length} node(s) FAILED (${failed.slice(0, 3).map((t) => t.nodeId ?? t.nodeName).join(', ')}). The header lies in this direction; the traces are the record.`, 'gate on traces, not on the header'));
        }
        if (/FAIL|ERROR/i.test(header) && failed.length === 0 && completed.length) {
          out.push(find(this, at, `the executions header says ${header} while all ${completed.length} node(s) COMPLETED. The header lies in this direction too — a failure to persist the audit row is reported as a failed run.`, 'gate on traces, not on the header'));
        }
        if (envelope && envelope !== header) {
          out.push(find(this, at, `two platform surfaces disagree about the same run: GET /v2/workflows/{id}/executions says ${header}, GET /v2/workflows/executions/{id}/traces says ${envelope}. Neither is the record; the per-node statuses are (${completed.length} completed, ${failed.length} failed of ${traces.length}).`, 'derive the verdict from the per-node statuses'));
        }
      }
    }
    if (!anyRun) return skip('no workflow in this solution has ever executed');
    return out;
  },
});

/**
 * The one runtime rule that catches the whole persistence family at once.
 *
 * Found by running this preflight against solution two. Every node reported
 * COMPLETED, every DATA_TABLE reported success: true, and all five tables held
 * zero rows — because the trigger payload is not at `inputs.*` in the sandbox,
 * so the code node looped over an empty array. `Array.isArray(undefined)` is
 * false; nothing raises; the counts are all zero and internally consistent.
 *
 * The trap this exposes is bigger than the access path. The graph carried a
 * reconciliation gate — "written + excepted must equal the total" — and it
 * PASSED, because 0 + 0 === 0. A conservation check is vacuous on an empty
 * input, which is exactly the case it was built to catch.
 */
rule({
  id: 'RUN-WROTE-NOTHING',
  catalogue: null,
  severity: 'block',
  title: 'a persistence node that completed successfully having written nothing',
  needs: ['executions'],
  run(snap) {
    if (!snap.executions || Object.keys(snap.executions).length === 0) return skip('no executions fetched');
    const out = [];
    let anyPool = false;
    for (const [key, runs] of Object.entries(snap.executions)) {
      // The list comes back newest-first. A stale failed run is history worth
      // showing; the LATEST run failing is what should stop a release. Grading
      // them the same makes the rule noisy and people stop reading it.
      (runs ?? []).forEach((r, idx) => {
        const pool = r.pool;
        if (!pool) return;
        anyPool = true;
        const latest = idx === 0;
        const inputBytes = JSON.stringify(pool.inputs ?? {}).length;
        for (const [nodeId, o] of Object.entries(pool)) {
          if (!o || typeof o !== 'object') continue;
          if (o.operation !== 'insert' && o.operation !== 'upsert') continue;
          const wrote = Number(o.inserted ?? o.written ?? o.rowCount ?? 0);
          if (wrote > 0) continue;
          out.push({
            ...find(this, `${key}/${r.header?.id}/${nodeId}`, `${latest ? 'THE LATEST RUN: ' : `an earlier run (#${idx + 1} back): `}${o.operation} into "${o.tableName}" wrote ${wrote} rows and reported success:${o.success}. The run's input payload was ${inputBytes} bytes, so this is not an empty batch. Every one of the persistence failure modes ends here — wrong template root, object-shaped rows, a bare reference, a mistyped table — and all of them are invisible from the node status.`, 'read the table back; then check the upstream node actually saw the input (the trigger payload is NOT at inputs.*)'),
            severity: latest ? 'block' : 'warn',
          });
        }
      });
    }
    if (!anyPool) return skip('execution variable pools unavailable');
    return out;
  },
});

/* --- 7. the size guard trims outputData and drops inputData ------------- */
rule({
  id: 'RUN-VARIABLE-POOL-TRIMMED',
  catalogue: 7,
  severity: 'warn',
  title: 'an execution whose variable pool was trimmed by the size guard',
  needs: ['executions'],
  run(snap) {
    if (!snap.executions || Object.keys(snap.executions).length === 0) return skip('no executions fetched');
    const MAX_BYTES = 358400; // OutputDataSizeGuard.MAX_BYTES
    const out = [];
    let any = false;
    for (const [key, runs] of Object.entries(snap.executions)) {
      for (const r of runs ?? []) {
        any = true;
        if (/_truncationApplied|_truncated/.test(JSON.stringify(r))) {
          out.push(find(this, `${key}/${r.header?.id}`, 'the execution carries a size-guard truncation marker.', 'shrink what upstream nodes return, or persist bulk data to a table and pass the id'));
        }
        for (const t of r.traces ?? []) {
          const bytes = t.outputSizeBytes ?? 0;
          if (bytes > MAX_BYTES) {
            out.push(find(this, `${key}/${r.header?.id}/${t.nodeId}`, `node output is ${bytes} bytes, over OutputDataSizeGuard.MAX_BYTES (${MAX_BYTES}). The guard trims outputData at that limit but the same-sized value arriving as *input* on the next node is not protected, and the variable pool goes with it — every downstream {{…}} then resolves to "" while every node reports COMPLETED.`, 'page the fetch, or write the bulk to a data table and pass the table name'));
          }
        }
      }
    }
    if (!any) return skip('no executions fetched');
    return out;
  },
});

/* --- 8. PUT /v2/workflows/{id} is dead code ----------------------------- */
rule({
  id: 'API-WORKFLOW-PUT',
  catalogue: 8,
  severity: 'block',
  title: 'build code writing a workflow through PUT',
  needs: ['sourceFiles'],
  run(snap) {
    if (!snap.sourceFiles) return skip('no sourceDirs declared in the manifest');
    const out = [];
    for (const f of snap.sourceFiles) {
      const lines = f.text.split('\n');
      lines.forEach((line, i) => {
        if (!/\/v2\/workflows\//.test(line)) return;
        if (!/\bput\s*\(|['"]PUT['"]/.test(line)) return;
        out.push(find(this, `${f.path}:${i + 1}`, `PUT /v2/workflows/{id} is dead code: its DTO declares tags as a List while the entity serialises a Map (an instant 400), it carries @NotNull fields that no GET body returns, and convertToModel never sets workspaceId. ${line.trim().slice(0, 100)}`, 'use PATCH /v2/workflows/{id} for a merge, or POST /v2/workflows/{id}/draft to replace the node map'));
      });
    }
    return out;
  },
});

/* --- 9. agent knowledge: three things must be true together ------------- */
const TIERS = ['SIMPLE', 'KNOWLEDGE', 'CONVERSATIONAL', 'AGENTIC', 'AUTONOMOUS'];
rule({
  id: 'AGENT-KNOWLEDGE-EFFECTIVE',
  catalogue: 9,
  severity: 'block',
  title: 'agent grounding that the runtime will actually resolve',
  needs: ['components', 'knowledgeModules'],
  run(snap) {
    const agents = (snap.components ?? []).filter((c) => c.kind === 'agent' && c.record);
    if (!agents.length) return skip('no agents in this solution');
    if (!snap.knowledgeModules) return skip('knowledge-module listing unavailable');
    const moduleById = new Map(snap.knowledgeModules.map((m) => [m.id, m]));
    const datasetIds = new Set((snap.datasets ?? []).map((d) => d.id));
    const out = [];
    for (const a of agents) {
      const r = a.record;
      const ids = r.knowledgeModuleIds ?? [];
      const legacy = (r.knowledgeSources ?? '').trim();
      if (legacy && ids.length === 0) {
        out.push(find(this, `${a.key} (agent)`, `knowledgeSources = "${legacy.slice(0, 60)}" while knowledgeModuleIds is empty. knowledgeSources is written by the wizard and by AgentService and read only by AgentExportService — it never appears in AgentInferenceService. The record looks grounded and the runtime grounds on nothing.`, 'put a KnowledgeModule id in knowledgeModuleIds'));
      }
      for (const id of ids) {
        const mod = moduleById.get(id);
        if (mod) {
          if (!mod.datasetId) out.push(find(this, `${a.key} (agent)`, `knowledgeModuleIds contains module ${id} which carries no datasetId. KnowledgeRetrievalServiceV2.java:210 warns and does a silent continue — retrieval returns nothing and no error surfaces.`, 'attach a dataset to the module'));
          continue;
        }
        if (datasetIds.has(id)) {
          out.push(find(this, `${a.key} (agent)`, `knowledgeModuleIds contains ${id}, which is a DATASET id, not a KnowledgeModule id. findById misses at KnowledgeRetrievalServiceV2.java:193 and the id is dropped by a silent continue. The agent reads as grounded on the correct knowledge and retrieves zero passages. The chain is dataset →(KnowledgeModule.datasetId)→ module →(Agent.knowledgeModuleIds)→ agent; this skips the middle hop.`, 'create a KnowledgeModule whose datasetId is this dataset, and reference the module'));
          continue;
        }
        out.push(find(this, `${a.key} (agent)`, `knowledgeModuleIds contains ${id}, which resolves to neither a knowledge module nor a dataset in this workspace.`, 'remove it or point it at a real module'));
      }
      const tier = String(r.capabilityTier ?? '').toUpperCase();
      const needsTools = ids.length > 0 || (r.tools ?? []).length > 0;
      if (needsTools && TIERS.indexOf(tier) < TIERS.indexOf('AGENTIC')) {
        out.push(find(this, `${a.key} (agent)`, `capabilityTier=${tier || 'unset'} while the agent carries ${ids.length} knowledge module(s) and ${(r.tools ?? []).length} tool(s). resolveTools early-returns an empty list below AGENTIC (AgentInferenceService.java:645-649), and the search_knowledge registration at :707 is below that return — so a correctly grounded agent retrieves nothing. An unparseable tier falls open to SIMPLE.`, 'set capabilityTier to AGENTIC'));
      }
    }
    return out;
  },
});

/**
 * The composition nobody was looking for.
 *
 * Two separately-documented defects multiply into a total outage:
 *   - a document can report indexingStatus COMPLETED over zero segments
 *   - an agent at tier >= AGENTIC with a non-empty knowledgeModuleIds gets
 *     `search_knowledge` registered and will call it
 * Put them together and the agent calls a tool that returns nothing, the loop
 * ends after one iteration, and the reply is `content: ""`. Not a refusal, not
 * an error — an empty string, with the record showing the correct module id,
 * the correct dataset and the correct tier.
 *
 * Proven live on solution two by a control: the same agent with the same prompt
 * and the same tier, differing only in `knowledgeModuleIds: []`, answered in
 * full (483 chars, 112 output tokens) where the grounded one produced 14 output
 * tokens and no content. It also retro-explains X Broker gate G10, where the
 * submission preparer "returns no content at all" across three probes and had
 * exactly this shape.
 */
rule({
  id: 'AGENT-GROUNDED-ON-EMPTY-KNOWLEDGE',
  catalogue: null,
  severity: 'block',
  title: 'an agent whose only knowledge source retrieves nothing',
  needs: ['components', 'knowledgeModules', 'datasetDocs'],
  run(snap) {
    const agents = (snap.components ?? []).filter((c) => c.kind === 'agent' && c.record);
    if (!agents.length) return skip('no agents in this solution');
    if (!snap.knowledgeModules || !snap.datasetDocs) return skip('knowledge catalogues unavailable');
    const moduleById = new Map(snap.knowledgeModules.map((m) => [m.id, m]));
    const emptyDataset = (dsId) => {
      const docs = snap.datasetDocs[dsId];
      if (!Array.isArray(docs)) return null; // unknown — never guess
      if (docs.length === 0) return true;
      return docs.every((d) => (d.totalSegments ?? d.total_segments ?? 0) === 0);
    };
    const out = [];
    for (const a of agents) {
      const ids = a.record.knowledgeModuleIds ?? [];
      if (ids.length === 0) continue;
      const tier = String(a.record.capabilityTier ?? '').toUpperCase();
      if (TIERS.indexOf(tier) < TIERS.indexOf('AGENTIC')) continue;
      const verdicts = ids.map((id) => emptyDataset(moduleById.get(id)?.datasetId));
      if (verdicts.some((v) => v === null)) continue;
      if (!verdicts.every((v) => v === true)) continue;
      out.push(find(this, `${a.key} (agent)`, `every knowledge module on this agent points at a dataset with zero retrievable segments, and the tier is ${tier}, so search_knowledge IS registered and WILL be called. The tool returns nothing, the loop terminates after one iteration, and the agent replies with an empty string. Proven by control: the identical agent with knowledgeModuleIds:[] answers in full.`, 'either make the dataset retrievable, or unlink the module until it is — an agent that answers nothing is worse than one grounded on its prompt alone'));
    }
    return out;
  },
});

/* --- 10. widget brain, and the vocabulary that never lands -------------- */
rule({
  id: 'WIDGET-BRAIN-EFFECTIVE',
  catalogue: 10,
  severity: 'block',
  title: 'widget bound through the field the runtime resolves',
  needs: ['components'],
  run(snap) {
    const widgets = (snap.components ?? []).filter((c) => c.kind === 'widget' && c.record);
    if (!widgets.length) return skip('no widgets in this solution');
    const out = [];
    for (const w of widgets) {
      const r = w.record.config ?? w.record;
      const brain = r.brain;
      const ok = (brain && brain.kind && brain.id) || r.agentId;
      if (!ok) {
        out.push(find(this, `${w.key} (widget)`, 'no brain: WidgetConfig.brain is unset and the deprecated top-level agentId is unset. WidgetControllerV1.java:970 returns "no_brain" on dispatch. attach / binding / chatflowId are request-only vocabulary and never land on the stored record, so a widget configured with those reads as bound and answers nothing.', 'PUT /api/v2/widgets/{id} with brain = {kind, id}'));
      }
      if (brain && String(brain.kind).toUpperCase() === 'DASHBOARD') {
        out.push(find(this, `${w.key} (widget)`, 'brain.kind = DASHBOARD is declared in the BrainKind enum but falls to unsupported_brain_kind at WidgetControllerV1.java:989.', 'use AGENT, CHATFLOW or WORKFLOW'));
      }
      if (r.customDomain) {
        out.push({ ...find(this, `${w.key} (widget)`, `customDomain = "${r.customDomain}" is inert — getWidgetByCustomDomain has zero callers, so the domain resolves to nothing.`, 'do not promise this URL to anyone'), severity: 'warn' });
      }
    }
    return out;
  },
});

/* --- chatflow → agent, through the field the overlay actually reads ----- */
rule({
  id: 'CHATFLOW-DOWNSTREAM-EFFECTIVE',
  catalogue: 10,
  severity: 'block',
  title: 'chatflow handing off through agentConfig.defaultAgentId or agentId',
  needs: ['components'],
  run(snap) {
    const flows = (snap.components ?? []).filter((c) => c.kind === 'chatflow' && c.record);
    if (!flows.length) return skip('no chatflows in this solution');
    const wires = snap.manifest?.wires ?? [];
    const out = [];
    for (const f of flows) {
      const declared = wires.filter((w) => w.from === f.key && w.relation === 'hands-off-to');
      if (!declared.length) continue;
      const r = f.record;
      const eff = r.agentConfig?.defaultAgentId || r.agentId || null;
      if ('boundAgentId' in r) out.push(find(this, `${f.key} (chatflow)`, 'the record carries a boundAgentId field. No such field exists on ChatFlow — a checker selecting that path can never resolve, and a writer setting it writes nothing.', 'use agentConfig.defaultAgentId (wins) or agentId (fallback)'));
      for (const w of declared) {
        const target = (snap.components ?? []).find((c) => c.key === w.to);
        if (!target?.id) continue;
        if (eff !== target.id) {
          out.push(find(this, `${f.key} → ${w.to}`, `the chatflow's effective downstream is ${eff ?? 'null'}, not ${target.id}. AgentOverlayService.java:214 reads agentConfig.defaultAgentId first and falls back to agentId at :218; nothing else is consulted.`, `POST /v2/chatflows/${f.id}/bind-agent/${target.id}`));
        }
      }
    }
    return out;
  },
});

/* --- knowledge that is attached but not retrievable --------------------- */
rule({
  id: 'KNOWLEDGE-RETRIEVABLE',
  catalogue: null,
  severity: 'block',
  title: 'documents reporting COMPLETED over zero segments',
  needs: ['datasetDocs'],
  run(snap) {
    if (!snap.datasetDocs || Object.keys(snap.datasetDocs).length === 0) return skip('no datasets in this solution');
    const out = [];
    for (const [dsId, docs] of Object.entries(snap.datasetDocs)) {
      if (!Array.isArray(docs)) continue;
      if (docs.length === 0) { out.push(find(this, `dataset ${dsId}`, 'the dataset holds no documents.', 'upload the source')); continue; }
      for (const d of docs) {
        const status = String(d.indexingStatus ?? d.indexing_status ?? '').toUpperCase();
        const total = d.totalSegments ?? d.total_segments ?? 0;
        if (status === 'COMPLETED' && total === 0) {
          out.push(find(this, `dataset ${dsId} / ${d.name ?? d.id}`, 'indexingStatus=COMPLETED with totalSegments=0. The data-runtime ingest path reads chunk_count, uses it for a zero-guard and discards it (DocumentProcessingServiceV2.java:289), then writes COMPLETED — so a document that never ingested is indistinguishable from one that did, except by a retrieval query returning nothing.', 'run a retrieval query before believing the status'));
        }
      }
    }
    return out;
  },
});

/* --- a workflow that is not actually live ------------------------------- */
rule({
  id: 'WF-PUBLISHED',
  catalogue: null,
  severity: 'block',
  title: 'workflows the manifest calls live that are still drafts',
  needs: ['workflows'],
  run(snap) {
    if (snap.manifest?.expectLive === false) return skip('manifest does not claim these are live');
    const out = [];
    for (const wf of snap.workflows ?? []) {
      const r = wf.record ?? {};
      if (r.published !== true || r.enabled !== true) {
        out.push(find(this, wf.key, `published=${r.published} enabled=${r.enabled} status=${r.status}. published is derived from status === ACTIVE, and only a deployment sets that — publishing a version alone does not.`, `POST /v2/workflows/${wf.id}/publish then POST /v2/workflows/${wf.id}/deploy/managed {option: SHARED_CLOUD}`));
      }
    }
    return out;
  },
});

/* --- declared wires resolve through effective fields -------------------- */
rule({
  id: 'WIRE-RESOLVES',
  catalogue: null,
  severity: 'block',
  title: 'every declared wire resolves in the field the runtime reads',
  needs: ['components'],
  run(snap) {
    const wires = snap.manifest?.wires ?? [];
    if (!wires.length) return skip('manifest declares no wires');
    const byKey = new Map((snap.components ?? []).map((c) => [c.key, c]));
    const out = [];
    for (const w of wires) {
      const from = byKey.get(w.from);
      const to = byKey.get(w.to);
      if (!from?.record) { out.push(find(this, `${w.from} → ${w.to}`, `source component "${w.from}" could not be read.`, 'check the id')); continue; }
      if (!to?.id) { out.push(find(this, `${w.from} → ${w.to}`, `target component "${w.to}" has no live id.`, 'build it')); continue; }
      const res = resolveWire(from, to, w, snap);
      if (res.state === 'connected') continue;
      out.push(find(this, `${w.from} → ${w.to} (${w.relation})`, `${res.state.toUpperCase()}: ${res.detail}`, res.fix));
    }
    return out;
  },
});

/**
 * Wire resolution. Each entry names the ONE field the runtime consults, with
 * the read site, so a stale entry fails loudly (a connected wire reported
 * broken) rather than quietly.
 */
export function resolveWire(from, to, wire, snap) {
  const r = from.record;
  const id = to.id;
  const nodeCarries = (key) => {
    for (const [nid, n] of Object.entries(r.nodes ?? {})) {
      const c = n.configuration ?? n.config ?? {};
      if (c[key] === id) return nid;
    }
    return null;
  };
  switch (`${from.kind}:${wire.relation}`) {
    case 'agent:grounds-on': {
      const ids = r.knowledgeModuleIds ?? [];
      if (ids.includes(id)) return { state: 'connected' };
      if ((r.knowledgeSources ?? '').includes(id)) return { state: 'inert', detail: 'the id is in knowledgeSources, which AgentInferenceService never reads.', fix: 'move it to knowledgeModuleIds' };
      return { state: 'broken', detail: `knowledgeModuleIds = ${JSON.stringify(ids)} does not contain ${id}.`, fix: 'link the module' };
    }
    case 'chatflow:hands-off-to': {
      const eff = r.agentConfig?.defaultAgentId || r.agentId;
      if (eff === id) return { state: 'connected' };
      return { state: 'broken', detail: `effective downstream is ${eff ?? 'null'}.`, fix: `POST /v2/chatflows/${from.id}/bind-agent/${id}` };
    }
    case 'widget:answers-through': {
      const cfgw = r.config ?? r;
      if (cfgw.brain?.id === id) return { state: 'connected' };
      if (cfgw.agentId === id) return { state: 'connected' };
      const blob = JSON.stringify(cfgw);
      if (blob.includes(id)) return { state: 'inert', detail: 'the id appears on the widget but not in brain{kind,id} or the deprecated agentId — attach/binding/chatflowId are request-only vocabulary.', fix: 'PUT the widget with brain = {kind, id}' };
      return { state: 'broken', detail: 'the widget references the target nowhere.', fix: 'PUT the widget with brain = {kind, id}' };
    }
    case 'workflow:invokes-agent': {
      const n = nodeCarries('agentId');
      return n ? { state: 'connected' } : { state: 'broken', detail: 'no AGENT node carries configuration.agentId = the target.', fix: 'add an AGENT node' };
    }
    case 'workflow:reads-knowledge': {
      const n = nodeCarries('datasetId');
      if (n) return { state: 'connected' };
      for (const [nid, nd] of Object.entries(r.nodes ?? {})) {
        const c = nd.configuration ?? nd.config ?? {};
        if (Array.isArray(c.datasetIds) && c.datasetIds.includes(id)) return { state: 'connected' };
        nid;
      }
      return { state: 'broken', detail: 'no KNOWLEDGE_RETRIEVAL node carries configuration.datasetId (or datasetIds[]) = the target.', fix: 'add a KNOWLEDGE_RETRIEVAL node' };
    }
    case 'workflow:calls-workflow': {
      const n = nodeCarries('workflowId');
      return n ? { state: 'connected' } : { state: 'broken', detail: 'no SUBWORKFLOW node carries configuration.workflowId = the target.', fix: 'add a SUBWORKFLOW node' };
    }
    case 'workflow:calls-chatflow': {
      const n = nodeCarries('chatFlowId');
      if (n) return { state: 'connected' };
      const lower = nodeCarries('chatflowId');
      if (lower) return { state: 'inert', detail: 'a node carries configuration.chatflowId (lowercase f). ChatFlowTurnNodeExecutor.java:109 reads chatFlowId with a capital F.', fix: 'rename the key to chatFlowId' };
      return { state: 'broken', detail: 'no CHATFLOW_TURN node carries configuration.chatFlowId = the target.', fix: 'add a CHATFLOW_TURN node' };
    }
    case 'workflow:writes-table': {
      // Tables are addressed by name, so the "id" for this relation is the name.
      const name = to.tableName ?? to.id;
      for (const [, nd] of Object.entries(r.nodes ?? {})) {
        const c = nd.configuration ?? nd.config ?? {};
        if (String(nd.type).toUpperCase() === 'DATA_TABLE' && c.tableName === name) return { state: 'connected' };
      }
      return { state: 'broken', detail: `no DATA_TABLE node targets "${name}".`, fix: 'add a DATA_TABLE node' };
    }
    default:
      return { state: 'unknown', detail: `no resolver for ${from.kind}:${wire.relation} — reported unresolvable rather than passed.`, fix: 'add a resolver, or declare the wire external with a reason' };
  }
}

/* --- coverage, not existence -------------------------------------------- */
rule({
  id: 'COVERAGE',
  catalogue: null,
  severity: 'block',
  title: 'a component covering the set it was commissioned to cover',
  needs: ['components'],
  run(snap) {
    const specs = snap.manifest?.coverage ?? [];
    if (!specs.length) return skip('manifest declares no coverage sets');
    const byKey = new Map((snap.components ?? []).map((c) => [c.key, c]));
    const out = [];
    for (const spec of specs) {
      const c = byKey.get(spec.component);
      if (!c?.record) { out.push(find(this, spec.component, 'component could not be read, so its coverage is unknown — reported as a failure, not skipped.', 'check the id')); continue; }
      const present = project(c.record, spec.in);
      if (present == null) { out.push(find(this, spec.component, `selector "${spec.in}" resolved to nothing on this record.`, 'fix the selector')); continue; }
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      const haveSet = spec.match === 'contains' ? null : new Set(present.map(norm));
      const blob = spec.match === 'contains' ? present.join('\n').toLowerCase() : null;
      const missing = spec.of.filter((f) => (spec.match === 'contains' ? !blob.includes(String(f).toLowerCase()) : !haveSet.has(norm(f))));
      const ratio = (spec.of.length - missing.length) / spec.of.length;
      if (ratio < (spec.minRatio ?? 1)) {
        out.push(find(this, `${spec.component} · ${spec.id}`, `${spec.of.length - missing.length}/${spec.of.length} (${Math.round(ratio * 100)}%) — missing: ${missing.join(', ')}. An existence assertion is satisfied by any artifact of the right shape; this one is satisfied only by an artifact that carries what it was commissioned to carry.`, 'add the missing entries'));
      }
    }
    return out;
  },
});

/** Tiny selector: `fields[].id`, `a.b`, or `$prompt`. */
export function project(record, selector) {
  if (selector === '$prompt') {
    return [record.persona, record.instructions, record.systemPrompt].filter(Boolean);
  }
  const parts = selector.split('.');
  let cur = [record];
  for (const p of parts) {
    const arr = p.endsWith('[]');
    const key = arr ? p.slice(0, -2) : p;
    const next = [];
    for (const v of cur) {
      if (v == null) continue;
      const got = v[key];
      if (got == null) continue;
      if (Array.isArray(got)) next.push(...got);
      else next.push(got);
    }
    cur = next;
  }
  return cur.length ? cur : null;
}

export { skip };
