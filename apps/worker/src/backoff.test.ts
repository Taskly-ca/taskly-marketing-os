import { describe, expect, it } from 'vitest';

import { BASE_RETRY_MS, JITTER_RATIO, MAX_RETRY_MS, dueVerdict, retryDelayMs } from './backoff.js';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const minutesAgo = (n: number): string => new Date(NOW.getTime() - n * 60_000).toISOString();

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
    expect(dueVerdict({ consecutiveFailures: 0, lastAttemptAt: null }, NOW, 0)).toMatchObject({
      due: true,
      reason: 'never collected',
    });
    // Even one carrying a failure streak: with no attempt on record there is
    // nothing to measure the hold from, and never collecting is the worse bug.
    expect(dueVerdict({ consecutiveFailures: 9, lastAttemptAt: null }, NOW, 0).due).toBe(true);
  });

  it('collects a healthy source on every pass', () => {
    expect(dueVerdict({ consecutiveFailures: 0, lastAttemptAt: minutesAgo(0) }, NOW, 0)).toMatchObject({
      due: true,
      reason: 'healthy',
    });
  });

  it('holds a failing source back, and reports how long is left', () => {
    const verdict = dueVerdict({ consecutiveFailures: 3, lastAttemptAt: minutesAgo(5) }, NOW, 0);
    expect(verdict.due).toBe(false);
    // 3 failures = 20 minutes, 5 elapsed.
    expect(verdict.waitMs).toBe(15 * 60_000);
    expect(verdict.reason).toContain('3 consecutive failures');
  });

  it('releases the hold once the delay has elapsed', () => {
    expect(dueVerdict({ consecutiveFailures: 3, lastAttemptAt: minutesAgo(21) }, NOW, 0).due).toBe(true);
  });

  it('recovers immediately when the streak is cleared — no ramp back up', () => {
    const failing = { consecutiveFailures: 6, lastAttemptAt: minutesAgo(1) };
    expect(dueVerdict(failing, NOW, 0).due).toBe(false);
    // `recordCollection` sets consecutive_failures = 0 on ANY success.
    expect(dueVerdict({ ...failing, consecutiveFailures: 0 }, NOW, 0).due).toBe(true);
  });

  it('attempts rather than stalls when the last-attempt stamp is unreadable', () => {
    expect(dueVerdict({ consecutiveFailures: 4, lastAttemptAt: 'not a date' }, NOW, 0)).toMatchObject({
      due: true,
      reason: 'unreadable last attempt',
    });
  });
});
