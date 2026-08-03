// Flat config. Zero-warning policy in CI — style never costs review attention.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Node globals for build/CI scripts, without pulling in another dependency. */
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'supabase/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The budget chokepoint is the ONLY module allowed to call a provider SDK.
    // Everything else must go through it, so the ceiling cannot be bypassed.
    files: ['packages/**/src/**/*.ts', 'apps/**/src/**/*.ts'],
    ignores: ['packages/shared/src/llm/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'groq-sdk',
              message: 'Route LLM calls through @tmos/shared/llm — it owns the budget ceiling.',
            },
            {
              name: '@google/generative-ai',
              message: 'Route LLM calls through @tmos/shared/llm — it owns the budget ceiling.',
            },
            {
              name: '@anthropic-ai/sdk',
              message: 'Route LLM calls through @tmos/shared/llm — it owns the budget ceiling.',
            },
            {
              name: 'openai',
              message: 'Route LLM calls through @tmos/shared/llm — it owns the budget ceiling.',
            },
          ],
        },
      ],
    },
  },
  {
    // CI scripts print to stdout by design. LAST block wins in flat config.
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
