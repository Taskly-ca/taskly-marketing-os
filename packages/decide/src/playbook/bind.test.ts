import { describe, it, expect } from 'vitest';
import { playbookSchema } from '@tmos/contracts';
import type { Playbook } from '@tmos/contracts';
import { bindParams, bindingDrift } from './bind.js';
import type { BindResult, BoundParam, FactSheet } from './bind.js';

/**
 * The numbers are the ones on the generated FACT-SHEET (taskly-brain,
 * `npm run brain:facts`): commission 20%, poster fee floor $2.99, urgent boost
 * $5.00, HST 13%. They are INJECTED here, exactly as production must inject
 * them — this suite never asserts that the values are what they are, only that
 * whatever the sheet says is what gets bound.
 */
const SHEET: FactSheet = {
  COMMISSION_RATE: { value: 20, source: 'lib/marketplace/fees.ts#COMMISSION_RATE (0.2 → 20%)' },
  POSTER_FEE_FLOOR_CENTS: { value: 299, source: 'lib/marketplace/fees.ts' },
  URGENT_BOOST_CENTS: { value: 500, source: 'lib/marketplace/fees.ts' },
  HST_RATE_PCT: { value: 13, source: 'lib/marketplace/fees.ts#HST_RATE' },
  FEE_LABEL: { value: 'Trust & support fee', source: 'lib/marketplace/fees.ts' },
};

const pb = (params: Playbook['params']): Playbook =>
  playbookSchema.parse({
    id: 'pb_price_comparison_post',
    version: 3,
    title: 'Publish a fee comparison',
    intent: 'Convert price-sensitive posters with an honest side-by-side.',
    status: 'proven',
    applies_when: [],
    excludes_when: [],
    params,
    steps: [{ n: 1, do: 'Write the comparison', owner: 'agent' }],
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
  });

const ok = (r: BindResult): Record<string, BoundParam> => {
  if (!r.ok) throw new Error(`expected a binding, got: ${JSON.stringify(r.failures)}`);
  return r.bound;
};

const codes = (r: BindResult): string[] => (r.ok ? [] : r.failures.map((f) => f.code));

describe('a parameter binds to the fact sheet, not to a memory of it', () => {
  it("resolves derive_from: 'facts.COMMISSION_RATE' from the INJECTED sheet", () => {
    const r = bindParams(
      pb({ commission_pct: { type: 'int', derive_from: 'facts.COMMISSION_RATE', required: true } }),
      {},
      SHEET,
    );
    const bound = ok(r).commission_pct;
    expect(bound?.value).toBe(SHEET.COMMISSION_RATE?.value);
    expect(bound?.provenance).toBe('derived');
    expect(bound?.derived_from).toBe('facts.COMMISSION_RATE');
    expect(bound?.source).toBe(SHEET.COMMISSION_RATE?.source);
  });

  it('binds whatever the sheet holds today — a changed sheet changes the binding', () => {
    const spec = pb({
      floor_cents: {
        type: 'money_cents',
        derive_from: 'facts.POSTER_FEE_FLOOR_CENTS',
        required: true,
      },
    });
    expect(ok(bindParams(spec, {}, SHEET)).floor_cents?.value).toBe(299);
    const raised: FactSheet = {
      ...SHEET,
      POSTER_FEE_FLOOR_CENTS: { value: 349, source: 'lib/marketplace/fees.ts' },
    };
    expect(ok(bindParams(spec, {}, raised)).floor_cents?.value).toBe(349);
  });

  it('REFUSES to run when a derive_from cannot be resolved', () => {
    const r = bindParams(
      pb({ fee: { type: 'money_cents', derive_from: 'facts.NO_SUCH_FEE', required: true } }),
      {},
      SHEET,
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['unresolvable_derive_from']);
    if (!r.ok) expect(r.failures[0]?.detail).toContain('NO_SUCH_FEE');
  });

  it('refuses a derive_from outside the facts namespace', () => {
    const r = bindParams(
      pb({ fee: { type: 'money_cents', derive_from: 'memory.COMMISSION_RATE', required: true } }),
      {},
      SHEET,
    );
    expect(codes(r)).toEqual(['unresolvable_derive_from']);
  });

  it('does not let a caller literal shadow a derived param', () => {
    const r = bindParams(
      pb({ commission_pct: { type: 'int', derive_from: 'facts.COMMISSION_RATE', required: true } }),
      { commission_pct: 15 },
      SHEET,
    );
    expect(codes(r)).toEqual(['literal_shadows_derived']);
  });
});

