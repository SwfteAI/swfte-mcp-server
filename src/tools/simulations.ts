/**
 * Swfte Simulations tools.
 *
 * Provenance: original (Swfte Simulations). Not derived from MiroFish.
 *
 * The MCP holds no simulation logic. `swfte_simulation_validate` is a local,
 * network-free structural check driven entirely by the published v1 JSON
 * Schema (src/contracts/simulation.v1.schema.json); everything else calls the
 * agents-service `/v2/simulations` API and summarises what it returns.
 * Server-only rules (target ownership, sandbox-only deployment, pack
 * resolution, flags, roles) are enforced by the server on create.
 *
 * Wording rules: UNKNOWN is never PASS, and a report supports an audit; it is
 * not an audit opinion.
 */
import { z } from 'zod';
import { parseDocument } from 'yaml';
import schemaJson from '../contracts/simulation.v1.schema.json';
import {
  SIMULATION_DIMENSIONS,
  TERMINAL_RUN_STATUSES,
  type SimulationCoverageCell,
  type SimulationEstimate,
  type SimulationFinding,
  type SimulationRun,
  type SimulationValidationPack,
  type SpecError,
} from '../contracts/simulations.js';
import type { ToolDefinition } from './_types.js';

export const SIMULATIONS_BASE = '/v2/simulations';
export const REPORT_DISCLAIMER = 'Supports your audit; not an audit opinion.';
const UNKNOWN_RULE = 'UNKNOWN is never PASS: an untested or inconclusive cell is reported as a gap, not a pass.';

/* ── local schema check (subset of JSON Schema 2020-12 used by the v1 schema) ── */

type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  propertyNames?: Schema;
  maxProperties?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  $defs?: Record<string, Schema>;
};

const ROOT_SCHEMA = schemaJson as unknown as Schema;
const patternCache = new Map<string, RegExp>();
const re = (p: string): RegExp => {
  let r = patternCache.get(p);
  if (!r) {
    r = new RegExp(p, 'u');
    patternCache.set(p, r);
  }
  return r;
};

