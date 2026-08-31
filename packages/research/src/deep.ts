/**
 * DEEP RESEARCH — one question, decomposed, researched step by step, then
 * answered over everything the steps proved.
 *
 * `streamAnswer` is one pass: plan queries, read eight pages, attribute, write.
 * That is the right shape for "what does Jiffy charge" and the wrong shape for
 * "should we launch snow removal in October", which is four questions wearing
 * one sentence. A single pass answers the loudest of the four and the reader
 * cannot see which three it dropped.
 *
 * So this file runs the orchestrator-worker loop the published systems use
 * (Anthropic's multi-agent research write-up; Perplexity's planner-executor):
 * decompose, execute each sub-question against its OWN boundary, reflect on
 * what is still open, stop, and only then synthesise. The plan is published
 * before the first search because a reader must be able to abandon a run that
 * is going wrong at minute one rather than discovering it at minute four.
 *
 * ── FOUR THINGS THIS FILE EXISTS TO GET RIGHT ──────────────────────────────
 *
 * **1 · Ambiguity is decided BEFORE retrieval, or it is not decided at all.**
 * "Knowing but Not Showing" (arXiv:2605.25284) reports two findings that
 * together fix the ordering: a model asked directly whether a request is
 * ambiguous judges it correctly, and the same model in normal QA mode guesses
 * instead — and handing it retrieved context makes it LESS likely to ask,
 * because context reads as confidence. A clarify gate placed after the first
 * search is therefore a gate that never fires. It is the first thing here, it
 * runs before a search port is so much as touched, and a caller who already
 * has the reader's answers skips it entirely.
 *
 * **2 · Span ids are global, unique and contiguous across every step.**
 * `attribute()` numbers from 1 on every call, and its `docIndex` is 1-based
 * into the documents IT was handed. Merge two steps naively and step 2's `[1]`
 * overwrites step 1's: every marker in the final answer then resolves to the
 * wrong quote, wearing a confirmed badge, which is exactly the failure
 * `attribute.ts` closed for a single pass. `absorbSpans` renumbers on the way
 * in and re-homes `docIndex` onto the run-global source list by URL.
 *
 * **3 · A hard engineering cap sits UNDER the model's own stopping judgement.**
 * The reflection may say "keep going"; the caps do not have to agree. Steps,
 * spend, wall-clock and universe size are all checked at the top of every
 * iteration, before the model gets a vote. And the reason a run ended is
 * carried on `ReflectEvent.stop`, because "the plan is answered" and "the
 * budget ended it" are different outcomes and an answer that cannot tell you
 * which is a worse answer.
 *
 * **4 · Drift.** Each step is planned, searched and attributed against its own
 * sub-question — never the raw question re-injected, which is what collapses a
 * five-step plan into five copies of step one. The plan is the run's external
 * memory: the reflection reads the plan and the proven quotes, never the raw
 * document text, so what carries between steps is evidence and structure.
 *
 * ── AND ONE THING IT DELIBERATELY DOES NOT DO ──────────────────────────────
 *
 * There is no second generate-and-check loop in here. `writeFromSpans` is the
 * same function the web path and grounded mode call, for the reason
 * `stream.ts` records: `confirmed` is rendered by a client that cannot tell
 * which pipeline wrote the sentence under it, and a third copy of that loop
 * would drift until the badge quietly carried a third meaning. Every guarantee
 * — markers resolve or are deleted, every figure is in a span its own sentence
 * cites, the honesty gate, the causal lint — holds here because it is literally
 * the same code, not the equivalent code.
 */
import { checkCausalLanguage, checkHonesty } from '@tmos/guardrails';

import type { AttributeLimits, CitableSpan, DroppedSpan } from './attribute.js';
import { attribute } from './attribute.js';
import type {
  ClarifyEvent,
  DeltaEvent,
  PlanEvent,
  PlanStep,
  ReflectEvent,
  SentenceEvent,
  SourceEvent,
  SpanEvent,
  StatusEvent,
  StepEvent,
} from './events.js';
import { planSearches } from './follow-up.js';
import type { ResearchLimits } from './pipeline.js';
import { dedupeHits } from './pipeline.js';
import { writeFromSpans } from './stream.js';
import type {
  AskPort,
  AskStreamPort,
  ReadDoc,
  ReadPort,
  SearchHit,
  SearchPort,
} from './types.js';
import { normalise } from './verify.js';

/* ── budget ───────────────────────────────────────────────────────────────── */

/**
 * The caps. Every one of them can end a run over the model's objection.
 *
 * No vendor ships "trust the LLM" for cost control, and the reason is not that
 * models are bad at stopping — it is that a stopping bug is unbounded. A loop
 * that decides to continue is a loop that decides to spend, and the only cost
 * ceiling worth having is one the thing being capped does not participate in.
 */
