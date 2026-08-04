/**
 * Deep research — a button that spends real money and takes real time.
 *
 * Everything here is about making that legible BEFORE it is spent, because the
 * failure this feature invites is not a bad answer, it is a bill. Accepting
 * "$2" and being charged "$20" destroys the estimate permanently, and once the
 * estimate is theatre the only safe behaviour left is never pressing the button.
 *
 * So a run never starts on intent. It starts on an acceptance token carrying
 * the exact estimate the reader saw, which is re-derived and compared at start
 * time; if anything that drives the price moved, the acceptance is INVALID —
 * not adjusted, not warned about — and must be re-confirmed. Around that sit
 * the three properties that bite in production: a ceiling that ABORTS rather
 * than continues, idempotency (double-click is the common case, not the edge
 * one), and cancellation that commits spend already incurred, because
 * pretending a cancelled run was free is the same lie as under-estimating it.
 */
import type { Investigation } from '@tmos/contracts';
import type { BudgetPort, SpendOutcome, SpendRequest } from './chat.js';

export type BudgetTier = Investigation['budget_tier'];

export interface ResearchRequest {
  investigationId: string;
  question: string;
  tier: BudgetTier;
  /** Sources to sweep — the dominant cost driver, hence part of the estimate
   *  fingerprint: changing it silently is the classic bait-and-switch. */
  sourceCount: number;
  /** `investigations.max_cost_cents`. The ceiling can never exceed it. */
  maxCostCents: number;
}

/**
 * 15 minutes. Long enough to read the estimate, think, and come back; short
 * enough that the source set, the model price and the reader's memory of what
 * they clicked have not moved. An hour-old "yes" is not consent to today's
 * price — past that a token stops being an acceptance and becomes a standing
 * authorisation, which is what nobody agreed to.
 */
export const ACCEPTANCE_TTL_MS = 15 * 60_000;

/**
 * 1.5×. Absorbs honest variance — a source returning more text than expected —
 * while making a 4× runaway structurally impossible. Anything beyond 50% over
 * the shown number is a re-consent event, not a rounding error.
 */
export const CEILING_MULTIPLIER = 1.5;

/** Median overrun above this, over enough runs, means the estimator is broken
 *  rather than unlucky. */
const SYSTEMATIC_RATIO = 1.25;
const SYSTEMATIC_MIN_RUNS = 3;

interface TierModel {
  baseCents: number;
  perSourceCents: number;
  baseMs: number;
  perSourceMs: number;
  tokensPerSource: number;
  /** Plain language. Numbers alone do not say what you are buying. */
  does: string;
}

const TIERS: Record<BudgetTier, TierModel> = {
  t0_gate: {
    baseCents: 1,
    perSourceCents: 0,
    baseMs: 200,
    perSourceMs: 10,
    tokensPerSource: 0,
    does: 'Check whether anything changed. No model call unless something did.',
  },
  t1_skim: {
    baseCents: 5,
    perSourceCents: 2,
    baseMs: 2_000,
    perSourceMs: 400,
    tokensPerSource: 800,
    does: 'Read each source once and pull out what is new.',
  },
  t2_correlate: {
    baseCents: 20,
    perSourceCents: 6,
    baseMs: 8_000,
    perSourceMs: 1_200,
    tokensPerSource: 4_000,
    does: 'Read the sources, then cross-check them against each other and against what we already know.',
  },
  t3_deep: {
    baseCents: 60,
    perSourceCents: 18,
    baseMs: 30_000,
    perSourceMs: 4_000,
    tokensPerSource: 12_000,
    does: 'Read the sources, cross-check them, chase the citations behind them, and write up what changed with evidence for every claim.',
  },
};

