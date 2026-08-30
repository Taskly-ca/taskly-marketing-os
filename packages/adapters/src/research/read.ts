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
