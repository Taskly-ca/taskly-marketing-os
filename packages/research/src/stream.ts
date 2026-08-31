/**
 * PHASES B AND C — write from the proven quotes, then check every sentence.
 *
 * `attribute.ts` builds the citable universe: a numbered set of quotes already
 * proven verbatim on pages this run fetched. This file spends it.
 *
 * **Phase B — generate.** The model writes prose conditioned on that numbered
 * list and nothing else, emitting `[N]` markers. It is never shown a URL, so it
 * cannot produce one: the marker number is generative, the URL is retrieved.
 * That single separation is what the published hallucinated-citation rates are
 * measuring the absence of (UPenn, arXiv:2604.03173 — 3-13% of citation URLs in
 * commercial deep-research agents have no Wayback record at all). Here a
 * citation cannot be invented because there is nothing to invent it out of.
 *
 * **Phase C — check.** Sound citations are not a sound answer. GPTZero's
 * "second-hand hallucination" is a real, correctly-fetched source attached to a
 * claim it never made, and prose paraphrasing a quote can do exactly that. So
 * every completed sentence runs four deterministic checks — no model, no key,
 * no forward pass. The published version of attribute-first escalates to an NLI
 * model (AutoAIS, Vectara HHEM) for entailment; the expensive tier in everyone
 * else's design is free in ours because our question is not "does this entail"
 * but "is this string there".
 *
 * ── WHAT `flagged` MEANS, AND THE UI MUST NOT DRIFT FROM IT ────────────────
 *
 * `flagged` is **"we could not confirm this from the spans it cites"**. It is
 * not "false". A flagged sentence may be perfectly true and merely unquoted.
 * Every `why` string in this file is written to survive being read aloud in
 * front of the reader, which is why none of them says wrong, invented or false
 * about the CLAIM — only about the citation, where the word is earned.
 *
 * The honest ceiling of a `confirmed` badge, stated so nobody over-reads it:
 * every marker resolves to a real quote, and every figure in the sentence is in
 * one of those quotes. Not "this sentence is true".
 *
 * ── WHAT THIS FIXES THAT `pipeline.ts` DOES NOT ────────────────────────────
 *
 * `verifyPoints` runs the honesty gate but has never run the causal lint —
 * `packages/draft` runs both, research runs one, and the gap has been sitting
 * in the answer path where the sentences that get read live. Phase C runs
 * `checkCausalLanguage(sentence, 0)`. Rung 0 is not a parameter waiting to be
 * tuned: a web page we read is an observation, never a randomised holdout, so
 * causal language in an answer built out of it is unsupported by construction.
 *
 * `research()` is untouched and stays the Verified mode — whole-answer gate,
 * nothing shown until everything is checked. This is Fast mode beside it.
 *
 * ── AND WHAT CONVERSATION CHANGES, WHICH IS LESS THAN IT LOOKS ─────────────
 *
 * `deps.history` makes a follow-up planable: `follow-up.ts` resolves "and in
 * Vancouver?" into a standalone question and standalone queries, and may say
 * the pages the last turn read are still the right pages, which skips a search
 * call. That is the entire concession. It reaches the PLANNER and the RETRIEVAL
 * and stops there — phase B never sees a previous answer, phase A still proves
 * every span against a document fetched in THIS run, and phase C still checks
 * every sentence. A follow-up whose reused pages have stopped supporting it
 * comes back short, flagged, or refused; there is no path by which a claim
 * inherits an earlier turn's confidence.
 *
 * ── AND WHAT GROUNDED MODE CHANGES, WHICH IS LESS AGAIN ────────────────────
 *
 * `grounded.ts` builds a citable universe out of Postgres — the world model,
 * live findings, the Brain, the ledger — with no search, no fetch and no
 * attribution pass, because an internal span was proven the day it was written.
 * What it needed was stage 5 and nothing else, so stage 5 is now
 * `writeFromSpans` and BOTH entry points call it: `streamAnswer` after its four
 * web stages, `streamGrounded` over the universe it is handed.
 *
 * One copy, and the reason is the badge. `confirmed` is rendered by one client
 * that cannot tell which pipeline wrote the sentence under it, so the checks
 * behind it must be the same code and not merely the same intention. The long
 * argument for this shape — and against the smaller-diff alternative, a
 * `prebuilt` flag on `StreamDeps` — is above `writeFromSpans`.
 */
import { checkCausalLanguage, checkHonesty } from '@tmos/guardrails';

import type { AttributeLimits, CitableSpan, CitableUniverse, DroppedSpan } from './attribute.js';
import { attribute } from './attribute.js';
import type {
  ConversationTurn,
  DeltaEvent,
  SentenceEvent,
  SourceEvent,
  SpanEvent,
  StatusEvent,
} from './events.js';
import { planSearches, relatedQuestions, reuseUrls } from './follow-up.js';
import type { GroundedSpan, GroundedUniverse } from './grounded.js';
import { groundedDocs, groundedSpanBlock } from './grounded.js';
import type { ResearchLimits } from './pipeline.js';
import { DEFAULT_LIMITS, dedupeHits } from './pipeline.js';
import type { SentencePiece } from './sentences.js';
import { SentenceSplitter } from './sentences.js';
import type {
  AskPort,
  AskStreamPort,
  ReadDoc,
  ReadPort,
  SearchHit,
  SearchPort,
} from './types.js';
import { claimNumbers } from './verify.js';

