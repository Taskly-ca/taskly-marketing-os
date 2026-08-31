/**
 * READING A PAGE FOR RESEARCH — the same gate the collectors pass through.
 *
 * `createTransport` enforces robots.txt as a HARD gate on every hop, the
 * 2-second per-host floor, and the honest User-Agent with a contact address.
 * Research reads the open web on demand, which is exactly the traffic pattern
 * a site owner would most want that promise to cover, so it uses that
 * transport rather than a convenient `fetch`.
 *
 * A refusal is a normal outcome and returns null. It is not retried through a
 * third party: the transport gate runs FIRST, so a host that has refused us is
 * never laundered through Firecrawl. Firecrawl is reached only when a page we
 * ARE allowed to read comes back too short to be a page — the one signal we
 * have that it was assembled in a browser rather than served.
 */
import { createRenderer, createTransport, MIN_USEFUL_CHARS } from '@tmos/collectors';
import type { ReadDoc, ReadPort } from '@tmos/research';

/** Strip markup to something a model can read. Not a parser — a de-tagger. */
export function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    /**
     * AN UNDECODABLE BYTE BECOMES A SPACE, NOT A GLYPH.
     *
     * Pages routinely declare `charset=UTF-8` and then carry bytes that are not
     * valid UTF-8 — a CMS storing content pasted out of Word is the usual
     * source. `response.text()` is right to emit U+FFFD for those, and the page
     * is the thing that is broken. But the bytes that break are almost always
     * punctuation, and the punctuation that matters most here is the en-dash in
     * a price range.
     *
     * Observed, 2026-08-31: TaskRabbit's own pricing table reaches us as
     * "Furniture Assembly $40\uFFFD$70". A model cannot reproduce a replacement
     * character, so it quotes a normal dash instead, and the substring check
     * correctly refuses the span as reconstructed. The gate was working; the
     * document was unquotable. Every price on that page was silently unciteable.
     *
     * A space is the honest substitute. Deleting the character would fuse
     * "$40$70" into one token and invent a figure; guessing a dash would put
     * characters on the page that were never there. A space preserves the
     * boundary, and because this runs BEFORE the text is handed to a model and
     * before any span is checked against it, all three see the same string —
     * which is the property the whole citation guarantee rests on.
     */
    /**
     * CONTROL BYTES ARE STRIPPED HERE OR THEY LOSE THE WHOLE TURN.
     *
     * Postgres `text` and `jsonb` cannot hold U+0000. A page that serves one —
     * PDFs rendered to text are the usual source — streams to the reader
     * perfectly and then kills the INSERT that stores it:
     *
     *   appendMessage: unsupported Unicode escape sequence
     *   (\u0000 cannot be converted to text.)
     *
     * Observed 2026-08-31 on a live web answer citing four toronto.ca PDFs. The
     * reader watched a complete, cited, checked answer appear on screen; the
     * thread kept the question and lost the answer. **A failure after the last
     * delta is the worst-shaped bug this system can have**, because everything
     * that would tell you something went wrong has already said it went right.
     *
     * Stripped at INGESTION rather than at the store, and the distinction
     * matters: sanitising on the way to Postgres would make the stored text
     * differ from the text the model read and the span check ran against, which
     * is the one property the citation guarantee rests on. Cleaned here, all
     * three see the same string.
     *
     * The range is C0 minus tab/newline/carriage-return, plus the C1 block and
     * U+2028/U+2029, which are legal in JSON but break naive line handling
     * downstream. Replaced with a space, never deleted — for the same reason
     * U+FFFD is: closing a gap can fuse two tokens into a figure that appears
     * nowhere.
     */
    // The rule below guards against a control character arriving in a pattern
    // by accident, usually pasted. Here matching them is the entire job.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\uFFFD/g, ' ')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function titleOf(html: string, url: string): string {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  return m?.[1] ? toText(m[1]).slice(0, 200) : url;
}

export function createResearchReader(): ReadPort {
  const transport = createTransport();
  const render = createRenderer(process.env);

  return {
    async read(url): Promise<ReadDoc | null> {
      try {
        const res = await transport.fetchText(url, { Accept: 'text/html,application/xhtml+xml' });
        if (res.status < 200 || res.status >= 300) return null;

        let text = toText(res.body);
        // Short is the only signal available that a page is assembled rather
        // than served. Robots has already allowed this host by the time we
        // are here, so the fallback cannot launder a refusal.
        // `createRenderer` returns null with no key — a skip, never a crash.
        if (text.length < MIN_USEFUL_CHARS && render !== null) {
          const rendered = await render(url);
          if (rendered.ok && rendered.text.length > text.length) text = rendered.text;
        }
        if (text.length < 200) return null;
        return { url, title: titleOf(res.body, url), text };
      } catch {
        // A robots denial arrives as a throw. It is a normal outcome for a
        // research run over the open web, not an error worth surfacing twice.
        return null;
      }
    },
  };
}
