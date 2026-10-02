import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packTwinBundle, requireNoProductionSecret } from '../src/twins/intake.js';

function fixture(run: (root: string, git: (args: string[]) => Buffer) => void, license = 'MIT') {
  const old = process.cwd(); const root = realpathSync(mkdtempSync(join(tmpdir(), 'twin-intake-test-')));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    process.chdir(root); git(['init', '-q']); git(['config', 'user.name', 'Twin Test']); git(['config', 'user.email', 'twin@example.invalid']);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reference', license }));
    writeFileSync(join(root, 'app.js'), 'export const reference = true;\n'); git(['add', '.']); git(['commit', '-qm', 'synthetic reference']);
    run(root, git);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
}
test('committed synthetic source packs a genuine verified hash-bound Git bundle', () => fixture((root, git) => {
  const packed = packTwinBundle(root); assert.equal(packed.snapshotHash, 'sha256:' + createHash('sha256').update(packed.bytes).digest('hex'));
  const bundle = join(root, 'verification.bundle'); writeFileSync(bundle, packed.bytes); git(['bundle', 'verify', bundle]);
  assert.deepEqual(packed.commitShas, [git(['rev-parse', 'HEAD']).toString().trim()]);
}));
test('dirty or untracked source refuses before packing an incomplete snapshot', () => fixture((root) => {
  writeFileSync(join(root, 'app.js'), 'changed'); assert.throws(() => packTwinBundle(root), /UNCOMMITTED_SOURCE_REFUSED/);
}));
test('deleted historical production credential still refuses a full-history bundle', () => fixture((root, git) => {
  writeFileSync(join(root, 'old-config.txt'), 'sk_' + 'live_' + 'A'.repeat(24)); git(['add', '.']); git(['commit', '-qm', 'historical credential fixture']);
  rmSync(join(root, 'old-config.txt')); git(['add', '-u']); git(['commit', '-qm', 'delete credential fixture']);
  assert.throws(() => packTwinBundle(root), /PRODUCTION_CREDENTIAL/);
}));
test('credential in a commit message cannot escape history hygiene', () => fixture((root, git) => {
  writeFileSync(join(root, 'app.js'), 'export const reference = 2;'); git(['add', '.']); git(['commit', '-qm', 'sk_' + 'live_' + 'B'.repeat(24)]);
  assert.throws(() => packTwinBundle(root), /PRODUCTION_CREDENTIAL/);
}));
test('credential in a lightweight ref refuses while clean local refs remain packable', () => {
  for (const kind of ['tag', 'branch']) fixture((root, git) => {
    const value = 'sk_' + 'live_' + 'R'.repeat(24);
    const name = 'fixture/' + value;
    git([kind, name]);
    assert.throws(() => packTwinBundle(root), error => error instanceof Error && error.message === 'PRODUCTION_CREDENTIAL');
    git([kind, '-d', name]);
    git([kind, 'fixture/clean-reference']);
    const packed = packTwinBundle(root);
    assert.equal(packed.snapshotHash, 'sha256:' + createHash('sha256').update(packed.bytes).digest('hex'));
    assert.equal(Buffer.from(packed.bytes).includes(Buffer.from(value)), false);
    assert.equal(Buffer.from(packed.bytes).includes(Buffer.from('fixture/clean-reference')), true);
  });
});
test('annotated tag messages are scanned with a real clean annotated-tag control', () => fixture((root, git) => {
  git(['tag', '-a', 'fixture-tag', '-m', 'sk_' + 'live_' + 'T'.repeat(24)]);
  assert.throws(() => packTwinBundle(root), /PRODUCTION_CREDENTIAL/);
  git(['tag', '-d', 'fixture-tag']); git(['tag', '-a', 'fixture-tag', '-m', 'synthetic annotated reference']);
  const packed = packTwinBundle(root);
  const bundle = join(root, '.git', 'verified-tag.bundle'); writeFileSync(bundle, packed.bytes); git(['bundle', 'verify', bundle]);
}));
test('credential in commit author metadata cannot escape the uploaded object scan', () => fixture((root, git) => {
  git(['config', 'user.name', 'sk_' + 'live_' + 'U'.repeat(24)]);
  writeFileSync(join(root, 'app.js'), 'export const reference = 3;'); git(['add', '.']); git(['commit', '-qm', 'synthetic metadata fixture']);
  assert.throws(() => packTwinBundle(root), error => error instanceof Error && error.message === 'PRODUCTION_CREDENTIAL');
}));
test('known provider credential families refuse even after the secret-bearing blob was deleted', () => {
  const values = ['AS' + 'IA' + 'A'.repeat(16), 'gh' + 'p_' + 'B'.repeat(32), 'sk-' + 'proj-' + 'C'.repeat(24),
    'sk-' + 'ant-api03-' + 'D'.repeat(24), '-----BEGIN ' + 'DSA ' + 'PRIVATE KEY-----',
    'https://' + 'owner:' + 'E'.repeat(24) + '@example.invalid/'];
  for (const value of values) fixture((root, git) => {
    writeFileSync(join(root, 'old-config.txt'), value); git(['add', '.']); git(['commit', '-qm', 'synthetic history fixture']);
    rmSync(join(root, 'old-config.txt')); git(['add', '-u']); git(['commit', '-qm', 'delete synthetic history fixture']);
    assert.throws(() => packTwinBundle(root), error => error instanceof Error && error.message === 'PRODUCTION_CREDENTIAL');
  });
});
test('declared test-key source remains packable and hash bound', () => fixture((root, git) => {
  writeFileSync(join(root, 'test-config.txt'), 'api_key=sk_' + 'test_' + 'F'.repeat(32));
  git(['add', '.']); git(['commit', '-qm', 'declared test credential fixture']);
  const packed = packTwinBundle(root);
  assert.equal(packed.snapshotHash, 'sha256:' + createHash('sha256').update(packed.bytes).digest('hex'));
}));
test('historical source symlink is refused even after deletion', () => fixture((root, git) => {
  symlinkSync('app.js', join(root, 'source-link')); git(['add', '.']); git(['commit', '-qm', 'link fixture']);
  rmSync(join(root, 'source-link')); git(['add', '-u']); git(['commit', '-qm', 'delete link fixture']);
  assert.throws(() => packTwinBundle(root), /SOURCE_LINK_REFUSED/);
}));
test('unsupported source license refuses the actual bundle boundary', () => fixture(root => {
  assert.throws(() => packTwinBundle(root), /SOURCE_LICENSE_REFUSED/);
}, 'Elastic-2.0'));
test('an unrelated permissive manifest cannot excuse an unknown nested license', () => fixture((root, git) => {
  mkdirSync(join(root, 'imported')); writeFileSync(join(root, 'imported', 'LICENCE.txt'), 'Confidential proprietary source. All use requires separate permission.');
  git(['add', '.']); git(['commit', '-qm', 'nested unrecognized license fixture']);
  assert.throws(() => packTwinBundle(root), /SOURCE_LICENSE_REFUSED/);
}));
test('recognized nested permissive SPDX license remains hash-bound and packable', () => fixture((root, git) => {
  mkdirSync(join(root, 'imported')); writeFileSync(join(root, 'imported', 'LICENCE.txt'), 'SPDX-License-Identifier: MIT\n');
  git(['add', '.']); git(['commit', '-qm', 'nested permissive license fixture']);
  const packed = packTwinBundle(root);
  assert.equal(packed.snapshotHash, 'sha256:' + createHash('sha256').update(packed.bytes).digest('hex'));
}));
test('every declared SPDX license must be permissive even after an accepted first declaration', () => fixture((root, git) => {
  mkdirSync(join(root, 'imported')); writeFileSync(join(root, 'imported', 'LICENSE'), 'SPDX-License-Identifier: MIT\nSPDX-License-Identifier: AGPL-3.0\n');
  git(['add', '.']); git(['commit', '-qm', 'multiple declared license fixture']);
  assert.throws(() => packTwinBundle(root), /SOURCE_LICENSE_REFUSED/);
}));
test('imported source comments cannot borrow an unrelated permissive package manifest', () => {
  for (const source of ['// SPDX-License-Identifier: AGPL-3.0-only\n', '/* SPDX-License-Identifier: LicenseRef-Proprietary */\n',
    '# SPDX-License-Identifier: BUSL-1.1\n', '<!-- SPDX-License-Identifier: Elastic-2.0 -->\n']) fixture((root, git) => {
    mkdirSync(join(root, 'imported')); writeFileSync(join(root, 'imported', 'source.txt'), source);
    git(['add', '.']); git(['commit', '-qm', 'synthetic imported source license fixture']);
    assert.throws(() => packTwinBundle(root), error => error instanceof Error && error.message === 'SOURCE_LICENSE_REFUSED');
  });
});
test('deleted historical source SPDX still refuses the actual full bundle boundary', () => fixture((root, git) => {
  writeFileSync(join(root, 'old-source.js'), '// SPDX-License-Identifier: AGPL-3.0-only\n');
  git(['add', '.']); git(['commit', '-qm', 'synthetic source license history']);
  rmSync(join(root, 'old-source.js')); git(['add', '-u']); git(['commit', '-qm', 'delete historical source']);
  assert.throws(() => packTwinBundle(root), error => error instanceof Error && error.message === 'SOURCE_LICENSE_REFUSED');
}));
test('recognized permissive source comments retain genuine Git bundle verification', () => {
  for (const source of ['// SPDX-License-Identifier: MIT\n', '/* SPDX-License-Identifier: Apache-2.0 */\n',
    '# SPDX-License-Identifier: BSD-3-Clause\n', '<!-- SPDX-License-Identifier: ISC -->\n']) fixture((root, git) => {
    writeFileSync(join(root, 'source.txt'), source); git(['add', '.']); git(['commit', '-qm', 'synthetic permissive source declaration']);
    const packed = packTwinBundle(root);
    assert.equal(packed.snapshotHash, 'sha256:' + createHash('sha256').update(packed.bytes).digest('hex'));
    const bundle = join(root, '.git', 'permissive-source.bundle'); writeFileSync(bundle, packed.bytes); git(['bundle', 'verify', bundle]);
  });
});
test('every source declaration and unsupported SPDX expression is checked', () => {
  for (const source of ['// SPDX-License-Identifier: MIT\n// SPDX-License-Identifier: AGPL-3.0\n',
    '// SPDX-License-Identifier: MIT OR AGPL-3.0\n', '// SPDX-License-Identifier: LicenseRef-Unknown\n']) fixture((root, git) => {
    writeFileSync(join(root, 'source.txt'), source); git(['add', '.']); git(['commit', '-qm', 'synthetic source declaration boundary']);
    assert.throws(() => packTwinBundle(root), /SOURCE_LICENSE_REFUSED/);
  });
});
test('partial clone refuses before a local remote helper can execute', () => fixture((root, git) => {
  const canary = join(root, '.git', 'transport-canary');
  const helpers = join(root, '.git', 'helper-fixture'); mkdirSync(helpers);
  writeFileSync(join(helpers, 'git-remote-twin-canary'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' + JSON.stringify(canary) + ', "executed");\nprocess.exit(1);\n', { mode: 0o755 });
  git(['config', 'core.repositoryformatversion', '1']); git(['config', 'extensions.partialclone', 'origin']);
  git(['config', 'remote.origin.url', 'twin-canary::ignored']); git(['config', 'remote.origin.promisor', 'true']);
  git(['config', 'protocol.twin-canary.allow', 'always']);
  const blob = git(['rev-parse', 'HEAD:app.js']).toString().trim();
  rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = helpers + ':' + originalPath;
    assert.throws(() => packTwinBundle(root), /INCOMPLETE_GIT_HISTORY_REFUSED/);
    assert.equal(existsSync(canary), false);
  } finally { process.env.PATH = originalPath; }
}));
test('shallow graft and alternate histories refuse before incomplete history can pack', () => {
  for (const metadata of ['shallow', 'info/grafts', 'objects/info/http-alternates', 'objects/info/alternates']) fixture(root => {
    writeFileSync(join(root, '.git', metadata), 'history-boundary-fixture\n');
    assert.throws(() => packTwinBundle(root), /INCOMPLETE_GIT_HISTORY_REFUSED/);
  });
});
test('promisor pack metadata refuses even without a partial-clone config key', () => fixture(root => {
  writeFileSync(join(root, '.git', 'objects', 'pack', 'fixture.promisor'), '');
  assert.throws(() => packTwinBundle(root), /INCOMPLETE_GIT_HISTORY_REFUSED/);
}));
test('invalid base ref and paths outside the local launch directory refuse', () => fixture(root => {
  assert.throws(() => packTwinBundle(root, '../branch'), /INVALID_BASE_REF/); assert.throws(() => packTwinBundle('/etc'), /outside the working directory/);
}));
test('source label does not excuse a high-entropy credential and values stay out of errors', () => {
  assert.throws(() => requireNoProductionSecret(Buffer.from('api_key=synthetic_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef')), /PRODUCTION_CREDENTIAL/);
  const token = 'sk_' + 'live_' + 'C'.repeat(24); assert.throws(() => requireNoProductionSecret(Buffer.from(token)), error => error instanceof Error && error.message === 'PRODUCTION_CREDENTIAL');
});