/* ── phase B: the prompt ──────────────────────────────────────────────────── */

/**
 * The generation prompt. Three properties matter and each is load-bearing:
 *
 *  1. **The span list is the entire world.** No URLs appear anywhere in this
 *     prompt or its user message, so "never invent a URL" is not a rule the
 *     model has to remember — it is a thing it has no material for.
 *  2. **The marker range is closed and stated.** An out-of-range `[N]` then has
 *     one possible meaning, fabrication, and is caught rather than rendered.
 *  3. **The mechanical checks are disclosed.** Same medicine as `SYNTH_SYSTEM`:
 *     a model told a guess will be caught stops guessing, because the guess now
 *     costs it the sentence and gains it nothing.
 *
 * Nothing in here crosses the honesty boundary. That is not a style choice —
 * a banned phrase in a system prompt generates itself into the output, so the
 * gate would be catching its own instructions.
 */
const GEN_SYSTEM = [
  'You answer a marketing research question in short, plain prose.',
  '',
  'YOU MAY USE ONLY THE NUMBERED SPANS YOU ARE GIVEN. Each is a sentence this',
  'run already proved is on a page we fetched. You have no other evidence and',
  'you have been given no web addresses — so never write one, and never name a',
  'publisher a span does not name.',
  '',
  'HOW TO WRITE',
  '- Cite with a bracketed number: [3]. The number must be one of the span',
  '  numbers below. There are no others.',
  '- Every sentence that states a fact carries at least one marker.',
  '- Every figure, date, price or percentage you write must appear in a span',
  '  you cite IN THAT SAME SENTENCE, character-for-character. Do not add up,',
  '  average or convert figures — a derived number is in no span.',
  '- If the spans do not settle part of the question, say so plainly.',
  '- Short sentences. No headings, no lists, no marketing register.',
  '',
  'CHECKED MECHANICALLY, SENTENCE BY SENTENCE, AS YOU WRITE:',
  '- A marker outside the range you were given is deleted before any reader',
  '  sees it, and its sentence is marked unconfirmed.',
  '- A number that is in no span you cited marks the sentence unconfirmed.',
  '- Never write that something caused, drove, led to or boosted something',
  '  else. Nothing here is an experiment. Write "observed alongside" or',
  '  "coincided with".',
  '- Never state that Taskly screens, checks, covers or promises anything about',
  '  anyone. No span supports it and the sentence will be refused.',
].join('\n');

/** Prose, not JSON, and short by instruction — the answer is a paragraph or
 *  three. Sized so the ceiling is never the reason an answer stops mid-word. */
const GEN_MAX_TOKENS = 1_200;

/* ── citation markers ─────────────────────────────────────────────────────── */

/**
 * `[3]`, and tolerantly `[1, 2]`.
 *
 * Anything else between brackets is ordinary prose and is left alone: treating
 * `[sic]` as a broken citation would flag honest sentences, and the cost of
 * missing an exotic marker form is that it renders as text, which is visible.
 */
const MARKER = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;

function markerIds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MARKER)) {
    for (const part of (m[1] ?? '').split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n)) out.push(n);
    }
  }
  return out;
}

/** Marker digits are not claims. Stripping them before the number check is not
 *  cosmetic: without it, `[12]` demands that "12" appear in a cited span, and
 *  every well-cited sentence past span 9 would be flagged for citing itself. */
const withoutMarkers = (text: string): string => text.replace(MARKER, ' ');

/* ── phase C: the per-sentence check ──────────────────────────────────────── */

/**
 * Four checks on one completed sentence. Deterministic, no model, no key.
 *
 *  1. **Every marker resolves.** The model was handed a closed, numbered set,
 *     so a number outside it cannot be a typo for a real source the way a
 *     mistyped URL can — it is a citation with nothing behind it. Same argument
 *     as `bindCitations` and `bindSpans`; this is the third and last place a
 *     number the model invented could enter the answer.
 *  2. **Every figure is in a cited span.** Derived numbers are where a research
 *     answer does its real damage: "the GTA market is worth $2.1B" is
 *     actionable, unfalsifiable at a glance, and frequently arithmetic the
 *     model did in its head. `claimNumbers` is imported from `verify.ts` rather
 *     than reimplemented so Fast mode and Verified mode cannot drift about what
 *     counts as a number — including the deliberate exemption for bare
 *     integers under 10, without which "the top 3 reasons" flags every time.
 *
 *     `claimNumbers` is used for the SPAN side too, which is stricter than the
 *     verifier's private `numbersIn`: a bare `5` in a span will not satisfy a
 *     `$5` in the sentence. That is the correct direction — "$5" is not
 *     supported by a page that says "5" — and it keeps this file free of a
 *     second, drifting copy of the number rules.
 *  3. **Honesty**, at `internal`: the boundary is legal, not stylistic, and it
 *     binds an internal research answer because that is where a banned claim
 *     enters a campaign six months later.
 *  4. **Causal language at rung 0**, the check `research()` has never run. A
 *     page we read is an observation; nothing in this pipeline can reach rung 2.
 *
 * All four run — the reader is owed every reason a sentence did not clear, not
 * just the first. `why` names the failure and never the sentence: "could not be
 * confirmed" is the claim being made, and it is a claim about evidence.
 */
