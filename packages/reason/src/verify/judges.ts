/**
 * L1 and L2 — the two judged levels above the deterministic floor.
 *
 * L1 GROUNDEDNESS asks one question: does this claim follow from THIS span,
 * seen alone? The isolation is the whole mechanism. A judge shown the rest of
 * the document reconstructs the missing step from context the reader will never
 * have, then reports the claim as grounded — which is exactly the failure the
 * level exists to catch. So the request type carries a claim and a single span
 * and nothing else, it is branded so it can only be built here, and it is
 * rebuilt from primitives at the boundary so a cast cannot smuggle context past
 * the type.
 *
 * L2 RUBRIC is one call per digest, not per finding. Per-finding is the obvious
 * shape and it multiplies cost by the digest size for a score that is only ever
 * read comparatively. Temperature 0, and the model version is PINNED: an
 * unpinned judge silently changes what "passes" as the provider ships new
 * weights, and every comparison against last month's digest quietly stops
 * meaning anything. The pin is recorded in the verdict, not assumed.
 *
 * Both judges ABSTAIN on anything they cannot validate. An abstention is a
 * "needs a human" — never a pass, and never silently a fail either.
 */
import { assertL0 } from './l0.js';
import type { L0Result } from './l0.js';
import type { VerifiableFinding } from './adversarial.js';

export type JudgeOutcome = 'pass' | 'fail' | 'abstain';

/** Injected — library code never reads the wall clock. */
export type Clock = () => string;

/* ── L1: groundedness, one span at a time ─────────────────────────────────── */

declare const isolatedSpan: unique symbol;

/**
 * The judge's entire view. Branded so it cannot be constructed outside this
 * module: if a caller could write `{ claim, span, document }`, the isolation
 * would last exactly until the first person who thought more context would help.
 */
export interface L1Request {
  readonly claim: string;
  readonly span: string;
  readonly [isolatedSpan]: true;
}

/** From the model. Loosely typed because it is validated, not trusted. */
export interface L1Response {
  /** `entailed` | `not_entailed` | `abstain`. Anything else ⇒ abstain. */
  label: string;
  reason: string;
}

export interface L1Port {
  judge(request: L1Request): Promise<L1Response>;
}

export interface L1Input {
  claim: string;
  /** The cited spans. Each is judged alone; they are never concatenated. */
  spans: readonly string[];
}

export interface L1Verdict {
  outcome: JudgeOutcome;
  /** The span the verdict turned on. */
  span: string | null;
  reason: string;
}

/** Exactly two own keys, frozen. The runtime half of the isolation guarantee. */
const sealL1Request = (claim: string, span: string): L1Request =>
  Object.freeze({ claim, span }) as unknown as L1Request;

/**
 * Spans are judged one at a time, in order, and the walk STOPS at the first
 * entailment: evidence is disjunctive, so one sufficient span settles the
 * question and every further call is money spent on an answer that cannot
 * change. Same rule as the ladder, one level down.
 *
 * When nothing entails, abstentions outrank failures — "the judge could not
 * read this span" must not be recorded as "this span refutes the claim".
 */
export async function judgeL1(port: L1Port, input: L1Input): Promise<L1Verdict> {
  const claim = input.claim;
  const abstentions: string[] = [];
  let firstFail: L1Verdict | null = null;

  for (const span of input.spans) {
    let res: L1Response;
    try {
      res = await port.judge(sealL1Request(claim, span));
    } catch (err) {
      abstentions.push(
        `abstained: judge failed (${err instanceof Error ? err.message : 'unknown'})`,
      );
      continue;
    }

    if (typeof res.reason !== 'string' || res.reason.trim().length === 0) {
      abstentions.push('abstained: judge returned a label with no reason — unreviewable');
      continue;
    }
    if (res.label === 'entailed') return { outcome: 'pass', span, reason: res.reason };
    if (res.label === 'not_entailed') {
      firstFail ??= { outcome: 'fail', span, reason: res.reason };
      continue;
    }
    if (res.label === 'abstain') {
      abstentions.push(`abstained: ${res.reason}`);
      continue;
    }
    abstentions.push(`abstained: unrecognised label "${res.label}"`);
  }

  const firstAbstention = abstentions[0];
  if (firstAbstention !== undefined) {
    return { outcome: 'abstain', span: null, reason: firstAbstention };
  }
  return firstFail ?? { outcome: 'abstain', span: null, reason: 'abstained: no spans to judge' };
}

