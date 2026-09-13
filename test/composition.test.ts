import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASE_COMPOSITIONS,
  DELIVERY_SURFACES,
  EXECUTION_APPROACHES,
  classifyComposition,
  compositionForCase,
} from '../src/guidance/composition.js';
import catalog from '../src/guidance/case-studies.json';

test('every catalogue case is placed on both axes', () => {
  assert.equal(CASE_COMPOSITIONS.length, catalog.cases.length);
  for (const c of CASE_COMPOSITIONS) {
    assert.ok(EXECUTION_APPROACHES.includes(c.executionApproach), `${c.caseStudyId} execution`);
    assert.ok(DELIVERY_SURFACES.includes(c.deliverySurface), `${c.caseStudyId} surface`);
    assert.ok(c.why.length > 40, `${c.caseStudyId} needs a real explanation`);
  }
  for (const c of catalog.cases) assert.ok(compositionForCase(c.id), `${c.id} missing`);
  assert.equal(compositionForCase('S99'), undefined);
});

test('the two axes are independent — neither determines the other', () => {
  // If they were one axis in disguise, every value of one would map to exactly
  // one value of the other. This is the assertion the old single-word `form`
  // could not pass, which is why "agentic" kept reading as "product".
  const byExecution = new Map<string, Set<string>>();
  const bySurface = new Map<string, Set<string>>();
  for (const c of CASE_COMPOSITIONS) {
    (byExecution.get(c.executionApproach) ?? byExecution.set(c.executionApproach, new Set()).get(c.executionApproach)!).add(c.deliverySurface);
    (bySurface.get(c.deliverySurface) ?? bySurface.set(c.deliverySurface, new Set()).get(c.deliverySurface)!).add(c.executionApproach);
  }
  assert.ok([...byExecution.values()].some(s => s.size > 1), 'at least one execution approach ships on more than one surface');
  assert.ok([...bySurface.values()].some(s => s.size > 1), 'at least one surface carries more than one execution approach');
});

test('a fixed specialist agent inside known stages is still a bounded workflow', () => {
  // S14 runs five agents and is still bounded: each is invoked at a fixed point
  // in a known sequence. Treating "has agents" as "is agentic" is the mistake.
  const s14 = compositionForCase('S14')!;
  assert.equal(s14.executionApproach, 'bounded-workflow');
  assert.ok(s14.componentKinds.includes('agent'));

  // S07 declares form `workflow` yet names an AGENTIC analyst, so it is hybrid.
  assert.equal(compositionForCase('S07')!.executionApproach, 'hybrid');
});

test('"agentic" is not a synonym for "product"', () => {
  const agentic = CASE_COMPOSITIONS.filter(c => c.executionApproach !== 'bounded-workflow');
  assert.ok(agentic.length >= 8);
  assert.ok(
    agentic.some(c => c.deliverySurface === 'internal-automation'),
    'an agentic investigation must be able to ship as pure automation'
  );
  assert.ok(
    CASE_COMPOSITIONS.some(c => c.executionApproach === 'bounded-workflow' && c.deliverySurface === 'solution'),
    'a bounded workflow must be able to ship as a coordinated solution'
  );
});

test('silence produces UNDETERMINED, never a default recommendation', () => {
  const r = classifyComposition({});
  assert.equal(r.executionApproach.value, null);
  assert.equal(r.executionApproach.confidence, 'UNDETERMINED');
  assert.equal(r.deliverySurface.value, null);
  assert.equal(r.deliverySurface.confidence, 'UNDETERMINED');
  assert.ok(r.missingSignals.includes('expectedAudience'));
  assert.ok(r.missingSignals.includes('uncertainSteps'));
  assert.match(r.explanation, /Not enough was said/);
});

test('it stops on the lowest rung the signals justify and names the next one', () => {
  const automation = classifyComposition({
    expectedAudience: 'single-operator',
    deterministicSteps: ['fetch', 'score', 'open PR'],
    uncertainSteps: [],
    sharedDurableRecords: false,
    sharedReviewInterface: false,
    conversationalIntake: false,
  });
  assert.equal(automation.executionApproach.value, 'bounded-workflow');
  assert.equal(automation.deliverySurface.value, 'internal-automation');
  assert.equal(automation.deliverySurface.entryPointKind, null);
  assert.match(String(automation.deliverySurface.escalateWhen), /asking a question/);

  const widget = classifyComposition({
    expectedAudience: 'team',
    deterministicSteps: ['ingest', 'normalise'],
    uncertainSteps: ['decide which lineage hop explains the anomaly'],
    sharedDurableRecords: true,
    sharedReviewInterface: true,
    conversationalIntake: false,
    independentlyUsefulArtifacts: 1,
  });
  assert.equal(widget.executionApproach.value, 'hybrid');
  assert.equal(widget.deliverySurface.value, 'widget');
  assert.equal(widget.deliverySurface.entryPointKind, 'widget');
  assert.match(String(widget.deliverySurface.escalateWhen), /insufficient/);
});

