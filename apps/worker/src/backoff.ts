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
 *
 * ── THE SECOND QUESTION: NOT "HOW LONG", BUT "WHO CAN FIX IT" ───────────────
 *
 * The curve above answers "how long do we wait". On its own it answers the
 * wrong question for two of the three ways a source actually breaks, and the
 * live table on 2026-08-30 is the proof: `rss:hpac-magazine` (7 straight
 * refusals, `robots.txt disallows /feed/`), `gdelt:home-services-toronto` (6,
 * robots.txt unreachable so the gate fails closed) and Product Hunt (4, HTTP
 * 401 `invalid_oauth_token`) had all been failing for over a week, none had
 * EVER succeeded, and the scheduler treated all three exactly like a feed that
 * had timed out once. Capped at 6h, each one failed again on every pass,
 * forever, and wrote a line nobody could act on.
 *
 * Backoff is the wrong instrument for those two. Retrying is a bet that the
 * world will change on its own, and it only pays when the failure is an
 * accident of the moment:
 *
 *   TRANSIENT       (network · rate_limited · parse) — a blip, a hiccup, a feed
 *                   that was briefly malformed. Waiting IS the fix. The curve.
 *   NEEDS_OPERATOR  (auth · not_configured) — a credential. No number of
 *                   retries has ever repaired a dead token; a person has to
 *                   edit `.env`. Retrying is pure noise until they do.
 *   REFUSED         (blocked_by_policy) — the site told us not to. That is not
 *                   a fault and there is nothing to repair. We do not fetch
 *                   what a host refuses, and no workaround (a different UA, a
 *                   render service, ignoring the gate) is on the table — the
 *                   honest-crawler promise is the whole reason the gate exists.
 *
 * So `needs_operator` and `refused` are both held at HUMAN SCALE — one day,
 * flat — because the recovery mechanism is a human, and a human works in days.
 * That is short enough that a token replaced this morning is picked up tonight
 * without anyone remembering `--force`, and long enough that a source nobody
 * can fix stops appearing in every pass.
 *
 * WHY BOTH GET THE SAME INTERVAL, THOUGH NOT THE SAME LABEL. A longer hold for
 * `refused` was considered and rejected: `blocked_by_policy` covers BOTH "the
 * site published a rule" (permanent) and "we could not read the rule and failed
 * closed" (may clear on its own — this is GDELT, today). Telling those apart
 * needs a structured denial from the transport, which it does not emit; the
 * difference survives only in the event's `detail` string. Guessing permanence
 * off that string would be a rule that breaks when someone rewords an error.
 * What differs is what the operator is TOLD, and that is the part that pays:
 * `needs_operator` goes on a list of things to do, `refused` on a list of
 * things we are not allowed to have. Neither is a source having a bad day.
 *
 * ── WHERE THE REASON COMES FROM, AND THE SECOND SCHEMA GAP ──────────────────
 *
 * `lastFailure` is the collector's own word (`CollectFailure`), and it is the
 * classifier's first choice. Nothing persists it yet: it is written into the
 * `source.collect_failed` event payload and never read back, and the reader
 * that would return it belongs beside `lastAttemptAt` in `store.ts` — outside
 * this change. So the scheduler passes `null` today and the fallback below does
 * the work: a source that has failed `UNPRODUCTIVE_AFTER` times and has NEVER
 * ONCE SUCCEEDED (`source.last_ok_at is null`) is not having a bad afternoon,
 * whatever the reason was. That reclassifies all three of the live failures
 * correctly with no new column and no new query. It is a proxy, not the truth,
 * and the moment the reason is persisted the proxy stops being consulted.
 */
import type { CollectFailure } from '@tmos/collectors';


/** One pass' worth of grace after the first failure. */
export const BASE_RETRY_MS = 5 * 60_000;

/** The ceiling for a failure that waiting can fix. */
export const MAX_RETRY_MS = 6 * 60 * 60_000;

/**
 * The hold for a failure only a person can clear — flat, not a curve.
 *
 * A curve models "the world may right itself"; nothing about a wrong token or a
 * `Disallow` line gets likelier as we wait, so escalating is meaningless. One
 * day is the operator's own cadence: it survives a whole working day of
 * on-demand passes without repeating itself, and it re-asks by tomorrow so a
 * fix made at 09:00 is picked up without anyone typing `--force`.
 */
