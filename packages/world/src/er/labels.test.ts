import { describe, it, expect, beforeEach } from 'vitest';
import { AUTO_MERGE } from './blocking.js';
import {
  DECISION_BOUNDARY,
  DEFAULT_TARGET_PRECISION,
  MIN_CALIBRATION_LABELS,
  MIN_CALIBRATION_POSITIVES,
  calibrate,
  createMemoryLabelStore,
  createReviewQueue,
  pairKey,
  regressionSuite,
  resetLabelIds,
  thresholdReport,
  usableLabels,
} from './labels.js';
import type { ErLabel, HumanVerdict } from './labels.js';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const label = (id: string, score: number, humanVerdict: HumanVerdict): ErLabel => ({
  id: `erl_${id}`,
  leftEntity: `e_${id}_l`,
  rightEntity: `e_${id}_r`,
  score,
  llmVerdict: null,
  llmRationale: null,
  humanVerdict,
  decidedBy: 'nishant',
  decidedAt: '2026-08-04T00:00:00.000Z',
});

/** 30 positives at 0.800..0.945 and 30 negatives at 0.300..0.735. */
const separableSet = (): ErLabel[] => [
  ...Array.from({ length: 30 }, (_v, i) => label(`p${i}`, round3(0.8 + i * 0.005), 'match')),
  ...Array.from({ length: 30 }, (_v, i) => label(`n${i}`, round3(0.3 + i * 0.015), 'no_match')),
];

beforeEach(() => {
  resetLabelIds();
});

describe('label store', () => {
  it('treats (A,B) and (B,A) as one pair', async () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
    const store = createMemoryLabelStore();
    await store.add({ ...label('x', 0.9, 'match'), leftEntity: 'a', rightEntity: 'b' });
    expect(await store.byPair('b', 'a')).not.toBeNull();
    expect(await store.all()).toHaveLength(1);
  });

  it('replaces a re-labelled pair instead of storing a contradiction', async () => {
    const store = createMemoryLabelStore();
    const first = await store.add({
      ...label('x', 0.9, 'match'),
      leftEntity: 'a',
      rightEntity: 'b',
    });
    const second = await store.add({
      ...label('x', 0.9, 'no_match'),
      leftEntity: 'b',
      rightEntity: 'a',
    });
    expect(second.id).toBe(first.id);
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.humanVerdict).toBe('no_match');
  });

  it('mints deterministic ids and never reads a clock', async () => {
    const store = createMemoryLabelStore();
    const a = await store.add({ ...label('x', 0.9, 'match'), leftEntity: 'a', rightEntity: 'b' });
    const b = await store.add({ ...label('y', 0.8, 'match'), leftEntity: 'c', rightEntity: 'd' });
    expect([a.id, b.id]).toEqual(['erl_000001', 'erl_000002']);
    // decidedAt is whatever the caller passed — the store invents no timestamps.
    expect(a.decidedAt).toBe('2026-08-04T00:00:00.000Z');
  });

  it('returns copies, so a caller cannot mutate the store through them', async () => {
    const store = createMemoryLabelStore();
    await store.add({ ...label('x', 0.9, 'match'), leftEntity: 'a', rightEntity: 'b' });
    const got = await store.byPair('a', 'b');
    if (got) got.humanVerdict = 'no_match';
    expect((await store.byPair('a', 'b'))?.humanVerdict).toBe('match');
  });
});

describe('review queue orders by information gain, not by score', () => {
  const q = () => {
    const queue = createReviewQueue();
    queue.enqueue({ leftEntity: 'a', rightEntity: 'b', score: 0.99 });
    queue.enqueue({ leftEntity: 'c', rightEntity: 'd', score: 0.86 });
    queue.enqueue({ leftEntity: 'e', rightEntity: 'f', score: 0.76 });
    return queue;
  };

  it('puts the pair nearest the decision boundary first', () => {
    // Boundary is 0.85. Distances: 0.14, 0.01, 0.09. Sorting by SCORE would put
    // 0.99 first — a pair the pipeline already gets right, whose label teaches
    // nothing and moves no threshold.
    expect(DECISION_BOUNDARY).toBeCloseTo(0.85, 12);
    expect(
      q()
        .pending()
        .map((p) => p.score),
    ).toEqual([0.86, 0.76, 0.99]);
  });

  it('honours a limit and a custom boundary', () => {
    expect(
      q()
        .pending(2)
        .map((p) => p.score),
    ).toEqual([0.86, 0.76]);
    const strict = createReviewQueue({ boundary: 0.98 });
    strict.enqueue({ leftEntity: 'a', rightEntity: 'b', score: 0.99 });
    strict.enqueue({ leftEntity: 'c', rightEntity: 'd', score: 0.76 });
    expect(strict.pending().map((p) => p.score)).toEqual([0.99, 0.76]);
  });

  it('dedupes a pair regardless of the order it is enqueued in', () => {
    const queue = createReviewQueue();
    queue.enqueue({ leftEntity: 'a', rightEntity: 'b', score: 0.8 });
    queue.enqueue({ leftEntity: 'b', rightEntity: 'a', score: 0.9 });
    expect(queue.size()).toBe(1);
    expect(queue.pending()[0]?.score).toBe(0.9);
  });

  it('drops a pair once it has been reviewed', () => {
    const queue = q();
    queue.resolve('d', 'c');
    expect(queue.size()).toBe(2);
    expect(queue.pending().map((p) => p.score)).toEqual([0.76, 0.99]);
  });

  it('is stable when two pairs sit equally far from the boundary', () => {
    const queue = createReviewQueue();
    queue.enqueue({ leftEntity: 'z', rightEntity: 'z2', score: 0.9 });
    queue.enqueue({ leftEntity: 'a', rightEntity: 'a2', score: 0.8 });
    expect(queue.pending().map((p) => p.leftEntity)).toEqual(['a', 'z']);
  });
});

