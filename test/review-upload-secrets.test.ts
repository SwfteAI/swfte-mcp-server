import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { loadConfig } from '../src/config.js';
import { ConfinedWriter } from '../src/fsguard.js';
import { fileTools } from '../src/tools/files.js';
import { codeTools } from '../src/tools/code.js';

let root: string, previous: string;
beforeEach(() => { previous = process.cwd(); root = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-content-'))); process.chdir(root); });
afterEach(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true }); });
const upload = fileTools.find((item) => item.name === 'swfte_files_upload')!;
const sync = codeTools.find((item) => item.name === 'swfte_sync_src')!;
const config = (credential = 'pat_configured_fixture') => credential.startsWith('pat_')
  ? loadConfig({ SWFTE_PAT: credential, SWFTE_TELEMETRY: '0' })
  : loadConfig({ SWFTE_API_KEY: credential, SWFTE_TELEMETRY: '0' });
function context(credential?: string) {
  const calls: Array<{ path: string; form: FormData; options: unknown }> = [];
  return { calls, config: config(credential), localFilesystem: true, client: {
    postMultipart: async (path: string, form: FormData, options: unknown) => {
      calls.push({ path, form, options }); return { id: 'safe-file', hasChanges: false };
    },
  } as never };
}

test('uploadPermittedFileRejectsEveryAcceptedCredentialLengthBeforeOutbound', async () => {
  // Config actually accepts these prefixes with no minimum suffix length.
  for (const credential of ['sk_', 'sk_a', 'sk_ab', 'sk_abc', 'sk_abcd', 'pat_', 'pat_a', 'pat_ab', 'pat_abc', 'pat_LONG_SYNTHETIC']) {
    const ctx = context(credential);
    const content = `public notes\ncredential=${credential}\n`;
    writeFileSync(join(root, 'notes.txt'), content);
    await assert.rejects(upload.execute({ path: 'notes.txt' }, ctx), /configured Swfte credential/);
    assert.equal(ctx.calls.length, 0, 'a refused safe-path file must not reach multipart transport');
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), content);
  }
});

test('uploadPermittedBinaryRejectsKnownAndSecretShapedContentBeforeOutbound', async () => {
  for (const secret of ['pat_private_fixture', 'ghp_SYNTHETIC01234567890123456789']) {
    const ctx = context(secret.startsWith('pat_') ? secret : undefined);
    const bytes = Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(secret), Buffer.from([0x80, 0x00])]);
    writeFileSync(join(root, 'public.bin'), bytes);
    await assert.rejects(upload.execute({ path: 'public.bin' }, ctx), /credential|secret-shaped/);
    assert.equal(ctx.calls.length, 0);
    assert.deepEqual(readFileSync(join(root, 'public.bin')), bytes);
  }
});

test('safeUploadPreservesExactTextAndBinaryBytesAndWorkspace', async () => {
  for (const bytes of [Buffer.from('ordinary public notes\n'), Buffer.from([0xff, 0x00, 0x01, 0xfe, 0x80])]) {
    const ctx = context();
    writeFileSync(join(root, 'public.bin'), bytes);
    const result: any = await upload.execute({ path: 'public.bin', workspaceId: 'workspace-safe', name: 'public.bin' }, ctx);
    assert.equal(result.id, 'safe-file');
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0]!.path, '/api/v2/files/upload');
    assert.deepEqual(ctx.calls[0]!.options, { workspaceId: 'workspace-safe' });
    const blob = ctx.calls[0]!.form.get('file') as Blob;
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  }
});

function workspace(content: string) {
  mkdirSync(join(root, 'workspace', 'src'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'swfte-blueprint.json'), '{"workflowId":"safe","steps":[]}');
  writeFileSync(join(root, 'workspace', 'src', 'main.rs'), content);
}

test('syncPermittedSourceRejectsShortAndShapedSecretsBeforeAnyOutbound', async () => {
  for (const secret of ['pat_', 'pat_a', 'sk_', 'sk_abcd', 'ghp_SYNTHETIC01234567890123456789']) {
    const ctx = context(secret.startsWith('ghp_') ? undefined : secret);
    const source = `fn main() { let fixture = "${secret}"; }\n`;
    workspace(source);
    await assert.rejects(sync.execute({ workflowId: 'safe', srcDir: 'workspace', apply: true }, ctx), /credential|secret-shaped/);
    assert.equal(ctx.calls.length, 0);
    assert.equal(readFileSync(join(root, 'workspace', 'src', 'main.rs'), 'utf8'), source);
  }
});

test('uploadAndSyncRejectEscapedAndMixedPercentLiteralsBeforeOutbound', async () => {
  const credential = 'pat_a/"\\Z';
  const mixed = encodeURIComponent(credential).replace('%2F', '%2f');
  assert.ok(mixed.includes('%2f') && mixed.includes('%5C'), 'exercise mixed percent hex while retaining ordinary literal case');
  for (const encoded of [JSON.stringify(credential).slice(1, -1), mixed]) {
    const ctx = context(credential), content = `public note\nfixture=${encoded}\n`;
    writeFileSync(join(root, 'notes.txt'), content);
    await assert.rejects(upload.execute({ path: 'notes.txt' }, ctx), /configured Swfte credential/);
    assert.equal(ctx.calls.length, 0);
    workspace(content);
    await assert.rejects(sync.execute({ workflowId: 'safe', srcDir: 'workspace', apply: true }, ctx), /configured Swfte credential/);
    assert.equal(ctx.calls.length, 0);
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), content);
  }
  const ctx = context(credential), publicContent = 'public URL https://example.test/public%2Froute\n';
  writeFileSync(join(root, 'notes.txt'), publicContent);
  await upload.execute({ path: 'notes.txt' }, ctx);
  workspace(publicContent);
  await sync.execute({ workflowId: 'safe', srcDir: 'workspace' }, ctx);
  assert.equal(ctx.calls.length, 2, 'unrelated escaped public values remain uploadable');
});

test('safeSyncSendsExactPermittedWorkspaceAndKeepsDefaultDryRun', async () => {
  const ctx = context();
  const source = 'fn main() { println!("public"); }\n';
  workspace(source);
  const result: any = await sync.execute({ workflowId: 'wf/safe', srcDir: 'workspace' }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0]!.path, '/v2/workflows/execution/wf%2Fsafe/sync-from-code');
  assert.deepEqual(ctx.calls[0]!.options, { query: { dryRun: true }, timeoutMs: 180_000 });
  const zip = new Uint8Array(await (ctx.calls[0]!.form.get('workspace') as Blob).arrayBuffer());
  const entries = unzipSync(zip);
  assert.deepEqual(Object.keys(entries).sort(), ['src/main.rs', 'swfte-blueprint.json']);
  assert.equal(new TextDecoder().decode(entries['src/main.rs']), source);
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.hasChanges, false);
});

test('confinedWriterRejectsShortOpaqueConfiguredLiteralWithoutPartialWrites', () => {
  for (const secret of ['~', 'r5X', 'pat_', 'sk_ab']) {
    const writer = new ConfinedWriter({ forbidden: [secret] });
    writer.create(writer.resolve('safe.ts'), 'export const publicValue = 1;\n');
    writer.create(writer.resolve('private.ts'), `export const fixture = "${secret}";\n`);
    assert.throws(() => writer.commit(), /configured Swfte credential/);
    assert.throws(() => readFileSync(join(root, 'safe.ts')), { code: 'ENOENT' });
    assert.throws(() => readFileSync(join(root, 'private.ts')), { code: 'ENOENT' });
  }
});
