import { describe, expect, it } from 'vitest';
import { findingSchema } from '@tmos/contracts';
import type { Finding } from '@tmos/contracts';
import {
  MATERIALITY_GATE,
  PREEMPTION_CAP,
  PREEMPTION_GATE,
  WEEKLY_PUSH_CAP,
  materiality,
  selectDigest,
} from './select.js';
import type { DeliveryRecord } from './select.js';

const NOW = new Date('2026-08-05T09:00:00Z');

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** Schema-valid by construction — a selector tested against a shape the
 *  contract would reject is a selector tested against nothing. */
const finding = (n: number, over: Partial<Finding> = {}): Finding =>
  findingSchema.parse({
    id: uuid(n),
    claim: `Jiffy listed a flat $189 rate for drain clearing in Toronto (${n}).`,
    so_what: 'Our drain price sits above theirs in the same postal codes.',
    subject_refs: ['competitor:jiffy'],
    evidence: [
      {
        signal_id: null,
        fact_id: null,
        source_url: 'https://example.com/jiffy/pricing',
        span: 'Drain clearing from $189, Toronto.',
        observed_at: '2026-08-01T09:00:00Z',
      },
    ],
    basis: 'governed_query',
    causal_rung: 0,
    stakes: 'high',
    region: 'ca',
    domain_score: 0.9,
    generated_by: 'agent:t2@1',
    reviewed_by: null,
    superseded_by: null,
    supersede_reason: null,
    created_at: `2026-08-0${(n % 4) + 1}T09:00:00Z`,
    ...over,
  });

const ids = (r: ReturnType<typeof selectDigest>) =>
  r.kind === 'digest' ? r.items.map((i) => i.finding.id) : [];