export interface DeepBudget {
  /** Steps actually executed. The plan may be longer; the remainder is emitted
   *  as `skipped` rather than silently dropped, so the reader sees the cost of
   *  the cap and not just its effect. */
  readonly maxSteps: number;
  /**
   * Total model spend for the run, in cents, across the clarify gate, every
   * step's planner and attribution pass, every reflection and the final write.
   * Checked BEFORE a step starts, never in the middle: a step half-executed is
   * a step whose documents were fetched and whose spans were never proven, so
   * the money is spent and nothing is bought.
   */
  readonly maxCostCents: number;
  /** Wall-clock, in milliseconds. The one cap that catches a slow run rather
   *  than an expensive one — sixteen fetches behind a 2s-per-host floor cost
   *  almost nothing and can still take four minutes. */
  readonly maxMs: number;
  /**
   * The accumulated universe. This is a cost cap wearing a different hat: the
   * span list is pasted into phase B's prompt in full, so five steps at
   * `DEFAULT_ATTRIBUTE_LIMITS.maxSpans` would put 120 quotes into the single
   * most expensive call of the run. It is also a QUALITY cap — a universe far
   * larger than the answer buries the spans that matter among the ones that do
   * not, and phase B cites what it can see.
   */
  readonly maxSpans: number;
}

export const DEFAULT_DEEP_BUDGET: DeepBudget = {
  maxSteps: 5,
  // ~60× a normal fast answer (0.17¢ measured). A deep run is meant to be the
  // expensive one; this is the line past which it is a runaway instead.
  maxCostCents: 10,
  maxMs: 240_000,
  maxSpans: 40,
};

/**
 * Per-step retrieval, deliberately narrower than `DEFAULT_LIMITS`.
 *
 * Breadth in a deep run comes from having five sub-questions, not from reading
 * forty pages about one of them. Keeping the web path's 4 queries × 8 pages
 * per step would fetch up to 40 documents for one question — slower, dearer,
 * and no broader, because the fifth page of a query is usually the fourth page
 * restated. Narrow and repeated beats wide and single.
 */
export const DEFAULT_DEEP_LIMITS: ResearchLimits = {
  maxQueries: 2,
  maxPages: 4,
  maxCharsPerPage: 6_000,
};

/** A plan longer than this is not a plan, it is a list. Structural, and
 *  distinct from `DeepBudget.maxSteps`: the budget decides how many steps RUN,
 *  this decides how many a model may propose before we stop reading. */
const MAX_PLAN_STEPS = 8;

/** Three at most, because a reader who is asked four questions before any work
 *  starts closes the tab. Each must be answerable in a phrase. */
const MAX_CLARIFY_QUESTIONS = 3;

const PLAN_MAX_TOKENS = 700;
const CLARIFY_MAX_TOKENS = 400;
const REFLECT_MAX_TOKENS = 500;

/* ── the prompts ──────────────────────────────────────────────────────────── */

/**
 * The clarify gate.
 *
 * Asked DIRECTLY whether the request is ambiguous, which is the mode the
 * literature says models judge well in — not asked to answer while remaining
 * alert to ambiguity, which is the mode they guess in. It is also asked before
 * any document exists, so there is no retrieved context to read as confidence.
 *
 * The bar is deliberately high. A gate that fires on every second question is
 * a gate users learn to click through, and the cost it is protecting against
 * is minutes and cents — real, but not so large that asking is free.
 *
 * Nothing here crosses the honesty boundary: a banned phrase in a system prompt
 * generates itself into the output, and the questions this produces are shown
 * to a reader verbatim.
 */
const CLARIFY_SYSTEM = [
  'You decide ONE thing: whether a research request is specific enough to spend',
  'several minutes and real money researching, or whether answering it would',
  'mean guessing which question was meant.',
  '',
  'Return JSON. Specific enough: {"ok":true}',
  'Too broad: {"questions":["...","..."],"because":"..."}',
  '',
  'ASK ONLY WHEN A REASONABLE RESEARCHER WOULD HAVE TO GUESS',
  '- Two or more readings would send the research somewhere different.',
  '- A named thing is ambiguous (a company with a common name, a city with no',
  '  country, "the market" with no market).',
  '- The request has no subject at all, only a topic area.',
  '',
  'DO NOT ASK when the question is merely broad but researchable. "What do',
  'competitors charge in Toronto?" is answerable. Breadth is not ambiguity.',
  '',
  'RULES FOR THE QUESTIONS THEMSELVES',
  '- At most three. One sentence each, plain, ending in "?".',
  '- Each must be answerable in a few words by the person who typed the request.',
  '- "because" is one sentence saying what is unclear, in the reader\'s terms.',
  '- Never ask what caused, drove or led to what.',
  '- Never ask whether Taskly screens, checks, covers or promises anything.',
].join('\n');

/**
 * Decomposition.
 *
 * Sub-questions, not search queries — the difference matters. A query is what
 * you type; a sub-question is a thing that can be answered, and it is the unit
 * the step boundary is drawn around. Each step then runs the ordinary planner
 * over its own sub-question to get queries, so this pass never has to be good
 * at two jobs at once.
 *
 * `why` is required because a step nobody can justify is a step to cut, and
 * making the model write the justification is the cheapest way to make it
 * notice it does not have one.
 */
const PLAN_SYSTEM = [
  'You break one research question into a small number of sub-questions that',
  'can each be researched separately on the open web.',
  'Return JSON: {"steps":[{"question":"...","why":"..."}]}',
  '',
  'RULES',
  '- Each sub-question must stand on its own. Someone who has not seen the',
  '  original question must be able to research it.',
  '- Cover DIFFERENT ground. Two sub-questions that would retrieve the same',
  '  pages are one sub-question and a wasted step.',
  '- Order them so an early answer is useful even if the run stops early.',
  '- Prefer sub-questions a primary source could settle: a company page, a',
  '  government statistic, a filing, a job board.',
  '- "why" is one short sentence: what this step adds that the others do not.',
  '- Never ask what caused, drove or led to what. Nothing here is an experiment.',
  '- Never ask whether Taskly screens, checks, covers or promises anything.',
].join('\n');

