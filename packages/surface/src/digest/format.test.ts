import { describe, expect, it, vi } from 'vitest';
import { findingSchema } from '@tmos/contracts';
import type { Finding } from '@tmos/contracts';
import { assertNoConfidenceNumber } from '../basis.js';
import {
  MAX_LINES,
  renderFinding,
  renderFindings,
  truncateLine,
  type FormatDeps,
} from './format.js';

import { assertHonest, assertCausalLanguage } from '@tmos/guardrails';

const deps: FormatDeps = { honesty: assertHonest, causal: assertCausalLanguage };
const BASE = 'https://tmos.example/app';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const finding = (over: Partial<Finding> = {}): Finding =>
  findingSchema.parse({
    id: uuid(1),
    claim: 'Jiffy listed a flat $189 rate for drain clearing in Toronto on 2026-07-28.',
    so_what: 'Our drain price sits 22% above theirs in the same postal codes.',
    subject_refs: ['competitor:jiffy'],
    evidence: [
      {
        signal_id: null,
        fact_id: null,
        source_url: 'https://jiffy.example/pricing',
        span: 'Drain clearing from $189, Toronto. Updated 2026-07-28.',
        observed_at: '2026-08-01T09:00:00Z',
      },
    ],
    basis: 'inferred_from_sources',
    causal_rung: 0,
    stakes: 'high',
    region: 'ca',
    domain_score: 0.9,
    generated_by: 'agent:t2@1',
    reviewed_by: null,
    superseded_by: null,
    supersede_reason: null,
    created_at: '2026-08-02T09:00:00Z',
    ...over,
  });

const render = (over: Partial<Finding> = {}, independentSources?: number) =>
  renderFinding({ finding: finding(over), deepLinkBase: BASE, independentSources }, deps);

