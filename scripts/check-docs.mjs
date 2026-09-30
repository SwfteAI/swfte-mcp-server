// node scripts/check-docs.mjs — release-doc presence and content checks. Prints DOCS_OK only when all hold.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => (existsSync(resolve(root, f)) ? readFileSync(resolve(root, f), 'utf8') : null);
const problems = [];
const need = (file, re, why) => {
  const t = read(file);
  if (t === null) return problems.push(`${file} is missing`);
  if (!re.test(t)) problems.push(`${file}: ${why}`);
};
const forbid = (file, re, why) => {
  const t = read(file);
  if (t !== null && re.test(t)) problems.push(`${file}: ${why}`);
};
need('SECURITY.md', /security@swfte\.com/, 'no reporting address');
need('CHANGELOG.md', /^## 0\.2\.0 - 2026-09-30$/m, 'no 0.2.0 heading');
need('docs/RELEASING.md', /NPM_TOKEN/, 'does not tell the owner about NPM_TOKEN');
need('README.md', /^### Security model$/m, 'no Security model section');
need('README.md', /^## Releases$/m, 'no Releases section');
forbid('README.md', /Zero-config security/, 'still claims zero-config security');
forbid('README.md', /Repository secrets required: `NPM_TOKEN`/, 'stale Releases text');
need('Dockerfile', /npm ci/, 'no npm ci');
need('Dockerfile', /npm prune --omit=dev/, 'no prune');
need('Dockerfile', /FROM node:22-alpine@sha256:[0-9a-f]{64} AS runtime/, 'runtime base not digest-pinned');
forbid('Dockerfile', /npm install/, 'npm install in Dockerfile');
const dupes = (read('README.md') ?? '').match(/^## Development$/gm) ?? [];
if (dupes.length > 1) problems.push('README has duplicate "## Development" headings');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('DOCS_OK');
