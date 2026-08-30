/**
 * PHASE A — THE CITABLE UNIVERSE. Prove the quotes first; write the prose later.
 *
 * `verifyPoints` is the strongest thing this system owns, and it works in the
 * only order a batch pipeline can: generate the whole answer, then refuse the
 * parts the documents cannot carry. Nothing can be shown until everything has
 * been checked, which is fine for a memo and impossible for a first token.
 *
 * "Attribute First, then Generate" (Slobodkin et al., arXiv:2403.17104 — the
 * structure Anthropic's Citations API ships) inverts it. Before a single token
 * of prose exists, one cheap pass extracts candidate VERBATIM spans and numbers
 * them. Every span is proven a substring of its source document here, by string
 * comparison, with no model in the loop for the CHECK. What comes out is a
 * closed set of quotes we already know are real — and phase B, generating from
 * that set alone, cannot cite anything else. **The citation payload is sound by
 * construction rather than sound by inspection**, which is what buys the
 * streaming: there is nothing left to verify about the QUOTE at emit time.
 *
 * What this does NOT buy, said plainly because the UI must not overclaim: prose
 * is a paraphrase of its span, so a sentence can still misrepresent a genuine
 * quote (GPTZero's "second-hand hallucination" — a real source attached to a
 * claim it never made). Phase C's per-sentence number/honesty/causal checks
 * narrow that. Phase A's guarantee is exactly "this quote is real, and it is on
 * the page we say it is". Nothing more.
 *
 * ── THE PROMPT IS SHAPED THE SAME WAY SYNTH_SYSTEM IS, FOR THE SAME REASON ──
 *
 * `pipeline.ts` records that the first live run dropped four of five points
 * because the model wrote the claim it wanted and then produced a span saying
 * the same thing in its own words. Putting `span` first — copy before you
 * conclude — took that run to nine kept, zero dropped. Phase A takes the same
 * medicine one step further: **this pass has no `claim` field at all.** There
 * is nothing for a quote to be bent toward, because at this point in the run no
 * claim exists yet. Copying is the entire job.
 */
import type { AskPort, ReadDoc } from './types.js';
import { normalise } from './verify.js';

/** One quote we have PROVEN is on the page it names. `id` is what phase B
 *  emits as `[N]`; the URL is retrieved, never generated. */
export interface CitableSpan {
  /** 1-based and contiguous. Stable for the life of the universe. */
  readonly id: number;
  /** 1-based index into the run's `ReadDoc[]` — the number the model saw. */
  readonly docIndex: number;
  readonly url: string;
  /** Whitespace-normalised, case preserved. A substring of the doc, checked. */
  readonly span: string;
}

/** A span that did not survive, and why. Never silently discarded: a gate whose
 *  refusals are invisible teaches nobody anything, and a run that refuses most
 *  of its spans is telling you the sources were wrong. */
export interface DroppedSpan {
  readonly span: string;
  readonly why: string;
}

export interface CitableUniverse {
  readonly question: string;
  readonly spans: readonly CitableSpan[];
  readonly dropped: readonly DroppedSpan[];
  /** Empty when the pass ran normally. Set when there is no universe and the
   *  reader is owed the reason — no documents, a refused model call, a corpus
   *  that carried nothing. Phase B must render this instead of writing anyway. */
  readonly note: string;
  readonly costCents: number;
}

export interface AttributeLimits {
  /** Below this a quote is not evidence — it is a fragment that happens to
   *  appear on the page. Mirrors the floor in `verifyPoints`; the two must not
   *  drift, or Fast mode would admit spans Verified mode refuses. */
  readonly minSpanChars: number;
  /**
   * Above this a quote is not a citation. Two reasons, and the second is the
   * load-bearing one: nobody reads a paragraph in a hover card, AND phase C's
   * number check degrades to nothing as the span grows — a span the length of
   * the page contains every figure on it, so it would "confirm" any sentence.
   */
  readonly maxSpanChars: number;
  /** The universe is pasted into phase B's prompt in full, so an unbounded
   *  universe is an unbounded prompt on the run that already costs the most. */
  readonly maxSpans: number;
}

export const DEFAULT_ATTRIBUTE_LIMITS: AttributeLimits = {
  minSpanChars: 12,
  maxSpanChars: 320,
  maxSpans: 24,
};

/** Sized against the caps above — the pass emits copied text and no prose, so
 *  maxSpans × maxSpanChars plus JSON overhead is the whole output budget. Move
 *  one and you must move the other. */
