/**
 * How much a source is worth, and how much a pile of agreeing sources is worth.
 *
 * Two independent ideas, both of which have one obvious wrong answer:
 *
 *  1. Scoring a source by its success RATE, or by its POSTERIOR MEAN. The rate
 *     is worst — one correct claim is "100% reliable" and beats 190/200. The
 *     mean shrinks that, but a short perfect run still wins: 20/20 scores 0.955
 *     against a veteran's 0.946. We score on the LOWER credible bound instead,
 *     so being untested costs you: 1/1 ⇒ 0.22, 20/20 ⇒ 0.87, 190/200 ⇒ 0.92.
 *  2. Counting corroboration by counting sources. Ten outlets republishing one
 *     press release is ONE piece of evidence. Counting it as ten is precisely
 *     how a single fabricated claim becomes "widely reported" — so copy chains
 *     collapse to their roots BEFORE anything is counted.
 */

export interface BetaPosterior {
  alpha: number;
  beta: number;
}

/**
 * Beta(1,1) — uniform, two pseudo-observations of weight. It matches the
 * `source.reliability_alpha/beta` defaults in migration 001, and the choice
 * barely matters here precisely because we score on a lower bound rather than a
 * mean: under Beta(1,1) a single correct claim scores ~0.22 while 190/200
 * scores ~0.92. A heavier prior (Beta(2,2)) would shrink the extremes further
 * but also slow down a genuinely good new source for no additional safety.
 */
export const WEAK_PRIOR: BetaPosterior = { alpha: 1, beta: 1 };

/** Equal-tailed mass. 0.90 ⇒ the lower bound is a one-sided 95% bound. */
export const DEFAULT_CREDIBLE_MASS = 0.9;

export function updateReliability(
  prior: BetaPosterior,
  obs: { correct: number; incorrect: number },
): BetaPosterior {
  if (!Number.isFinite(obs.correct) || !Number.isFinite(obs.incorrect)) {
    throw new RangeError('updateReliability: counts must be finite');
  }
  if (obs.correct < 0 || obs.incorrect < 0) {
    throw new RangeError('updateReliability: counts must not be negative');
  }
  return { alpha: prior.alpha + obs.correct, beta: prior.beta + obs.incorrect };
}

export const posteriorMean = (p: BetaPosterior): number => p.alpha / (p.alpha + p.beta);

/* ── the Beta quantile, without a dependency ─────────────────────────────── */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  const g = 7;
  let a = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Lentz continued fraction for the incomplete beta (Numerical Recipes §6.4). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITERATIONS = 300;
  const EPS = 3e-14;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let num = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + num * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + num / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    num = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + num * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + num / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** I_x(a,b) — the Beta CDF. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Bisection: 60 halvings of [0,1] is exact to ~1e-18, needs no derivative and
 *  cannot diverge the way Newton does near the boundaries. */
const BISECTION_STEPS = 60;

function betaQuantile(a: number, b: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function credibleInterval(
  p: BetaPosterior,
  mass: number = DEFAULT_CREDIBLE_MASS,
): { lo: number; hi: number } {
  const tail = (1 - mass) / 2;
  return { lo: betaQuantile(p.alpha, p.beta, tail), hi: betaQuantile(p.alpha, p.beta, 1 - tail) };
}

/**
 * The score every ranking should use: the LOWER credible bound, never the mean.
 *
 * The mean answers "how good do we think this source is"; the lower bound
 * answers "how good are we confident it is", and only the second is safe to
 * sort by. The mean still lets a thin record win on nothing — 20/20 (0.955)
 * outranks 190/200 (0.946) — because it ignores how much evidence produced it.
 * The lower bound prices ignorance in: 1/1 ⇒ 0.22, 20/20 ⇒ 0.87, 190/200 ⇒ 0.92.
 */
export const reliabilityScore = (p: BetaPosterior, mass: number = DEFAULT_CREDIBLE_MASS): number =>
  credibleInterval(p, mass).lo;

/** What a source we have never checked is worth: almost nothing, deliberately. */
export const UNRATED_SOURCE_RELIABILITY = reliabilityScore(WEAK_PRIOR);

/* ── copy-chain collapse ─────────────────────────────────────────────────── */

/** Mirrors `source.derives_from`, as a list so a source may cite two upstreams. */
export interface DerivesEdge {
  sourceId: string;
  derivesFrom: string;
}

export interface SourceClaim {
  sourceId: string;
  factId?: string;
  observedAt?: string;
}

function parentIndex(edges: readonly DerivesEdge[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    if (e.sourceId === e.derivesFrom) continue; // a self-loop carries no lineage
    const list = parents.get(e.sourceId);
    if (list) list.push(e.derivesFrom);
    else parents.set(e.sourceId, [e.derivesFrom]);
  }
  return parents;
}

function rootsFrom(start: string, parents: Map<string, string[]>): string[] {
  const roots = new Set<string>();
  const seen = new Set<string>();
  const stack = [start];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue; // ← the cycle guard: A cites B cites A terminates here
    seen.add(node);
    const ps = parents.get(node);
    if (!ps || ps.length === 0) {
      roots.add(node);
      continue;
    }
    for (const p of ps) stack.push(p);
  }

  if (roots.size === 0) {
    // Every path led back into the cycle and never reached a terminal source:
    // A cites B cites A. Collapse the whole cycle to one deterministic
    // representative so every member counts as the SAME single root — which is
    // what it is. Lexicographically smallest, so the choice never depends on
    // traversal or insertion order.
    const representative = [...seen].sort()[0];
    if (representative !== undefined) roots.add(representative);
  }
  return [...roots].sort();
}

