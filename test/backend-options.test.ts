import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { allTools } from '../src/tools/index.js';
import { selectTools } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import {
  BACKEND_OPTION_CONTRACT,
  DEPLOY_OPTIONS,
  DEPLOY_OPTION_ALIASES,
  TERMINAL_DEPLOY_PHASES,
  DEPLOY_PHASES,
  CHATFLOW_CHANNELS,
  WIDGET_VIEW_TYPES,
  UNRESOLVED_BINDING_SOURCE_TYPES,
  WIDGET_BINDING_SOURCE_TYPES,
  toWireDeployOption,
} from '../src/contracts/backend-options.js';

/** Pull every literal out of a zod enum living anywhere in a tool's input schema. */
function enumValuesIn(schema: unknown, found: Set<string>[] = []): Set<string>[] {
  const def = (schema as any)?._def;
  if (!def) return found;
  if (def.typeName === 'ZodEnum') found.push(new Set(def.values as string[]));
  for (const child of [def.schema, def.innerType, def.type, def.left, def.right, def.valueType]) {
    if (child) enumValuesIn(child, found);
  }
  for (const opt of (def.options as unknown[]) ?? []) enumValuesIn(opt, found);
  if (typeof def.shape === 'function') for (const v of Object.values(def.shape())) enumValuesIn(v, found);
  return found;
}

function toolNamed(name: string) {
  const t = allTools.find(x => x.name === name);
  assert.ok(t, `${name} is not registered`);
  return t!;
}

function hasEnumEqualTo(name: string, expected: readonly string[]) {
  const wanted = new Set(expected);
  return enumValuesIn(toolNamed(name).inputSchema).some(
    s => s.size === wanted.size && [...wanted].every(v => s.has(v))
  );
}

test('governed option lists are non-empty and carry backend provenance', () => {
  const entries = Object.entries(BACKEND_OPTION_CONTRACT.options);
  assert.ok(entries.length >= 15, `expected the full governed set, got ${entries.length}`);
  for (const [key, entry] of entries) {
    const e = entry as any;
    assert.ok(Array.isArray(e.values) && e.values.length > 0, `${key} has no values`);
    assert.ok(e.backend?.file && e.backend?.extract, `${key} has no backend provenance`);
    assert.equal(new Set(e.values).size, e.values.length, `${key} has duplicates`);
    for (const v of e.values) assert.equal(typeof v, 'string', `${key} value is not a string`);
    // A narrowing must explain itself, or it is indistinguishable from drift.
    if (e.narrowedFrom) {
      assert.ok(Array.isArray(e.narrowedFrom.omitted) && e.narrowedFrom.omitted.length > 0, `${key} narrowedFrom is empty`);
      assert.ok(String(e.narrowedFrom.why).length > 40, `${key} narrowing has no reason`);
    }
  }
});

test('tool schemas advertise the contract values, not restated literals', () => {
  assert.ok(hasEnumEqualTo('swfte_widgets_configure', WIDGET_VIEW_TYPES), 'widget viewType');
  assert.ok(hasEnumEqualTo('swfte_widget_bindings_create', WIDGET_BINDING_SOURCE_TYPES), 'binding sourceType');
  assert.ok(hasEnumEqualTo('swfte_chatflows_session_start', CHATFLOW_CHANNELS), 'chatflow channel');
  assert.ok(
    hasEnumEqualTo('swfte_deploy', [...DEPLOY_OPTIONS, ...Object.keys(DEPLOY_OPTION_ALIASES)]),
    'deploy option accepts wire values and aliases'
  );
});

test('no governed option is restated as a raw literal array in src', () => {
  // The point of the contract file is that there is exactly one copy. A tool
  // that re-declares the same list is how the last drift happened.
  const governed: Array<[string, readonly string[]]> = [
    ['widget.viewType', WIDGET_VIEW_TYPES],
    ['chatflow.channel', CHATFLOW_CHANNELS],
    ['deploy.phase', DEPLOY_PHASES],
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts') && !p.includes('/contracts/')) files.push(p);
    }
  };
  walk('src');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [key, values] of governed) {
      const restated = values.every(v => text.includes(`'${v}'`));
      assert.ok(!restated, `${file} restates the whole ${key} list; import it from src/contracts/backend-options.ts`);
    }
  }
});