/** RFC 6901 JSON pointer segment escaping. */
const ptr = (base: string, seg: string | number): string =>
  `${base}/${String(seg).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function resolveRef(ref: string): Schema {
  const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
  const def = m ? ROOT_SCHEMA.$defs?.[m[1]!] : undefined;
  if (!def) throw new Error(`Unsupported $ref in simulation schema: ${ref}`);
  return def;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: string, v: unknown): boolean {
  const actual = typeOf(v);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

/** Stable deep equality for uniqueItems / const (JSON values only). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

function check(schema: Schema, value: unknown, path: string, errors: SpecError[]): void {
  if (schema.$ref) {
    check(resolveRef(schema.$ref), value, path, errors);
    return;
  }
  const at = path || '/';
  if (typeof value === 'number' && !Number.isFinite(value)) {
    errors.push({ path: at, code: 'TYPE', message: 'must be a finite JSON number' });
    return;
  }
  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) {
    errors.push({ path: at, code: 'CONST', message: `must be ${show(schema.const)}, got ${show(value)}` });
    return;
  }
  if (schema.enum && !schema.enum.some((e) => canonical(e) === canonical(value))) {
    errors.push({ path: at, code: 'ENUM', message: `must be one of ${schema.enum.map((e) => show(e)).join(', ')}, got ${show(value)}` });
    return;
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push({ path: at, code: 'TYPE', message: `must be ${schema.type}, got ${typeOf(value)}` });
    return;
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      errors.push({ path: at, code: 'MIN_LENGTH', message: `must be at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
      errors.push({ path: at, code: 'MAX_LENGTH', message: `must be at most ${schema.maxLength} characters` });
    if (schema.pattern && !re(schema.pattern).test(value))
      errors.push({ path: at, code: 'PATTERN', message: `${show(value)} does not match ${schema.pattern}` });
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push({ path: at, code: 'MINIMUM', message: `must be >= ${schema.minimum}, got ${value}` });
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push({ path: at, code: 'MAXIMUM', message: `must be <= ${schema.maximum}, got ${value}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      errors.push({ path: at, code: 'EXCLUSIVE_MINIMUM', message: `must be > ${schema.exclusiveMinimum}, got ${value}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      errors.push({ path: at, code: 'EXCLUSIVE_MAXIMUM', message: `must be < ${schema.exclusiveMaximum}, got ${value}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push({ path: at, code: 'MIN_ITEMS', message: `must have at least ${schema.minItems} item(s)` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push({ path: at, code: 'MAX_ITEMS', message: `must have at most ${schema.maxItems} items` });
    if (schema.uniqueItems) {
      const seen = new Map<string, number>();
      value.forEach((item, i) => {
        const key = canonical(item);
        const first = seen.get(key);
        if (first !== undefined)
          errors.push({ path: ptr(path, i), code: 'DUPLICATE', message: `duplicates item ${first} (${show(item)})` });
        else seen.set(key, i);
      });
    }
    if (schema.items) value.forEach((item, i) => check(schema.items!, item, ptr(path, i), errors));
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (const req of schema.required ?? [])
      if (!(req in obj)) errors.push({ path: ptr(path, req), code: 'REQUIRED', message: `${req} is required` });
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      errors.push({ path: at, code: 'MAX_PROPERTIES', message: `must have at most ${schema.maxProperties} entries` });
    for (const k of keys) {
      const child = ptr(path, k);
      if (schema.propertyNames) {
        const nameErrors: SpecError[] = [];
        check(schema.propertyNames, k, child, nameErrors);
        for (const e of nameErrors) errors.push({ ...e, code: 'PROPERTY_NAME', message: `key ${show(k)}: ${e.message}` });
      }
      const prop = schema.properties?.[k];
      if (prop) check(prop, obj[k], child, errors);
      else if (schema.additionalProperties === false)
        errors.push({ path: child, code: 'UNKNOWN_FIELD', message: `${k} is not a field of simulation.yaml v1 here` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        check(schema.additionalProperties, obj[k], child, errors);
    }
  }
}

/** Validate a spec object against the v1 schema. Pure; no network. */
export function validateSpecObject(spec: unknown): { valid: boolean; errors: SpecError[] } {
  const errors: SpecError[] = [];
  check(ROOT_SCHEMA, spec, '', errors);
  return { valid: errors.length === 0, errors };
}

/** Parse simulation.yaml text (YAML 1.2, JSON is a subset) and validate it. */
export function validateSpecYaml(text: string): { valid: boolean; errors: SpecError[] } {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    return {
      valid: false,
      errors: doc.errors.map((e) => ({
        path: '',
        code: 'YAML_SYNTAX',
        message: e.linePos?.[0] ? `line ${e.linePos[0].line}, column ${e.linePos[0].col}: ${e.message.split('\n')[0]}` : e.message.split('\n')[0]!,
      })),
    };
  }
  return validateSpecObject(doc.toJS({ maxAliasCount: 50 }));
}

/* ── API helpers ─────────────────────────────────────────────────────────── */

const RunId = z.string().regex(/^sim_[A-Za-z0-9]{1,64}$/, 'a simulation run id, "sim_…"').describe('Simulation run id, "sim_…".');
const Workspace = z.string().min(1).optional().describe('Workspace override; defaults to the configured workspace.');
const SpecInput = {
  yaml: z.string().min(1).max(256 * 1024).optional().describe('simulation.yaml text.'),
  spec: z.record(z.unknown()).optional().describe('The spec as an object (same shape as the YAML).'),
};

const runPath = (id: string, suffix = '') => `${SIMULATIONS_BASE}/${encodeURIComponent(id)}${suffix}`;

function requireOneSpec(input: { yaml?: string; spec?: Record<string, unknown> }): void {
  if ((input.yaml === undefined) === (input.spec === undefined)) throw new Error('Pass exactly one of `yaml` or `spec`.');
}

/** Coverage counts per dimension; UNKNOWN stays UNKNOWN even when passes exist. */
export function coverageByDimension(cells: SimulationCoverageCell[] = []) {
  const out: Record<string, { pass: number; fail: number; unknown: number; notApplicable: number }> = {};
  for (const d of SIMULATION_DIMENSIONS) out[d] = { pass: 0, fail: 0, unknown: 0, notApplicable: 0 };
  for (const c of cells) {
    const row = (out[c.dimension] ??= { pass: 0, fail: 0, unknown: 0, notApplicable: 0 });
    if (!c.applicable) row.notApplicable++;
    else if (c.outcome === 'PASS') row.pass++;
    else if (c.outcome === 'FAIL') row.fail++;
    else row.unknown++;
  }
  return out;
}

const round = (n: number | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const rounded = Math.round(n * 10_000) / 10_000;
  return Number.isFinite(rounded) ? rounded : n;
};

/** Preserve actual saved identity and provenance before presenting reusable material. */
// Admission of wire shape/identity only. Java FullContentHash is authoritative;
// JSON parsing can erase BigDecimal scale, so this client does not recompute its checksum.
function savedObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function savedText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function savedHash(value: unknown, prefixed = false): boolean {
  return typeof value === 'string' && (prefixed ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(value)
}
function savedVersion(value: unknown): boolean { return value == null || (typeof value === 'number' && Number.isSafeInteger(value)) }
function savedActualVersion(value: unknown): boolean { return value == null || savedText(value) }
function savedStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
const savedTargetKinds = ['workflow', 'agent', 'chatflow', 'app', 'widget', 'worker_box']
function savedTerminalStatus(value: unknown): boolean {
  return typeof value === 'string' && ['DONE', 'FAILED', 'STOPPED', 'BUDGET_EXHAUSTED'].includes(value)
}
function savedProvenanceShape(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.sourcePacks) && payload.sourcePacks.every(item => savedObject(item)
    && savedText(item.ref) && typeof item.kind === 'string' && ['PERSONA', 'SCENARIO', 'FAULT'].includes(item.kind)
    && savedHash(item.manifestHash)) && savedStrings(payload.unavailableDeclarations)
}
function savedPayloadShape(payload: Record<string, unknown>): boolean {
  return savedHash(payload.sourceSpecHash) && savedObject(payload.spec)
    && payload.spec.apiVersion === 'swfte.dev/simulation/v1' && payload.spec.kind === 'Simulation' && savedObject(payload.spec.spec)
    && (payload.industry == null || typeof payload.industry === 'string')
    && [payload.scenarios, payload.faults, payload.findings].every(items => Array.isArray(items) && items.every(savedObject))
    && savedObject(payload.evidenceHeads) && Object.values(payload.evidenceHeads).every(value => typeof value === 'string')
}
function savedRawTargetShape(payload: Record<string, unknown>, workspaceId: unknown): boolean {
  const target = payload.target
  return savedObject(target) && typeof target.kind === 'string' && savedTargetKinds.some(kind => kind.toUpperCase() === target.kind)
    && payload.artifactKind === target.kind.toLowerCase() && savedText(target.id) && target.workspaceId === workspaceId
    && target.environment === 'sandbox' && savedHash(target.contentHash, true) && savedVersion(target.version)
    && savedActualVersion(target.actualVersion) && savedStrings(target.instanceIds)
}
function createdTargetShape(value: unknown): boolean {
  return savedObject(value) && typeof value.kind === 'string' && savedTargetKinds.includes(value.kind)
    && savedText(value.id) && value.environment === 'sandbox' && savedHash(value.contentHash, true)
    && savedVersion(value.version) && savedActualVersion(value.actualVersion)
}
function savedWorkspaceMatches(value: unknown, expected?: string): boolean {
  return savedText(value) && (expected === undefined || value === expected)
}
function savedFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function savedNonnegativeNumber(value: unknown): boolean { return savedFiniteNumber(value) && value >= 0 }
function savedCount(value: unknown): boolean { return savedFiniteNumber(value) && value >= 0 && Number.isInteger(value) }
function savedNullableString(value: unknown): boolean { return value == null || typeof value === 'string' }
function savedCoverageShape(value: unknown): boolean {
  return Array.isArray(value) && value.every(cell => savedObject(cell) && typeof cell.elementId === 'string'
    && typeof cell.dimension === 'string' && (SIMULATION_DIMENSIONS as readonly string[]).includes(cell.dimension)
    && typeof cell.applicable === 'boolean' && [cell.passes, cell.fails, cell.unknowns].every(savedCount)
    && typeof cell.outcome === 'string' && ['PASS', 'FAIL', 'UNKNOWN'].includes(cell.outcome) && savedStrings(cell.evidenceIds))
}
function savedRoutingShape(value: unknown): boolean {
  return value == null || (savedObject(value)
    && (value.chains === undefined || (savedObject(value.chains) && Object.values(value.chains).every(savedStrings)))
    && (value.residencyApplied === undefined || typeof value.residencyApplied === 'boolean'))
}
function savedRunFieldsShape(value: Record<string, unknown>): boolean {
  const budget = value.budget, counters = value.counters
  return [value.mode, value.profile, value.specVersion, value.createdAt].every(savedText)
    // A Java signed long may exceed exact JS precision; shape admission is not identity verification.
    && savedFiniteNumber(value.seed) && Number.isInteger(value.seed)
    && savedObject(budget) && [budget.usdPersonas, budget.usdSystemUnderTest, budget.usdReport].every(savedNonnegativeNumber)
    && savedCount(budget.maxSteps) && savedObject(counters)
    && [counters.personas, counters.sessionsPlanned, counters.sessionsDone, counters.sessionsUnknown, counters.steps, counters.findings].every(savedCount)
    && [counters.usdPersonas, counters.usdSystemUnderTest, counters.usdReport].every(savedNonnegativeNumber)
    && savedCoverageShape(value.coverage) && savedFiniteNumber(value.completeness) && value.completeness >= 0 && value.completeness <= 1
    && savedRoutingShape(value.routing) && [value.name, value.startedAt, value.finishedAt, value.error].every(savedNullableString)
}

function savedCreatedShape(value: unknown, workspaceId?: string): value is SimulationRun {
  return savedObject(value) && typeof value.id === 'string' && /^sim_[A-Za-z0-9]{1,64}$/.test(value.id)
    && value.status === 'CREATED' && savedWorkspaceMatches(value.workspaceId, workspaceId)
    && savedHash(value.specHash) && createdTargetShape(value.target) && savedRunFieldsShape(value)
}

function requireValidationPack(value: unknown, sourceRunId: string, workspaceId?: string): SimulationValidationPack {
  const pack = value as Partial<SimulationValidationPack> | null;
  if (!pack || pack.runId !== sourceRunId || pack.ref !== `validation/${sourceRunId}@1`
      || typeof pack.workspaceId !== 'string' || !pack.workspaceId || (workspaceId && pack.workspaceId !== workspaceId)
      || typeof pack.contentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(pack.contentHash)
      || !savedObject(pack.payload) || pack.payload.schemaVersion !== 1 || pack.payload.sourceRunId !== sourceRunId || pack.payload.evidenceKind !== 'simulation'
      || !savedPayloadShape(pack.payload) || !savedProvenanceShape(pack.payload) || !savedTerminalStatus(pack.payload.sourceStatus)
      || !savedRawTargetShape(pack.payload, pack.workspaceId)) {
    throw new Error('VALIDATION_PACK_INVALID: saved identity or simulation provenance is unavailable.');
  }
  return pack as SimulationValidationPack;
}

export function summarizeRun(run: SimulationRun) {
  const c = run.counters;
  const b = run.budget;
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    terminal: TERMINAL_RUN_STATUSES.includes(run.status),
    mode: run.mode,
    profile: run.profile,
    target: run.target,
    specHash: run.specHash,
    counters: c,
    completeness: run.completeness,
    budget: b && c
      ? {
          usdPersonas: { spent: round(c.usdPersonas), limit: b.usdPersonas },
          usdSystemUnderTest: { spent: round(c.usdSystemUnderTest), limit: b.usdSystemUnderTest },
          usdReport: { spent: round(c.usdReport), limit: b.usdReport },
          steps: { used: c.steps, limit: b.maxSteps },
        }
      : undefined,
    coverage: coverageByDimension(run.coverage),
    error: run.error ?? undefined,
    note: UNKNOWN_RULE,
  };
}

/* ── tools ───────────────────────────────────────────────────────────────── */

export const simulationTools: ToolDefinition[] = [
  {
    name: 'swfte_simulation_validate',
    title: 'Check a simulation.yaml locally',
    description:
      'Local, network-free check of a simulation.yaml (text) or spec object against the published v1 JSON Schema: ' +
      'unknown fields, types, enums, patterns (pack refs "publisher/name@version"), ranges, duplicates, and ' +
      'environment must be "sandbox". Returns {valid, errors:[{path, code, message}]} with JSON-pointer paths. ' +
      'Server-only rules (target ownership, sandbox deployment, pack resolution, flags, roles) are not checked here; ' +
      'swfte_simulation_create checks them.',
    readOnly: true,
    inputSchema: z.object(SpecInput),
    execute: async (input) => {
      requireOneSpec(input);
      return input.yaml !== undefined ? validateSpecYaml(input.yaml) : validateSpecObject(input.spec);
    },
  },
  {
    name: 'swfte_simulation_create',
    title: 'Create a simulation run',
    description:
      'POST /v2/simulations with {yaml} or {spec}. The server validates everything (schema plus ownership, ' +
      'sandbox-only target, packs, flags, roles). Or pass validationPackRunId to explicitly reuse saved redacted ' +
      'simulation material through the server, with current source-pack and policy validation. Returns {created:true, run:{id, status, specHash, …}} or ' +
      '{created:false, errors:[{path, code, message}]}. Creating spends nothing; swfte_simulation_start does.',
    inputSchema: z.object({ ...SpecInput, validationPackRunId: RunId.optional(), acceptableUseAcknowledged: z.boolean().optional(), workspaceId: Workspace }),
    execute: async (input, { client }) => {
      if ([input.yaml, input.spec, input.validationPackRunId].filter(value => value !== undefined).length !== 1) throw new Error('Pass exactly one of `yaml`, `spec` or `validationPackRunId`.');
      const body = input.validationPackRunId !== undefined ? {} : input.yaml !== undefined ? { yaml: input.yaml } : { spec: input.spec };
      if (input.acceptableUseAcknowledged === true) Object.assign(body, { acceptableUseAcknowledged: true });
      const res = await client.request<Record<string, unknown>>({
        method: 'POST',
        path: input.validationPackRunId !== undefined ? `${SIMULATIONS_BASE}/validation-packs/${encodeURIComponent(input.validationPackRunId)}/reuse` : SIMULATIONS_BASE,
        body,
        workspaceId: input.workspaceId,
        expectStatuses: [400, 409],
      });
      if (input.validationPackRunId !== undefined) {
        // Expected 400/409 server refusals retain their original envelope; malformed successes refuse.
        const refusal = savedObject(res) && (typeof res.code === 'string' || typeof res.error === 'string'
          || (res.valid === false && Array.isArray(res.errors)))
        if (!refusal && !savedCreatedShape(res, input.workspaceId ?? client.configuredWorkspaceId)) {
          throw new Error('VALIDATION_PACK_REUSE_INVALID: saved reuse creation identity is unavailable.')
        }
        if (refusal) {
          const envelope = res as Record<string, unknown>
          return { created: false, valid: false, errors: Array.isArray(envelope.errors) ? envelope.errors : [],
            code: typeof envelope.code === 'string' ? envelope.code : typeof envelope.error === 'string' ? envelope.error : undefined,
            message: typeof envelope.message === 'string' ? envelope.message : undefined }
        }
      }
      if (res && typeof res === 'object' && typeof res.id === 'string') {
        const run = res as unknown as SimulationRun;
        return { created: true, run: { id: run.id, status: run.status, specHash: run.specHash, mode: run.mode, profile: run.profile, target: run.target, budget: run.budget } };
      }
      const raw = res as Record<string, unknown> | undefined;
      const errors = (raw?.errors as SpecError[] | undefined) ?? [];
      const code = typeof raw?.code === 'string' ? raw.code : typeof raw?.error === 'string' ? raw.error : undefined;
      return { created: false, valid: false, errors, code, message: typeof raw?.message === 'string' ? raw.message : undefined };
    },
  },
  {
    name: 'swfte_simulation_start',
    title: 'Start a simulation run',
    description:
      'POST /v2/simulations/{id}/start (the binding gate: flags, role, quota, credit, budget). With estimate:true ' +
      '(default) it first calls POST /estimate (advisory, no spend) and includes the result; with ' +
      'onlyIfWithinBudget:true it refuses over-budget, missing or unpriced estimates. Actual model/execution admission always requires a known bounded price and reserves the shared cap first.',
    inputSchema: z.object({
      id: RunId,
      estimate: z.boolean().default(true).describe('Fetch the advisory estimate first.'),
      onlyIfWithinBudget: z.boolean().default(false).describe('Refuse to start when the estimate is over budget.'),
      workspaceId: Workspace,
    }),
    execute: async (input, { client }) => {
      let estimate: SimulationEstimate | undefined;
      if (input.estimate || input.onlyIfWithinBudget) {
        estimate = await client.request<SimulationEstimate>({ method: 'POST', path: runPath(input.id, '/estimate'), workspaceId: input.workspaceId });
        if (input.onlyIfWithinBudget) {
          if (!estimate || !Array.isArray(estimate.unpricedModels) || typeof estimate.withinBudget !== 'boolean'
              || typeof estimate.usdCeiling !== 'number' || !Number.isFinite(estimate.usdCeiling) || estimate.usdCeiling < 0) {
            return { started: false, reason: 'ESTIMATE_UNAVAILABLE', estimate };
          }
          if (estimate.unpricedModels.length) return { started: false, reason: 'ESTIMATE_UNPRICED', estimate };
          if (estimate.withinBudget !== true) return { started: false, reason: 'ESTIMATE_OVER_BUDGET', estimate };
        }
      }
      await client.request({ method: 'POST', path: runPath(input.id, '/start'), workspaceId: input.workspaceId });
      return { started: true, id: input.id, estimate, next: 'Poll swfte_simulation_status until terminal.' };
    },
  },
  {
    name: 'swfte_simulation_status',
    title: 'Simulation run status',
    description:
      'GET /v2/simulations/{id}, summarised: status (and whether it is terminal), counters, completeness, budget ' +
      `spend vs limit, and per-dimension coverage counts (pass/fail/unknown/notApplicable). ${UNKNOWN_RULE}`,
    readOnly: true,
    inputSchema: z.object({ id: RunId, workspaceId: Workspace }),
    execute: async (input, { client }) => {
      const run = await client.request<SimulationRun>({ method: 'GET', path: runPath(input.id), workspaceId: input.workspaceId });
      return summarizeRun(run);
    },
  },
  {
    name: 'swfte_simulation_findings',
    title: 'Simulation findings',
    description:
      'GET /v2/simulations/{id}/findings, optionally filtered by severity and dimension. Gap findings (untested or ' +
      `inconclusive cells) are included and marked gap:true. ${UNKNOWN_RULE}`,
    readOnly: true,
    inputSchema: z.object({
      id: RunId,
      severity: z.array(z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'])).optional(),
      dimension: z.array(z.enum(SIMULATION_DIMENSIONS)).optional(),
      includeGaps: z.boolean().default(true),
      workspaceId: Workspace,
    }),
    execute: async (input, { client }) => {
      const res = await client.request<{ findings?: SimulationFinding[] }>({ method: 'GET', path: runPath(input.id, '/findings'), workspaceId: input.workspaceId });
      const all = res?.findings ?? [];
      const findings = all.filter(
        (f) =>
          (!input.severity?.length || input.severity.includes(f.severity)) &&
          (!input.dimension?.length || input.dimension.includes(f.dimension)) &&
          (input.includeGaps || !f.gap),
      );
      return {
        total: all.length,
        returned: findings.length,
        gaps: findings.filter((f) => f.gap).length,
        findings: findings.map((f) => ({ ...f, gap: Boolean(f.gap), kind: f.gap ? 'GAP (untested, not a pass)' : 'FAILURE' })),
      };
    },
  },
  {
    name: 'swfte_simulation_report',
    title: 'Simulation report',
    description:
      `GET /v2/simulations/{id}/report?format=md|json; format=validation-pack reads saved workspace-private redacted simulation material for explicit reuse. ${REPORT_DISCLAIMER} ${UNKNOWN_RULE} Every claim cites evidence ids.`,
    readOnly: true,
    inputSchema: z.object({
      id: RunId,
      format: z.enum(['md', 'json', 'validation-pack']).default('json'),
      workspaceId: Workspace,
    }),
    execute: async (input, { client }) => {
      if (input.format === 'validation-pack') {
        const saved = await client.request<unknown>({ method: 'GET', path: `${SIMULATIONS_BASE}/validation-packs/${encodeURIComponent(input.id)}`, workspaceId: input.workspaceId });
        const pack = requireValidationPack(saved,input.id,input.workspaceId ?? client.configuredWorkspaceId);
        return { format: 'validation-pack', evidenceKind: pack.payload.evidenceKind, disclaimer: REPORT_DISCLAIMER, pack };
      }
      const md = input.format === 'md';
      const res = await client.request<unknown>({
        method: 'GET',
        path: runPath(input.id, '/report'),
        query: { format: input.format },
        headers: md ? { Accept: 'text/markdown' } : undefined,
        workspaceId: input.workspaceId,
      });
      if (md) return { format: 'md', disclaimer: REPORT_DISCLAIMER, markdown: typeof res === 'string' ? res : JSON.stringify(res) };
      return { format: 'json', disclaimer: REPORT_DISCLAIMER, report: res };
    },
  },
];
