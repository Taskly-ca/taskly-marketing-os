/**
 * THE HARNESS — run the set, and report what the numbers are worth.
 *
 * Three jobs, and the third is the one that makes the first two honest:
 *
 *  1. Turn a pipeline answer into an `EvalTranscript` (the two adapters).
 *  2. Score every case and pool the results (`runEval`).
 *  3. Print the pooled numbers **next to the size of their own blind spot**
 *     (`formatEvalReport`). A citation-recall figure with no blind-spot count
 *     beside it is the same species of claim as an AI Overview with a
 *     footnote: technically sourced, and read as more than it says.
 *
 * ── FOUR RULES THIS FILE ENFORCES ON THE ARITHMETIC ───────────────────────
 *
 * **Blind-spot cases are excluded from the pooled citation numbers.** They are
 * answers we know are wrong that every check here scores clean, so including
 * them would raise recall — the metric would be rewarded for the failures it
 * cannot see. They are counted, printed and named instead.
 *
 * **Abstentions are excluded from the citation numbers too.** A refused answer
 * has no citations to be right or wrong about, and scoring one 1.0 would make
 * "answer fewer questions" the cheapest way to improve citation recall.
 * Whether the refusal was correct is a separate count, and it is the one that
 * stops a system from buying accuracy with silence.
 *
 * **Web and grounded are pooled separately as well as together.** They fail
 * differently — web fetches the wrong company's page, grounded quotes our own
 * strategy document as though it were an observation — and a single average
 * lets each hide behind the other.
 *
 * **`live-recorded` and `hand-built` are counted apart.** A hand-built fixture
 * proves a scorer path; it proves nothing about the pipeline. Reporting the two
 * as one figure would be the same error as reporting a model-judged number as a
 * measurement.
 */
import type { CitableSpan } from '../attribute.js';
import { splitSentences } from '../sentences.js';
import type { GroundedAnswer, StreamedAnswer } from '../stream.js';

import { EVAL_CASES, EVAL_FIXTURES } from './cases.js';
import type { EvalCitationMetrics } from './metrics.js';
import { poolCitations, scoreCitations } from './metrics.js';
import type { EvalAssertion, EvalCase, EvalMode, EvalSentence, EvalSpan, EvalTranscript } from './types.js';

/* ── adapters: a pipeline answer becomes a transcript ─────────────────────── */

/**
 * Line the pipeline's per-sentence verdicts up with the sentences a reader saw.
 *
 * `SentenceEvent` carries `n`, a verdict and a reason, and deliberately not the
 * text — the text reached the client as `DeltaEvent`s. Rather than reassemble
 * it from deltas the caller may not have kept, the answer text is re-split with
 * `splitSentences`, which is the same `SentenceSplitter` the pipeline ran, fed
 * the same characters. The two lists must therefore be the same length.
 *
 * When they are not, the transcript is marked `misaligned` and the report
 * EXCLUDES it. Repairing the alignment by index would attach verdicts to the
 * wrong sentences, and every number computed from it would then be wrong in a
 * way that looks entirely normal — which is the worst failure a measuring tool
 * can have. A loud exclusion is worth more than a quiet average.
 */
function align(text: string, verdicts: readonly { n: number; verdict: 'confirmed' | 'flagged'; why?: string }[]): {
  sentences: EvalSentence[];
  misaligned?: string;
} {
  const texts = splitSentences(text);
  if (texts.length !== verdicts.length) {
    return {
      sentences: [],
      misaligned: `re-splitting the answer produced ${texts.length} sentence(s) but the run reported ${verdicts.length} verdict(s) — the transcript cannot be trusted to attach a verdict to the right sentence`,
    };
  }
  return {
    sentences: verdicts.map((v, i) => ({
      n: v.n,
      text: texts[i] ?? '',
      verdict: v.verdict,
      ...(v.why === undefined ? {} : { why: v.why }),
    })),
  };
}

const toEvalSpans = (spans: readonly CitableSpan[], kind?: EvalSpan['kind']): EvalSpan[] =>
  spans.map((s) => ({
    id: s.id,
    locator: s.url,
    text: s.span,
    ...(kind === undefined ? {} : { kind }),
  }));

