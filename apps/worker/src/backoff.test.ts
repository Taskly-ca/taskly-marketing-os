import { describe, expect, it } from 'vitest';

import type { CollectFailure } from '@tmos/collectors';

import {
  BASE_RETRY_MS,
  HUMAN_SCALE_RETRY_MS,
  JITTER_RATIO,
  MAX_RETRY_MS,
  UNPRODUCTIVE_AFTER,
  dueVerdict,
  healthFromFailure,
  retryDelayMs,
  sourceHealth,
  type BackoffState,
} from './backoff.js';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW.getTime() - n * 60_000).toISOString();
const hoursAgo = (n: number): string => new Date(NOW.getTime() - n * 3_600_000).toISOString();

/**
 * A source in the ordinary case: it has worked before, so a failure streak is
 * evidence of an outage rather than of a source that never worked at all.
 */
const state = (over: Partial<BackoffState> = {}): BackoffState => ({
  consecutiveFailures: 0,
  lastAttemptAt: minutesAgo(1),
  everSucceeded: true,
  lastFailure: null,
  ...over,
});

describe('retryDelayMs', () => {
  it('does not hold back a healthy source at all — cadence belongs to the scheduler', () => {
    expect(retryDelayMs(0, 0)).toBe(0);
    expect(retryDelayMs(0, 1)).toBe(0);
  });

  it('doubles per consecutive failure from the base', () => {
    expect(retryDelayMs(1, 0)).toBe(BASE_RETRY_MS);
    expect(retryDelayMs(2, 0)).toBe(BASE_RETRY_MS * 2);
    expect(retryDelayMs(3, 0)).toBe(BASE_RETRY_MS * 4);
    expect(retryDelayMs(4, 0)).toBe(BASE_RETRY_MS * 8);
  });

  it('caps, so a deep streak cannot turn a transient outage into a permanent one', () => {
    expect(retryDelayMs(20, 0)).toBe(MAX_RETRY_MS);
    // The pathological input that would reach Infinity through `2 ** n`.
    expect(retryDelayMs(10_000, 0)).toBe(MAX_RETRY_MS);
    expect(Number.isFinite(retryDelayMs(10_000, 1))).toBe(true);
  });

  it('adds jitter on top and never subtracts it — backoff must not retry sooner', () => {
    expect(retryDelayMs(1, 1)).toBe(Math.round(BASE_RETRY_MS * (1 + JITTER_RATIO)));
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      expect(retryDelayMs(3, r)).toBeGreaterThanOrEqual(BASE_RETRY_MS * 4);
      expect(retryDelayMs(3, r)).toBeLessThanOrEqual(BASE_RETRY_MS * 4 * (1 + JITTER_RATIO));
    }
  });

  it('is monotonic in the failure count up to the cap', () => {
    let previous = -1;
    for (let n = 0; n <= 8; n++) {
      const delay = retryDelayMs(n, 0);
      expect(delay).toBeGreaterThan(previous);
      previous = delay;
    }
  });
});

describe('dueVerdict', () => {
  it('always collects a source that has never been attempted', () => {
    expect(dueVerdict(state({ lastAttemptAt: null }), NOW, 0)).toMatchObject({
      due: true,
      reason: 'never collected',
    });
    // Even one carrying a failure streak: with no attempt on record there is
    // nothing to measure the hold from, and never collecting is the worse bug.
    expect(dueVerdict(state({ consecutiveFailures: 9, lastAttemptAt: null }), NOW, 0).due).toBe(true);
  });

  it('collects a healthy source on every pass', () => {
    expect(dueVerdict(state({ lastAttemptAt: minutesAgo(0) }), NOW, 0)).toMatchObject({
      due: true,
      reason: 'healthy',
    });
  });

  it('holds a failing source back, and reports how long is left', () => {
    const verdict = dueVerdict(state({ consecutiveFailures: 3, lastAttemptAt: minutesAgo(5) }), NOW, 0);
    expect(verdict.due).toBe(false);
    // 3 failures = 20 minutes, 5 elapsed.
    expect(verdict.waitMs).toBe(15 * 60_000);
    expect(verdict.reason).toContain('3 consecutive failures');
  });

  it('releases the hold once the delay has elapsed', () => {
    expect(dueVerdict(state({ consecutiveFailures: 3, lastAttemptAt: minutesAgo(21) }), NOW, 0).due).toBe(true);
  });

  it('recovers immediately when the streak is cleared — no ramp back up', () => {
    const failing = state({ consecutiveFailures: 6 });
    expect(dueVerdict(failing, NOW, 0).due).toBe(false);
    // `recordCollection` sets consecutive_failures = 0 on ANY success.
    expect(dueVerdict({ ...failing, consecutiveFailures: 0 }, NOW, 0).due).toBe(true);
  });

  it('attempts rather than stalls when the last-attempt stamp is unreadable', () => {
    expect(dueVerdict(state({ consecutiveFailures: 4, lastAttemptAt: 'not a date' }), NOW, 0)).toMatchObject({
      due: true,
      reason: 'unreadable last attempt',
    });
  });
});

