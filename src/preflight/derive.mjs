/**
 * derive — build a preflight manifest instead of hand-maintaining one.
 *
 * The hand-written manifest is the reason preflight did not scale past two
 * engagements: it is a parallel description of a solution that someone has to
 * keep in step with the solution. This derives it.
 *
 * The hard part is not the walking. It is that a manifest field is one of two
 * completely different kinds of statement, and only one kind can be derived:
 *
 *   FACT       what the solution is built out of — its components, the tables
 *              its graphs name. Deriving this is strictly better than typing
 *              it: the machine cannot forget a component.
 *
 *   INTENT     what the solution was commissioned to do and what it is
 *              authorised to do — coverage sets, allowedOutbound,
 *              allowedIntegrations, the wires it claims. Deriving these from
 *              live state is circular. `allowedOutbound` derived from the nodes
 *              present authorises whatever is present, so GEN-UNDECLARED-OUTBOUND
 *              can never fire. A wire derived from the field WIRE-RESOLVES reads
 *              is connected by construction.
 *
 * So: facts are derived, intent is never derived from live state. Intent comes
 * from a spec when one exists, and otherwise from the strictest default — an
 * empty allow-list, which makes every outbound node a finding, and an empty
 * coverage set, which makes COVERAGE *skip* and say so.
 *
 * Every derived manifest carries a `provenance` block naming, per field, where
 * the value came from and which rule branches that choice leaves unexercised.
 * `cli.mjs` prints it. This is the same discipline as mutation.mjs: a check
 * that cannot fail is reported, never counted as a pass.
 *
 *   node src/preflight/derive.mjs --seed workflow:<id> --seed workflow:<id> [--out m.json]
 *   node src/preflight/derive.mjs --spec path/to/x.solution.json [--out m.json]
 *   node src/preflight/derive.mjs --name-prefix "XB-" --out m.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tryGet, isError } from './lib/api.mjs';

const KIND_PATH = {
  workflow: (id) => `/v2/workflows/${id}`,
  agent: (id) => `/v2/agents/${id}`,
  chatflow: (id) => `/v2/chatflows/${id}`,
  widget: (id) => `/api/v2/widgets/${id}`,
  dataset: (id) => `/api/v2/datasets/${id}`,
  module: (id) => `/v1/knowledge-modules/${id}`,
  application: (id) => `/v2/applications/${id}`,
};

/**
 * Relations the preflight rule set can actually resolve. A spec relation that
 * is not in here is DROPPED and recorded in provenance — emitting it anyway
 * would produce a wire that reports `unknown` on every run, which buries the
 * wires that genuinely broke.
 */
const RELATION_MAP = {
  'grounds-on': 'grounds-on',
  'hands-off-to': 'hands-off-to',
  'answers-through': 'answers-through',
  'invokes-agent': 'invokes-agent',
  'reads-knowledge': 'reads-knowledge',
  'calls-workflow': 'calls-workflow',
  'calls-chatflow': 'calls-chatflow',
  'writes-table': 'writes-table',
};

const cfgOf = (n) => n?.configuration ?? n?.config ?? {};
const slug = (s, fallback) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || fallback;

/** Longest shared leading `<word>_` prefix of the derived table names. */
export function commonTablePrefix(names) {
  const withUnderscore = names.filter((n) => n.includes('_'));
  if (withUnderscore.length < 2) return undefined;
  const first = withUnderscore[0].split('_')[0] + '_';
  return withUnderscore.every((n) => n.startsWith(first)) ? first : undefined;
}

/* ── walking live state ──────────────────────────────────────────────────── */

/**
 * Follow every typed reference out of a record, so the component set is
 * discovered rather than listed. Returns `[kind, id]` pairs.
 */
