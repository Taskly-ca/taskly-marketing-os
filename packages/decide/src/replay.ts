/**
 * Held-out replay: does accumulated memory make the system better, or only make
 * it feel better?
 *
 * The honest version of that question has three parts, and skipping any one of
 * them produces a number that flatters memory:
 *
 *   PAIRED — the same input through both arms, so a lift cannot come from one
 *            arm drawing easier examples.
 *   BLIND  — the scorer never learns which arm it is scoring. Unblinded scoring
 *            measures the scorer's expectations, and this system's whole claim
 *            is that memory helps, which is exactly the expectation.
 *   BOUNDED — a lift below a minimum n is refused outright, not reported with a
 *            caveat, because the caveat is dropped the first time the number is
 *            quoted.
 *
 * Deterministic given a seed: the shuffle, the token assignment and the scoring
 * order all come from the injected seed. A replay harness that cannot be re-run
 * to the same answer cannot measure anything.
 */

export type MemoryArm = 'on' | 'off';

export interface SystemPort<I, O> {
  run(input: I, memory: MemoryArm): Promise<O>;
}

/**
 * Everything the scorer is allowed to see. There is no arm field, and there is
 * no id it could correlate with one: `token` is assigned by a seeded shuffle.
 */
export interface BlindItem<I, O> {
  readonly token: string;
  readonly input: I;
  readonly output: O;
}

export type Scorer<I, O> = (item: BlindItem<I, O>) => number | Promise<number>;

export interface ReplayOptions {
  seed: number;
  /** Below this many pairs, no lift is reported at all. */
  minPairs?: number;
  /** |diff| ≤ this is a tie. Default 0: only exact ties count. */
  tieEpsilon?: number;
}

export interface PairResult<I> {
  input: I;
  onScore: number;
  offScore: number;
  /** on − off. Positive = memory did better on this input. */
  diff: number;
  verdict: 'memory_better' | 'memory_worse' | 'tie';
}

export interface Lift {
  n: number;
  meanDiff: number;
  sdDiff: number;
  stderr: number;
  /** Normal approximation. Indicative, not a p-value. */
  ci95: readonly [number, number];
  wins: number;
  losses: number;
  ties: number;
  verdict: 'memory_helps' | 'memory_hurts' | 'no_detectable_difference';
  caveat: string;
}

export type ReplayResult<I> =
  | {
      ok: true;
      lift: Lift;
      pairs: readonly PairResult<I>[];
      /** Tokens in the order the scorer saw them — the audit of the blinding. */
      scoringOrder: readonly string[];
    }
  | {
      ok: false;
      code: 'insufficient_pairs';
      n: number;
      minPairs: number;
      detail: string;
      /** Raw per-pair scores survive; only the aggregate is withheld. */
      pairs: readonly PairResult<I>[];
    };

/**
 * Twenty paired comparisons.
 *
 * At n = 20 a two-sided sign test can reach p < 0.05 (15 of 20 one way), and
 * the normal approximation used for the interval below is rough but not absurd.
 * Under it there is no arrangement of the data that distinguishes a real effect
 * from noise, so any number reported would be decoration. This is a floor for
 * REPORTING a lift, not for running a replay — the per-pair results still come
 * back and are still worth reading one by one.
 */
export const MIN_REPLAY_PAIRS = 20;

/** Keys that would tell the scorer which arm it is looking at. */
const ARM_KEY = /^(arm|memory|memoryarm|memory_arm)$/i;

/**
 * The blinding, enforced rather than assumed.
 *
 * A system that echoes its own condition into its output — trivially easy, e.g.
 * a debug field or a "using remembered context" preamble — turns a blind
 * comparison into an unblind one with no visible symptom. Throwing is right:
 * scoring anyway would produce a number that looks like the others.
 */
function assertBlind(value: unknown, path = 'item', depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (ARM_KEY.test(key)) {
      throw new Error(
        `blind_violation: ${path}.${key} would tell the scorer which arm produced this output`,
      );
    }
    assertBlind(child, `${path}.${key}`, depth + 1);
  }
}

/** mulberry32 — small, fast, and reproducible across runtimes. `Math.random()`
 *  is unavailable to this module by design. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * Run the held-out set through both arms and score the pooled outputs blind.
 *
 * Sequential on purpose: concurrent runs would make the order of side effects
 * (and therefore any stateful port) depend on scheduling rather than the seed.
 */
