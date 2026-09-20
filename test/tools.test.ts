/**
 * Tests for tool-level behaviour that must hold before any network call:
 * the deploy spend gates, unsupported-verb reporting, and the advertised
 * surface. A regression in any of these is either a safety problem or a
 * silently-wrong answer, so none of them should depend on a live backend.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, type ServerConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { selectTools } from '../src/server.js';
import { shipTools } from '../src/tools/ship.js';
import { getAdapter, requireVerb, IMPLEMENTED_KINDS, BUILDABLE_KINDS } from '../src/kinds/index.js';

const tool = (name: string) => {
  const t = shipTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
};

const ctx = (overrides: Partial<ServerConfig> = {}) => {
  const config = { ...loadConfig({ SWFTE_PAT: 'pat_test' } as never), ...overrides };
  return { client: new SwfteClient(config), config };
};

describe('swfte_deploy spend gates', () => {
  test('defaults to preview and provisions nothing', async () => {
    // No `action` supplied is the case that matters: a model that omits the
    // parameter must not end up provisioning.
    const result: any = await tool('swfte_deploy').execute(
      { kind: 'agent', id: 'a1' },
      ctx()
    );
    assert.equal(result.dryRun, true);
  });

  test('refuses to deploy without confirm, even when deploys are enabled', async () => {
    const result: any = await tool('swfte_deploy').execute(
      { kind: 'workflow', id: 'w1', action: 'deploy' },
      ctx({ allowDeploy: true })
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.refused, true);
    assert.equal(result.reason, 'CONFIRMATION_REQUIRED');
  });

  test('refuses to deploy with confirm when the server has deploys disabled', async () => {
    // The two gates are independent on purpose: a model can supply confirm:true
    // on its own, so the environment must also opt in.
    const result: any = await tool('swfte_deploy').execute(
      { kind: 'workflow', id: 'w1', action: 'deploy', confirm: true },
      ctx({ allowDeploy: false })
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.refused, true);
    assert.equal(result.reason, 'DEPLOY_DISABLED');
    assert.match(result.message, /SWFTE_ALLOW_DEPLOY=1/);
  });

  test('preview reports honestly for a kind with no deploy pre-flight', async () => {
    const result: any = await tool('swfte_deploy').execute(
      { kind: 'agent', id: 'a1', action: 'preview' },
      ctx()
    );
    assert.equal(result.dryRun, true);
    assert.match(result.note, /no deploy pre-flight/);
    assert.equal(result.canDeploy, false, 'agents are not deployable');
  });
});

describe('unsupported verbs', () => {
  test('reports the kind and verb rather than failing generically', () => {
    // The application blueprint wizard genuinely has no steer.
    assert.throws(
      () => requireVerb('application', 'steer'),
      (err: Error) => {
        assert.match(err.message, /application does not support "steer"/);
        return true;
      }
    );
  });

  test('carries the adapter note explaining why', () => {
    assert.throws(
      () => requireVerb('widget', 'refine'),
      (err: Error) => {
        assert.match(err.message, /persists as part of generation/);
        return true;
      }
    );
  });

  test('an unimplemented kind lists what is implemented', () => {
    assert.throws(
      () => getAdapter('custom-node'),
      (err: Error) => {
        assert.match(err.message, /No adapter for kind "custom-node"/);
        assert.match(err.message, /workflow/);
        return true;
      }
    );
  });
});

describe('kind registry', () => {
  test('every implemented adapter can verify', () => {
    // verify is the one verb with no excuse for being absent — it is how a
    // caller finds out whether anything worked.
    for (const kind of IMPLEMENTED_KINDS) {
      assert.equal(typeof getAdapter(kind).verify, 'function', kind);
    }
  });

  test('buildable kinds all implement build, status and extractArtifact together', () => {
    // A build with no status to poll, or no artifact to extract, would hang or
    // return nothing — the three have to travel together.
    for (const kind of BUILDABLE_KINDS) {
      const a = getAdapter(kind);
      assert.equal(typeof a.build, 'function', `${kind}.build`);
      assert.equal(typeof a.status, 'function', `${kind}.status`);
      assert.equal(typeof a.extractArtifact, 'function', `${kind}.extractArtifact`);
    }
  });

  test('models are excluded from the buildable set', () => {
    // Weights are uploaded, not generated; advertising build would invite a
    // call that could never succeed.
    assert.equal(BUILDABLE_KINDS.includes('model'), false);
    assert.equal(IMPLEMENTED_KINDS.includes('model'), true);
  });

  test('anything that deploys can also tear down', () => {
    // Otherwise a tool can start billing with no way to stop it.
    for (const kind of IMPLEMENTED_KINDS) {
      const a = getAdapter(kind);
      if (typeof a.deploy === 'function') {
        assert.equal(typeof a.teardown, 'function', `${kind} deploys but cannot tear down`);
      }
    }
  });
});

describe('advertised surface', () => {
  test('no duplicate tool names', () => {
    const names = allTools.map((t) => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, []);
  });

  test('every tool has a description worth reading', () => {
    const thin = allTools.filter((t) => !t.description || t.description.length < 30);
    assert.deepEqual(thin.map((t) => t.name), []);
  });

  test('every tool name is namespaced', () => {
    const bad = allTools.filter((t) => !t.name.startsWith('swfte_'));
    assert.deepEqual(bad.map((t) => t.name), []);
  });

  test('the default surface stays small enough for reliable tool selection', () => {
    // The ceiling moved 80 → 85 when the five post-deploy observability tools
    // landed. They are workflow tools and the workflows group is advertised by
    // default, so there is no shipping them and keeping them out of the count.
    // Worth the slots: without them a deployed workflow can be reported as
    // shipped but never as working. Raise this again only for something that
    // earns it the same way — the number exists to make the trade visible.
    //
    // 85 -> 90 for the four solution-orchestration tools. They earn it the same
    // way: without them a multi-artifact build can be reported as delivered
    // while none of its components reference each other. swfte_solution_build
    // orders and wires a whole solution; swfte_solution_wire writes one
    // reference into the field the runtime reads; swfte_knowledge_build proves
    // a dataset retrieves rather than trusting its COMPLETED status;
    // swfte_agent_ground carries the dataset -> module -> knowledgeModuleIds
    // hop that is silent at every step when it is skipped. All four are `core`,
    // so they cannot be group-filtered out of the count either.
    //
    // 90 -> 93 for preflight. swfte_preflight runs the 28-rule sweep over the
    // platform's known silent-failure modes — the ways an artifact reports
    // COMPLETED while resolving every template to the empty string, which no
    // structural check sees. swfte_preflight_manifest derives its input, so a
    // solution stops hand-maintaining a parallel description of itself.
    // swfte_publish is the gate: publish is the promotion boundary, and the
    // last place a defect is still cheap. All three are `core` for the same
    // reason the solution tools are — a gate anyone can group-filter away is
    // not a gate.
    const selected = selectTools(allTools, loadConfig({ SWFTE_PAT: 'pat_x' } as never));
    // Chatflow turn input plus read-only status and explicit administrative abandonment complete durable recovery.
    // 96: swfte_composition_classify joined the always-on set. It answers a
    // question swfte_solution_advise cannot — the two axes are independent, and
    // advise's five booleans cannot carry audience, budget, side effects or
    // deployment needs. The ceiling moves by exactly one, deliberately; it is
    // still a ceiling.
    //
    // 96 -> 103 on the merge that brought Relay in beside agent-mail. The
    // product groups did what they were supposed to: `journeys` and `relay` are
    // held out of DEFAULT_GROUPS, and `agent-mail` is opt-in because one of its
    // tools emails real people. The growth is elsewhere — Relay put eight tools
    // in `workflows` and two in `agents`, and both of those ARE default groups,
    // so they are advertised whether or not anyone weighed them against this
    // ceiling.
    //
    // Two previous entries said the next addition should trim a group rather
    // than raise this number, and named `experiments`, `audit` and `cost`. That
    // advice is now stale: all three were already outside DEFAULT_GROUPS, so
    // trimming them saves nothing. Measured breakdown at 103 —
    //   core 19, workflows 19, analytics 13, agents 12, chatflows 12,
    //   deployments 8, datasets 6, modules 6, connect 5, untagged 3
    // — which makes `analytics` (13 tools, none of them needed to build or ship
    // anything) the only real lever left. Dropping it returns this to 90.
    //
    // That is a product decision about what every client sees by default, so it
    // is written down here rather than taken quietly as part of a merge.
    assert.ok(selected.length <= 103, `default surface is ${selected.length} tools`);
    assert.ok(selected.length > 40, `default surface is only ${selected.length} tools`);
  });

  test('core tools survive every group filter', () => {
    for (const groups of ['voice', 'audit', 'rag,files']) {
      const selected = selectTools(allTools, loadConfig({ SWFTE_PAT: 'pat_x', SWFTE_TOOLS: groups } as never));
      assert.ok(
        selected.some((t) => t.name === 'swfte_build'),
        `swfte_build missing with SWFTE_TOOLS=${groups}`
      );
    }
  });

  test('destructive tools are flagged so clients can prompt', () => {
    const del = allTools.find((t) => t.name === 'swfte_agents_delete');
    assert.equal(del?.destructive, true);
  });
});
