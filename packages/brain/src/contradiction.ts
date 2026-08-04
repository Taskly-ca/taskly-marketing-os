/**
 * Brain-vs-world contradiction detection, and a patch a HUMAN approves.
 *
 * The Brain says Taskly's commission is 20%. The world model observes something
 * else. That is four different situations wearing one costume, and they need
 * opposite treatments — so, exactly as `@tmos/world`'s conflict module does, the
 * contradiction is TYPED before anything acts on it:
 *
 *   unit_mismatch     0.2, 20% and "20 percent" are the same number written
 *                     three ways. This is not a disagreement, and a system that
 *                     opens a pull request over one is switched off in a week.
 *   stale_observation our data is older than the Brain edit. The Brain already
 *                     knows something we do not; correcting it would be a
 *                     regression written by a robot.
 *   stale_brain       the world moved after the Brain was last reviewed. The
 *                     ONLY kind that may produce a proposed edit.
 *   genuine_conflict  contemporaneous and incompatible. Someone is wrong and a
 *                     person has to decide which.
 *
 * Nothing here performs a side effect. `proposeEdit` returns data; opening a
 * pull request is the caller's job, through `PullRequestPort`.
 */
import type { Basis, BrainStatus, EvidenceRef } from '@tmos/contracts';

export type Unit = 'ratio' | 'percent' | 'cents' | 'dollars' | 'count';
type Dimension = 'fraction' | 'money' | 'count';

const UNIT_DIMENSION: Record<Unit, Dimension> = {
  ratio: 'fraction',
  percent: 'fraction',
  cents: 'money',
  dollars: 'money',
  count: 'count',
};

/** Multiplier into each dimension's base unit: ratio, cents, count. */
const TO_BASE: Record<Unit, number> = { ratio: 1, percent: 0.01, cents: 1, dollars: 100, count: 1 };

export interface Quantity {
  amount: number;
  unit: Unit;
  /** The literal characters the document uses, e.g. `20%`. A patch replaces the
   *  number, not the sentence, so we must know exactly what to replace. */
  text?: string;
}

/**
 * Relative, not absolute: 0.5% of the value.
 *
 * Brain prose rounds — "about 20%", "$99" for 9,899 cents — and a tolerance
 * tighter than that rounding manufactures contradictions out of typography.
 * A looser one hides real movement. Every price or rate change worth reporting
 * is at least a percent (a $99 → $119 move is 20%), so 0.5% sits comfortably
 * below the smallest change we care about and comfortably above both prose
 * rounding and the float error in `20 × 0.01 ≠ 0.2`.
 */
export const DEFAULT_RELATIVE_TOLERANCE = 0.005;

/**
 * `reviewed` has day granularity, so an observation within a day of the review
 * carries no ordering information at all. Inside this window neither side is
 * "stale" — it is a genuine conflict, which is to say a human's problem.
 */
export const DEFAULT_STALENESS_GRACE_MS = 24 * 60 * 60 * 1000;

/** Structural priors on how much an observation should be able to move the
 *  company's own record. Computed from the evidence — never self-reported by a
 *  model, which is why no number here comes out of a prompt. */
const BASIS_WEIGHT: Record<Basis, number> = {
  verified_metric: 0.95,
  governed_query: 0.8,
  inferred_from_sources: 0.55,
  exploratory_unverified: 0.25,
};

export type ContradictionKind =
  'stale_brain' | 'stale_observation' | 'unit_mismatch' | 'genuine_conflict';

/** A claim the Brain makes, located precisely enough to patch. */
export interface BrainClaim {
  /** What is being claimed, e.g. `taskly.commission_rate`. Pairs with an
   *  observation of the same key. */
  key: string;
  path: string;
  heading: string;
  /** The exact text in the document that states the value. */
  span: string;
  value: Quantity;
  status: BrainStatus;
  /** `YYYY-MM-DD`, or null when the document carries no review date. */
  reviewed: string | null;
}

export interface WorldObservation {
  key: string;
  value: Quantity;
  observedAt: string;
  /** Never empty in practice — see `detectContradictions`. */
  evidence: EvidenceRef[];
  basis: Basis;
}

export interface DetectOptions {
  now: Date;
  relativeTolerance?: number;
  stalenessGraceMs?: number;
}

export interface Contradiction {
  kind: ContradictionKind;
  key: string;
  path: string;
  heading: string;
  span: string;
  brainStatus: BrainStatus;
  brainReviewed: string | null;
  brainValue: Quantity;
  observedValue: Quantity;
  observedAt: string;
  evidence: EvidenceRef[];
  /** How much the conflicting value should be believed, derived from its basis
   *  and its evidence. Zero for `unit_mismatch`, where we have PROVEN the two
   *  values agree. */
  confidence: number;
  rationale: string;
}

const normalize = (q: Quantity): { dimension: Dimension; amount: number } => ({
  dimension: UNIT_DIMENSION[q.unit],
  amount: q.amount * TO_BASE[q.unit],
});

