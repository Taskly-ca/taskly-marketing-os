/**
 * Turning a fetched page into text a citation can survive.
 *
 * The rule under test is not cosmetic. A span is only citable if the string the
 * model reads, the string the substring check runs against, and the string a
 * reader sees are all the same — so anything that rewrites document text has to
 * happen here, once, before any of those three.
 */
import { describe, expect, it } from 'vitest';

import { titleOf, toText } from './read.js';

describe('toText', () => {
  it('strips markup, scripts and styles', () => {
    const html = '<p>Hello</p><script>var a = "<b>no</b>";</script><style>p{color:red}</style><p>world</p>';
    expect(toText(html)).toBe('Hello world');
  });

  it('decodes the entities a price table actually contains', () => {
    expect(toText('<p>Assembly&nbsp;$40 &amp; up</p>')).toBe('Assembly $40 & up');
  });

  it('turns an undecodable byte into a space, not a deletion', () => {
    // TaskRabbit's own pricing table, 2026-08-31: the page declares UTF-8 and
    // carries bytes that are not, so the en-dash arrives as U+FFFD. Deleting it
    // would fuse "$40$70" into a figure that appears nowhere on earth.
    expect(toText('<p>Furniture Assembly $40�$70</p>')).toBe('Furniture Assembly $40 $70');
  });

  it('leaves both figures separately findable, which is the point', () => {
    // The number check asks whether each figure in a claim appears in a cited
    // span. Fusing them would make both unfindable and every price unciteable.
    const text = toText('<td>TV Mounting $55�$90</td>');
    expect(text).toContain('$55');
    expect(text).toContain('$90');
    expect(text).not.toContain('�');
  });

  it('strips a NUL byte, which Postgres cannot store and which loses the turn', () => {
    // Live, 2026-08-31: a web answer citing four toronto.ca PDFs streamed to
    // the reader complete, cited and checked — then the INSERT failed with
    // "unsupported Unicode escape sequence (\\u0000 cannot be converted to
    // text)". The thread kept the question and lost the answer.
    expect(toText('<p>budget of \u0000$100 million</p>')).toBe('budget of $100 million');
    expect(toText('<p>a\u0000b</p>')).not.toContain('\u0000');
  });

  it('replaces a control byte with a space rather than closing the gap', () => {
    // Deleting it would fuse "$40" and "$70" into $4070 — a figure on no page.
    expect(toText('<p>$40\u0000$70</p>')).toBe('$40 $70');
  });

  it('leaves tab, newline and carriage return alone', () => {
    // They are structure, not corruption; newlines survive on purpose.
    expect(toText('<p>a\nb</p>')).toContain('\n');
  });

  it('collapses spaces but KEEPS newlines — paragraph structure is meaning', () => {
    // Line breaks survive on purpose: a page's paragraph boundaries are part of
    // what the model reads. Cross-line matching is `normalise`'s job at compare
    // time, not this function's — flattening here would lose structure for
    // every reader in exchange for a check that already works.
    expect(toText('<p>a\n\t  b</p>')).toBe('a\n b');
    expect(toText('<p>a    b</p>')).toBe('a b');
  });
});

describe('titleOf', () => {
  it('reads the title and decodes it the same way', () => {
    expect(titleOf('<title>Assembly &amp; Installation</title>', 'https://x.com')).toBe('Assembly & Installation');
  });

  it('falls back to the url when there is no title', () => {
    expect(titleOf('<p>hi</p>', 'https://x.com/a')).toBe('https://x.com/a');
  });
});