export function checkSentence(
  n: number,
  text: string,
  spans: readonly CitableSpan[],
): SentenceEvent {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const cited: CitableSpan[] = [];
  const unknown: number[] = [];
  for (const id of markerIds(text)) {
    const span = byId.get(id);
    if (span) cited.push(span);
    else if (!unknown.includes(id)) unknown.push(id);
  }

  const why: string[] = [];

  if (unknown.length > 0) {
    why.push(
      `cites ${unknown.map((u) => `[${u}]`).join(', ')}, and this run proved ${spans.length} span(s) — a marker with no span behind it was removed before it reached the page`,
    );
  }

  const haystack = new Set(claimNumbers(cited.map((c) => c.span).join(' ')));
  const missing = claimNumbers(withoutMarkers(text)).filter((num) => !haystack.has(num));
  if (missing.length > 0) {
    why.push(
      cited.length === 0
        ? `${missing.map((m) => `"${m}"`).join(', ')} is stated here and this sentence cites no span at all, so there is nothing to confirm it against`
        : `${missing.map((m) => `"${m}"`).join(', ')} does not appear in any span this sentence cites — unconfirmed, which is weaker than wrong: the figure may be right and merely unquoted`,
    );
  }

  const honesty = checkHonesty(text, 'internal');
  if (!honesty.ok) {
    why.push(
      `honesty gate: ${honesty.violations.map((v) => `"${v.match}" — ${v.reason}`).join('; ')}`,
    );
  }

  const causal = checkCausalLanguage(text, 0);
  if (!causal.ok) {
    why.push(
      `causal language with no experiment behind it: ${causal.violations
        .map((v) => `"${v.match}" — say "${v.suggest}"`)
        .join('; ')}`,
    );
  }

  return why.length === 0
    ? { n, verdict: 'confirmed' }
    : { n, verdict: 'flagged', why: why.join('; ') };
}

/* ── the marker gate: caught, not rendered ────────────────────────────────── */

/** Long enough for `[10, 11, 12]`, short enough that a stray `[` in prose is
 *  released almost immediately rather than swallowing the sentence after it. */
const MAX_MARKER_HOLD = 14;

/**
 * Removes fabricated markers from the text on its way to the reader.
 *
 * A brief hold is unavoidable: `[` arrives, and whether it opens a citation is
 * not knowable until `]` does. So an open bracket is buffered — at most a few
 * characters — and released either as a resolved marker, as literal prose, or,
 * if the number behind it does not exist, as nothing at all.
 *
 * This runs AFTER the splitter, on already-tagged pieces, so a dropped marker
 * can never move a sentence boundary — the boundary was decided on the raw
 * text and the check reads that same raw text. The gate governs what is SHOWN;
 * `checkSentence` independently governs what is SAID about it. Two mechanisms
 * reading the same evidence, neither depending on the other having run.
 *
 * The hold is released at a sentence change rather than carried across it: a
 * citation never spans two sentences, and text held under sentence n must not
 * re-emerge tagged n+1, which would break the lossless per-index invariant the
 * client renders on.
 */
class MarkerGate {
  private hold = '';
  private n = -1;

  constructor(private readonly known: (id: number) => boolean) {}

  feed(piece: SentencePiece): DeltaEvent[] {
    const out: DeltaEvent[] = [];
    if (piece.n !== this.n) {
      if (this.hold !== '' && this.n >= 0) out.push({ n: this.n, text: this.hold });
      this.hold = '';
      this.n = piece.n;
    }

    let buf = '';
    for (const c of piece.text) {
      if (this.hold !== '') {
        if (c === ']') {
          buf += this.resolve(`${this.hold}]`);
          this.hold = '';
          continue;
        }
        if (/[\d,\s]/.test(c) && this.hold.length < MAX_MARKER_HOLD) {
          this.hold += c;
          continue;
        }
        // Not a citation after all. Release it verbatim and reconsider `c`,
        // which may itself be the `[` that opens a real one.
        buf += this.hold;
        this.hold = '';
      }
      if (c === '[') {
        this.hold = '[';
        continue;
      }
      buf += c;
    }

    if (buf !== '') out.push({ n: piece.n, text: buf });
    return out;
  }

  /** Stream over: an unclosed bracket was prose all along. */
  flush(): DeltaEvent[] {
    if (this.hold === '' || this.n < 0) return [];
    const out = [{ n: this.n, text: this.hold }];
    this.hold = '';
    return out;
  }

  /** A group is all-or-nothing: `[1,9]` with 9 missing is dropped whole, since
   *  silently rewriting it to `[1]` would be this module editing a citation and
   *  then vouching for the result. */
  private resolve(marker: string): string {
    const ids = markerIds(marker);
    return ids.length > 0 && ids.every((id) => this.known(id)) ? marker : '';
  }
}