const ATTRIBUTE_MAX_TOKENS = 2_500;

const ATTRIBUTE_SYSTEM = [
  'You extract QUOTES. You do not answer the question and you do not summarise.',
  'Return JSON: {"spans":[{"span":"...","doc":1}]}',
  '',
  'HOW — this is a copying job, not a writing job:',
  '  1. Read the question only to decide which sentences are RELEVANT.',
  '  2. COPY a relevant sentence out of a document character-for-character.',
  '     Keep its punctuation, capitals and figures. Do not join two sentences,',
  '     do not tidy it, do not shorten it, do not translate it.',
  '  3. Put that document\'s number in "doc". Numbers only — you have no URLs.',
  '',
  'PREFER sentences carrying a figure, a date, a price, a name or a claim a',
  'reader could act on. Skip navigation, boilerplate and marketing filler.',
  '',
  'CHECKED MECHANICALLY — every span is string-matched against the document you',
  'cite, so a reconstructed quote costs you the span and gains you nothing:',
  '- A span that is not a character-for-character substring is deleted.',
  '- A span on a document other than the one you cite is deleted.',
  '- Under 12 characters is deleted. Over 320 characters is deleted.',
  '- If a document says nothing relevant, return no span for it. An empty list',
  '  is a correct answer.',
].join('\n');