/**
 * The reflection between steps.
 *
 * It sees the plan and the quotes proven so far — never the raw document text.
 * That is the progressive-narrowing mitigation from the multi-agent literature
 * made concrete: what crosses a step boundary is structure and evidence, and
 * feeding page text forward would make step five's context step one's corpus,
 * which is both the expensive way and the way a run drifts back onto its
 * opening subject.
 *
 * `done` is the model's stopping judgement and it is genuinely useful — it is
 * the only thing here that can tell "the plan is answered" from "there are
 * steps left". It is also not trusted with the budget: the caps are checked
 * before this reply is ever read.
 */
const REFLECT_SYSTEM = [
  'You are tracking a multi-step research run against its own plan. You do not',
  'answer the question and you do not summarise the evidence.',
  'Return JSON: {"stillOpen":["..."],"note":"...","done":false,',
  '"revise":[{"n":3,"question":"...","why":"..."}],"revisedBecause":"..."}',
  '',
  'RULES',
  '- "stillOpen" names the parts of the plan the quotes so far do NOT settle.',
  '  Copy the sub-question wording. An empty list means the plan is answered.',
  '- "note" is one plain sentence for someone watching the run decide whether',
  '  to let it keep spending. Say what was found and what is missing.',
  '- "done" is true only when the remaining steps would add nothing.',
  '- "revise" is optional and may only change steps that have NOT run yet.',
  '  Never renumber a step and never touch one already done. Use it when the',
  '  evidence showed a planned step is pointless or points somewhere better.',
  '- "revisedBecause" is required whenever "revise" is present: one sentence.',
  '- Never write that something caused, drove, led to or boosted something else.',
  '- Never state that Taskly screens, checks, covers or promises anything.',
].join('\n');

/* ── shared parsing ───────────────────────────────────────────────────────── */

const parseJson = (text: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The gate every piece of generated text in this file passes before a reader
 * sees it.
 *
 * A plan step, a clarifying question and a progress note are all model output
 * rendered on the page. `checkSentence` never sees them — it runs on the
 * ANSWER — so without this they would be the one place in the pipeline where
 * generated prose reaches a reader ungated. The honesty boundary is legal
 * rather than stylistic and does not care which part of the UI a claim appears
 * in; the causal lint is here for the same reason `bindRelated` runs it on a
 * suggestion. Failing text is dropped or replaced, never repaired: rewording a
 * model's sentence and then presenting it as the model's is worse than losing
 * it.
 */
const readerSafe = (text: string): boolean =>
  checkHonesty(text, 'internal').ok && checkCausalLanguage(text, 0).ok;

/* ── phase 0: the ambiguity gate ──────────────────────────────────────────── */

/**
 * Turn the gate's reply into a `ClarifyEvent`, or into nothing.
 *
 * Returns `null` — meaning "proceed" — for every unusable reply, and that
 * direction is deliberate. The gate exists to save minutes; failing it closed
 * would spend a broken JSON parse as a refusal to research at all, which is a
 * far worse outcome than one run that should have asked and did not. A gate
 * that can deadlock the product is a gate someone removes.
 */
export function bindClarify(raw: unknown): ClarifyEvent | null {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (obj['ok'] === true) return null;

  const questions: string[] = [];
  for (const q of strings(obj['questions'])) {
    const text = normalise(q);
    // A statement in a clarifying-questions box is an instruction wearing a
    // question's clothes, and the reader has no way to answer it.
    if (text.length < 8 || text.length > 160 || !text.endsWith('?')) continue;
    if (!readerSafe(text)) continue;
    if (questions.includes(text)) continue;
    questions.push(text);
    if (questions.length >= MAX_CLARIFY_QUESTIONS) break;
  }
  if (questions.length === 0) return null;

  const rawBecause = obj['because'];
  const because =
    typeof rawBecause === 'string' && normalise(rawBecause) !== '' && readerSafe(rawBecause)
      ? clip(normalise(rawBecause), 240)
      : 'The request could be read more than one way, and the readings would send the research somewhere different.';

  return { questions, because };
}

/* ── phase 1: the plan ────────────────────────────────────────────────────── */

/**
 * Number the steps. `n` is assigned HERE and never by the model — the wire
 * contract says `n` is stable for the run and a replan revises `question`,
 * never `n`, which is only enforceable if the numbering was ours to begin with.
 */
export function bindPlan(raw: unknown): PlanStep[] {
  const steps: PlanStep[] = [];
  if (!Array.isArray(raw)) return steps;

  const seen = new Set<string>();
  for (const item of raw as unknown[]) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const q = entry['question'];
    if (typeof q !== 'string') continue;
    const question = normalise(q);
    if (question.length < 8 || question.length > 200 || !readerSafe(question)) continue;
    const key = question.toLowerCase();
    // Two identical sub-questions retrieve one set of pages and cost two steps.
    if (seen.has(key)) continue;
    seen.add(key);

    const rawWhy = entry['why'];
    const why =
      typeof rawWhy === 'string' && normalise(rawWhy) !== '' && readerSafe(rawWhy)
        ? clip(normalise(rawWhy), 200)
        : '';
    steps.push({ n: steps.length + 1, question, why });
    if (steps.length >= MAX_PLAN_STEPS) break;
  }
  return steps;
}

