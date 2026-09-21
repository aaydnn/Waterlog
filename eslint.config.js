// Root ESLint flat config, shared by every workspace package.
// Each package's `lint` script runs `eslint .` from its own directory;
// ESLint resolves this file by walking up from the package cwd.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/.wrangler/',
      '**/coverage/',
      // The waitlist app predates the monorepo and keeps its own style.
      'apps/waitlist/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Service worker scripts shipped as static assets. They run in a worker global scope, not a
    // window, so `self` and the clients API are defined for them and nowhere else.
    files: ['**/public/*-sw.js'],
    languageOptions: {
      globals: { self: 'readonly', clients: 'readonly', caches: 'readonly' },
    },
  },
  {
    // Operator scripts run by hand under Node, never deployed — `workers/cron/scripts` and the
    // like. They live inside a Worker package, so without this they are linted against the Workers
    // runtime and every Node global reads as undefined.
    files: ['**/scripts/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
)
