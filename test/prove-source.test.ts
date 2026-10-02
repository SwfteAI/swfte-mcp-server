import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSourceProof } from '../src/prove/source.js';
import { treeKey } from '../src/prove/treekey.js';
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

test('stale verified tree refuses before consent upload and start; freshly verified twin is accepted', async () => {
  const root = await fixture(); let consents = 0; let uploads = 0; let starts = 0;
  const intake: SourceIntake = { resolveLevel: async () => 'diff',
    authorizeSource: async () => { consents++; return { explicitFixtureConsent: true }; },
    prepareUpload: async ({ snapshot }) => { uploads++; return { payloadRef: 'fixture_receipt', runKey: snapshot.run_key, manifest: snapshot.manifest }; } };
  const client = { baseUrl: 'https://api.example.invalid', request: async <T>(options: { body?: unknown }) => {
    starts++; const body = options.body as { run_key: string; level: string };
    return { schema: 'nexus.proof.v1', run_id: `pr_${'a'.repeat(64)}`, run_key: body.run_key, level: body.level,
      status: 'PENDING', verdict: 'UNAVAILABLE', checks: [], findings: [], dependency_gaps: ['RUN_PENDING'],
      behavior_trace: [], explained: [] } as T;
  } };
  try {
    const verified = await treeKey(root);
    await writeFile(join(root, 'source.ts'), 'const total = 3;');
    await assert.rejects(runSourceProof(client, { path: root, level: 'diff', expectedRunKey: verified.run_key,
      sessionId: 'session1', trigger: 'verified_edit', requestedChecks: ['scan'] }, { intake, learning: boundary }), /STALE_CONTENT/);
    assert.equal(consents, 0); assert.equal(uploads, 0); assert.equal(starts, 0);
    await assert.rejects(runSourceProof(client, { path: root, level: 'diff', expectedRunKey: 'invalid', requestedChecks: ['scan'] },
      { intake, learning: boundary }), /STALE_CONTENT/);
    assert.equal(consents, 0); assert.equal(uploads, 0); assert.equal(starts, 0);
    const fresh = await treeKey(root);
    const accepted = await runSourceProof(client, { path: root, level: 'diff', expectedRunKey: fresh.run_key,
      sessionId: 'session1', trigger: 'verified_edit', requestedChecks: ['scan'] }, { intake, learning: boundary });
    assert.equal('status' in accepted && accepted.status, 'PENDING');
    assert.equal(consents, 1); assert.equal(uploads, 1); assert.equal(starts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('awaited level and proof-origin admission cannot authorize changed verified bytes', async () => {
  for (const delayed of ['level', 'origin']) {
    const root = await fixture(); let consents = 0; let uploads = 0; let starts = 0;
    const mutate = async () => { await writeFile(join(root, 'source.ts'), 'const total = 3;'); };
    const intake: SourceIntake = {
      resolveLevel: async () => { if (delayed === 'level') await mutate(); return 'diff'; },
      authorizeSource: async () => { consents++; return { explicitFixtureConsent: true }; },
      prepareUpload: async () => { uploads++; throw new Error('changed verified tree must not upload'); },
    };
    const learning: ProofLearningBoundary = { proofOriginExcludedByDefault: () => true,
      withProofOrigin: async action => { if (delayed === 'origin') await mutate(); return action(); } };
    try {
      const verified = await treeKey(root);
      await assert.rejects(runSourceProof({ baseUrl: 'https://api.example.invalid', request: async <T>() => { starts++; return {} as T; } },
        { path: root, level: 'diff', expectedRunKey: verified.run_key, requestedChecks: ['scan'], trigger: 'verified_edit' },
        { intake, learning }), /STALE_CONTENT/);
      assert.equal(consents, delayed === 'level' ? 0 : 1); assert.equal(uploads, 0); assert.equal(starts, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('tree change during an already attempted producer upload blocks start without pretending upload never happened', async () => {
  const root = await fixture(); let uploads = 0; let starts = 0;
  const intake: SourceIntake = { resolveLevel: async () => 'diff', authorizeSource: async () => ({ explicitFixtureConsent: true }),
    prepareUpload: async ({ snapshot }) => {
      uploads++; await writeFile(join(root, 'source.ts'), 'const total = 3;');
      return { payloadRef: 'fixture_immutable_receipt', runKey: snapshot.run_key, manifest: snapshot.manifest };
    } };
  try {
    const verified = await treeKey(root);
    await assert.rejects(runSourceProof({ baseUrl: 'https://api.example.invalid', request: async <T>() => { starts++; return {} as T; } },
      { path: root, level: 'diff', expectedRunKey: verified.run_key, requestedChecks: ['scan'], trigger: 'verified_edit' },
      { intake, learning: boundary }), /STALE_CONTENT/);
    assert.equal(uploads, 1); assert.equal(starts, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('frozen configured target and source abort guard each next effect across awaited admission', async () => {
  for (const change of ['destination', 'abort']) for (const phase of ['level', 'consent', 'origin', 'upload']) {
    const root = await fixture(); const abort = new AbortController();
    const configured = 'https://api.example.invalid';
    let consents = 0; let uploads = 0; let starts = 0;
    const client = { baseUrl: configured, request: async <T>() => { starts++; return {} as T; } };
    const changeAdmission = async (at: string) => {
      await Promise.resolve();
      if (at !== phase) return;
      if (change === 'destination') client.baseUrl = 'https://changed.example.invalid';
      else abort.abort();
    };
    const intake: SourceIntake = {
      resolveLevel: async () => { await changeAdmission('level'); return 'diff'; },
      authorizeSource: async input => { consents++; assert.equal(input.destination, configured);
        await changeAdmission('consent'); return { explicitFixtureConsent: true }; },
      prepareUpload: async ({ snapshot }) => { uploads++; await changeAdmission('upload');
        return { payloadRef: 'fixture_immutable_receipt', runKey: snapshot.run_key, manifest: snapshot.manifest }; },
    };
    const learning: ProofLearningBoundary = { proofOriginExcludedByDefault: () => true,
      withProofOrigin: async action => { await changeAdmission('origin'); return action(); } };
    try {
      const verified = await treeKey(root);
      await assert.rejects(runSourceProof(client, { path: root, level: 'diff', expectedRunKey: verified.run_key,
        signal: abort.signal, trigger: 'verified_edit', requestedChecks: ['scan'] }, { intake, learning }),
        change === 'destination' ? /PROVING_DESTINATION_CHANGED/ : /PROVING_ABORTED/);
      assert.equal(consents, phase === 'level' ? 0 : 1, `${change}/${phase} consent attempts`);
      assert.equal(uploads, phase === 'upload' ? 1 : 0, `${change}/${phase} already attempted uploads`);
      assert.equal(starts, 0, `${change}/${phase} next POST effects`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('preaborted source never reads disk or authorizes effects; unchanged admission accepts once', async () => {
  const abort = new AbortController(); abort.abort(); let effects = 0;
  await assert.rejects(runSourceProof({ baseUrl: 'https://api.example.invalid', request: async <T>() => { effects++; return {} as T; } },
    { path: '/nonexistent-no-read-on-abort', signal: abort.signal, level: 'diff' }), /PROVING_ABORTED/);
  assert.equal(effects, 0);
  const root = await fixture(); let consents = 0; let uploads = 0; let starts = 0;
  const configured = 'https://api.example.invalid';
  const intake: SourceIntake = { resolveLevel: async () => 'diff',
    authorizeSource: async input => { consents++; assert.equal(input.destination, configured); return { explicitFixtureConsent: true }; },
    prepareUpload: async ({ snapshot }) => { uploads++; return { payloadRef: 'fixture_immutable_receipt', runKey: snapshot.run_key, manifest: snapshot.manifest }; } };
  try {
    const verified = await treeKey(root);
    const result = await runSourceProof({ baseUrl: configured, request: async <T>(options: { body?: unknown }) => {
      starts++; const body = options.body as { run_key: string };
      return { schema: 'nexus.proof.v1', run_id: `pr_${'a'.repeat(64)}`, run_key: body.run_key, level: 'diff', status: 'PENDING',
        verdict: 'UNAVAILABLE', checks: [], findings: [], dependency_gaps: ['RUN_PENDING'], behavior_trace: [], explained: [] } as T;
    } }, { path: root, level: 'diff', expectedRunKey: verified.run_key, signal: new AbortController().signal,
      requestedChecks: ['scan'], trigger: 'verified_edit' }, { intake, learning: boundary });
    assert.equal('status' in result && result.status, 'PENDING');
    assert.equal(consents, 1); assert.equal(uploads, 1); assert.equal(starts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