/**
 * Apply a revision without touching the past.
 *
 * A step that has already run has been reported to the reader with a `found`
 * count against its number. Renumbering it, or rewording it after the fact,
 * makes that report describe work nobody did — the run would be editing its own
 * history to match its current opinion. So `doneThrough` is a hard floor:
 * revisions land on future steps or on the end of the plan, and nothing else.
 */
export function revisePlan(
  plan: readonly PlanStep[],
  raw: unknown,
  doneThrough: number,
): PlanStep[] {
  if (!Array.isArray(raw)) return [...plan];
  const out = [...plan];

  for (const item of raw as unknown[]) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const q = entry['question'];
    if (typeof q !== 'string') continue;
    const question = normalise(q);
    if (question.length < 8 || question.length > 200 || !readerSafe(question)) continue;

    const rawWhy = entry['why'];
    const why =
      typeof rawWhy === 'string' && normalise(rawWhy) !== '' && readerSafe(rawWhy)
        ? clip(normalise(rawWhy), 200)
        : '';

    const n = Number(entry['n']);
    const at = Number.isInteger(n) ? out.findIndex((s) => s.n === n) : -1;
    const target = at >= 0 ? out[at] : undefined;
    if (target) {
      // Only a step still in the future may be rewritten.
      if (target.n <= doneThrough) continue;
      out[at] = { n: target.n, question, why };
      continue;
    }
    if (out.length >= MAX_PLAN_STEPS) continue;
    out.push({ n: (out[out.length - 1]?.n ?? 0) + 1, question, why });
  }
  return out;
}

/* ── the accumulating universe ────────────────────────────────────────────── */

export interface AbsorbedSpans {
  /** The whole universe after the merge — ids 1..n, contiguous, in the order
   *  they were proven. */
  readonly spans: CitableSpan[];
  /** How many of `incoming` were NEW. This is `StepEvent.found`, and it is
   *  deliberately not a document count: a step that read nine pages and proved
   *  nothing is the single most useful thing a watching reader can be told. */
  readonly added: number;
  readonly dropped: DroppedSpan[];
}

/**
 * MERGE ONE STEP'S SPANS INTO THE RUN'S UNIVERSE. The correctness of every
 * `[N]` in the final answer rests on this function.
 *
 * `attribute()` hands back spans numbered from 1 with `docIndex` pointing into
 * the documents that one call was given. Both facts are correct in isolation
 * and both are wrong globally. Concatenating two steps' output produces two
 * spans called `[1]`; phase B is handed a list where one number appears twice,
 * cites it, and the marker resolves to whichever the map happened to keep —
 * a confirmed badge over a quote from a different page. That is the identical
 * failure `bindSpans` closed within a single pass, and a multi-step run
 * re-opens it unless the renumbering happens on the way in.
 *
 * So, in order:
 *
 *  1. **`docIndex` is re-homed by URL**, not by arithmetic. The step's local
 *     index means nothing outside the step; the URL is the identity the run
 *     shares, and it is the field `attribute` already proved the span against.
 *     A span whose URL is not in the run's source list is dropped rather than
 *     guessed at — inventing a home for a quote is inventing attribution.
 *  2. **Ids are reassigned from the universe's own length**, so they stay
 *     1..n and contiguous no matter how many steps contributed. Contiguity is
 *     not cosmetic: phase B is told its marker range is closed, and a gap in
 *     the numbering would make a legitimate `[7]` indistinguishable from an
 *     invented one.
 *  3. **Duplicates collapse per document**, the same rule `bindSpans` uses:
 *     the same sentence twice is one citation, the same sentence on two
 *     documents is corroboration and both are kept. A step that only re-proves
 *     what an earlier step already proved therefore reports `found: 0`, which
 *     is true and is exactly what a reader needs in order to cut it.
 *  4. **The cap is checked last**, so a duplicate never consumes a slot a new
 *     span could have had.
 */
export function absorbSpans(
  existing: readonly CitableSpan[],
  incoming: readonly CitableSpan[],
  docIndexOf: (url: string) => number | undefined,
  cap: number,
): AbsorbedSpans {
  const spans = [...existing];
  const dropped: DroppedSpan[] = [];
  const seen = new Set(spans.map((s) => `${s.docIndex} ${s.span}`));
  let added = 0;

  for (const s of incoming) {
    const docIndex = docIndexOf(s.url);
    if (docIndex === undefined) {
      dropped.push({
        span: s.span,
        why: `proven against ${s.url}, which is not in this run's source list — a span with no home is not a citation`,
      });
      continue;
    }

    const key = `${docIndex} ${s.span}`;
    if (seen.has(key)) continue;

    if (spans.length >= cap) {
      dropped.push({
        span: s.span,
        why: `the run's universe is capped at ${cap} spans and was already full`,
      });
      continue;
    }

    seen.add(key);
    spans.push({ id: spans.length + 1, docIndex, url: s.url, span: s.span });
    added += 1;
  }

  return { spans, added, dropped };
}

/* ── the run ──────────────────────────────────────────────────────────────── */

