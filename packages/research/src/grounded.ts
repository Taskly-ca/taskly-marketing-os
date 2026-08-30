/**
 * PHASE A, FOR OUR OWN EVIDENCE — the citable universe without a model in it.
 *
 * `attribute.ts` spends a model call because a fetched web page is 20,000
 * characters of undifferentiated text and something has to point at the
 * sentence that answers the question. The pass proposes; the substring check
 * disposes. That is the right shape for the web and it is the wrong shape here.
 *
 * ── WHY THERE IS NO MODEL PASS IN THIS FILE ────────────────────────────────
 *
 * **Internal evidence arrives already proven.** Every row in the world model
 * carries `evidence.snippet` — the exact sentence the value was read from — and
 * the URL it was on, stamped with the date we read it. A `finding` carries
 * `evidence[0].span` and `source_url` and has already survived L0's adversarial
 * verifier, which asserts every number and date in the claim appears verbatim
 * in that span. A Brain chunk is a verbatim slice of a document we wrote.
 *
 * The span already exists, it was checked when it was written, and no model
 * needs to propose it. Running one here would let it re-word a stored sentence
 * on the way past — re-introducing exactly the fabrication risk the stored
 * evidence had already eliminated, and paying for the privilege. So the
 * grounded universe is a **selection** problem: the caller retrieves (this
 * package stays DB-free), and this file decides what survives, in what order,
 * and what a reader is told about each piece.
 *
 * The check that remains is smaller but real: a Brain passage narrowed by the
 * caller is string-matched against the chunk it claims to come from, because
 * that is the one place a narrowing happens and therefore the one place a span
 * can be stitched together from text that was never adjacent.
 *
 * ── WHAT SHAPE COMES OUT, AND WHY IT MATTERS ───────────────────────────────
 *
 * A `GroundedUniverse` **is** a `CitableUniverse`. `GroundedSpan` extends
 * `CitableSpan` with the metadata internal evidence has and a web page does
 * not. That is the whole point of the design: phase B and phase C in
 * `stream.ts` — the generation prompt, the marker gate, `checkSentence` — run
 * over either universe unchanged, because neither ever asked where a span came
 * from. Only the renderer and the reader care, and both are served by the extra
 * fields rather than by a second pipeline.
 */
import type { AttributeLimits, CitableSpan, CitableUniverse, DroppedSpan } from './attribute.js';
import { DEFAULT_ATTRIBUTE_LIMITS } from './attribute.js';
import type { SourceEvent, SourceKind, SpanEvent } from './events.js';
import type { ReadDoc } from './types.js';
import { normalise } from './verify.js';

/* ── what the caller hands over ───────────────────────────────────────────── */

/**
 * What a Brain document of a given status is allowed to do in an answer.
 *
 * Mirrors `groundingRightFor` in `@tmos/contracts` — deliberately re-declared
 * rather than imported, because `@tmos/research` does not depend on
 * `@tmos/contracts` and adding the dependency is a `pnpm-lock.yaml` change,
 * which is a locked, serial edit. The caller already computed this value during
 * retrieval; this file only enforces it.
 */
export type BrainGroundingRight = 'grounds' | 'corroborates' | 'context_only' | 'never_retrieved';

interface GroundedRecordBase {
  /** The row this came from. Diagnostic only — never rendered as a citation,
   *  because a uuid is not something a reader can check. */
  readonly id: string;
  /** What the source card says. The caller composes it: only they know whether
   *  `entity + predicate` reads better than the document's own title. */
  readonly title: string;
}

/**
 * One value read off somebody's page, with the sentence it was read from.
 *
 * `observedAt` is required and separate from any in-world date: `FactRow`
 * distinguishes "when this became true" from "when we looked", and the second
 * is what a reader needs to judge the evidence.
 */
export interface GroundedWorldFact extends GroundedRecordBase {
  readonly type: 'world_fact';
  readonly url: string;
  /** `evidence.snippet` — the sentence the extractor read the value out of. */
  readonly snippet: string;
  readonly observedAt: string;
}

/**
 * A finding's EVIDENCE, never a finding's claim.
 *
 * The distinction is the reason this type carries `span` and not `claim`. A
 * finding's `claim` is our own paraphrase of what a page said, and citing it
 * would present a conclusion as though it were an observation — the reader
 * would see a badge that means "verbatim on a page" attached to a sentence we
 * wrote. `evidence[0].span` is the page's own words, and it is what L0 checked.
 */
