import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The LIVE suite — opt-in, never run by CI.
 *
 * `vitest.config.ts` excludes `*.live.test.ts` so the default suite stays
 * deterministic and keyless. These tests spend real money and hit real hosts,
 * so running them has to be a decision someone makes, not something a `pnpm
 * test` does by accident.
 *
 *   pnpm test:live
 */
const packagesDir = resolve(import.meta.dirname, 'packages');
const alias = Object.fromEntries(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(packagesDir, e.name, 'src/index.ts')))
    .map((e) => [`@tmos/${e.name}`, resolve(packagesDir, e.name, 'src/index.ts')]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/**/*.live.test.ts', 'apps/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Real network + a real model. One at a time, and generous timeouts.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
