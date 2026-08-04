/**
 * Status is earned from the run ledger, never declared.
 *
 * Three ideas do the work, and each has an obvious wrong answer:
 *
 *  1. SCORE ON THE LOWER CREDIBLE BOUND, not the win rate and not the posterior
 *     mean. The rate is worst — 1-for-1 is "100%" and beats 12-for-15. The mean
 *     shrinks that but a short perfect run still wins. The lower bound prices
 *     ignorance in, so being untested costs you: 1/1 ⇒ 0.22, 12/15 ⇒ 0.58.
 *     Identical reasoning to `packages/world/src/fact/reliability.ts`.
 *  2. A WIN IN A SECOND CLUSTER, not a third win in the first. Three wins in one
 *     context is evidence that the CONTEXT is favourable; it says nothing about
 *     whether the playbook generalises, which is the only property that makes
 *     "proven" worth acting on.
 *  3. DEMOTION AND DECAY. A status that can only go up is a ratchet, and a
 *     ratchet eventually holds up something broken.
 *
 * `underpowered` runs count toward neither wins nor losses — an underpowered
 * result is not a result — but they are surfaced, because a playbook nobody can
 * conclusively measure is its own kind of problem.
 */
import type { Playbook } from '@tmos/contracts';
import { effectiveRuns } from './ledger.js';
import type { LedgerRun, RunClassification } from './ledger.js';

/* ── the Beta posterior ───────────────────────────────────────────────────── */
/* TODO(integrator): deliberate duplicate of WEAK_PRIOR / credibleInterval /
 * reliabilityScore in `packages/world/src/fact/reliability.ts`. @tmos/world is
 * not a dependency of @tmos/decide and this lane may not add one; world's copy
 * is the original if the two ever disagree. The implementation differs on
 * purpose: alpha and beta here are always integers (prior + run counts), so the
 * exact binomial form of the Beta CDF is available and the Lanczos /
 * continued-fraction machinery is unnecessary. */

/**
 * I_x(a,b) for INTEGER a,b — the binomial tail Σ_{j≥a} C(n,j) x^j (1−x)^{n−j},
 * n = a+b−1. Exact, ~15 lines, no special functions.
 */
function betaCdf(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // I_x(a,b) = 1 − I_{1−x}(b,a): keeps (1−x)^n clear of underflow for x > ½.
  if (x > 0.5) return 1 - betaCdf(b, a, 1 - x);
  const n = a + b - 1;
  const odds = x / (1 - x);
  let term = (1 - x) ** n;
  let sum = 0;
  for (let j = 0; j <= n; j++) {
    if (j >= a) sum += term;
    term *= ((n - j) / (j + 1)) * odds;
  }
  return Math.min(1, Math.max(0, sum));
}

