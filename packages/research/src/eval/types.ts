/**
 * WHAT AN EVALUATION IS ALLOWED TO CLAIM — the shapes, and the boundary.
 *
 * The answer engine's whole claim is that its citations are better than the
 * industry's. The published numbers it is measured against are real and
 * uncomfortable: Columbia Journalism Review found >60% of citations incorrect
 * across eight tools; Oumi found only 67% of Google AI Overviews' individual
 * claims supported by their own cited sources; UPenn found 3-13% of citation
 * URLs in commercial deep-research agents fully hallucinated. We have had, up
 * to this file, no number at all — only an argument, and one live anecdote of
 * the argument failing (§10 of TMOS-ANSWER-ENGINE: a sentence that conflated
 * two phrases from one of our own documents and passed every check, because
 * both phrases genuinely were in the cited span).
 *
 * ── THE ONE RULE THIS PACKAGE ENFORCES ON ITSELF ──────────────────────────
 *
 * A number produced by a model is not a measurement, and putting one beside a
 * deterministic number launders it. So the two never share a field, a total or
 * a report object: `EvalReport` is deterministic end to end and has no place to
 * put a judged number, and `judge.ts` returns its own separate shape whose type
 * name says `Judge` out loud. Merging them is a type error, not a code review.
 *
 * ── WHY A TRANSCRIPT AND NOT A PIPELINE CALL ──────────────────────────────
 *
 * Everything here scores an `EvalTranscript` — a flat record of one answered
 * question. That indirection is load-bearing three ways:
 *
 *  1. **It is free to score.** A recorded transcript costs nothing to re-score,
 *     so the metrics can be re-run on every commit while the answers behind
 *     them were paid for once. A harness nobody runs measures nothing.
 *  2. **It is the same shape live and fixed.** `transcriptFromStreamed` and
 *     `transcriptFromGrounded` in `harness.ts` are the only adapters; a live
 *     run and a fixture run go through identical scoring code, so a fixture
 *     result and a live result are comparable numbers rather than two
 *     dialects.
 *  3. **It scores what the reader saw.** The prose here is post-`MarkerGate`:
 *     markers the model invented were already deleted on their way to the page.
 *     Scoring the raw model output instead would measure a text no human is
 *     ever shown, and would credit the pipeline for a fabrication it caught
 *     while also penalising it for having made one.
 */
import type { SourceKind } from '../events.js';

/** Which entry point answered. `web` searched and read pages; `grounded` was
 *  selected out of records we already hold. Kept on every transcript because
 *  the two have different failure modes and averaging them hides both. */
export type EvalMode = 'web' | 'grounded';

/**
 * One proven-verbatim quote, as the reader could inspect it.
 *
 * `locator` rather than `url`: a Brain passage's locator is a vault path and is
 * not openable, and a shape that called it a URL would invite a renderer — or a
 * scorer — to treat "has a URL" as "is checkable on the open web".
 */
export interface EvalSpan {
  /** The number that appears in the prose as `[id]`. */
  readonly id: number;
  readonly locator: string;
  /** Whitespace-normalised, case preserved — as `attribute.ts` proved it. */
  readonly text: string;
  readonly kind?: SourceKind;
}

/** One completed sentence of the answer, with the pipeline's own verdict on it.
 *  The verdict is carried so the harness can report where the shipped gate and
 *  the field-standard metric DISAGREE, which is more informative than either
 *  number alone. */
export interface EvalSentence {
  /** 0-based, as `SentenceSplitter` numbers them. */
  readonly n: number;
  /** Post-`MarkerGate`: exactly the characters that reached the page. */
  readonly text: string;
  readonly verdict: 'confirmed' | 'flagged';
  readonly why?: string;
}

/** One answered question, flattened. Everything the metrics read. */
export interface EvalTranscript {
  readonly caseId: string;
  readonly mode: EvalMode;
  readonly question: string;
  readonly spans: readonly EvalSpan[];
  readonly sentences: readonly EvalSentence[];
  /** Every source the run read, whether or not a span came out of it. An
   *  answer resting on one of eight documents is a different object from one
   *  resting on the only document there was. */
  readonly sourceLocators: readonly string[];
  /** The run's own reason for a short or empty answer. Non-empty is how an
   *  abstention is recognised — see `EvalCase.expect`. */
  readonly note: string;
  readonly costCents: number;
  /**
   * Set when the adapter could not line the pipeline's per-sentence verdicts up
   * with the sentences it re-split out of the answer text. Recorded rather than
   * repaired: a silent realignment would attach verdicts to the wrong
   * sentences, and every number below it would be wrong in a way that looks
   * fine. A transcript carrying this is reported and excluded from scoring.
   */
  readonly misaligned?: string;
}

/* ── the regression set ───────────────────────────────────────────────────── */

/**
 * Why a case is in the set — recorded on the case itself, because a regression
 * set whose entries have no stated purpose decays into a list nobody prunes.
 */
export type EvalCaseShape =
  /** A question with a clear, figure-bearing answer in the sources. */
  | 'factual'
  /** A question that SHOULD come back empty. As important as the factual ones:
   *  a system that always answers is not being measured, it is being flattered. */
  | 'abstain'
  /** Probes a specific gate — the honesty boundary, the causal lint, a
   *  fabricated marker, a figure the model derived rather than read. */
  | 'gate'
  /** A KNOWN-BAD answer that every deterministic check in this harness scores
   *  clean. The set carries these on purpose: they are the measurement of our
   *  blindness, and the only number in the report that gets worse as the
   *  harness gets more honest. */
  | 'blind-spot';

/** Where a fixture's text came from. A hand-built transcript proves a scorer
 *  path; a recorded one proves the system did this. Conflating them would let
 *  a synthetic pass be reported as evidence about the live pipeline. */
export type EvalProvenance = 'live-recorded' | 'hand-built';

/** A deterministic, case-specific assertion. Each is a substring test, because
 *  anything richer is a judgement and judgements belong in `judge.ts`. */
export interface EvalAssertion {
  readonly kind:
    /** This figure must appear in the answer prose. */
    | 'answer-carries-figure'
    /** Some span's locator must contain this string. */
    | 'cites-locator'
    /** This string must NOT appear anywhere in the prose. */
    | 'never-says';
  readonly value: string;
  /** The failure this assertion exists to catch, in one line. */
  readonly why: string;
}

export interface EvalCase {
  readonly id: string;
  readonly mode: EvalMode;
  readonly question: string;
  readonly shape: EvalCaseShape;
  /** `empty` means the correct outcome is no prose and a stated reason. */
  readonly expect: 'answer' | 'empty';
  readonly provenance: EvalProvenance;
  readonly why: string;
  readonly assertions?: readonly EvalAssertion[];
  /**
   * Present only on `blind-spot` cases. The text names what a human reader can
   * see and no check in this file can: the harness prints it verbatim rather
   * than scoring it, because a blind spot with a score attached stops being one.
   */
  readonly blindSpot?: string;
  /**
   * Safe to run against the real pipeline. Only web-mode cases can be: grounded
   * retrieval lives in the console and is not reachable from this package, so
   * grounded cases are fixture-only and the report says so rather than
   * reporting a grounded live number that was never measured.
   */
  readonly live?: boolean;
}
