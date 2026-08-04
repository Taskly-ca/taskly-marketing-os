/**
 * T2 — CORRELATE. Two questions, both about waste:
 *
 *   1. Is this actually new? (entity history diff)
 *   2. Does anyone independent say it too? (corroboration seek)
 *
 * `restated` is the answer most of the time, and it is the single highest-volume
 * waste in a system like this: a scraper re-reads a page that has not changed,
 * an outlet re-covers a month-old announcement, and a human is asked to read
 * something they already knew. It must never promote, at any materiality.
 *
 * NAIVE SOURCE COUNTING IS HOW A FABRICATION BECOMES "WIDELY REPORTED".
 * Ten outlets republishing one press release is ONE observation. Counting
 * documents instead of origins converts volume into apparent confirmation,
 * which is exactly the mechanism that launders a single fabricated claim into
 * consensus. Copy chains are therefore collapsed to roots before anything is
 * counted, and there is no naive fallback: with no way to collapse, T2 refuses
 * to count at all.
 *
 * No LLM is used here. Classification is a comparison, corroboration is graph
 * traversal, and the claim text is a template — so T2 costs nothing and cannot
 * hallucinate a difference that is not in the data.
 */
import { assertCausalLanguage } from '@tmos/guardrails';
import type { EvidenceRef, Finding } from '@tmos/contracts';

/* ── values and the history port ──────────────────────────────────────────── */

/** A subset of world's `FactValue`. `entity` and `json` are omitted on purpose:
 *  diffing them needs semantics T2 does not have, and a shallow compare would
 *  report a reordered object as a change. */
export type ObservedValue = { kind: 'num'; num: number } | { kind: 'text'; text: string };

export interface HistoryLookup {
  /** False when the subject is not in the world model at all. */
  entityKnown: boolean;
  /** Our current best value for this predicate, or null if we hold none. */
  current: { value: ObservedValue; observedAt: string } | null;
}

/** Narrow by design. Deliberately NOT `@tmos/world`'s `FactStore` — reason does
 *  not depend on world; the integrator writes the six-line adapter. */
export interface EntityHistoryPort {
  lookup(subjectRef: string, predicate: string): Promise<HistoryLookup>;
}

/* ── the corroboration port ───────────────────────────────────────────────── */

export interface SourceClaimLike {
  sourceId: string;
  observedAt?: string;
}
export interface DerivesEdgeLike {
  sourceId: string;
  derivesFrom: string;
}
export interface CollapsedGroup {
  roots: readonly string[];
}

/** Structurally satisfied by `collapseCopyChains` from `@tmos/world`. */
export type CollapseCopyChainsPort = (
  claims: readonly SourceClaimLike[],
  edges: readonly DerivesEdgeLike[],
) => readonly CollapsedGroup[];

/** Either hand T2 the raw claims and a way to collapse them, or hand it roots
 *  you have already collapsed yourself. There is no third option — in
 *  particular there is no "just count the claims" default. */
export type CorroborationSource =
  | { kind: 'claims'; claims: readonly SourceClaimLike[]; edges: readonly DerivesEdgeLike[] }
  | { kind: 'roots'; roots: readonly string[] };

/* ── input / output ───────────────────────────────────────────────────────── */

export type HistoryClassification = 'new_entity' | 'changed_value' | 'restated' | 'contradicts';

export interface CorrelateInput {
  subjectRef: string;
  predicate: string;
  observation: { value: ObservedValue; observedAt: string };
  /** Provenance, always. A signal with no evidence is refused, not correlated. */
  evidence: readonly EvidenceRef[];
  /** T1's materiality for this item, in [0,1]. */
  materiality: number;
  stakes: 'low' | 'medium' | 'high';
  corroboration: CorroborationSource;
  /** Human-readable names for the claim template. Default to the raw refs. */
  labels?: { subject?: string; predicate?: string };
}

export interface T2Components {
  materiality: number;
  novelty: number;
  corroboration: number;
  stakes: number;
}

export interface T2Verdict {
  subjectRef: string;
  predicate: string;
  classification: HistoryClassification;
  stakes: CorrelateInput['stakes'];
  priorValue: ObservedValue | null;
  observedValue: ObservedValue;
  observedAt: string;
  /** Distinct copy-chain roots — the honest count of who actually said this. */
  independentSources: number;
  roots: string[];
  /** [0,1], for RANKING against other items. Not a quality bar. */
  score: number;
  promote: boolean;
  components: T2Components;
  evidence: EvidenceRef[];
  labels: { subject: string; predicate: string };
}

export type T2Failure = 'no_evidence' | 'no_collapse_port' | 'history_unavailable';

export type T2Result =
  | { ok: true; verdict: T2Verdict }
  | { ok: false; reason: T2Failure; detail: string; retryable: boolean };

