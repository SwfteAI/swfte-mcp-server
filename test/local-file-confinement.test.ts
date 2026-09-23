/**
 * Local-file tools on a server a model drives (black-hat C2, H2, H7).
 *
 * The model picks the paths, and text it reads can steer that pick. So:
 *   - hosted over HTTP, every local-file tool refuses — the server's disk is not
 *     the caller's project, and `/proc/self/environ` holds the OAuth secret;
 *   - locally, paths are confined under the working directory: no absolute
 *     paths elsewhere, no `../` traversal, no symlink escapes, no /proc;
 *   - a knowledge document name never becomes a filesystem path;
 *   - swfte_export_src overwrite deletes only a directory it wrote itself.
 *
 * Every case asserts on the side effect that matters (no API call made, no file
 * read, the victim directory still there), not only on the error text.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createHttpHandler } from '../src/http.js';
import { EXPORT_MARKER } from '../src/tools/code.js';

const config = () => loadConfig({ SWFTE_PAT: 'pat_test', SWFTE_TOOLS: 'all' } as never);

/** A client that records every call. Any upload means the guard let a file through. */
function fakeClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const uploads: Array<{ name: string; bytes: string }> = [];
  const client = {
    calls,
    uploads,
    async postMultipart(path: string, form: FormData) {
      calls.push({ method: 'postMultipart', args: [path] });
      const f = form.get('file') ?? form.get('workspace');
      if (f && typeof f !== 'string') uploads.push({ name: (f as File).name, bytes: await (f as Blob).text() });
      return { id: 'file-1', hasChanges: false, modifiedSteps: [] };
    },
    async request(opts: { method: string; path: string }) {
      calls.push({ method: 'request', args: [opts.method, opts.path] });
      return { id: 'ds-1' };
    },
    async getBinary(path: string) {
      calls.push({ method: 'getBinary', args: [path] });
      const zip = zipSync({ 'Cargo.toml': new TextEncoder().encode('[package]\n'), 'swfte-blueprint.json': new TextEncoder().encode('{}') });
      return { bytes: zip, headers: {} };
    },
    async withDeadline<T>(_d: number, fn: () => Promise<T>) {
      return fn();
    },
  };
  return client;
}

async function call(server: any, name: string, args: Record<string, unknown>) {
  const handler = server._requestHandlers.get('tools/call');
  const res = await handler({ method: 'tools/call', params: { name, arguments: args } }, {});
  return { isError: Boolean(res.isError), text: String(res.content?.[0]?.text ?? '') };
}

const local = (client: ReturnType<typeof fakeClient>) => buildServer({ config: config(), resolveClient: () => client as never });
const hosted = (client: ReturnType<typeof fakeClient>) =>
  buildServer({ config: config(), resolveClient: () => client as never, localFilesystem: false });

let project: string;
let outside: string;
const originalCwd = process.cwd();