/* ── stage 5, on its own, over any universe ───────────────────────────────── */

/**
 * GENERATE AND CHECK, LIFTED OUT OF `streamAnswer` — AND WHY IT IS A FUNCTION
 * RATHER THAN A FLAG.
 *
 * Grounded mode arrives holding a finished citable universe. `grounded.ts`
 * built it out of Postgres: no search, no fetch, and no attribution model pass,
 * because an internal span was proven verbatim on the day it was written. What
 * it still needs is everything from here down — prose, sentence boundaries, the
 * marker gate, `checkSentence` on every sentence — and there was no door to it.
 *
 * Two doors were possible.
 *
 *  (a) An optional `prebuilt` on `StreamDeps`, with `streamAnswer` skipping
 *      stages 1-4 when it is set. Smaller diff, and rejected on two counts.
 *      First, `StreamDeps` requires `search` and `read`; a grounded caller
 *      would have to hand over a search port it must never use, and a grounded
 *      answer that COULD reach a search provider eventually reaches one — "what
 *      do we know about Jiffy?" answered from a search engine is a different
 *      question with the same words. Second, "the web path is unchanged" would
 *      become a property of a branch at the top of a 200-line function, holding
 *      only as long as every future edit to stages 1-4 keeps it holding. That
 *      is a promise re-made on every commit.
 *
 *  (b) This. Stage 5 is a function; both entry points call it. The web path's
 *      stages 1-4 are not touched at all, so "unchanged" is structural rather
 *      than a thing to re-verify, and grounded mode cannot reach a search port
 *      because it is never given one.
 *
 * The reason it is one function and not two copies is the badge. `confirmed`
 * means one thing — every marker resolves, every figure is in a span that
 * sentence cites — and it is rendered by one client that cannot tell which
 * pipeline produced the sentence under it. A second copy of this loop would
 * drift, and the day it drifts the badge quietly acquires two meanings and
 * nothing anywhere says which one a reader is looking at.
 *
 * What crosses is a `CitableUniverse`'s spans and a `ReadDoc[]`, so nothing in
 * here can know where the evidence came from — the same reason `GEN_SYSTEM`
 * needs no grounded variant.
 */
export interface SpanGeneration {
  /**
   * The `QUESTION:` block, composed by the caller.
   *
   * The web path appends the reader's literal follow-up under the standalone
   * rewrite; grounded mode has no rewrite and passes the question as typed.
   * Composed there rather than here because only the caller knows whether a
   * rewrite happened, and a `standalone !== question` test in this file would
   * be re-deriving what the planner already decided.
   */
  readonly asked: string;
  /** The resolved question, for the related-questions pass — which is scored
   *  against the spans, so it must be asked about the question they answer. */
  readonly standalone: string;
  /** The numbered span list, already formatted. Both callers produce the
   *  identical shape (`groundedSpanBlock` mirrors the web path's) and it is
   *  passed in rather than built here so neither has to hand over the doc
   *  titles a second time in a second shape. */
  readonly spanBlock: string;
  readonly spans: readonly CitableSpan[];
  /** Only `relatedQuestions` reads these, for the titles it grounds against. */
  readonly docs: readonly ReadDoc[];
}

export interface SpanGenerationDeps {
  /** The related-questions pass. Not generation — see `AskStreamPort`. */
  readonly ask: AskPort;
  readonly askStream: AskStreamPort;
  readonly onStatus?: (e: StatusEvent) => void;
  readonly onDelta?: (e: DeltaEvent) => void;
  readonly onSentence?: (e: SentenceEvent) => void;
}

export interface WrittenAnswer {
  /** What the reader saw: the prose with fabricated markers removed. Equal to
   *  the concatenation of every `DeltaEvent`, by construction. */
  readonly text: string;
  readonly sentences: readonly SentenceEvent[];
  readonly flagged: number;
  readonly related: readonly string[];
  /** Non-empty when the answer is partial and the reader is owed the reason. */
  readonly note: string;
  /** Generation plus the related pass. Phase A's cost is the caller's, because
   *  only the caller knows whether phase A cost anything. */
  readonly costCents: number;
}

/**
 * Write prose against a proven universe, checking each sentence as it closes.
 *
 * Announces `writing`, then `checking`, then `done` — the staging is part of
 * the wire contract and belongs with the work, so both modes reveal the same
 * way. It does NOT announce the phases before it: what happened upstream is
 * the caller's to describe, and a grounded run must never say `searching`.
 */
