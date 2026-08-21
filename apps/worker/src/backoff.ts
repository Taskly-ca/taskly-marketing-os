/**
 * ADAPTIVE BACKOFF — the half of task 2.10 that Part 2 shipped without.
 *
 * Conditional GET already lives in the collectors. What did not exist anywhere
 * is the rule that decides whether to ASK a source at all, and that rule
 * belongs here because it is the only place that can see `consecutive_failures`
 * and a clock at the same time.
 *
 * ── THE CURVE, AND WHY THIS ONE ─────────────────────────────────────────────
 *
 * `delay(0) = 0`. A HEALTHY SOURCE IS ALWAYS DUE. The cadence of the whole
 * pipeline is the scheduler's decision (a cron line, a Part-8 concern), not the
 * runner's; a runner that also held opinions about how often a working feed
 * should be read would silently override whatever the scheduler was configured
 * to do, and the two would drift. So this module only ever HOLDS SOMETHING
 * BACK, and it holds back exactly one thing: a source that is failing.
 *
 * `delay(n) = 5min * 2^(n-1)`, capped at 6h. Exponential rather than linear
 * because the two costs are asymmetric. A wasted attempt on a dead source costs
 * a request, a connection and a slot in the pass; the cost of being late on a
 * source that has quietly recovered is staleness, bounded by the interval. With
 * doubling, total wasted attempts over an outage of length T grow as log(T)
 * while worst-case staleness stays within 2x of the outage — linear backoff
 * makes wasted attempts grow as sqrt(T) for the same staleness, which is the
 * wrong trade when outages are usually minutes and occasionally days.
 *
 * The 6h CAP matters more than the base. Uncapped doubling reaches a week by
 * n=12, and a source that hit twelve failures during a provider incident would
 * then stay dark long after the incident closed — the classic way backoff turns
 * a transient outage into a permanent one. 6h means a recovered source is
 * picked up within one working day no matter how deep the streak went.
 *
 * RECOVERY IS AUTOMATIC AND IMMEDIATE, and it is not implemented here: both
 * success outcomes in `recordCollection` set `consecutive_failures = 0`, so one
 * good fetch puts `delay` back to 0 and the source is due on the very next
 * pass. There is deliberately no gradual "ramp back up" — that would keep
 * punishing a source for an outage that is over.
 *
 * ── WHAT THIS MEASURES FROM, AND THE SCHEMA GAP BEHIND IT ───────────────────
 *
 * Backoff needs "when did we last TRY". `source` only records `last_ok_at` —
 * when we last SUCCEEDED — and after a failure that column does not move at
 * all. Measuring the delay from it would therefore compare `now` against an
 * instant that keeps receding, so a source stale by an hour would be "due"
 * again on every single pass no matter how deep its failure streak: the backoff
 * would compute correctly and then never apply.
 *
 * So the attempt log is `events`. Every collection attempt appends one
 * (`source.collected` / `source.collect_failed`), the table is append-only, and
 * `max(occurred_at)` per source is the durable last-attempt clock the source
 * table does not have. That is not a workaround for its own sake — the
 * source-store's own header argues the failure reason belongs in the event
 * stream because "a single mutable column would only ever remember the last
 * one". The attempt TIME has the same shape. See the report for the column
 * (`source.last_attempt_at`) that would make this a lookup instead of a join.
 */

/** One pass' worth of grace after the first failure. */
export const BASE_RETRY_MS = 5 * 60_000;

/** The ceiling. A recovered source is never more than this far from being read. */
export const MAX_RETRY_MS = 6 * 60 * 60_000;

/**
 * Spread, as a fraction of the delay, applied on top: `delay * (1 + r*0.2)`.
 *
 * Sources that fail together (one provider, one network blip) otherwise retry
 * together forever, and arrive as a thundering herd at exactly the moment the
 * provider is coming back up. 20% is enough to decorrelate a handful of sources
 * without meaningfully changing the curve. It is additive rather than the more
 * usual "full jitter" (`random(0, delay)`) because full jitter can retry almost
 * immediately, which is the one thing backoff exists to prevent.
 */
export const JITTER_RATIO = 0.2;

/** What the decision needs, and nothing else — so it is testable with a literal. */
interface BackoffState {
  readonly consecutiveFailures: number;
  /** ISO instant of the last ATTEMPT (success or failure), or null if never tried. */
  readonly lastAttemptAt: string | null;
}

/**
 * How long to hold a source back after `n` consecutive failures.
 *
 * `jitter` is injected rather than read from `Math.random` so the curve is
 * pinned by a test. Production passes nothing.
 */
export function retryDelayMs(consecutiveFailures: number, jitter = Math.random()): number {
  const n = Math.max(0, Math.floor(consecutiveFailures));
  if (n === 0) return 0;

  // `2 ** (n-1)` overflows to Infinity long before it matters, and Infinity
  // would survive `Math.min` as the cap — so clamp the exponent first.
  const doublings = Math.min(n - 1, 32);
  const base = Math.min(BASE_RETRY_MS * 2 ** doublings, MAX_RETRY_MS);
  const spread = Math.min(Math.max(jitter, 0), 1) * JITTER_RATIO;
  return Math.round(base * (1 + spread));
}

interface DueVerdict {
  readonly due: boolean;
  /** Milliseconds still to wait. 0 when due. */
  readonly waitMs: number;
  /** Why it is being held, in the words the report prints. */
  readonly reason: string;
}

/**
 * The scheduling decision for ONE source.
 *
 * A source that has never been attempted is always due — that is the cold start,
 * and it is also the only case where `dueSources`' `last_ok_at nulls first`
 * ordering and this function agree by construction rather than by accident.
 */
export function dueVerdict(state: BackoffState, now: Date, jitter = Math.random()): DueVerdict {
  if (state.lastAttemptAt === null) return { due: true, waitMs: 0, reason: 'never collected' };

  // NOTE: jitter is re-drawn every pass, so the effective deadline wobbles by up
  // to 20% between passes rather than being fixed once. That is harmless at this
  // depth (it can only ever move an attempt by a fifth of the delay) and it is
  // the price of storing no per-source retry deadline. If a stable deadline is
  // ever wanted, seed the jitter from the source id rather than the clock.
  const delay = retryDelayMs(state.consecutiveFailures, jitter);
  if (delay === 0) return { due: true, waitMs: 0, reason: 'healthy' };

  const last = Date.parse(state.lastAttemptAt);
  // An unparseable stamp is treated as "no idea when we last tried", which must
  // fail toward attempting: silently never collecting is the worse failure.
  if (Number.isNaN(last)) return { due: true, waitMs: 0, reason: 'unreadable last attempt' };

  const waitMs = last + delay - now.getTime();
  if (waitMs <= 0) return { due: true, waitMs: 0, reason: `retry after ${state.consecutiveFailures} failures` };

  return {
    due: false,
    waitMs,
    reason: `backing off: ${state.consecutiveFailures} consecutive failures, ${Math.ceil(waitMs / 60_000)}m to go`,
  };
}