before(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-confine-project-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-confine-outside-')));
  writeFileSync(join(outside, 'secret.txt'), 'TOP-SECRET');
  writeFileSync(join(project, 'notes.md'), '# notes\n');
  symlinkSync(join(outside, 'secret.txt'), join(project, 'link-to-secret.txt'));
  symlinkSync(outside, join(project, 'link-to-outside'));
  process.chdir(project);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('hosted mode refuses every local-file tool', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['swfte_files_upload', { path: 'notes.md' }],
    ['swfte_knowledge_build', { name: 'kb', documents: [{ name: 'env', path: '/proc/self/environ' }] }],
    ['swfte_knowledge_build', { name: 'kb', documents: [{ name: 'notes', path: 'notes.md' }] }],
    ['swfte_export_src', { workflowId: 'wf', destDir: 'out', overwrite: true }],
    ['swfte_sync_src', { workflowId: 'wf', srcDir: '.' }],
    ['swfte_preflight', { manifestPath: 'manifest.json' }],
    ['swfte_preflight', { manifest: { components: [{ key: 'a', kind: 'workflow', id: 'x' }], sourceDirs: ['.'] } }],
    ['swfte_preflight_manifest', { specPath: 'spec.json' }],
    ['swfte_preflight_manifest', { statePath: 'state.json' }],
    ['swfte_solution_build', { plan: { name: 'p', components: [{ key: 'd', kind: 'dataset', knowledge: { name: 'kb', documents: [{ name: 'e', path: '/proc/self/environ' }] } }] }, dryRun: true }],
  ];
  for (const [tool, args] of cases) {
    test(`hosted ${tool} (${Object.keys(args).join(',')}) is refused before any API call or disk access`, async () => {
      const client = fakeClient();
      const res = await call(hosted(client), tool, args);
      assert.equal(res.isError, true, `${tool} was not refused: ${res.text.slice(0, 200)}`);
      assert.match(res.text, /hosted MCP server/);
      assert.deepEqual(client.calls, [], `${tool} reached the API before refusing`);
    });
  }

  test('hosted knowledge_build with inline text still works (content passed inline instead of a path)', async () => {
    const client = fakeClient();
    const res = await call(hosted(client), 'swfte_knowledge_build', { name: 'kb', documents: [{ name: 'notes', text: 'hello' }], waitMs: 10_000 });
    assert.ok(client.uploads.some((u) => u.name === 'notes' && u.bytes === 'hello'), res.text.slice(0, 300));
  });

  test('the HTTP transport itself runs tools in hosted mode and rejects a /proc/self/environ read', async () => {
    const client = fakeClient();
    const handle = createHttpHandler({ config: config(), resolveClient: () => client as never });
    const res = await handle(
      new Request('https://mcp.example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'swfte_knowledge_build', arguments: { name: 'kb', documents: [{ name: 'env', path: '/proc/self/environ' }] } },
        }),
      })
    );
    const body = await res.text();
    assert.match(body, /hosted MCP server/, body.slice(0, 400));
    assert.deepEqual(client.calls, []);
  });
});

describe('local (stdio) mode confines paths under the working directory', () => {
  // Resolved lazily: `outside` exists only once `before` has run. The `../` one names the
  // real secret file, so without the guard the read would succeed.
  const escapes: Array<[string, () => string]> = [
    ['/proc/self/environ', () => '/proc/self/environ'],
    ['../<outside>/secret.txt', () => join(relative(project, outside), 'secret.txt')],
    ['../../etc/passwd', () => '../../etc/passwd'],
    ['link-to-secret.txt', () => 'link-to-secret.txt'],
    ['link-to-outside/secret.txt', () => 'link-to-outside/secret.txt'],
  ];
  for (const [label, path] of escapes) {
    test(`files_upload refuses traversal / escape path ${label}`, async () => {
      const client = fakeClient();
      const res = await call(local(client), 'swfte_files_upload', { path: path() });
      assert.equal(res.isError, true, res.text);
      assert.deepEqual(client.uploads, []);
    });
    test(`knowledge_build refuses traversal / escape path ${label} before creating a dataset`, async () => {
      const client = fakeClient();
      const res = await call(local(client), 'swfte_knowledge_build', { name: 'kb', documents: [{ name: 'd', path: path() }] });
      assert.equal(res.isError, true, res.text);
      assert.deepEqual(client.calls, []);
    });
  }

  test('files_upload refuses an absolute path outside the project', async () => {
    const client = fakeClient();
    const res = await call(local(client), 'swfte_files_upload', { path: join(outside, 'secret.txt') });
    assert.equal(res.isError, true);
    assert.match(res.text, /outside the working directory/);
    assert.deepEqual(client.uploads, []);
  });

  test('files_upload still uploads a file inside the project', async () => {
    const client = fakeClient();
    const res = await call(local(client), 'swfte_files_upload', { path: 'notes.md' });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(client.uploads, [{ name: 'notes.md', bytes: '# notes\n' }]);
  });

  test('sync_src refuses a srcDir outside the project (../ traversal) and never uploads it', async () => {
    const client = fakeClient();
    const res = await call(local(client), 'swfte_sync_src', { workflowId: 'wf', srcDir: relative(project, outside) });
    assert.equal(res.isError, true);
    assert.deepEqual(client.uploads, []);
  });

  test('sync_src skips symlinks inside the workspace instead of following them out', async () => {
    const ws = join(project, 'ws-sync');
    mkdirSync(ws);
    writeFileSync(join(ws, 'swfte-blueprint.json'), '{}');
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'leak.txt'));
    const client = fakeClient();
    const res = await call(local(client), 'swfte_sync_src', { workflowId: 'wf', srcDir: 'ws-sync' });
    assert.equal(res.isError, false, res.text);
    assert.equal(client.uploads.length, 1);
    assert.ok(!client.uploads[0]!.bytes.includes('TOP-SECRET'), 'symlinked secret was zipped into the upload');
  });

  test('preflight manifestPath traversal is refused', async () => {
    const client = fakeClient();
    const res = await call(local(client), 'swfte_preflight', { manifestPath: join(relative(project, outside), 'secret.txt') });
    assert.equal(res.isError, true);
    assert.match(res.text, /outside the working directory/);
  });
});