export const HUMAN_SCALE_RETRY_MS = 24 * 60 * 60_000;

/**
 * Failures with no success EVER on record before we stop calling it an outage.
 *
 * Three, because two is still plausibly one bad afternoon spanning two passes
 * and three is not — and because the cost of being wrong is asymmetric and
 * small: a genuinely-transient new source is held a day instead of forty
 * minutes, is named in the report, and `--force` collects it immediately.
 * Getting it wrong the other way is what we have been doing for nine days.
 */
export const UNPRODUCTIVE_AFTER = 3;

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

/**
 * WHAT KIND OF BROKEN A SOURCE IS — the distinction the whole module turns on.
 *
 * Deliberately about the REMEDY, not about the error: `transient` means waiting
 * fixes it, `needs_operator` means a person fixes it, `refused` means nobody
 * fixes it and we stop asking so often. Naming it after the remedy is what
 * makes a report actionable — "401" tells an operator nothing they can do.
 */
// Not exported: every consumer so far reaches it through `DueVerdict.health` or
// `healthFromFailure`, and an exported name nobody imports is a name that drifts.
type SourceHealth = 'healthy' | 'transient' | 'needs_operator' | 'refused';

/**
 * The collector vocabulary → the remedy. A `Record` over the union rather than
 * a switch, so adding a `CollectFailure` member is a COMPILE ERROR here instead
 * of a silent fall-through into "retry it forever", which is the failure this
 * whole file exists to end.
 */
const HEALTH_BY_FAILURE: Record<CollectFailure, Exclude<SourceHealth, 'healthy'>> = {
  // Waiting is the fix.
  network: 'transient',
  rate_limited: 'transient',
  // A feed that parsed badly once usually parses next time; a feed that never
  // parses is caught by the never-succeeded fallback rather than by its reason.
  parse: 'transient',
  // A person edits `.env`. This process cannot see that happen.
  auth: 'needs_operator',
  not_configured: 'needs_operator',
  // The site said no. Not a fault, not ours to repair, and not to be worked
  // around — see the module header.
  blocked_by_policy: 'refused',
};

/** What a single failure means for whether asking again can possibly help. */
export function healthFromFailure(reason: CollectFailure): Exclude<SourceHealth, 'healthy'> {
  return HEALTH_BY_FAILURE[reason];
}

/** What the decision needs, and nothing else — so it is testable with a literal. */
export interface BackoffState {
  readonly consecutiveFailures: number;
  /** ISO instant of the last ATTEMPT (success or failure), or null if never tried. */
  readonly lastAttemptAt: string | null;
  /**
   * `source.last_ok_at !== null` — has this source EVER produced a collection?
   *
   * The one durable signal that separates "an outage" from "this has never
   * worked", and it needs no column the table does not already have.
   */
  readonly everSucceeded: boolean;
  /**
   * The reason on the most recent failure, when the caller can supply it.
   *
   * `null` is honest ignorance, not "no failure" — the streak says whether it
   * is failing. Nothing persists the reason yet, so the scheduler passes null
   * and the fallback in `sourceHealth` decides. See the module header.
   */
  readonly lastFailure: CollectFailure | null;
}

/**
 * The classification, from whatever the caller actually knows.
 *
 * ORDER MATTERS: the recorded reason always wins over the inference. A source
 * that has never succeeded but whose last failure was a timeout is still just
 * failing — inferring "needs a person" from its history would put a network
 * outage on an operator's to-do list, and a to-do list with nothing to do on it
 * is one nobody opens.
 */
export function sourceHealth(state: BackoffState): SourceHealth {
  if (state.consecutiveFailures <= 0) return 'healthy';
  if (state.lastFailure !== null) return healthFromFailure(state.lastFailure);
  if (!state.everSucceeded && state.consecutiveFailures >= UNPRODUCTIVE_AFTER) return 'needs_operator';
  return 'transient';
}

/**
 * How long to hold a source back after `n` consecutive failures.
 *
 * `jitter` is injected rather than read from `Math.random` so the curve is
 * pinned by a test. Production passes nothing.
 */
