/**
 * A synthetic solution that is CORRECT in every respect the rules check.
 *
 * It is the positive control. Every rule must return zero findings against it —
 * a rule that fires here fires on correct artifacts, and a check that fires on
 * correct artifacts is worse than no check, because people learn to skip it.
 *
 * `mutation.mjs` then breaks one thing at a time and requires the corresponding
 * rule to notice. Both halves are needed: passing on the clean fixture and
 * failing on the mutated one. A rule that only ever passes is indistinguishable
 * from a rule that cannot fail.
 */

export function cleanSnapshot() {
  const agentId = 'agent-0000';
  const chatflowId = 'chatflow-0000';
  const datasetId = 'dataset-0000';
  const moduleId = 'module-0000';

  const workflow = {
    id: 'wf-0000',
    name: 'Clean Workflow',
    status: 'ACTIVE',
    published: true,
    enabled: true,
    nodes: {
      trigger: { id: 'trigger', type: 'MANUAL_TRIGGER', configuration: {} },
      fetch: { id: 'fetch', type: 'HTTP_REQUEST', configuration: { url: 'https://feed.internal/records', method: 'GET' } },
      shape: {
        id: 'shape',
        type: 'JAVASCRIPT',
        configuration: {
          code: [
            // A comment naming the banned calls, so the clean fixture proves
            // GEN-SANDBOX-CRYPTO reads code rather than text. It did not, until
            // a real solution made it fire on exactly this comment.
            "// no crypto here: require('crypto') and createHash() both throw in the sandbox",
            'const items = inputs.fetch.body.items;',
            'const rows = items.map(i => ({ ref: i.ref, score: i.score }));',
            'const rowsJson = JSON.stringify(rows);',
            'return {',
            // A comment carrying BOTH a colon and a comma, inside the returned
            // object literal, immediately before the key. This shape made
            // returnedKeys lose the key it preceded, which turned a correct
            // node into a warning on a real solution.
            '  // note: two shapes here, one per destination.',
            '  rowsJson,',
            '  count: rows.length,',
            '};',
          ].join('\n'),
        },
      },
      gate: {
        id: 'gate',
        type: 'IF_ELSE',
        configuration: { condition: '{{shape.result.count}} greater_than 0' },
      },
      persist: {
        id: 'persist',
        type: 'DATA_TABLE',
        configuration: {
          operation: 'insert',
          tableName: 'cf_records',
          rows: '{{shape.result.rowsJson}}',
        },
      },
      review: { id: 'review', type: 'HUMAN_INPUT', configuration: { prompt: 'approve?' } },
      ground: { id: 'ground', type: 'KNOWLEDGE_RETRIEVAL', configuration: { datasetId } },
      callAgent: { id: 'callAgent', type: 'AGENT', configuration: { agentId } },
    },
    edges: [
      { sourceNodeId: 'trigger', sourcePortId: 'out', targetNodeId: 'fetch', targetPortId: 'in' },
      { sourceNodeId: 'fetch', sourcePortId: 'out', targetNodeId: 'shape', targetPortId: 'in' },
      { sourceNodeId: 'shape', sourcePortId: 'out', targetNodeId: 'gate', targetPortId: 'in' },
      { sourceNodeId: 'gate', sourcePortId: 'true', targetNodeId: 'persist', targetPortId: 'in' },
      { sourceNodeId: 'persist', sourcePortId: 'out', targetNodeId: 'ground', targetPortId: 'in' },
      { sourceNodeId: 'ground', sourcePortId: 'out', targetNodeId: 'callAgent', targetPortId: 'in' },
      { sourceNodeId: 'callAgent', sourcePortId: 'out', targetNodeId: 'review', targetPortId: 'in' },
    ],
  };

  const components = [
    { key: 'flow', kind: 'workflow', id: workflow.id, record: workflow },
    {
      key: 'screener',
      kind: 'agent',
      id: agentId,
      record: {
        id: agentId,
        capabilityTier: 'AGENTIC',
        knowledgeModuleIds: [moduleId],
        knowledgeSources: '',
        tools: ['search_knowledge'],
        persona: 'A screener.',
        instructions: 'Check ref and score on every record.',
        systemPrompt: '',
      },
    },
    {
      key: 'intake',
      kind: 'chatflow',
      id: chatflowId,
      record: {
        id: chatflowId,
        agentId,
        agentConfig: { defaultAgentId: agentId },
        fields: [{ id: 'ref', required: true }, { id: 'score', required: true }],
      },
    },
    { key: 'front', kind: 'widget', id: 'widget-0000', record: { id: 'widget-0000', config: { brain: { kind: 'CHATFLOW', id: chatflowId } } } },
    { key: 'rules', kind: 'dataset', id: datasetId, record: { id: datasetId } },
  ];

  const manifest = {
    id: 'clean',
    name: 'Clean fixture',
    workspaceId: '271',
    tablePrefix: 'cf_',
    expectLive: true,
    dataTables: ['cf_records'],
    allowedIntegrations: [],
    allowedOutbound: [],
    components: components.map(({ key, kind, id }) => ({ key, kind, id })),
    wires: [
      { from: 'screener', to: 'module', relation: 'grounds-on' },
      { from: 'intake', to: 'screener', relation: 'hands-off-to' },
      { from: 'front', to: 'intake', relation: 'answers-through' },
      { from: 'flow', to: 'screener', relation: 'invokes-agent' },
      { from: 'flow', to: 'rules', relation: 'reads-knowledge' },
    ],
    coverage: [
      { component: 'intake', id: 'fields', in: 'fields[].id', match: 'normalized', minRatio: 1, of: ['ref', 'score'] },
      { component: 'screener', id: 'prompt', in: '$prompt', match: 'contains', minRatio: 1, of: ['ref', 'score'] },
    ],
  };

  // the module the agent grounds on is a component too, so the wire can resolve
  components.push({ key: 'module', kind: 'module', id: moduleId, record: { id: moduleId } });
  manifest.components.push({ key: 'module', kind: 'module', id: moduleId });

  return {
    manifest,
    workspaceId: '271',
    errors: [],
    components,
    workflows: [components[0]],
    executions: {
      flow: [
        {
          header: { id: 'exec-0000', status: 'SUCCEEDED' },
          envelopeStatus: 'SUCCEEDED',
          pool: {
            inputs: { records: [{ ref: 'A-1' }, { ref: 'A-2' }] },
            persist: { operation: 'insert', tableName: 'cf_records', inserted: 2, rowCount: 2, success: true },
          },
          traces: [
            { nodeId: 'trigger', nodeType: 'MANUAL_TRIGGER', status: 'COMPLETED', outputSizeBytes: 100 },
            { nodeId: 'fetch', nodeType: 'HTTP_REQUEST', status: 'COMPLETED', outputSizeBytes: 4000 },
            { nodeId: 'shape', nodeType: 'JAVASCRIPT', status: 'COMPLETED', outputSizeBytes: 3000 },
            { nodeId: 'persist', nodeType: 'DATA_TABLE', status: 'COMPLETED', outputSizeBytes: 500 },
          ],
        },
      ],
    },
    dataTablesLive: [{ id: 'dt_clean', name: 'cf_records', rowCount: 42 }],
    knowledgeModules: [{ id: moduleId, datasetId, name: 'clean module' }],
    datasets: [{ id: datasetId, name: 'clean dataset' }],
    datasetDocs: { [datasetId]: [{ id: 'doc-0', name: 'rules.md', indexingStatus: 'COMPLETED', totalSegments: 12, completedSegments: 12 }] },
    sourceFiles: [{ path: 'build/clean.mjs', text: "await patch(`/v2/workflows/${id}`, body);\n" }],
  };
}

/**
 * Deep clone so a mutation cannot leak into the next case.
 *
 * `snap.workflows` aliases entries of `snap.components` in a real snapshot, and
 * a naive JSON round-trip silently splits them into two copies — a mutation
 * applied through one would then be invisible to a rule reading the other, and
 * the rule would look like it survived. That is exactly the kind of harness bug
 * that produces a control which cannot fire, so the aliasing is restored here.
 */
export function clone(o) {
  const s = JSON.parse(JSON.stringify(o));
  s.workflows = (s.components ?? []).filter((c) => c.kind === 'workflow' && c.record);
  return s;
}