/** The root sources a claim ultimately traces back to. Terminates on cycles. */
export const rootsOf = (sourceId: string, edges: readonly DerivesEdge[]): string[] =>
  rootsFrom(sourceId, parentIndex(edges));

export interface CollapsedClaim {
  /** Stands for the group — the originator where we can identify one. */
  representative: SourceClaim;
  roots: string[];
  /** Every distinct sourceId folded into this group, representative included. */
  absorbed: string[];
}

/**
 * Collapse claims that share a lineage into one piece of evidence.
 *
 * Grouping is by the SET of roots a claim traces to, so a diamond (two paths to
 * one root) collapses, a chain of any depth collapses, and a cycle collapses to
 * its representative. Independent sources keep their own group.
 */
export function collapseCopyChains(
  claims: readonly SourceClaim[],
  edges: readonly DerivesEdge[],
): CollapsedClaim[] {
  const parents = parentIndex(edges);
  const groups = new Map<string, { roots: string[]; members: SourceClaim[] }>();

  for (const c of claims) {
    const roots = rootsFrom(c.sourceId, parents);
    const key = roots.join('|');
    const group = groups.get(key);
    if (group) group.members.push(c);
    else groups.set(key, { roots, members: [c] });
  }

  return [...groups.values()].map(({ roots, members }) => {
    // Prefer the originator: the source that IS a root is the press release,
    // not the outlet that reprinted it, and reliability should be judged
    // against whoever actually made the claim.
    const ranked = [...members].sort((a, b) => {
      const aRoot = roots.includes(a.sourceId) ? 0 : 1;
      const bRoot = roots.includes(b.sourceId) ? 0 : 1;
      if (aRoot !== bRoot) return aRoot - bRoot;
      const at = a.observedAt ?? '';
      const bt = b.observedAt ?? '';
      if (at !== bt) return at < bt ? -1 : 1;
      return a.sourceId < b.sourceId ? -1 : 1;
    });
    return {
      representative: ranked[0]!,
      roots,
      absorbed: [...new Set(members.map((m) => m.sourceId))].sort(),
    };
  });
}

export interface Corroboration {
  /** Distinct roots across every claim — the honest count of evidence. */
  independentRoots: number;
  roots: string[];
  collapsed: CollapsedClaim[];
  score: number;
}

/**
 * Combine independent evidence: `1 − Π(1 − rᵢ)` over the COLLAPSED groups.
 *
 * Sub-additive by construction, so ten copies of one claim score exactly what
 * the original scores alone, and two mediocre independent sources (0.6, 0.6)
 * reach 0.84 rather than an impossible 1.2.
 *
 * The formula assumes the roots are conditionally independent — which is what
 * the collapse buys, and which is never fully true (shared stringers, a common
 * upstream we have no edge for). Callers should gate on `independentRoots` as
 * well as `score`, and must not present the score as a probability.
 */
export function corroborationScore(
  claims: readonly SourceClaim[],
  edges: readonly DerivesEdge[],
  reliabilityOf: (sourceId: string) => number = () => UNRATED_SOURCE_RELIABILITY,
): Corroboration {
  const collapsed = collapseCopyChains(claims, edges);
  const roots = [...new Set(collapsed.flatMap((c) => c.roots))].sort();

  let product = 1;
  for (const group of collapsed) {
    const r = reliabilityOf(group.representative.sourceId);
    product *= 1 - Math.min(1, Math.max(0, Number.isFinite(r) ? r : 0));
  }

  return {
    independentRoots: roots.length,
    roots,
    collapsed,
    score: collapsed.length === 0 ? 0 : 1 - product,
  };
}
