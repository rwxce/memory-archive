import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'cli/index.ts' },
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  clean: true,
  dts: false,
  shims: true,
  sourcemap: false,
});