const equalWithin = (a: number, b: number, tolerance: number): boolean =>
  Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));

/** Six decimals kills accumulated float noise (`0.07 × 100 = 7.000000000000001`)
 *  without touching any precision a document would actually print. */
const trim = (n: number): string => String(Number(n.toFixed(6)));

export function renderQuantity(amount: number, unit: Unit): string {
  switch (unit) {
    case 'percent':
      return `${trim(amount)}%`;
    case 'dollars':
      return Number.isInteger(amount) ? `$${trim(amount)}` : `$${amount.toFixed(2)}`;
    case 'cents':
      return `${trim(amount)} cents`;
    case 'ratio':
    case 'count':
      return trim(amount);
  }
}

const convertTo = (q: Quantity, unit: Unit): number => normalize(q).amount / TO_BASE[unit];

const dayMs = (iso: string): number => new Date(iso).getTime();

/**
 * Classify one claim against one observation, or `null` when they do not
 * disagree at all. Order matters: the unit check runs before any staleness
 * reasoning, so a formatting difference can never be dressed up as news.
 */
function classify(
  claim: BrainClaim,
  obs: WorldObservation,
  tolerance: number,
  graceMs: number,
): { kind: ContradictionKind; rationale: string } | null {
  const brain = normalize(claim.value);
  const world = normalize(obs.value);

  // Comparing a commission rate to a dollar amount is a modelling error
  // upstream, not a contradiction. Inventing one from it would be pure noise.
  if (brain.dimension !== world.dimension) return null;

  if (equalWithin(brain.amount, world.amount, tolerance)) {
    if (claim.value.unit === obs.value.unit) return null;
    return {
      kind: 'unit_mismatch',
      rationale: `same value written two ways (${renderQuantity(claim.value.amount, claim.value.unit)} vs ${renderQuantity(obs.value.amount, obs.value.unit)}) — a formatting difference, not a disagreement`,
    };
  }

  const reviewedAt = claim.reviewed === null ? NaN : dayMs(`${claim.reviewed}T00:00:00.000Z`);
  const gap = dayMs(obs.observedAt) - reviewedAt;

  if (Number.isNaN(gap) || Math.abs(gap) <= graceMs) {
    return {
      kind: 'genuine_conflict',
      rationale: claim.reviewed
        ? 'the Brain edit and the observation are contemporaneous — neither is stale, so one of them is wrong'
        : 'the document carries no review date, so the two cannot be ordered in time',
    };
  }
  if (gap < 0) {
    return {
      kind: 'stale_observation',
      rationale: `observed ${obs.observedAt}, before the document was reviewed on ${claim.reviewed} — our data is the older of the two`,
    };
  }
  return {
    kind: 'stale_brain',
    rationale: `observed ${obs.observedAt}, after the document was reviewed on ${claim.reviewed} — the world moved and the Brain was not updated`,
  };
}

/** More independent sources make the observation harder to dismiss, with
 *  diminishing returns. One well-sourced observation is already worth reading. */
const evidenceFactor = (count: number): number => Math.min(1, 0.6 + 0.15 * count);

