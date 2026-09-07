#!/usr/bin/env npx tsx
/**
 * Route probe — validates every endpoint path this server uses, without needing
 * a credential.
 *
 * Sends an invalid PAT. Authentication can reject BEFORE routing, so a 401/403
 * proves neither route existence nor method compatibility. Such responses are
 * inconclusive and make this check exit nonzero. A 404 can also describe an
 * absent entity, so it is reported as unresolved rather than proof of a bad route.
 * Use authenticated method-and-payload contract tests for release evidence.
 *
 *   npx tsx scripts/probe-paths.ts
 *   npx tsx scripts/probe-paths.ts --base http://localhost:8080
 */
const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const BASE = (arg('base') ?? process.env.SWFTE_BASE_URL ?? 'https://api.swfte.com/agents').replace(/\/+$/, '');

/** A syntactically valid PAT that cannot exist — 32 bytes of zeros, base64url. */
const BOGUS_PAT = `pat_${Buffer.alloc(32).toString('base64url')}`;

/** Placeholder ids. The route is what is being tested, not the entity. */
const ID = 'probe-nonexistent-id';
const SESSION = 'probe-nonexistent-session';

type Probe = { group: string; path: string; note?: string };

const PROBES: Probe[] = [
  // identity
  { group: 'whoami', path: '/v2/workspace/members/me' },
  { group: 'whoami', path: '/v1/personal-access-tokens' },
  { group: 'whoami', path: '/v1/billing/usage/summary' },

  // workflow kind
  { group: 'workflow', path: '/v2/workflows' },
  { group: 'workflow', path: `/v2/workflows/${ID}` },
  { group: 'workflow', path: '/v2/workflows/wizard/generate/async', note: 'POST in use' },
  { group: 'workflow', path: `/v2/workflows/wizard/${SESSION}/status` },
  { group: 'workflow', path: '/v2/workflows/wizard/review', note: 'POST in use' },
  { group: 'workflow', path: '/v2/workflows/wizard/refine', note: 'POST in use' },
  { group: 'workflow', path: '/v2/workflows/wizard/create', note: 'POST in use' },
  { group: 'workflow', path: '/v2/workflows/wizard/node-types' },
  { group: 'workflow', path: `/v2/workflows/${ID}/execute`, note: 'POST in use' },
  { group: 'workflow', path: `/v2/workflow-executions/${ID}` },
  { group: 'workflow', path: `/v2/workflows/${ID}/deploy/preview` },
  { group: 'workflow', path: `/v2/workflows/${ID}/deploy/plan` },
  { group: 'workflow', path: `/v2/workflows/${ID}/deploy` , note: 'POST in use' },
  { group: 'workflow', path: `/v2/workflows/execution/${ID}/versions` },

  // agent kind
  { group: 'agent', path: '/v1/agents' },
  { group: 'agent', path: `/v2/agents/${ID}` },
  { group: 'agent', path: `/v1/agents/${ID}` },
  { group: 'agent', path: '/v2/agents/wizard/generate/async', note: 'POST in use' },
  { group: 'agent', path: `/v2/agents/wizard/${SESSION}/status` },
  { group: 'agent', path: '/v2/agents/wizard/review', note: 'POST in use' },
  { group: 'agent', path: '/v2/agents/wizard/create', note: 'POST in use' },
  { group: 'agent', path: '/v2/agents/wizard/link-tools', note: 'POST in use' },
  { group: 'agent', path: '/v2/agents/wizard/link-knowledge', note: 'POST in use' },
  { group: 'agent', path: '/v2/agents/wizard/templates' },
  { group: 'agent', path: '/v2/agents/wizard/agent-types' },
  { group: 'agent', path: '/v2/agents/wizard/providers' },
  { group: 'agent', path: `/v1/agents/${ID}/chat/probe-user`, note: 'POST in use' },

  // chatflow kind
  { group: 'chatflow', path: '/v2/chatflows' },
  { group: 'chatflow', path: `/v2/chatflows/${ID}` },
  { group: 'chatflow', path: '/api/v2/chatflow/generate/async', note: 'POST in use' },
  { group: 'chatflow', path: `/api/v2/chatflow/generate/${SESSION}/status` },
  { group: 'chatflow', path: '/api/v2/chatflow/generate/preview', note: 'POST in use' },
  { group: 'chatflow', path: '/api/v2/chatflow/generate/refine', note: 'POST in use' },

  // widget kind
  { group: 'widget', path: '/api/v2/widgets' },
  { group: 'widget', path: `/api/v2/widgets/${ID}` },
  { group: 'widget', path: '/v2/widgets/wizard/generate/async', note: 'POST in use' },
  { group: 'widget', path: `/v2/widgets/wizard/${SESSION}/status` },
  { group: 'widget', path: `/v1/widgets/${ID}/embed` },
  { group: 'widget', path: `/api/v2/widgets/${ID}/deploy`, note: 'POST in use' },
  { group: 'widget', path: `/api/v2/widgets/${ID}/pause`, note: 'POST in use — teardown' },

  // application kind
  { group: 'application', path: '/v2/applications' },
  { group: 'application', path: `/v2/applications/${ID}` },
  { group: 'application', path: '/v2/applications/wizard/blueprint/async', note: 'POST in use' },
  { group: 'application', path: `/v2/applications/wizard/blueprint/status/${SESSION}` },
  { group: 'application', path: `/v2/applications/${ID}/hosting` },

  // mcp-server kind
  { group: 'mcp-server', path: '/v2/mcp/wizard/generate', note: 'POST in use' },
  { group: 'mcp-server', path: '/v2/mcp/wizard/validate', note: 'POST in use' },
  { group: 'mcp-server', path: '/v2/mcp/wizard/deploy', note: 'POST in use' },
  { group: 'mcp-server', path: '/v2/mcp/wizard/artifacts' },
  { group: 'mcp-server', path: `/v2/mcp/wizard/artifacts/${ID}` },
  { group: 'mcp-server', path: '/v2/mcp/deployments' },
  { group: 'mcp-server', path: `/v2/mcp/deployments/${ID}`, note: 'DELETE in use — teardown' },

  // module kind
  { group: 'module', path: '/v2/modules' },
  { group: 'module', path: `/v2/modules/${ID}` },
  { group: 'module', path: `/v2/modules/${ID}/build`, note: 'POST in use' },
  { group: 'module', path: `/v2/modules/${ID}/versions` },
  { group: 'module', path: '/v2/rag/search', note: 'POST in use' },

  // model kind
  { group: 'model', path: '/v2/model-vault/models' },
  { group: 'model', path: `/v2/model-vault/models/${ID}` },
  { group: 'model', path: `/v2/model-vault/models/${ID}/deploy/status` },

  // experiments
  { group: 'experiments', path: '/v2/chatflow-experiments' },
  { group: 'experiments', path: `/v2/chatflow-experiments/${ID}` },
  { group: 'experiments', path: `/v2/chatflow-experiments/${ID}/start`, note: 'POST in use' },
  { group: 'experiments', path: `/v2/chatflow-experiments/${ID}/assign`, note: 'POST in use' },
  { group: 'experiments', path: `/v2/chatflow-experiments/${ID}/outcomes`, note: 'POST in use' },
  { group: 'experiments', path: `/v2/chatflow-experiments/${ID}/summary` },
  { group: 'experiments', path: `/v2/chatflow-experiments/${ID}/decide`, note: 'POST in use' },

  // analytics
  { group: 'analytics', path: '/v1/workspace-analytics/usage' },
  { group: 'analytics', path: '/v1/workspace-analytics/costs' },
  { group: 'analytics', path: '/v1/workspace-analytics/models' },
  { group: 'analytics', path: '/v1/workspace-analytics/timeseries' },
  { group: 'analytics', path: '/v1/workspace-analytics/top-consumers' },
  { group: 'analytics', path: `/v1/analytics/agents/${ID}` },
  { group: 'analytics', path: `/v1/analytics/agents/${ID}/tools` },
  { group: 'analytics', path: `/v1/analytics/agents/${ID}/conversations` },
  { group: 'analytics', path: `/v1/analytics/agents/${ID}/realtime` },
  { group: 'analytics', path: '/v1/analytics/enterprise/anomalies' },
  { group: 'analytics', path: '/v1/analytics/enterprise/cost-analysis' },
  { group: 'analytics', path: '/v1/analytics/enterprise/forecast' },
  { group: 'analytics', path: `/v1/analytics/prompts/${ID}/summary` },

  // connect
  { group: 'connect', path: '/v2/oauth/connect/slack' },
  { group: 'connect', path: '/v2/oauth/connect/slack/status?state=probe' },

  // deployments
  { group: 'deployments', path: '/v1/deployments' },
  { group: 'deployments', path: `/v1/deployments/${ID}` },
  { group: 'deployments', path: `/v1/deployments/agent/${ID}` },
  { group: 'deployments', path: `/v1/deployments/${ID}/trail` },
  { group: 'deployments', path: '/v1/deployments/count' },
];

