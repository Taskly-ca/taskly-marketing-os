import { describe, it, expect } from 'vitest';
import { replay, MIN_REPLAY_PAIRS } from './replay.js';
import type { BlindItem, MemoryArm, Scorer, SystemPort } from './replay.js';

interface Q {
  id: string;
  text: string;
}
interface A {
  text: string;
}

const inputs = (n: number): Q[] =>
  Array.from({ length: n }, (_, i) => ({ id: `q${i}`, text: `question ${i}` }));

/** A system whose answer quality is a pure function of input + arm, so every
 *  test below is exact rather than approximate. */
const port = (
  quality: (input: Q, arm: MemoryArm) => number,
): SystemPort<Q, A> & { calls: Array<{ id: string; arm: MemoryArm }> } => {
  const calls: Array<{ id: string; arm: MemoryArm }> = [];
  return {
    calls,
    async run(input, memory) {
      calls.push({ id: input.id, arm: memory });
      return { text: String(quality(input, memory)) };
    },
  };
};

const scorer: Scorer<Q, A> = (item) => Number(item.output.text);

const memoryAlwaysBetter = (_: Q, arm: MemoryArm) => (arm === 'on' ? 2 : 1);
const identical = () => 1;

describe('the scorer is blind to the arm', () => {
  it('is handed nothing but a token, an input and an output', async () => {
    const seen: string[][] = [];
    const spy: Scorer<Q, A> = (item) => {
      // The type itself has no arm field; this is the runtime half of the claim.
      const keys = Object.keys(item).sort();
      seen.push(keys);
      expect(keys).not.toContain('memory');
      expect(keys).not.toContain('arm');
      return Number(item.output.text);
    };
    await replay(inputs(MIN_REPLAY_PAIRS), port(memoryAlwaysBetter), spy, { seed: 7 });
    expect(seen).toHaveLength(MIN_REPLAY_PAIRS * 2);
    for (const keys of seen) expect(keys).toEqual(['input', 'output', 'token']);
  });

  it('refuses to score at all when the system leaks its arm into the output', async () => {
    // The blindness has to be enforced, not assumed: a system that echoes its
    // own condition turns a blind comparison into an unblind one silently.
    const leaky: SystemPort<Q, { text: string; memory: MemoryArm }> = {
      async run(_input, memory) {
        return { text: '1', memory };
      },
    };
    await expect(
      replay(inputs(MIN_REPLAY_PAIRS), leaky, (i) => Number(i.output.text), { seed: 1 }),
    ).rejects.toThrow(/blind_violation/);
  });

  it('scores in an order uncorrelated with the arm', async () => {
    const order: string[] = [];
    const spy: Scorer<Q, A> = (item) => {
      order.push(item.token);
      return Number(item.output.text);
    };
    const r = await replay(inputs(MIN_REPLAY_PAIRS), port(memoryAlwaysBetter), spy, { seed: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(order).toEqual([...r.scoringOrder]);
    // Not the order the arms were run in.
    expect(order).not.toEqual([...order].sort());
  });
});

describe('paired and deterministic', () => {
  it('sends the same inputs through both arms', async () => {
    const p = port(memoryAlwaysBetter);
    await replay(inputs(MIN_REPLAY_PAIRS), p, scorer, { seed: 11 });
    const on = p.calls.filter((c) => c.arm === 'on').map((c) => c.id);
    const off = p.calls.filter((c) => c.arm === 'off').map((c) => c.id);
    expect(on).toEqual(off);
    expect(on).toHaveLength(MIN_REPLAY_PAIRS);
  });

  it('is identical run to run for the same seed — shuffle and result', async () => {
    const a = await replay(inputs(MIN_REPLAY_PAIRS), port(memoryAlwaysBetter), scorer, {
      seed: 42,
    });
    const b = await replay(inputs(MIN_REPLAY_PAIRS), port(memoryAlwaysBetter), scorer, {
      seed: 42,
    });
    expect(a).toEqual(b);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.scoringOrder).toEqual(b.scoringOrder);
  });

  it('changes the shuffle with the seed but not the conclusion', async () => {
    const a = await replay(inputs(MIN_REPLAY_PAIRS), port(memoryAlwaysBetter), scorer, { seed: 1 });
    const b = await replay(inputs(MIN_REPLAY_PAIRS), port(memoryAlwaysBetter), scorer, { seed: 2 });
    if (!a.ok || !b.ok) return;
    expect(a.scoringOrder).not.toEqual(b.scoringOrder);
    expect(a.lift.meanDiff).toBe(b.lift.meanDiff);
    expect(a.lift.verdict).toBe(b.lift.verdict);
  });
});

describe('how small is too small', () => {
  it('REFUSES a lift below the minimum n instead of reporting it with a caveat', async () => {
    const r = await replay(inputs(4), port(memoryAlwaysBetter), scorer, { seed: 5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('insufficient_pairs');
    expect(r.n).toBe(4);
    expect(r.minPairs).toBe(MIN_REPLAY_PAIRS);
    // No number at all — a lift on 4 examples is theatre, and a caveat on it is
    // a number people quote without the caveat.
    expect('lift' in r).toBe(false);
    expect(r.detail).toMatch(/4/);
  });

  it('takes the minimum as an injected value', async () => {
    const r = await replay(inputs(4), port(memoryAlwaysBetter), scorer, { seed: 5, minPairs: 4 });
    expect(r.ok).toBe(true);
  });

  it('still hands back the per-pair scores it refused to aggregate', async () => {
    const r = await replay(inputs(4), port(memoryAlwaysBetter), scorer, { seed: 5 });
    if (r.ok) return;
    expect(r.pairs).toHaveLength(4);
    expect(r.pairs[0]!.onScore).toBe(2);
    expect(r.pairs[0]!.offScore).toBe(1);
  });
});

describe('what the lift is allowed to say', () => {
  it('calls it for memory only when the interval clears zero', async () => {
    const r = await replay(inputs(24), port(memoryAlwaysBetter), scorer, { seed: 9 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lift.meanDiff).toBe(1);
    expect(r.lift.wins).toBe(24);
    expect(r.lift.ties).toBe(0);
    expect(r.lift.verdict).toBe('memory_helps');
    expect(r.lift.ci95[0]).toBeGreaterThan(0);
  });

  it('calls it against memory when memory is worse', async () => {
    const r = await replay(
      inputs(24),
      port((_, arm) => (arm === 'on' ? 1 : 2)),
      scorer,
      {
        seed: 9,
      },
    );
    if (!r.ok) return;
    expect(r.lift.meanDiff).toBe(-1);
    expect(r.lift.verdict).toBe('memory_hurts');
  });

  it('reports ties and never credits them to memory', async () => {
    const r = await replay(inputs(24), port(identical), scorer, { seed: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lift.ties).toBe(24);
    expect(r.lift.wins).toBe(0);
    expect(r.lift.meanDiff).toBe(0);
    expect(r.lift.verdict).toBe('no_detectable_difference');
    expect(r.lift.caveat).toMatch(/tie/i);
  });

  it('does not turn a coin flip into a lift', async () => {
    // 12 wins, 12 losses of the same size: mean zero, and no story.
    const alternating = (input: Q, arm: MemoryArm) => {
      const memoryWins = Number(input.id.slice(1)) % 2 === 0;
      if (arm === 'on') return memoryWins ? 2 : 1;
      return memoryWins ? 1 : 2;
    };
    const r = await replay(inputs(24), port(alternating), scorer, { seed: 6 });
    if (!r.ok) return;
    expect(r.lift.wins).toBe(12);
    expect(r.lift.losses).toBe(12);
    expect(r.lift.verdict).toBe('no_detectable_difference');
    expect(r.lift.ci95[0]).toBeLessThan(0);
  });

  it('states the uncertainty in the same breath as the number', async () => {
    const r = await replay(inputs(24), port(memoryAlwaysBetter), scorer, { seed: 9 });
    if (!r.ok) return;
    expect(r.lift.n).toBe(24);
    expect(r.lift.caveat.length).toBeGreaterThan(0);
    expect(r.lift.caveat).toMatch(/24 pair/);
  });

  it('counts a near-tie as a tie when a tolerance is given, and still does not credit it', async () => {
    const r = await replay(
      inputs(24),
      port((_, arm) => (arm === 'on' ? 1.0001 : 1)),
      scorer,
      {
        seed: 2,
        tieEpsilon: 0.001,
      },
    );
    if (!r.ok) return;
    expect(r.lift.ties).toBe(24);
    expect(r.lift.wins).toBe(0);
    expect(r.lift.verdict).toBe('no_detectable_difference');
  });
});

describe('the blind item itself', () => {
  it('is frozen, so a scorer cannot annotate its way to remembering an arm', async () => {
    const frozen: boolean[] = [];
    const spy: Scorer<Q, A> = (item: BlindItem<Q, A>) => {
      frozen.push(Object.isFrozen(item));
      return Number(item.output.text);
    };
    await replay(inputs(MIN_REPLAY_PAIRS), port(memoryAlwaysBetter), spy, { seed: 8 });
    expect(frozen.every(Boolean)).toBe(true);
  });
});
