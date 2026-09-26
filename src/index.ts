import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildServer } from './server.js';
import { loadConfig } from './config.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(
      `[swfte-mcp] ${err instanceof Error ? err.message : String(err)}\n` +
        '[swfte-mcp] See https://www.swfte.com/developers for setup instructions.\n'
    );
    process.exit(1);
  }

  const server = buildServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[swfte-mcp] Connected. base=${config.baseUrl} workspace=${config.workspaceId ?? '(per-tool)'} \n`
  );
}

// `npx @swfte/mcp-server swfte verify` (and any `swfte-mcp-server swfte …`) runs
// the bake-in CLI instead of the MCP server, so CI needs no second package.
if (process.argv[2] === 'swfte') {
  import('./cli.js')
    .then((cli) => cli.main(process.argv.slice(3)))
    .catch((err) => {
      process.stderr.write(`[swfte] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    });
} else {
  main().catch((err) => {
    process.stderr.write(`[swfte-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