/** Threaded to every step's planner for the same reason the web path threads
 *  it: a sub-question researched without a subject drifts to whoever else
 *  writes about the topic. */
export interface DeepDeps {
  /** Clarify, plan, per-step query planning, attribution, reflection and the
   *  related-question pass. Whole replies, parsed as JSON. */
  readonly ask: AskPort;
  /** The pack's statement of whose interests this serves, threaded to every
   *  step's planner. A sub-question researched without one drifts to whoever
   *  else writes about the topic — see `subjectBlock` in follow-up.ts. */
  readonly subject?: string;
  /** The final write only. One streamed call per run, at the end. */
  readonly askStream: AskStreamPort;
  readonly search: readonly SearchPort[];
  readonly read: ReadPort;
  /** Per-step retrieval. Defaults to `DEFAULT_DEEP_LIMITS`, not the web path's. */
  readonly limits?: ResearchLimits;
  readonly attributeLimits?: AttributeLimits;
  /** Defaults to `DEFAULT_DEEP_BUDGET`; supplied fields override individually. */
  readonly budget?: Partial<DeepBudget>;
  /**
   * The reader's replies to a previous run's `ClarifyEvent`, in their own
   * words. Non-empty means the gate has already been through: it is not asked
   * again, because asking a reader who has just answered is how a research tool
   * becomes a form.
   */
  readonly clarifications?: readonly string[];
  /** Injectable clock, so the wall-clock cap is testable without waiting for
   *  it. Real runs pass nothing and get `Date.now`. */
  readonly now?: () => number;
  readonly onStatus?: (e: StatusEvent) => void;
  readonly onClarify?: (e: ClarifyEvent) => void;
  readonly onPlan?: (e: PlanEvent) => void;
  readonly onStep?: (e: StepEvent) => void;
  readonly onReflect?: (e: ReflectEvent) => void;
  readonly onSource?: (e: SourceEvent) => void;
  readonly onSpan?: (e: SpanEvent) => void;
  readonly onDelta?: (e: DeltaEvent) => void;
  readonly onSentence?: (e: SentenceEvent) => void;
}

/**
 * Deliberately its own shape rather than a `StreamedAnswer`, for the reason
 * `GroundedAnswer` is: a run that stopped to ask a question has no prose, no
 * sources and no spans, and reporting zeros for those reads as "researched and
 * found nothing" rather than "did not start". `clarify` non-null is the only
 * honest way to say which happened.
 */
export interface DeepAnswer {
  readonly question: string;
  /** Set when the run stopped before retrieval to ask. Everything else is then
   *  empty, and `text` is `''` — there is no answer, by design. */
  readonly clarify: ClarifyEvent | null;
  /** The plan as it finished, revisions applied. */
  readonly plan: readonly PlanStep[];
  /** One terminal record per planned step: `done` with its `found` count, or
   *  `skipped` with the cap that ended the run. */
  readonly steps: readonly StepEvent[];
  readonly reflections: readonly ReflectEvent[];
  /** Why the loop ended, in the same words as the `stop` on the last
   *  reflection. Empty only when the run never got as far as a step. */
  readonly stoppedBecause: string;
  readonly text: string;
  readonly sources: readonly ReadDoc[];
  readonly spans: readonly CitableSpan[];
  readonly dropped: readonly DroppedSpan[];
  readonly sentences: readonly SentenceEvent[];
  readonly flagged: number;
  readonly related: readonly string[];
  /** Every query any step ran, in order. The retrieval record — "why is this
   *  answer built out of those pages?" should not need a guess. */
  readonly queries: readonly string[];
  /** Non-empty when there is no answer and the reader is owed the reason. */
  readonly note: string;
  readonly costCents: number;
}

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** One step's outcome, as the loop needs to see it. */
interface StepOutcome {
  readonly added: number;
  readonly detail: string;
  readonly costCents: number;
}

/**
 * Run one question, as a plan of steps, and answer over everything they proved.
 */
