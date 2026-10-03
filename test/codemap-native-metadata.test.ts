import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeFilesystem } from '../src/native-filesystem.js';
import { walkProject } from '../src/codemap/walk.js';

const INSIDE_PACKAGE = 'inside-metadata-package';
const INSIDE_ENV = 'SWFTE_INSIDE_METADATA_NAME';
const OUTSIDE_PACKAGE = 'outside-unique-metadata-package';
const OUTSIDE_ENV = 'SWFTE_OUTSIDE_UNIQUE_METADATA_NAME';
const envFiles = { secret: ['dot-env', 'dot-env.*'], names: ['dot-env.example'] };

function fixture(run: (root: string, outside: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codemap-native-metadata-')));
  const root = join(base, 'project'), outside = join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(join(root, 'nested'));
  fs.writeFileSync(join(root, 'nested', 'app.ts'), 'export const INSIDE = 1;');
  fs.writeFileSync(join(root, 'nested', 'package.json'), JSON.stringify({ name: INSIDE_PACKAGE }));
  fs.writeFileSync(join(root, 'nested', 'dot-env.example'), INSIDE_ENV + '=inside-private-value');
  fs.writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: OUTSIDE_PACKAGE }));
  fs.writeFileSync(join(outside, 'dot-env.example'), OUTSIDE_ENV + '=outside-private-value');
  try { run(root, outside); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test('actual native nested package and env names project legitimate metadata', () => fixture(root => {
  const result = walkProject(root, { envFiles });
  assert.deepEqual(result.packages, [{ dir: 'nested', pkgId: INSIDE_PACKAGE }]);
  assert.deepEqual(result.envExampleNames, [INSIDE_ENV]);
  assert.deepEqual(result.files.map(file => file.relPath), ['nested/app.ts']);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
  assert.ok(!JSON.stringify(result).includes(OUTSIDE_PACKAGE));
  assert.ok(!JSON.stringify(result).includes(OUTSIDE_ENV));
  assert.ok(!JSON.stringify(result).includes('inside-private-value'));
  assert.ok(!JSON.stringify(result).includes('outside-private-value'));
}));

for (const metadata of ['package.json', 'dot-env.example']) {
  test('actual late parent swap before native ' + metadata + ' read refuses outside metadata', () => fixture((root, outside) => {
    const relative = 'nested/' + metadata;
    const realRead = NativeFilesystem.prototype.read;
    let reached = false;
    const observe = mock.method(NativeFilesystem.prototype, 'read', function(this: NativeFilesystem, rel: string, cap?: number) {
      if (rel === relative && !reached) {
        reached = true;
        fs.renameSync(join(root, 'nested'), join(root, 'retained'));
        fs.symlinkSync(outside, join(root, 'nested'));
      }
      return realRead.call(this, rel, cap);
    });
    try {
      const result = walkProject(root, { envFiles });
      assert.equal(reached, true, 'the swap must precede the actual target metadata read');
      assert.equal(result.truncated, true);
      assert.ok(result.warnings.some(warning => warning === relative + ': enumerated metadata unreadable; scan incomplete.'));
      assert.ok(!result.packages.some(pkg => pkg.pkgId === OUTSIDE_PACKAGE));
      assert.ok(!result.envExampleNames.includes(OUTSIDE_ENV));
      const projected = JSON.stringify(result);
      assert.ok(!projected.includes(OUTSIDE_PACKAGE));
      assert.ok(!projected.includes(OUTSIDE_ENV));
      assert.ok(!projected.includes('inside-private-value'));
      assert.ok(!projected.includes('outside-private-value'));
      assert.equal(fs.readFileSync(join(outside, 'package.json'), 'utf8'), JSON.stringify({ name: OUTSIDE_PACKAGE }));
      assert.equal(fs.readFileSync(join(outside, 'dot-env.example'), 'utf8'), OUTSIDE_ENV + '=outside-private-value');
    } finally { observe.mock.restore(); }
  }));
}
