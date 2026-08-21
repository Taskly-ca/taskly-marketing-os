import { readdirSync, existsSync, readFileSync } from 'node:fs';
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
 *
 * THIS config, and only this one, loads the repo-root `.env`. The separation is
 * the point: the deterministic suite must never acquire a key or a database by
 * standing next to a file, or "keyless" stops being a property anyone can rely
 * on. Here the opposite is true — a live suite that self-skips because nothing
 * put DATABASE_URL in the process reports "6 skipped" and looks like a pass,
 * which is the most expensive kind of green there is. That is what happened
 * before this existed.
 */
const packagesDir = resolve(import.meta.dirname, 'packages');
const alias = Object.fromEntries(
  readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(packagesDir, e.name, 'src/index.ts')))
    .map((e) => [`@tmos/${e.name}`, resolve(packagesDir, e.name, 'src/index.ts')]),
);

/**
 * Parse `KEY=value` lines from the repo-root `.env`.
 *
 * Two rules, both deliberate:
 *
 *  · A MISSING `.env` returns `{}`. It is not an error and must never throw:
 *    every live suite already self-skips on the variable it needs, and a clean
 *    skip on a machine with no credentials is the designed behaviour. (This is
 *    also why `process.loadEnvFile` is not used — it throws on a missing file.)
 *  · The REAL environment wins. `DATABASE_URL=… pnpm test:live` must point the
 *    suite where the operator said, not where the file says, so a key already
 *    present in `process.env` is left alone.
 *
 * A key with an EMPTY value is treated as absent. `.env` lists every variable
 * the system can take, most of them unfilled, and a suite that asks `'KEY' in
 * process.env` rather than for a truthy value would otherwise read a blank
 * credential as a provided one and fail at the host instead of skipping.
 */
function dotEnv(): Record<string, string> {
  const file = resolve(import.meta.dirname, '.env');
  if (!existsSync(file)) return {};

  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue; // comments, blanks, anything that is not an assignment
    const [, key, raw = ''] = match;
    if (key === undefined || process.env[key] !== undefined) continue;
    const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value.length > 0) out[key] = value;
  }
  return out;
}

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/**/*.live.test.ts', 'apps/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Assigned to `process.env` in the worker before any test file is imported,
    // which matters: the suites read their variables at module top level to
    // decide whether to skip.
    env: dotEnv(),
    // Real network + a real model. One at a time, and generous timeouts.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
