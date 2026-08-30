/**
 * The splitter, tested harder than anything else in this package — because a
 * boundary in the wrong place does not degrade the answer, it MISDIRECTS the
 * verdict. A badge that says "confirmed" while sitting on a sentence the check
 * never saw is worse than no badge at all, and every case below is a real shape
 * of prose that would produce exactly that.
 *
 * Two invariants are asserted repeatedly rather than once: that the pieces
 * concatenate back to the input (nothing is lost at a seam) and that feeding
 * the same text one character at a time produces the identical split (the
 * chunk boundary is not a boundary). The second is the one that fails first in
 * a naive implementation, and it is the only one the real stream exercises.
 */
import { describe, expect, it } from 'vitest';

import { SentenceSplitter, splitSentences } from './sentences.js';

/** Feed in arbitrary chunks and report everything the splitter produced. */
function drive(chunks: readonly string[]): { text: string; sentences: string[]; tags: number[] } {
  const s = new SentenceSplitter();
  let text = '';
  const sentences: string[] = [];
  const tags: number[] = [];
  for (const c of chunks) {
    const out = s.push(c);
    for (const p of out.pieces) {
      text += p.text;
      tags.push(p.n);
    }
    for (const k of out.closed) sentences[k.n] = k.text;
  }
  const end = s.end();
  for (const p of end.pieces) {
    text += p.text;
    tags.push(p.n);
  }
  for (const k of end.closed) sentences[k.n] = k.text;
  return { text, sentences, tags };
}

const chars = (s: string): string[] => [...s];

describe('splitSentences — the ordinary cases', () => {
  it('splits on a period followed by a capital', () => {
    expect(splitSentences('Jiffy operates in Toronto. Their rate is $89.')).toEqual([
      'Jiffy operates in Toronto.',
      'Their rate is $89.',
    ]);
  });

  it('splits on ? and ! and an ellipsis, and keeps the mark with its sentence', () => {
    expect(splitSentences('Is that right? It is! Wait… Then it grew.')).toEqual([
      'Is that right?',
      'It is!',
      'Wait…',
      'Then it grew.',
    ]);
  });

  it('closes an unterminated final sentence rather than dropping it', () => {
    // A truncated stream is a fact about the run. Swallowing the fragment would
    // hide the truncation; emitting it lets the check flag it like any other.
    expect(splitSentences('The market grew. Ottawa was not covered')).toEqual([
      'The market grew.',
      'Ottawa was not covered',
    ]);
  });

  it('treats a paragraph break as ordinary whitespace, not a second boundary', () => {
    expect(splitSentences('First point.\n\nSecond point.')).toEqual(['First point.', 'Second point.']);
  });
});

describe('splitSentences — the periods that are NOT sentence ends', () => {
  it('does not split inside a decimal or a version number', () => {
    expect(splitSentences('The rate rose 3.5 points to 15.2% this year.')).toEqual([
      'The rate rose 3.5 points to 15.2% this year.',
    ]);
  });

  it('does not split on a company suffix', () => {
    expect(splitSentences('Acme Inc. announced a raise. Ottawa followed.')).toEqual([
      'Acme Inc. announced a raise.',
      'Ottawa followed.',
    ]);
  });

  it('does not split on a company suffix even when the next word is capitalised', () => {
    // The hard one: only the word BEFORE the period says this is not an end.
    expect(splitSentences('The buyer was Acme Inc. Toronto stayed flat.')).toEqual([
      'The buyer was Acme Inc. Toronto stayed flat.',
    ]);
  });

  it('does not split on e.g. or i.e. before a capitalised place', () => {
    expect(splitSentences('It runs in two cities, e.g. Toronto and Ottawa.')).toEqual([
      'It runs in two cities, e.g. Toronto and Ottawa.',
    ]);
    expect(splitSentences('One market, i.e. Ontario, was measured.')).toEqual([
      'One market, i.e. Ontario, was measured.',
    ]);
  });

  it('does not split on an initialism or a lone initial', () => {
    expect(splitSentences('The U.S. Census Bureau published it.')).toEqual([
      'The U.S. Census Bureau published it.',
    ]);
    expect(splitSentences('Written by J. R. Smith last year.')).toEqual([
      'Written by J. R. Smith last year.',
    ]);
  });

  it('splits "$1.5m." before a capital and keeps it before a lowercase word', () => {
    // Both readings of the same three characters, and the following word is the
    // only thing that distinguishes them.
    expect(splitSentences('It raised $1.5m. Growth followed.')).toEqual([
      'It raised $1.5m.',
      'Growth followed.',
    ]);
    expect(splitSentences('It raised $1.5m. in the third quarter.')).toEqual([
      'It raised $1.5m. in the third quarter.',
    ]);
  });

  it('does not split on a numbered list marker at the start of a line', () => {
    expect(splitSentences('1. First finding here. 2. Second finding.')).toEqual([
      '1. First finding here.',
      '2. Second finding.',
    ]);
  });

  it('still splits after a four-digit year, which is not a list marker', () => {
    expect(splitSentences('The peak was in 2024. The market then cooled.')).toEqual([
      'The peak was in 2024.',
      'The market then cooled.',
    ]);
  });
});

