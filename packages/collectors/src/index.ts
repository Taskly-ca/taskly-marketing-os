/**
 * The collector registry.
 *
 * Every source is free-tier and every one degrades the same way: a missing
 * credential makes `isConfigured()` false and the runner skips it cleanly. A
 * source we cannot reach must never fail the run — but it must also never look
 * like a source that was simply quiet. That distinction lives in `CollectResult`
 * (see types.ts) and is the single most important property in this package.
 */
export * from './types.js';
export * from './policy.js';

export * from './rss.js';
export * from './hn.js';
export * from './gdelt.js';
export * from './product-hunt.js';
export * from './gsc.js';

import { createGscCollector } from './gsc.js';
import { createProductHuntCollector } from './product-hunt.js';
import type { Collector } from './types.js';

/**
 * The credentialed sources, bound to a run's env.
 *
 * The keyless ones (rss/hn/gdelt) are deliberately NOT here: each needs a feed
 * URL or a query, so they are constructed per watchlist entry by the runner
 * rather than registered as singletons.
 */
export function credentialedCollectors(env: Record<string, string | undefined>): Collector[] {
  return [createProductHuntCollector(env), createGscCollector(env)];
}

/** The subset that can actually run right now. Everything else is skipped, and
 *  the skip is a reportable fact — not a silent gap in the day's coverage. */
export function configuredCollectors(
  candidates: Collector[],
  env: Record<string, string | undefined>,
): { runnable: Collector[]; skipped: string[] } {
  const runnable: Collector[] = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    if (c.isConfigured(env)) runnable.push(c);
    else skipped.push(c.name);
  }
  return { runnable, skipped };
}