export interface GroundedFinding extends GroundedRecordBase {
  readonly type: 'finding';
  readonly sourceUrl: string;
  readonly span: string;
  readonly observedAt: string;
  /** Set when `superseded_by` is non-null. A correction supersedes a finding
   *  precisely when we decided it was wrong; its span may be misattributed as
   *  well as its claim, so it is refused rather than quietly reused. */
  readonly superseded?: boolean;
}

/**
 * A verbatim slice of a document we wrote.
 *
 * `right` is required and has no default. A missing grounding right would have
 * to default to something, and every safe default silently launders a draft
 * into evidence the first time a caller forgets the field. Making it required
 * moves the failure to compile time, where it is free.
 */
export interface GroundedBrainPassage extends GroundedRecordBase {
  readonly type: 'brain_passage';
  /** Vault-relative, e.g. `20-architecture/SYSTEM.md`. */
  readonly path: string;
  /** The heading path, so the citation names a section and not just a file.
   *  "It says so in SYSTEM.md" is not checkable in one glance; a section is. */
  readonly heading?: string;
  /** The chunk body as stored. */
  readonly text: string;
  /** A narrower quote out of `text`, when the caller knows which sentence
   *  matched. Checked against `text` — see `bindGrounded`. */
  readonly span?: string;
  readonly right: BrainGroundingRight;
  /** `YYYY-MM-DD`, the day someone last checked the document against the code.
   *  The closest honest analogue of "observed at" a written document has. */
  readonly reviewed?: string | null;
}

/** A row in the prediction ledger. Carried, and — see `bindGrounded` — never
 *  turned into a span. */
export interface GroundedForecast extends GroundedRecordBase {
  readonly type: 'forecast';
  readonly locator: string;
  readonly claim: string;
  /** The probability we put on it. Never 0 or 1 by contract. */
  readonly p: number;
  readonly resolveAt: string;
}

export type GroundedRecord =
  | GroundedWorldFact
  | GroundedFinding
  | GroundedBrainPassage
  | GroundedForecast;

/* ── what comes out ───────────────────────────────────────────────────────── */

/** A `CitableSpan` plus what a reader needs to weigh it. `url` holds a locator
 *  that is NOT a link for a Brain passage; `kind` is what says which. */
export interface GroundedSpan extends CitableSpan {
  readonly kind: SourceKind;
  readonly recordId: string;
  readonly title: string;
  /** Absent only where the record genuinely has no date. Never dropped to make
   *  a run look uniformly fresh. */
  readonly observedAt?: string;
}

/** One source card. Sources are distinct **observations**, not distinct URLs —
 *  see the keying note in `bindGrounded`. */
export interface GroundedSource {
  readonly i: number;
  readonly locator: string;
  readonly title: string;
  readonly kind: SourceKind;
  readonly observedAt?: string;
}

/**
 * A forecast, rendered as what it is.
 *
 * It is NOT a `DroppedSpan`: dropped means "this could have been evidence and
 * failed a check", and a forecast never entered that contest. Keeping the two
 * lists apart is what stops the UI from showing an expectation under a heading
 * that means "refused".
 */
export interface Expectation {
  readonly id: string;
  readonly locator: string;
  readonly title: string;
  readonly claim: string;
  readonly p: number;
  readonly resolveAt: string;
}

export interface GroundedUniverse extends CitableUniverse {
  readonly spans: readonly GroundedSpan[];
  readonly sources: readonly GroundedSource[];
  /** What we expect, at a probability. Surfaced beside the answer and NEVER
   *  pasted into phase B's prompt. */
  readonly expectations: readonly Expectation[];
}

export interface BoundGrounded {
  readonly spans: GroundedSpan[];
  readonly dropped: DroppedSpan[];
  readonly sources: GroundedSource[];
  readonly expectations: Expectation[];
}

/* ── selection ────────────────────────────────────────────────────────────── */

/** Kept short: a refusal record exists to be read, not to echo a chunk back. */
const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** For `world` the locator is a real page and the hostname is the useful label.
 *  For `brain` events.ts asks for the origin in words, not a fabricated host. */
const domainFor = (kind: SourceKind, locator: string): string => {
  if (kind !== 'web' && kind !== 'world') return kind === 'brain' ? 'brain' : 'ledger';
  try {
    return new URL(locator).hostname.replace(/^www\./, '');
  } catch {
    return locator;
  }
};

