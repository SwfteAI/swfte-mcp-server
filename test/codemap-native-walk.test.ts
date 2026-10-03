import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeFilesystem, NativeFilesystemError } from '../src/native-filesystem.js';
import { NativeScanReader } from '../src/codemap/native-reader.js';
import { walkProject, walkProjectWithReader } from '../src/codemap/walk.js';
import { detectProject, detectProjectWithReader } from '../src/codemap/detect.js';
import { scanRepository, repositoryIdentity, currentBoundScan } from '../src/codemap/scan.js';
import { project } from './codemap-support.js';
import type { UploadConfig } from '../src/codemap/upload.js';

const envFiles = { secret: ['dot-env', 'dot-env.*'], names: ['dot-env.example'] };

async function fixture(run: (root: string, outside: string) => unknown): Promise<void> {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codemap-native-')));
  const root = join(base, 'project'), outside = join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  try { await run(root, outside); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}
function source(root: string): void {
  fs.mkdirSync(join(root, 'nested'));
  fs.writeFileSync(join(root, 'nested', 'app.ts'), 'export const INSIDE = 1;');
  fs.writeFileSync(join(root, 'nested', 'package.json'), '{"name":"nested-package"}');
  fs.writeFileSync(join(root, 'nested', 'dot-env.example'), 'SWFTE_FLOW_ID=hidden-value');
}

test('actual native positive nested source and metadata; public and borrowed lifetime', async () => fixture(async root => {
  source(root);
  const realOpen = NativeFilesystem.openRoot;
  const realClose = NativeFilesystem.prototype.close;
  let opens = 0, closes = 0;
  const open = mock.method(NativeFilesystem, 'openRoot', (path: string) => { opens++; return realOpen(path); });
  const close = mock.method(NativeFilesystem.prototype, 'close', function(this: NativeFilesystem) { closes++; return realClose.call(this); });
  try {
    const walked = walkProject(root, { envFiles });
    assert.deepEqual(walked.files.map(file => file.relPath), ['nested/app.ts']);
    assert.deepEqual(walked.packages, [{ dir: 'nested', pkgId: 'nested-package' }]);
    assert.deepEqual(walked.envExampleNames, ['SWFTE_FLOW_ID']);
    assert.equal(walked.truncated, false);
    assert.equal(opens, 1); assert.equal(closes, 1);
    const seen: string[] = [];
    const detected = await detectProject(root, { envFiles, detectors: [{ id: 'positive', languages: ['typescript'], detect(file) {
      seen.push(file.text); return { sites: [], implementations: [], envVarNames: [] };
    } }] });
    assert.equal(detected.filesScanned, 1); assert.deepEqual(seen, ['export const INSIDE = 1;']);
    assert.equal(opens, 2); assert.equal(closes, 2);
    const reader = new NativeScanReader(root);
    try {
      walkProjectWithReader(reader, { envFiles });
      await detectProjectWithReader(reader, { envFiles, detectors: [] });
      assert.equal(closes, 2, 'borrowers must not close owner');
      assert.equal(reader.readText('nested/app.ts'), 'export const INSIDE = 1;');
    } finally { reader.close(); }
    assert.equal(opens, 3); assert.equal(closes, 3);
  } finally { open.mock.restore(); close.mock.restore(); }
}));

test('actual parent swap at source read admits no outside bytes or detector marker', async () => fixture(async (root, outside) => {
  source(root);
  fs.writeFileSync(join(outside, 'app.ts'), 'OUTSIDE_UNIQUE_MARKER');
  const read = NativeFilesystem.prototype.read;
  let swapped = false;
  const observer = mock.method(NativeFilesystem.prototype, 'read', function(this: NativeFilesystem, rel: string, cap?: number) {
    if (rel === 'nested/app.ts' && !swapped) {
      swapped = true;
      fs.renameSync(join(root, 'nested'), join(root, 'retained'));
      fs.symlinkSync(outside, join(root, 'nested'));
    }
    return read.call(this, rel, cap);
  });
  const seen: string[] = [];
  try {
    const outcome = await detectProject(root, { envFiles, detectors: [{ id: 'swap', languages: ['typescript'], detect(file) {
      seen.push(file.text); return { sites: [], implementations: [], envVarNames: [] };
    } }] });
    assert.equal(swapped, true);
    assert.equal(outcome.truncated, true);
    assert.deepEqual(seen, [], 'outside bytes never reach detector');
    assert.equal(fs.readFileSync(join(outside, 'app.ts'), 'utf8'), 'OUTSIDE_UNIQUE_MARKER');
  } finally { observer.mock.restore(); }
}));

test('held actual root survives pathname substitution; no traversal fallback', async () => fixture(async (root, outside) => {
  source(root);
  fs.writeFileSync(join(outside, 'outside.ts'), 'OUTSIDE_UNIQUE_MARKER');
  const reader = new NativeScanReader(root);
  fs.renameSync(root, root + '-held'); fs.symlinkSync(outside, root);
  const noList = mock.method(fs, 'readdirSync', () => { throw new Error('PATHNAME_FALLBACK'); });
  try {
    const walked = walkProjectWithReader(reader, { envFiles });
    assert.deepEqual(walked.files.map(file => file.relPath), ['nested/app.ts']);
    assert.equal(reader.readText('nested/app.ts'), 'export const INSIDE = 1;');
    assert.equal(walked.truncated, false);
  } finally { noList.mock.restore(); reader.close(); }
  assert.throws(() => reader.list(), error => error instanceof NativeFilesystemError && error.code === 'ROOT_CLOSED');
}));

test('native admission/protocol refusal propagates and never invokes pathname traversal', async () => fixture(root => {
  source(root);
  const noList = mock.method(fs, 'readdirSync', () => { throw new Error('PATHNAME_FALLBACK'); });
  const noOpen = mock.method(NativeFilesystem, 'openRoot', () => { throw new NativeFilesystemError('NATIVE_ARTIFACT_MISSING_OR_INVALID'); });
  try { assert.throws(() => walkProject(root, { envFiles }), error => error instanceof NativeFilesystemError && error.code === 'NATIVE_ARTIFACT_MISSING_OR_INVALID'); }
  finally { noOpen.mock.restore(); noList.mock.restore(); }
}));

test('enumerated hardlinked metadata is incomplete, not complete empty success', async () => fixture((root, outside) => {
  source(root);
  fs.writeFileSync(join(outside, 'package.json'), '{"name":"outside"}');
  fs.unlinkSync(join(root, 'nested', 'package.json'));
  fs.linkSync(join(outside, 'package.json'), join(root, 'nested', 'package.json'));
  const result = walkProject(root, { envFiles });
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some(warning => warning.includes('package.json')));
  assert.ok(!result.packages.some(pkg => pkg.pkgId === 'outside'));
}));

