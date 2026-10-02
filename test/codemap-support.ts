import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AssignedSite } from '../src/codemap/fingerprint.js';

export function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-codemap-')));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Codex', '-c', 'user.email=codex@openai.com', 'commit', '--quiet', '-m', 'fixture']]) {
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  }
  return root;
}
export function assigned(path: string, line = 1, language: 'typescript' | 'python' | 'java' = 'typescript', alias: string | null = null): AssignedSite {
  return { id: 'cs_' + '1'.repeat(24), site: { relPath: path, line, symbol: '<module>', language, sdk: language === 'typescript' ? 'node' : language,
    category: 'managed', managed: 'typed-client', op: 'run', artifact: { kind: 'workflow', id: 'wf_a', unresolved: false,
      alias, pinnedVersion: null }, contractHash: null, inputKeys: ['question'], outputKeys: ['answer'], detector: 'fixture' } };
}