describe('knowledge document names never become filesystem paths', () => {
  for (const name of ['../../../../tmp/pwned', 'a/b', 'a\\b', '..', 'x\u0000y']) {
    test(`knowledge_build rejects document name ${JSON.stringify(name)} (traversal) and writes nothing`, async () => {
      const client = fakeClient();
      const res = await call(local(client), 'swfte_knowledge_build', { name: 'kb', documents: [{ name, text: 'payload' }] });
      assert.equal(res.isError, true, res.text);
      assert.deepEqual(client.calls, []);
    });
  }
});

describe('swfte_export_src overwrite only deletes a directory it owns', () => {
  beforeEach(() => {
    rmSync(join(project, 'victim'), { recursive: true, force: true });
    rmSync(join(project, 'exported'), { recursive: true, force: true });
  });

  test('export_src overwrite refuses to delete a directory it did not create', async () => {
    mkdirSync(join(project, 'victim'));
    writeFileSync(join(project, 'victim', 'precious.txt'), 'keep me');
    const client = fakeClient();
    const res = await call(local(client), 'swfte_export_src', { workflowId: 'wf', destDir: 'victim', overwrite: true });
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /not created by swfte_export_src/);
    assert.equal(readFileSync(join(project, 'victim', 'precious.txt'), 'utf8'), 'keep me');
  });

  test('export_src overwrite refuses to delete outside the project (../ traversal)', async () => {
    const client = fakeClient();
    const res = await call(local(client), 'swfte_export_src', { workflowId: 'wf', destDir: relative(project, outside), overwrite: true });
    assert.equal(res.isError, true);
    assert.ok(existsSync(join(outside, 'secret.txt')), 'directory outside the project was deleted');
    assert.deepEqual(client.calls, [], 'downloaded before refusing');
  });

  test('export_src overwrite refuses to delete the working directory itself', async () => {
    const client = fakeClient();
    const res = await call(local(client), 'swfte_export_src', { workflowId: 'wf', destDir: '.', overwrite: true });
    assert.equal(res.isError, true);
    assert.ok(existsSync(join(project, 'notes.md')));
  });

  test('export_src overwrite refuses a symlinked destDir pointing outside', async () => {
    const client = fakeClient();
    const res = await call(local(client), 'swfte_export_src', { workflowId: 'wf', destDir: 'link-to-outside', overwrite: true });
    assert.equal(res.isError, true);
    assert.ok(existsSync(join(outside, 'secret.txt')));
  });

  test('export_src writes a marker, and a later overwrite of its own export succeeds', async () => {
    const client = fakeClient();
    const first = await call(local(client), 'swfte_export_src', { workflowId: 'wf', destDir: 'exported' });
    assert.equal(first.isError, false, first.text);
    assert.ok(existsSync(join(project, 'exported', EXPORT_MARKER)));
    writeFileSync(join(project, 'exported', 'stale.rs'), '');
    const second = await call(local(client), 'swfte_export_src', { workflowId: 'wf', destDir: 'exported', overwrite: true });
    assert.equal(second.isError, false, second.text);
    assert.ok(!existsSync(join(project, 'exported', 'stale.rs')), 'owned export was not cleared');
    assert.ok(existsSync(join(project, 'exported', 'Cargo.toml')));
  });
});