/**
 * ── THE FAILURE TAXONOMY ────────────────────────────────────────────────────
 *
 * Written against the live state of 2026-08-30, where three sources had been
 * failing on every pass for over a week and the report said the same thing
 * about all three. These tests are the specification of the difference.
 */
describe('healthFromFailure', () => {
  it('calls a policy refusal `refused` — a site that says no is not a fault to retry', () => {
    expect(healthFromFailure('blocked_by_policy')).toBe('refused');
  });

  it('calls a credential failure `needs_operator` — no retry has ever fixed a dead token', () => {
    expect(healthFromFailure('auth')).toBe('needs_operator');
    expect(healthFromFailure('not_configured')).toBe('needs_operator');
  });

  it('leaves the genuinely retryable kinds to the curve', () => {
    expect(healthFromFailure('network')).toBe('transient');
    expect(healthFromFailure('rate_limited')).toBe('transient');
    expect(healthFromFailure('parse')).toBe('transient');
  });

  it('has an answer for every member of CollectFailure', () => {
    // If the collector union grows a member, the map in backoff.ts stops
    // compiling — this asserts the runtime half, that none maps to undefined.
    const every: readonly CollectFailure[] = [
      'network', 'rate_limited', 'auth', 'parse', 'blocked_by_policy', 'not_configured',
    ];
    for (const reason of every) expect(healthFromFailure(reason)).not.toBeUndefined();
  });
});

describe('sourceHealth', () => {
  it('is healthy while nothing is failing, whatever the history says', () => {
    expect(sourceHealth(state({ consecutiveFailures: 0, everSucceeded: false }))).toBe('healthy');
  });

  it('prefers the recorded reason over any inference', () => {
    expect(sourceHealth(state({ consecutiveFailures: 1, lastFailure: 'blocked_by_policy' }))).toBe('refused');
    expect(sourceHealth(state({ consecutiveFailures: 1, lastFailure: 'auth' }))).toBe('needs_operator');
    // One network failure on a source that has never worked is still transient
    // when the reason is on record: the reason outranks the inference.
    expect(sourceHealth(state({ consecutiveFailures: 9, everSucceeded: false, lastFailure: 'network' }))).toBe('transient');
  });

  it('treats a short streak on a source that has worked before as an outage', () => {
    expect(sourceHealth(state({ consecutiveFailures: UNPRODUCTIVE_AFTER + 5 }))).toBe('transient');
  });

  it('escalates a source that has failed repeatedly and NEVER once succeeded', () => {
    // The fallback that does the work today, because no reason is persisted.
    // A source with no success on record is not having a bad afternoon.
    expect(sourceHealth(state({ consecutiveFailures: UNPRODUCTIVE_AFTER, everSucceeded: false }))).toBe('needs_operator');
    expect(sourceHealth(state({ consecutiveFailures: UNPRODUCTIVE_AFTER - 1, everSucceeded: false }))).toBe('transient');
  });
});

