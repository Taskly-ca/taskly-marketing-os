import { describe, it, expect } from 'vitest';
import {
  recordFeedback,
  dismissMeaning,
  dismissalPressure,
  outcomeWeight,
  wrongnessIsSevere,
  ALL_DISMISS_REASONS,
} from './feedback.js';
import type { FeedbackEvent } from './feedback.js';

const AT = '2026-08-04T00:00:00.000Z';
const ok = (over: Partial<Parameters<typeof recordFeedback>[0]> = {}) =>
  recordFeedback({ findingId: 'f1', actor: 'human:nishant', action: 'viewed', at: AT, ...over });

describe('a dismissal must say why', () => {
  it('refuses an unreasoned dismissal', () => {
    // A dismiss button that accepts no reason trains everyone to use it, and
    // the resulting signal routes nowhere.
    const r = ok({ action: 'dismissed' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/needs a reason/);
  });

  it('accepts a reasoned one', () => {
    expect(ok({ action: 'dismissed', dismissReason: 'obvious' }).ok).toBe(true);
  });

  it('refuses a reason on a non-dismissal', () => {
    expect(ok({ action: 'saved', dismissReason: 'stale' }).ok).toBe(false);
  });

  it('requires an attributable actor', () => {
    expect(ok({ actor: 'someone' }).ok).toBe(false);
    expect(ok({ actor: 'agent:opus@4.5' }).ok).toBe(true);
  });
});

describe('each reason blames a different component', () => {
  it('routes all five somewhere distinct', () => {
    // This is the justification for a fixed list instead of free text: a
    // dismissal is a bug report addressed to a component, not a vote.
    const blamed = ALL_DISMISS_REASONS.map((r) => dismissMeaning(r).blames);
    expect(new Set(blamed).size).toBe(ALL_DISMISS_REASONS.length);
  });

  it('tells the system what to change, in words an owner can act on', () => {
    expect(dismissMeaning('obvious').blames).toBe('novelty');
    expect(dismissMeaning('obvious').correction).toMatch(/restated|history/i);
    expect(dismissMeaning('stale').blames).toBe('freshness');
    expect(dismissMeaning('stale').correction).toMatch(/latency|window/i);
  });

  it('separates "true but late" from "wrong"', () => {
    // Both are defects, but one is a collection-latency problem and the other
    // is a verification failure. Merging them hides which is happening.
    expect(dismissMeaning('stale').blames).not.toBe(dismissMeaning('wrong').blames);
  });
});

describe('aggregation names an owner, not a score', () => {
  const ev = (reason: FeedbackEvent['dismissReason']): FeedbackEvent => ({
    findingId: 'f',
    actor: 'human:nishant',
    action: 'dismissed',
    dismissReason: reason,
    at: AT,
  });

  it('groups pressure by the component to fix, most-pressed first', () => {
    const out = dismissalPressure([ev('obvious'), ev('obvious'), ev('stale')]);
    expect(out[0]).toMatchObject({ blames: 'novelty', count: 2 });
    expect(out[1]).toMatchObject({ blames: 'freshness', count: 1 });
  });

  it('ignores non-dismissals', () => {
    const viewed: FeedbackEvent = {
      findingId: 'f',
      actor: 'human:nishant',
      action: 'viewed',
      dismissReason: null,
      at: AT,
    };
    expect(dismissalPressure([viewed])).toEqual([]);
  });

  it('produces no single "quality percentage"', () => {
    // A number like "72% useful" gets reported upward and acted on by nobody,
    // because it names no owner.
    const out = dismissalPressure([ev('wrong')]);
    expect(out[0]).toHaveProperty('correction');
    expect(Object.keys(out[0]!)).not.toContain('score');
  });
});

describe('outcome signal strength', () => {
  it('treats acting on a finding as the only unambiguous success', () => {
    expect(outcomeWeight('acted_on')).toBe(1);
    expect(outcomeWeight('saved')).toBeLessThan(outcomeWeight('acted_on'));
    // A push is seen whether or not it was wanted, so a view says nothing.
    expect(outcomeWeight('viewed')).toBe(0);
    expect(outcomeWeight('dismissed')).toBe(0);
  });

  it('treats a wrong governed answer as more serious than a wrong guess', () => {
    expect(wrongnessIsSevere('governed_query')).toBe(true);
    expect(wrongnessIsSevere('verified_metric')).toBe(true);
    expect(wrongnessIsSevere('exploratory_unverified')).toBe(false);
  });
});