export async function writeFromSpans(
  req: SpanGeneration,
  deps: SpanGenerationDeps,
): Promise<WrittenAnswer> {
  const status = deps.onStatus ?? ((): void => undefined);
  const emitDelta = deps.onDelta ?? ((): void => undefined);
  const emitSentence = deps.onSentence ?? ((): void => undefined);

  status({ phase: 'writing' });
  const known = new Set(req.spans.map((s) => s.id));
  const splitter = new SentenceSplitter();
  const gate = new MarkerGate((id) => known.has(id));
  const sentences: SentenceEvent[] = [];
  let cost = 0;
  let shown = '';
  let raw = '';

  const consume = (pieces: readonly SentencePiece[], closed: readonly { n: number; text: string }[]): void => {
    for (const piece of pieces) {
      for (const d of gate.feed(piece)) {
        shown += d.text;
        emitDelta(d);
      }
    }
    for (const c of closed) {
      const verdict = checkSentence(c.n, c.text, req.spans);
      sentences.push(verdict);
      emitSentence(verdict);
    }
  };

  const feed = (chunk: string): void => {
    if (chunk === '') return;
    raw += chunk;
    const out = splitter.push(chunk);
    consume(out.pieces, out.closed);
  };

  const written = await deps.askStream.askStream(
    GEN_SYSTEM,
    `${req.asked}\n\nSPANS — the only things you may cite:\n\n${req.spanBlock}`,
    GEN_MAX_TOKENS,
    feed,
  );

  // A refused or dead call is not a short answer. `AskStreamPort` says the
  // deltas are a side channel and the returned result is the answer, and the
  // reason is exactly this branch: a half-answer reads like a whole one, and
  // flushing the splitter here would hand a truncated fragment to the checker,
  // which would then stamp a verdict on a sentence the model never finished.
  if (!written) {
    const note =
      'The answer stopped part-way — the model call failed or the budget ceiling refused it.';
    status({ phase: 'done', detail: note });
    return {
      text: shown,
      sentences,
      flagged: sentences.filter((s) => s.verdict === 'flagged').length,
      related: [],
      note,
      costCents: cost,
    };
  }
  cost += written.costCents;

  // The returned text is authoritative. Normally it is exactly what streamed;
  // when a transport dropped deltas it is longer, and the tail is fed through
  // the same splitter so those sentences are checked like any other. If it is
  // not an extension of what streamed the two disagree about the past, and
  // re-emitting would renumber sentences the client has already rendered — so
  // the disagreement is reported rather than reconciled.
  let note = '';
  if (written.text.startsWith(raw)) feed(written.text.slice(raw.length));
  else if (raw !== '') note = 'The streamed text and the returned answer disagreed; only the streamed part was checked.';
  else feed(written.text);

  status({ phase: 'checking' });
  const tail = splitter.end();
  consume(tail.pieces, tail.closed);
  for (const d of gate.flush()) {
    shown += d.text;
    emitDelta(d);
  }

  const flagged = sentences.filter((s) => s.verdict === 'flagged').length;

  // What to ask next. Last, and out of the spans rather than the prose: a
  // suggestion sits in a rail that reads like navigation, which is the most
  // credulous place on the page, and an ungrounded one there is an uncited
  // claim wearing a question mark. `bindRelated` refuses anything the proven
  // quotes do not name — including a figure they do not carry.
  const suggested = await relatedQuestions(req.standalone, req.spans, req.docs, deps.ask);
  cost += suggested.costCents;

  status({ phase: 'done', detail: `${sentences.length} sentence(s), ${flagged} flagged` });

  return { text: shown, sentences, flagged, related: suggested.related, note, costCents: cost };
}

/* ── the pipeline ─────────────────────────────────────────────────────────── */

export interface StreamDeps {
  /** Planning, attribution and the related-question pass — whole replies,
   *  parsed as JSON. */
  readonly ask: AskPort;
  /** Generation only. A separate port on purpose: see `AskStreamPort`. */
  readonly askStream: AskStreamPort;
  readonly search: readonly SearchPort[];
  readonly read: ReadPort;
  readonly limits?: ResearchLimits;
  readonly attributeLimits?: AttributeLimits;
  /**
   * The turns before this one, oldest first. Absent or empty means a first
   * question, and the run then plans, searches and reads exactly as it did
   * before conversation existed — that equivalence is tested, because a
   * follow-up feature that quietly changes the first answer is a regression
   * nobody would look for.
   *
   * History reaches the PLANNER and nothing else. It never reaches phase B:
   * see the note above the generation call for why that boundary is the real
   * defence and the per-sentence checks are only the backstop.
   */
  readonly history?: readonly ConversationTurn[];
  /** The pack's one-line statement of whose interests the queries serve. Absent
   *  restores the pre-2026-08-31 behaviour exactly; see `subjectBlock`. */
  readonly subject?: string;
  readonly onStatus?: (e: StatusEvent) => void;
  readonly onSource?: (e: SourceEvent) => void;
  readonly onSpan?: (e: SpanEvent) => void;
  readonly onDelta?: (e: DeltaEvent) => void;
  readonly onSentence?: (e: SentenceEvent) => void;
}

