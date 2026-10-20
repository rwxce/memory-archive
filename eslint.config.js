import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * `local/require-test-file`: every source module under the configured folders
 * needs a sibling `<name>.test.ts`. Barrels (`index.ts`) and type-only modules
 * (`types.ts`) are exempt.
 */
const requireTestFile = {
  meta: {
    type: 'problem',
    docs: { description: 'Require a sibling *.test.ts for each source module' },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    if (/\.test\.ts$/.test(file) || /[\\/](index|types)\.ts$/.test(file)) return {};
    return {
      Program(node) {
        const testFile = file.replace(/\.ts$/, '.test.ts');
        if (!existsSync(testFile)) {
          context.report({
            node,
            message: `Missing test file: ${testFile.split(/[\\/]/).slice(-2).join('/')}`,
          });
        }
      },
    };
  },
};

// Node built-ins, with and without the `node:` prefix.
const NODE_MODULES = [...new Set(builtinModules.map((m) => m.replace(/^node:/, '')))];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'lab/**',
      'backup/**',
      'out/**',
      'output/**',
      'fixtures/**',
      'coverage/**',
      'docs/**',
      '.scratch/**',
      // Vendored skill scripts and rulesync-generated agent config.
      '.rulesync/**',
      '.agents/**',
      '.claude/**',
      '.codex/**',
      '.cursor/**',
      '.opencode/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // The parser intentionally matches Unicode invisible runs and control
      // characters in message/timestamp/title processing.
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
  {
    // lib/ is shared with the browser (PWA Web Worker): no Node APIs.
    files: ['lib/**/*.{ts,js}'],
    ignores: ['lib/**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_MODULES.flatMap((name) => [
            { name, message: 'lib/ must stay platform-neutral; put Node I/O in cli/.' },
            { name: `node:${name}`, message: 'lib/ must stay platform-neutral; put Node I/O in cli/.' },
          ]),
          patterns: [
            {
              group: ['node:*', ...NODE_MODULES.map((m) => `${m}/*`)],
              message: 'lib/ must stay platform-neutral; put Node I/O in cli/.',
            },
            {
              group: ['@/cli/*', '**/cli/*'],
              message: 'lib/ must not depend on the CLI.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', '__dirname', '__filename', 'require', 'module', 'global', 'setImmediate'].map(
          (name) => ({ name, message: 'Node-only global; lib/ must run in the browser.' }),
        ),
      ],
    },
  },
  {
    files: ['lib/importers/**/*.ts'],
    plugins: { local: { rules: { 'require-test-file': requireTestFile } } },
    rules: { 'local/require-test-file': 'error' },
  },
);
