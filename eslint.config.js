// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

/**
 * Flat ESLint config.
 *
 * Three populations of code live here and they cannot share one parser setup:
 * type-checked TypeScript under src/ and test/, browser script JS under web/,
 * and Node entrypoint JS under bin/. The type-aware configs are scoped to
 * `**\/*.ts` on purpose — leaving them unscoped makes the TS parser try to
 * resolve every .js file through the project service, which fails because
 * tsconfig only includes src/**\/*.ts and test/**\/*.ts. Scoping also tells
 * ESLint 9 to discover .ts files at all, since its default target set is only
 * js/cjs/mjs.
 *
 * eslintConfigPrettier stays last so formatting is Prettier's job alone.
 */

/**
 * Globals available to the browser bundle in web/.
 *
 * Hand-listed rather than pulled from the `globals` package, which is only a
 * transitive dependency here and would break config loading if it ever stopped
 * being hoisted. `no-undef` is live on this block, so anything the browser
 * bundle legitimately touches has to appear below or it reports a false error.
 */
const browserGlobals = {
  AbortController: 'readonly',
  Blob: 'readonly',
  CustomEvent: 'readonly',
  DOMParser: 'readonly',
  Element: 'readonly',
  Event: 'readonly',
  EventSource: 'readonly',
  HTMLElement: 'readonly',
  MutationObserver: 'readonly',
  Node: 'readonly',
  ResizeObserver: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  document: 'readonly',
  fetch: 'readonly',
  getComputedStyle: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  matchMedia: 'readonly',
  navigator: 'readonly',
  performance: 'readonly',
  queueMicrotask: 'readonly',
  requestAnimationFrame: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  window: 'readonly',
  // Vendored UMD globals, loaded via <script> before app.js.
  marked: 'readonly',
  mermaid: 'readonly',
};

/** Globals for Node ESM files that tsc never sees (bin/ and this config). */
const nodeGlobals = {
  AbortController: 'readonly',
  Buffer: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
};

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'test/fixtures/'],
  },

  js.configs.recommended,

  // Type-checked TypeScript. `projectService` picks up tsconfig.json per file.
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in a server or file-watcher is a silent hang, not a warning.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Applies to every population.
  {
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'warn',
    },
  },

  // The CLI and the bin shim exist to print to a terminal.
  {
    files: ['src/cli.ts', 'bin/*.js'],
    rules: {
      'no-console': 'off',
    },
  },

  // Tests. `node:test`'s `test()` returns a promise nobody is meant to await at
  // the top level — the runner owns the lifecycle. Enforcing the rule here would
  // mean 128 `void` operators that say nothing.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // Browser bundle: classic scripts, no module system, no tsconfig.
  {
    files: ['web/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: browserGlobals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // Node ESM files outside the TypeScript program.
  {
    files: ['bin/*.js', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  eslintConfigPrettier
);
