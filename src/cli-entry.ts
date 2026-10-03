import { main } from './cli.js';
import { fatalLine } from './fsguard.js';

/** Shared by the real swfte bin and its stderr boundary regression. */
export async function launchCli(action: () => Promise<unknown> = main): Promise<void> {
  try { await action(); }
  catch (err) {
    process.stderr.write(fatalLine('swfte', err));
    process.exitCode = 1;
  }
}