export function detectContradictions(
  brainClaims: readonly BrainClaim[],
  observed: readonly WorldObservation[],
  opts: DetectOptions,
): Contradiction[] {
  const tolerance = opts.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE;
  const graceMs = opts.stalenessGraceMs ?? DEFAULT_STALENESS_GRACE_MS;
  const nowMs = opts.now.getTime();
  // Confidence is filled in at the end, once every witness has been merged.
  const groups = new Map<string, { found: Contradiction; basisWeight: number }>();

  for (const claim of brainClaims) {
    for (const obs of observed) {
      if (obs.key !== claim.key) continue;
      // Rule 4: an unsourced claim is refused at consolidation, and it may not
      // overturn the company's own record through a side door either.
      if (obs.evidence.length === 0) continue;
      // A future timestamp is a clock bug, and a clock bug must not be able to
      // argue that the Brain is out of date.
      if (dayMs(obs.observedAt) > nowMs) continue;

      const verdict = classify(claim, obs, tolerance, graceMs);
      if (!verdict) continue;

      // Three sources reporting one new price is ONE contradiction with three
      // witnesses, not three items in a reviewer's queue.
      const key = `${claim.path}|${claim.key}|${verdict.kind}|${normalize(obs.value).amount}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          basisWeight: BASIS_WEIGHT[obs.basis],
          found: {
            kind: verdict.kind,
            rationale: verdict.rationale,
            key: claim.key,
            path: claim.path,
            heading: claim.heading,
            span: claim.span,
            brainStatus: claim.status,
            brainReviewed: claim.reviewed,
            brainValue: claim.value,
            observedValue: obs.value,
            observedAt: obs.observedAt,
            evidence: [...obs.evidence],
            confidence: 0,
          },
        });
        continue;
      }
      const { found } = existing;
      for (const ref of obs.evidence) {
        const seen = found.evidence.some(
          (e) => e.source_url === ref.source_url && e.span === ref.span,
        );
        if (!seen) found.evidence.push(ref);
      }
      existing.basisWeight = Math.max(existing.basisWeight, BASIS_WEIGHT[obs.basis]);
      if (dayMs(obs.observedAt) > dayMs(found.observedAt)) found.observedAt = obs.observedAt;
    }
  }

  return [...groups.values()]
    .map(({ found, basisWeight }) => ({
      ...found,
      confidence:
        found.kind === 'unit_mismatch'
          ? 0
          : Math.min(1, basisWeight * evidenceFactor(found.evidence.length)),
    }))
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.key.localeCompare(b.key) ||
        a.kind.localeCompare(b.kind) ||
        a.observedAt.localeCompare(b.observedAt),
    );
}

/** Only a stale Brain is worth a patch. Every other kind is a message to a
 *  human, and three of the four would be a wrong edit if applied. */
export const isActionable = (c: Contradiction): boolean => c.kind === 'stale_brain';

export interface EditProposal {
  path: string;
  heading: string;
  oldSpan: string;
  newSpan: string;
  title: string;
  body: string;
}

export type ProposalRefusalCode =
  | 'not_stale_brain'
  | 'not_canonical'
  | 'span_not_found'
  | 'span_ambiguous'
  | 'value_not_in_span'
  | 'incomparable_units';

export type ProposeOutcome =
  | { proposed: true; proposal: EditProposal }
  | { proposed: false; refusal: { code: ProposalRefusalCode; reason: string } };

/**
 * The seam for the side effect, deliberately left unimplemented here.
 *
 * TMOS proposes; a human disposes. The Brain is the company's own record of
 * truth, and an automated system that can silently rewrite it is no longer a
 * record — so nothing in this module calls this port, and a proposal is never
 * auto-merged. The caller wires it to GitHub and a person clicks merge.
 */
export interface PullRequestPort {
  open(proposal: EditProposal): Promise<{ url: string }>;
}

const countOccurrences = (haystack: string, needle: string): number =>
  needle.length === 0 ? 0 : haystack.split(needle).length - 1;

export function proposeEdit(c: Contradiction, documentText: string): ProposeOutcome {
  const refuse = (code: ProposalRefusalCode, reason: string): ProposeOutcome => ({
    proposed: false,
    refusal: { code, reason },
  });

  if (!isActionable(c)) {
    return refuse('not_stale_brain', `kind is ${c.kind}; only stale_brain may propose an edit`);
  }
  // Drafts and superseded documents are not the record. Editing one would
  // launder a guess into the Brain rather than correcting it.
  if (c.brainStatus !== 'canonical') {
    return refuse('not_canonical', `document is ${c.brainStatus}, not the canonical record`);
  }
  if (normalize(c.brainValue).dimension !== normalize(c.observedValue).dimension) {
    return refuse('incomparable_units', 'the two values are not measured in the same dimension');
  }

  // A patch against a span you cannot locate — or can locate twice — is a
  // corruption waiting to happen.
  const occurrences = countOccurrences(documentText, c.span);
  if (occurrences === 0) {
    return refuse('span_not_found', `the quoted span no longer appears in ${c.path}`);
  }
  if (occurrences > 1) {
    return refuse('span_ambiguous', `the quoted span appears ${occurrences} times in ${c.path}`);
  }

  const oldText = c.brainValue.text ?? renderQuantity(c.brainValue.amount, c.brainValue.unit);
  if (!c.span.includes(oldText)) {
    return refuse(
      'value_not_in_span',
      `"${oldText}" does not appear in the span it should replace`,
    );
  }

  // Written in the unit the document already uses: patching "20%" to "0.25"
  // would introduce the very mismatch the classifier refuses to act on.
  const newText = renderQuantity(convertTo(c.observedValue, c.brainValue.unit), c.brainValue.unit);
  const newSpan = c.span.replace(oldText, newText);

  return {
    proposed: true,
    proposal: {
      path: c.path,
      heading: c.heading,
      oldSpan: c.span,
      newSpan,
      title: `brain(${c.key}): ${oldText} → ${newText} in ${c.path}`,
      body: [
        `The Brain states **${oldText}**; the world model observes **${newText}**.`,
        '',
        `- document: \`${c.path}\` § ${c.heading}`,
        `- last reviewed: ${c.brainReviewed ?? 'unknown'}`,
        `- observed at: ${c.observedAt}`,
        `- confidence: ${c.confidence.toFixed(2)} — computed from the evidence below, not self-reported`,
        '',
        'Evidence:',
        ...c.evidence.map((e) => `- ${e.source_url} — "${e.span}" (observed ${e.observed_at})`),
        '',
        'TMOS proposes, a human disposes. Review the span against the code it',
        'documents before merging: the Brain is the record, and no automated',
        'system may rewrite the record on its own.',
      ].join('\n'),
    },
  };
}
