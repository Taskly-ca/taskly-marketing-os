/**
 * THE PART THAT IS NOT A MEASUREMENT — a model reading for meaning.
 *
 * `metrics.ts` ends at a hard edge: it can prove a quote is real and that a
 * sentence's figures and names are carried by the spans it cites, and it cannot
 * tell "these words are in the span" from "the span says this". The one live
 * failure we have on record lives exactly in that gap (TMOS-ANSWER-ENGINE §10:
 * *"Its market positioning is described as safe-but-narrow and broad and
 * safe"*, welded out of two phrases that were both genuinely there).
 *
 * Closing that gap needs something that reads. This file is that something, and
 * everything about how it is packaged exists to stop its output being mistaken
 * for the numbers next door:
 *
 *  · It returns `EvalJudgeReport`, a shape `EvalReport` has no field for. The
 *    two cannot be summed by accident; merging them is a type error.
 *  · `modelJudged: true` is a required literal on the shape, so no consumer can
 *    hold one of these without the label travelling with it.
 *  · `caveat` is a required string that is printed wherever the numbers are.
 *  · It costs money and does not run unless an `AskPort` is handed in.
 *
 * ── AND THE JUDGE ITSELF IS UNVALIDATED, WHICH IS THE HONEST HEADLINE ─────
 *
 * An LLM judge is a model with an opinion about another model. The literature
 * on judge reliability is not encouraging and we have measured nothing. What we
 * DO have is a tiny labelled set: the regression set carries `blind-spot` cases
 * that are known-bad and `factual` cases that are known-good, so
 * `judgeAgreement` scores the judge against them. That is two negatives and a
 * handful of positives — enough to notice a judge that catches nothing or flags
 * everything, and nowhere near enough to publish a number from. It is reported
 * as a count, never as a rate, because a percentage over n=2 is a rhetorical
 * device rather than a statistic.
 *
 * So: use this to find candidate second-hand hallucinations for a human to
 * read. Do not put its output in a sentence beginning "our citation accuracy
 * is".
 */
import type { AskPort } from '../types.js';

import type { EvalCase } from './types.js';
import type { EvalTranscript } from './types.js';
import { citedIds } from './metrics.js';

/** The one thing a deterministic check cannot decide, named three ways. */
export type JudgedVerdict =
  /** The cited spans say what the sentence says. */
  | 'supported'
  /** Every phrase is genuinely in a cited span and the sentence recombines them
   *  into a claim no span makes. The second-hand hallucination, by name. */
  | 'conflated'
  /** The cited spans simply do not carry the claim. */
  | 'unsupported'
  /** The model returned nothing usable for this sentence. Never silently
   *  promoted to `supported` — an absent judgement is not a pass. */
  | 'unjudged';

export interface JudgedSentence {
  readonly n: number;
  readonly text: string;
  readonly verdict: JudgedVerdict;
  readonly why: string;
}

export interface EvalJudgeReport {
  /** Required and literal. The label cannot be dropped in transit. */
  readonly modelJudged: true;
  readonly caveat: string;
  readonly caseId: string;
  readonly sentences: readonly JudgedSentence[];
  readonly conflated: number;
  readonly unsupported: number;
  readonly unjudged: number;
  readonly costCents: number;
}

export const JUDGE_CAVEAT =
  'MODEL-JUDGED. Produced by a language model reading each sentence against its cited spans. ' +
  'It is not a measurement, it has not been validated beyond the handful of labelled cases in ' +
  'the regression set, and it must never be pooled with the deterministic citation metrics.';

const JUDGE_SYSTEM = [
  'You compare ONE sentence against the exact quotes it cites, and you answer',
  'only about whether those quotes carry that sentence.',
  '',
  'Return JSON: {"verdict":"supported|conflated|unsupported","why":"one short line"}',
  '',
  'supported   — the quotes state what the sentence states.',
  'conflated   — every phrase in the sentence appears somewhere in the quotes,',
  '              but the sentence joins them into a claim no quote makes. This',
  '              is the case you exist to find: a real quote, read wrongly.',
  'unsupported — the quotes do not carry the claim at all.',
  '',
  'Judge ONLY the quotes given. Do not use anything you know about the subject:',
  'a true sentence whose quotes do not carry it is still unsupported. Style,',
  'tone and paraphrase are not defects — a sentence may reword a quote freely',
  'as long as the meaning is the quote\'s.',
].join('\n');