/** 60 halvings of [0,1]: exact to ~1e-18, needs no derivative, cannot diverge. */
const BISECTION_STEPS = 60;
function betaQuantile(a: number, b: number, p: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Beta(1,1), uniform — two pseudo-observations of weight.
 *
 * The prior barely matters BECAUSE we score on a lower bound rather than a
 * mean, and the structural gates below (≥3 runs, ≥2 wins, ≥2 clusters) carry
 * the pessimism where a reviewer can see it. A pessimistic prior such as
 * Beta(1,3) — "most tactics do not work" — would encode the same caution
 * invisibly, and would also slow a genuinely good playbook for no extra safety.
 * Matches `source.reliability_alpha/beta` in migration 001.
 */
export const WEAK_PRIOR = { alpha: 1, beta: 1 } as const;
/** Equal-tailed 0.90 ⇒ the lower bound is a one-sided 95% bound. */
export const CREDIBLE_MASS = 0.9;

export const MIN_RUNS = 3;
export const MIN_WINS = 2;
/** ≥2 distinct clusters among the WINS. See idea (2) at the top. */
export const MIN_WINNING_CLUSTERS = 2;
/**
 * The demotion window: the last 8 conclusive runs.
 *
 * Small enough that a playbook which stopped working is caught inside a
 * quarter, large enough that the bound over it is not dominated by one result —
 * at n<3 a single loss would drag any record under the bar, and one loss is
 * what a 70%-effective playbook produces routinely.
 */
export const RECENT_WINDOW = 8;
/**
 * Zero wins across this many recent conclusive runs retires outright rather
 * than demoting. Under the weakest record that could have promoted (a 0.6 point
 * estimate) a 0-for-4 stretch has probability 0.4⁴ ≈ 2.6%, and even at a
 * coin-flip 0.5 it is 6%. Rare enough to treat as a signal, not as noise.
 */
export const RETIRE_LOSS_STREAK = 4;

const boundOf = (
  wins: number,
  losses: number,
  prior: { alpha: number; beta: number } = WEAK_PRIOR,
  mass: number = CREDIBLE_MASS,
): number => betaQuantile(prior.alpha + wins, prior.beta + losses, (1 - mass) / 2);

/**
 * The demotion bar IS the weakest record that could ever have promoted (2 wins,
 * 1 loss ⇒ ≈0.249). Stated this way rather than as a magic number, and compared
 * with a strict `<`, promotion and demotion provably cannot both fire on the
 * same evidence — so a freshly promoted playbook never oscillates.
 */
export const DEMOTION_LOWER_BOUND = boundOf(MIN_WINS, MIN_RUNS - MIN_WINS);

export interface GraduationConfig {
  prior: { alpha: number; beta: number };
  credibleMass: number;
  minRuns: number;
  minWins: number;
  minWinningClusters: number;
  recentWindow: number;
  retireLossStreak: number;
  demotionLowerBound: number;
  /** Share of settled runs that may be underpowered before we say so out loud. */
  hardToEvaluateRatio: number;
}

export const DEFAULT_GRADUATION: GraduationConfig = Object.freeze({
  prior: { ...WEAK_PRIOR },
  credibleMass: CREDIBLE_MASS,
  minRuns: MIN_RUNS,
  minWins: MIN_WINS,
  minWinningClusters: MIN_WINNING_CLUSTERS,
  recentWindow: RECENT_WINDOW,
  retireLossStreak: RETIRE_LOSS_STREAK,
  demotionLowerBound: DEMOTION_LOWER_BOUND,
  hardToEvaluateRatio: 0.5,
});

/** The number to sort and gate on: the lower credible bound of the win rate. */
export const playbookScore = (
  wins: number,
  losses: number,
  config: GraduationConfig = DEFAULT_GRADUATION,
): number => boundOf(wins, losses, config.prior, config.credibleMass);

/* ── the verdict ──────────────────────────────────────────────────────────── */

export type PlaybookStatus = Playbook['status'];

export type GraduationRule =
  | 'retired_is_terminal'
  | 'decayed'
  | 'no_recent_wins'
  | 'deteriorated'
  | 'graduated'
  | 'insufficient_runs'
  | 'insufficient_wins'
  | 'single_cluster'
  | 'holding';

export interface Justification {
  conclusive: number;
  wins: number;
  losses: number;
  underpowered: number;
  inconclusive: number;
  aborted: number;
  /** Outcomes read before their horizon. A record built on peeks is weaker. */
  forced_reads: number;
  clusters: { all: string[]; winning: string[] };
  posterior: { alpha: number; beta: number };
  lower_bound: number;
  mean: number;
  recent: { window: number; wins: number; losses: number; lower_bound: number };
  evaluability: {
    underpowered: number;
    conclusive: number;
    ratio: number;
    hard_to_evaluate: boolean;
  };
  days_since_last_win: number | null;
  /** Runs on OTHER versions of this playbook. Counted, never borrowed. */
  other_version_runs: number;
  narrative: string;
}

export interface GraduationVerdict {
  playbook_id: string;
  version: number;
  from: PlaybookStatus;
  to: PlaybookStatus;
  changed: boolean;
  rule: GraduationRule;
  justification: Justification;
}

export interface GraduationInput {
  playbook: Playbook;
  runs: readonly LedgerRun[];
  /** Cluster identity is INJECTED. What counts as "a different context" is a
   *  domain judgement (region, vertical, channel, customer size); a clustering
   *  algorithm invented here would silently decide the most important gate. */
  clusterOf: (run: LedgerRun) => string;
  now: string;
  config?: Partial<GraduationConfig>;
}

type Settled = LedgerRun & { outcome: NonNullable<LedgerRun['outcome']> };
const isSettled = (r: LedgerRun): r is Settled => r.outcome !== null;
const isa = (c: RunClassification) => (r: Settled) => r.outcome.classification === c;
const DAY_MS = 86_400_000;
const daysTo = (from: string, to: string): number =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / DAY_MS);
const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();

