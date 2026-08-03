/**
 * Proper scoring rules.
 *
 * Report Brier AND log, always — they fail differently: Brier is insensitive to
 * rare events, log punishes confident wrongness hard. And raw Brier is
 * uninterpretable on its own, so every score carries a BASELINE (how much
 * better than always-saying-50%) in bits.
 */

/** Probabilities are clamped on write, but clamp defensively here too — a log
 *  score of a 0 or 1 forecast is infinite and would poison every aggregate. */
const EPS = 0.01;
export const clampP = (p: number): number => Math.min(1 - EPS, Math.max(EPS, p));

export interface ResolvedForecast {
  /** The stated probability that the event happens. */
  p: number;
  /** 1 = happened, 0 = did not. Annulled forecasts must be filtered out first. */
  outcome: 0 | 1;
}

export interface Scores {
  brier: number;
  log: number;
  /** Bits better than a coin flip. Positive = skill, negative = worse than chance. */
  baseline: number;
  /** Bits better than the peers who answered the same question; null if alone. */
  peer: number | null;
}

/** Lower is better. Range 0..1. */
export const brier = ({ p, outcome }: ResolvedForecast): number => (clampP(p) - outcome) ** 2;

/** Lower is better. The probability assigned to what actually happened. */
export const logScore = ({ p, outcome }: ResolvedForecast): number =>
  -Math.log(probabilityOfOutcome({ p, outcome }));

export const probabilityOfOutcome = ({ p, outcome }: ResolvedForecast): number =>
  outcome === 1 ? clampP(p) : 1 - clampP(p);

/** log2(p_actual / 0.5). 0 = no better than chance; +1 = twice as good. */
export const baselineScore = (f: ResolvedForecast): number =>
  Math.log2(probabilityOfOutcome(f) / 0.5);

/** log2(p_actual / mean peer p_actual). Requires ≥1 peer on the same question. */
export function peerScore(
  f: ResolvedForecast,
  peers: ReadonlyArray<ResolvedForecast>,
): number | null {
  if (peers.length === 0) return null;
  const meanPeer =
    peers.reduce((acc, q) => acc + probabilityOfOutcome({ p: q.p, outcome: f.outcome }), 0) /
    peers.length;
  if (meanPeer <= 0) return null;
  return Math.log2(probabilityOfOutcome(f) / meanPeer);
}

export function score(f: ResolvedForecast, peers: ReadonlyArray<ResolvedForecast> = []): Scores {
  return {
    brier: brier(f),
    log: logScore(f),
    baseline: baselineScore(f),
    peer: peerScore(f, peers),
  };
}

export const meanBrier = (fs: ReadonlyArray<ResolvedForecast>): number =>
  fs.length === 0 ? Number.NaN : fs.reduce((a, f) => a + brier(f), 0) / fs.length;

/**
 * Murphy decomposition: Brier = Reliability − Resolution + Uncertainty.
 *
 * This is the diagnostic that matters, and the one most teams skip:
 *   high reliability  → we are overconfident (fixable by a calibration shift)
 *   low  resolution   → we say ~50% about everything: honest but useless
 * Startups almost always have the SECOND problem and mistake it for humility.
 */
export interface Decomposition {
  brier: number;
  reliability: number;
  resolution: number;
  uncertainty: number;
  /** Brier Skill Score = (resolution − reliability) / uncertainty. >0 = skill. */
  skill: number;
  bins: ReadonlyArray<{ lower: number; upper: number; n: number; meanP: number; observed: number }>;
}

export function decompose(fs: ReadonlyArray<ResolvedForecast>, binCount = 10): Decomposition {
  const n = fs.length;
  if (n === 0) {
    return {
      brier: NaN,
      reliability: NaN,
      resolution: NaN,
      uncertainty: NaN,
      skill: NaN,
      bins: [],
    };
  }
  const baseRate = fs.reduce((a, f) => a + f.outcome, 0) / n;

  const buckets: ResolvedForecast[][] = Array.from({ length: binCount }, () => []);
  for (const f of fs) {
    const idx = Math.min(binCount - 1, Math.floor(clampP(f.p) * binCount));
    buckets[idx]!.push(f);
  }

  let reliability = 0;
  let resolution = 0;
  const bins: Decomposition['bins'] = buckets.map((bucket, i) => {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    if (bucket.length === 0) return { lower, upper, n: 0, meanP: NaN, observed: NaN };
    const meanP = bucket.reduce((a, f) => a + clampP(f.p), 0) / bucket.length;
    const observed = bucket.reduce((a, f) => a + f.outcome, 0) / bucket.length;
    reliability += (bucket.length * (meanP - observed) ** 2) / n;
    resolution += (bucket.length * (observed - baseRate) ** 2) / n;
    return { lower, upper, n: bucket.length, meanP, observed };
  });

  const uncertainty = baseRate * (1 - baseRate);
  return {
    brier: meanBrier(fs),
    reliability,
    resolution,
    uncertainty,
    skill: uncertainty === 0 ? NaN : (resolution - reliability) / uncertainty,
    bins,
  };
}