describe('six lines, and the limit is the design', () => {
  it('renders no more than six lines', () => {
    const r = render({}, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendered.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(r.rendered.text.split('\n')).toHaveLength(r.rendered.lines.length);
  });

  it('always carries the claim, the so_what, the basis and a deep link', () => {
    const r = render({}, 2);
    if (!r.ok) throw new Error('expected a render');
    const text = r.rendered.text;
    expect(text).toContain('Jiffy listed a flat $189 rate');
    expect(text).toContain('Our drain price sits 22% above theirs');
    expect(text).toContain('Inferred from 2 independent sources');
    expect(text).toContain(`${BASE}/findings/${uuid(1)}`);
    expect(r.rendered.deepLink).toBe(`${BASE}/findings/${uuid(1)}`);
  });

  it('collapses embedded newlines instead of blowing the line budget', () => {
    // A claim with a newline in it would silently become two lines, and the
    // six-line contract would be true of the array and false of the message.
    const r = render({ claim: 'Jiffy cut its rate.\n\nToronto only.\nEffective 2026-08-01.' });
    if (!r.ok) throw new Error('expected a render');
    expect(r.rendered.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(r.rendered.lines[0]).toBe('Jiffy cut its rate. Toronto only. Effective 2026-08-01.');
  });

  it('is deterministic', () => {
    const a = render({}, 3);
    const b = render({}, 3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('basis is a category, never a number', () => {
  it('renders the category with the INDEPENDENT source count', () => {
    const r = render({ basis: 'inferred_from_sources' }, 3);
    if (!r.ok) throw new Error('expected a render');
    expect(r.rendered.text).toContain('Inferred from 3 independent sources');
    expect(r.rendered.text).not.toMatch(/%\s*(confiden|certain|sure)/i);
    expect(r.rendered.text).not.toMatch(/\b0\.\d+\b/);
  });

  it('says so when the sources collapse to none', () => {
    const r = render({ basis: 'inferred_from_sources' }, 0);
    if (!r.ok) throw new Error('expected a render');
    expect(r.rendered.text).toContain('no independent source');
  });

  it('never leaks domain_score into the rendered text', () => {
    const r = render({ domain_score: 0.87 }, 2);
    if (!r.ok) throw new Error('expected a render');
    expect(r.rendered.text).not.toContain('0.87');
  });

  it('passes the real assertNoConfidenceNumber for every basis', () => {
    for (const basis of [
      'verified_metric',
      'governed_query',
      'inferred_from_sources',
      'exploratory_unverified',
    ] as const) {
      const r = render({ basis }, 2);
      if (!r.ok) throw new Error(`expected a render for ${basis}`);
      expect(() => assertNoConfidenceNumber(r.rendered.text), basis).not.toThrow();
    }
  });
});

describe('refusal, not repair', () => {
  it('refuses a finding whose text would leak a confidence number', () => {
    const r = render({ claim: 'Jiffy is 87% confident its flat rate will hold through Q4.' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('confidence_number');
  });

  it('refuses the leak even when truncation would have hidden it', () => {
    // The dangerous version of this bug is the silent one: a leak that falls off
    // the end of a truncated line ships a rule violation that no test can see.
    // So the guard runs on the SOURCE text, before any trimming.
    const tail = 'Confidence: 92%.';
    const r = render({ so_what: `${'Toronto postal codes matter here. '.repeat(20)}${tail}` });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('confidence_number');
    expect(r.detail).toContain('92%');
  });

  it('refuses an unquoted trust claim, and accepts the same fact as a quoted span', () => {
    const banned = { claim: 'Jiffy now offers liability insurance on every job.' };
    expect(render(banned).ok).toBe(false);

    // The honest way to report it: the assertion is the source's, in its words.
    const quoted = render({
      claim: 'Jiffy added a new trust claim to its pricing page on 2026-07-28.',
      evidence: [
        {
          signal_id: null,
          fact_id: null,
          source_url: 'https://jiffy.example/pricing',
          span: 'Every job is covered by our liability insurance.',
          observed_at: '2026-08-01T09:00:00Z',
        },
      ],
    });
    expect(quoted.ok).toBe(true);
  });

  it('refuses causal language below rung 2', () => {
    const r = render({ claim: "Jiffy's price cut drove our Toronto conversion down." });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('causal');
  });

  it('allows the same sentence at rung 2', () => {
    const r = render({
      claim: "Jiffy's price cut drove our Toronto conversion down.",
      causal_rung: 2,
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a disabled gate outright — a no-op guard is a bug, not a soft pass', () => {
    const noop: FormatDeps = { honesty: () => {}, causal: () => {} };
    expect(() => renderFinding({ finding: finding(), deepLinkBase: BASE }, noop)).toThrow(
      /canary/i,
    );
  });
});

describe('truncation never splits a number', () => {
  /** Every numeric token surviving truncation must be one of the whole numbers
   *  the sentence actually contained. A half-number reads as a real, smaller
   *  number, which is worse than an omitted one. */
  const numbersAreWhole = (out: string, whole: string[], label: string) => {
    for (const token of out.match(/\$?\d[\d,.]*/g) ?? []) {
      expect(whole, `${label} → ${out}`).toContain(token);
    }
  };

  it.each([
    ['Jiffy raised its Toronto drain rate to $1,299.00 last week', ['$1,299.00']],
    ['Toronto volume reached 1,284,905 tasks in July', ['1,284,905']],
  ])('keeps a cited figure whole or drops it: %s', (line, whole) => {
    for (let max = 4; max <= line.length + 2; max++) {
      const out = truncateLine(line, max);
      expect(out.length, `max=${max}`).toBeLessThanOrEqual(Math.max(max, 1));
      numbersAreWhole(out, whole, `max=${max}`);
    }
  });

  it('drops a single oversized numeric token rather than halving it', () => {
    expect(truncateLine('$1,299,456.78', 6)).toBe('…');
  });

  it('does not split a number that contains a space', () => {
    expect(truncateLine('Rates moved 12 % this quarter', 15)).toBe('Rates moved…');
  });

  it('leaves text that fits completely alone', () => {
    expect(truncateLine('short enough', 40)).toBe('short enough');
  });
});

describe('batch rendering', () => {
  it('separates what rendered from what was refused, keeping order', () => {
    const out = renderFindings(
      [
        { finding: finding({ id: uuid(1) }), deepLinkBase: BASE, independentSources: 2 },
        {
          finding: finding({ id: uuid(2), claim: 'We are 99% certain of this.' }),
          deepLinkBase: BASE,
        },
        { finding: finding({ id: uuid(3) }), deepLinkBase: BASE, independentSources: 1 },
      ],
      deps,
    );
    expect(out.rendered.map((r) => r.id)).toEqual([uuid(1), uuid(3)]);
    expect(out.refused.map((r) => r.id)).toEqual([uuid(2)]);
  });

  it('runs the gate canary once, before reading any finding', () => {
    const honesty = vi.fn(assertHonest);
    renderFindings([], { honesty, causal: assertCausalLanguage });
    expect(honesty).toHaveBeenCalled();
  });
});
