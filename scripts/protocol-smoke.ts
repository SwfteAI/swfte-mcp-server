#!/usr/bin/env npx tsx
/**
 * Protocol smoke test: launches the built server over stdio as a real MCP
 * client would, and checks the handshake and tool listing.
 *
 * Deliberately does NOT call a tool — this verifies the MCP wiring, not the
 * backend. `scripts/e2e.ts` covers the backend. A placeholder credential is
 * enough here, so this runs anywhere, including CI without secrets.
 *
 *   npm run build && npx tsx scripts/protocol-smoke.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = process.env.SWFTE_SMOKE_ENTRY ?? join(HERE, '..', 'dist', 'index.js');

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      // No network call is made, so a placeholder is fine and keeps CI secret-free.
      SWFTE_PAT: 'pat_protocol_smoke_placeholder',
      SWFTE_API_KEY: '',
      SWFTE_DEBUG: '0',
      SWFTE_ALLOW_DEPLOY: '0',
      SWFTE_BASE_URL: 'https://example.invalid',
      SWFTE_TOOLS: 'all',
    },
  });

  const client = new Client({ name: 'protocol-smoke', version: '1.0.0' }, { capabilities: {} });
  const timeout = setTimeout(() => {
    console.error('Protocol smoke exceeded 30 seconds');
    void client.close().finally(() => process.exit(1));
  }, 30_000);
  try {
  await client.connect(transport);
  console.log('✓ handshake');

  const { tools } = await client.listTools();
  console.log(`✓ tools/list → ${tools.length} tools`);

  const problems: string[] = [];

  for (const t of tools) {
    if (!t.description || t.description.length < 20) problems.push(`${t.name}: description too thin`);
    if (!t.inputSchema || typeof t.inputSchema !== 'object') problems.push(`${t.name}: missing inputSchema`);
    // A JSON Schema that leaked a $ref or $schema tends to render badly in clients.
    if (JSON.stringify(t.inputSchema).includes('$ref')) problems.push(`${t.name}: inputSchema contains $ref`);
  }

  // The core tools are the contract; their absence is a wiring failure, not a
  // preference, so check them by name rather than trusting the count.
  const required = [
    'swfte_solution_advise',
    'swfte_capabilities',
    'swfte_whoami',
    'swfte_build',
    'swfte_build_status',
    'swfte_build_steer',
    'swfte_validate',
    'swfte_create',
    'swfte_refine',
    'swfte_run',
    'swfte_deploy',
    'swfte_verify',
    // Studio as source of truth: reuse-first, code bridge, approval-gated wiring.
    'swfte_find_existing',
    'swfte_get_context',
    'swfte_get_evidence',
    'swfte_trace_dependencies',
    'swfte_scaffold_client',
    'swfte_embed_widget',
    'swfte_request_approval',
    'swfte_execute_approved_action',
    'swfte_get_action_status',
    'swfte_wire_analytics',
    'swfte_wire_payments',
    // Solution Hub + bake-in.
    'swfte_fit_check',
    'swfte_adopt',
    'swfte_get_timeline',
    'swfte_sync',
    'swfte_check_upgrades',
    // Cross-organisation delivery.
    'swfte_deliver',
    'swfte_handover_record',
  ];
  const names = new Set(tools.map((t) => t.name));
  for (const r of required) if (!names.has(r)) problems.push(`missing required tool: ${r}`);

  // An unknown tool must be reported as an error, not crash the server.
  const unknown = await client.callTool({ name: 'swfte_does_not_exist', arguments: {} });
  if (!unknown.isError) problems.push('unknown tool did not return isError');
  else console.log('✓ unknown tool → isError');

  // Bad input must be rejected by schema validation before any request is made.
  const badInput = await client.callTool({ name: 'swfte_build', arguments: { kind: 'not-a-kind' } });
  if (!badInput.isError) problems.push('invalid input was not rejected');
  else console.log('✓ invalid input → isError');

  // Local guidance tools exercise calls without backend access or credentials.
  const capabilityReply = await client.callTool({ name: 'swfte_capabilities', arguments: { kind: 'agent' } });
  const capabilityData = JSON.parse((capabilityReply.content as Array<{text:string}>)[0]!.text);
  if (capabilityReply.isError || capabilityData.evidenceLevel !== 'LOCAL_IMPLEMENTATION_ONLY' || capabilityData.adapters[0].verbs.includes('deploy')) problems.push('capability tool invents agent deployment support');
  const adviceReply = await client.callTool({ name: 'swfte_solution_advise', arguments: { facts: { boundedSteps: true, adaptiveInvestigation: false }, caseStudyIds: ['S14'] } });
  const advice = JSON.parse((adviceReply.content as Array<{text:string}>)[0]!.text);
  if (adviceReply.isError || advice.recommendation !== 'workflow' || advice.examples[0].id !== 'S14' || advice.caseIndex.length !== 15) problems.push('solution advice/case references failed protocol call');
  const unsupportedReply = await client.callTool({ name: 'swfte_deploy', arguments: { kind: 'agent', id: 'local-no-network', action: 'teardown' } });
  const unsupported = JSON.parse((unsupportedReply.content as Array<{text:string}>)[0]!.text);
  if (!unsupportedReply.isError || unsupported.code !== 'UNSUPPORTED_CAPABILITY' || !unsupported.nextAction.includes('swfte_capabilities')) problems.push('unsupported capability recovery missing');
  const missingCase = await client.callTool({ name: 'swfte_solution_advise', arguments: { facts: {}, caseStudyIds: ['not-a-real-case'] } });
  if (!missingCase.isError) problems.push('unknown case study was not rejected');
  else console.log('✓ guidance calls, adapter limits and unknown reference rejection');

  // Resources and prompts are advertised over the protocol, not just registered.
  const caps = client.getServerCapabilities();
  if (!caps?.resources || !caps?.prompts) problems.push('server does not advertise resources and prompts capabilities');
  const { resources } = await client.listResources();
  if (!resources.some((r) => r.uri === 'swfte://capabilities')) problems.push('swfte://capabilities resource missing');
  const { resourceTemplates } = await client.listResourceTemplates();
  if (!resourceTemplates.some((t) => t.uriTemplate === 'swfte://catalog/{kind}/{id}')) problems.push('swfte://catalog/{kind}/{id} template missing');
  const capRes = await client.readResource({ uri: 'swfte://capabilities' });
  const capBody = JSON.parse(String((capRes.contents[0] as { text?: string }).text ?? '{}'));
  if (!capBody.catalog?.kinds?.includes('workflow') || !capBody.actions?.capabilities?.includes('app.payments.enable')) problems.push('capabilities resource content incomplete');
  const { prompts } = await client.listPrompts();
  for (const p of ['reuse-then-build', 'ship-with-analytics-and-payments', 'bake-into-codebase', 'pick-up-tailor-deploy']) {
    if (!prompts.some((x) => x.name === p)) problems.push(`missing prompt: ${p}`);
  }
  const rendered = await client.getPrompt({ name: 'reuse-then-build', arguments: { goal: 'invoice extraction' } });
  const renderedText = (rendered.messages[0]?.content as { text?: string })?.text ?? '';
  if (!renderedText.includes('swfte_find_existing')) problems.push('reuse-then-build prompt does not start from swfte_find_existing');
  const hub = await client.getPrompt({ name: 'pick-up-tailor-deploy', arguments: { problem: 'invoice extraction' } });
  const hubText = (hub.messages[0]?.content as { text?: string })?.text ?? '';
  for (const step of ['swfte_find_existing', 'swfte_fit_check', 'swfte_adopt', 'swfte_scaffold_client', 'workflow.deploy', 'swfte_get_action_status']) {
    if (!hubText.includes(step)) problems.push(`pick-up-tailor-deploy prompt does not chain ${step}`);
  }
  // A traversal targetDir is refused before any request (the credential here is a placeholder).
  const traversal = await client.callTool({ name: 'swfte_scaffold_client', arguments: { catalogRef: 'workflow:x', language: 'typescript', targetDir: '../outside' } });
  if (!traversal.isError || !JSON.stringify(traversal.content).includes('outside the working directory')) problems.push('scaffold traversal was not refused');
  console.log(`✓ resources (${resources.length} + ${resourceTemplates.length} template), prompts (${prompts.length}), scaffold confinement`);

  await client.close();

  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    throw new Error('Protocol contract failed');
  }
  console.log('\n✓ protocol smoke passed');
  } finally { clearTimeout(timeout); await client.close(); }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
