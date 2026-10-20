import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    // Tests live next to the code they cover.
    include: ['lib/**/*.test.ts', 'cli/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Fixtures come from `scripts/generate-fixtures.mjs` (run by `pnpm test`).
    testTimeout: 20_000,
  },
});
