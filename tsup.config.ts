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
  // The code-map scanner's vendored tree-sitter grammars (MIT; docs/codemap/CONTRACT.md D1) ship beside the bundle.
  async onSuccess() {
    const { cpSync } = await import('node:fs');
    cpSync('src/codemap/grammars', 'dist/codemap/grammars', { recursive: true });
  },
});
