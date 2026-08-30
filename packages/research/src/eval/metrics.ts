/**
 * ALCE-STYLE CITATION METRICS, WITH THE ENTAILMENT MODEL TAKEN OUT.
 *
 * ALCE (Gao et al., arXiv:2305.14627) is the field standard for measuring
 * whether an attributed answer's citations hold up. Two numbers per answer:
 *
 *  · **Citation recall** — does every statement carry at least one citation,
 *    and do that statement's citations JOINTLY support it? One statement, one
 *    binary score, averaged.
 *  · **Citation precision** — is each individual citation load-bearing? A
 *    citation is counted correct only when the joint set supports the statement
 *    AND removing that one citation breaks the support. A citation that could
 *    be deleted with no loss is padding, and padding is how an answer looks
 *    better attributed than it is.
 *
 * ── WHAT WE SUBSTITUTE FOR THEIR NLI MODEL, AND WHAT IT COSTS ─────────────
 *
 * ALCE's support step is an NLI model (AutoAIS / T5-11B) — a forward pass per
 * statement, per ablation. We do not run one, and the reason is the same one
 * §2 of the answer-engine plan gives for the pipeline itself: our spans are
 * verbatim substrings of documents we fetched, so a large part of "does this
 * span support this sentence" collapses into string work.
 *
 * The substitution is NOT free and this file will not pretend it is. An NLI
 * model judges MEANING. We judge **units**: the checkable pieces of a sentence
 * whose absence from a cited span is unambiguously a defect. Two kinds, each
 * tied to a failure this system has actually had:
 *
 *  1. **Figures.** `verify.ts` names this the place a research answer does its
 *     real damage — "the GTA market is worth $2.1B" is actionable,
 *     unfalsifiable at a glance and frequently arithmetic the model did in its
 *     head. `claimNumbers` is IMPORTED from `verify.ts`, never reimplemented,
 *     so the eval and the shipped gate cannot drift about what counts as a
 *     number — including the deliberate exemption for bare integers under 10.
 *  2. **Entities.** `grounded.ts` names the other one: "a current,
 *     correctly-cited fact about the WRONG company", which is undetectable
 *     downstream and is why entity scoping there is literal rather than
 *     embedded. A capitalised name in a sentence whose cited spans never
 *     mention it is that failure, visible as a string.
 *
 * ── WHAT THIS CANNOT SEE. READ THIS BEFORE QUOTING ANY NUMBER BELOW ──────
 *
 * A deterministic unit check cannot catch a sentence that MISREADS a real
 * quote. Every figure can be present, every name can be present, every span can
 * be genuine, and the sentence can still say something the span does not.
 *
 * That is not hypothetical. It is the one live failure we have on record —
 * TMOS-ANSWER-ENGINE §10: *"Its market positioning is described as
 * safe-but-narrow and broad and safe."* Our document says Jiffy is
 * safe-but-narrow, and that *broad and safe* is the unoccupied position Taskly
 * targets. The model welded them together. Both phrases are in the cited span,
 * so every check in this file scores that sentence a clean 1.0 on recall and
 * 1.0 on precision, and it is wrong.
 *
 * The regression set therefore carries that sentence as a case, marked
 * `blind-spot`, and `harness.ts` reports those cases in their own block instead
 * of scoring them. **The blind-spot count is the honest companion to the
 * recall figure and must never be printed without it.** Closing the gap needs a
 * judge that reads meaning; that lives in `judge.ts`, its output is labelled
 * model-judged, and it is not admitted into any number here.
 */
import { claimNumbers, normalise } from '../verify.js';

import type { EvalSentence, EvalSpan, EvalTranscript } from './types.js';

/* ── citation markers ─────────────────────────────────────────────────────── */