/* ── L2: the digest rubric ────────────────────────────────────────────────── */

export const RUBRIC_DIMENSIONS = ['specificity', 'actionability', 'source_quality'] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

/** Discrete anchors beat a float: 0-3 is a judgement, 0.73 is a guess. */
export const RUBRIC_MAX = 3;

/**
 * Out of 9. A finding scoring 1 across the board is technically fine and not
 * worth a human's attention; 5 forces at least one dimension to 2 or better.
 * Independently, a 0 on ANY dimension fails outright — nothing makes up for a
 * finding with no source quality.
 */
export const L2_MIN_TOTAL = 5;

export interface PinnedModel {
  model: string;
  version: string;
}

/** Aliases that look like a pin and are not: they move under you. */
const FLOATING_TAGS: readonly string[] = ['latest', 'stable', 'current', 'head', 'main'];

export class UnpinnedModelError extends Error {
  constructor(judge: PinnedModel) {
    super(
      `L2 judge "${judge.model}" has no pinned version (got "${judge.version}"). ` +
        'An unpinned judge changes what "passes" whenever the provider ships weights, ' +
        'and every comparison against an earlier digest stops meaning anything.',
    );
    this.name = 'UnpinnedModelError';
  }
}

/** Throws, deliberately. An unpinned judge is a misconfiguration: returning an
 *  abstention would let a pipeline run for months looking healthy while
 *  producing verdicts that cannot be compared to each other. */
export function assertPinned(judge: PinnedModel): void {
  const v = judge.version.trim().toLowerCase();
  if (v.length === 0 || FLOATING_TAGS.includes(v)) throw new UnpinnedModelError(judge);
}

export interface RubricItem {
  id: string;
  claim: string;
  so_what: string;
}

export interface RubricRequest {
  readonly items: readonly RubricItem[];
  readonly dimensions: readonly RubricDimension[];
  readonly temperature: 0;
  readonly judge: PinnedModel;
}

export interface RubricScore {
  id: string;
  scores: Partial<Record<RubricDimension, number>>;
  note: string;
}

export interface RubricResponse {
  scores: readonly RubricScore[];
}

export interface L2Port {
  score(request: RubricRequest): Promise<RubricResponse>;
}

export interface L2Item {
  id: string;
  outcome: JudgeOutcome;
  scores: Record<RubricDimension, number> | null;
  reason: string;
}

export interface L2Verdict {
  outcome: JudgeOutcome;
  items: readonly L2Item[];
  /** Recorded, not assumed — this is what makes an old verdict interpretable. */
  judge: PinnedModel;
  checked_at: string;
  reason: string;
}

export interface L2Options {
  items: readonly RubricItem[];
  judge: PinnedModel;
  now: Clock;
}

const abstainAll = (items: readonly RubricItem[], reason: string): L2Item[] =>
  items.map((i) => ({ id: i.id, outcome: 'abstain' as const, scores: null, reason }));

/** Validate one entry. Anything unexpected abstains rather than guesses. */
function scoreItem(entry: RubricScore | undefined, id: string): L2Item {
  if (!entry) {
    return {
      id,
      outcome: 'abstain',
      scores: null,
      reason: 'abstained: the judge returned no entry',
    };
  }
  const scores = {} as Record<RubricDimension, number>;
  for (const d of RUBRIC_DIMENSIONS) {
    const raw = entry.scores[d];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > RUBRIC_MAX) {
      return {
        id,
        outcome: 'abstain',
        scores: null,
        reason: `abstained: "${d}" is missing or outside 0-${RUBRIC_MAX} (got ${String(raw)})`,
      };
    }
    scores[d] = raw;
  }

  const zero = RUBRIC_DIMENSIONS.find((d) => scores[d] === 0);
  if (zero) {
    return { id, outcome: 'fail', scores, reason: `scored 0 on ${zero} — nothing offsets that` };
  }
  const total = RUBRIC_DIMENSIONS.reduce((sum, d) => sum + scores[d], 0);
  if (total < L2_MIN_TOTAL) {
    return {
      id,
      outcome: 'fail',
      scores,
      reason: `total ${total} is below the floor of ${L2_MIN_TOTAL}`,
    };
  }
  return { id, outcome: 'pass', scores, reason: entry.note || `total ${total}` };
}