/** A web-mode answer, flattened. */
export function transcriptFromStreamed(caseId: string, a: StreamedAnswer): EvalTranscript {
  const { sentences, misaligned } = align(a.text, a.sentences);
  return {
    caseId,
    mode: 'web',
    question: a.question,
    spans: toEvalSpans(a.spans, 'web'),
    sentences,
    sourceLocators: a.sources.map((s) => s.url),
    note: a.note,
    costCents: a.costCents,
    ...(misaligned === undefined ? {} : { misaligned }),
  };
}

/** A grounded answer, flattened. `kind` is kept per span rather than stamped
 *  across the transcript: one grounded answer routinely cites a competitor's
 *  page and one of our own documents in adjacent sentences, and those are not
 *  equal evidence. */
export function transcriptFromGrounded(caseId: string, a: GroundedAnswer): EvalTranscript {
  const { sentences, misaligned } = align(a.text, a.sentences);
  return {
    caseId,
    mode: 'grounded',
    question: a.question,
    spans: a.spans.map((s) => ({ id: s.id, locator: s.url, text: s.span, kind: s.kind })),
    sentences,
    sourceLocators: a.sources.map((s) => s.url),
    note: a.note,
    costCents: a.costCents,
    ...(misaligned === undefined ? {} : { misaligned }),
  };
}

/* ── per-case assertions ──────────────────────────────────────────────────── */

export interface EvalAssertionResult {
  readonly kind: EvalAssertion['kind'];
  readonly value: string;
  readonly ok: boolean;
  readonly why: string;
}

/** Substring tests, and nothing richer. Anything that needs to weigh meaning is
 *  a judgement and belongs in `judge.ts`, labelled as one. */
function checkAssertions(t: EvalTranscript, assertions: readonly EvalAssertion[]): EvalAssertionResult[] {
  const prose = t.sentences.map((s) => s.text).join(' ');
  return assertions.map((a) => {
    let ok: boolean;
    switch (a.kind) {
      case 'answer-carries-figure':
        ok = prose.includes(a.value);
        break;
      case 'cites-locator':
        ok = t.spans.some((s) => s.locator.includes(a.value));
        break;
      case 'never-says':
        // Case-insensitive: the honesty boundary is about the claim, and a
        // capitalised banned word is the same claim.
        ok = !prose.toLowerCase().includes(a.value.toLowerCase());
        break;
    }
    return { kind: a.kind, value: a.value, ok, why: a.why };
  });
}

/* ── the report ───────────────────────────────────────────────────────────── */

export interface EvalOutcome {
  readonly caseId: string;
  readonly mode: EvalMode;
  readonly shape: EvalCase['shape'];
  readonly provenance: EvalCase['provenance'];
  readonly expect: EvalCase['expect'];
  /** The run produced prose. `false` is an abstention. */
  readonly answered: boolean;
  readonly abstentionCorrect: boolean;
  readonly citations: EvalCitationMetrics;
  readonly assertions: readonly EvalAssertionResult[];
  /** Present on `blind-spot` cases: what a reader can see and no check here can. */
  readonly blindSpot?: string;
  readonly excluded?: string;
  readonly costCents: number;
}

export interface EvalAbstention {
  readonly shouldAbstain: number;
  readonly correctlyAbstained: number;
  /** Answered a question that had nothing behind it. The failure the published
   *  citation-accuracy numbers are made of. */
  readonly wronglyAnswered: number;
  readonly shouldAnswer: number;
  readonly correctlyAnswered: number;
  /** Refused a question it could have answered. Cheap to over-tune for, which
   *  is why it is reported beside `wronglyAnswered` and not under it. */
  readonly wronglyAbstained: number;
}

