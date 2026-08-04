import { describe, it, expect } from 'vitest';
import { checkHonesty, assertHonest, isNegated, TAKE_RATE_PERCENT } from './honesty.js';

const poster = (t: string) => checkHonesty(t, 'poster_facing');

describe('forbidden claims — untrue on every surface', () => {
  it.each([
    ['criminal background checks on every Tasker', /criminal/i],
    ['all Taskers are background-checked', /background check/i],
    ['covered by $2M liability insurance', /insurance/i],
    ['our satisfaction guarantee has you covered', /guarantee/i],
    ['Taskers are enrolled in our WSIB program', /WSIB/i],
    ['we do trade-licence verification', /licence/i],
    ['24-hour payouts, every time', /payout/i],
    ['fully vetted professionals', /vetted/i],
  ])('blocks %j', (text, reason) => {
    const r = poster(text);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.severity).toBe('forbidden_claim');
    expect(r.violations.some((v) => reason.test(v.reason))).toBe(true);
  });

  it('blocks them on INTERNAL surfaces too', () => {
    // An internal doc asserting we carry insurance is how the claim reaches
    // customer copy six months later, laundered through a "source".
    expect(checkHonesty('we are covered by liability insurance', 'internal').ok).toBe(false);
    expect(checkHonesty('CPIC check on file', 'legal').ok).toBe(false);
  });
});

describe('negation — the sentences that STATE the boundary must pass', () => {
  it('allows honest denials', () => {
    // Every one of these is a true sentence we need to be able to write. This
    // exact false positive already bit the trust-word sweep in taskly.ca.
    for (const honest of [
      'Taskly does not run criminal background checks.',
      'We do NOT do background checks — Stripe Identity is ID-only.',
      'There is no liability insurance and no property-damage guarantee.',
      'Taskers are never described as vetted professionals.',
      'No WSIB program exists.',
      'Identity verification is not a criminal-history check.',
    ]) {
      expect(poster(honest), honest).toMatchObject({ ok: true });
    }
  });

  it('detects a negator inside the window and not outside it', () => {
    const t = 'we do not offer insurance';
    expect(isNegated(t, t.indexOf('insurance'))).toBe(true);
    const far = `no. ${'x'.repeat(80)} insurance included`;
    expect(isNegated(far, far.indexOf('insurance'))).toBe(false);
  });

  it('still blocks the positive claim in the same document', () => {
    const mixed =
      'We do not run criminal background checks. Every Tasker carries $2M liability insurance.';
    const r = poster(mixed);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.match.toLowerCase()).toContain('insur');
  });
});

describe('quoted text is reported, not asserted', () => {
  it('allows quoting a competitor’s claim', () => {
    // A Finding whose whole point is "Jiffy now advertises insurance" must be
    // writable, or the system cannot report the market.
    const r = poster('Jiffy\'s new homepage says "every job is covered by $2M insurance".');
    expect(r.ok).toBe(true);
  });
});

describe('surface words — right word, wrong audience', () => {
  it('blocks "escrow" in poster copy', () => {
    const r = poster('Your payment is held in escrow.');
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.severity).toBe('surface_word');
    expect(r.violations[0]!.instead).toMatch(/held by Taskly/);
  });

  it('ALLOWS "escrow" in Terms and internally — it is the accurate legal term', () => {
    // A context-blind checker fires on every legal page and gets switched off,
    // taking the forbidden-claim checks with it.
    expect(checkHonesty('Funds are held in escrow until release.', 'legal').ok).toBe(true);
    expect(checkHonesty('the escrow release path', 'internal').ok).toBe(true);
  });

  it('blocks handpicked and pros poster-side', () => {
    expect(poster('handpicked pros near you').ok).toBe(false);
  });

  it('allows "commission" tasker-side but not poster-side', () => {
    expect(checkHonesty('Your commission is deducted at release.', 'tasker_facing').ok).toBe(true);
    expect(poster('our commission is deducted').ok).toBe(false);
  });
});

describe('the take rate is a factual claim, not a number', () => {
  it(`allows ${TAKE_RATE_PERCENT}%`, () => {
    expect(poster(`Taskly's ${TAKE_RATE_PERCENT}% take rate keeps the lights on`).ok).toBe(true);
  });

  it('blocks any other stated rate', () => {
    const r = poster('we charge a 15% take rate');
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.reason).toContain(`${TAKE_RATE_PERCENT}%`);
  });
});

describe('fail-closed', () => {
  it('treats an unknown surface as the strictest one', () => {
    const r = checkHonesty('held in escrow', 'marketing-email-v2');
    expect(r.surface).toBe('poster_facing');
    expect(r.ok).toBe(false);
  });

  it('assertHonest throws so the gate cannot be silently ignored', () => {
    expect(() => assertHonest('$2M insurance included', 'poster_facing')).toThrow(/honesty gate/);
    expect(() => assertHonest('Reviewed & approved Taskers.', 'poster_facing')).not.toThrow();
  });

  it('reports every violation with an offset a reviewer can jump to', () => {
    const text = 'handpicked pros, fully insured, 30% take rate';
    const r = poster(text);
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
    expect(r.violations.map((v) => v.index)).toEqual(
      [...r.violations.map((v) => v.index)].sort((a, b) => a - b),
    );
    for (const v of r.violations)
      expect(text.slice(v.index).toLowerCase()).toContain(v.match.toLowerCase().slice(0, 4));
  });
});

describe('the approved language passes clean', () => {
  it('accepts the real, shipped trust claims', () => {
    // BRAND-VOICE §5 "Do claim (all real, all shipped)".
    const copy = [
      'Every Tasker is reviewed and approved before they can take a job.',
      'Identity-verified with a government photo ID and a selfie.',
      "Taskly holds this money for you. It goes to your Tasker only when you tap 'Task done'.",
      'Door codes confirm the right Tasker turned up.',
      'Calls are routed through Taskly, so neither side sees the other’s number.',
      'A real person decides disputes.',
    ].join(' ');
    expect(poster(copy)).toMatchObject({ ok: true });
  });
});
