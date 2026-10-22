import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('.', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  // React 19 automatic JSX runtime for component tests.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Fixtures come from `scripts/generate-fixtures.mjs` (run by `pnpm test`).
    testTimeout: 20_000,
    // Tests live next to the code they cover.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'lib/**/*.test.ts',
            'cli/**/*.test.ts',
            'scripts/**/*.test.ts',
            'i18n/**/*.test.ts',
            'sw/**/*.test.ts',
          ],
        },
      },
      {
        // UI code runs against a DOM. happy-dom over jsdom: a fraction of the
        // install size and dependencies, and fast enough for component tests.
        extends: true,
        test: {
          name: 'dom',
          environment: 'happy-dom',
          setupFiles: ['./vitest.setup-dom.ts'],
          include: [
            'app/**/*.test.{ts,tsx}',
            'components/**/*.test.{ts,tsx}',
            'hooks/**/*.test.{ts,tsx}',
          ],
        },
      },
    ],
  },
});