/** What a record contributes, before any check has run. */
interface Candidate {
  readonly kind: SourceKind;
  readonly locator: string;
  readonly span: string;
  /** Present only where a narrowing happened and can therefore be checked. */
  readonly against?: string;
  readonly observedAt?: string;
}

const brainLocator = (r: GroundedBrainPassage): string =>
  r.heading && r.heading.trim() !== '' ? `${r.path} § ${r.heading.trim()}` : r.path;

/**
 * Choose what survives, and say why about everything that did not.
 *
 * Checks run in cost order, and each exists for a named failure:
 *
 *  1. **A forecast is diverted, not tested.** See `Expectation`, and the
 *     paragraph below on why it is not citable at all.
 *  2. **The Brain trust ladder.** `context_only` is a draft — somebody thinking
 *     out loud — and letting one be cited is the fastest way to launder a guess
 *     into a stated fact. `never_retrieved` is a document the company has
 *     already decided is wrong. Both are refused here rather than filtered
 *     upstream, so the rule holds even if a caller's retrieval forgets it.
 *  3. **A superseded finding.** Fail closed: we corrected it because it was
 *     wrong about something.
 *  4. **Empty evidence.** A row with no snippet was never citable. This is the
 *     common shape of a fact written by an extractor that lost its source text,
 *     and it must not become a citation with an empty hover card.
 *  5. **A narrowed Brain span must be inside its chunk.** The only mechanical
 *     check left, and it earns its place: a caller assembling a "quote" from
 *     two non-adjacent sentences produces a sentence the document does not
 *     contain, and nothing downstream would ever notice.
 *  6. **The length floor and cap, shared with the web path.** `minSpanChars`
 *     and `maxSpanChars` come from `DEFAULT_ATTRIBUTE_LIMITS` rather than being
 *     restated, so grounded mode cannot admit a span the web path refuses. The
 *     cap matters for the same reason it does there: phase C's number check
 *     degrades to nothing as a span grows, since a span the length of a page
 *     contains every figure on it and would "confirm" any sentence.
 *
 *     An over-long passage is **dropped, not trimmed**. Trimming would make
 *     this module decide which half of a document the reader sees, and a quote
 *     that stops before its qualification says something the document does not.
 *     The caller ran the retrieval and knows which sentence matched; the reason
 *     string tells them to narrow it.
 *  7. **Duplicates**, per locator. The same sentence twice is one citation; the
 *     same sentence from two locators is corroboration and both are kept —
 *     matching `bindSpans` exactly.
 *  8. **Capacity, last**, so a refused record never consumes a slot a good one
 *     could have had.
 *
 * ── ORDER IS THE CALLER'S ──────────────────────────────────────────────────
 *
 * Records are considered in the order supplied, and the cap truncates the tail.
 * Only the caller ran the retrieval, so only the caller knows what is relevant.
 * Re-sorting by recency here would look like a kindness and would be a policy —
 * "six weeks is too old" is a call nobody has made, and making it silently
 * inside a selection function is how a fact disappears without a trace.
 *
 * ── STALENESS IS ON THE SOURCE CARD, WHICH IS WHY SOURCES ARE OBSERVATIONS ──
 *
 * `SpanEvent` on the wire is `{id, sourceIndex, quote}` — it has nowhere to put
 * a date, and `events.ts` is a frozen contract. `SourceEvent` has `observedAt`.
 * So a source is keyed by **locator AND date**: the same competitor page read
 * in June and again today becomes two cards, because it is two observations and
 * one card would have to put a single date on evidence that has two. Two spans
 * off one observation share one card, as they should.
 *
 * ── WHY NO HONESTY GATE ON A SPAN ──────────────────────────────────────────
 *
 * A span is quoted text: a competitor's page making a screening or insurance
 * claim about its own workers is them making it, not us. `checkHonesty` runs
 * where it belongs — on the prose phase C checks, which is the point at which a
 * banned phrase stops being a quotation and becomes our claim.
 */