export interface T2Deps {
  history: EntityHistoryPort;
  collapse?: CollapseCopyChainsPort;
}

/* ── scoring ──────────────────────────────────────────────────────────────── */

/**
 * COMPETITIVE RANKING, NOT A THRESHOLD.
 *
 * T3 has a hard daily quota. A score threshold is the wrong instrument against
 * a fixed number of slots: it overflows on a busy day and leaves slots idle on
 * a quiet one. T2's job is to emit a number items can be sorted by; the cut is
 * made by whoever owns the quota, against the day's actual queue.
 *
 * COMPARABILITY. Every term is unit-free and bounded to [0,1] by the same
 * definition for every item type, and the weights sum to 1 — so a price change
 * and a coverage change land on one scale.
 *
 * WHAT WOULD MAKE THEM INCOMPARABLE, and these are real:
 *   · `materiality` comes from a small model that is not calibrated. Across a
 *     prompt or model change it is a different scale, and ranking items skimmed
 *     under different `SKIM_VERSION`s against each other is not meaningful.
 *   · `corroboration` measures how many sources we happen to COLLECT for that
 *     subject. A well-covered competitor out-scores a thinly-covered one for
 *     reasons with nothing to do with the claim.
 *   · `stakes` is assigned by the caller. Two domain packs using different
 *     conventions for "high" break the scale silently.
 */
export const T2_WEIGHTS = {
  materiality: 0.35,
  novelty: 0.25,
  corroboration: 0.2,
  stakes: 0.2,
} as const;

/** `contradicts` outranks `changed_value`: a disagreement on record is a
 *  correctness problem, and correctness beats novelty. */
export const NOVELTY: Record<HistoryClassification, number> = {
  new_entity: 1,
  contradicts: 0.9,
  changed_value: 0.7,
  restated: 0,
};

