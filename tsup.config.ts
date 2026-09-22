import { defineConfig } from 'tsup';

export default defineConfig({
  // index = MCP server (and `… swfte <cmd>` passthrough); swfte = the bake-in CLI bin.
  entry: ['src/index.ts', 'src/swfte.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
});
