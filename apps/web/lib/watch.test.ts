import { describe, expect, it } from 'vitest';
import { STAGES, STAGE_INFO, TABS, clamp, days, httpUrl, lineClass } from './watch';

describe('watch helpers', () => {
  it('colours only ok, failure and header lines', () => {
    expect(lineClass('  ok      briefing   2818ms')).toBe('ok');
    expect(lineClass('1 stage(s), all green.')).toBe('ok');
    expect(lineClass('  FAILED  watch  robots.txt refused')).toBe('bad');
    expect(lineClass('▶ briefing — the page')).toBe('hd');
    expect(lineClass('PASS SUMMARY')).toBe('hd');
    expect(lineClass('wrote /app/briefing.html')).toBe('');
  });
  it('describes every stage the console accepts', () => {
    expect(STAGES).toEqual(['all', 'collect', 'brain', 'watch', 'reason', 'resolve', 'digest', 'briefing']);
    for (const s of STAGES) expect(STAGE_INFO[s].why.length).toBeGreaterThan(10);
  });
  it('keeps the old dashboard’s six sections in order', () => {
    expect(TABS.map(t => t.id)).toEqual(['week', 'research', 'changed', 'competitors', 'forecasts', 'sources']);
  });
  it('formats streaks, clamps detail, and only links http(s)', () => {
    expect([days(null), days(0), days(1), days(9)]).toEqual(['', 'today', '1 day', '9 days']);
    expect(clamp('x'.repeat(300))).toHaveLength(200);
    expect(httpUrl('javascript:alert(1)')).toBeNull();
    expect(httpUrl('https://jiffy.ca/pricing')).toBe('https://jiffy.ca/pricing');
  });
});