export async function streamDeep(question: string, deps: DeepDeps): Promise<DeepAnswer> {
  const budget: DeepBudget = { ...DEFAULT_DEEP_BUDGET, ...deps.budget };
  const limits = deps.limits ?? DEFAULT_DEEP_LIMITS;
  const clarifications = (deps.clarifications ?? []).filter((c) => c.trim() !== '');
  const now = deps.now ?? ((): number => Date.now());
  const status = deps.onStatus ?? ((): void => undefined);
  const emitClarify = deps.onClarify ?? ((): void => undefined);
  const emitPlan = deps.onPlan ?? ((): void => undefined);
  const emitStep = deps.onStep ?? ((): void => undefined);
  const emitReflect = deps.onReflect ?? ((): void => undefined);
  const emitSource = deps.onSource ?? ((): void => undefined);
  const emitSpan = deps.onSpan ?? ((): void => undefined);

  const startedAt = now();
  let cost = 0;

  /** The run-global source list. `SourceEvent.i` and every span's `docIndex`
   *  are 1-based indices into it, which is the whole reason it is one list and
   *  not a list per step. */
  const sources: ReadDoc[] = [];
  /** URL → 1-based index into `sources`. Both the requested URL and the URL the
   *  reader resolved to are keyed, so a redirect does not read a page twice. */
  const byUrl = new Map<string, number>();
  let spans: CitableSpan[] = [];
  const dropped: DroppedSpan[] = [];
  const steps: StepEvent[] = [];
  const reflections: ReflectEvent[] = [];
  const queries: string[] = [];
  let plan: PlanStep[] = [];

  /** Every exit that produces no prose. `stopped` is carried rather than
   *  defaulted to `''` because a run the caps ended with nothing proven is a
   *  different outcome from one that never started, and the empty string reads
   *  as the second. */
  const halt = (
    note: string,
    clarify: ClarifyEvent | null = null,
    stopped = '',
  ): DeepAnswer => {
    status({ phase: 'done', detail: note });
    return {
      question,
      clarify,
      plan,
      steps,
      reflections,
      stoppedBecause: stopped,
      text: '',
      sources,
      spans,
      dropped,
      sentences: [],
      flagged: 0,
      related: [],
      queries,
      note,
      costCents: cost,
    };
  };

  /* 0 ─ the ambiguity gate, BEFORE a search port is touched.
   *
   * Not merely before the first search — before the PLAN, too. Decomposition
   * is where a model commits to a reading of the question, and a gate placed
   * after it is asking whether to clarify something already resolved. */
  if (clarifications.length === 0) {
    status({ phase: 'planning', detail: 'checking the question is specific enough to research' });
    const reply = await deps.ask.ask(CLARIFY_SYSTEM, `REQUEST: ${question}`, CLARIFY_MAX_TOKENS);
    if (reply) {
      cost += reply.costCents;
      const clarify = bindClarify(parseJson(reply.text));
      if (clarify) {
        // The stream ENDS here. Answering is a new request carrying the
        // replies — `ClarifyEvent` says why: SSE has no upstream channel, and
        // inventing one for a question asked at most once per run is a lot of
        // machinery for a rare moment.
        emitClarify(clarify);
        return halt(clarify.because, clarify);
      }
    }
    // A dead or unparseable gate proceeds. See `bindClarify`.
  }

  /* 1 ─ decompose, and publish the plan before any retrieval. */
  status({ phase: 'planning', detail: 'breaking the question into steps' });
  const planReply = await deps.ask.ask(
    PLAN_SYSTEM,
    clarifications.length === 0
      ? `QUESTION: ${question}\n\nPropose at most ${budget.maxSteps} sub-questions.`
      : `QUESTION: ${question}\n\nThe reader has already clarified:\n${clarifications
          .map((c) => `- ${c}`)
          .join('\n')}\n\nPropose at most ${budget.maxSteps} sub-questions.`,
    PLAN_MAX_TOKENS,
  );
  if (!planReply) {
    return halt('The model was unavailable or the budget ceiling refused the call.');
  }
  cost += planReply.costCents;
  plan = bindPlan(parseJson(planReply.text)['steps']);
  if (plan.length === 0) {
    return halt(
      'Could not break that into researchable steps. Try naming a company, a market or a period.',
    );
  }
  emitPlan({ steps: plan });

  /* 2 ─ execute, reflecting between steps, until a cap or the plan ends it. */

  /** Read one step's pages, prove its quotes, merge them into the universe. */
  const runStep = async (step: PlanStep): Promise<StepOutcome> => {
    let spent = 0;

    // Queries come from the STEP's question, through the same planner a first
    // web question uses (empty history, so it is that exact non-conversational
    // path). The original question is not in this prompt: re-injecting it is
    // the documented way a five-step plan becomes five searches for step one.
    status({ phase: 'searching', detail: `step ${step.n}: ${step.question}` });
    const planned = await planSearches(step.question, [], deps.ask, limits.maxQueries, deps.subject);
    spent += planned.costCents;
    if (planned.note !== '') return { added: 0, detail: planned.note, costCents: spent };
    if (planned.queries.length === 0) {
      return {
        added: 0,
        detail: 'could not turn this step into a search',
        costCents: spent,
      };
    }
    queries.push(...planned.queries);

    const hits: SearchHit[] = [];
    for (const q of planned.queries) {
      for (const provider of deps.search) {
        try {
          hits.push(...(await provider.search(q, limits.maxPages)));
        } catch (err) {
          status({
            phase: 'searching',
            detail: `${provider.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
    const unique = dedupeHits(hits);
    if (unique.length === 0) {
      return { added: 0, detail: 'no search results for this step', costCents: spent };
    }

    status({ phase: 'reading', detail: `step ${step.n}: ${unique.length} result(s)` });
    const stepDocs: ReadDoc[] = [];
    for (const h of unique) {
      if (stepDocs.length >= limits.maxPages) break;

      // A page an earlier step already fetched is reused AS TEXT, and that is
      // safe here in a way it explicitly is not across turns: `follow-up.ts`
      // refuses to carry a document body between turns because the guarantee
      // is "verbatim on a page we fetched THIS RUN", and a snapshot from a
      // previous turn silently weakens it to "was there at some earlier point".
      // Inside one run there is no such gap — the page was fetched by this run,
      // minutes ago at most — so re-fetching would buy nothing and cost a
      // request against the same host we are already rate-limited on.
      const known = byUrl.get(h.url);
      if (known !== undefined) {
        const doc = sources[known - 1];
        if (doc && !stepDocs.includes(doc)) stepDocs.push(doc);
        continue;
      }

      const fetched = await deps.read.read(h.url);
      if (fetched === null || fetched.text.trim().length < 200) continue;

      const settled = byUrl.get(fetched.url);
      if (settled !== undefined) {
        // Redirected onto a page we already hold. Key the requested URL too so
        // a later step does not pay for the same redirect.
        byUrl.set(h.url, settled);
        const doc = sources[settled - 1];
        if (doc && !stepDocs.includes(doc)) stepDocs.push(doc);
        continue;
      }

      const doc: ReadDoc = { ...fetched, text: fetched.text.slice(0, limits.maxCharsPerPage) };
      sources.push(doc);
      byUrl.set(doc.url, sources.length);
      byUrl.set(h.url, sources.length);
      stepDocs.push(doc);
      emitSource({ i: sources.length, url: doc.url, title: doc.title, domain: domainOf(doc.url) });
    }
    if (stepDocs.length === 0) {
      return { added: 0, detail: 'read nothing — refused by robots, or assembled in a browser', costCents: spent };
    }

    // Attributed against the STEP's question for the same reason the web path
    // attributes against the standalone rewrite rather than the literal
    // follow-up: the extraction pass reads the question only to decide which
    // sentences are relevant, so pointing it at the original umbrella question
    // would select the same opening-subject sentences on every step.
    status({ phase: 'attributing', detail: `step ${step.n}: ${stepDocs.length} document(s)` });
    const universe = await attribute(step.question, stepDocs, {
      ask: deps.ask,
      ...(deps.attributeLimits ? { limits: deps.attributeLimits } : {}),
    });
    spent += universe.costCents;
    dropped.push(...universe.dropped);

    const before = spans.length;
    const absorbed = absorbSpans(spans, universe.spans, (url) => byUrl.get(url), budget.maxSpans);
    spans = absorbed.spans;
    dropped.push(...absorbed.dropped);
    for (const s of spans.slice(before)) {
      emitSpan({ id: s.id, sourceIndex: s.docIndex, quote: s.span });
    }

    return {
      added: absorbed.added,
      detail:
        absorbed.added === 0 && universe.spans.length > 0
          ? `read ${stepDocs.length} document(s); everything quotable was already proven`
          : `read ${stepDocs.length} document(s)`,
      costCents: spent,
    };
  };

  /** What the reflection is shown: the plan with its outcomes, and the quotes.
   *  Never the document text — see `REFLECT_SYSTEM`. */
  const reflectionBrief = (doneThrough: number): string => {
    const lines = [`QUESTION: ${question}`, '', 'PLAN'];
    for (const s of plan) {
      const record = steps.find((r) => r.n === s.n);
      const state =
        s.n <= doneThrough ? `done, ${record?.found ?? 0} new quote(s)` : 'not run yet';
      lines.push(`[${s.n}] ${s.question} — ${state}`);
    }
    lines.push('', 'QUOTES PROVEN SO FAR');
    if (spans.length === 0) lines.push('(none)');
    for (const s of spans.slice(-20)) lines.push(`[${s.id}] "${clip(s.span, 200)}"`);
    return lines.join('\n');
  };

  let stoppedBecause = '';
  let doneThrough = 0;
  let executed = 0;

  for (let i = 0; i < plan.length; i += 1) {
    const step = plan[i];
    if (!step) break;

    // ── THE CAPS, CHECKED BEFORE THE MODEL GETS A VOTE ──────────────────────
    // Order matters only in what the reader is told, so the cheapest and most
    // legible reason wins: a run that hit both the step cap and the clock
    // should say the step cap, because that is the one the operator set.
    if (executed >= budget.maxSteps) {
      stoppedBecause = `the step cap ended the run — ${budget.maxSteps} step(s) is the ceiling, and ${plan.length - i} planned step(s) did not run`;
    } else if (cost >= budget.maxCostCents) {
      stoppedBecause = `the spend cap ended the run — ${cost.toFixed(3)}¢ of a ${budget.maxCostCents}¢ ceiling, with ${plan.length - i} planned step(s) left`;
    } else if (now() - startedAt >= budget.maxMs) {
      stoppedBecause = `the time cap ended the run — ${Math.round((now() - startedAt) / 1000)}s of a ${Math.round(budget.maxMs / 1000)}s ceiling, with ${plan.length - i} planned step(s) left`;
    } else if (spans.length >= budget.maxSpans) {
      stoppedBecause = `the evidence cap ended the run — ${budget.maxSpans} proven quote(s) is the ceiling, with ${plan.length - i} planned step(s) left`;
    }
    if (stoppedBecause !== '') break;

    emitStep({ n: step.n, state: 'running', detail: step.question });
    const outcome = await runStep(step);
    cost += outcome.costCents;
    executed += 1;
    doneThrough = step.n;

    const record: StepEvent = {
      n: step.n,
      state: 'done',
      detail: outcome.detail,
      found: outcome.added,
    };
    steps.push(record);
    emitStep(record);

    /* Reflect. It may revise the plan ahead of us, and it may say the plan is
     * answered — but it was reached only because every cap above let it be. */
    const reflectReply = await deps.ask.ask(
      REFLECT_SYSTEM,
      reflectionBrief(doneThrough),
      REFLECT_MAX_TOKENS,
    );
    let stillOpen = plan.filter((s) => s.n > doneThrough).map((s) => s.question);
    let note = `Step ${step.n} added ${outcome.added} quote(s); ${spans.length} proven so far.`;
    let modelDone = false;

    if (reflectReply) {
      cost += reflectReply.costCents;
      const parsed = parseJson(reflectReply.text);
      const open = strings(parsed['stillOpen']).map((s) => normalise(s)).filter((s) => s !== '');
      if (open.length > 0) stillOpen = open;
      const rawNote = parsed['note'];
      if (typeof rawNote === 'string' && normalise(rawNote) !== '' && readerSafe(rawNote)) {
        note = clip(normalise(rawNote), 300);
      }
      modelDone = parsed['done'] === true;

      const revised = revisePlan(plan, parsed['revise'], doneThrough);
      const changed =
        revised.length !== plan.length ||
        revised.some((s, idx) => s.question !== plan[idx]?.question);
      if (changed) {
        const rawWhy = parsed['revisedBecause'];
        const revisedBecause =
          typeof rawWhy === 'string' && normalise(rawWhy) !== '' && readerSafe(rawWhy)
            ? clip(normalise(rawWhy), 240)
            : 'The evidence so far changed what the remaining steps should look for.';
        plan = revised;
        emitPlan({ steps: plan, revisedBecause });
        stillOpen = plan.filter((s) => s.n > doneThrough).map((s) => s.question);
      }
    }

    if (modelDone) {
      stoppedBecause =
        stillOpen.length === 0
          ? 'the plan is answered — the run stopped on its own judgement, not on a cap'
          : 'the run judged the remaining steps would add nothing, and stopped on its own judgement, not on a cap';
    }

    const reflection: ReflectEvent = {
      after: step.n,
      stillOpen,
      note,
      ...(stoppedBecause === '' ? {} : { stop: stoppedBecause }),
    };
    reflections.push(reflection);
    emitReflect(reflection);

    if (stoppedBecause !== '') break;
  }

  /* 3 ─ close the record. Exactly one reflection carries `stop`, so
   *     "why did it end?" has one place to look. A cap fires at the TOP of an
   *     iteration, after the previous reflection has already been emitted
   *     without a `stop` — so it gets its own terminal reflection here. */
  if (stoppedBecause === '') {
    stoppedBecause = 'every planned step ran';
    const closing: ReflectEvent = {
      after: doneThrough,
      stillOpen: [],
      note: `${executed} step(s) ran and proved ${spans.length} quote(s).`,
      stop: stoppedBecause,
    };
    reflections.push(closing);
    emitReflect(closing);
  } else if (reflections[reflections.length - 1]?.stop !== stoppedBecause) {
    const closing: ReflectEvent = {
      after: doneThrough,
      stillOpen: plan.filter((s) => s.n > doneThrough).map((s) => s.question),
      note: `${executed} step(s) ran and proved ${spans.length} quote(s).`,
      stop: stoppedBecause,
    };
    reflections.push(closing);
    emitReflect(closing);
  }

  // Steps the caps never let run are reported as `skipped`, with the reason.
  // Dropping them from the record would make a capped run look like a complete
  // one — the plan was published, and the plan is what it is measured against.
  for (const s of plan) {
    if (s.n <= doneThrough) continue;
    const record: StepEvent = { n: s.n, state: 'skipped', detail: stoppedBecause };
    steps.push(record);
    emitStep(record);
  }

  /* 4 ─ synthesise over the ACCUMULATED universe, through the shared stage 5. */

  if (spans.length === 0) {
    return halt(
      `Nothing quotable was found across ${executed} step(s). The pages this run read carried no sentence that answers the question — which is an answer about the sources, not about the topic.`,
      null,
      stoppedBecause,
    );
  }

  const written = await writeFromSpans(
    {
      // The reader's own words, and — when they answered a clarifying question
      // — their own answers. Nothing generated by this run crosses into phase
      // B: not the plan, not a reflection, not a step's `why`. The rule is
      // `stream.ts`'s and it is structural rather than a matter of care — a
      // sub-question is model-written prose, and prose the generator can see is
      // prose the generator can copy, arriving in the answer with a citation to
      // a page that never said it. Only proven quotes are evidence.
      asked:
        clarifications.length === 0
          ? `QUESTION: ${question}`
          : `QUESTION: ${question}\n(the reader also told us: ${clarifications.map((c) => `"${c}"`).join(', ')})`,
      standalone: question,
      spanBlock: spans
        .map(
          (sp) =>
            `[${sp.id}] (source ${sp.docIndex} — ${sources[sp.docIndex - 1]?.title ?? ''})\n"${sp.span}"`,
        )
        .join('\n\n'),
      spans,
      docs: sources,
    },
    {
      ask: deps.ask,
      askStream: deps.askStream,
      ...(deps.onStatus ? { onStatus: deps.onStatus } : {}),
      ...(deps.onDelta ? { onDelta: deps.onDelta } : {}),
      ...(deps.onSentence ? { onSentence: deps.onSentence } : {}),
    },
  );
  cost += written.costCents;

  return {
    question,
    clarify: null,
    plan,
    steps,
    reflections,
    stoppedBecause,
    text: written.text,
    sources,
    spans,
    dropped,
    sentences: written.sentences,
    flagged: written.flagged,
    related: written.related,
    queries,
    note: written.note,
    costCents: cost,
  };
}