describe('the weekly cap is a cap, not a target', () => {
  it('pushes 3 of 4 excellent findings and names the one it held', () => {
    const candidates = [1, 2, 3, 4].map((n) => finding(n, { domain_score: 0.95 - n * 0.01 }));
    const r = selectDigest({ candidates, history: [], signalsExamined: 412, now: NOW });

    expect(r.kind).toBe('digest');
    if (r.kind !== 'digest') return;
    expect(r.items).toHaveLength(WEEKLY_PUSH_CAP);

    // The held one is identifiable — a system that drops work silently is
    // indistinguishable from a system that lost it.
    const heldForCap = r.held.filter((h) => h.reason === 'weekly_cap');
    expect(heldForCap).toHaveLength(1);
    expect(heldForCap[0]?.finding.id).toBe(uuid(4));
    expect(ids(r)).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it('counts deliveries already made this week against the cap', () => {
    const history: DeliveryRecord[] = [
      { findingId: uuid(90), deliveredAt: '2026-08-03T09:00:00Z' },
      { findingId: uuid(91), deliveredAt: '2026-08-04T09:00:00Z' },
    ];
    const r = selectDigest({
      candidates: [1, 2, 3].map((n) => finding(n, { domain_score: 0.95 - n * 0.01 })),
      history,
      signalsExamined: 100,
      now: NOW,
    });
    expect(ids(r)).toEqual([uuid(1)]);
  });

  it('ignores deliveries that fall outside the trailing week', () => {
    const history: DeliveryRecord[] = [
      { findingId: uuid(90), deliveredAt: '2026-07-01T09:00:00Z' },
      { findingId: uuid(91), deliveredAt: '2026-07-02T09:00:00Z' },
      { findingId: uuid(92), deliveredAt: '2026-07-03T09:00:00Z' },
    ];
    const r = selectDigest({
      candidates: [1, 2, 3].map((n) => finding(n)),
      history,
      signalsExamined: 100,
      now: NOW,
    });
    expect(ids(r)).toHaveLength(3);
  });
});

describe('a quiet week is a result, not an empty list', () => {
  it('returns `quiet` when nothing clears the bar, and says how much was checked', () => {
    const candidates = [1, 2].map((n) =>
      finding(n, { stakes: 'low', basis: 'exploratory_unverified', domain_score: 0.3 }),
    );
    const r = selectDigest({ candidates, history: [], signalsExamined: 1_284, now: NOW });

    expect(r.kind).toBe('quiet');
    if (r.kind !== 'quiet') return;
    // Silence must carry evidence of work, or the founder cannot tell a quiet
    // week from a broken pipeline.
    expect(r.checked).toBe(1_284);
    expect(r.reason).toBe('nothing_material');
    expect(r.held.every((h) => h.reason === 'below_gate')).toBe(true);
    expect(typeof r.since).toBe('string');
  });

  it('is quiet with an empty candidate set, and still reports the sweep', () => {
    const r = selectDigest({ candidates: [], history: [], signalsExamined: 77, now: NOW });
    expect(r.kind).toBe('quiet');
    if (r.kind !== 'quiet') return;
    expect(r.checked).toBe(77);
    expect(r.held).toHaveLength(0);
  });

  it('distinguishes "nothing material" from "cap already spent"', () => {
    const history: DeliveryRecord[] = [1, 2, 3].map((n) => ({
      findingId: uuid(80 + n),
      deliveredAt: `2026-08-0${n}T09:00:00Z`,
    }));
    const r = selectDigest({
      candidates: [finding(1, { stakes: 'medium', basis: 'inferred_from_sources' })],
      history,
      signalsExamined: 55,
      now: NOW,
    });
    expect(r.kind).toBe('quiet');
    if (r.kind !== 'quiet') return;
    expect(r.reason).toBe('weekly_cap_reached');
    // `since` is anchored to the last thing actually delivered.
    expect(r.since).toBe('2026-08-03T09:00:00Z');
  });
});

describe('what never ships', () => {
  it('never re-pushes a finding already delivered, however good it is', () => {
    const f = finding(1, { domain_score: 1 });
    const history: DeliveryRecord[] = [{ findingId: f.id, deliveredAt: '2026-06-01T09:00:00Z' }];
    const r = selectDigest({ candidates: [f], history, signalsExamined: 9, now: NOW });

    expect(r.kind).toBe('quiet');
    if (r.kind !== 'quiet') return;
    expect(r.held.map((h) => h.reason)).toEqual(['already_delivered']);
  });

  it('suppresses a superseded finding — a correction must not be outranked by what it corrects', () => {
    const stale = finding(1, { superseded_by: uuid(2), supersede_reason: 'price was misread' });
    const r = selectDigest({ candidates: [stale], history: [], signalsExamined: 9, now: NOW });

    expect(r.kind).toBe('quiet');
    if (r.kind !== 'quiet') return;
    expect(r.held.map((h) => h.reason)).toEqual(['superseded']);
  });

  it('holds anything below the materiality gate', () => {
    const weak = finding(1, { stakes: 'low', basis: 'inferred_from_sources', domain_score: 0.5 });
    expect(materiality(weak)).toBeLessThan(MATERIALITY_GATE);
    const r = selectDigest({ candidates: [weak], history: [], signalsExamined: 9, now: NOW });
    expect(r.kind).toBe('quiet');
  });
});

describe('materiality', () => {
  it('lets a high-stakes exploratory finding through — basis governs how it looks, not whether it is seen', () => {
    const f = finding(1, { stakes: 'high', basis: 'exploratory_unverified', domain_score: 1 });
    expect(materiality(f)).toBeGreaterThanOrEqual(MATERIALITY_GATE);
  });

  it('does not let a strong basis alone carry a trivial finding', () => {
    const f = finding(1, { stakes: 'low', basis: 'verified_metric', domain_score: 0.6 });
    expect(materiality(f)).toBeLessThan(MATERIALITY_GATE);
  });

  it('is monotone in domain_score', () => {
    const lo = finding(1, { domain_score: 0.4 });
    const hi = finding(1, { domain_score: 0.8 });
    expect(materiality(hi)).toBeGreaterThan(materiality(lo));
  });
});

describe('pre-emption is an exception, and exceptions are capped too', () => {
  const emergency = (n: number) =>
    finding(n, { stakes: 'high', basis: 'verified_metric', domain_score: 0.95 });

  const spentCap: DeliveryRecord[] = [1, 2, 3].map((n) => ({
    findingId: uuid(80 + n),
    deliveredAt: `2026-08-0${n}T09:00:00Z`,
  }));

  it('lets one verified, high-stakes finding past a spent cap', () => {
    const f = emergency(1);
    expect(materiality(f)).toBeGreaterThanOrEqual(PREEMPTION_GATE);
    const r = selectDigest({
      candidates: [f],
      history: spentCap,
      signalsExamined: 9,
      now: NOW,
    });
    expect(r.kind).toBe('digest');
    if (r.kind !== 'digest') return;
    expect(r.items).toHaveLength(PREEMPTION_CAP);
    expect(r.items[0]?.preempts).toBe(true);
  });

  it('allows only one pre-emption per week — a second is held', () => {
    const r = selectDigest({
      candidates: [emergency(1), emergency(2)],
      history: spentCap,
      signalsExamined: 9,
      now: NOW,
    });
    if (r.kind !== 'digest') throw new Error('expected a digest');
    expect(r.items).toHaveLength(1);
    expect(r.held.filter((h) => h.reason === 'weekly_cap')).toHaveLength(1);
  });

  it('refuses a second pre-emption when one was already spent this week', () => {
    const history: DeliveryRecord[] = [
      ...spentCap,
      { findingId: uuid(95), deliveredAt: '2026-08-04T09:00:00Z', preemptedCap: true },
    ];
    const r = selectDigest({ candidates: [emergency(1)], history, signalsExamined: 9, now: NOW });
    expect(r.kind).toBe('quiet');
  });

  it('never pre-empts on an unverifiable basis, however high the stakes', () => {
    // A rumour that pre-empts the cap is how a rumour becomes an emergency.
    const rumour = finding(1, {
      stakes: 'high',
      basis: 'exploratory_unverified',
      domain_score: 1,
    });
    const r = selectDigest({
      candidates: [rumour],
      history: spentCap,
      signalsExamined: 9,
      now: NOW,
    });
    expect(r.kind).toBe('quiet');
  });
});

describe('determinism', () => {
  const candidates = [1, 2, 3, 4, 5].map((n) => finding(n, { domain_score: 0.95 - n * 0.01 }));

  it('gives the same answer for the same input', () => {
    const a = selectDigest({ candidates, history: [], signalsExamined: 10, now: NOW });
    const b = selectDigest({ candidates, history: [], signalsExamined: 10, now: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not depend on input order', () => {
    const shuffled = [...candidates].reverse();
    const a = selectDigest({ candidates, history: [], signalsExamined: 10, now: NOW });
    const b = selectDigest({ candidates: shuffled, history: [], signalsExamined: 10, now: NOW });
    expect(ids(b)).toEqual(ids(a));
  });

  it('breaks an exact tie on age then id, never on arrival order', () => {
    const tied = [7, 6, 5].map((n) =>
      finding(n, { domain_score: 0.9, created_at: '2026-08-01T09:00:00Z' }),
    );
    const r = selectDigest({ candidates: tied, history: [], signalsExamined: 10, now: NOW });
    expect(ids(r)).toEqual([uuid(5), uuid(6), uuid(7)]);
  });
});
