import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.planning/**',
      'lab/**',
      'backup/**',
      'out/**',
      'output/**',
      'coverage/**',
      'docs/**',
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
    // Browser-side scripts that run in the generated HTML viewer.
    files: ['src/render/js/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
);