export function bindGrounded(
  records: readonly GroundedRecord[],
  limits: AttributeLimits = DEFAULT_ATTRIBUTE_LIMITS,
): BoundGrounded {
  const spans: GroundedSpan[] = [];
  const dropped: DroppedSpan[] = [];
  const sources: GroundedSource[] = [];
  const expectations: Expectation[] = [];

  const seen = new Set<string>();
  const sourceIndex = new Map<string, number>();

  for (const record of records) {
    // 1 ─ a forecast is what we expect, not something we measured.
    if (record.type === 'forecast') {
      expectations.push({
        id: record.id,
        locator: record.locator,
        title: record.title,
        claim: record.claim,
        p: record.p,
        resolveAt: record.resolveAt,
      });
      continue;
    }

    // 2, 3 ─ the trust ladders, before any string work.
    if (record.type === 'brain_passage') {
      if (record.right === 'context_only') {
        dropped.push({
          span: clip(record.span ?? record.text),
          why: `${brainLocator(record)} is unreviewed thinking and may not be cited as evidence — it may inform phrasing and nothing more`,
        });
        continue;
      }
      if (record.right === 'never_retrieved') {
        dropped.push({
          span: clip(record.span ?? record.text),
          why: `${record.path} has been superseded — answering from a document the company has already decided is wrong is worse than answering short`,
        });
        continue;
      }
    }
    if (record.type === 'finding' && record.superseded === true) {
      dropped.push({
        span: clip(record.span),
        why: 'the finding this quote belongs to was superseded by a correction, so its attribution is no longer something we stand behind',
      });
      continue;
    }

    const candidate = toCandidate(record);

    // 4 ─ nothing to quote.
    const span = normalise(candidate.span);
    if (span === '') {
      dropped.push({
        span: `${record.type} ${record.id}`,
        why: 'the record carried no stored evidence — a row with no snippet was never citable, and an empty hover card is worse than no citation',
      });
      continue;
    }

    // 5 ─ a narrowing is the one place a check is still possible.
    if (candidate.against !== undefined && !normalise(candidate.against).includes(span)) {
      dropped.push({
        span: clip(span),
        why: `does not appear in the passage it names (${candidate.locator}) — a quote assembled out of text that was never adjacent`,
      });
      continue;
    }

    // 6 ─ the floor and the cap, shared with the web path.
    if (span.length < limits.minSpanChars) {
      dropped.push({
        span,
        why: `too short to be evidence (under ${limits.minSpanChars} characters)`,
      });
      continue;
    }
    if (span.length > limits.maxSpanChars) {
      dropped.push({
        span: clip(span),
        why: `longer than a citation anyone reads (${span.length} characters, cap ${limits.maxSpanChars}) — supply a narrower span, since trimming it here would decide for the reader which half of the passage they see`,
      });
      continue;
    }

    // 7 ─ duplicates, per locator.
    const key = `${candidate.locator} ${span}`;
    if (seen.has(key)) {
      dropped.push({ span: clip(span), why: `already in the universe from ${candidate.locator}` });
      continue;
    }

    // 8 ─ capacity last.
    if (spans.length >= limits.maxSpans) {
      dropped.push({
        span: clip(span),
        why: `the universe is capped at ${limits.maxSpans} spans and was already full`,
      });
      continue;
    }
    seen.add(key);

    const cardKey = `${candidate.locator}@${candidate.observedAt ?? ''}`;
    let docIndex = sourceIndex.get(cardKey);
    if (docIndex === undefined) {
      docIndex = sources.length + 1;
      sourceIndex.set(cardKey, docIndex);
      sources.push({
        i: docIndex,
        locator: candidate.locator,
        title: record.title,
        kind: candidate.kind,
        ...(candidate.observedAt !== undefined ? { observedAt: candidate.observedAt } : {}),
      });
    }

    spans.push({
      id: spans.length + 1,
      docIndex,
      url: candidate.locator,
      span,
      kind: candidate.kind,
      recordId: record.id,
      title: record.title,
      ...(candidate.observedAt !== undefined ? { observedAt: candidate.observedAt } : {}),
    });
  }

  return { spans, dropped, sources, expectations };
}

/**
 * Flatten one record to the four things selection cares about.
 *
 * A finding is `world`, not `web`: `events.ts` reserves `web` for a page
 * fetched THIS run, and a finding's page was read on `observedAt`, possibly
 * months ago. Its URL is still openable and is still emitted — what changes is
 * the promise the badge makes.
 */
function toCandidate(
  record: GroundedWorldFact | GroundedFinding | GroundedBrainPassage,
): Candidate {
  switch (record.type) {
    case 'world_fact':
      return {
        kind: 'world',
        locator: record.url,
        span: record.snippet,
        observedAt: record.observedAt,
      };
    case 'finding':
      return {
        kind: 'world',
        locator: record.sourceUrl,
        span: record.span,
        observedAt: record.observedAt,
      };
    default: {
      const narrowed = record.span !== undefined && record.span.trim() !== '';
      return {
        kind: 'brain',
        locator: brainLocator(record),
        span: narrowed ? (record.span ?? '') : record.text,
        ...(narrowed ? { against: record.text } : {}),
        ...(record.reviewed ? { observedAt: record.reviewed } : {}),
      };
    }
  }
}