export function retryDelayMs(
  consecutiveFailures: number,
  jitter = Math.random(),
  health: SourceHealth = 'transient',
): number {
  const n = Math.max(0, Math.floor(consecutiveFailures));
  if (n === 0 || health === 'healthy') return 0;

  // Jitter applies to every hold, not only the curve: sources that broke
  // together (one provider, one expired key) would otherwise come back together
  // at exactly the moment the provider is recovering.
  const spread = Math.min(Math.max(jitter, 0), 1) * JITTER_RATIO;

  // FLAT, not capped-exponential. A wrong token and a `Disallow` line do not
  // become likelier to have been fixed the longer we have waited, so the only
  // thing an escalating curve would buy is a source that gets quieter the
  // longer an operator ignores it — the opposite of what a report wants.
  if (health !== 'transient') return Math.round(HUMAN_SCALE_RETRY_MS * (1 + spread));

  // `2 ** (n-1)` overflows to Infinity long before it matters, and Infinity
  // would survive `Math.min` as the cap — so clamp the exponent first.
  const doublings = Math.min(n - 1, 32);
  const base = Math.min(BASE_RETRY_MS * 2 ** doublings, MAX_RETRY_MS);
  return Math.round(base * (1 + spread));
}

interface DueVerdict {
  readonly due: boolean;
  /** Milliseconds still to wait. 0 when due. */
  readonly waitMs: number;
  /** Why it is being held, in the words the report prints. */
  readonly reason: string;
  /** What kind of broken, so the report can group by who has to act. */
  readonly health: SourceHealth;
}

/**
 * The held-source line an operator reads. It has to say who is expected to act,
 * because "backing off" reads as "the system is handling it" — which for two of
 * the three kinds is exactly false.
 */
function holdReason(state: BackoffState, health: SourceHealth, waitMs: number): string {
  const failures = state.consecutiveFailures;
  const left = `${Math.ceil(waitMs / 60_000)}m to go`;

  // INFERRED, SO SAY LESS. With no reason on record the streak only proves the
  // source has never worked — it cannot tell a dead token from a host that
  // declines us, and "needs a person" about a robots.txt refusal sends someone
  // off to fix something that is not theirs to fix. Name the evidence we have
  // and point at the log for the rest; overclaiming on an attention list is how
  // the list stops being read.
  if (state.lastFailure === null && health !== 'transient') {
    return `never worked: ${failures} straight failures and no success ever on record — held a day, reason in the event log; ${left}`;
  }

  switch (health) {
    case 'refused':
      return `refused by policy: ${failures} straight refusals — we do not fetch what a host declines; ${left}`;
    case 'needs_operator':
      return `needs a person: ${failures} straight failures, no retry will clear this; ${left}`;
    default:
      return `backing off: ${failures} consecutive failures, ${left}`;
  }
}

/**
 * The scheduling decision for ONE source.
 *
 * A source that has never been attempted is always due — that is the cold start,
 * and it is also the only case where `dueSources`' `last_ok_at nulls first`
 * ordering and this function agree by construction rather than by accident.
 */
export function dueVerdict(state: BackoffState, now: Date, jitter = Math.random()): DueVerdict {
  const health = sourceHealth(state);
  if (state.lastAttemptAt === null) return { due: true, waitMs: 0, reason: 'never collected', health };

  // NOTE: jitter is re-drawn every pass, so the effective deadline wobbles by up
  // to 20% between passes rather than being fixed once. That is harmless at this
  // depth (it can only ever move an attempt by a fifth of the delay) and it is
  // the price of storing no per-source retry deadline. If a stable deadline is
  // ever wanted, seed the jitter from the source id rather than the clock.
  const delay = retryDelayMs(state.consecutiveFailures, jitter, health);
  if (delay === 0) return { due: true, waitMs: 0, reason: 'healthy', health };

  const last = Date.parse(state.lastAttemptAt);
  // An unparseable stamp is treated as "no idea when we last tried", which must
  // fail toward attempting: silently never collecting is the worse failure.
  if (Number.isNaN(last)) return { due: true, waitMs: 0, reason: 'unreadable last attempt', health };

  const waitMs = last + delay - now.getTime();
  if (waitMs <= 0) {
    return { due: true, waitMs: 0, reason: `retry after ${state.consecutiveFailures} failures`, health };
  }

  return { due: false, waitMs, reason: holdReason(state, health, waitMs), health };
}