export async function replay<I, O>(
  inputs: readonly I[],
  port: SystemPort<I, O>,
  scorer: Scorer<I, O>,
  opts: ReplayOptions,
): Promise<ReplayResult<I>> {
  const rand = rng(opts.seed);
  const minPairs = opts.minPairs ?? MIN_REPLAY_PAIRS;
  const tieEpsilon = opts.tieEpsilon ?? 0;

  // Arm identity lives here and nowhere the scorer can reach.
  const runs: Array<{ pair: number; arm: MemoryArm; output: O }> = [];
  for (const arm of ['on', 'off'] as const) {
    for (let i = 0; i < inputs.length; i += 1) {
      runs.push({ pair: i, arm, output: await port.run(inputs[i] as I, arm) });
    }
  }

  // Tokens are drawn from a shuffled pool, so token order carries no arm
  // information even if the scorer sorts by it.
  const pool = shuffle(
    runs.map((_, i) => `item-${i}`),
    rand,
  );
  const identity = new Map<string, { pair: number; arm: MemoryArm }>();
  const items: Array<BlindItem<I, O>> = runs.map((r, i) => {
    const token = pool[i] as string;
    identity.set(token, { pair: r.pair, arm: r.arm });
    const item = Object.freeze({ token, input: inputs[r.pair] as I, output: r.output });
    assertBlind(item);
    return item;
  });

  const scored = new Map<string, number>();
  const scoringOrder: string[] = [];
  for (const item of shuffle(items, rand)) {
    scoringOrder.push(item.token);
    scored.set(item.token, await scorer(item));
  }

  // Re-associate only now.
  const onScores = new Map<number, number>();
  const offScores = new Map<number, number>();
  for (const [token, s] of scored) {
    const who = identity.get(token) as { pair: number; arm: MemoryArm };
    (who.arm === 'on' ? onScores : offScores).set(who.pair, s);
  }

  const pairs: PairResult<I>[] = inputs.map((input, i) => {
    const onScore = onScores.get(i) as number;
    const offScore = offScores.get(i) as number;
    const diff = onScore - offScore;
    const verdict =
      Math.abs(diff) <= tieEpsilon ? 'tie' : diff > 0 ? 'memory_better' : 'memory_worse';
    return { input, onScore, offScore, diff, verdict };
  });

  if (pairs.length < minPairs) {
    return {
      ok: false,
      code: 'insufficient_pairs',
      n: pairs.length,
      minPairs,
      detail: `${pairs.length} pairs — a memory-lift number computed on ${pairs.length} examples is theatre, so none is given (floor: ${minPairs})`,
      pairs,
    };
  }

  return { ok: true, lift: summarise(pairs), pairs, scoringOrder };
}

function summarise<I>(pairs: readonly PairResult<I>[]): Lift {
  const n = pairs.length;
  const diffs = pairs.map((p) => p.diff);
  const meanDiff = diffs.reduce((a, d) => a + d, 0) / n;
  const sdDiff =
    n < 2 ? 0 : Math.sqrt(diffs.reduce((a, d) => a + (d - meanDiff) ** 2, 0) / (n - 1));
  const stderr = sdDiff / Math.sqrt(n);
  const ci95: [number, number] = [meanDiff - 1.96 * stderr, meanDiff + 1.96 * stderr];

  const wins = pairs.filter((p) => p.verdict === 'memory_better').length;
  const losses = pairs.filter((p) => p.verdict === 'memory_worse').length;
  const ties = pairs.filter((p) => p.verdict === 'tie').length;

  // Ties are never credited: they count in n, they drag the mean toward zero,
  // and `wins > losses` cannot be satisfied by them. A tie is the system saying
  // memory made no difference, which is a result, not a near-win.
  let verdict: Lift['verdict'] = 'no_detectable_difference';
  if (ci95[0] > 0 && wins > losses) verdict = 'memory_helps';
  else if (ci95[1] < 0 && losses > wins) verdict = 'memory_hurts';

  const caveat =
    `${n} paired comparisons; ${wins} to memory, ${losses} against, ${ties} ties. ` +
    `Mean paired difference ${meanDiff.toFixed(4)} (95% CI ${ci95[0].toFixed(4)}…${ci95[1].toFixed(4)}, normal approximation).` +
    (n < 30 ? ' n is small — treat the interval as indicative, not as a p-value.' : '') +
    (sdDiff === 0 ? ' Zero variance across pairs — check the scorer discriminates at all.' : '') +
    (ties === n ? ' Every pair tied: this measured no difference, not a small one.' : '');

  return { n, meanDiff, sdDiff, stderr, ci95, wins, losses, ties, verdict, caveat };
}