export const STAKES_WEIGHT: Record<CorrelateInput['stakes'], number> = {
  low: 0.25,
  medium: 0.6,
  high: 1,
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function scoreVerdict(x: {
  materiality: number;
  classification: HistoryClassification;
  independentSources: number;
  stakes: CorrelateInput['stakes'];
}): T2Components {
  const n = Math.max(0, x.independentSources);
  return {
    materiality: clamp01(x.materiality),
    novelty: NOVELTY[x.classification],
    // n/(n+1): saturating, so the second independent source is worth far more
    // than the twentieth and a swarm can never dominate the other terms.
    corroboration: n / (n + 1),
    stakes: STAKES_WEIGHT[x.stakes],
  };
}

const combine = (c: T2Components): number =>
  c.materiality * T2_WEIGHTS.materiality +
  c.novelty * T2_WEIGHTS.novelty +
  c.corroboration * T2_WEIGHTS.corroboration +
  c.stakes * T2_WEIGHTS.stakes;

/* ── classification ───────────────────────────────────────────────────────── */

const norm = (v: ObservedValue): string =>
  v.kind === 'num' ? String(v.num) : v.text.replace(/\s+/g, ' ').trim().toLowerCase();

const instant = (iso: string): number => new Date(iso).getTime();

/**
 * A difference ACROSS time is a change; a difference at or behind the same
 * instant is a contradiction. Two sources describing the same moment
 * differently is a correctness problem, not news.
 *
 * This is only as good as `observed_at`. A source with a missing or wrong
 * timestamp gets misfiled, so unparseable timestamps fall to `contradicts` —
 * the outcome that asks for a human rather than the one that asserts a change.
 */
export function classify(observation: CorrelateInput['observation'], held: HistoryLookup) {
  if (!held.entityKnown) return 'new_entity' as const;
  if (held.current === null) return 'changed_value' as const;
  if (norm(observation.value) === norm(held.current.value)) return 'restated' as const;
  const seen = instant(observation.observedAt);
  const prior = instant(held.current.observedAt);
  if (Number.isNaN(seen) || Number.isNaN(prior)) return 'contradicts' as const;
  return seen > prior ? ('changed_value' as const) : ('contradicts' as const);
}

/* ── correlate ────────────────────────────────────────────────────────────── */

export async function correlate(inp: CorrelateInput, deps: T2Deps): Promise<T2Result> {
  if (inp.evidence.length === 0) {
    return {
      ok: false,
      reason: 'no_evidence',
      detail: 'a signal with no provenance is refused, never correlated',
      retryable: false,
    };
  }

  let roots: string[];
  if (inp.corroboration.kind === 'roots') {
    roots = [...new Set(inp.corroboration.roots)].sort();
  } else {
    if (!deps.collapse) {
      return {
        ok: false,
        reason: 'no_collapse_port',
        detail:
          'raw claims given with no way to collapse copy chains; counting them would be wrong',
        retryable: false,
      };
    }
    const groups = deps.collapse(inp.corroboration.claims, inp.corroboration.edges);
    roots = [...new Set(groups.flatMap((g) => [...g.roots]))].sort();
  }

  let held: HistoryLookup;
  try {
    held = await deps.history.lookup(inp.subjectRef, inp.predicate);
  } catch (e) {
    return {
      ok: false,
      reason: 'history_unavailable',
      detail: `history lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
    };
  }

  const classification = classify(inp.observation, held);
  const components = scoreVerdict({
    materiality: inp.materiality,
    classification,
    independentSources: roots.length,
    stakes: inp.stakes,
  });

  // A hard floor, not a weight. As a weight it could be out-argued by a high
  // materiality — which is precisely the "we already knew this, loudly" case.
  const score = classification === 'restated' ? 0 : combine(components);

  return {
    ok: true,
    verdict: {
      subjectRef: inp.subjectRef,
      predicate: inp.predicate,
      classification,
      stakes: inp.stakes,
      priorValue: held.current?.value ?? null,
      observedValue: inp.observation.value,
      observedAt: inp.observation.observedAt,
      independentSources: roots.length,
      roots,
      score,
      // Eligibility to COMPETE for a T3 slot — never a quality bar.
      promote: classification !== 'restated' && roots.length >= 1,
      components,
      evidence: [...inp.evidence],
      labels: {
        subject: inp.labels?.subject ?? inp.subjectRef,
        predicate: inp.labels?.predicate ?? inp.predicate,
      },
    },
  };
}

/* ── assembling a Finding ─────────────────────────────────────────────────── */

/**
 * Values are rendered exactly as observed — never converted, never currency-
 * formatted. L0 compares digits in the claim against digits in the span, so
 * turning `6000` into `$60.00` produces a number that appears in no source and
 * fails the check that exists to catch fabrication.
 */
const render = (v: ObservedValue): string => (v.kind === 'num' ? String(v.num) : v.text);

const CLAIM: Record<Exclude<HistoryClassification, 'restated'>, (v: T2Verdict) => string> = {
  new_entity: (v) =>
    `${v.labels.subject}'s ${v.labels.predicate} observed at ${render(v.observedValue)}.`,
  changed_value: (v) =>
    `${v.labels.subject}'s ${v.labels.predicate} is now ${render(v.observedValue)}.`,
  contradicts: (v) =>
    `${v.labels.subject}'s ${v.labels.predicate} reported as ${render(v.observedValue)}.`,
};

/**
 * The prior value lives in `so_what`, not in the claim.
 *
 * It comes from our world model, not from this source's span, so putting it in
 * the claim would fail L0 on every legitimate change. The honest consequence is
 * that the prior is NOT covered by L0 — closing that needs the history port to
 * return the prior fact's own evidence ref so it can be cited. Flagged for L1.
 */
function defaultSoWhat(v: T2Verdict): string {
  const prior = v.priorValue === null ? null : render(v.priorValue);
  switch (v.classification) {
    case 'new_entity':
      return `We held nothing on ${v.labels.subject} before this observation.`;
    case 'changed_value':
      return prior === null
        ? `We now hold a value for ${v.labels.predicate} where we previously held none.`
        : `We previously held ${prior}; any comparison using that value is stale.`;
    default:
      return `This disagrees with ${prior ?? 'what is already on record'} for the same period; one of the two is wrong.`;
  }
}

export interface AssembleOptions {
  id: string;
  createdAt: string;
  region: Finding['region'];
  generatedBy: string;
  soWhat?: string;
  /** Placeholder until the domain scorer lands (Part 5.8, another lane).
   *  Defaults to the T2 rank score, which is a proxy for relevance, not a
   *  measurement of it — do not read it as one. */
  domainScore?: number;
}

export function assembleFinding(verdict: T2Verdict, opts: AssembleOptions): Finding {
  if (verdict.classification === 'restated') {
    throw new Error('refusing to assemble a Finding from a restated signal — we already knew this');
  }
  const claim = CLAIM[verdict.classification](verdict);
  const so_what = opts.soWhat ?? defaultSoWhat(verdict);
  // Rung 0: T2 observes, it never runs a holdout. Fail-closed on both fields,
  // including a caller-supplied consequence.
  assertCausalLanguage(`${claim} ${so_what}`, 0);

  return {
    id: opts.id,
    claim,
    so_what,
    subject_refs: [verdict.subjectRef],
    evidence: verdict.evidence,
    basis: 'inferred_from_sources',
    causal_rung: 0,
    stakes: verdict.stakes,
    region: opts.region,
    domain_score: opts.domainScore ?? verdict.score,
    generated_by: opts.generatedBy,
    reviewed_by: null,
    superseded_by: null,
    supersede_reason: null,
    created_at: opts.createdAt,
  };
}
