import { existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import boundaries from 'eslint-plugin-boundaries';
import { importX } from 'eslint-plugin-import-x';
import i18next from 'eslint-plugin-i18next';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

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

// UI frameworks: never imported from lib/ (the core runs in Node, a Web Worker
// and the standalone viewer).
const UI_MODULES = ['react', 'react-dom', 'next', 'next-intl', 'lucide-react', '@radix-ui'];

/**
 * Architecture layers (eslint-plugin-boundaries). Upper layers may import
 * lower ones, never the reverse:
 *
 *   app → components → hooks → lib/usecases → lib/{domain,db,storage,importers,exporters}
 *
 * UI code reaches data only through use cases (and may use domain types);
 * only use cases compose db / storage / importers / exporters.
 */
const ELEMENTS = [
  { type: 'app', pattern: 'app' },
  { type: 'components', pattern: 'components' },
  { type: 'hooks', pattern: 'hooks' },
  { type: 'i18n', pattern: 'i18n' },
  { type: 'messages', pattern: 'messages' },
  { type: 'usecases', pattern: 'lib/usecases' },
  { type: 'domain', pattern: 'lib/domain' },
  { type: 'db', pattern: 'lib/db' },
  { type: 'storage', pattern: 'lib/storage' },
  { type: 'importers', pattern: 'lib/importers' },
  { type: 'exporters', pattern: 'lib/exporters' },
  { type: 'cli', pattern: 'cli' },
  // Files directly in lib/ (lib/log.ts): shared by every layer. Last, so the
  // lib/<layer> folders above win.
  { type: 'shared', pattern: 'lib' },
].map((e) => ({ ...e, partialMatch: false }));

const allow = (from, to) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: to } } } },
});

const LAYER_POLICIES = [
  allow('app', ['app', 'components', 'hooks', 'i18n', 'messages', 'usecases', 'domain', 'shared']),
  allow('components', ['components', 'hooks', 'i18n', 'messages', 'usecases', 'domain', 'shared']),
  allow('hooks', ['hooks', 'i18n', 'usecases', 'domain', 'shared']),
  allow('i18n', ['i18n', 'messages']),
  allow('usecases', ['usecases', 'domain', 'db', 'storage', 'importers', 'exporters', 'shared']),
  allow('db', ['db', 'domain', 'shared']),
  allow('storage', ['storage', 'domain', 'shared']),
  // The legacy importer/exporter pair shares the CSV codec and version.
  allow('importers', ['importers', 'exporters', 'domain', 'shared']),
  allow('exporters', ['exporters', 'importers', 'domain', 'shared']),
  allow('domain', ['domain']),
  allow('cli', ['cli', 'usecases', 'domain', 'db', 'storage', 'importers', 'exporters', 'shared']),
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.next/**',
      'next-env.d.ts',
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
    plugins: { boundaries, 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
      // Without these, import-x skips TypeScript modules when following imports.
      'import-x/extensions': ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'] },
      'import/resolver': { typescript: { alwaysTryTypes: true } },
      'boundaries/elements': ELEMENTS,
      'boundaries/ignore': ['**/*.test.{ts,tsx}', 'components/test-utils.tsx'],
    },
    rules: {
      'boundaries/dependencies': ['error', { default: 'disallow', policies: LAYER_POLICIES }],
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      // Diagnostics go through lib/log.ts (the CLI and repo scripts print by design).
      'no-console': 'error',
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
            {
              group: UI_MODULES.flatMap((m) => [m, `${m}/*`]),
              message: 'lib/ must not import React, Next.js or other UI code.',
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
  {
    // UI copy comes from messages/{ca,es,en}.json, never hard-coded JSX text.
    files: ['app/**/*.tsx', 'components/**/*.tsx'],
    ignores: ['**/*.test.tsx', 'components/test-utils.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }],
    },
  },
  {
    // The logger itself, the Node CLI and repo scripts may print.
    files: ['lib/log.ts', 'cli/**', 'scripts/**', '**/*.test.{ts,tsx}', '*.config.{js,ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
);