type Result = Probe & { status: number | string; verdict: 'ok' | 'missing' | 'unknown' };

async function probe(p: Probe): Promise<Result> {
  const url = `${BASE}${p.path}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${BOGUS_PAT}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });

    const verdict: Result['verdict'] =
      res.status === 405
        ? 'ok'
        : res.status === 404
          ? 'missing'
          : 'unknown';

    return { ...p, status: res.status, verdict };
  } catch (err) {
    return { ...p, status: err instanceof Error ? err.message.slice(0, 40) : 'network', verdict: 'unknown' };
  }
}

async function main(): Promise<void> {
  console.log(`probing ${PROBES.length} routes against ${BASE}`);
  console.log('(invalid credential — the auth filter rejects before any controller runs)\n');

  const results: Result[] = [];
  // Small concurrency: enough to be quick, not enough to look like an attack.
  const QUEUE = [...PROBES];
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const next = QUEUE.shift();
      if (!next) return;
      results.push(await probe(next));
    }
  });
  await Promise.all(workers);

  const byGroup = new Map<string, Result[]>();
  for (const r of results) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group)!.push(r);
  }

  const missing: Result[] = [];
  const unknown: Result[] = [];

  for (const [group, rows] of byGroup) {
    const bad = rows.filter((r) => r.verdict !== 'ok');
    const mark = bad.length === 0 ? '✓' : '✗';
    console.log(`${mark} ${group.padEnd(12)} ${rows.length - bad.length}/${rows.length} routed`);
    for (const r of bad) {
      console.log(`    ${r.verdict === 'missing' ? '404' : r.status} ${r.path}`);
      (r.verdict === 'missing' ? missing : unknown).push(r);
    }
  }

  console.log(`\n${results.filter((r) => r.verdict === 'ok').length}/${results.length} routes returned method-not-allowed (not payload verification)`);

  if (missing.length > 0) {
    console.log(`\n✗ ${missing.length} route(s) returned 404 — route or entity unresolved:`);
    for (const m of missing) console.log(`  ${m.path}`);
  }
  if (unknown.length > 0) {
    console.log(`\n? ${unknown.length} inconclusive (authentication, backend, network, or routing):`);
    for (const u of unknown) console.log(`  ${u.status} ${u.path}`);
  }

  process.exitCode = missing.length > 0 || unknown.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
