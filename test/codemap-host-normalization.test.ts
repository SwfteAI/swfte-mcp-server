import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { detectProject } from '../src/codemap/detect.js';
import { project } from './codemap-support.js';

type Language = 'ts' | 'py' | 'java';
function source(language: Language, url: string, expression = false): string {
  const value = expression ? url : JSON.stringify(url);
  if (language === 'ts') return `export const request = () => fetch(${value}, {method: 'POST'});`;
  if (language === 'py') return `import requests\nimport os\ndef request():\n    return requests.post(${value}, json={})\n`;
  return `import org.springframework.web.client.RestTemplate;\nclass Client { final RestTemplate http = new RestTemplate(); Object request() { return http.postForObject(${value}, null, String.class); } }`;
}
async function sites(language: Language, code: string) {
  const root = project({ [`src/client.${language}`]: code });
  try { return (await detectProject(root)).sites; } finally { rmSync(root, {recursive: true, force: true}); }
}
test('only the exact environment base establishes TypeScript authority', async () => {
  for (const name of ['NOT_SWFTE_BASE_URL', 'CUSTOM_SWFTE_BASE_URL', 'SWFTE_BASE_URL_SUFFIX']) {
    assert.equal((await sites('ts', source('ts', '`' + '${process.env.' + name + '}/v2/workflows/wf_1/invoke`', true))).length, 0);
  }
  const control = await sites('ts', source('ts', '`${process.env.SWFTE_BASE_URL}/v2/workflows/wf_1/invoke`', true));
  assert.equal(control.length, 1); assert.equal(control[0]!.artifact.id, 'wf_1');
});
for (const language of ['ts', 'py', 'java'] as const) {
  test(`${language} recognizes the normalized destination and refuses deleted artifact segments`, async () => {
    const shifted = await sites(language, source(language, 'https://api.swfte.com/v2/workflows/wf_old/../../../v1/agents/ag_new/chat'));
    assert.equal(shifted.length, 1); assert.equal(shifted[0]!.artifact.kind, 'agent'); assert.equal(shifted[0]!.artifact.id, 'ag_new');
    for (const suffix of ['../invoke', '%2e%2e/invoke', '../%2e%2e/not-an-artifact']) {
      assert.equal((await sites(language, source(language, 'https://api.swfte.com/v2/workflows/wf_old/' + suffix))).length, 0);
    }
    const control = await sites(language, source(language, 'https://api.swfte.com/v2/workflows/wf_1/./versions/3/invoke'));
    assert.equal(control.length, 1); assert.equal(control[0]!.artifact.id, 'wf_1'); assert.equal(control[0]!.artifact.pinnedVersion, '3');
  });
  test(`${language} normalized surviving environment hole retains its own provenance`, async () => {
    const expression = language === 'ts' ? '`${process.env.SWFTE_BASE_URL}/v2/../${process.env.FIRST_ID}/../v2/workflows/${process.env.WORKFLOW_ID}/invoke`'
      : language === 'py' ? 'os.getenv("SWFTE_BASE_URL") + "/v2/../" + os.getenv("FIRST_ID") + "/../v2/workflows/" + os.getenv("WORKFLOW_ID") + "/invoke"'
      : 'System.getenv("SWFTE_BASE_URL") + "/v2/../" + System.getenv("FIRST_ID") + "/../v2/workflows/" + System.getenv("WORKFLOW_ID") + "/invoke"';
    const result = await sites(language, source(language, expression, true));
    assert.equal(result.length, 1); assert.equal(result[0]!.artifact.id, null); assert.equal(result[0]!.artifact.unresolved, true);
    assert.equal(result[0]!.artifact.envVarName, 'WORKFLOW_ID');
  });
  test(`${language} explicit invalid version routes do not become live pins`, async () => {
    for (const version of ['v%2F3', 'v%253A3', 'v%20three', 'v%0A3', '%40%3A%2B-', 'v%ZZ3']) {
      const result = await sites(language, source(language, `https://api.swfte.com/v2/workflows/wf_1/versions/${version}/invoke`));
      assert.equal(result.length, 1); assert.equal(result[0]!.artifact.id, null); assert.equal(result[0]!.artifact.unresolved, true);
      assert.equal(result[0]!.artifact.pinnedVersion, null);
    }
  });
  test(`${language} dynamic version preserves its literal artifact without certifying a pin`, async () => {
    const expression = language === 'ts' ? '`https://api.swfte.com/v2/workflows/wf_1/versions/${process.env.WORKFLOW_VERSION}/invoke`'
      : language === 'py' ? '"https://api.swfte.com/v2/workflows/wf_1/versions/" + os.getenv("WORKFLOW_VERSION") + "/invoke"'
      : '"https://api.swfte.com/v2/workflows/wf_1/versions/" + System.getenv("WORKFLOW_VERSION") + "/invoke"';
    const result = await sites(language, source(language, expression, true));
    assert.equal(result.length, 1); assert.equal(result[0]!.artifact.id, 'wf_1'); assert.equal(result[0]!.artifact.unresolved, false);
    assert.equal(result[0]!.artifact.pinnedVersion, null); assert.equal(result[0]!.managed, 'raw-http');
  });
}