export interface EvalReport {
  readonly cases: number;
  readonly ran: number;
  /** Cases with no transcript — a live run that was not asked to cover them,
   *  or a fixture that was deleted. Named, never counted as passes. */
  readonly missing: readonly string[];
  /** Transcripts excluded from the citation numbers, with the reason. */
  readonly excluded: readonly { readonly caseId: string; readonly why: string }[];
  /** Pooled over answered, non-blind-spot cases only. See the header. */
  readonly citations: EvalCitationMetrics;
  readonly web: EvalCitationMetrics;
  readonly grounded: EvalCitationMetrics;
  readonly abstention: EvalAbstention;
  readonly assertionsRun: number;
  readonly assertionFailures: readonly { readonly caseId: string; readonly value: string; readonly why: string }[];
  /**
   * The measurement of our own blindness. Every entry is an answer that is
   * wrong and that scores a clean 1.0 on everything above. This list going up
   * is not a regression in the pipeline; it is this harness becoming more
   * honest about what it cannot see.
   */
  readonly blindSpots: readonly { readonly caseId: string; readonly note: string }[];
  readonly liveRecorded: number;
  readonly handBuilt: number;
  /** What the transcripts cost when they were produced. Zero for a fixture run:
   *  re-scoring is free, and saying so is the argument for the fixture path. */
  readonly costCents: number;
  readonly outcomes: readonly EvalOutcome[];
}

/** Produces the transcript for one case, or null if this run does not cover it. */
export type EvalResolver = (c: EvalCase) => Promise<EvalTranscript | null> | EvalTranscript | null;

/** The free path: score the recorded answers. No key, no network, no spend. */
export const fixtureResolver: EvalResolver = (c) => EVAL_FIXTURES[c.id] ?? null;

const EMPTY: EvalCitationMetrics = poolCitations([]);

/**
 * Run the set.
 *
 * `resolve` is the whole variation point: `fixtureResolver` re-scores recorded
 * answers for nothing, and `eval.live.test.ts` passes one that drives the real
 * pipeline. Identical scoring either way — a fixture number and a live number
 * have to be comparable or the cheap path is not a proxy for anything.
 */
export async function runEval(
  cases: readonly EvalCase[] = EVAL_CASES,
  resolve: EvalResolver = fixtureResolver,
): Promise<EvalReport> {
  const outcomes: EvalOutcome[] = [];
  const missing: string[] = [];
  const excluded: { caseId: string; why: string }[] = [];
  const blindSpots: { caseId: string; note: string }[] = [];
  const assertionFailures: { caseId: string; value: string; why: string }[] = [];

  const pool: EvalCitationMetrics[] = [];
  const byMode: Record<EvalMode, EvalCitationMetrics[]> = { web: [], grounded: [] };

  let assertionsRun = 0;
  let cost = 0;
  const abst = {
    shouldAbstain: 0, correctlyAbstained: 0, wronglyAnswered: 0,
    shouldAnswer: 0, correctlyAnswered: 0, wronglyAbstained: 0,
  };

  for (const c of cases) {
    const t = await resolve(c);
    if (t === null) {
      missing.push(c.id);
      continue;
    }
    cost += t.costCents;

    const answered = t.sentences.length > 0;
    if (c.expect === 'empty') {
      abst.shouldAbstain += 1;
      // An abstention is correct only when it also SAYS why. A silent empty
      // answer and a refusal with a reason look identical in a count and are
      // completely different products — §10 records a stored empty answer being
      // replayed as prose, which is the failure this leg exists to catch.
      if (!answered && t.note.trim() !== '') abst.correctlyAbstained += 1;
      else abst.wronglyAnswered += 1;
    } else {
      abst.shouldAnswer += 1;
      if (answered) abst.correctlyAnswered += 1;
      else abst.wronglyAbstained += 1;
    }

    const results = checkAssertions(t, c.assertions ?? []);
    assertionsRun += results.length;
    for (const r of results) if (!r.ok) assertionFailures.push({ caseId: c.id, value: r.value, why: r.why });

    const metrics = t.misaligned === undefined ? scoreCitations(t) : EMPTY;

    if (t.misaligned !== undefined) excluded.push({ caseId: c.id, why: t.misaligned });
    else if (c.shape === 'blind-spot') {
      excluded.push({ caseId: c.id, why: 'known blind spot — scoring it would credit the metric for a failure it cannot see' });
      blindSpots.push({ caseId: c.id, note: c.blindSpot ?? '' });
    } else if (!answered) {
      excluded.push({ caseId: c.id, why: 'no prose — an abstention has no citations to score' });
    } else {
      pool.push(metrics);
      byMode[c.mode].push(metrics);
    }

    outcomes.push({
      caseId: c.id,
      mode: c.mode,
      shape: c.shape,
      provenance: c.provenance,
      expect: c.expect,
      answered,
      abstentionCorrect: c.expect === 'empty' ? !answered && t.note.trim() !== '' : answered,
      citations: metrics,
      assertions: results,
      ...(c.blindSpot === undefined ? {} : { blindSpot: c.blindSpot }),
      ...(t.misaligned === undefined ? {} : { excluded: t.misaligned }),
      costCents: t.costCents,
    });
  }

  return {
    cases: cases.length,
    ran: outcomes.length,
    missing,
    excluded,
    citations: poolCitations(pool),
    web: poolCitations(byMode.web),
    grounded: poolCitations(byMode.grounded),
    abstention: abst,
    assertionsRun,
    assertionFailures,
    blindSpots,
    liveRecorded: outcomes.filter((o) => o.provenance === 'live-recorded').length,
    handBuilt: outcomes.filter((o) => o.provenance === 'hand-built').length,
    costCents: cost,
    outcomes,
  };
}