describe('splitSentences — quotes and citation markers', () => {
  it('keeps a closing quotation mark with the sentence it closes', () => {
    expect(splitSentences('He said "it works." Then it grew.')).toEqual([
      'He said "it works."',
      'Then it grew.',
    ]);
  });

  it('keeps a marker glued to the period with the sentence that wrote it', () => {
    // If `[1]` drifted to the next sentence, sentence 0 would be checked as
    // uncited and sentence 1 against a span it never cited — two wrong verdicts
    // from one misplaced boundary.
    expect(splitSentences('Toronto grew.[1] Ottawa did not.[2]')).toEqual([
      'Toronto grew.[1]',
      'Ottawa did not.[2]',
    ]);
  });

  it('leaves a marker written before the period where it is', () => {
    expect(splitSentences('Toronto grew [1]. Ottawa did not [2].')).toEqual([
      'Toronto grew [1].',
      'Ottawa did not [2].',
    ]);
  });
});

describe('the streaming invariants', () => {
  const CASES = [
    'Jiffy operates in Toronto. Their rate is $89 per visit.',
    'The buyer was Acme Inc. Toronto stayed flat. It raised $1.5m. Growth followed.',
    'Toronto grew.[1] Ottawa did not [2]. The U.S. Census Bureau disagrees.',
    'He said "it works." Then it grew 15.2% e.g. in Ontario.',
    'One sentence with no terminator at all',
  ];

  it('a character-at-a-time stream splits identically to the whole string', () => {
    for (const text of CASES) {
      expect(drive(chars(text)).sentences, text).toEqual(splitSentences(text));
    }
  });

  it('splits identically no matter where the chunk edges fall', () => {
    for (const text of CASES) {
      const whole = splitSentences(text);
      for (let cut = 1; cut < text.length; cut += 1) {
        const parts = [text.slice(0, cut), text.slice(cut)];
        expect(drive(parts).sentences, `${text} @${cut}`).toEqual(whole);
      }
    }
  });

  it('is lossless: the pieces concatenate back to the input exactly', () => {
    for (const text of CASES) {
      expect(drive(chars(text)).text).toBe(text);
      expect(drive([text]).text).toBe(text);
    }
  });

  it('never lets a sentence index go backwards', () => {
    for (const text of CASES) {
      const { tags } = drive(chars(text));
      for (let i = 1; i < tags.length; i += 1) {
        expect(tags[i]).toBeGreaterThanOrEqual(tags[i - 1] as number);
      }
    }
  });

  it('tags every piece of a sentence that arrives in many chunks with one index', () => {
    // The delta-tagging case the wire contract exists for: one sentence, twelve
    // chunks, and the client must be able to accumulate them under one key.
    const { tags, sentences } = drive(['Jiffy ', 'operates ', 'in ', 'Tor', 'onto', '.', ' Then', ' it', ' grew', '.']);
    expect(sentences).toEqual(['Jiffy operates in Toronto.', 'Then it grew.']);
    expect(new Set(tags)).toEqual(new Set([0, 1]));
  });

  it('holds back rather than guessing when the deciding character has not arrived', () => {
    // After ". " nothing may be emitted as a boundary yet: the next chunk could
    // be "Growth" (two sentences) or "in Q3" (one).
    const s = new SentenceSplitter();
    s.push('It raised $1.5m');
    const mid = s.push('. ');
    expect(mid.closed).toEqual([]);
    expect(s.push('in Q3.').closed).toEqual([]);
    expect(s.end().closed).toEqual([{ n: 0, text: 'It raised $1.5m. in Q3.' }]);
  });
});