/**
 * `[3]`, and tolerantly `[1, 2]`.
 *
 * Deliberately a SECOND copy of `stream.ts`'s `MARKER` rather than an import:
 * that one is private, and widening a shipped module's surface so a measuring
 * tool can reach in is how a measurement starts changing the thing it measures.
 * The drift risk is real and bounded — a marker form the pipeline emits and
 * this regex misses shows up immediately as an uncited statement in the report,
 * which is a loud failure rather than a quiet one.
 */
const MARKER = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;

/** Marker digits are not claims. Stripping them before unit extraction is not
 *  cosmetic: without it `[12]` demands that "12" appear in a cited span, and
 *  every well-cited statement past span 9 would score zero for citing itself. */
const withoutMarkers = (text: string): string => text.replace(MARKER, ' ');

/** The span ids a statement cites, deduplicated and in order of appearance. */
export function citedIds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MARKER)) {
    for (const part of (m[1] ?? '').split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/* ── units: the deterministic stand-in for entailment ─────────────────────── */

export type EvalUnitKind = 'figure' | 'entity';

/** One checkable piece of a statement. `text` is what must be findable in a
 *  cited span; `kind` is which argument above justifies checking it. */
export interface EvalUnit {
  readonly kind: EvalUnitKind;
  readonly text: string;
}

/**
 * Capitalised words that are not names.
 *
 * A stoplist alone is not enough, and the first draft of this file proved it:
 * "Hourly rates run $40-$70 [1]." made "Hourly" an entity and then failed a
 * correctly-cited sentence because the page said "per hour". Sentence-initial
 * capitalisation is ambiguous — "Prices rose" and "Jiffy rose" are identical to
 * a tokeniser — so `supportUnits` SKIPS the first token for the capitalised
 * rule entirely, and this list handles the rest.
 *
 * That is a deliberate loss of coverage in the conservative direction: an
 * entity in first position is never checked, so the metric under-reports and
 * never false-flags. A metric that cries wolf is a metric that gets switched
 * off, and every unit here has to survive being shown to someone whose sentence
 * it just failed.
 */
const NOT_A_NAME = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'They', 'Their', 'Them',
  'It', 'Its', 'We', 'Our', 'Us', 'You', 'Your', 'His', 'Her', 'Both',
  'And', 'But', 'For', 'Nor', 'Yet', 'So', 'Or', 'If', 'When', 'While',
  'However', 'Because', 'Although', 'Neither', 'Either', 'Every', 'Each',
  'One', 'Two', 'Three', 'Some', 'Most', 'Many', 'Several', 'Other', 'Another',
  'No', 'Not', 'None', 'Nothing', 'Only', 'Also', 'Still', 'Then', 'Than',
  'What', 'Which', 'Where', 'Who', 'How', 'Why', 'Here', 'Now', 'Across',
  'After', 'Before', 'Between', 'During', 'Since', 'Under', 'Over', 'With',
  'Without', 'About', 'Against', 'Among', 'Within', 'Per', 'By', 'At', 'On',
  'In', 'Of', 'To', 'From', 'As', 'Is', 'Are', 'Was', 'Were', 'Be', 'Been',
]);

/** Trailing punctuation a tokeniser must not carry into a name. Quotes are
 *  stripped from both ends because a quoted phrase inside prose is still prose. */
const trimToken = (t: string): string => t.replace(/^[^\p{L}\p{N}$]+/u, '').replace(/[^\p{L}\p{N}%]+$/u, '');

/**
 * The checkable units of one statement.
 *
 * Kept deliberately narrow. Every unit kind here is one whose absence from a
 * cited span is a DEFECT rather than a stylistic choice — a metric that flags
 * paraphrase would be flagging the pipeline for working as designed (phase B
 * writes prose about its spans; it does not transcribe them), and a metric that
 * cries wolf is a metric that gets switched off.
 *
 *  · **figure** — via `claimNumbers`, the shipped rule, imported not copied.
 *  · **entity** — a capitalised token of 3+ characters that is NOT the first
 *    token of the sentence and not a common sentence-starter, or a lowercase
 *    hyphenated compound of 8+ characters ("safe-but-narrow"). The second form
 *    is there because a hyphenated coinage behaves like a quoted term: it is
 *    the document's phrasing, so a sentence using it is claiming the document
 *    said it. The first-token exemption is explained on `NOT_A_NAME`; it costs
 *    real coverage and buys freedom from false flags, and that trade is the
 *    right way round for a number this system intends to quote publicly.
 */