describe('retryDelayMs — the hold depends on who can fix it', () => {
  it('holds a transient failure on the 6h curve, as before', () => {
    expect(retryDelayMs(2, 0, 'transient')).toBe(BASE_RETRY_MS * 2);
    expect(retryDelayMs(20, 0, 'transient')).toBe(MAX_RETRY_MS);
  });

  it('holds a credential failure for a day, not for six hours', () => {
    // The fix is a human editing `.env`, which this process cannot observe. A
    // day is the shortest interval that stops per-pass noise and still picks up
    // a token replaced this morning without anyone remembering `--force`.
    expect(retryDelayMs(1, 0, 'needs_operator')).toBe(HUMAN_SCALE_RETRY_MS);
    expect(retryDelayMs(40, 0, 'needs_operator')).toBe(HUMAN_SCALE_RETRY_MS);
  });

  it('holds a policy refusal for a day too — flat, never escalating', () => {
    expect(retryDelayMs(1, 0, 'refused')).toBe(HUMAN_SCALE_RETRY_MS);
    expect(retryDelayMs(99, 0, 'refused')).toBe(HUMAN_SCALE_RETRY_MS);
  });

  it('still holds nothing back when the source is healthy', () => {
    expect(retryDelayMs(0, 0, 'needs_operator')).toBe(0);
    expect(retryDelayMs(3, 0, 'healthy')).toBe(0);
  });

  it('jitters the human-scale hold too, so a provider outage does not resynchronise', () => {
    expect(retryDelayMs(1, 1, 'refused')).toBe(Math.round(HUMAN_SCALE_RETRY_MS * (1 + JITTER_RATIO)));
  });
});

/**
 * The three sources that were failing every pass on 2026-08-30, exactly as the
 * `source` table held them. This is the regression: before this change all
 * three were on the same 6h curve as a network blip.
 */
describe('dueVerdict — the live failures of 2026-08-30', () => {
  const NINE_DAYS_OF_PASSES = [1, 2, 4, 8, 12, 20, 23];

  it('parks a robots-refused source instead of asking again on the next pass', () => {
    // rss:hpac-magazine — 7 consecutive failures, last_ok_at null, every one
    // `blocked_by_policy: robots.txt disallows /feed/`.
    const hpac = state({ consecutiveFailures: 7, everSucceeded: false, lastFailure: 'blocked_by_policy' });
    for (const h of NINE_DAYS_OF_PASSES) {
      const verdict = dueVerdict({ ...hpac, lastAttemptAt: hoursAgo(h) }, NOW, 0);
      expect(verdict.due).toBe(false);
      expect(verdict.health).toBe('refused');
      expect(verdict.reason).toContain('refused');
    }
    // A day later it asks once — robots.txt is the site's to change, and we
    // would otherwise never notice if it did.
    expect(dueVerdict({ ...hpac, lastAttemptAt: hoursAgo(25) }, NOW, 0).due).toBe(true);
  });

  it('parks GDELT the same way while its robots.txt is unreadable', () => {
    // Fail-closed: unknown rules are refused rules. Same verdict, and the
    // detail string in the event log is what tells the two apart.
    const gdelt = state({ consecutiveFailures: 6, everSucceeded: false, lastFailure: 'blocked_by_policy', lastAttemptAt: hoursAgo(6) });
    expect(dueVerdict(gdelt, NOW, 0)).toMatchObject({ due: false, health: 'refused' });
  });

  it('names Product Hunt as needing a person, not as a source having a bad day', () => {
    // 4 straight `auth` failures, `invalid_oauth_token`, since 2026-08-23.
    const ph = state({ consecutiveFailures: 4, everSucceeded: false, lastFailure: 'auth', lastAttemptAt: hoursAgo(6) });
    const verdict = dueVerdict(ph, NOW, 0);
    expect(verdict.due).toBe(false);
    expect(verdict.health).toBe('needs_operator');
    expect(verdict.reason).toContain('needs a person');
  });

  it('reaches the same verdicts with no reason on record, which is the state today', () => {
    // Nothing persists the failure reason yet, so the schedule runs on
    // `last_ok_at` + the streak. All three are still held off the pass.
    for (const failures of [7, 6, 4]) {
      const blind = state({ consecutiveFailures: failures, everSucceeded: false, lastFailure: null, lastAttemptAt: hoursAgo(6) });
      const verdict = dueVerdict(blind, NOW, 0);
      expect(verdict).toMatchObject({ due: false, health: 'needs_operator' });
      // …but it does NOT claim to know whose problem it is. The streak proves
      // the source has never worked and nothing more; saying "needs a person"
      // about a robots.txt refusal sends someone to fix what is not theirs.
      expect(verdict.reason).toContain('never worked');
      expect(verdict.reason).not.toContain('needs a person');
    }
  });

  it('still puts a healthy source on every pass — four of the nine were fine', () => {
    // rss:globalnews-toronto, rss:financial-post, rss:betakit, both hn:*.
    const healthy = state({ consecutiveFailures: 0, lastAttemptAt: minutesAgo(1) });
    expect(dueVerdict(healthy, NOW, 0)).toMatchObject({ due: true, health: 'healthy' });
  });
});
