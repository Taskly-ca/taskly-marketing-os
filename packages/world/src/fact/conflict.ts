/**
 * Type the conflict BEFORE resolving it.
 *
 * Two rows disagreeing is not one situation, it is three, and they need
 * opposite treatments:
 *
 *   TEMPORAL — the world changed. A competitor raising their price from $99 to
 *              $119 is the most valuable signal we collect. "Resolving" it by
 *              picking one number deletes the signal and leaves a number that
 *              was never true at any single instant. The correct action is
 *              `recordChange` (write.ts rule 3), never fusion.
 *   FACTUAL  — the same instant, incompatible values. Exactly one is right, and
 *              this is the ONLY kind eligible for fusion.
 *   OPINION  — the predicate is subjective. Yelp saying 4.2 and Google saying
 *              4.6 are both true; averaging them manufactures a number no
 *              source stands behind. Keep both, attributed.
 *
 * Misfiling a temporal change as factual is the single most damaging error in
 * this module, so it is the first thing the test suite proves.
 */
import { rangesOverlap } from './types.js';
import type { FactMethod, FactRow } from './types.js';
import { sameValue } from './write.js';

export type ConflictKind = 'temporal' | 'factual' | 'opinion' | 'none';
export type RealConflictKind = Exclude<ConflictKind, 'none'>;

/**
 * One crawl cycle — seven days, our slowest routine re-observation interval.
 * Two observations further apart than this did not look at the same snapshot of
 * the world, so a differing value is better explained by the world moving than
 * by the sources contradicting each other. Volatile predicates should pass a
 * shorter `ctx.changeWindowMs`; ones that cannot move, a much longer one.
 */
export const DEFAULT_CHANGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fallback ONLY. Subjectivity belongs in `predicate_def` metadata — a hardcoded
 * list cannot know a domain pack's `vendor_verdict` is an opinion.
 * `ctx.isSubjective` always wins; this exists so an un-annotated `rating` is
 * not silently fused on day one.
 */
const FALLBACK_SUBJECTIVE_TOKENS = [
  'rating',
  'stars',
  'sentiment',
  'satisfaction',
  'nps',
  'reputation',
  'quality',
  'opinion',
  'verdict',
  'best',
];

export interface ConflictContext {
  /** Wire to `PredicateDef.subjective` (predicates.ts). Return undefined when
   *  the predicate is unknown, so the fallback list can answer instead. */
  isSubjective?: (predicate: string) => boolean | undefined;
  /** Override for a predicate whose real-world volatility is not the default. */
  changeWindowMs?: number;
}

export function isSubjectivePredicate(predicate: string, ctx: ConflictContext = {}): boolean {
  const fromMetadata = ctx.isSubjective?.(predicate);
  if (fromMetadata !== undefined) return fromMetadata;
  const p = predicate.toLowerCase();
  return FALLBACK_SUBJECTIVE_TOKENS.some((token) => p.includes(token));
}

const ms = (iso: string): number => new Date(iso).getTime();

/** Same window means neither row can be hiding a change the other missed. */
const sameWindow = (a: FactRow, b: FactRow): boolean =>
  ms(a.valid.from) === ms(b.valid.from) &&
  (a.valid.to === null
    ? b.valid.to === null
    : b.valid.to !== null && ms(a.valid.to) === ms(b.valid.to));

const observationGapMs = (a: FactRow, b: FactRow): number =>
  Math.abs(ms(a.observedAt) - ms(b.observedAt));

/**
 * The classification, in the order that keeps the dangerous mistake impossible.
 *
 * Note that a subjective predicate can still produce a TEMPORAL result when both
 * rows come from the SAME source: one outlet's own rating moving over time is a
 * real change. It is two DIFFERENT sources disagreeing that is an opinion.
 */