test('public detect closes actual root on preprocessing exception', async () => fixture(async root => {
  source(root);
  const realClose = NativeFilesystem.prototype.close;
  let closes = 0;
  const close = mock.method(NativeFilesystem.prototype, 'close', function(this: NativeFilesystem) { closes++; return realClose.call(this); });
  try {
    await assert.rejects(detectProject(root, { envFiles, preprocess() { throw new Error('PREPROCESS_FAILURE'); } }), /PREPROCESS_FAILURE/);
    assert.equal(closes, 1);
  } finally { close.mock.restore(); }
}));

test('real detectors discover native TS/Python/Java call sites', async () => fixture(async root => {
  fs.writeFileSync(join(root, 'caller.ts'), "import Swfte from '@swfte/sdk'; const client = new Swfte({});\nfunction run() { const r=client.workflows.invoke('wf_ts',{question:1}); console.log(r.outputs.answer); }");
  fs.writeFileSync(join(root, 'caller.py'), "from swfte import SwfteClient\nclient = SwfteClient()\ndef run():\n    r=client.workflows.invoke('wf_py',{'question':1})\n    print(r.outputs['answer'])\n");
  fs.writeFileSync(join(root, 'Caller.java'), 'import com.swfte.sdk.SwfteClient; import java.util.*; class Caller { SwfteClient client; void run() { var r=client.workflows().invoke("wf_java",Map.of("question",1)); sink(r.getOutputs().get("answer")); }}');
  const result = await detectProject(root, { envFiles });
  assert.equal(result.truncated, false); assert.equal(result.filesScanned, 3);
  assert.deepEqual(result.sites.map(site => site.artifact.id).sort(), ['wf_java', 'wf_py', 'wf_ts']);
  for (const site of result.sites) {
    assert.deepEqual(site.inputKeys, ['question']); assert.deepEqual(site.outputKeys, ['answer']);
  }
}));