export function referencesOf(kind, record) {
  const out = [];
  const push = (k, id) => {
    if (typeof id === 'string' && id.trim()) out.push([k, id.trim()]);
  };

  if (kind === 'workflow') {
    for (const n of Object.values(record?.nodes ?? {})) {
      const c = cfgOf(n);
      push('agent', c.agentId);
      push('workflow', c.workflowId);
      // ChatFlowTurnNodeExecutor reads chatFlowId (capital F). The lowercase
      // spelling is a real, common miswrite — follow both so the component is
      // fetched and CHATFLOW-DOWNSTREAM-EFFECTIVE / WIRE-RESOLVES can speak.
      push('chatflow', c.chatFlowId);
      push('chatflow', c.chatflowId);
      push('dataset', c.datasetId);
      for (const d of Array.isArray(c.datasetIds) ? c.datasetIds : []) push('dataset', d);
    }
  }
  if (kind === 'agent') {
    for (const m of record?.knowledgeModuleIds ?? []) push('module', m);
  }
  if (kind === 'chatflow') {
    push('agent', record?.agentConfig?.defaultAgentId);
    push('agent', record?.agentId);
  }
  if (kind === 'widget') {
    const c = record?.config ?? record ?? {};
    const brainKind = String(c.brain?.kind ?? '').toLowerCase();
    if (brainKind === 'agent' || brainKind === 'chatflow') push(brainKind, c.brain?.id);
    push('agent', c.agentId);
  }
  if (kind === 'module') {
    push('dataset', record?.datasetId ?? record?.dataset?.id);
  }
  return out;
}

