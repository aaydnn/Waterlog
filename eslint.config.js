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