describe('the declared type is enforced, because money is integer cents', () => {
  const money = (value: unknown): BindResult =>
    bindParams(
      pb({ fee_cents: { type: 'money_cents', required: true } }),
      { fee_cents: value },
      SHEET,
    );

  it('rejects a non-integer money_cents', () => {
    expect(codes(money(299.5))).toEqual(['not_an_integer']);
  });

  it('rejects a money_cents that is not a number at all', () => {
    expect(codes(money('299'))).toEqual(['type_mismatch']);
    expect(codes(money(Number.NaN))).toEqual(['type_mismatch']);
  });

  it('accepts an integer money_cents', () => {
    expect(ok(money(299)).fee_cents?.value).toBe(299);
  });

  it('refuses the raw 0.2 rate for an int param — the contract has no rate type', () => {
    const raw: FactSheet = { COMMISSION_RATE: { value: 0.2, source: 'lib/marketplace/fees.ts' } };
    const r = bindParams(
      pb({ commission: { type: 'int', derive_from: 'facts.COMMISSION_RATE', required: true } }),
      {},
      raw,
    );
    expect(codes(r)).toEqual(['not_an_integer']);
  });

  it('requires duration_days to be a positive whole number of days', () => {
    const days = (value: unknown): BindResult =>
      bindParams(
        pb({ window: { type: 'duration_days', required: true } }),
        { window: value },
        SHEET,
      );
    expect(codes(days(0))).toEqual(['not_positive']);
    expect(codes(days(-7))).toEqual(['not_positive']);
    expect(codes(days(1.5))).toEqual(['not_an_integer']);
    expect(ok(days(14)).window?.value).toBe(14);
  });

  it('holds an enum to its allowed set when one is given, and is open when not', () => {
    const spec = pb({ tone: { type: 'enum', required: true } });
    expect(
      codes(bindParams(spec, { tone: 'shouty' }, SHEET, { enums: { tone: ['plain', 'warm'] } })),
    ).toEqual(['enum_out_of_range']);
    expect(
      ok(bindParams(spec, { tone: 'warm' }, SHEET, { enums: { tone: ['plain', 'warm'] } })).tone
        ?.value,
    ).toBe('warm');
    expect(ok(bindParams(spec, { tone: 'anything' }, SHEET)).tone?.value).toBe('anything');
  });

  it('requires a ref to point at something', () => {
    const ref = (value: unknown): BindResult =>
      bindParams(pb({ belief: { type: 'ref', required: true } }), { belief: value }, SHEET);
    expect(codes(ref('   '))).toEqual(['empty_ref']);
    expect(codes(ref(''))).toEqual(['empty_ref']);
    expect(ok(ref('belief_7')).belief?.value).toBe('belief_7');
  });
});

describe('required, absent and null are three different things', () => {
  it('refuses a required param with no value and no derive_from', () => {
    expect(
      codes(bindParams(pb({ fee_cents: { type: 'money_cents', required: true } }), {}, SHEET)),
    ).toEqual(['required_param_missing']);
  });

  it('leaves an optional param simply absent — not bound, not null', () => {
    const r = bindParams(pb({ note: { type: 'text', required: false } }), {}, SHEET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.absent).toEqual(['note']);
      expect(Object.prototype.hasOwnProperty.call(r.bound, 'note')).toBe(false);
    }
  });

  it('treats an explicit null as a value, and a wrong one', () => {
    const r = bindParams(pb({ note: { type: 'text', required: false } }), { note: null }, SHEET);
    expect(codes(r)).toEqual(['type_mismatch']);
    if (!r.ok) expect(r.failures[0]?.detail).toContain('absen');
  });

  it('reports EVERY failure, so one run surfaces the whole repair list', () => {
    const r = bindParams(
      pb({
        a: { type: 'money_cents', required: true },
        b: { type: 'int', derive_from: 'facts.MISSING', required: true },
        c: { type: 'duration_days', required: true },
      }),
      { c: 0 },
      SHEET,
    );
    expect(codes(r)).toEqual([
      'required_param_missing',
      'unresolvable_derive_from',
      'not_positive',
    ]);
  });
});