export interface StreamedAnswer {
  readonly question: string;
  /** What the reader saw: the model's prose with fabricated markers removed.
   *  Equal to the concatenation of every `DeltaEvent`, by construction. */
  readonly text: string;
  readonly sources: readonly ReadDoc[];
  readonly spans: readonly CitableSpan[];
  readonly dropped: readonly DroppedSpan[];
  readonly sentences: readonly SentenceEvent[];
  /** Surfaced, never swallowed — §7 of the plan: the failures are the honest
   *  part and the tempting thing to delete for a cleaner screen. */
  readonly flagged: number;
  readonly queries: readonly string[];
  readonly unanswered: readonly string[];
  /**
   * Questions to ask next, each grounded in a span this run proved. Returned
   * rather than emitted as an event because `events.ts` is the wire contract
   * three parallel pieces already agreed on, and a new event name is a change
   * to all three; the route can carry these on `done` or in the message row.
   */
  readonly related: readonly string[];
  /** URLs read because a previous turn had read them, not because this run's
   *  search found them. Empty on a first question. Surfaced so "why is this
   *  answer built out of those pages?" has an answer that is not a guess. */
  readonly reused: readonly string[];
  /** Non-empty when there is no answer and the reader is owed the reason. */
  readonly note: string;
  readonly costCents: number;
}

/** Tags a reading-list entry that came from a previous turn rather than from a
 *  search this run. A provider name and not a boolean flag, because that is
 *  what `SearchHit` already carries and it lets a reused URL travel through
 *  `dedupeHits` — where a search result for the same page collapses into it —
 *  without a second, parallel notion of "already have this one". */
const REUSE_PROVIDER = 'prior-turn';

/** Shown on the source card. A URL we cannot parse is one we still fetched, so
 *  it keeps its place in the list rather than vanishing from the count. */
const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * One question, answered as it is written.
 *
 * Stages: plan → search → read (thin re-implementations of `pipeline.ts`'s,
 * because that file is Verified mode and does not change) → attribute → stream
 * → check. Every stage announces itself, because the UX finding behind this
 * whole design is that sources appearing BEFORE the prose is what makes a
 * multi-second wait read as progress instead of a stall.
 */
