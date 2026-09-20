#!/usr/bin/env node
/**
 * The negative controls.
 *
 * The X Broker method audit found that six of twenty-one acceptance gates
 * contained a clause no mutation could kill, and that the one declared negative
 * control in the harness asserted `n + 7 !== n` without re-running the check it
 * claimed to control. This file exists so that cannot happen here.
 *
 * For every rule:
 *   1. run it against `fixture.cleanSnapshot()` — it must produce NOTHING.
 *      A rule that fires on a correct solution is worse than no rule.
 *   2. for each declared mutation, break exactly one thing in a fresh clone and
 *      re-run THE SAME RULE BODY — it must produce at least one finding.
 *
 * A rule with no declared mutation, or whose mutation it survives, is reported
 * BROKEN and the harness exits non-zero. Skips do not count as passes.
 *
 *   node preflight/mutation.mjs
 */
import { RULES } from './lib/rules.mjs';
import { cleanSnapshot, clone } from './fixture.mjs';

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => (C ? `[${n}m${s}[0m` : String(s));
const red = (s) => c(31, s);
const green = (s) => c(32, s);
const dim = (s) => c(2, s);
const bold = (s) => c(1, s);

const wf = (s) => s.workflows[0].record;
const comp = (s, k) => s.components.find((x) => x.key === k);

/**
 * Declared mutations, keyed by rule id. Each one breaks the *specific* thing
 * the rule promises to catch, phrased as the mistake a real operator makes.
 */