describe('provenance is recorded per param, so "why 20%?" is answerable later', () => {
  it('distinguishes literal, derived and default', () => {
    const bound = ok(
      bindParams(
        pb({
          headline: { type: 'text', required: true },
          commission_pct: { type: 'int', derive_from: 'facts.COMMISSION_RATE', required: true },
          tone: { type: 'enum', required: false },
        }),
        { headline: 'What Taskly keeps' },
        SHEET,
        { defaults: { tone: 'plain' } },
      ),
    );
    expect(bound.headline?.provenance).toBe('literal');
    expect(bound.commission_pct?.provenance).toBe('derived');
    expect(bound.tone?.provenance).toBe('default');
    expect(bound.headline?.source).toBeUndefined();
    expect(bound.commission_pct?.source).toContain('fees.ts');
  });
});

describe('a re-run after a fee change shows the change', () => {
  const bindWith = (sheet: FactSheet): Record<string, BoundParam> =>
    ok(
      bindParams(
        pb({
          commission_pct: { type: 'int', derive_from: 'facts.COMMISSION_RATE', required: true },
          floor_cents: {
            type: 'money_cents',
            derive_from: 'facts.POSTER_FEE_FLOOR_CENTS',
            required: true,
          },
        }),
        {},
        sheet,
      ),
    );

  it('reports which param changed and from what to what', () => {
    const before = bindWith(SHEET);
    const after = bindWith({
      ...SHEET,
      COMMISSION_RATE: {
        value: 18,
        source: 'lib/marketplace/fees.ts#COMMISSION_RATE (0.18 → 18%)',
      },
    });
    const drift = bindingDrift(before, after);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.param).toBe('commission_pct');
    expect(drift[0]?.change).toBe('changed');
    expect(drift[0]?.from?.value).toBe(20);
    expect(drift[0]?.to?.value).toBe(18);
    expect(drift[0]?.detail).toContain('20 → 18');
    expect(drift[0]?.detail).toContain('fees.ts');
  });

  it('is empty when nothing moved', () => {
    expect(bindingDrift(bindWith(SHEET), bindWith(SHEET))).toEqual([]);
  });

  it('reports added and removed params, in a stable order', () => {
    const before = bindWith(SHEET);
    const after = ok(
      bindParams(
        pb({
          commission_pct: { type: 'int', derive_from: 'facts.COMMISSION_RATE', required: true },
          boost_cents: {
            type: 'money_cents',
            derive_from: 'facts.URGENT_BOOST_CENTS',
            required: true,
          },
        }),
        {},
        SHEET,
      ),
    );
    expect(bindingDrift(before, after).map((d) => [d.param, d.change])).toEqual([
      ['boost_cents', 'added'],
      ['floor_cents', 'removed'],
    ]);
  });

  it('reports a provenance change even when the number is identical', () => {
    const derived = ok(
      bindParams(
        pb({
          commission_pct: { type: 'int', derive_from: 'facts.COMMISSION_RATE', required: true },
        }),
        {},
        SHEET,
      ),
    );
    const typedByHand = ok(
      bindParams(
        pb({ commission_pct: { type: 'int', required: true } }),
        { commission_pct: 20 },
        SHEET,
      ),
    );
    const drift = bindingDrift(derived, typedByHand);
    expect(drift[0]?.change).toBe('provenance_changed');
    expect(drift[0]?.detail).toContain('literal');
  });
});