export interface ResearchEstimate {
  investigationId: string;
  tier: BudgetTier;
  sourceCount: number;
  estimatedCostCents: number;
  estimatedTokens: number;
  estimatedLatencyMs: number;
  /** Hard stop. The run aborts here even mid-way. */
  ceilingCents: number;
  whatItWillDo: string;
  /** Everything the price depends on, readable — so a drift refusal can say
   *  exactly what moved instead of "something changed". */
  fingerprint: string;
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Deterministic: same request in, same estimate out — otherwise drift
 *  detection would fire on its own noise. */
export function estimate(req: ResearchRequest): ResearchEstimate {
  const m = TIERS[req.tier];
  const costCents = m.baseCents + m.perSourceCents * req.sourceCount;
  const latencyMs = m.baseMs + m.perSourceMs * req.sourceCount;
  const ceilingCents = Math.min(Math.ceil(costCents * CEILING_MULTIPLIER), req.maxCostCents);
  return {
    investigationId: req.investigationId,
    tier: req.tier,
    sourceCount: req.sourceCount,
    estimatedCostCents: costCents,
    estimatedTokens: m.tokensPerSource * req.sourceCount,
    estimatedLatencyMs: latencyMs,
    ceilingCents,
    whatItWillDo:
      `${m.does} About ${req.sourceCount} sources, roughly ${Math.round(latencyMs / 1000)}s. ` +
      `Expected cost ${money(costCents)}; we stop at ${money(ceilingCents)} even if it is ` +
      'not finished.',
    fingerprint: [
      req.tier,
      req.sourceCount,
      req.maxCostCents,
      costCents,
      latencyMs,
      ceilingCents,
    ].join('|'),
  };
}

/* ── acceptance ───────────────────────────────────────────────────────────── */

export interface Acceptance {
  /** Caller-supplied. No random ids in library code. */
  token: string;
  investigationId: string;
  /** The estimate the reader actually saw. Compared at start, never trusted. */
  shown: ResearchEstimate;
  acceptedAt: string;
}

export const acceptEstimate = (input: {
  token: string;
  estimate: ResearchEstimate;
  at: Date;
}): Acceptance => ({
  token: input.token,
  investigationId: input.estimate.investigationId,
  shown: input.estimate,
  acceptedAt: input.at.toISOString(),
});

/* ── ports ────────────────────────────────────────────────────────────────── */

export interface StepResult {
  costCents: number;
  tokens: number;
  /** One line for the report. Not the finding — synthesis owns that. */
  note: string;
}

export interface ResearchStep {
  label: string;
  run(): Promise<StepResult>;
}

/** Planning is deterministic and free; only `run` costs anything. */
export interface ResearchPort {
  plan(req: ResearchRequest): readonly ResearchStep[];
}

/** Deliberately not `AbortSignal`: polled between steps, so cancellation lands
 *  on a boundary where the spend so far is known and committable. */
export interface CancelToken {
  cancelled(): boolean;
}

export interface Progress {
  stepIndex: number;
  stepCount: number;
  label: string;
  spentCents: number;
  ceilingCents: number;
}

/**
 * Idempotency store. A token is consumed EVEN when the run is then blocked: a
 * refusal is an outcome and re-asking is one click, whereas releasing it would
 * make "the same token cannot start two runs" conditional — and conditional
 * idempotency is not idempotency.
 */
export interface RunLedger {
  has(token: string): boolean;
  add(token: string): void;
}

export const createRunLedger = (): RunLedger => {
  const seen = new Set<string>();
  return { has: (t) => seen.has(t), add: (t) => void seen.add(t) };
};

export interface RunDeps {
  research: ResearchPort;
  budget: BudgetPort;
  ledger: RunLedger;
  /** Injected — no Date.now() in library code. */
  now: () => Date;
  cancel?: CancelToken;
  onProgress?: (p: Progress) => void;
}

/* ── running ──────────────────────────────────────────────────────────────── */

export type RunOutcome = 'completed' | 'cancelled' | 'aborted_ceiling';

export interface RunReport {
  token: string;
  investigationId: string;
  outcome: RunOutcome;
  estimatedCostCents: number;
  actualCostCents: number;
  /** actual ÷ estimated. Above 1 means we charged more than we showed. */
  costRatio: number;
  stepsCompleted: number;
  stepsPlanned: number;
  notes: readonly string[];
  detail?: string;
}

export type StartRefusalCode =
  | 'wrong_investigation'
  | 'estimate_drifted'
  | 'acceptance_expired'
  | 'ceiling_below_estimate'
  | 'duplicate_acceptance'
  | 'budget_blocked';

export type StartResult =
  | { ok: true; report: RunReport }
  | { ok: false; code: StartRefusalCode; detail: string; budgetOutcome?: SpendOutcome };

export async function startRun(
  req: ResearchRequest,
  acceptance: Acceptance,
  deps: RunDeps,
): Promise<StartResult> {
  if (acceptance.investigationId !== req.investigationId) {
    return {
      ok: false,
      code: 'wrong_investigation',
      detail: `acceptance is for ${acceptance.investigationId}, run is for ${req.investigationId}`,
    };
  }

  const fresh = estimate(req);
  if (fresh.fingerprint !== acceptance.shown.fingerprint) {
    return {
      ok: false,
      code: 'estimate_drifted',
      detail:
        `the estimate changed after it was shown: accepted [${acceptance.shown.fingerprint}] ` +
        `(${money(acceptance.shown.estimatedCostCents)}), now [${fresh.fingerprint}] ` +
        `(${money(fresh.estimatedCostCents)}). Re-confirm the new price before spending it.`,
    };
  }

  const ageMs = deps.now().getTime() - Date.parse(acceptance.acceptedAt);
  if (!(ageMs >= 0 && ageMs < ACCEPTANCE_TTL_MS)) {
    return {
      ok: false,
      code: 'acceptance_expired',
      detail:
        `acceptance is ${Math.round(ageMs / 1000)}s old and is valid for ` +
        `${ACCEPTANCE_TTL_MS / 1000}s — yesterday's yes is not consent to today's price`,
    };
  }

  if (fresh.ceilingCents < fresh.estimatedCostCents) {
    return {
      ok: false,
      code: 'ceiling_below_estimate',
      detail:
        `the investigation cap (${money(req.maxCostCents)}) is below the estimate ` +
        `(${money(fresh.estimatedCostCents)}) — the run would abort part-way. Raise the cap ` +
        'or narrow the question.',
    };
  }

  if (deps.ledger.has(acceptance.token)) {
    return {
      ok: false,
      code: 'duplicate_acceptance',
      detail: `acceptance ${acceptance.token} has already started a run — one yes buys one run`,
    };
  }
  deps.ledger.add(acceptance.token);

  const decision = deps.budget.authorize({
    runId: acceptance.token,
    estimatedTokens: fresh.estimatedTokens,
    estimatedCostCents: fresh.estimatedCostCents,
    toolDepth: 1,
  });
  if (decision.outcome !== 'allowed') {
    return {
      ok: false,
      code: 'budget_blocked',
      detail: decision.reason ?? decision.outcome,
      budgetOutcome: decision.outcome,
    };
  }

  const steps = deps.research.plan(req);
  const notes: string[] = [];
  let spentCents = 0;
  let completed = 0;
  let outcome: RunOutcome = 'completed';
  let detail: string | undefined;

  for (const [i, step] of steps.entries()) {
    if (deps.cancel?.cancelled() === true) {
      outcome = 'cancelled';
      detail =
        `cancelled after ${completed} of ${steps.length} steps; the ${money(spentCents)} ` +
        'already incurred is charged, not waived';
      break;
    }
    deps.onProgress?.({
      stepIndex: i + 1,
      stepCount: steps.length,
      label: step.label,
      spentCents,
      ceilingCents: fresh.ceilingCents,
    });
    const r = await step.run();
    // Committed per step, so an abort or cancellation has ALREADY recorded what
    // was incurred. One commit at the end would make every non-completion look
    // free — which is the same dishonesty as a fabricated estimate.
    const spend: SpendRequest = {
      runId: acceptance.token,
      estimatedTokens: r.tokens,
      estimatedCostCents: r.costCents,
      toolDepth: 1,
    };
    deps.budget.commit(spend);
    spentCents += r.costCents;
    completed += 1;
    notes.push(r.note);

    if (spentCents > fresh.ceilingCents) {
      outcome = 'aborted_ceiling';
      detail =
        `stopped at ${money(spentCents)}, past the ${money(fresh.ceilingCents)} ceiling you ` +
        `accepted, with ${steps.length - completed} step(s) unrun`;
      break;
    }
  }

  return {
    ok: true,
    report: {
      token: acceptance.token,
      investigationId: req.investigationId,
      outcome,
      estimatedCostCents: fresh.estimatedCostCents,
      actualCostCents: spentCents,
      costRatio: ratio(spentCents, fresh.estimatedCostCents),
      stepsCompleted: completed,
      stepsPlanned: steps.length,
      notes,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

const ratio = (actual: number, estimated: number): number =>
  estimated <= 0 ? 0 : Number((actual / estimated).toFixed(2));

/* ── did the estimate mean anything? ──────────────────────────────────────── */

export interface EstimateAccuracy {
  runs: number;
  medianRatio: number;
  worstRatio: number;
  /** One overrun is variance. A median overrun is a broken estimator, and the
   *  estimate is theatre until this is shown next to the button. */
  systematicUnderEstimate: boolean;
}

export function estimateAccuracy(reports: readonly RunReport[]): EstimateAccuracy {
  const ratios = reports
    .filter((r) => r.actualCostCents > 0 && r.estimatedCostCents > 0)
    .map((r) => r.costRatio)
    .sort((a, b) => a - b);
  const n = ratios.length;
  if (n === 0) return { runs: 0, medianRatio: 0, worstRatio: 0, systematicUnderEstimate: false };
  const mid = Math.floor(n / 2);
  const lo = ratios[n % 2 === 0 ? mid - 1 : mid] ?? 0;
  const medianRatio = Number(((lo + (ratios[mid] ?? 0)) / 2).toFixed(2));
  return {
    runs: n,
    medianRatio,
    worstRatio: ratios[n - 1] ?? 0,
    systematicUnderEstimate: n >= SYSTEMATIC_MIN_RUNS && medianRatio > SYSTEMATIC_RATIO,
  };
}