test('a dedicated interface is only reached when a table/dashboard/form is declared insufficient', () => {
  const base = {
    expectedAudience: 'team' as const,
    deterministicSteps: ['ingest'],
    uncertainSteps: [],
    sharedDurableRecords: true,
    sharedReviewInterface: true,
    conversationalIntake: false,
    independentlyUsefulArtifacts: 1,
  };
  assert.equal(classifyComposition(base).deliverySurface.value, 'widget');
  assert.equal(
    classifyComposition({ ...base, dedicatedInterfaceRequired: true }).deliverySurface.value,
    'application'
  );
});

test('an existing system of record caps the ladder instead of adding a second interface', () => {
  const r = classifyComposition({
    expectedAudience: 'team',
    deterministicSteps: ['triage'],
    uncertainSteps: [],
    sharedDurableRecords: true,
    sharedReviewInterface: true,
    conversationalIntake: true,
    existingSystemOfRecord: true,
    independentlyUsefulArtifacts: 3,
  });
  assert.equal(r.deliverySurface.value, 'conversational');
  assert.notEqual(r.deliverySurface.value, 'solution');
  assert.ok(r.deliverySurface.why.some(w => /already owns these records/.test(w)));
});

test('solution is a packaging rung above the entry point, not a replacement for it', () => {
  const r = classifyComposition({
    expectedAudience: 'team',
    deterministicSteps: ['intake', 'distribute'],
    uncertainSteps: [],
    sharedDurableRecords: true,
    sharedReviewInterface: true,
    conversationalIntake: false,
    existingSystemOfRecord: false,
    independentlyUsefulArtifacts: 4,
  });
  assert.equal(r.deliverySurface.value, 'solution');
  assert.equal(r.deliverySurface.entryPointKind, 'widget', 'the bundle still has one place a human opens');
});

test('the recommendation carries the disclosure fields the wizard must render', () => {
  const r = classifyComposition({
    expectedAudience: 'team',
    recurringInteraction: true,
    deterministicSteps: ['collect evidence'],
    uncertainSteps: [],
    sources: ['GitHub', 'CloudWatch'],
    permissions: ['repo:read'],
    humanDecisions: ['approve the PR'],
    outputTypes: ['pull request'],
    budgetBoundary: '$2 per run',
    timeBoundary: '15 minutes',
    sideEffects: ['opens a pull request'],
    deploymentNeeds: ['scheduled trigger only'],
    sharedReviewInterface: false,
    conversationalIntake: false,
    sharedDurableRecords: false,
  });
  for (const key of ['sources', 'permissions', 'humanDecisions', 'outputTypes', 'sideEffects', 'deploymentNeeds'] as const) {
    assert.ok(r.facts[key].length > 0, `${key} must survive into the recommendation`);
  }
  assert.equal(r.facts.budgetBoundary, '$2 per run');
  assert.equal(r.facts.timeBoundary, '15 minutes');
  assert.equal(r.revisable, true);
  assert.equal(r.evidenceLevel, 'LOCAL_CLASSIFICATION_ONLY');
});

test('the recommendation states plainly that nothing persists it', () => {
  const r = classifyComposition({ deterministicSteps: ['a'], uncertainSteps: [], expectedAudience: 'team' });
  assert.equal(r.persistence.persistedWithArtifact, false);
  assert.match(String(r.persistence.blocker), /wizard endpoint/);
  assert.match(String(r.persistence.blocker), /browser state/);
});

test('an agentic investigation is told to configure real limits, not a prompt', () => {
  const r = classifyComposition({
    expectedAudience: 'single-operator',
    deterministicSteps: [],
    uncertainSteps: ['choose the next probe from what the last one returned'],
    sharedReviewInterface: false,
    conversationalIntake: false,
    sharedDurableRecords: false,
  });
  assert.equal(r.executionApproach.value, 'agentic-investigation');
  assert.ok(r.executionApproach.why.some(w => /budget ceiling/.test(w) && /A prompt does not implement/.test(w)));
  assert.ok(r.composition.omitted.some(o => o.kind === 'workflow'));
});