/** Literal table names a workflow's DATA_TABLE nodes address. */
export function tableNamesIn(record) {
  const names = new Set();
  for (const n of Object.values(record?.nodes ?? {})) {
    if (String(n?.type).toUpperCase() !== 'DATA_TABLE') continue;
    const name = cfgOf(n).tableName;
    // A templated or blank name is not a declaration — it is a finding, and
    // DT-TABLE-NAME owns it. Adding it here would launder the defect into the
    // manifest and silence the rule.
    if (typeof name === 'string' && name.trim() && !/\{\{/.test(name)) names.add(name.trim());
  }
  return [...names];
}

/* ── seeds from the id registry the build scripts already write ──────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kind hints from the key name. Only a hint: it decides the ORDER the probe
 * tries kinds, never the answer. A key called `signalSourceId` gets no hint and
 * is probed against every kind, which is the whole point — the registry is not
 * required to follow a naming convention for this to work.
 */
const KEY_HINTS = [
  [/workflow/i, 'workflow'],
  [/chat.?flow/i, 'chatflow'],
  [/agent/i, 'agent'],
  [/widget/i, 'widget'],
  [/(knowledge)?module/i, 'module'],
  [/dataset|knowledge/i, 'dataset'],
  [/app(lication)?/i, 'application'],
];

/** Every UUID-shaped value in an arbitrary JSON tree, with the key that held it. */
export function uuidsIn(value, key = '', out = new Map()) {
  if (typeof value === 'string') {
    if (UUID.test(value) && !out.has(value)) out.set(value, key);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) uuidsIn(v, key, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) uuidsIn(v, k, out);
  }
  return out;
}

const ALL_KINDS = ['workflow', 'agent', 'chatflow', 'widget', 'dataset', 'module', 'application'];

/**
 * What kind is this id? Ask the platform.
 *
 * An id that resolves to nothing is NOT dropped — it is returned as `unresolved`
 * and lands in provenance. A registry entry pointing at a deleted artifact is
 * exactly the kind of quiet rot the manifest is supposed to surface, and
 * silently omitting it would turn a finding into an absence.
 */
export async function probeKind(id, hintKey, { log = () => {} } = {}) {
  const hinted = KEY_HINTS.find(([re]) => re.test(hintKey))?.[1];
  const order = hinted ? [hinted, ...ALL_KINDS.filter((k) => k !== hinted)] : ALL_KINDS;
  for (const kind of order) {
    log(`  probe ${kind} ${id}`);
    const r = await tryGet(KIND_PATH[kind](id));
    if (!isError(r) && r) return { kind, record: r };
  }
  return { kind: null, record: null };
}

const nameOf = (kind, record, id) =>
  record?.name ?? record?.title ?? record?.workflowName ?? `${kind}-${id.slice(0, 8)}`;

/**
 * Breadth-first walk from the seeds, fetching one record at a time (the
 * platform returns "fetch failed" under concurrency; api.mjs serialises).
 */
export async function walkLive(seeds, { log = () => {}, maxComponents = 120 } = {}) {
  const seen = new Map(); // `${kind}:${id}` -> component
  const keys = new Set();
  const errors = [];
  const queue = [...seeds];

  const uniqueKey = (base) => {
    let k = base;
    let i = 2;
    while (keys.has(k)) k = `${base}-${i++}`;
    keys.add(k);
    return k;
  };

  while (queue.length && seen.size < maxComponents) {
    const [kind, id] = queue.shift();
    const dedupe = `${kind}:${id}`;
    if (seen.has(dedupe)) continue;
    const path = KIND_PATH[kind];
    if (!path) {
      errors.push(`no fetch path for kind "${kind}" (${id}) — not derived`);
      continue;
    }
    log(`  fetch ${kind} ${id}`);
    const r = await tryGet(path(id));
    if (isError(r)) {
      // Recorded, not dropped: a seed that cannot be read still belongs in the
      // manifest so the run reports it as unreadable rather than as absent.
      errors.push(`${kind} ${id}: ${r.$error}`);
      seen.set(dedupe, { key: uniqueKey(slug(`${kind}-${id.slice(0, 8)}`)), kind, id });
      continue;
    }
    seen.set(dedupe, { key: uniqueKey(slug(nameOf(kind, r, id), `${kind}-${id.slice(0, 8)}`)), kind, id, $record: r });
    for (const ref of referencesOf(kind, r)) queue.push(ref);
  }

  const truncated = queue.length > 0;
  return { components: [...seen.values()], errors, truncated };
}

/* ── the two entry points ────────────────────────────────────────────────── */

const NOT_DERIVED = {
  allowedIntegrations:
    'NOT derived. An allow-list derived from the nodes present authorises whatever is present, ' +
    'so GEN-UNDECLARED-INTEGRATION could never fire. Empty is the strict default: every ' +
    'third-party integration node reports as undeclared until a human authorises it.',
  allowedOutbound:
    'NOT derived, for the same reason, and this is the specific shape that failed in the X Broker ' +
    'engagement. Empty is the strict default: every node that can reach a person reports until ' +
    'a human authorises it.',
  coverage:
    'NOT derivable. Coverage is what the solution was commissioned to carry — it exists only in ' +
    'the engagement, never in live state. With none declared, COVERAGE reports SKIP, which is ' +
    'printed. It is not counted as a pass.',
  wires:
    'NOT derived from live state. Every wire resolver reads one specific field; deriving the wire ' +
    'from that field makes it connected by construction and WIRE-RESOLVES vacuous. Wires come ' +
    'from a spec, or not at all — with none, WIRE-RESOLVES reports SKIP.',
};

const UNEXERCISED_BY_LIVE_TABLES =
  'DT-TABLE-NAME "table not in the declared set": dataTables was derived from the same DATA_TABLE ' +
  'nodes the rule inspects, so that branch cannot fire. Its other branches (blank, templated, ' +
  'near-duplicate names) are unaffected, and DT-TABLE-LIVE still checks each derived name against ' +
  'the live workspace and still flags stray prefixed tables.';

/**
 * Turn an id registry (`state.json` — the file every build script in an
 * engagement already writes) into seeds, by asking the platform what each id is.
 *
 * This is the derivation that actually scales, because it does not depend on
 * the solution being correctly wired. The live walk alone discovers only what
 * is reachable through a working link — and preflight exists precisely because
 * links are routinely broken, so the components most worth checking are the
 * ones the walk cannot see. The registry knows about them anyway.
 */
export async function seedsFromRegistry(registryPath, { log = () => {} } = {}) {
  const raw = JSON.parse(readFileSync(registryPath, 'utf8'));
  const ids = uuidsIn(raw);
  const seeds = [];
  const unresolved = [];
  for (const [id, key] of ids) {
    const { kind } = await probeKind(id, key, { log });
    if (kind) seeds.push([kind, id]);
    else unresolved.push(`${key} = ${id}: resolves to no artifact of any kind — a dead registry entry, or an id from another workspace`);
  }
  return { seeds, unresolved };
}

/** Derive from live state, walking out from seed components. */
export async function deriveFromLive(seeds, { id, name, log, registryUnresolved = [], source = 'live', baseDir, sourceDirs } = {}) {
  const { components, errors, truncated } = await walkLive(seeds, { log });
  errors.push(...registryUnresolved);

  const tables = new Set();
  for (const c of components) {
    if (c.kind === 'workflow' && c.$record) for (const t of tableNamesIn(c.$record)) tables.add(t);
  }
  const dataTables = [...tables].sort();
  const workspaceId = String(components.find((c) => c.$record?.workspaceId)?.$record?.workspaceId ?? '');

  return finish({
    id: id ?? 'derived',
    name: name ?? 'Derived solution',
    workspaceId,
    components,
    dataTables,
    wires: [],
    coverage: [],
    droppedWires: [],
    source,
    baseDir,
    sourceDirs,
    errors,
    truncated,
  });
}

/** Derive from a declared solution spec (`spec/*.solution.json`). */
export function deriveFromSpec(specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const meta = spec.metadata ?? {};

  const components = (spec.components ?? [])
    .map((c) => ({ key: c.key, kind: c.kind, id: c.live?.id ?? c.id }))
    .filter((c) => c.key && c.kind);
  const declared = new Set(components.map((c) => c.key));

  const wires = [];
  const droppedWires = [];
  for (const w of spec.wiring ?? []) {
    const relation = RELATION_MAP[w.relation];
    if (!relation) {
      droppedWires.push(`${w.from} → ${w.to} (${w.relation}): preflight has no resolver for this relation`);
      continue;
    }
    if (!declared.has(w.from) || !declared.has(w.to)) {
      droppedWires.push(`${w.from} → ${w.to} (${w.relation}): an endpoint is not a declared component`);
      continue;
    }
    wires.push({ from: w.from, to: w.to, relation, ...(w.note ? { note: w.note } : {}) });
  }

  // The spec's own coverage assertions, where it carries them, in preflight's shape.
  const coverage = [];
  for (const c of spec.components ?? []) {
    for (const cov of c.covers ?? []) {
      coverage.push({ component: c.key, id: cov.id, in: cov.in, match: cov.match ?? 'normalized', minRatio: cov.minRatio ?? 1, of: cov.of });
    }
  }

  return finish({
    id: meta.id ?? 'derived-from-spec',
    name: meta.name ?? 'Derived from spec',
    workspaceId: String(meta.workspaceId ?? ''),
    components,
    dataTables: [],
    wires,
    coverage,
    droppedWires,
    source: `spec:${specPath}`,
    errors: [],
    truncated: false,
  });
}

function finish(d) {
  const components = d.components.map(({ $record, ...c }) => c);
  const prefix = commonTablePrefix(d.dataTables);
  // Keyed on what was actually derived, not on the seed source: a registry-seeded
  // run still derives dataTables from the graph, and still declares no wires.
  const fromSpec = d.source.startsWith('spec:');
  const fromLive = !fromSpec;
  const seededFromRegistry = d.source.startsWith('registry:');

  const provenance = {
    derivedAt: new Date().toISOString(),
    source: d.source,
    fields: {
      components: fromLive
        ? `derived: ${d.components.length} record(s) — ${seededFromRegistry ? 'every id in the registry, kind confirmed by probing the platform' : 'seeds'}, plus every typed reference walked out of them`
        : 'derived: the spec\'s component list, with live ids where the spec carries them',
      dataTables: fromLive
        ? `derived from DATA_TABLE node tableName literals (${d.dataTables.length} found)`
        : 'not carried by the spec — declare or derive from live to enable DT-TABLE-LIVE',
      tablePrefix: prefix ? `derived: common prefix "${prefix}"` : 'no common prefix found — the stray-table branch of DT-TABLE-LIVE is inert',
      wires: d.wires.length ? `derived from the spec's wiring (${d.wires.length} resolvable)` : NOT_DERIVED.wires,
      coverage: d.coverage.length ? `derived from the spec's coverage assertions (${d.coverage.length})` : NOT_DERIVED.coverage,
      allowedIntegrations: NOT_DERIVED.allowedIntegrations,
      allowedOutbound: NOT_DERIVED.allowedOutbound,
    },
    /** Rule branches this derivation leaves unexercised. Printed, never counted as passing. */
    unexercised: [
      ...(fromLive && d.dataTables.length ? [UNEXERCISED_BY_LIVE_TABLES] : []),
      ...(fromLive && !seededFromRegistry
        ? [
            'components: a walk from seeds discovers only what is REACHABLE THROUGH A WORKING LINK. ' +
              'A component wired to nothing — the failure preflight most exists to catch — is invisible ' +
              'to it and is therefore not checked at all. Seed from the id registry (--state) rather ' +
              'than from a handful of ids, or confirm the component list by hand.',
          ]
        : []),
      ...(d.wires.length === 0
        ? [
            'WIRE-RESOLVES: no wires declared, so it reports SKIP rather than pass.',
            'CHATFLOW-DOWNSTREAM-EFFECTIVE: its hand-off branch is driven by declared wires, so with none it ' +
              'checks no hand-off — but it reports PASS, not skip, because its other branch (a stray ' +
              'boundAgentId field) still ran. Read that "pass" as "no hand-off was asserted", not as "the ' +
              'hand-off works". This is a real reporting gap in the rule, not in the derivation.',
          ]
        : []),
      ...(d.coverage.length === 0 ? ['COVERAGE: no set declared, so it reports SKIP rather than pass. An existence check is not a coverage check.'] : []),
    ],
    ...(d.droppedWires.length ? { droppedWires: d.droppedWires } : {}),
    ...(d.errors.length ? { fetchErrors: d.errors } : {}),
    ...(d.truncated ? { truncated: 'the component walk hit its ceiling — the manifest is incomplete' } : {}),
    humanMustConfirm: [
      'allowedOutbound / allowedIntegrations: derivation deliberately leaves these empty. Read every finding and authorise, one line each, or remove the node.',
      'coverage: nothing in live state knows what the solution was commissioned to carry. Write it.',
      ...(fromLive ? ['wires: derive from a spec, or write them. Live state cannot state intent without making the check circular.'] : []),
    ],
  };

  return {
    id: d.id,
    name: d.name,
    workspaceId: d.workspaceId,
    // API-WORKFLOW-PUT and GEN-SANDBOX-CRYPTO read the operator's own build
    // code, which lives nowhere in live state. Without a directory they skip,
    // and the skip is printed.
    ...(d.baseDir ? { baseDir: d.baseDir } : {}),
    ...(d.sourceDirs?.length ? { sourceDirs: d.sourceDirs } : {}),
    ...(prefix ? { tablePrefix: prefix } : {}),
    expectLive: true,
    components,
    dataTables: d.dataTables,
    allowedIntegrations: [],
    allowedOutbound: [],
    wires: d.wires,
    coverage: d.coverage,
    provenance,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n, dflt) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const many = (n) => argv.reduce((a, v, i) => (v === `--${n}` ? [...a, argv[i + 1]] : a), []);

  const specPath = opt('spec');
  const out = opt('out');
  let manifest;

  if (specPath) {
    manifest = deriveFromSpec(specPath);
  } else {
    const seeds = many('seed').map((s) => {
      const [kind, ...rest] = String(s).split(':');
      return [kind, rest.join(':')];
    });
    const statePath = opt('state');
    let unresolved = [];
    let source = 'live';
    if (statePath) {
      const r = await seedsFromRegistry(statePath, { log: (m) => console.error(m) });
      seeds.push(...r.seeds);
      unresolved = r.unresolved;
      source = `registry:${statePath}`;
    }
    const namePrefix = opt('name-prefix');
    if (namePrefix) {
      const list = await tryGet('/v2/workflows?size=200');
      const rows = isError(list) ? [] : (list.content ?? list ?? []);
      for (const w of Array.isArray(rows) ? rows : []) {
        if (String(w.name ?? '').startsWith(namePrefix)) seeds.push(['workflow', w.workflowId ?? w.id]);
      }
    }
    if (!seeds.length) {
      console.error('usage: derive.mjs (--spec <solution.json> | --state <state.json> | --seed <kind>:<id> … | --name-prefix <s>) [--out m.json] [--id x] [--name "x"]');
      process.exitCode = 1;
      return;
    }
    manifest = await deriveFromLive(seeds, {
      id: opt('id'),
      name: opt('name'),
      source,
      registryUnresolved: unresolved,
      baseDir: opt('base-dir'),
      sourceDirs: many('source-dir'),
      log: (m) => console.error(m),
    });
  }

  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (out) {
    writeFileSync(out, text);
    console.error(`\nwrote ${out} — ${manifest.components.length} component(s), ${manifest.dataTables.length} table(s)`);
    for (const u of manifest.provenance.unexercised) console.error(`  unexercised: ${u}`);
    for (const h of manifest.provenance.humanMustConfirm) console.error(`  confirm: ${h}`);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`derive could not run: ${e.stack ?? e.message}`);
    process.exitCode = 1;
  });
}
