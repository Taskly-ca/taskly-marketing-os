/**
 * WHERE ONE SENTENCE ENDS — the single decision the whole wire contract rests on.
 *
 * `events.ts` explains why the SERVER owns this: a verdict is addressed to a
 * sentence INDEX, so if the splitter here and a splitter in the browser ever
 * disagreed about "Inc." the badge would land on the wrong sentence — marking a
 * checked claim unchecked, or worse, an unchecked one confirmed. There is
 * exactly one splitter in the system and it is this file. The client never
 * splits anything; it only concatenates the text it is handed, per index.
 *
 * ── WHY THIS IS HARDER THAN A REGEX ────────────────────────────────────────
 *
 * The text arrives in arbitrary chunks from a token stream, so the character
 * that decides a boundary routinely has not been generated yet. `"...Jiffy Inc"`
 * plus `". Their rate"` is one sentence; `"...in Toronto"` plus `". Their rate"`
 * is two, and the two look identical until the chunk after the period exists.
 * So this splitter is INCREMENTAL and it HOLDS BACK: when a terminator lands at
 * the end of the buffer with nothing after it, the decision is deferred and the
 * text is not emitted. A few characters of latency buys a boundary that is never
 * revised, and a boundary that is never revised is what lets a delta be tagged
 * once and stay tagged.
 *
 * ── THE TWO INVARIANTS, both tested ────────────────────────────────────────
 *
 *  1. **Lossless.** Concatenating every emitted piece, in order, reproduces the
 *     input exactly. Nothing is dropped at a boundary, so a client that
 *     accumulates per index can render the answer verbatim.
 *  2. **Monotonic.** A piece's index never decreases and a closed sentence is
 *     never reopened. The stream is append-only in both directions, which is
 *     what makes an SSE reconnect a replay rather than a reconciliation.
 *
 * Sentence numbers are 0-BASED — `n` is an index into the client's accumulating
 * array, not an identifier the way `SourceEvent.i` and `SpanEvent.id` are.
 */

/** A run of text known to belong to sentence `n`. Emitted as it is decided. */
export interface SentencePiece {
  readonly n: number;
  readonly text: string;
}

/** A sentence that will receive no more text. Trimmed; ready to be checked. */
export interface ClosedSentence {
  readonly n: number;
  readonly text: string;
}

export interface SplitOutput {
  readonly pieces: readonly SentencePiece[];
  readonly closed: readonly ClosedSentence[];
}

const TERMINATORS = new Set(['.', '!', '?', '…']);

/** Punctuation that belongs to the sentence it closes, not the next one. */
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»', '*', '_']);

/**
 * Words whose trailing period is part of the word.
 *
 * Deliberately SHORT. Every entry here trades a false split for a false merge,
 * and both are wrong — so the list carries only tokens that are almost never a
 * real sentence ending in business prose. `no.`, `min.`, `max.` and `may.` were
 * considered and left out: they are ordinary words far more often than they are
 * abbreviations, and merging two real sentences to protect "No. 1" is the worse
 * trade. Stored without the final period, because that period is the character
 * under examination.
 */
const ABBREVIATIONS = new Set([
  'inc', 'ltd', 'llc', 'plc', 'co', 'corp', 'mr', 'mrs', 'ms', 'dr', 'prof',
  'jr', 'sr', 'st', 'ave', 'rd', 'vs', 'etc', 'cf', 'al', 'approx', 'dept',
  'univ', 'est', 'e.g', 'i.e', 'u.s', 'u.k', 'u.s.a', 'a.m', 'p.m',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec',
]);

/** A citation marker sitting flush against the terminator — `...Toronto.[3]` —
 *  belongs to the sentence it was written for, not to the one that follows. Get
 *  this wrong and a sentence is checked against a span it never cited. */
const ATTACHED_MARKER = /^\[\s*\d+(?:\s*,\s*\d+)*\s*\]/;
/** The same marker, still arriving. Distinguishing "not a marker" from "not a
 *  marker YET" is the difference between splitting early and waiting. */
