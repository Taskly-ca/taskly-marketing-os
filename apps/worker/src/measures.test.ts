/**
 * The instrument's own tests.
 *
 * The case that matters most is the one that already happened: a small count
 * answered differently on an unchanged page, minted as a Finding, and read by a
 * human as a competitor move. Nothing below can stop a model counting badly —
 * what it can do is make sure a measure nobody can hold to its span never
 * reaches the ledger, and that a measure which CAN be held to one is.
 */
import { describe, expect, it } from 'vitest';

import { UNSTATED, marketingCanada, publishes, type Measure } from '@tmos/packs';

import { acceptAnswer } from './measures.js';

/** The pack's question set — the data these rules are applied to. */
const COMMON = marketingCanada.targets[0]?.measures ?? [];

const bounded: Measure = {
  predicate: 'serves_canada',
  datatype: 'text',
  unit: null,
  question: 'q',
  answer: 'bounded',
  allowed: ['yes', 'no', UNSTATED],
};

const quoted: Measure = {
  predicate: 'lowest_advertised_price',
  datatype: 'text',
  unit: null,
  question: 'q',
  answer: 'quoted',
};

const open: Measure = {
  predicate: 'service_categories_count',
  datatype: 'num',
  unit: 'count',
  question: 'q',
  answer: 'open',
};

describe('publishes', () => {
  it('lets bounded and quoted measures report a change', () => {
    expect(publishes(bounded)).toBe(true);
    expect(publishes(quoted)).toBe(true);
  });

  it('never lets an open measure report one', () => {
    expect(publishes(open)).toBe(false);
  });

  it('keeps the two measures that drifted, as recording-only', () => {
    const byPredicate = new Map(COMMON.map((m) => [m.predicate, m]));
    // Kept, not deleted: a month of stable readings is what would justify
    // promoting either one, and deleting them throws away that evidence.
    expect(byPredicate.get('service_categories_count')?.answer).toBe('open');
    expect(byPredicate.get('cities_listed')?.answer).toBe('open');
  });

  it('gives every bounded measure a complete answer set', () => {
    for (const m of COMMON.filter((x) => x.answer === 'bounded')) {
      expect(m.allowed, m.predicate).toBeDefined();
      expect(m.allowed?.length ?? 0, m.predicate).toBeGreaterThan(1);
      expect(m.allowed, m.predicate).toContain(UNSTATED);
    }
  });
});

describe('acceptAnswer — bounded', () => {
  it('accepts an answer on the menu, normalised', () => {
    expect(acceptAnswer(bounded, '  Yes ', 'irrelevant')).toEqual({ ok: true, value: 'yes' });
  });

  it('refuses an off-menu answer, because the next rewording reads as a change', () => {
    const got = acceptAnswer(bounded, 'yes, for Toronto', 'irrelevant');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.why).toMatch(/not one of yes \| no \| unstated/);
  });

  it('does not consult the span — a bounded answer is a reading, not a quote', () => {
    expect(acceptAnswer(bounded, 'no', '')).toEqual({ ok: true, value: 'no' });
  });
});

describe('acceptAnswer — quoted', () => {
  it('accepts a value that is in its own span', () => {
    const got = acceptAnswer(quoted, 'from $49/hr', 'Book a Tasker in Toronto from $49/hr today.');
    expect(got).toEqual({ ok: true, value: 'from $49/hr' });
  });

  it('refuses a price the span does not contain', () => {
    const got = acceptAnswer(quoted, '$39/hr', 'Book a Tasker in Toronto from $49/hr today.');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.why).toMatch(/does not appear in the span/);
  });

  it('accepts the one sentinel, because absence has no span', () => {
    expect(acceptAnswer(quoted, 'unstated', 'no prices anywhere on this page')).toEqual({
      ok: true,
      value: UNSTATED,
    });
  });
});

describe('acceptAnswer — open', () => {
  it('accepts the value so the history is still recorded', () => {
    expect(acceptAnswer(open, 5, 'Home Cleaning Furniture Assembly TV Mounting')).toEqual({
      ok: true,
      value: '5',
    });
  });

  it('refuses an empty answer whatever the kind', () => {
    for (const m of [bounded, quoted, open]) {
      expect(acceptAnswer(m, '   ', 'span').ok, m.predicate).toBe(false);
    }
  });
});