describe('precision / recall arithmetic on a hand-built matrix', () => {
  const labels = [
    label('1', 0.9, 'match'),
    label('2', 0.85, 'match'),
    label('3', 0.82, 'no_match'),
    label('4', 0.7, 'match'),
    label('5', 0.6, 'no_match'),
    label('6', 0.5, 'no_match'),
  ];

  it('counts the matrix exactly', () => {
    const r = thresholdReport(labels, 0.8);
    expect({ tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn }).toEqual({ tp: 2, fp: 1, fn: 1, tn: 2 });
    expect(r.precision).toBeCloseTo(2 / 3, 12);
    expect(r.recall).toBeCloseTo(2 / 3, 12);
    expect(r.f1).toBeCloseTo(2 / 3, 12);
  });

  it('reports precision 0 — not 1 — when nothing is predicted a match', () => {
    // A rule that merges nothing has abstained, not achieved perfection.
    // Scoring it 1.0 would make the empty rule win every threshold search.
    const r = thresholdReport(labels, 1.1);
    expect(r.tp + r.fp).toBe(0);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
    expect(r.f1).toBe(0);
  });

  it('drops unsure labels from the matrix entirely', () => {
    const withUnsure = [...labels, label('7', 0.99, 'unsure'), label('8', 0.1, 'unsure')];
    expect(usableLabels(withUnsure)).toHaveLength(6);
    expect(thresholdReport(withUnsure, 0.8)).toEqual(thresholdReport(labels, 0.8));
  });
});

describe('calibrate abstains below the label floor', () => {
  it('returns null on 12 labels', () => {
    // A cutoff fitted on 12 labels is noise: one relabelled pair moves measured
    // precision by ~17 points, and the "best" threshold is whichever one
    // happens to sit between the two nearest scores.
    const twelve = separableSet().slice(0, 6).concat(separableSet().slice(30, 36));
    expect(twelve).toHaveLength(12);
    expect(calibrate(twelve)).toBeNull();
    expect(MIN_CALIBRATION_LABELS).toBe(50);
  });

  it('returns null when there are enough labels but too few positives', () => {
    const labels = [
      ...Array.from({ length: 5 }, (_v, i) => label(`p${i}`, 0.9, 'match')),
      ...Array.from({ length: 55 }, (_v, i) => label(`n${i}`, 0.4, 'no_match')),
    ];
    expect(labels.length).toBeGreaterThanOrEqual(MIN_CALIBRATION_LABELS);
    expect(calibrate(labels)).toBeNull();
    expect(MIN_CALIBRATION_POSITIVES).toBe(10);
  });

  it('does not count unsure labels toward the floor', () => {
    const labels = [
      ...separableSet().slice(0, 20),
      ...separableSet().slice(30, 59),
      ...Array.from({ length: 20 }, (_v, i) => label(`u${i}`, 0.9, 'unsure')),
    ];
    expect(labels).toHaveLength(69);
    expect(usableLabels(labels).length).toBeLessThan(MIN_CALIBRATION_LABELS);
    expect(calibrate(labels)).toBeNull();
  });
});

