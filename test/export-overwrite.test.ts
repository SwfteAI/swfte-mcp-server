import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { codeTools } from '../src/tools/code.js';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

/**
 * swfte_export_src overwrite:true replaces a previous export. The new export is unpacked and validated in a
 * sibling directory and swapped in by rename, so a zip that is refused leaves the previous export untouched.
 */
let root: string, previous: string;
beforeEach(() => {
  previous = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-export-swap-')));
  writeFileSync(join(root, 'package.json'), '{}');
  process.chdir(root);
  mkdirSync(join(root, 'source'));
  writeFileSync(join(root, 'source', '.swfte-export.json'), JSON.stringify({ writtenBy: 'swfte_export_src' }));
  writeFileSync(join(root, 'source', 'user.txt'), 'local edits to the previous export');
});
afterEach(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true }); });

const exportTool = codeTools.find(tool => tool.name === 'swfte_export_src')!;
const CREDENTIAL = 'pat_TESTCREDENTIAL0000';
const config = loadConfig({ SWFTE_PAT: CREDENTIAL, SWFTE_TELEMETRY: '0' });
const bytes = (text: string) => new TextEncoder().encode(text);
const zipOf = (entries: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, bytes(text)])));
const GOOD = { 'Cargo.toml': '[package]\nname="example"\n', 'src/main.rs': 'fn main() {}\n' };

function run(archive: Uint8Array, input: Record<string, unknown> = {}): Promise<any> {
  const client = Object.assign(new SwfteClient(config), { getBinary: async () => ({ bytes: archive, headers: {} }) });
  return exportTool.execute(exportTool.inputSchema.parse({ workflowId: 'wf_1', destDir: 'source', overwrite: true, ...input }),
    { client, config, localFilesystem: true }) as Promise<any>;
}
function assertPreviousExportIntact() {
  assert.equal(readFileSync(join(root, 'source', 'user.txt'), 'utf8'), 'local edits to the previous export');
  assert.equal(existsSync(join(root, 'source', '.swfte-export.json')), true);
  assert.equal(existsSync(join(root, 'source', 'Cargo.toml')), false, 'nothing of the refused export may land in the old directory');
  assert.deepEqual(readdirSync(root).sort(), ['package.json', 'source'], 'no staging or backup directory may be left behind');
}

test('overwrite swaps in the new export and leaves no staging or backup directory', async () => {
  const result = await run(zipOf(GOOD));
  assert.deepEqual(result.files, ['Cargo.toml', 'src/main.rs']);
  assert.equal(existsSync(join(root, 'source', 'user.txt')), false);
  assert.equal(readFileSync(join(root, 'source', 'Cargo.toml'), 'utf8'), GOOD['Cargo.toml']);
  assert.equal(JSON.parse(readFileSync(join(root, 'source', '.swfte-export.json'), 'utf8')).writtenBy, 'swfte_export_src');
  assert.deepEqual(readdirSync(root).sort(), ['package.json', 'source']);
});

test('a zip entry holding a secret-shaped token leaves the previous export intact', async () => {
  await assert.rejects(run(zipOf({ ...GOOD, 'src/leak.rs': 'const KEY: &str = "sk_live_ABCDEFGH12345678";\n' })), /secret-shaped/);
  assertPreviousExportIntact();
});

test('a zip entry holding the configured credential leaves the previous export intact', async () => {
  await assert.rejects(run(zipOf({ ...GOOD, 'src/leak.rs': `// ${CREDENTIAL}\n` })), /configured Swfte credential/);
  assertPreviousExportIntact();
});

test('a deny-listed entry leaves the previous export intact', async () => {
  await assert.rejects(run(zipOf({ ...GOOD, '.env': 'A=1\n' })), /Refusing/);
  assertPreviousExportIntact();
});

test('a path-escaping entry leaves the previous export intact', async () => {
  await assert.rejects(run(zipOf({ ...GOOD, '../escape.txt': 'x' })), /Refusing|outside/);
  assertPreviousExportIntact();
  assert.equal(existsSync(join(root, '..', 'escape.txt')), false);
});

test('an unreadable archive leaves the previous export intact', async () => {
  await assert.rejects(run(bytes('this is not a zip archive')));
  assertPreviousExportIntact();
});

test('a directory without the export marker is still never replaced', async () => {
  rmSync(join(root, 'source', '.swfte-export.json'));
  await assert.rejects(run(zipOf(GOOD)), /not created by swfte_export_src/);
  assert.equal(readFileSync(join(root, 'source', 'user.txt'), 'utf8'), 'local edits to the previous export');
  assert.deepEqual(readdirSync(root).sort(), ['package.json', 'source']);
});
