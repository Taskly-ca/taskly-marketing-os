import { describe, it, expect, vi } from 'vitest';
import { playbookSchema } from '@tmos/contracts';
import type { Playbook } from '@tmos/contracts';
import { evaluatePredicate, selectPlaybooks } from './select.js';
import type { Predicate, SelectOptions } from './select.js';

const NOW = '2026-08-05T00:00:00.000Z';

/** Parsed through the real schema, so a fixture can never drift from the contract. */
const pb = (over: Partial<Playbook> = {}): Playbook =>
  playbookSchema.parse({
    id: 'pb_answer_a_price_move',
    version: 1,
    title: 'Answer a competitor price move',
    intent: 'Publish a comparison within 48h of a visible price change.',
    status: 'proven',
    applies_when: [],
    excludes_when: [],
    params: {},
    steps: [{ n: 1, do: 'Draft the comparison', owner: 'agent' }],
    hypothesis: {
      metric: 'weekly_posts',
      direction: 'up',
      expected_effect: [2, 8],
      horizon_days: 14,
      min_n: 30,
    },
    kill_criteria: [{ field: 'weekly_posts', op: '<', value: 20 }],
    assumptions: [],
    decay_after_days: 90,
    ...over,
  });

const p = (field: string, op: Predicate['op'], value: unknown): Predicate => ({ field, op, value });

const opts = (over: Partial<SelectOptions> = {}): SelectOptions => ({ now: NOW, ...over });

const CTX = {
  channel: 'seo',
  budget_cents: 50_000,
  region: 'gta',
  competitor: { name: 'jiffy', price_move_pct: 12 },
  paused: false,
  owner: null,
};

describe('a predicate has three outcomes, not two', () => {
  it('= and != compare values, including nested paths and arrays', () => {
    expect(evaluatePredicate(p('channel', '=', 'seo'), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('channel', '=', 'ads'), CTX).outcome).toBe('unmatched');
    expect(evaluatePredicate(p('channel', '!=', 'ads'), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('competitor.name', '=', 'jiffy'), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('competitor.price_move_pct', '>', 10), CTX).outcome).toBe('matched');
  });

  it('orders numerically for < <= > >=', () => {
    expect(evaluatePredicate(p('budget_cents', '<', 60_000), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('budget_cents', '<=', 50_000), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('budget_cents', '>', 50_000), CTX).outcome).toBe('unmatched');
    expect(evaluatePredicate(p('budget_cents', '>=', 50_000), CTX).outcome).toBe('matched');
  });

  it('tests membership for in / not_in', () => {
    expect(evaluatePredicate(p('region', 'in', ['gta', 'ottawa']), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('region', 'in', ['ottawa']), CTX).outcome).toBe('unmatched');
    expect(evaluatePredicate(p('region', 'not_in', ['ottawa']), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('region', 'not_in', ['gta']), CTX).outcome).toBe('unmatched');
  });

  it('refuses to order a string — lexicographic compare makes "9" > "10" silently true', () => {
    const v = evaluatePredicate(p('channel', '<', 'zzz'), CTX);
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toBe('type_mismatch');

    const rhs = evaluatePredicate(p('budget_cents', '>', '10'), CTX);
    expect(rhs.outcome).toBe('unknown');
    expect(rhs.reason).toBe('type_mismatch');
  });

  it('refuses a non-finite number rather than letting NaN compare as false', () => {
    const v = evaluatePredicate(p('n', '<', 10), { n: Number.NaN });
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toBe('type_mismatch');
  });

  it('calls `in` against a non-array a malformed predicate, not a miss', () => {
    const v = evaluatePredicate(p('region', 'in', 'gta'), CTX);
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toBe('malformed_predicate');
  });

  it('a misspelled context key is UNKNOWN, never unmatched', () => {
    const v = evaluatePredicate(p('budget_cent', '>', 10), CTX);
    expect(v.outcome).toBe('unknown');
    expect(v.reason).toBe('field_missing');
    expect(v.outcome).not.toBe('unmatched');
  });

  it('does not let not_in on a missing field pass vacuously', () => {
    expect(evaluatePredicate(p('nope', 'not_in', ['x']), CTX).outcome).toBe('unknown');
    expect(evaluatePredicate(p('nope', '!=', 'x'), CTX).outcome).toBe('unknown');
  });

  it('treats an explicit null as an answer, and a missing key as no answer', () => {
    expect(evaluatePredicate(p('owner', '=', null), CTX).outcome).toBe('matched');
    expect(evaluatePredicate(p('missing_owner', '=', null), CTX).reason).toBe('field_missing');
  });

  it('explains itself in every branch', () => {
    for (const v of [
      evaluatePredicate(p('channel', '=', 'seo'), CTX),
      evaluatePredicate(p('nope', '=', 'seo'), CTX),
      evaluatePredicate(p('channel', '<', 1), CTX),
    ]) {
      expect(v.detail.length).toBeGreaterThan(0);
      expect(v.field.length).toBeGreaterThan(0);
    }
  });
});

