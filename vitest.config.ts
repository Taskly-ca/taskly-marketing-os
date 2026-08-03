import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Deterministic and keyless by default — the same discipline as taskly.ca.
    // Anything needing a live key goes in a *.live.test.ts and is excluded here.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    environment: 'node',
  },
});