test('terminal deploy phases are a subset of the phases the backend can emit', () => {
  for (const phase of TERMINAL_DEPLOY_PHASES) {
    assert.ok(DEPLOY_PHASES.includes(phase), `${phase} is not a DeploymentStatusEvent.Phase value`);
  }
  // Regression: the previous hand-written set waited for these two, which the
  // backend cannot produce, and omitted TERMINATED, which it can.
  assert.ok(!TERMINAL_DEPLOY_PHASES.has('CANCELLED'));
  assert.ok(!TERMINAL_DEPLOY_PHASES.has('DESTROYED'));
  assert.ok(TERMINAL_DEPLOY_PHASES.has('TERMINATED'));
  // In-flight phases must not be terminal, or a poller stops early.
  for (const phase of ['QUEUED', 'SIZING', 'PROVISIONING', 'DEPLOYING', 'UNKNOWN']) {
    assert.ok(!TERMINAL_DEPLOY_PHASES.has(phase), `${phase} must not end polling`);
  }
});

test('both deploy option spellings normalise to the wire value', () => {
  assert.equal(toWireDeployOption('shared'), 'SHARED_CLOUD');
  assert.equal(toWireDeployOption('SHARED_CLOUD'), 'SHARED_CLOUD');
  assert.equal(toWireDeployOption('BYO'), 'BYO_CLOUD_DEDICATED');
  assert.equal(toWireDeployOption('DEDICATED_INSTANCE'), 'DEDICATED_INSTANCE');
  assert.equal(toWireDeployOption(undefined), undefined);
  assert.throws(() => toWireDeployOption('SHARED'), /UNSUPPORTED_DEPLOY_OPTION/);
});

test('a source type with no registered adapter is advertised as unresolvable, not as working', () => {
  assert.deepEqual([...UNRESOLVED_BINDING_SOURCE_TYPES], ['STUDIO_OPERATIONS']);
  for (const v of UNRESOLVED_BINDING_SOURCE_TYPES) {
    assert.ok(WIDGET_BINDING_SOURCE_TYPES.includes(v), `${v} must still be creatable — the wizard writes it`);
  }
  const why = (BACKEND_OPTION_CONTRACT.options['widget.bindingSourceType'] as any).persistedButUnresolved.why;
  assert.match(String(why), /no WidgetDataSourceAdapter/i);
});

test('zod really rejects a value outside a governed list', () => {
  // Guards the guard: if the schemas were plain strings these tests prove nothing.
  const schema = toolNamed('swfte_widgets_configure').inputSchema as z.ZodTypeAny;
  assert.throws(() => schema.parse({ widgetId: 'w', configuration: { viewType: 'NOT_A_VIEW' } }));
  assert.ok(schema.safeParse({ widgetId: 'w', configuration: { viewType: 'TABLE' } }).success);
});

test('the documented tool counts are the real ones', () => {
  // README.md, docs/TOOLS.md and docs/ATTACH.md all advertised 119/69 while the
  // server registered 183 and advertised 96. A count in prose is a claim like
  // any other, and this is the cheapest place to keep it true.
  const total = allTools.length;
  const advertised = selectTools(allTools, loadConfig({ SWFTE_PAT: 'pat_x' } as never)).length;
  for (const file of ['README.md', 'docs/TOOLS.md', 'docs/ATTACH.md']) {
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(String(total)), `${file} does not mention the real tool count (${total})`);
    assert.ok(text.includes(String(advertised)), `${file} does not mention the real default count (${advertised})`);
    assert.ok(!/\b119 tools\b/.test(text), `${file} still claims 119 tools`);
  }
  const config = readFileSync('src/config.ts', 'utf8');
  assert.ok(!/~?119 tools/.test(config), 'src/config.ts still claims 119 tools');
});