/**
 * Build the citable universe for one question over records the caller retrieved.
 *
 * Synchronous, and `costCents` is 0 — not an oversight but the headline: phase
 * A over our own evidence spends nothing, because the spans were written down
 * the day they were verified.
 */
export function groundedUniverse(
  question: string,
  records: readonly GroundedRecord[],
  limits: AttributeLimits = DEFAULT_ATTRIBUTE_LIMITS,
): GroundedUniverse {
  const bound = bindGrounded(records, limits);

  // An empty universe is a legitimate outcome and must be stated as one — the
  // alternative, letting phase B write anyway, is the plain-LLM failure this
  // package exists to prevent. The three cases read differently to a founder:
  // "we hold nothing on this" is not "we hold things and none can be quoted",
  // and neither is "all we have is a forecast".
  let note = '';
  if (bound.spans.length === 0) {
    if (records.length === 0) {
      note =
        'Nothing in the world model, the Brain or the ledger matched that question — this run had no internal records to answer from.';
    } else if (bound.expectations.length > 0 && bound.dropped.length === 0) {
      note =
        'All that matched was the prediction ledger. What we expect is listed below; nothing here is an observation, so there is no answer to write.';
    } else {
      note = 'The internal records that matched carried nothing quotable for this question.';
    }
  }

  return {
    question,
    spans: bound.spans,
    dropped: bound.dropped,
    sources: bound.sources,
    expectations: bound.expectations,
    note,
    costCents: 0,
  };
}

/* ── projections: what the streaming phases consume ───────────────────────── */

/**
 * The universe as `ReadDoc[]`, indexed so `spans[i].docIndex - 1` addresses it.
 *
 * `stream.ts` builds its prompt block and calls `relatedQuestions` against a
 * `ReadDoc[]`; handing it one lets the grounded path reuse both without a line
 * changing there. `text` is the stored evidence for that source and nothing
 * else — we do not hold the page, and inventing a body would make this doc look
 * like something a substring check could run against.
 */
export function groundedDocs(u: GroundedUniverse): ReadDoc[] {
  return u.sources.map((s) => ({
    url: s.locator,
    title: s.title,
    text: u.spans
      .filter((span) => span.docIndex === s.i)
      .map((span) => span.span)
      .join(' '),
  }));
}

/** Source cards, carrying `kind` and the observation date the wire contract
 *  added for exactly this path. */
export function groundedSourceEvents(u: GroundedUniverse): SourceEvent[] {
  return u.sources.map((s) => ({
    i: s.i,
    url: s.locator,
    title: s.title,
    domain: domainFor(s.kind, s.locator),
    kind: s.kind,
    ...(s.observedAt !== undefined ? { observedAt: s.observedAt } : {}),
  }));
}

export function groundedSpanEvents(u: GroundedUniverse): SpanEvent[] {
  return u.spans.map((s) => ({ id: s.id, sourceIndex: s.docIndex, quote: s.span }));
}

/**
 * The numbered span list phase B writes from — the same shape `stream.ts`
 * builds for the web path, so `GEN_SYSTEM` needs no grounded variant.
 *
 * **No dates in here, deliberately.** Putting "observed 2026-06-01" beside a
 * quote invites "as of June 2026", and that sentence's "2026" appears in no
 * cited span — so `checkSentence` would flag a sentence for faithfully
 * repeating something we told it. Dates belong on the source card, where the
 * reader sees them and the number check never looks.
 *
 * Forecasts are absent for the reason in `Expectation`: the prompt tells the
 * model each span is something already proved, and a forecast is not. Handed
 * one, it would write our expectation as a measurement and phase C would
 * confirm it — the number is genuinely in the span. The only place that can be
 * prevented is here, by never letting it in.
 */
export function groundedSpanBlock(u: GroundedUniverse): string {
  return u.spans
    .map((s) => {
      const source = u.sources[s.docIndex - 1];
      return `[${s.id}] (source ${s.docIndex} — ${source?.title ?? ''})\n"${s.span}"`;
    })
    .join('\n\n');
}
