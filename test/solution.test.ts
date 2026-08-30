/**
 * Unit tests for the offline half of `swfte_solution_verify`.
 *
 * The wire resolver needs live state, but the three pieces that decide whether
 * it draws the right conclusion are pure: the path selector, the coverage
 * matcher, and the placeholder scanner. Each of them has a way of being subtly
 * wrong that produces a confident, false report — a coverage matcher that does
 * not normalise field ids says 0/19 when the answer is 4/19, and a report that
 * cries wolf is one nobody reads.
 *
 *   npx tsx --test test/*.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { selectPath, measureCoverage, findPlaceholders, type SolutionComponent } from '../src/solution.js';

const component: SolutionComponent = { key: 'intake-assist', kind: 'chatflow', id: 'cf-1' };

describe('selectPath', () => {
  test('fans out an array and plucks a field', () => {
    const got = selectPath({ fields: [{ id: 'a' }, { id: 'b' }] }, 'fields[].id');
    assert.deepEqual(got.map((n) => n.value), ['a', 'b']);
    assert.deepEqual(got.map((n) => n.path), ['$.fields[0].id', '$.fields[1].id']);
  });

  test('fans out an object map, which is how workflows hold their nodes', () => {
    const got = selectPath({ nodes: { n1: { configuration: { url: 'u1' } }, n2: { configuration: { url: 'u2' } } } }, 'nodes.*.configuration.url');
    assert.deepEqual(got.map((n) => n.value).sort(), ['u1', 'u2']);
  });

  test('missing segments yield nothing rather than throwing', () => {
    assert.deepEqual(selectPath({ a: 1 }, 'b.c.d'), []);
  });

  test('$effectivePrompt applies the runtime rule, not the stored text', () => {
    // The gateway ignores systemPrompt unless persona AND instructions are both
    // blank. An agent carrying its checklist in systemPrompt while persona is
    // set behaves as though the checklist were never written.
    const shadowed = selectPath({ systemPrompt: 'check venueName', persona: 'a careful underwriter', instructions: '' }, '$effectivePrompt');
    assert.equal(shadowed[0]!.value, 'a careful underwriter');

    const applied = selectPath({ systemPrompt: 'check venueName', persona: '', instructions: '' }, '$effectivePrompt');
    assert.equal(applied[0]!.value, 'check venueName');
  });
});

describe('measureCoverage', () => {
  const mandatory = ['venueName', 'address', 'sumInsuredContents', 'stockValue'];

  test('normalised matching treats snake_case and camelCase as the same field', () => {
    // This is not a nicety. Chatflow field ids come back snake_case and the
    // scheme config declares them camelCase; a literal comparison would report
    // total failure on a form that is partly right, and the reader would stop
    // believing the number.
    const r = measureCoverage(component, 'cf-1', { fields: [{ id: 'sum_insured_contents' }, { id: 'stock_value' }] }, {
      id: 'mandatory',
      of: mandatory,
      in: 'fields[].id',
    });
    assert.equal(r.covered, 2);
    assert.equal(r.required, 4);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['venueName', 'address']);
  });

  test('exact matching does not', () => {
    const r = measureCoverage(component, 'cf-1', { fields: [{ id: 'sum_insured_contents' }] }, {
      id: 'mandatory',
      of: mandatory,
      in: 'fields[].id',
      match: 'exact',
    });
    assert.equal(r.covered, 0);
  });

  test('full coverage passes', () => {
    const r = measureCoverage(component, 'cf-1', { fields: mandatory.map((id) => ({ id })) }, {
      id: 'mandatory',
      of: mandatory,
      in: 'fields[].id',
    });
    assert.equal(r.ok, true);
    assert.equal(r.ratio, 1);
  });

  test('minRatio admits deliberate partial coverage', () => {
    const r = measureCoverage(component, 'cf-1', { fields: [{ id: 'venueName' }, { id: 'address' }] }, {
      id: 'mandatory',
      of: mandatory,
      in: 'fields[].id',
      minRatio: 0.5,
    });
    assert.equal(r.ok, true);
  });

  test('contains matching reads prose surfaces', () => {
    const r = measureCoverage(component, 'a-1', { systemPrompt: 'Validate venue name, full address and stock value.' }, {
      id: 'prompt',
      of: mandatory,
      in: '$text',
      match: 'contains',
    });
    assert.deepEqual(r.missing, ['sumInsuredContents']);
  });

  test('an empty required set is vacuously covered rather than a divide by zero', () => {
    const r = measureCoverage(component, 'cf-1', {}, { id: 'none', of: [], in: 'fields[].id' });
    assert.equal(r.ok, true);
    assert.equal(r.ratio, 1);
  });
});

describe('findPlaceholders', () => {
  test('finds generated stubs inside node configuration', () => {
    const wf = {
      nodes: {
        fetch: { configuration: { url: '{{TODO: Licence feed URL}}' } },
        post: { configuration: { url: 'https://api.example.com/route' } },
        fine: { configuration: { url: 'https://register.xbroker.co.uk/api' } },
      },
    };
    const hits = findPlaceholders(wf, 'nodes');
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.label).sort(), ['example.com placeholder host', 'unresolved {{TODO}} template']);
  });

  test('a fully configured workflow reports nothing', () => {
    const wf = { nodes: { a: { configuration: { url: 'https://real.example-broker.co.uk/feed', key: 'live' } } } };
    assert.deepEqual(findPlaceholders(wf, 'nodes'), []);
  });

  test('a template expression that binds a real upstream node is not a placeholder', () => {
    // `{{validation-check.snapshot}}` is how one node reads another's output.
    // Flagging it would bury the real stubs in noise.
    const wf = { nodes: { w: { configuration: { rows: '{{validation-check.snapshot}}' } } } };
    assert.deepEqual(findPlaceholders(wf, 'nodes'), []);
  });
});
