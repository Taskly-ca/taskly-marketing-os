import { describe, it, expect } from 'vitest';
import {
  checkCausalLanguage,
  assertCausalLanguage,
  CausalLanguageError,
  MIN_CAUSAL_RUNG,
} from './causal.js';

/** Fixture corpus. Every phrase here has appeared in real marketing analysis
 *  and every one asserts causation without an experiment behind it. */
const BANNED_AT_RUNG_0 = [
  'The Instagram push caused a 12% lift in signups.',
  'Our blog post drove 400 new visitors.',
  'The pricing change resulted in more offers.',
  'The competitor launch led to a dip in our traffic.',
  'Signups rose because of the seasonal campaign.',
  'Traffic fell due to the algorithm update.',
  'Thanks to the referral push, bookings doubled.',
  'The rebrand impacted conversion.',
  'The discount boosted completion rate.',
  'The uplift is attributable to the new hero copy.',
  'The nav change is responsible for the bounce drop.',
];

describe('causal lint', () => {
  it.each(BANNED_AT_RUNG_0)('blocks causal phrasing at rung 0: %s', (text) => {
    const r = checkCausalLanguage(text, 0);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations[0]!.suggest).toBeTruthy();
  });

  it('still blocks at rung 1 — pre-registration is not causal inference', () => {
    expect(checkCausalLanguage('The campaign caused a lift.', 1).ok).toBe(false);
  });

  it('ALLOWS causal language from rung 2 up — a randomised holdout earns it', () => {
    for (const rung of [2, 3, 4] as const) {
      expect(checkCausalLanguage('The holdout shows the campaign caused a 6% lift.', rung).ok).toBe(
        true,
      );
    }
    expect(MIN_CAUSAL_RUNG).toBe(2);
  });

  it('permits honest observational phrasing at rung 0', () => {
    const ok = [
      'Signups rose 12% in the week following the Instagram push.',
      'The traffic dip coincided with the competitor launch.',
      'Offer volume is associated with weekday posting.',
      'This is consistent with a seasonal effect.',
    ];
    for (const t of ok) expect(checkCausalLanguage(t, 0).ok).toBe(true);
  });

  it('does not rewrite a source we are quoting verbatim', () => {
    const text = 'Their post claims "our launch caused a surge in demand" — unverified.';
    expect(checkCausalLanguage(text, 0).ok).toBe(true);
  });

  it('reports every violation with a position and a concrete replacement', () => {
    const r = checkCausalLanguage('It caused a lift and led to more signups.', 0);
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0]!.index).toBeLessThan(r.violations[1]!.index);
  });

  it('throws a usable error on the generation path', () => {
    expect(() => assertCausalLanguage('The push caused growth.', 0)).toThrow(CausalLanguageError);
    try {
      assertCausalLanguage('The push caused growth.', 0);
    } catch (e) {
      expect((e as Error).message).toContain('associated with');
    }
    expect(() => assertCausalLanguage('The push caused growth.', 2)).not.toThrow();
  });

  it('is not fooled by substrings — "becauseless" is not "because of"', () => {
    expect(checkCausalLanguage('The causeway metric is flat.', 0).ok).toBe(true);
  });
});
