import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpServerAdapter as adapter } from '../src/kinds/mcp-server.js';

// Recorded production readback with ownership/storage/git metadata removed. No network.
const dto = JSON.parse(readFileSync(new URL('./fixtures/mcp-persisted-quote.json', import.meta.url), 'utf8'));
const generated = () => ({
  id: dto.id, name: dto.name, description: dto.description, version: dto.version,
  tools: JSON.parse(dto.toolDefinitions), resources: JSON.parse(dto.resourceDefinitions), prompts: JSON.parse(dto.promptDefinitions),
  configuration: { transport: dto.transport, port: dto.port, environment: dto.environment, requiredSecrets: dto.requiredSecrets },
  deployment: { type: dto.deploymentType }, generatedCode: dto.generatedCode, packageJson: dto.packageJson,
});
function harness(artifact: unknown) {
  const calls: any[] = [];
  const client = { request: async (request: any) => {
    calls.push(request);
    if (request.method === 'GET') return artifact;
    if (request.path.endsWith('/validate')) return { valid: Array.isArray(request.body.tools) && request.body.tools.length === 1,
      errors: [{ field: 'tools', message: 'At least one tool is required' }] };
    if (request.path.endsWith('/validate-build')) return { success: true, buildAttempted: true, validationMethod: 'stub-only' };
    if (request.path.endsWith('/deploy')) return { deployment: { id: 'stub-deployment', state: 'PROVISIONING' } };
    throw new Error('Unexpected stub route');
  } } as any;
  return { client, calls };
}
for (const [label, artifact] of [['persisted DTO', dto], ['generated server', generated()]] as const) {
  test(`${label}: get exposes definitions and exact code; input remains unchanged`, async () => {
    const before = JSON.stringify(artifact);
    const { client } = harness(artifact);
    const result = await adapter.get!(client, dto.id) as any;
    assert.equal(result.tools[0].name, 'check_synthetic_quote');
    assert.deepEqual(result.tools, generated().tools);
    assert.deepEqual(result.resources, []);
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(result.configuration, generated().configuration);
    assert.deepEqual(result.deployment, generated().deployment);
    assert.equal(result.generatedCode, dto.generatedCode);
    assert.equal(result.packageJson, dto.packageJson);
    assert.equal(JSON.stringify(artifact), before);
    if (label === 'generated server') assert.deepEqual(result, artifact);
  });
  test(`${label}: verify sends native definition and compiles exact saved snapshot`, async () => {
    const { client, calls } = harness(artifact);
    const report = await adapter.verify(client, dto.id, { run: false });
    assert.equal(report.checks.find(c => c.id === 'has-tools')?.ok, true);
    assert.equal(report.checks.find(c => c.id === 'configuration')?.ok, true);
    assert.equal(report.ok, true); // Stub contract assertion only, not live deployment readiness.
    assert.deepEqual(calls.find(c => c.path.endsWith('/validate')).body.tools, generated().tools);
    assert.deepEqual(calls.find(c => c.path.endsWith('/validate-build')).body,
      { serverName: dto.name, code: dto.generatedCode, packageJson: dto.packageJson });
    assert.ok(report.nextActions.some(a => a.includes('runtime health remains unverified')));
  });
  test(`${label}: deploy stub receives native arrays, configuration, deployment and exact code`, async () => {
    const { client, calls } = harness(artifact);
    await adapter.deploy!(client, dto.id, {});
    const server = calls.find(c => c.path.endsWith('/deploy')).body.server;
    assert.deepEqual(server.tools, generated().tools);
    assert.deepEqual(server.resources, []);
    assert.deepEqual(server.prompts, []);
    assert.deepEqual(server.configuration, generated().configuration);
    assert.deepEqual(server.deployment, generated().deployment);
    assert.equal(server.generatedCode, dto.generatedCode);
    assert.equal(server.packageJson, dto.packageJson);
    // Preserve the genuine metadata/code discrepancy; don't silently repair it.
    assert.equal(server.configuration.transport, 'http');
    assert.match(server.generatedCode, /new StdioServerTransport\(\)/);
  });
}
const invalid: Record<string, unknown> = {};
for (const field of ['toolDefinitions', 'resourceDefinitions', 'promptDefinitions']) {
  for (const [label, value] of Object.entries({ badJSON: '[', objectJSON: '{}', nullJSON: 'null', scalarJSON: '3', stringJSON: '"x"', arrayInsteadOfJSON: [], missing: undefined, nullValue: null, primitiveMember: '[1]', nullMember: '[null]', arrayMember: '[[]]' })) {
    invalid[`${field}/${label}`] = { ...dto, [field]: value };
  }
}
for (const field of ['tools', 'resources', 'prompts']) {
  for (const [label, value] of Object.entries({ object: {}, string: '[]', null: null, primitiveMember: [true] })) {
    invalid[`${field}/${label}`] = { ...generated(), [field]: value };
  }
}
invalid['missing tools'] = { name: 'Server', generatedCode: 'code' };
invalid['null artifact'] = null;
invalid['array artifact'] = [];
invalid['mixed contracts'] = { ...dto, tools: generated().tools };
for (const [label, artifact] of Object.entries(invalid)) {
  test(`malformed ${label}: get/deploy reject, verify fails before POST`, async () => {
    for (const method of ['get', 'deploy', 'validate', 'verify'] as const) {
      const { client, calls } = harness(artifact);
      if (method === 'verify') {
        const report = await adapter.verify(client, dto.id, {});
        assert.equal(report.ok, false);
        assert.equal(report.checks.find(c => c.id === 'artifact-contract')?.ok, false);
      } else if (method === 'validate') {
        await assert.rejects(adapter.validate!(client, artifact), /Invalid MCP artifact/);
      } else if (method === 'deploy') {
        await assert.rejects(adapter.deploy!(client, dto.id, {}), /Invalid MCP artifact/);
      } else {
        await assert.rejects(adapter.get!(client, dto.id), /Invalid MCP artifact/);
      }
      assert.equal(calls.filter(c => c.method === 'POST').length, 0);
    }
  });
}
test('valid empty tools is accurately reported and cannot pass verification', async () => {
  const { client } = harness({ ...dto, toolDefinitions: '[]' });
  const report = await adapter.verify(client, dto.id, {});
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.id === 'has-tools')?.ok, false);
});
