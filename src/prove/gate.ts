import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const PG_LEDGER = '# Proving ground\n\n- [ ] PG: the change at this tree state passed the proving ground\n  CHECK: swfte prove verdict --tree HEAD+worktree\n  EXPECT: PROOF_PASS\n';
export interface GateInstallResult { path: string; installed: boolean; mode: 'unchanged'; watchStarted: false }

/** Only the fixed PG ledger is installed. Existing files and Nexus policy are never replaced. */
export async function installProvingGate(path: string): Promise<GateInstallResult> {
  const root = await realpath(resolve(path));
  for (const pieces of [['.nexus'], ['.nexus', 'gates']]) {
    const directory = join(root, ...pieces);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error('Nexus gate directory is not confined to the repository');
    }
  }
  const output = join(root, '.nexus', 'gates', 'proving-ground.md');
  const handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(PG_LEDGER, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  return { path: output, installed: true, mode: 'unchanged', watchStarted: false };
}