export async function streamAnswer(question: string, deps: StreamDeps): Promise<StreamedAnswer> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const history = deps.history ?? [];
  const status = deps.onStatus ?? ((): void => undefined);
  const emitSource = deps.onSource ?? ((): void => undefined);
  const emitSpan = deps.onSpan ?? ((): void => undefined);
  const emitDelta = deps.onDelta ?? ((): void => undefined);
  const emitSentence = deps.onSentence ?? ((): void => undefined);

  let cost = 0;
  const sources: ReadDoc[] = [];
  const reused: string[] = [];
  let queries: string[] = [];
  let cannot: string[] = [];

  const stop = (note: string, universe?: CitableUniverse): StreamedAnswer => {
    status({ phase: 'done', detail: note });
    return {
      question,
      text: '',
      sources,
      spans: universe?.spans ?? [],
      dropped: universe?.dropped ?? [],
      sentences: [],
      flagged: 0,
      queries,
      unanswered: cannot,
      related: [],
      reused,
      note,
      costCents: cost,
    };
  };

  /* 1 ─ plan. With history this also resolves the follow-up into a standalone
   *       question and decides whether the last turn's pages still apply. */
  status({ phase: 'planning' });
  const plan = await planSearches(question, history, deps.ask, limits.maxQueries, deps.subject);
  cost += plan.costCents;
  if (plan.note !== '') return stop(plan.note);
  queries = [...plan.queries];
  cannot = [...plan.unanswerable];

  // The URL list is reused; the page text never is. `reuseUrls` carries the
  // argument — every reused page is fetched again, so a follow-up is answered
  // out of the page as it is now and every span is still proven against a
  // document THIS run read.
  const reusable = reuseUrls(history, plan, limits.maxPages);
  if (queries.length === 0 && reusable.length === 0) {
    return stop('Could not turn that into a search. Try naming a company, a market or a period.');
  }

  /* 2 ─ search, unless the follow-up needs nothing new */
  const hits: SearchHit[] = [];
  if (queries.length === 0) {
    // The no-new-retrieval case. The phase is still announced so the client's
    // staged reveal keeps the same shape, and the detail says plainly that no
    // search was run — a silent skip would look like a fast search.
    status({
      phase: 'searching',
      detail: `no new search — re-reading the ${reusable.length} page(s) the previous answer used`,
    });
  } else {
    status({ phase: 'searching', detail: queries.join(' · ') });
    for (const q of queries) {
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
  }

  // Reused URLs go through `dedupeHits` alongside the search results, and go in
  // FIRST. That does both halves of the job with the canonicalisation the
  // pipeline already uses: known-good pages are read before speculative ones,
  // and a search result we had already read collapses into the reused entry
  // instead of being fetched a second time.
  const unique = dedupeHits([
    ...reusable.map((url) => ({ title: '', url, snippet: '', provider: REUSE_PROVIDER })),
    ...hits,
  ]);
  if (unique.length === 0) {
    return stop('No search results. The providers returned nothing for those queries.');
  }

  /* 3 ─ read. Robots decides; a refusal is normal, reported, and not retried. */
  status({ phase: 'reading', detail: `${unique.length} result(s)` });
  for (const h of unique) {
    if (sources.length >= limits.maxPages) break;
    const doc = await deps.read.read(h.url);
    if (doc === null || doc.text.trim().length < 200) continue;
    sources.push({ ...doc, text: doc.text.slice(0, limits.maxCharsPerPage) });
    if (h.provider === REUSE_PROVIDER) reused.push(h.url);
    // Emitted the moment it is read, not at the end: the staged reveal is the
    // product, and a source card is the first thing this run can honestly show.
    emitSource({
      i: sources.length,
      url: doc.url,
      title: doc.title,
      domain: domainOf(doc.url),
    });
  }
  if (sources.length === 0) {
    // A reuse-only follow-up whose pages have all gone — rotted links, a
    // changed robots.txt — stops here. The tempting alternative is to answer
    // from the previous turn, which is available, on-topic and already written.
    // It is also unverifiable: not one word of it is a span this run proved, so
    // an answer built from it would wear badges it did not earn. Refusing is
    // the whole point of the design.
    return stop(
      queries.length === 0
        ? 'Could not re-read any of the pages the previous answer used, and this follow-up needed no new search — so there is nothing to answer from. The earlier answer is context, not evidence.'
        : 'Found results but could not read any of them — refused by robots.txt, or assembled in a browser.',
    );
  }

  /* 4 ─ attribute: prove the quotes before any prose exists.
   *
   * Against the STANDALONE question, not the literal follow-up: "and in
   * Vancouver?" selects no spans at all, because the extraction pass reads the
   * question only to decide which sentences are relevant and those four words
   * are relevant to nothing. */
  status({ phase: 'attributing', detail: `${sources.length} document(s)` });
  const universe = await attribute(plan.standalone, sources, {
    ask: deps.ask,
    ...(deps.attributeLimits ? { limits: deps.attributeLimits } : {}),
  });
  cost += universe.costCents;
  for (const s of universe.spans) {
    emitSpan({ id: s.id, sourceIndex: s.docIndex, quote: s.span });
  }
  // An empty universe is a legitimate outcome and phase B must not paper over
  // it. Generating against no evidence is the plain-LLM failure this package
  // exists to prevent, so the reason is returned instead of an answer.
  if (universe.spans.length === 0) return stop(universe.note, universe);

  /* 5, 6 ─ generate, check, and propose what to ask next.
   *
   * Delegated to `writeFromSpans` rather than inlined, so grounded mode runs
   * this exact loop. What crosses is the universe's spans, the docs and one
   * composed question string — nothing below this line can know a search ran.
   */

  // ── THE CONVERSATION STOPS HERE, AND THIS IS THE LOAD-BEARING PART ────────
  //
  // Phase B is handed the standalone question and the spans. It is NOT handed
  // the conversation, and specifically not the previous answer — even though
  // that answer is on-topic, already written, and would make a follow-up read
  // more naturally.
  //
  // Phase C is not sufficient on its own here. Its number check catches a
  // FIGURE carried across from an earlier turn, because the figure has to
  // appear in a span cited this run. It catches nothing about a claim with no
  // figure in it: "Jiffy is the larger of the two" copied out of the previous
  // answer, marked with a citation to a page re-read this run that no longer
  // says it, passes every check in `checkSentence` and renders confirmed. The
  // only defence against that is structural — the sentence cannot be copied
  // from prose the model was never shown.
  //
  // So the conversation buys better retrieval and a resolved question, and buys
  // no shortcut whatsoever on evidence. If the reused pages have stopped
  // supporting the earlier claim, this turn is short or flagged, which is the
  // correct outcome and the one the conversation must not be able to soften.
  //
  // The boundary is now enforced by the SHAPE as well as by this comment:
  // `writeFromSpans` has no `history` field to pass one to, so history cannot
  // reach phase B by a future edit that forgets to read this paragraph.
  const written = await writeFromSpans(
    {
      // The reader's own words are still shown beside the standalone rewrite,
      // so the answer is visibly a reply to what was typed rather than to a
      // rewrite nobody saw. This is the ONE thing about the conversation that
      // crosses, and it is the reader's own sentence.
      asked:
        plan.standalone === question
          ? `QUESTION: ${question}`
          : `QUESTION: ${plan.standalone}\n(the reader typed this as a follow-up: "${question}")`,
      standalone: plan.standalone,
      spanBlock: universe.spans
        .map(
          (sp) =>
            `[${sp.id}] (source ${sp.docIndex} — ${sources[sp.docIndex - 1]?.title ?? ''})\n"${sp.span}"`,
        )
        .join('\n\n'),
      spans: universe.spans,
      docs: sources,
    },
    {
      ask: deps.ask,
      askStream: deps.askStream,
      onStatus: status,
      onDelta: emitDelta,
      onSentence: emitSentence,
    },
  );
  cost += written.costCents;

  return {
    question,
    text: written.text,
    sources,
    spans: universe.spans,
    dropped: universe.dropped,
    sentences: written.sentences,
    flagged: written.flagged,
    queries,
    unanswered: cannot,
    related: written.related,
    reused,
    note: written.note,
    costCents: cost,
  };
}

/* ── grounded mode: the same phases, over evidence we already hold ────────── */