test('actual scan owns one root per hash pass, closes before outbound, and durable bound readback agrees', async () => {
  // project() creates an isolated real committed Git fixture when this queued test is later executed.
  const root = project({ '.gitignore': '.swfte/codemap/\n', 'nested/package.json': '{"name":"native-scan"}',
    'nested/caller.ts': "import Swfte from '@swfte/sdk'; const client=new Swfte({}); client.workflows.invoke('wf_native',{question:'PRIVATE_VALUE'});" });
  const repoId = repositoryIdentity(root).repo.id;
  const realOpen = NativeFilesystem.openRoot, realClose = NativeFilesystem.prototype.close;
  let opened = 0, closed = 0;
  const open = mock.method(NativeFilesystem, 'openRoot', (path: string) => { opened++; return realOpen(path); });
  const close = mock.method(NativeFilesystem.prototype, 'close', function(this: NativeFilesystem) { closed++; return realClose.call(this); });
  const bodies: unknown[] = [];
  const cfg: UploadConfig = { baseUrl: 'http://127.0.0.1:8976', credential: 'test-native-scanner', credentialKind: 'pat', env: {},
    fetch: (async (url, init) => {
      assert.equal(opened, closed, 'no scanner capability crosses outbound await');
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString()) : null;
      if (body) bodies.push(body);
      if (path.endsWith('/key')) return Response.json({ keyId: 'wk_native', key: Buffer.alloc(32, 7).toString('base64') });
      if (path.endsWith('/manifests')) return Response.json({ status: 'stored', commitSha: body.commitSha, callSites: body.callSites.length });
      if (path.endsWith('/repos')) {
        const optIn = { repoId, pathHashing: false, attribution: false };
        // GET lists consent ({repos:[...]}); POST answers with the single opt-in record.
        return Response.json(init?.method === 'GET' ? { repos: [optIn] } : optIn);
      }
      throw new Error('unexpected test route');
    }) as typeof fetch };
  try {
    const scanned = await scanRepository(root, cfg, { optIn: true });
    assert.equal(scanned.status, 'stored'); assert.equal(scanned.manifest.callSites.length, 1);
    assert.equal(opened, 3, 'initial, post-consent and final before-upload hash passes each own exactly one root');
    assert.equal(closed, 3);
    assert.ok(!JSON.stringify(bodies).includes('PRIVATE_VALUE'));
    const reread = await currentBoundScan(root, cfg, { keyId: 'wk_native', key: Buffer.alloc(32, 7) }, { repoId, pathHashing: false, attribution: false });
    assert.equal(reread.sourceDigest, reread.binding.sourceDigest);
    assert.equal(opened, 4); assert.equal(closed, 4);
  } finally { open.mock.restore(); close.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual source hash reread rejects changed content before any outbound request', async () => {
  const root = project({ 'caller.ts': "import Swfte from '@swfte/sdk'; const client=new Swfte({}); client.workflows.invoke('wf_native',{});" });
  const read = NativeFilesystem.prototype.read;
  let reads = 0, requests = 0;
  const observe = mock.method(NativeFilesystem.prototype, 'read', function(this: NativeFilesystem, rel: string, cap?: number) {
    if (rel === 'caller.ts' && ++reads === 2) fs.writeFileSync(join(root, rel), 'CHANGED_AFTER_DETECTION');
    return read.call(this, rel, cap);
  });
  const cfg: UploadConfig = { baseUrl: 'http://127.0.0.1:8976', credential: 'test-native-scanner', credentialKind: 'pat', env: {},
    fetch: (async () => { requests++; throw new Error('unexpected outbound'); }) as typeof fetch };
  try {
    await assert.rejects(scanRepository(root, cfg, { optIn: true }), error => error instanceof NativeFilesystemError && error.code === 'STALE_CONTENT');
    assert.equal(reads, 2); assert.equal(requests, 0);
  } finally { observe.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('fatal protocol errors release actual admitted capability; absent listed entries are incomplete', async () => fixture(root => {
  source(root);
  const list = NativeFilesystem.prototype.list, realClose = NativeFilesystem.prototype.close;
  let closes = 0;
  const close = mock.method(NativeFilesystem.prototype, 'close', function(this: NativeFilesystem) { closes++; return realClose.call(this); });
  const fail = mock.method(NativeFilesystem.prototype, 'list', () => { throw new NativeFilesystemError('PROTOCOL_INVALID'); });
  try { assert.throws(() => walkProject(root, { envFiles }), error => error instanceof NativeFilesystemError && error.code === 'PROTOCOL_INVALID'); assert.equal(closes, 1); }
  finally { fail.mock.restore(); close.mock.restore(); }
  const disappear = mock.method(NativeFilesystem.prototype, 'list', function(this: NativeFilesystem, rel?: string) {
    if (rel === 'nested') fs.rmSync(join(root, 'nested'), { recursive: true });
    return list.call(this, rel);
  });
  try { assert.equal(walkProject(root, { envFiles }).truncated, true); } finally { disappear.mock.restore(); }
}));

test('empty and detector-failure public scans close; borrower stays open after failure', async () => fixture(async root => {
  const realClose = NativeFilesystem.prototype.close;
  let closes = 0;
  const close = mock.method(NativeFilesystem.prototype, 'close', function(this: NativeFilesystem) { closes++; return realClose.call(this); });
  try {
    const empty = await detectProject(root, { envFiles });
    assert.equal(empty.filesScanned, 0); assert.equal(empty.truncated, false); assert.equal(closes, 1);
    source(root);
    const failed = await detectProject(root, { envFiles, detectors: [{ id: 'failure', languages: ['typescript'], detect() { throw new Error('detector failure'); } }] });
    assert.equal(failed.truncated, true); assert.equal(closes, 2);
    const reader = new NativeScanReader(root);
    try {
      await assert.rejects(detectProjectWithReader(reader, { envFiles, preprocess() { throw new Error('borrower failure'); } }), /borrower failure/);
      assert.equal(closes, 2);
      assert.equal(reader.readText('nested/app.ts'), 'export const INSIDE = 1;');
    } finally { reader.close(); }
    assert.equal(closes, 3);
  } finally { close.mock.restore(); }
}));

test('explicit configured read cap refusal and enumerated shared source remain incomplete', async () => fixture((root, outside) => {
  source(root);
  assert.throws(() => walkProject(root, { envFiles, maxFileBytes: 4 * 1024 * 1024 + 1 }), error => error instanceof NativeFilesystemError && error.code === 'SIZE_LIMIT');
  fs.writeFileSync(join(outside, 'source.ts'), 'OUTSIDE_SHARED_INODE');
  fs.linkSync(join(outside, 'source.ts'), join(root, 'nested', 'shared.ts'));
  const result = walkProject(root, { envFiles });
  assert.equal(result.truncated, true); assert.ok(!result.files.some(file => file.relPath.endsWith('shared.ts')));
}));