const MUTATIONS = {
  'DT-CODE-RESULT-ROOT': [
    ['reference a code node result without the .result root', (s) => { wf(s).nodes.persist.configuration.rows = '[{"n": "{{shape.count}}"}]'; }],
    ['same mistake inside a nested template', (s) => { wf(s).nodes.gate.configuration.condition = '{{shape.rowsJson}} not_empty'; }],
  ],
  'DT-ROWS-NOT-STRING': [
    ['hand rows in as a JSON array, which never gets template-resolved', (s) => { wf(s).nodes.persist.configuration.rows = [{ ref: '{{shape.result.rowsJson}}' }]; }],
    ['hand rows in as a JSON object', (s) => { wf(s).nodes.persist.configuration.rows = { ref: '{{shape.result.ref}}' }; }],
  ],
  'DT-ROWS-BARE-REF': [
    ['point rows at a returned array instead of a JSON string', (s) => {
      wf(s).nodes.shape.configuration.code = 'const rows = items.map(i => ({ref: i.ref}));\nreturn { rows, count: rows.length };';
      wf(s).nodes.persist.configuration.rows = '{{shape.result.rows}}';
    }],
    ['point rows at an upstream node the checker cannot read', (s) => { wf(s).nodes.persist.configuration.rows = '{{fetch.body.items}}'; }],
  ],
  'DT-FILTER-SET-TEMPLATED': [
    ['template a query filter', (s) => { wf(s).nodes.persist.configuration.operation = 'query'; wf(s).nodes.persist.configuration.filter = [{ field: 'ref', value: '{{shape.result.ref}}' }]; }],
    ['template an update set', (s) => { wf(s).nodes.persist.configuration.set = { status: '{{shape.result.status}}' }; }],
  ],
  'DT-TABLE-NAME': [
    ['typo the table name in one of two nodes', (s) => {
      wf(s).nodes.persist2 = { id: 'persist2', type: 'DATA_TABLE', configuration: { operation: 'insert', tableName: 'cf_record', rows: '[]' } };
      wf(s).edges.push({ sourceNodeId: 'persist', sourcePortId: 'out', targetNodeId: 'persist2', targetPortId: 'in' });
    }],
    ['use a table the manifest never declared', (s) => { wf(s).nodes.persist.configuration.tableName = 'cf_scratch'; }],
    ['template the table name', (s) => { wf(s).nodes.persist.configuration.tableName = 'cf_{{shape.result.kind}}'; }],
    ['leave the table name blank', (s) => { wf(s).nodes.persist.configuration.tableName = ''; }],
  ],
  'DT-TABLE-LIVE': [
    ['the declared table never got created', (s) => { s.dataTablesLive = []; }],
    ['the table exists but holds only its schema seed', (s) => { s.dataTablesLive[0].rowCount = 1; }],
    ['a stray table with the solution prefix was minted by a typo', (s) => { s.dataTablesLive.push({ id: 'dt_stray', name: 'cf_record', rowCount: 0 }); }],
  ],
  'GEN-UNRESOLVED-PLACEHOLDER': [
    ['ship a generated {{TODO}}', (s) => { wf(s).nodes.fetch.configuration.credentialId = '{{TODO: API credential}}'; }],
    ['ship an example.com endpoint', (s) => { wf(s).nodes.fetch.configuration.url = 'https://api.example.com/records'; }],
    ['ship a REPLACE_ME literal', (s) => { wf(s).nodes.fetch.configuration.token = 'REPLACE_ME'; }],
  ],
  'GEN-UNDECLARED-INTEGRATION': [
    ['the generator adds Google Drive nobody asked for', (s) => { wf(s).nodes.drive = { id: 'drive', type: 'GOOGLE_DRIVE', configuration: {} }; }],
    ['the generator adds SeaTable nobody asked for', (s) => { wf(s).nodes.sea = { id: 'sea', type: 'SEA_TABLE', configuration: {} }; }],
  ],
  'GEN-UNDECLARED-OUTBOUND': [
    ["the platform's own EMAIL_SEND slips in", (s) => { wf(s).nodes.mail = { id: 'mail', type: 'EMAIL_SEND', configuration: {} }; }],
    ['a Slack post slips in', (s) => { wf(s).nodes.slack = { id: 'slack', type: 'SLACK', configuration: {} }; }],
    ['a NOTIFICATION node slips in', (s) => { wf(s).nodes.notify = { id: 'notify', type: 'NOTIFICATION', configuration: {} }; }],
  ],
  'GEN-UNPARSEABLE-CONDITION': [
    ['a regex alternation in a branch condition', (s) => { wf(s).nodes.gate.configuration.condition = '{{shape.result.kind}} /urgent|escalate|complaint/'; }],
    ['a matches operator the evaluator does not have', (s) => { wf(s).nodes.gate.configuration.conditions = [{ operator: 'matches', value: 'x' }]; }],
  ],
  'GEN-SANDBOX-CRYPTO': [
    ["require('crypto') in a sandboxed code node", (s) => { wf(s).nodes.shape.configuration.code += "\nconst crypto = require('crypto');"; }],
    ['createHash in a sandboxed code node', (s) => { wf(s).nodes.shape.configuration.code += '\nconst h = createHash("sha256");'; }],
    ['require a node builtin', (s) => { wf(s).nodes.shape.configuration.code += "\nconst fs = require('fs');"; }],
  ],
  'WF-GRAPH-SOUND': [
    ['leave a dangling edge', (s) => { wf(s).edges.push({ sourceNodeId: 'shape', sourcePortId: 'out', targetNodeId: 'ghost', targetPortId: 'in' }); }],
    ['leave a node unwired', (s) => { wf(s).nodes.orphan = { id: 'orphan', type: 'NOOP', configuration: {} }; }],
    ['remove every entry point', (s) => { wf(s).edges.push({ sourceNodeId: 'review', sourcePortId: 'out', targetNodeId: 'trigger', targetPortId: 'in' }); }],
  ],
  /* found by running this preflight against solution number two */
  'REF-UNRESOLVABLE-HEAD': [
    ['the generator invents a free variable for an endpoint', (s) => { wf(s).nodes.fetch.configuration.url = '{{summary_report_endpoint}}'; }],
    ['a reference to a node that was renamed away', (s) => { wf(s).nodes.persist.configuration.rows = '{{normaliseNode.result.rowsJson}}'; }],
  ],
  'REF-UNDECLARED-OUTPUT-KEY': [
    ['read .rows off a DATA_TABLE that is inserting, not querying', (s) => { wf(s).nodes.gate.configuration.condition = '{{persist.rows}} not_empty'; }],
    ['read .length off a table write', (s) => { wf(s).nodes.gate.configuration.condition = '{{persist.length}} greater_than 0'; }],
  ],
  'WF-EDGE-PORT-UNDEFINED': [
    ['the generator serialises a missing port as the string "undefined"', (s) => { wf(s).edges[3].targetPortId = 'undefined'; }],
    ['a branch edge expresses its side as a label instead of a port', (s) => { const e = wf(s).edges[3]; delete e.sourcePortId; e.label = 'true'; }],
    ['a blank port on a linear edge', (s) => { wf(s).edges[0].sourcePortId = ''; }],
  ],
  'DT-BRANCHES-WRITE-SAME-SOURCE': [
    ['both sides of a branch persist the same expression to different tables', (s) => {
      const g = wf(s);
      g.nodes.persistX = { id: 'persistX', type: 'DATA_TABLE', configuration: { operation: 'insert', tableName: 'cf_records_bad', rows: '{{shape.result.rowsJson}}' } };
      g.edges.push({ sourceNodeId: 'gate', sourcePortId: 'false', targetNodeId: 'persistX', targetPortId: 'in' });
    }],
  ],
  'RUN-HEADER-VS-TRACES': [
    ['header says SUCCEEDED over a failed node', (s) => { s.executions.flow[0].traces[2].status = 'FAILED'; }],
    ['header says FAILED over eleven completed nodes', (s) => { s.executions.flow[0].header.status = 'FAILED'; s.executions.flow[0].envelopeStatus = 'FAILED'; }],
    ['the two platform surfaces disagree with each other', (s) => { s.executions.flow[0].envelopeStatus = 'FAILED'; }],
    ['an execution with no traces at all', (s) => { s.executions.flow[0].traces = []; }],
  ],
  'RUN-WROTE-NOTHING': [
    ['a table insert that completed having written nothing', (s) => { s.executions.flow[0].pool.persist.inserted = 0; s.executions.flow[0].pool.persist.rowCount = 0; }],
    ['an upsert that wrote nothing', (s) => { s.executions.flow[0].pool.persist = { operation: 'upsert', tableName: 'cf_records', written: 0, rowCount: 0, success: true }; }],
  ],
  'RUN-VARIABLE-POOL-TRIMMED': [
    ['a node output over the size-guard limit', (s) => { s.executions.flow[0].traces[1].outputSizeBytes = 762271; }],
    ['a truncation marker on the run', (s) => { s.executions.flow[0].traces[1].note = '_truncationApplied'; }],
  ],
  'API-WORKFLOW-PUT': [
    ['build code reaching for the dead PUT', (s) => { s.sourceFiles[0].text = "await put(`/v2/workflows/${id}`, merged);\n"; }],
    ['the same call spelled as a method string', (s) => { s.sourceFiles[0].text = "await api('PUT', `/v2/workflows/${id}`, merged);\n"; }],
  ],
  'AGENT-KNOWLEDGE-EFFECTIVE': [
    ['park the id in knowledgeSources, which nothing reads', (s) => { const a = comp(s, 'screener').record; a.knowledgeSources = a.knowledgeModuleIds[0]; a.knowledgeModuleIds = []; }],
    ['put a DATASET id where a MODULE id belongs', (s) => { comp(s, 'screener').record.knowledgeModuleIds = ['dataset-0000']; }],
    ['reference a module that does not exist', (s) => { comp(s, 'screener').record.knowledgeModuleIds = ['module-ghost']; }],
    ['the module carries no dataset', (s) => { s.knowledgeModules[0].datasetId = null; }],
    ['drop the tier below AGENTIC, silently closing the tool gate', (s) => { comp(s, 'screener').record.capabilityTier = 'CONVERSATIONAL'; }],
  ],
  'AGENT-GROUNDED-ON-EMPTY-KNOWLEDGE': [
    ['ground an AGENTIC agent on a dataset that indexed to nothing', (s) => { s.datasetDocs['dataset-0000'][0].totalSegments = 0; }],
    ['ground an AGENTIC agent on a dataset holding no documents', (s) => { s.datasetDocs['dataset-0000'] = []; }],
  ],
  'WIDGET-BRAIN-EFFECTIVE': [
    ['bind the widget with request-only vocabulary that never lands', (s) => { comp(s, 'front').record.config = { attach: { kind: 'CHATFLOW', id: 'chatflow-0000' } }; }],
    ['use the DASHBOARD brain kind the dispatcher rejects', (s) => { comp(s, 'front').record.config.brain.kind = 'DASHBOARD'; }],
    ['promise a customDomain that resolves to nothing', (s) => { comp(s, 'front').record.config.customDomain = 'quote.example.co.uk'; }],
  ],
  'CHATFLOW-DOWNSTREAM-EFFECTIVE': [
    ['leave the chatflow handing off to nobody', (s) => { const r = comp(s, 'intake').record; r.agentId = null; r.agentConfig = null; }],
    ['write the handoff into boundAgentId, a field that does not exist', (s) => { const r = comp(s, 'intake').record; r.agentId = null; r.agentConfig = null; r.boundAgentId = 'agent-0000'; }],
  ],
  'KNOWLEDGE-RETRIEVABLE': [
    ['a document reporting COMPLETED over zero segments', (s) => { s.datasetDocs['dataset-0000'][0].totalSegments = 0; }],
    ['a dataset with no documents at all', (s) => { s.datasetDocs['dataset-0000'] = []; }],
  ],
  'WF-PUBLISHED': [
    ['the workflow was published but never deployed, so it is still a draft', (s) => { wf(s).published = false; wf(s).status = 'DRAFT'; }],
    ['the workflow is published but disabled', (s) => { wf(s).enabled = false; }],
  ],
  'WIRE-RESOLVES': [
    ['break the grounding wire', (s) => { comp(s, 'screener').record.knowledgeModuleIds = []; }],
    ['break the widget wire', (s) => { comp(s, 'front').record.config = {}; }],
    ['drop the AGENT node so the workflow reaches its agent through prose', (s) => { delete wf(s).nodes.callAgent; }],
    ['drop the KNOWLEDGE_RETRIEVAL node', (s) => { delete wf(s).nodes.ground; }],
    ['spell chatFlowId with a lowercase f', (s) => {
      s.manifest.wires.push({ from: 'flow', to: 'intake', relation: 'calls-chatflow' });
      wf(s).nodes.turn = { id: 'turn', type: 'CHATFLOW_TURN', configuration: { chatflowId: 'chatflow-0000' } };
    }],
  ],
  'COVERAGE': [
    ['ship a form covering half the field set', (s) => { comp(s, 'intake').record.fields = [{ id: 'ref', required: true }]; }],
    ['ship an agent whose prompt never names the fields it validates', (s) => { const a = comp(s, 'screener').record; a.instructions = 'Be helpful.'; }],
    ['ship a form whose fields are well-formed but wrong', (s) => { comp(s, 'intake').record.fields = [{ id: 'name' }, { id: 'email' }]; }],
  ],
};

