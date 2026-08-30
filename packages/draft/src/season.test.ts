/**
 * The calendar, and the bug it would otherwise ship with.
 *
 * Snow runs November → March. Every naive `start <= m && m <= end` returns
 * false for every month of that window, so the calendar simply never mentions
 * winter — in a system built for Toronto, silently, forever.
 */
import { describe, expect, it } from 'vitest';

import { activeSeasons, describeSeason, inWindow, monthsUntil } from './season.js';
import type { SeasonWindow } from '@tmos/packs';

const snow: SeasonWindow = {
  name: 'snow removal', startsMonth: 11, endsMonth: 3, leadWeeks: 8,
  why: 'weather-triggered demand, supply must exist first',
};
const spring: SeasonWindow = {
  name: 'spring cleaning', startsMonth: 3, endsMonth: 5, leadWeeks: 4, why: 'the annual spike',
};
const utc = (month: number): Date => new Date(Date.UTC(2026, month - 1, 15));

describe('inWindow', () => {
  it('handles an ordinary window', () => {
    expect(inWindow(4, 3, 5)).toBe(true);
    expect(inWindow(6, 3, 5)).toBe(false);
  });

  it('handles a window that wraps the new year — the whole reason this exists', () => {
    for (const m of [11, 12, 1, 2, 3]) expect(inWindow(m, 11, 3)).toBe(true);
    for (const m of [4, 6, 9, 10]) expect(inWindow(m, 11, 3)).toBe(false);
  });
});

describe('monthsUntil', () => {
  it('counts forward across the year boundary', () => {
    expect(monthsUntil(9, 11)).toBe(2);
    expect(monthsUntil(12, 3)).toBe(3);
    expect(monthsUntil(11, 11)).toBe(0);
  });
});

describe('activeSeasons', () => {
  it('reports a window as open while it is running', () => {
    const [s] = activeSeasons([snow], utc(1));
    expect(s?.phase).toBe('open');
  });

  it('warns during the lead-in, which is the only time it is useful', () => {
    // September: snow is ~9 weeks out, inside the 8-week lead… just outside.
    // October is ~4 weeks out and must warn.
    const [s] = activeSeasons([snow], utc(10));
    expect(s?.phase).toBe('lead-in');
    expect(s?.weeksAway).toBeGreaterThan(0);
  });

  it('stays silent well outside the window', () => {
    // June: snow is five months away. Saying so every day is how a calendar
    // becomes noise and gets ignored the month it matters.
    expect(activeSeasons([snow], utc(6))).toEqual([]);
  });

  it('sorts the soonest first', () => {
    const r = activeSeasons([snow, spring], utc(2));
    expect(r[0]?.window.name).toBe('snow removal');
  });

  it('returns nothing for a domain with no calendar — the platform pack', () => {
    expect(activeSeasons(undefined, utc(1))).toEqual([]);
    expect(activeSeasons([], utc(1))).toEqual([]);
  });
});

describe('describeSeason', () => {
  it('leads with the lead time, because that is the actionable part', () => {
    const [s] = activeSeasons([snow], utc(10));
    expect(describeSeason(s!)).toMatch(/opens in about \d+ weeks/);
    expect(describeSeason(s!)).toMatch(/8 weeks of lead time/);
  });
});
