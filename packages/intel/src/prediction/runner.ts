/**
 * The weekly resolution run.
 *
 * Scans for due predictions, executes each resolver, and records the outcome.
 * Ambiguity ANNULS — no score, no penalty. That rule exists to protect scoring
 * integrity: a guessed resolution is indistinguishable from a real one in the
 * aggregate, and it quietly destroys the only asset that compounds here.
 */
import { resolverFor } from '../resolver/kinds.js';
import type { ResolverContext } from '../resolver/types.js';
import type { PredictionStore } from './store.js';

export interface RunSummary {
  scanned: number;
  resolved: number;
  annulled: number;
  failures: Array<{ id: string; reason: string }>;
}

export async function runDueResolvers(
  store: PredictionStore,
  ctx: ResolverContext,
  now: Date = new Date(),
): Promise<RunSummary> {
  const due = await store.due(now);
  const summary: RunSummary = { scanned: due.length, resolved: 0, annulled: 0, failures: [] };

  for (const p of due) {
    const resolver = resolverFor(p.resolver.kind);
    if (!resolver) {
      await store.resolve(p.id, {
        outcome: 'annulled',
        observed: null,
        resolvedAt: now.toISOString(),
        annulReason: `unknown resolver kind: ${p.resolver.kind}`,
      });
      summary.annulled++;
      continue;
    }

    try {
      const res = await resolver.run(p.resolver, ctx);
      if (res.outcome === 'annulled') {
        await store.resolve(p.id, {
          outcome: 'annulled',
          observed: res.observed ?? null,
          resolvedAt: now.toISOString(),
          annulReason: res.reason,
        });
        summary.annulled++;
      } else {
        await store.resolve(p.id, {
          outcome: res.outcome,
          observed: res.observed,
          resolvedAt: now.toISOString(),
        });
        summary.resolved++;
      }
    } catch (e) {
      // An exception is never a "no" — it annuls, and it is surfaced loudly.
      const reason = (e as Error).message;
      await store.resolve(p.id, {
        outcome: 'annulled',
        observed: null,
        resolvedAt: now.toISOString(),
        annulReason: `resolver threw: ${reason}`,
      });
      summary.annulled++;
      summary.failures.push({ id: p.id, reason });
    }
  }
  return summary;
}