/**
 * One figure, in a form that compares.
 *
 * `claimNumbers`' pattern ends `\.?\d*`, so a figure at the end of a sentence
 * absorbs the full stop: "$99." yields `99.` and "$99 in Toronto" yields `99`.
 * The same string is therefore two different figures depending on where it sat,
 * which would flag a sentence whose span quotes the identical price. Stripping
 * a trailing dot with no digits behind it — and ONLY that — makes the two
 * comparable without touching "99.5".
 *
 * Deliberately applied on both sides and nowhere else. `claimNumbers` itself is
 * left alone: it is the shipped rule, `checkSentence` runs it, and quietly
 * changing what the gate counts as a number from inside a measuring tool is how
 * a measurement starts moving the thing it measures.
 */
const figureKey = (n: string): string => n.replace(/\.$/, '');

export function supportUnits(statement: string): EvalUnit[] {
  const bare = withoutMarkers(statement);
  const units: EvalUnit[] = [];
  const seen = new Set<string>();

  const add = (kind: EvalUnitKind, text: string): void => {
    const key = `${kind}:${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    units.push({ kind, text });
  };

  for (const n of claimNumbers(bare)) add('figure', figureKey(n));

  const words = bare.split(/\s+/);
  for (let i = 0; i < words.length; i += 1) {
    const token = trimToken(words[i] ?? '');
    if (token.length < 3) continue;
    // `i > 0`: see `NOT_A_NAME`. The first word of a sentence is capitalised
    // whatever it is, and guessing costs more than the coverage is worth.
    if (i > 0 && /^[A-Z]/.test(token) && !NOT_A_NAME.has(token) && !/^\d/.test(token)) {
      add('entity', token);
      continue;
    }
    if (token.length >= 8 && /^[a-z]+(?:-[a-z]+)+$/.test(token)) add('entity', token);
  }

  return units;
}

/**
 * Which of a statement's units the given spans actually carry.
 *
 * Figures are matched with `claimNumbers` on the span side too — stricter than
 * the verifier's private `numbersIn`, and stricter in the correct direction: a
 * bare `5` on a page does not support a `$5` in a sentence.
 *
 * Entities are matched case-INSENSITIVELY, with one trailing `s` optionally
 * dropped. Case is preserved in `verify.ts` for a reason that does not apply
 * here: there, a quote differing in case is a different quote and lowering it
 * would let a headline masquerade as body text. Here we are asking whether the
 * sentence is about a thing the span mentions, and "JIFFY" in a heading is the
 * same company as "Jiffy" in a paragraph. Refusing that match would flag honest
 * sentences, which is the failure mode that gets a metric ignored.
 */
export function unitsMetBy(units: readonly EvalUnit[], spans: readonly EvalSpan[]): EvalUnit[] {
  const joined = spans.map((s) => s.text).join(' ');
  const figures = new Set(claimNumbers(joined).map(figureKey));
  const haystack = normalise(joined).toLowerCase();

  return units.filter((u) => {
    if (u.kind === 'figure') return figures.has(u.text);
    const t = u.text.toLowerCase();
    if (haystack.includes(t)) return true;
    return t.length > 4 && t.endsWith('s') && haystack.includes(t.slice(0, -1));
  });
}

/* ── the two ALCE numbers ─────────────────────────────────────────────────── */

/** One statement, scored. Kept per-statement so the report can point at the
 *  sentence that cost a run its recall rather than only at the average. */
export interface EvalStatementScore {
  readonly n: number;
  readonly text: string;
  /** Span ids the statement cites, after `MarkerGate` — so an id here always
   *  resolves unless the transcript itself is inconsistent. */
  readonly cited: readonly number[];
  /** Ids cited that no span in the transcript carries. Normally empty: the
   *  pipeline deletes fabricated markers before a reader sees them, so a
   *  non-zero count means the transcript was assembled wrong, not that the
   *  model fabricated — and it is surfaced rather than absorbed. */
  readonly unresolved: readonly number[];
  readonly units: readonly EvalUnit[];
  readonly unitsMet: readonly EvalUnit[];
  /** ALCE recall for this statement: cited at all, and jointly supported. */
  readonly recall: boolean;
  /** Nothing deterministic to check — no figure, no name. Counted, never
   *  scored: giving a vacuous statement a 1.0 is how a metric flatters itself. */
  readonly vacuous: boolean;
  readonly citations: number;
  readonly loadBearing: number;
  /** The pipeline's own per-sentence verdict, carried through for the
   *  agreement count. Not an input to any number here. */
  readonly pipelineVerdict: 'confirmed' | 'flagged';
}

export interface EvalCitationMetrics {
  readonly statements: number;
  readonly statementsWithCitation: number;
  readonly citations: number;
  /**
   * ALCE citation recall: the fraction of statements that carry a citation AND
   * whose citations jointly carry every unit of the statement. A statement with
   * no units passes the second leg vacuously, which is why `strictRecall` sits
   * beside it and why neither should be quoted alone.
   */
  readonly recall: number;
  /** Recall over unit-bearing statements only — the number with teeth. */
  readonly strictRecall: number;
  /**
   * ALCE citation precision over citations attached to unit-bearing
   * statements. A citation counts as correct when the statement's joint set
   * supports it and dropping this one loses a unit. Citations on vacuous
   * statements are excluded from BOTH sides of the ratio: with nothing to
   * check, an ablation cannot distinguish a load-bearing citation from a
   * decorative one, and scoring them 0 would report our ignorance as the
   * model's padding.
   */
  readonly precision: number;
  readonly precisionDenominator: number;
  readonly vacuousStatements: number;
  readonly unitsRequired: number;
  readonly unitsMet: number;
  /** Statements where this metric and the shipped per-sentence check reached
   *  the same conclusion, and where they did not. Disagreement in either
   *  direction is interesting: it is either a gap in the gate or a gap here. */
  readonly agreesWithPipeline: number;
  readonly disagreesWithPipeline: number;
  readonly perStatement: readonly EvalStatementScore[];
}

const ratio = (num: number, den: number): number => (den === 0 ? 1 : num / den);

/** Score one statement. Exported for the tests, which build statements by hand
 *  precisely so the scorer is checked against cases whose answer is known. */
export function scoreStatement(
  sentence: EvalSentence,
  spans: readonly EvalSpan[],
): EvalStatementScore {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const ids = citedIds(sentence.text);
  const cited = ids.filter((id) => byId.has(id));
  const unresolved = ids.filter((id) => !byId.has(id));
  const citedSpans = cited.map((id) => byId.get(id)).filter((s): s is EvalSpan => s !== undefined);

  const units = supportUnits(sentence.text);
  const met = unitsMetBy(units, citedSpans);
  const vacuous = units.length === 0;
  const recall = cited.length > 0 && met.length === units.length;

  // ALCE's precision leg, with the ablation done over units instead of over an
  // NLI verdict. A citation is load-bearing when the joint set supports the
  // statement and removing THIS citation loses at least one unit. The
  // `recall &&` guard is ALCE's own: when the joint set does not support the
  // statement, no individual citation in it is credited.
  let loadBearing = 0;
  if (recall && !vacuous) {
    for (const id of cited) {
      const without = citedSpans.filter((s) => s.id !== id);
      if (unitsMetBy(units, without).length < met.length) loadBearing += 1;
    }
  }

  return {
    n: sentence.n,
    text: sentence.text,
    cited,
    unresolved,
    units,
    unitsMet: met,
    recall,
    vacuous,
    citations: cited.length,
    loadBearing,
    pipelineVerdict: sentence.verdict,
  };
}

/**
 * Score one transcript.
 *
 * An empty answer scores nothing rather than scoring 1.0. A run that refused to
 * answer has no citations to be right or wrong about, and folding a perfect
 * score for it into an average would mean the surest way to raise our citation
 * recall is to answer fewer questions. Whether the refusal was CORRECT is a
 * different measurement and lives in the abstention counts in `harness.ts`.
 */
export function scoreCitations(t: EvalTranscript): EvalCitationMetrics {
  const perStatement = t.sentences.map((s) => scoreStatement(s, t.spans));

  const unitBearing = perStatement.filter((s) => !s.vacuous);
  const citations = perStatement.reduce((a, s) => a + s.citations, 0);
  const precisionDenominator = unitBearing.reduce((a, s) => a + s.citations, 0);
  const loadBearing = unitBearing.reduce((a, s) => a + s.loadBearing, 0);

  // The pipeline says `confirmed`; this metric says `recall`. They are not the
  // same statement — the gate also runs the honesty and causal lints, which
  // have nothing to do with citation support — so agreement is a signal and
  // never a target.
  let agree = 0;
  for (const s of perStatement) {
    if ((s.pipelineVerdict === 'confirmed') === s.recall) agree += 1;
  }

  return {
    statements: perStatement.length,
    statementsWithCitation: perStatement.filter((s) => s.citations > 0).length,
    citations,
    recall: ratio(perStatement.filter((s) => s.recall).length, perStatement.length),
    strictRecall: ratio(unitBearing.filter((s) => s.recall).length, unitBearing.length),
    precision: ratio(loadBearing, precisionDenominator),
    precisionDenominator,
    vacuousStatements: perStatement.length - unitBearing.length,
    unitsRequired: perStatement.reduce((a, s) => a + s.units.length, 0),
    unitsMet: perStatement.reduce((a, s) => a + s.unitsMet.length, 0),
    agreesWithPipeline: agree,
    disagreesWithPipeline: perStatement.length - agree,
    perStatement,
  };
}

/** Combine per-transcript metrics into one set-level figure.
 *
 *  Pooled over STATEMENTS, not averaged over transcripts. A three-sentence
 *  answer and a nine-sentence answer are not equal evidence, and averaging
 *  per-answer rates would let one short answer with a single lucky sentence
 *  outweigh a long one. ALCE pools the same way. */
export function poolCitations(all: readonly EvalCitationMetrics[]): EvalCitationMetrics {
  const perStatement = all.flatMap((m) => m.perStatement);
  const unitBearing = perStatement.filter((s) => !s.vacuous);
  const precisionDenominator = unitBearing.reduce((a, s) => a + s.citations, 0);
  const loadBearing = unitBearing.reduce((a, s) => a + s.loadBearing, 0);

  return {
    statements: perStatement.length,
    statementsWithCitation: perStatement.filter((s) => s.citations > 0).length,
    citations: perStatement.reduce((a, s) => a + s.citations, 0),
    recall: ratio(perStatement.filter((s) => s.recall).length, perStatement.length),
    strictRecall: ratio(unitBearing.filter((s) => s.recall).length, unitBearing.length),
    precision: ratio(loadBearing, precisionDenominator),
    precisionDenominator,
    vacuousStatements: perStatement.length - unitBearing.length,
    unitsRequired: perStatement.reduce((a, s) => a + s.units.length, 0),
    unitsMet: perStatement.reduce((a, s) => a + s.unitsMet.length, 0),
    agreesWithPipeline: all.reduce((a, m) => a + m.agreesWithPipeline, 0),
    disagreesWithPipeline: all.reduce((a, m) => a + m.disagreesWithPipeline, 0),
    perStatement,
  };
}