const JUDGE_MAX_TOKENS = 300;

const parse = (text: string): { verdict?: unknown; why?: unknown } => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as { verdict?: unknown; why?: unknown }) : {};
  } catch {
    return {};
  }
};

/**
 * Judge one transcript, one sentence at a time.
 *
 * Per sentence rather than per answer on purpose: an answer-level prompt lets
 * the model average over five good sentences and one welded one, which is
 * precisely the sentence we are hunting. The cost is one small call per
 * sentence, which is why this is opt-in and why the deterministic pass runs
 * without it.
 *
 * A sentence citing nothing is not sent to the model at all. There are no
 * quotes to compare it against, `metrics.ts` already scores it as uncited, and
 * asking a model whether an unsupported sentence is supported invites it to
 * answer from what it knows — the exact failure the whole package exists to
 * prevent.
 */
export async function judgeTranscript(t: EvalTranscript, ask: AskPort): Promise<EvalJudgeReport> {
  const byId = new Map(t.spans.map((s) => [s.id, s]));
  const sentences: JudgedSentence[] = [];
  let cost = 0;

  for (const s of t.sentences) {
    const quotes = citedIds(s.text)
      .map((id) => byId.get(id))
      .filter((sp): sp is NonNullable<typeof sp> => sp !== undefined);

    if (quotes.length === 0) {
      sentences.push({ n: s.n, text: s.text, verdict: 'unsupported', why: 'the sentence cites no span' });
      continue;
    }

    const reply = await ask.ask(
      JUDGE_SYSTEM,
      `SENTENCE: ${s.text}\n\nQUOTES IT CITES:\n${quotes.map((q) => `[${q.id}] "${q.text}"`).join('\n')}`,
      JUDGE_MAX_TOKENS,
    );
    if (!reply) {
      sentences.push({ n: s.n, text: s.text, verdict: 'unjudged', why: 'the model was unavailable or the budget ceiling refused the call' });
      continue;
    }
    cost += reply.costCents;

    const { verdict, why } = parse(reply.text);
    const v: JudgedVerdict =
      verdict === 'supported' || verdict === 'conflated' || verdict === 'unsupported' ? verdict : 'unjudged';
    sentences.push({
      n: s.n,
      text: s.text,
      verdict: v,
      why: typeof why === 'string' ? why : 'the reply carried no reason',
    });
  }

  return {
    modelJudged: true,
    caveat: JUDGE_CAVEAT,
    caseId: t.caseId,
    sentences,
    conflated: sentences.filter((x) => x.verdict === 'conflated').length,
    unsupported: sentences.filter((x) => x.verdict === 'unsupported').length,
    unjudged: sentences.filter((x) => x.verdict === 'unjudged').length,
    costCents: cost,
  };
}

/** How the judge did against the only labels we have. Counts, never rates —
 *  see the header for why a percentage over two negatives would be dishonest. */
export interface EvalJudgeAgreement {
  readonly modelJudged: true;
  readonly caveat: string;
  /** `blind-spot` cases where the judge said `conflated` or `unsupported` —
   *  the failures the deterministic metrics score clean. */
  readonly blindSpotsCaught: readonly string[];
  readonly blindSpotsMissed: readonly string[];
  /** `factual` cases where the judge flagged a sentence. Every one of these is
   *  either a real defect we had not noticed or a false alarm, and only a human
   *  reading the sentence can say which. Listed, never netted off. */
  readonly factualFlagged: readonly string[];
  readonly costCents: number;
}

export function judgeAgreement(
  reports: readonly EvalJudgeReport[],
  cases: readonly EvalCase[],
): EvalJudgeAgreement {
  const shapeOf = new Map(cases.map((c) => [c.id, c.shape]));
  const caught: string[] = [];
  const missed: string[] = [];
  const flagged: string[] = [];

  for (const r of reports) {
    const bad = r.conflated + r.unsupported > 0;
    const shape = shapeOf.get(r.caseId);
    if (shape === 'blind-spot') (bad ? caught : missed).push(r.caseId);
    else if (shape === 'factual' && bad) flagged.push(r.caseId);
  }

  return {
    modelJudged: true,
    caveat: JUDGE_CAVEAT,
    blindSpotsCaught: caught,
    blindSpotsMissed: missed,
    factualFlagged: flagged,
    costCents: reports.reduce((a, r) => a + r.costCents, 0),
  };
}