/**
 * The result of answering from our own records.
 *
 * Deliberately NOT a `StreamedAnswer`: three of that shape's fields would have
 * to be filled with lies of omission here. `queries` would be an empty array
 * that reads like "the search found nothing" rather than "no search was run";
 * `reused` is about pages a previous turn fetched, and this path fetches none;
 * `unanswered` is the planner's list of sub-questions it could not turn into a
 * query, and there is no planner. A caller that wants to render both modes
 * through one component is better served by a shape that omits what did not
 * happen than by one that reports zero for it.
 *
 * `spans` are `GroundedSpan`s, so a renderer keeps the `kind` and `observedAt`
 * a reader needs in order to weigh a Brain passage differently from a
 * competitor's own page.
 */
export interface GroundedAnswer {
  readonly question: string;
  readonly text: string;
  /** The universe projected as documents — the retrieval record, so a thread
   *  reopened tomorrow still shows which of our own rows it rested on. */
  readonly sources: readonly ReadDoc[];
  readonly spans: readonly GroundedSpan[];
  readonly dropped: readonly DroppedSpan[];
  readonly sentences: readonly SentenceEvent[];
  readonly flagged: number;
  readonly related: readonly string[];
  readonly note: string;
  readonly costCents: number;
}

export interface GroundedStreamDeps {
  readonly ask: AskPort;
  readonly askStream: AskStreamPort;
  readonly onStatus?: (e: StatusEvent) => void;
  readonly onDelta?: (e: DeltaEvent) => void;
  readonly onSentence?: (e: SentenceEvent) => void;
}

/**
 * Answer one question from a universe the caller already built.
 *
 * ── WHAT IS ABSENT, AND EVERY ABSENCE IS THE POINT ─────────────────────────
 *
 * **No `search`, no `read`.** Not an omission for brevity: a grounded answer
 * that COULD reach a search provider would eventually reach one, and the
 * reader who picked this mode asked what WE know. The ports are not in the
 * shape, so the mode cannot silently become the web mode under load, under a
 * retry, or under a future edit.
 *
 * **No `history`.** The web path lets a conversation reach the PLANNER, and
 * grounded mode has no planner — the console's retrieval is deterministic term
 * and entity matching over our own rows. So the question reaches phase B as it
 * was typed. The honest consequence, stated rather than hidden: a grounded
 * follow-up phrased "and in Vancouver?" retrieves against those four words and
 * will come back empty. That is a retrieval limitation with a visible failure,
 * which is the right trade against the alternative — handing phase B a previous
 * answer, whose failure is invisible.
 *
 * **No attribution pass, and no cost for phase A.** `grounded.ts` says why: the
 * span already exists and was checked when it was written, so a model asked to
 * propose it could only re-word it on the way past.
 *
 * ── WHAT IS PRESENT IS EVERYTHING PHASE C DOES ─────────────────────────────
 *
 * `writeFromSpans` is the same function the web path calls. Markers resolve or
 * are deleted before a reader sees them; every figure must be in a span the
 * sentence cites; the honesty gate and the causal lint run on every sentence.
 * Not "the equivalent checks" — the same code, so a `confirmed` badge means the
 * same thing in both modes, which is the entire reason grounded mode is a
 * second entry point rather than a second pipeline.
 */
export async function streamGrounded(
  question: string,
  universe: GroundedUniverse,
  deps: GroundedStreamDeps,
): Promise<GroundedAnswer> {
  const status = deps.onStatus ?? ((): void => undefined);
  const docs = groundedDocs(universe);

  // An empty universe stops here, before a model is asked anything. Same rule
  // as the web path and for the same reason — generating against no evidence is
  // the plain-LLM failure this package exists to prevent — but the reason is
  // better here: `groundedUniverse` already separates "we hold nothing on this"
  // from "we hold things and none can be quoted" from "all we have is a
  // forecast", and a founder reads those three very differently. So its note is
  // relayed, never replaced with a line of this function's own.
  if (universe.spans.length === 0) {
    const note =
      universe.note !== ''
        ? universe.note
        : 'There was nothing quotable in the internal records this question matched.';
    status({ phase: 'done', detail: note });
    return {
      question,
      text: '',
      sources: docs,
      spans: universe.spans,
      dropped: universe.dropped,
      sentences: [],
      flagged: 0,
      related: [],
      note,
      costCents: 0,
    };
  }

  const written = await writeFromSpans(
    {
      // No rewrite to disclose: the question reaches phase B as it was typed.
      asked: `QUESTION: ${question}`,
      standalone: question,
      // `groundedSpanBlock` and not a local build: it already produces the shape
      // the web path produces, and it is the one place that decides no
      // observation date goes into the prompt. A date beside a quote invites
      // "as of August 2026", whose "2026" is in no cited span — phase C would
      // then flag a sentence for faithfully repeating what we told it.
      spanBlock: groundedSpanBlock(universe),
      spans: universe.spans,
      docs,
    },
    deps,
  );

  return {
    question,
    text: written.text,
    sources: docs,
    spans: universe.spans,
    dropped: universe.dropped,
    sentences: written.sentences,
    flagged: written.flagged,
    related: written.related,
    note: written.note,
    // Phase A was free, so generation and the related pass are the whole bill.
    costCents: written.costCents,
  };
}
