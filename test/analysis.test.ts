/**
 * Unit tests for the offline analysis that backs `swfte_verify`.
 *
 * These are the checks the backend will NOT do for you — it happily persists a
 * workflow whose nodes are never wired together — so they need to be right.
 *
 *   npx tsx --test test/*.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { analyseGraph } from '../src/kinds/workflow.js';
import { pickId, pickList, toFindings, isSucceededRunStatus, isTerminalRunStatus } from '../src/kinds/_adapter.js';
import { detectCredentialKind, loadConfig, DEFAULT_GROUPS } from '../src/config.js';

describe('analyseGraph', () => {
  test('accepts a well-formed linear graph', () => {
    const g = analyseGraph({
      nodes: [{ id: 'trigger_1', type: 'trigger' }, { id: 'ai_1', type: 'llm' }, { id: 'out_1', type: 'output' }],
      connections: [
        { source: 'trigger_1', target: 'ai_1' },
        { source: 'ai_1', target: 'out_1' },
      ],
    });
    assert.equal(g.ok, true);
    assert.equal(g.nodeCount, 3);
    assert.equal(g.edgeCount, 2);
    assert.deepEqual(g.orphans, []);
  });

  test('flags a node that no edge touches', () => {
    const g = analyseGraph({
      nodes: [{ id: 'trigger_1', type: 'trigger' }, { id: 'ai_1', type: 'llm' }, { id: 'slack_1', type: 'slack' }],
      connections: [{ source: 'trigger_1', target: 'ai_1' }],
    });
    assert.equal(g.ok, false);
    assert.deepEqual(g.orphans, ['slack_1']);
    assert.match(g.summary, /1 unwired: slack_1/);
  });

  test('does not flag an entry node for having no inbound edge', () => {
    // A trigger legitimately has no inbound edge; flagging it would make every
    // valid workflow look broken.
    const g = analyseGraph({
      nodes: [{ id: 'webhook_1', type: 'webhook_trigger' }, { id: 'ai_1', type: 'llm' }],
      connections: [{ source: 'webhook_1', target: 'ai_1' }],
    });
    assert.equal(g.ok, true);
    assert.deepEqual(g.orphans, []);
  });

  test('flags an edge pointing at a node that does not exist', () => {
    const g = analyseGraph({
      nodes: [{ id: 'a', type: 'trigger' }, { id: 'b', type: 'llm' }],
      connections: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'ghost_node' },
      ],
    });
    assert.equal(g.ok, false);
    assert.deepEqual(g.danglingEdges, ['b → ghost_node']);
  });

  test('reads the `edges` spelling as well as `connections`', () => {
    // The wizard emits `connections`; the canvas and draft store emit `edges`.
    // Missing one spelling would silently report every edge as absent and every
    // node as unwired.
    const viaEdges = analyseGraph({
      nodes: [{ id: 'a', type: 'trigger' }, { id: 'b', type: 'llm' }],
      edges: [{ source: 'a', target: 'b' }],
    });
    assert.equal(viaEdges.ok, true);
    assert.equal(viaEdges.edgeCount, 1);
  });

  test('reads sourceNodeId/targetNodeId edge spellings', () => {
    const g = analyseGraph({
      nodes: [{ id: 'a', type: 'trigger' }, { id: 'b', type: 'llm' }],
      edges: [{ sourceNodeId: 'a', targetNodeId: 'b' }],
    });
    assert.equal(g.ok, true);
    assert.deepEqual(g.orphans, []);
  });

  test('treats a single-node graph as connected', () => {
    const g = analyseGraph({ nodes: [{ id: 'only', type: 'llm' }], connections: [] });
    assert.deepEqual(g.orphans, []);
    assert.equal(g.ok, true);
  });

  test('an empty graph is not ok', () => {
    const g = analyseGraph({ nodes: [], connections: [] });
    assert.equal(g.ok, false);
  });

  test('handles nodes supplied as a keyed object rather than an array', () => {
    const g = analyseGraph({
      nodes: { trigger_1: { id: 'trigger_1', type: 'trigger' }, ai_1: { id: 'ai_1', type: 'llm' } },
      connections: [{ source: 'trigger_1', target: 'ai_1' }],
    });
    assert.equal(g.nodeCount, 2);
    assert.equal(g.ok, true);
  });
});

describe('run status normalisation', () => {
  test('treats all three success spellings as success', () => {
    // The backend is not consistent about which it emits; missing one would
    // report a successful run as a failure.
    for (const s of ['COMPLETED', 'SUCCESS', 'SUCCEEDED', 'succeeded']) {
      assert.equal(isSucceededRunStatus(s), true, s);
    }
  });

  test('failure states are terminal but not success', () => {
    for (const s of ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMEOUT']) {
      assert.equal(isTerminalRunStatus(s), true, s);
      assert.equal(isSucceededRunStatus(s), false, s);
    }
  });

  test('in-flight states are not terminal, so polling continues', () => {
    for (const s of ['RUNNING', 'PENDING', 'QUEUED', undefined]) {
      assert.equal(isTerminalRunStatus(s), false, String(s));
    }
  });
});

describe('response shape helpers', () => {
  test('pickId finds the id under every spelling in use', () => {
    assert.equal(pickId({ id: 'x' }), 'x');
    assert.equal(pickId({ workflowId: 'w' }), 'w');
    assert.equal(pickId({ agentId: 'a' }), 'a');
    assert.equal(pickId({ chatflowId: 'c' }), 'c');
    assert.equal(pickId({ data: { id: 'd' } }), 'd');
    assert.equal(pickId({ nothing: true }), undefined);
  });

  test('pickList unwraps every list envelope in use', () => {
    assert.deepEqual(pickList([1, 2]), [1, 2]);
    assert.deepEqual(pickList({ content: [1] }), [1]);
    assert.deepEqual(pickList({ items: [2] }), [2]);
    assert.deepEqual(pickList({ agents: [3] }), [3]);
    assert.deepEqual(pickList({ workflows: [4] }), [4]);
    assert.deepEqual(pickList({}), []);
  });

  test('toFindings normalises strings and objects alike', () => {
    const f = toFindings(['plain string', { message: 'structured', severity: 'warning', nodeId: 'n1' }]);
    assert.equal(f.length, 2);
    assert.equal(f[0]!.severity, 'error');
    assert.equal(f[0]!.message, 'plain string');
    assert.equal(f[1]!.severity, 'warning');
    assert.equal(f[1]!.path, 'n1');
  });

  test('toFindings tolerates an absent error list', () => {
    assert.deepEqual(toFindings(undefined), []);
    assert.deepEqual(toFindings(null), []);
  });

  test('an unrecognised severity falls back to error rather than being dropped', () => {
    const f = toFindings([{ message: 'x', severity: 'catastrophic' }]);
    assert.equal(f[0]!.severity, 'error');
  });
});

describe('credential handling', () => {
  test('detects each credential family', () => {
    assert.equal(detectCredentialKind('pat_abc'), 'pat');
    assert.equal(detectCredentialKind('sk-swfte-abc'), 'api-key');
    assert.equal(detectCredentialKind('sk_abc'), 'api-key');
    assert.equal(detectCredentialKind('Bearer eyJ...'), null);
  });

  test('SWFTE_TOOLS=all clears the filter', () => {
    const cfg = loadConfig({ SWFTE_PAT: 'pat_x', SWFTE_TOOLS: 'all' } as never);
    assert.equal(cfg.enabledGroups.size, 0, 'empty set means advertise everything');
  });

  test('an explicit group list always includes core', () => {
    // Without core there is no swfte_build, which would make the server useless
    // in a way that is hard to diagnose from the client side.
    const cfg = loadConfig({ SWFTE_PAT: 'pat_x', SWFTE_TOOLS: 'voice' } as never);
    assert.equal(cfg.enabledGroups.has('core'), true);
    assert.equal(cfg.enabledGroups.has('voice'), true);
  });

  test('the default group set is applied when SWFTE_TOOLS is unset', () => {
    const cfg = loadConfig({ SWFTE_PAT: 'pat_x' } as never);
    assert.deepEqual([...cfg.enabledGroups].sort(), [...DEFAULT_GROUPS].sort());
  });

  test('deploy is disabled unless explicitly enabled', () => {
    assert.equal(loadConfig({ SWFTE_PAT: 'pat_x' } as never).allowDeploy, false);
    assert.equal(loadConfig({ SWFTE_PAT: 'pat_x', SWFTE_ALLOW_DEPLOY: '1' } as never).allowDeploy, true);
    assert.equal(loadConfig({ SWFTE_PAT: 'pat_x', SWFTE_ALLOW_DEPLOY: 'true' } as never).allowDeploy, true);
    assert.equal(loadConfig({ SWFTE_PAT: 'pat_x', SWFTE_ALLOW_DEPLOY: '0' } as never).allowDeploy, false);
  });

  test('a trailing slash on the base URL does not produce a double slash', () => {
    const cfg = loadConfig({ SWFTE_PAT: 'pat_x', SWFTE_BASE_URL: 'http://localhost:8080/' } as never);
    assert.equal(cfg.baseUrl, 'http://localhost:8080');
  });
});