const PARTIAL_MARKER = /^\[[\s\d,]*$/;

/**
 * Consume what is glued to the terminator: closing quotes, brackets, and
 * citation markers. Returns the index after them, or `null` meaning "the buffer
 * ran out mid-decision — hold and ask again with more text".
 */
function consumeAttached(s: string, from: number, final: boolean): number | null {
  let j = from;
  for (;;) {
    while (j < s.length && CLOSERS.has(s.charAt(j))) j += 1;
    if (j >= s.length) return final ? j : null;
    if (s.charAt(j) !== '[') return j;
    const rest = s.slice(j);
    const m = ATTACHED_MARKER.exec(rest);
    if (m) {
      j += m[0].length;
      continue;
    }
    // `[` that is not a marker is ordinary prose and ends the run — unless it
    // is a marker whose closing bracket has not streamed yet.
    if (!final && PARTIAL_MARKER.test(rest)) return null;
    return j;
  }
}

/** The token immediately before the terminator, lower-cased, periods kept so
 *  `e.g` and `u.s` are recognisable as the single tokens they are. */
function trailingToken(before: string): string {
  const m = /([A-Za-z](?:[A-Za-z.]*[A-Za-z])?)$/.exec(before);
  return m ? (m[1] ?? '').toLowerCase() : '';
}

/**
 * Does this terminator actually end a sentence?
 *
 * Each rule names the text it protects:
 *
 *  - **No whitespace after** → `3.5`, `v1.2`, `example.com`. A period wedged
 *    between two non-spaces is punctuation inside a token, never a boundary.
 *    This one rule handles every decimal, which is why decimals need no special
 *    case of their own.
 *  - **Lowercase next** → `Jiffy Inc. operates`, `$1.5m. in revenue`. A new
 *    sentence in generated prose does not start lower-case; a continuation
 *    routinely does.
 *  - **A known abbreviation before** → `e.g. Toronto`, `U.S. Census`, where the
 *    following word IS capitalised and only the word before betrays it.
 *  - **A lone initial before** → `J. R. R.`, and the same shape in `H. Smith`.
 *  - **A bare number at the start of a line** → `1. First finding`, a list
 *    marker. Scoped to line starts so `raised in 2024. The market grew` still
 *    splits, which it must.
 */
function isBoundary(before: string, hasSpace: boolean, next: string | null): boolean {
  if (next !== null && !hasSpace) return false;

  const token = trailingToken(before);
  if (token !== '' && ABBREVIATIONS.has(token)) return false;
  if (/(?:^|[\s(])[A-Z]$/.test(before)) return false;
  if (/(?:^|\n)\s*\d{1,3}$/.test(before)) return false;

  // End of the whole answer: a trailing terminator closes the last sentence.
  if (next === null) return true;
  return !/[a-z,;]/.test(next);
}

/**
 * The splitter itself. One instance per answer; feed it every chunk in order.
 *
 * It is a class rather than a pure function because the held-back buffer, the
 * open sentence's text and the running index are the state that makes the
 * boundary decision correct across chunk edges — the exact state a stateless
 * splitter re-derives from scratch and gets wrong at the seam.
 */
export class SentenceSplitter {
  /** Text seen but deliberately NOT emitted: a boundary decision is pending. */
  private buf = '';
  /** Everything already emitted for the sentence still open. The check input,
   *  and the left-hand context the abbreviation rule needs. */
  private cur = '';
  private idx = 0;

  /** Feed one streamed chunk. */
  push(chunk: string): SplitOutput {
    return this.run(chunk, false);
  }

  /**
   * The stream is over. Resolves the pending decision, closes whatever is open,
   * and guarantees the lossless invariant even for an answer with no final
   * period — a truncated last sentence is still emitted and still checked,
   * because silently dropping it would hide the truncation.
   */
  end(): SplitOutput {
    return this.run('', true);
  }

  private run(chunk: string, final: boolean): SplitOutput {
    const pieces: SentencePiece[] = [];
    const closed: ClosedSentence[] = [];
    const s = this.buf + chunk;
    this.buf = '';
    let start = 0;
    let i = 0;

    const emit = (upto: number): void => {
      if (upto <= start) return;
      const text = s.slice(start, upto);
      start = upto;
      this.cur += text;
      pieces.push({ n: this.idx, text });
    };

    /** Everything up to `i` is definitely sentence `idx`; hold the rest. */
    const hold = (at: number): SplitOutput => {
      emit(at);
      this.buf = s.slice(at);
      return { pieces, closed };
    };

    while (i < s.length) {
      if (!TERMINATORS.has(s.charAt(i))) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < s.length && TERMINATORS.has(s.charAt(j))) j += 1;

      const attached = consumeAttached(s, j, final);
      if (attached === null) return hold(i);
      j = attached;

      let k = j;
      while (k < s.length && /\s/.test(s.charAt(k))) k += 1;
      // The decisive character has not arrived. Holding from the terminator —
      // rather than guessing — is the whole reason boundaries never move.
      if (k >= s.length && !final) return hold(i);

      const next = k < s.length ? s.charAt(k) : null;
      if (!isBoundary(this.cur + s.slice(start, i), k > j, next)) {
        i = j;
        continue;
      }

      // The separating whitespace is emitted with the sentence it follows, so
      // the client's per-index concatenation reproduces the original spacing.
      // The check sees the trimmed text, so it never sees that whitespace.
      emit(k);
      closed.push({ n: this.idx, text: this.cur.trim() });
      this.idx += 1;
      this.cur = '';
      i = k;
    }

    emit(s.length);
    if (final && this.cur.trim() !== '') {
      closed.push({ n: this.idx, text: this.cur.trim() });
      this.idx += 1;
      this.cur = '';
    }
    return { pieces, closed };
  }
}

/** Whole-string convenience, for tests and for text that never streamed. */
export function splitSentences(text: string): string[] {
  const s = new SentenceSplitter();
  const a = s.push(text);
  const b = s.end();
  return [...a.closed, ...b.closed].map((c) => c.text);
}
