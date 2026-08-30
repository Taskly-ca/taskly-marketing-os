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
 */
import { checkCausalLanguage, checkHonesty } from '@tmos/guardrails';

import type { AttributeLimits, CitableSpan, CitableUniverse, DroppedSpan } from './attribute.js';
import { attribute } from './attribute.js';
import type { DeltaEvent, SentenceEvent, SourceEvent, SpanEvent, StatusEvent } from './events.js';
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
 * Planning, restated rather than imported.
 *
 * `pipeline.ts` keeps its own copy private and is deliberately not edited here:
 * `research()` is Verified mode and must keep behaving exactly as it does
 * today, and a shared constant makes any future tuning of Fast mode's planning
 * a silent change to Verified mode's. Two prompts that are allowed to diverge
 * is the cheaper of the two couplings.
 */
const PLAN_SYSTEM = [
  'You turn a marketing research question into web search queries.',
  'Return JSON: {"queries":["...","..."],"unanswerable":["..."]}',
  '',
  'RULES',
  '- Queries are what a researcher would type, not the question restated.',
  '- Prefer queries that would surface PRIMARY sources: a company page, a',
  '  government statistic, a filing, a job board. Not listicles.',
  '- Vary the angle. Four near-identical queries retrieve one document.',
  '- Put in "unanswerable" any part of the question the open web cannot settle',
  '  (our own revenue, a private company\'s margins, anyone\'s intent).',
].join('\n');

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

/* ── the pipeline ─────────────────────────────────────────────────────────── */

export interface StreamDeps {
  /** Planning and attribution — whole replies, parsed as JSON. */
  readonly ask: AskPort;
  /** Generation only. A separate port on purpose: see `AskStreamPort`. */
  readonly askStream: AskStreamPort;
  readonly search: readonly SearchPort[];
  readonly read: ReadPort;
  readonly limits?: ResearchLimits;
  readonly attributeLimits?: AttributeLimits;
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
  /** Non-empty when there is no answer and the reader is owed the reason. */
  readonly note: string;
  readonly costCents: number;
}

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
  const status = deps.onStatus ?? ((): void => undefined);
  const emitSource = deps.onSource ?? ((): void => undefined);
  const emitSpan = deps.onSpan ?? ((): void => undefined);
  const emitDelta = deps.onDelta ?? ((): void => undefined);
  const emitSentence = deps.onSentence ?? ((): void => undefined);

  let cost = 0;
  const sources: ReadDoc[] = [];
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
      note,
      costCents: cost,
    };
  };

  /* 1 ─ plan */
  status({ phase: 'planning' });
  const planned = await deps.ask.ask(PLAN_SYSTEM, question, 700);
  if (!planned) return stop('The model was unavailable or the budget ceiling refused the call.');
  cost += planned.costCents;
  const plan = parseJson(planned.text);
  queries = strings(plan['queries']).slice(0, limits.maxQueries);
  cannot = strings(plan['unanswerable']);
  if (queries.length === 0) {
    return stop('Could not turn that into a search. Try naming a company, a market or a period.');
  }

  /* 2 ─ search */
  status({ phase: 'searching', detail: queries.join(' · ') });
  const hits: SearchHit[] = [];
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
  const unique = dedupeHits(hits);
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
    return stop('Found results but could not read any of them — refused by robots.txt, or assembled in a browser.');
  }

  /* 4 ─ attribute: prove the quotes before any prose exists */
  status({ phase: 'attributing', detail: `${sources.length} document(s)` });
  const universe = await attribute(question, sources, {
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

  /* 5 ─ generate, splitting and checking as it arrives */
  status({ phase: 'writing' });
  const known = new Set(universe.spans.map((s) => s.id));
  const splitter = new SentenceSplitter();
  const gate = new MarkerGate((id) => known.has(id));
  const sentences: SentenceEvent[] = [];
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
      const verdict = checkSentence(c.n, c.text, universe.spans);
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

  const spans = universe.spans
    .map((s) => `[${s.id}] (source ${s.docIndex} — ${sources[s.docIndex - 1]?.title ?? ''})\n"${s.span}"`)
    .join('\n\n');

  const written = await deps.askStream.askStream(
    GEN_SYSTEM,
    `QUESTION: ${question}\n\nSPANS — the only things you may cite:\n\n${spans}`,
    GEN_MAX_TOKENS,
    feed,
  );

  // A refused or dead call is not a short answer. `AskStreamPort` says the
  // deltas are a side channel and the returned result is the answer, and the
  // reason is exactly this branch: a half-answer reads like a whole one, and
  // flushing the splitter here would hand a truncated fragment to the checker,
  // which would then stamp a verdict on a sentence the model never finished.
  if (!written) {
    return {
      ...stop('The answer stopped part-way — the model call failed or the budget ceiling refused it.', universe),
      text: shown,
      sentences,
      flagged: sentences.filter((s) => s.verdict === 'flagged').length,
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
  status({ phase: 'done', detail: `${sentences.length} sentence(s), ${flagged} flagged` });

  return {
    question,
    text: shown,
    sources,
    spans: universe.spans,
    dropped: universe.dropped,
    sentences,
    flagged,
    queries,
    unanswered: cannot,
    note,
    costCents: cost,
  };
}
