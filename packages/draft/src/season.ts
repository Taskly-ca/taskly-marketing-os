/**
 * WHICH SEASONS ARE ACTIONABLE TODAY.
 *
 * A calendar is only useful if it speaks BEFORE the window opens. "Snow removal
 * season is here" in January is a fact everyone already has; "snow removal
 * opens in eight weeks and supply has to exist first" in September is a
 * decision. So a window becomes evidence during its LEAD-IN — from `leadWeeks`
 * before it starts until it ends — and is silent the rest of the year.
 *
 * ── THE WRAPPED WINDOW ─────────────────────────────────────────────────────
 *
 * Snow runs November → March, so `startsMonth > endsMonth`. Half the obvious
 * implementations get this wrong by testing `start <= m && m <= end`, which is
 * empty for every wrapped window — and the failure is silent: the calendar
 * simply never mentions winter, in a system built for a Canadian city.
 */
import type { SeasonWindow } from '@tmos/packs';

/** Inclusive month membership, correct across a year boundary. */
export function inWindow(month: number, startsMonth: number, endsMonth: number): boolean {
  return startsMonth <= endsMonth
    ? month >= startsMonth && month <= endsMonth
    : month >= startsMonth || month <= endsMonth;
}

/** Whole months from `month` forward to `target`, wrapping the year. */
export function monthsUntil(month: number, target: number): number {
  return (target - month + 12) % 12;
}

export interface ActiveSeason {
  readonly window: SeasonWindow;
  /** `open` — demand is live. `lead-in` — act now, it has not started. */
  readonly phase: 'open' | 'lead-in';
  readonly weeksAway: number;
}

/**
 * The windows worth mentioning on `now`, soonest first.
 *
 * A month is ~4.35 weeks; the approximation is deliberate. `leadWeeks` is a
 * planning horizon someone chose, not a measurement, and computing it to the
 * day would dress a judgement call as precision.
 */
export function activeSeasons(
  calendar: readonly SeasonWindow[] | undefined,
  now: Date,
): ActiveSeason[] {
  if (!calendar || calendar.length === 0) return [];
  const month = now.getUTCMonth() + 1;
  const out: ActiveSeason[] = [];

  for (const w of calendar) {
    if (inWindow(month, w.startsMonth, w.endsMonth)) {
      out.push({ window: w, phase: 'open', weeksAway: 0 });
      continue;
    }
    const weeksAway = Math.round(monthsUntil(month, w.startsMonth) * 4.35);
    if (weeksAway <= w.leadWeeks) out.push({ window: w, phase: 'lead-in', weeksAway });
  }

  return out.sort((a, b) => a.weeksAway - b.weeksAway);
}

export function describeSeason(s: ActiveSeason): string {
  return s.phase === 'open'
    ? `Demand for ${s.window.name} is open now. ${s.window.why}`
    : `Demand for ${s.window.name} opens in about ${s.weeksAway} week${s.weeksAway === 1 ? '' : 's'}, and needs ${s.window.leadWeeks} weeks of lead time. ${s.window.why}`;
}
