/** Entry for the `swfte` bin. All behaviour lives in ./cli.ts. */
import { main } from './cli.js';

main().catch((err) => {
  process.stderr.write(`[swfte] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
