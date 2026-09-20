import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export function assertReleaseVersion(ref, version) {
  if (ref?.startsWith('refs/tags/') && ref !== `refs/tags/v${version}`)
    throw new Error(`Release tag ${ref} does not match package version ${version}`);
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assertReleaseVersion(process.env.GITHUB_REF, version);
  console.log('RELEASE_VERSION_VERIFIED', version);
}
