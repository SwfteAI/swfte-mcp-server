import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseVersion } from '../scripts/check-release-version.mjs';
test('release version gate checks tag before publishing and permits branch verification', () => {
  assert.doesNotThrow(() => assertReleaseVersion('refs/tags/v0.2.0', '0.2.0'));
  assert.doesNotThrow(() => assertReleaseVersion('refs/heads/master', '0.2.0'));
  assert.throws(() => assertReleaseVersion('refs/tags/v9.9.9', '0.2.0'), /does not match/);
});