describe('selection is applies_when ∧ ¬excludes_when', () => {
  it('selects when every applies_when matches and no veto fires', () => {
    const s = selectPlaybooks([pb({ applies_when: [p('channel', '=', 'seo')] })], CTX, opts());
    expect(s.selected.map((e) => e.id)).toEqual(['pb_answer_a_price_move']);
    expect(s.selected[0]?.verdict).toBe('selected');
  });

  it('treats an empty applies_when as unconditional', () => {
    const s = selectPlaybooks([pb()], CTX, opts());
    expect(s.selected).toHaveLength(1);
  });

  it('lets ONE excludes_when match veto any number of matched conditions', () => {
    const s = selectPlaybooks(
      [
        pb({
          applies_when: [
            p('channel', '=', 'seo'),
            p('region', '=', 'gta'),
            p('budget_cents', '>', 100),
          ],
          excludes_when: [p('paused', '=', false)],
        }),
      ],
      CTX,
      opts(),
    );
    expect(s.selected).toHaveLength(0);
    const e = s.rejected[0];
    expect(e?.verdict).toBe('excluded');
    expect(e?.appliesMatched).toBe(3);
    expect(e?.reason).toContain('veto');
  });

  it('surfaces an unknown in excludes_when as needs_context — a veto cannot be assumed clear', () => {
    const s = selectPlaybooks(
      [
        pb({
          applies_when: [p('channel', '=', 'seo')],
          excludes_when: [p('blacklisted', '=', true)],
        }),
      ],
      CTX,
      opts(),
    );
    expect(s.selected).toHaveLength(0);
    expect(s.needsContext[0]?.verdict).toBe('needs_context');
    expect(s.unansweredFields).toEqual(['blacklisted']);
  });

  it('fails the match on an unknown in applies_when, and names the field', () => {
    const s = selectPlaybooks([pb({ applies_when: [p('budget_cent', '>', 1)] })], CTX, opts());
    expect(s.selected).toHaveLength(0);
    expect(s.needsContext[0]?.verdict).toBe('needs_context');
    expect(s.needsContext[0]?.unansweredFields).toEqual(['budget_cent']);
  });

  it('prefers a definitive miss over an unanswerable one', () => {
    const s = selectPlaybooks(
      [pb({ applies_when: [p('channel', '=', 'ads'), p('nope', '=', 1)] })],
      CTX,
      opts(),
    );
    expect(s.rejected[0]?.verdict).toBe('not_applicable');
    // Still reported, so a typo is never silent even when the playbook is out.
    expect(s.unansweredFields).toEqual(['nope']);
  });

  it('never selects a retired playbook, however well it matches', () => {
    const s = selectPlaybooks(
      [pb({ status: 'retired', applies_when: [p('channel', '=', 'seo')] })],
      CTX,
      opts(),
    );
    expect(s.selected).toHaveLength(0);
    expect(s.rejected[0]?.verdict).toBe('retired');
  });

  it('selects a candidate but flags it unproven, so a caller can demand approval', () => {
    const s = selectPlaybooks([pb({ status: 'candidate' }), pb({ id: 'pb_proven' })], CTX, opts());
    const candidate = s.selected.find((e) => e.id === 'pb_answer_a_price_move');
    expect(candidate?.verdict).toBe('selected');
    expect(candidate?.unproven).toBe(true);
    expect(s.selected.find((e) => e.id === 'pb_proven')?.unproven).toBe(false);
  });
});