export async function judgeL2(port: L2Port, opts: L2Options): Promise<L2Verdict> {
  assertPinned(opts.judge);
  const { items, judge } = opts;
  const stamp = { judge, checked_at: opts.now() };

  let response: RubricResponse;
  try {
    response = await port.score({
      items,
      dimensions: RUBRIC_DIMENSIONS,
      temperature: 0,
      judge,
    });
  } catch (err) {
    const reason = `abstained: rubric call failed (${err instanceof Error ? err.message : 'unknown'})`;
    return { outcome: 'abstain', items: abstainAll(items, reason), reason, ...stamp };
  }

  // An id we never sent means the score-to-finding mapping is unreliable for
  // EVERY item, not only the phantom one. There is no safe partial reading.
  const requested = new Set(items.map((i) => i.id));
  const ghost = response.scores.find((s) => !requested.has(s.id));
  if (ghost) {
    const reason = `abstained: the judge scored an id it was never sent ("${ghost.id}")`;
    return { outcome: 'abstain', items: abstainAll(items, reason), reason, ...stamp };
  }

  const byId = new Map(response.scores.map((s) => [s.id, s]));
  const scored = items.map((i) => scoreItem(byId.get(i.id), i.id));
  const outcome: JudgeOutcome = scored.some((s) => s.outcome === 'abstain')
    ? 'abstain'
    : scored.some((s) => s.outcome === 'fail')
      ? 'fail'
      : 'pass';

  return { outcome, items: scored, reason: `${scored.length} item(s) scored`, ...stamp };
}

/* ── the ladder ───────────────────────────────────────────────────────────── */

export interface LadderInput {
  /** The finding's id — used to find its entry in the digest-level rubric. */
  id: string;
  finding: VerifiableFinding;
  retrievedUrls: Iterable<string>;
  l1: L1Port;
  /**
   * The digest's L2 verdict, computed ONCE by `judgeL2` for all findings.
   * A port here would reintroduce the per-finding cost L2's design exists to
   * avoid. `null` fails closed: a missing rubric is not a passed rubric.
   */
  l2: L2Verdict | null;
}

export interface LadderResult {
  ok: boolean;
  /** The level that stopped it. An abstention counts as stopping there. */
  failed_at: 'l0' | 'l1' | 'l2' | null;
  reason: string;
  l0: L0Result;
  /** Null when the level was never reached — the audit trail of the short-circuit. */
  l1: L1Verdict | null;
  l2: L2Verdict | null;
}

/**
 * L0 → L1 → L2, cheapest first, stopping at the first level that does not pass.
 * The ordering is the cost control: a fabricated number is caught by a string
 * comparison, and no model is ever asked whether it was meaningful.
 */
export async function verificationLadder(input: LadderInput): Promise<LadderResult> {
  const { finding } = input;

  const l0 = assertL0({
    claim: finding.claim,
    evidence: finding.evidence.map((e) => ({ ...e, signal_id: null, fact_id: null })),
    retrievedUrls: input.retrievedUrls,
  });
  if (!l0.ok) {
    return {
      ok: false,
      failed_at: 'l0',
      reason: `L0: ${l0.violations.map((v) => v.detail).join('; ')}`,
      l0,
      l1: null,
      l2: null,
    };
  }

  const l1 = await judgeL1(input.l1, {
    claim: finding.claim,
    spans: finding.evidence.map((e) => e.span),
  });
  if (l1.outcome !== 'pass') {
    return { ok: false, failed_at: 'l1', reason: `L1: ${l1.reason}`, l0, l1, l2: null };
  }

  if (!input.l2) {
    return {
      ok: false,
      failed_at: 'l2',
      reason: 'L2: no digest-level rubric verdict was supplied — a missing rubric is not a pass',
      l0,
      l1,
      l2: null,
    };
  }

  const item = input.l2.items.find((i) => i.id === input.id);
  if (!item || item.outcome !== 'pass') {
    return {
      ok: false,
      failed_at: 'l2',
      reason: `L2: ${item ? item.reason : `the digest rubric has no entry for "${input.id}"`}`,
      l0,
      l1,
      l2: input.l2,
    };
  }

  return { ok: true, failed_at: null, reason: 'passed L0, L1 and L2', l0, l1, l2: input.l2 };
}