export function classifyConflict(a: FactRow, b: FactRow, ctx: ConflictContext = {}): ConflictKind {
  if (a.factId === b.factId) return 'none';
  if (a.entityId !== b.entityId || a.predicate !== b.predicate) return 'none';
  if (sameValue(a.value, b.value)) return 'none';

  if (isSubjectivePredicate(a.predicate, ctx) && a.sourceId !== b.sourceId) return 'opinion';

  // No instant at which both claim to hold: nothing collides, so the only
  // coherent reading is that the value changed between the two windows.
  if (!rangesOverlap(a.valid, b.valid)) return 'temporal';

  const window = ctx.changeWindowMs ?? DEFAULT_CHANGE_WINDOW_MS;
  if (!sameWindow(a, b) && observationGapMs(a, b) >= window) return 'temporal';

  return 'factual';
}

/** The instant they collide (overlap) or the instant of the apparent change. */
function collisionInstant(a: FactRow, b: FactRow): string {
  return ms(a.valid.from) >= ms(b.valid.from) ? a.valid.from : b.valid.from;
}

/**
 * Mirrors the `fact_conflict` table. `id` and `created_at` are assigned by the
 * store on insert, exactly as `factId` is for a fact.
 */
export interface FactConflict {
  entityId: string;
  predicate: string;
  validInstant: string;
  factIds: string[];
  kind: RealConflictKind;
  status: 'open' | 'resolved' | 'unresolvable';
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

/**
 * Pairwise over the rows we currently assert, then grouped: three sources
 * disagreeing at one instant is ONE conflict with three participants, not three
 * conflicts. A reviewer should see one queue item per real disagreement.
 */
export function detectConflicts(
  rows: readonly FactRow[],
  ctx: ConflictContext = {},
): FactConflict[] {
  const live = rows.filter((r) => r.status === 'active' && r.asserted.to === null);
  const byKey = new Map<string, FactConflict>();

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      const kind = classifyConflict(a, b, ctx);
      if (kind === 'none') continue;

      const validInstant = collisionInstant(a, b);
      const key = `${a.entityId}|${a.predicate}|${kind}|${validInstant}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const id of [a.factId, b.factId]) {
          if (!existing.factIds.includes(id)) existing.factIds.push(id);
        }
      } else {
        byKey.set(key, {
          entityId: a.entityId,
          predicate: a.predicate,
          validInstant,
          factIds: [a.factId, b.factId],
          kind,
          status: 'open',
        });
      }
    }
  }

  return [...byKey.values()].map((c) => ({ ...c, factIds: [...c.factIds].sort() }));
}

/* ── resolution ──────────────────────────────────────────────────────────── */

/**
 * Structural error-rate priors on how a value got here: a human typed it or an
 * API served it structured; a scrape guessed a selector; an LLM extraction also
 * had to read prose right. Not trust in the source — `reliabilityOf` is that.
 */
export const METHOD_WEIGHT: Record<FactMethod, number> = {
  human: 1,
  api: 0.85,
  scrape: 0.6,
  llm_extract: 0.4,
};

/**
 * Reliability dominates: it is the only component grounded in outcomes (did
 * this source turn out right). Method is a structural prior. Recency is weakest
 * on purpose — inside a FACTUAL conflict every row claims the SAME instant, so
 * being observed later does not make a row righter. It is a tie-breaker, and
 * weighting it higher would let crawl order decide truth.
 */
export const RESOLUTION_WEIGHTS = { reliability: 0.45, method: 0.35, recency: 0.2 } as const;

/** An observation a month older than the freshest in the same conflict carries
 *  half the recency credit. Shorter half-lives make crawl jitter decisive. */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;

/** Below this gap the winner is a coin flip, and a coin flip recorded as a
 *  resolution is worse than an open conflict: it looks settled. Goes to a human
 *  as `unresolvable` instead. */
export const RESOLUTION_MARGIN = 0.05;

export interface ResolveOptions {
  /** Lower credible bound on the source's accuracy — see reliability.ts. */
  reliabilityOf: (sourceId: string) => number;
  /** Injected clock; stamped on the resolution. */
  now: string;
  recencyHalfLifeDays?: number;
  resolvedBy?: string;
}

export interface FactScore {
  factId: string;
  score: number;
  reliability: number;
  method: number;
  recency: number;
}

export interface Refusal {
  kind: RealConflictKind | 'insufficient_margin' | 'missing_rows';
  reason: string;
  /** What to do instead. A refusal is a routing decision, not a bug. */
  action: 'recordChange' | 'keep_both' | 'human_review';
}

export type ResolveOutcome =
  | {
      resolved: true;
      conflict: FactConflict;
      winner: FactRow;
      /** Retract these — `retractFact`, never DELETE. Erasing the losing rows
       *  destroys the audit trail that explains a later wrong answer. */
      retract: string[];
      scores: FactScore[];
    }
  | { resolved: false; conflict: FactConflict; refusal: Refusal; scores: FactScore[] };

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Fuse a FACTUAL conflict. Returns the winner and the rows to retract; mutates
 * nothing, writes nothing — the caller applies the retractions through
 * `retractFact` so the append-only rules stay in one place.
 */
export function resolveFactual(
  conflict: FactConflict,
  rows: readonly FactRow[],
  opts: ResolveOptions,
): ResolveOutcome {
  const refuse = (refusal: Refusal, status: FactConflict['status']): ResolveOutcome => ({
    resolved: false,
    conflict: { ...conflict, factIds: [...conflict.factIds], status },
    refusal,
    scores: [],
  });
  const open = conflict.status;

  if (conflict.kind === 'temporal') {
    const reason = 'the values hold at different times — fusing them would erase a real change';
    return refuse({ kind: 'temporal', reason, action: 'recordChange' }, open);
  }
  if (conflict.kind === 'opinion') {
    const reason = 'subjective predicate — disagreement is the signal, not an error';
    return refuse({ kind: 'opinion', reason, action: 'keep_both' }, open);
  }

  const participants = conflict.factIds
    .map((id) => rows.find((r) => r.factId === id))
    .filter((r): r is FactRow => r !== undefined);
  if (participants.length < 2) {
    const reason = 'fewer than two participating facts were supplied';
    return refuse({ kind: 'missing_rows', reason, action: 'human_review' }, open);
  }

  const halfLifeMs = (opts.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS) * 86_400_000;
  const newest = Math.max(...participants.map((p) => ms(p.observedAt)));

  const scores: FactScore[] = participants
    .map((p) => {
      const reliability = clamp01(opts.reliabilityOf(p.sourceId));
      const method = METHOD_WEIGHT[p.method];
      const recency = 0.5 ** ((newest - ms(p.observedAt)) / halfLifeMs);
      return {
        factId: p.factId,
        score:
          RESOLUTION_WEIGHTS.reliability * reliability +
          RESOLUTION_WEIGHTS.method * method +
          RESOLUTION_WEIGHTS.recency * recency,
        reliability,
        method,
        recency,
      };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.factId < b.factId ? -1 : 1));

  const best = scores[0]!;
  const runnerUp = scores[1]!;
  if (best.score - runnerUp.score < RESOLUTION_MARGIN) {
    return {
      resolved: false,
      conflict: { ...conflict, factIds: [...conflict.factIds], status: 'unresolvable' },
      refusal: {
        kind: 'insufficient_margin',
        reason: `top two candidates are within ${RESOLUTION_MARGIN} — picking one would be a coin flip`,
        action: 'human_review',
      },
      scores,
    };
  }

  const winner = participants.find((p) => p.factId === best.factId)!;
  // Rows agreeing with the winner corroborate it; only the incompatible ones lose.
  const retract = participants
    .filter((p) => p.factId !== winner.factId && !sameValue(p.value, winner.value))
    .map((p) => p.factId)
    .sort();

  return {
    resolved: true,
    conflict: {
      ...conflict,
      factIds: [...conflict.factIds],
      status: 'resolved',
      resolution: `kept ${winner.factId} (${winner.sourceId}, ${winner.method}, score ${best.score.toFixed(3)}); retracted ${retract.join(', ') || 'none'}`,
      resolvedBy: opts.resolvedBy ?? 'auto',
      resolvedAt: opts.now,
    },
    winner: { ...winner },
    retract,
    scores,
  };
}
