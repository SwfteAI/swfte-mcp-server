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
const ENTRY = join(HERE, '..', 'dist', 'index.js');

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [ENTRY],
    env: {
      ...process.env,
      // No network call is made, so a placeholder is fine and keeps CI secret-free.
      SWFTE_PAT: process.env.SWFTE_PAT ?? 'pat_protocol_smoke_placeholder',
      SWFTE_TOOLS: process.env.SWFTE_TOOLS ?? 'all',
    },
  });

  const client = new Client({ name: 'protocol-smoke', version: '1.0.0' }, { capabilities: {} });
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

  await client.close();

  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\n✓ protocol smoke passed');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