const parseJson = (text: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** What lands in a `DroppedSpan` when the entry was not even a string. Kept
 *  short — the record exists to be readable, not to echo the model back. */
const preview = (v: unknown): string => {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

interface RawSpan {
  span?: unknown;
  doc?: unknown;
}

export interface BoundSpans {
  readonly spans: CitableSpan[];
  readonly dropped: DroppedSpan[];
}

/**
 * The check. Deterministic, sub-millisecond, no model, no key.
 *
 * This is the cheap half of the trade in §2 of the answer-engine plan: the
 * published version of attribute-first escalates to an NLI model (AutoAIS,
 * Vectara HHEM) for entailment, a forward pass per candidate. We do not need
 * one, because our question is not "does this entail the claim" but "is this
 * string on that page" — and that is `String.includes`.
 *
 * Checks run in cost order and each exists for a named failure:
 *
 *  1. **Shape.** A non-string span or a missing doc number is a malformed reply,
 *     not a citation. Dropped, never patched — guessing which document a
 *     numberless quote belongs to is the system inventing attribution.
 *  2. **The document number must be one we handed over.** The model sees
 *     NUMBERS, never URLs, precisely so that an out-of-range index is
 *     unambiguous: it cannot be a typo of a real source, so it is a fabricated
 *     one. Same reasoning as `bindCitations` in `pipeline.ts`.
 *  3. **Length floor, then cap.** See `AttributeLimits`.
 *  4. **Substring, against the CITED document only.** A model that read a page
 *     will still paraphrase a sentence and present it as a quote. When the text
 *     turns out to be verbatim on a DIFFERENT document we say so in the reason,
 *     because a paraphrase and a misfiled quote are different bugs — but the
 *     span is still dropped. Re-homing it would be this module quietly
 *     rewriting the model's citation and then vouching for the result.
 *  5. **Duplicates**, per document. The same sentence twice is one citation;
 *     the same sentence on two documents is corroboration and both are kept.
 *
 * Whitespace is normalised on both sides and nothing else is. That single
 * transform is what makes substring matching survive line-wrapped HTML text.
 * Case is preserved deliberately — lowering it would let a headline masquerade
 * as body text.
 */
export function bindSpans(
  raw: unknown,
  docs: readonly ReadDoc[],
  limits: AttributeLimits = DEFAULT_ATTRIBUTE_LIMITS,
): BoundSpans {
  const spans: CitableSpan[] = [];
  const dropped: DroppedSpan[] = [];
  if (!Array.isArray(raw)) return { spans, dropped };

  const texts = docs.map((d) => normalise(d.text));
  const seen = new Set<string>();

  for (const item of raw as unknown[]) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as RawSpan;
    const rawSpan: unknown = entry.span;

    if (typeof rawSpan !== 'string' || rawSpan.trim() === '') {
      dropped.push({ span: preview(item), why: 'the entry carried no span to check' });
      continue;
    }
    const span = normalise(rawSpan);

    const n = Number(entry.doc);
    if (!Number.isInteger(n)) {
      dropped.push({ span, why: 'no document number, so there is nothing to check the quote against' });
      continue;
    }
    if (n < 1 || n > docs.length) {
      dropped.push({
        span,
        why: `cited document ${n}, but this run fetched only ${docs.length} document(s) — an index we never handed over is an invented source`,
      });
      continue;
    }

    if (span.length < limits.minSpanChars) {
      dropped.push({ span, why: `too short to be evidence (under ${limits.minSpanChars} characters)` });
      continue;
    }
    if (span.length > limits.maxSpanChars) {
      dropped.push({
        span: preview(span),
        why: `longer than a citation anyone reads (${span.length} characters, cap ${limits.maxSpanChars})`,
      });
      continue;
    }

    if (!texts[n - 1]?.includes(span)) {
      const elsewhere = texts.findIndex((t) => t.includes(span));
      dropped.push({
        span,
        why:
          elsewhere === -1
            ? `does not appear on document ${n} — reconstructed from memory, not copied off the page`
            : `does not appear on document ${n}; the text is on document ${elsewhere + 1}, so the quote is real and the attribution is wrong`,
      });
      continue;
    }

    const key = `${n} ${span}`;
    if (seen.has(key)) {
      dropped.push({ span, why: `already in the universe from document ${n}` });
      continue;
    }

    // Capacity is checked LAST so a refused span never consumes a slot a good
    // one could have had.
    if (spans.length >= limits.maxSpans) {
      dropped.push({ span, why: `the universe is capped at ${limits.maxSpans} spans and was already full` });
      continue;
    }

    seen.add(key);
    const doc = docs[n - 1];
    if (!doc) continue;
    spans.push({ id: spans.length + 1, docIndex: n, url: doc.url, span });
  }

  return { spans, dropped };
}

export interface AttributeDeps {
  readonly ask: AskPort;
  readonly limits?: AttributeLimits;
  /** Progress for a UI that is watching. Never the transport for results. */
  readonly onStep?: (line: string) => void;
}

/**
 * Build the citable universe for one question over the documents this run read.
 *
 * The model proposes; this function disposes. Its only power is to point at
 * text — every span it names is then proven, and an unproven one is reported
 * rather than removed. That asymmetry is the reason a cheap fast model is safe
 * here: the worst a bad extraction pass can do is produce a small universe, and
 * a small universe produces a short answer. It cannot produce a false one.
 */
export async function attribute(
  question: string,
  docs: readonly ReadDoc[],
  deps: AttributeDeps,
): Promise<CitableUniverse> {
  const limits = deps.limits ?? DEFAULT_ATTRIBUTE_LIMITS;
  const say = deps.onStep ?? ((): void => undefined);

  const nothing = (note: string, costCents = 0): CitableUniverse => ({
    question, spans: [], dropped: [], note, costCents,
  });

  // Refuse to spend a call on an empty corpus. The caller reaching here with no
  // documents is the read stage having been refused by robots or having found
  // only browser-assembled pages — a real outcome, and one the model cannot fix.
  if (docs.length === 0) return nothing('No documents to attribute against — nothing was read this run.');

  say(`attributing over ${docs.length} document(s)…`);

  // Titles and numbers only. `pipeline.ts` includes each URL in its synthesis
  // corpus because the model there writes a claim and the publisher is part of
  // judging it; a copying pass needs none of that, and a URL in the prompt is a
  // source the model can name without having read it — which is exactly the
  // signal the numbering scheme exists to preserve.
  const corpus = docs.map((d, i) => `[${i + 1}] ${d.title}\n${d.text}`).join('\n\n---\n\n');

  const reply = await deps.ask.ask(
    ATTRIBUTE_SYSTEM,
    `QUESTION: ${question}\n\nDOCUMENTS:\n\n${corpus}`,
    ATTRIBUTE_MAX_TOKENS,
  );
  if (!reply) return nothing('The model was unavailable or the budget ceiling refused the call.');

  const { spans, dropped } = bindSpans(parseJson(reply.text)['spans'], docs, limits);
  say(`${spans.length} span(s) proven, ${dropped.length} refused`);

  return {
    question,
    spans,
    dropped,
    // An empty universe is a legitimate answer and must be stated as one. The
    // alternative — letting phase B generate against nothing — is precisely the
    // plain-LLM failure this whole package exists to prevent.
    note:
      spans.length === 0
        ? 'The documents carried nothing quotable for this question.'
        : '',
    costCents: reply.costCents,
  };
}