/** Evaluate one playbook VERSION against its ledger. Pure and deterministic. */
export function graduate(input: GraduationInput): GraduationVerdict {
  const cfg: GraduationConfig = { ...DEFAULT_GRADUATION, ...input.config };
  const { playbook, now, clusterOf } = input;
  const live = effectiveRuns(input.runs).filter((r) => r.playbook_id === playbook.id);
  const version = live.filter((r) => r.playbook_version === playbook.version);
  const otherVersionRuns = live.length - version.length;

  const settled = version
    .filter(isSettled)
    .sort(
      (a, b) =>
        a.outcome.measured_at.localeCompare(b.outcome.measured_at) ||
        a.run_id.localeCompare(b.run_id),
    );
  const wins = settled.filter(isa('win'));
  const losses = settled.filter(isa('loss'));
  const conclusive = settled.filter((r) => isa('win')(r) || isa('loss')(r));
  const underpowered = settled.filter(isa('underpowered')).length;

  const recent = conclusive.slice(-cfg.recentWindow);
  const recentWins = recent.filter(isa('win')).length;
  const recentLosses = recent.length - recentWins;
  const recentBound = playbookScore(recentWins, recentLosses, cfg);

  const lastWin = wins.at(-1);
  const earliestStart = version.map((r) => r.started_at).sort()[0];
  const winAnchor = lastWin?.outcome.measured_at ?? earliestStart;
  const daysSinceLastWin = winAnchor === undefined ? null : daysTo(winAnchor, now);

  const j: Omit<Justification, 'narrative'> = {
    conclusive: conclusive.length,
    wins: wins.length,
    losses: losses.length,
    underpowered,
    inconclusive: settled.filter(isa('inconclusive')).length,
    aborted: settled.filter(isa('aborted')).length,
    forced_reads: settled.filter((r) => r.outcome.forced !== null).length,
    clusters: { all: uniq(settled.map(clusterOf)), winning: uniq(wins.map(clusterOf)) },
    posterior: { alpha: cfg.prior.alpha + wins.length, beta: cfg.prior.beta + losses.length },
    lower_bound: playbookScore(wins.length, losses.length, cfg),
    mean: (cfg.prior.alpha + wins.length) / (cfg.prior.alpha + cfg.prior.beta + conclusive.length),
    recent: {
      window: recent.length,
      wins: recentWins,
      losses: recentLosses,
      lower_bound: recentBound,
    },
    evaluability: {
      underpowered,
      conclusive: conclusive.length,
      ratio: settled.length === 0 ? 0 : underpowered / settled.length,
      hard_to_evaluate:
        settled.length >= cfg.minRuns && underpowered / settled.length > cfg.hardToEvaluateRatio,
    },
    days_since_last_win: daysSinceLastWin,
    other_version_runs: otherVersionRuns,
  };

  const from = playbook.status;
  const decide = (): { to: PlaybookStatus; rule: GraduationRule } => {
    // Order matters and is fixed: retirement rules outrank promotion, so a
    // playbook cannot be promoted in the same breath as it is found dead.
    if (from === 'retired') return { to: 'retired', rule: 'retired_is_terminal' };
    if (daysSinceLastWin !== null && daysSinceLastWin > playbook.decay_after_days)
      return { to: 'retired', rule: 'decayed' };
    if (recentWins === 0 && recentLosses >= cfg.retireLossStreak)
      return { to: 'retired', rule: 'no_recent_wins' };
    if (from === 'proven')
      return recent.length >= cfg.minRuns && recentBound < cfg.demotionLowerBound
        ? { to: 'candidate', rule: 'deteriorated' }
        : { to: 'proven', rule: 'holding' };
    if (conclusive.length < cfg.minRuns) return { to: from, rule: 'insufficient_runs' };
    if (wins.length < cfg.minWins) return { to: from, rule: 'insufficient_wins' };
    if (j.clusters.winning.length < cfg.minWinningClusters)
      return { to: from, rule: 'single_cluster' };
    return { to: 'proven', rule: 'graduated' };
  };

  const { to, rule } = decide();
  return {
    playbook_id: playbook.id,
    version: playbook.version,
    from,
    to,
    changed: to !== from,
    rule,
    justification: { ...j, narrative: narrate(playbook, from, to, rule, j, cfg) },
  };
}

