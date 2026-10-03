import { defineConfig } from 'tsup';

export default defineConfig({
  // index = MCP server (and `… swfte <cmd>` passthrough); swfte = the bake-in CLI bin.
  entry: ['src/index.ts', 'src/swfte.ts', 'src/native-filesystem.ts'],
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
    const { execFileSync } = await import('node:child_process');
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const supported = (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch))
      || (process.platform === 'linux' && process.arch === 'x64' && !!report?.header?.glibcVersionRuntime);
    // Docker's unsupported musl/arm64 JS builds retain an explicitly refusing wrapper.
    if (supported || process.env.SWFTE_NATIVE_REQUIRE_ALL === '1')
      execFileSync(process.execPath, ['scripts/build-confined-fs.mjs', '--prepare-and-assemble'], { stdio: 'inherit' });
  },
});