describe('calibrate suggests a threshold once it has evidence', () => {
  it('picks the LOWEST threshold reaching the target precision', () => {
    const out = calibrate(separableSet());
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.labelCount).toBe(60);
    expect(out.positives).toBe(30);
    expect(out.targetPrecision).toBe(DEFAULT_TARGET_PRECISION);
    // 0.735 is the top negative: including it gives 30/31 = 0.968 < 0.98.
    // 0.800 is the lowest positive: 30/30 = 1.000, and it keeps every match.
    expect(out.suggested?.threshold).toBe(0.8);
    expect(out.suggested?.precision).toBe(1);
    expect(out.suggested?.recall).toBe(1);
    expect(out.note).toContain('in-sample');
  });

  it('reports how the threshold in force today actually performs', () => {
    const out = calibrate(separableSet());
    // AUTO_MERGE = 0.95 is above every labelled positive here, so today's cutoff
    // merges nothing at all — exactly the kind of thing a guess hides.
    expect(out?.current.threshold).toBe(AUTO_MERGE);
    expect(out?.current.tp).toBe(0);
    expect(out?.current.recall).toBe(0);
  });

  it('honours a caller-supplied target and current threshold', () => {
    const out = calibrate(separableSet(), { targetPrecision: 0.9, currentThreshold: 0.8 });
    expect(out?.targetPrecision).toBe(0.9);
    expect(out?.current.threshold).toBe(0.8);
    expect(out?.current.precision).toBe(1);
    // 0.9 is reachable earlier than 0.98 — more recall for less precision.
    expect(out?.suggested?.threshold).toBeLessThanOrEqual(0.8);
    expect(out?.suggested?.precision).toBeGreaterThanOrEqual(0.9);
  });

  it('suggests nothing when no threshold reaches the target', () => {
    const labels = [
      ...Array.from({ length: 30 }, (_v, i) => label(`p${i}`, round3(0.5 + i * 0.01), 'match')),
      label('bad1', 0.99, 'no_match'),
      label('bad2', 0.97, 'no_match'),
      ...Array.from({ length: 20 }, (_v, i) => label(`n${i}`, round3(0.1 + i * 0.01), 'no_match')),
    ];
    const out = calibrate(labels);
    expect(out).not.toBeNull();
    expect(out?.suggested).toBeNull();
    expect(out?.note).toContain('the scorer, not the cutoff');
  });
});

describe('regressionSuite — the reason labels are stored at all', () => {
  const labels = [
    label('a', 0.9, 'match'),
    label('b', 0.88, 'match'),
    label('c', 0.4, 'no_match'),
    label('d', 0.2, 'no_match'),
  ];

  it('names the previously-correct decisions a change would break', () => {
    // A "better" scorer that happens to push one true match below the boundary.
    const out = regressionSuite(labels, (l) => (l.id === 'erl_b' ? 0.5 : l.score));
    expect(out.evaluated).toBe(4);
    expect(out.broke.map((c) => c.label.id)).toEqual(['erl_b']);
    expect(out.fixed).toEqual([]);
    expect(out.oldAccuracy).toBe(1);
    expect(out.newAccuracy).toBe(0.75);
    const broken = out.broke[0];
    expect(broken?.oldDecision).toBe('match');
    expect(broken?.newDecision).toBe('no_match');
    expect(broken?.newScore).toBe(0.5);
  });

  it('credits the decisions a change fixes', () => {
    const wrong = [label('a', 0.4, 'match'), label('b', 0.9, 'match')];
    const out = regressionSuite(wrong, () => 0.9);
    expect(out.fixed.map((c) => c.label.id)).toEqual(['erl_a']);
    expect(out.broke).toEqual([]);
    expect(out.oldAccuracy).toBe(0.5);
    expect(out.newAccuracy).toBe(1);
  });

  it('skips pairs that can no longer be scored rather than counting them wrong', () => {
    // An entity deleted since the label was written is not a regression.
    const out = regressionSuite(labels, (l) => (l.id === 'erl_c' ? null : l.score));
    expect(out.skipped).toBe(1);
    expect(out.evaluated).toBe(3);
    expect(out.broke).toEqual([]);
    expect(out.newAccuracy).toBe(1);
  });

  it('ignores unsure labels and reports the threshold it judged at', () => {
    const out = regressionSuite([...labels, label('u', 0.9, 'unsure')], (l) => l.score);
    expect(out.evaluated).toBe(4);
    expect(out.threshold).toBe(DECISION_BOUNDARY);
    const custom = regressionSuite(labels, (l) => l.score, { threshold: 0.95 });
    expect(custom.threshold).toBe(0.95);
    // The threshold is the decision RULE, applied to the old and new scores
    // alike — so raising it to 0.95 costs both true matches on both sides and
    // breaks nothing. `broke` isolates changes to the SCORER; the cost of
    // moving a threshold is `calibrate`'s question, not this one's.
    expect(custom.broke).toEqual([]);
    expect(custom.oldAccuracy).toBe(0.5);
    expect(custom.newAccuracy).toBe(0.5);
  });

  it('returns zeroed accuracy rather than NaN on an empty run', () => {
    const out = regressionSuite([], () => 0.9);
    expect(out.evaluated).toBe(0);
    expect(out.oldAccuracy).toBe(0);
    expect(out.newAccuracy).toBe(0);
  });
});