function findingsFor(rule, snap) {
  const produced = rule.run(snap);
  if (produced && !Array.isArray(produced) && produced.$skip) return { skipped: produced.$skip, findings: [] };
  return { skipped: null, findings: produced ?? [] };
}

const base = cleanSnapshot();
let brokenRules = 0;
let totalMutations = 0;
let caught = 0;
const problems = [];

console.log('');
console.log(bold('MUTATION CONTROL — every rule must fire on a broken solution and stay silent on a clean one'));
console.log('');

for (const rule of RULES) {
  // 1. positive control: silence on a correct solution
  const cleanRun = findingsFor(rule, clone(base));
  const cleanOk = cleanRun.findings.length === 0;
  if (!cleanOk) {
    problems.push(`${rule.id}: fires on the CLEAN fixture (${cleanRun.findings.length} finding(s): ${cleanRun.findings.map((f) => f.where).join('; ')})`);
  }
  if (cleanRun.skipped) {
    problems.push(`${rule.id}: SKIPS on the clean fixture (${cleanRun.skipped}) — the fixture does not exercise this rule, so nothing here proves it works`);
  }

  const muts = MUTATIONS[rule.id] ?? [];
  if (muts.length === 0) {
    brokenRules++;
    problems.push(`${rule.id}: NO DECLARED MUTATION — unproven, treated as broken`);
    console.log(`  ${red('BROKEN')} ${rule.id} ${dim('no declared mutation')}`);
    continue;
  }

  const missed = [];
  for (const [label, mutate] of muts) {
    totalMutations++;
    const s = clone(base);
    mutate(s);
    const run = findingsFor(rule, s);
    if (run.findings.length > 0) caught++;
    else missed.push(label + (run.skipped ? ` [rule skipped: ${run.skipped}]` : ''));
  }

  if (missed.length) {
    brokenRules++;
    for (const m of missed) problems.push(`${rule.id}: SURVIVED mutation — ${m}`);
    console.log(`  ${red('BROKEN')} ${rule.id} ${dim(`${muts.length - missed.length}/${muts.length} mutations caught`)}`);
  } else {
    console.log(`  ${cleanOk && !cleanRun.skipped ? green('proven') : red('DIRTY ')} ${rule.id} ${dim(`${muts.length}/${muts.length} mutations caught${cleanOk ? '' : ', BUT fires on the clean fixture'}`)}`);
  }
}

console.log('');
if (problems.length) {
  console.log(bold(red('PROBLEMS')));
  for (const p of problems) console.log(`  ${red('!')} ${p}`);
  console.log('');
}
console.log(bold('SUMMARY'));
console.log(`  ${RULES.length} rules · ${caught}/${totalMutations} declared mutations detected · ${brokenRules} broken`);
console.log(`  ${problems.length === 0 ? green('RULES PROVEN') : red(`${problems.length} problem(s)`)}`);
console.log('');
process.exitCode = problems.length ? 1 : 0;