/* ── printing ─────────────────────────────────────────────────────────────── */

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/**
 * The report as text.
 *
 * Ordered so the caveats cannot be scrolled past: every headline number is
 * followed immediately by what it excludes, and the blind-spot block is last
 * because it is the sentence a reader should leave with. Nothing here is a
 * model's opinion — `judge.ts` prints its own block, under its own heading,
 * with the word "model-judged" in it.
 */
export function formatEvalReport(r: EvalReport): string {
  const out: string[] = [];
  out.push(`ANSWER-ENGINE EVAL — ${r.ran}/${r.cases} case(s) run, ${r.liveRecorded} from live runs, ${r.handBuilt} hand-built`);
  out.push(`  recorded cost of these transcripts: ${r.costCents.toFixed(3)}¢ (re-scoring them is free)`);
  out.push('');
  out.push('DETERMINISTIC — ALCE-style citation metrics, no model in the loop');
  const line = (label: string, m: EvalCitationMetrics): string =>
    `  ${label.padEnd(10)} recall ${pct(m.recall)}  strict-recall ${pct(m.strictRecall)}  precision ${pct(m.precision)}` +
    `  (${m.statements} statement(s), ${m.citations} citation(s), ${m.vacuousStatements} with nothing checkable)`;
  out.push(line('all', r.citations));
  out.push(line('web', r.web));
  out.push(line('grounded', r.grounded));
  out.push(
    `  units: ${r.citations.unitsMet}/${r.citations.unitsRequired} figures and names in a statement were carried by a span it cites`,
  );
  out.push(
    `  agreement with the shipped per-sentence check: ${r.citations.agreesWithPipeline} agree, ${r.citations.disagreesWithPipeline} disagree`,
  );
  out.push('');
  out.push('ABSTENTION — a system that always answers is not being measured');
  out.push(
    `  should refuse: ${r.abstention.shouldAbstain} · refused with a reason ${r.abstention.correctlyAbstained} · answered anyway ${r.abstention.wronglyAnswered}`,
  );
  out.push(
    `  should answer: ${r.abstention.shouldAnswer} · answered ${r.abstention.correctlyAnswered} · refused ${r.abstention.wronglyAbstained}`,
  );
  out.push('');
  out.push(`ASSERTIONS — ${r.assertionsRun - r.assertionFailures.length}/${r.assertionsRun} passed`);
  for (const f of r.assertionFailures) out.push(`  FAIL ${f.caseId}: "${f.value}" — ${f.why}`);
  if (r.missing.length > 0) out.push(`  not covered by this run: ${r.missing.join(', ')}`);
  for (const e of r.excluded) out.push(`  excluded from the numbers · ${e.caseId}: ${e.why}`);
  out.push('');
  out.push(`WHAT THESE NUMBERS CANNOT SEE — ${r.blindSpots.length} known-bad answer(s) that score clean`);
  for (const b of r.blindSpots) out.push(`  ${b.caseId}: ${b.note}`);
  out.push(
    '  A deterministic check compares strings. It cannot tell "these words are in the span"',
    '  from "the span says this", so a sentence that misreads a genuine quote scores 1.0.',
    '  Recall above is therefore a ceiling on citation soundness, not a claim about truth.',
  );
  return out.join('\n');
}
