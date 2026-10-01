import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSourceProof } from '../src/prove/source.js';
import { sourceProofHandler } from '../src/tools/proving-source.js';
import type { ProofLearningBoundary, SourceIntake, TreeSnapshot } from '../src/prove/types.js';
const exec = promisify(execFile);
const boundary: ProofLearningBoundary = { proofOriginExcludedByDefault: () => true, withProofOrigin: action => action() };
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prove-source-')); await exec('git', ['init', '-q', root]);
  await writeFile(join(root, 'source.ts'), 'const total = 2;'); return root;
}

test('secret refuses before consent or upload; key removed twin uploads exactly once through actual port seam', async () => {
  const root = await fixture(); let uploads = 0; let requests = 0;
  const intake: SourceIntake = { resolveLevel: async () => 'diff', authorizeSource: async () => ({ userConsent: true }),
    prepareUpload: async ({ snapshot }) => { uploads++; return { payloadRef: 'upload_fixture', runKey: snapshot.run_key, manifest: snapshot.manifest }; } };
  const client = { baseUrl: 'https://api.example.invalid', request: async <T>(options: { body?: unknown }) => {
    requests++; const request = options.body as { run_key: string; level: string };
    return { schema: 'nexus.proof.v1', run_id: `pr_${'a'.repeat(64)}`, run_key: request.run_key, level: request.level,
      status: 'PENDING', verdict: 'UNAVAILABLE', checks: [], findings: [], dependency_gaps: ['RUN_PENDING'], behavior_trace: [], explained: [] } as T;
  } };
  try {
    const key = ['AK', 'IA', 'A1B2C3D4E5F6G7H8'].join(''); await writeFile(join(root, 'source.ts'), `const credential = '${key}';`);
    const refused = await runSourceProof(client, { path: root, level: 'diff' }, { intake, learning: boundary });
    assert.equal('token' in refused && refused.token, 'PROOF_REFUSED'); assert.equal(uploads, 0); assert.equal(requests, 0);
    await writeFile(join(root, 'source.ts'), 'const total = 2;');
    const clean = await runSourceProof(client, { path: root, level: 'diff', requestedChecks: ['scan'] }, { intake, learning: boundary });
    assert.equal('token' in clean && clean.token, false); assert.equal(uploads, 1); assert.equal(requests, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing07 and absent08 private-origin policy make zero remote requests', async () => {
  const root = await fixture(); let network = 0;
  const client = { baseUrl: 'https://api.example.invalid', request: async <T>() => { network++; return {} as T; } };
  const intake: SourceIntake = { resolveLevel: async () => 'tree', authorizeSource: async () => ({}),
    prepareUpload: async () => { throw new Error('must not upload'); } };
  try {
    const missing = await runSourceProof(client, { path: root, level: 'tree' });
    assert(missing.dependency_gaps.includes('07_SHARED_CONSENT_LEVELS_UPLOAD'));
    const absent = await runSourceProof(client, { path: root, level: 'tree' }, { intake });
    assert(absent.dependency_gaps.includes('08_PROOF_LEARNING_EXCLUSION')); assert.equal(network, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('repository level lowering delegated to shared07 is honored; feature never raises it', async () => {
  const root = await fixture(); let authorized = 0;
  const intake: SourceIntake = { resolveLevel: async () => 'local', authorizeSource: async () => { authorized++; return {}; },
    prepareUpload: async () => { throw new Error('must not upload'); } };
  try {
    const result = await runSourceProof({ baseUrl: 'https://api.example.invalid', request: async <T>() => ({} as T) },
      { path: root, level: 'tree' }, { intake, learning: boundary });
    assert.equal(result.level, 'local'); assert.equal(authorized, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('tree edit during consent is stale and upload never starts', async () => {
  const root = await fixture(); let uploads = 0;
  const intake: SourceIntake = { resolveLevel: async () => 'tree', authorizeSource: async () => {
    await writeFile(join(root, 'source.ts'), 'const total = 3;'); return {};
  }, prepareUpload: async () => { uploads++; throw new Error('must not run'); } };
  try {
    await assert.rejects(runSourceProof({ baseUrl: 'https://api.example.invalid', request: async <T>() => ({} as T) },
      { path: root, level: 'tree' }, { intake, learning: boundary }), /STALE_CONTENT/);
    assert.equal(uploads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('prohibited source license refuses the real upload boundary', async () => {
  const root = await fixture(); let uploads = 0;
  const intake: SourceIntake = { resolveLevel: async () => 'tree', authorizeSource: async () => ({}),
    prepareUpload: async () => { uploads++; throw new Error('must not upload'); } };
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'Elastic-2.0' }));
    const result = await runSourceProof({ baseUrl: 'https://api.example.invalid', request: async <T>() => ({} as T) },
      { path: root, level: 'tree' }, { intake, learning: boundary });
    assert(result.dependency_gaps.includes('SOURCE_LICENSE_REFUSED')); assert.equal(uploads, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('hosted MCP refuses local source before touching server disk', async () => {
  const result = await sourceProofHandler()({ source: { path: '/never-read-server-disk' } }, { localFilesystem: false } as never);
  assert.equal((result as { code: string }).code, 'LOCAL_FILESYSTEM_REQUIRED');
});
