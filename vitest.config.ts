import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Resolve `@tmos/*` to SOURCE, not to the built `dist`.
 *
 * Without this, a cross-package import in a test resolves through node_modules
 * to `dist/index.js` — so the suite silently runs against the last build. A new
 * export is invisible until someone rebuilds, and, worse, a test can pass
 * against a stale copy of a contract that the source no longer matches. That
 * cost a lane most of a run before it was spotted, and the failure mode ("this
 * export does not exist" when it plainly does) points nowhere near the cause.
 *
 * Built by reading the workspace so a new package is wired up automatically and
 * cannot be forgotten.
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
    // Deterministic and keyless by default — the same discipline as taskly.ca.
    // Anything needing a live key goes in a *.live.test.ts and is excluded here.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    environment: 'node',
  },
});