/** A status that changes without a visible reason is one nobody trusts. */
function narrate(
  playbook: Playbook,
  from: PlaybookStatus,
  to: PlaybookStatus,
  rule: GraduationRule,
  j: Omit<Justification, 'narrative'>,
  cfg: GraduationConfig,
): string {
  const head =
    `${playbook.id} v${playbook.version}: ${from} → ${to} (${rule}) — ` +
    `${j.wins}W/${j.losses}L over ${j.conclusive} conclusive run(s), ` +
    `lower bound ${j.lower_bound.toFixed(2)}; ` +
    `clusters won: ${j.clusters.winning.length > 0 ? j.clusters.winning.join(', ') : 'none'}.`;

  const because: Record<GraduationRule, string> = {
    retired_is_terminal: ' Retired stays retired — revival is a version bump, not a status flip.',
    decayed: ` No successful run in ${String(j.days_since_last_win)} days, past the ${playbook.decay_after_days}-day decay window.`,
    no_recent_wins: ` No wins in the last ${j.recent.window} conclusive run(s) (${j.recent.losses} losses) — that is not noise around a working playbook.`,
    deteriorated: ` Recent ${j.recent.wins}W/${j.recent.losses}L scores ${j.recent.lower_bound.toFixed(2)}, under the ${cfg.demotionLowerBound.toFixed(2)} bar the weakest promoting record clears.`,
    graduated: ` Wins in ${j.clusters.winning.length} clusters, so the evidence is about the playbook and not only about one context.`,
    single_cluster: ` Every win is in the same context (${j.clusters.winning.join(', ')}) — wins in the same context are evidence the context is favourable, not that the playbook generalises.`,
    insufficient_runs: ` Needs ${cfg.minRuns} conclusive runs; underpowered and inconclusive runs do not count.`,
    insufficient_wins: ` Needs ${cfg.minWins} wins.`,
    holding: '',
  };

  const notes: string[] = [];
  if (j.other_version_runs > 0)
    notes.push(
      ` ${j.other_version_runs} run(s) on other version(s) ignored — evidence does not transfer across versions.`,
    );
  if (j.forced_reads > 0)
    notes.push(` ${j.forced_reads} forced early read(s) in this record — treat it as softer.`);
  if (j.evaluability.hard_to_evaluate)
    notes.push(
      ` ${j.underpowered} of ${j.underpowered + j.conclusive + j.inconclusive + j.aborted} runs were underpowered — this playbook is hard to evaluate, which is its own problem.`,
    );
  return head + because[rule] + notes.join('');
}