describe('decay is surfaced, never silently dropped', () => {
  const decaying = [pb({ id: 'pb_stale', decay_after_days: 30 })];

  it('flags a playbook past decay_after_days but keeps it selectable', () => {
    const s = selectPlaybooks(decaying, CTX, {
      now: NOW,
      lastSuccessAt: { pb_stale: '2026-05-01T00:00:00.000Z' },
    });
    expect(s.selected).toHaveLength(1);
    expect(s.selected[0]?.stale).toBe(true);
    expect(s.selected[0]?.daysSinceLastSuccess).toBe(96);
    expect(s.selected[0]?.reason).toContain('stale');
  });

  it('does not flag one still inside its window', () => {
    const s = selectPlaybooks(decaying, CTX, {
      now: NOW,
      lastSuccessAt: { pb_stale: '2026-07-30T00:00:00.000Z' },
    });
    expect(s.selected[0]?.stale).toBe(false);
    expect(s.selected[0]?.daysSinceLastSuccess).toBe(6);
  });

  it('treats never-run as new, not decayed', () => {
    const s = selectPlaybooks(decaying, CTX, opts());
    expect(s.selected[0]?.stale).toBe(false);
    expect(s.selected[0]?.daysSinceLastSuccess).toBeNull();
  });
});

describe('the selection is reproducible and consults nothing', () => {
  const many: Playbook[] = [
    pb({ id: 'pb_b', status: 'candidate' }),
    pb({ id: 'pb_a', applies_when: [p('channel', '=', 'seo')] }),
    pb({ id: 'pb_c' }),
    pb({ id: 'pb_a', version: 2, applies_when: [p('channel', '=', 'seo')] }),
  ];

  it('orders deterministically, independent of input order', () => {
    const forward = selectPlaybooks(many, CTX, opts());
    const reversed = selectPlaybooks([...many].reverse(), CTX, opts());
    expect(forward.evaluations.map((e) => `${e.id}@${e.version}`)).toEqual(
      reversed.evaluations.map((e) => `${e.id}@${e.version}`),
    );
    // proven before candidate; more matched conditions before fewer; id, then
    // newest version — a total order, so ties cannot reshuffle.
    expect(forward.selected.map((e) => `${e.id}@${e.version}`)).toEqual([
      'pb_a@2',
      'pb_a@1',
      'pb_c@1',
      'pb_b@1',
    ]);
  });

  it('returns the identical result for identical inputs', () => {
    expect(selectPlaybooks(many, CTX, opts())).toEqual(selectPlaybooks(many, CTX, opts()));
  });

  it('calls no model, no network and no ambient clock', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('selection must never reach the network');
    });
    const nowSpy = vi.fn(() => 0);
    const realNow = Date.now;
    const realRandom = Math.random;
    vi.stubGlobal('fetch', fetchSpy);
    Date.now = nowSpy;
    Math.random = () => {
      throw new Error('selection must be deterministic');
    };
    try {
      selectPlaybooks(many, CTX, opts());
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    // There is no port to inject an LLM through: (playbooks, context, opts).
    expect(selectPlaybooks.length).toBe(3);
  });

  it('refuses an unparseable clock instead of silently dating everything to 1970', () => {
    expect(() => selectPlaybooks(many, CTX, { now: 'yesterday' })).toThrow(RangeError);
  });
});
