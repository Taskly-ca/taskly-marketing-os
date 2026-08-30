/**
 * A RENDERING FETCH, for pages a browser has to assemble.
 *
 * Two watched documents defeat a plain fetch today, and they are not edge
 * cases: `jiffyondemand.com` flattens to **29 characters** and `groq.com/pricing`
 * yields nothing an extractor can answer from. Both are ordinary modern sites
 * whose content arrives from JavaScript. The competitor watch reports them
 * honestly — "too little text to read" — and then knows nothing about a rival's
 * pricing and nothing about the price of the models it runs on.
 *
 * Firecrawl renders the page and returns markdown. This is deliberately NOT a
 * collector: a collector produces a stream of items and this produces the text
 * of one document, which is what `readPage` already does. Making it a fallback
 * on the existing path rather than a new source means every downstream rule —
 * the span must be on the page, the answer must be supported by its span, the
 * measure kinds — applies unchanged.
 *
 * ── THE FALLBACK IS A FALLBACK
 *
 * Plain fetch first, always. It is free, it is fast, and it is what most pages
 * need; paying for a rendered fetch of a document that arrived complete is
 * money spent to get the same string. So this runs only when the cheap path
 * returned too little to read, which is also the only signal we have that a
 * page is assembled rather than served.
 *
 * ── ROBOTS STILL DECIDES
 *
 * A rendering service fetches on our behalf and its own crawler obeys its own
 * rules. That is not our robots check. The caller passes the same transport
 * gate first, so a host we are disallowed from stays disallowed — routing a
 * refused fetch through a third party is the definition of working around the
 * gate, and it is the one thing this file must not become.
 *
 * ── UNVERIFIED AGAINST THE LIVE API
 *
 * There is no key, so nothing here has met a real response. The shape below is
 * narrowed defensively for exactly that reason: an unexpected body produces a
 * NULL and a printed reason, never a partial string that flows into a fact. The
 * first run with a real key is the test, and it is the one thing this file is
 * waiting for.
 */

const ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';

/** The page is assembled, not empty, below this. Matches `readPage`'s floor. */
export const MIN_USEFUL_CHARS = 400;

interface RenderOptions {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
  /** A rendered fetch is slow by nature — it runs a browser. */
  readonly timeoutMs?: number;
}

export type RenderOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Pull the document text out of a response we have never seen.
 *
 * `data.markdown` is the documented field. Everything else is a guard: a body
 * that is not an object, a `data` that is not an object, a `markdown` that is
 * not a string, and a string too short to be a page. Each returns null, and the
 * caller reports it — because the failure this must not have is returning
 * `"undefined"` or `"[object Object]"` as a document and having it quoted in a
 * Finding.
 */
export function extractText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (body['success'] === false) return null;

  const data = body['data'];
  if (!isRecord(data)) return null;

  const markdown = data['markdown'];
  if (typeof markdown !== 'string') return null;

  const trimmed = markdown.trim();
  return trimmed.length >= MIN_USEFUL_CHARS ? trimmed : null;
}

export const RENDER_KEY_ENV = 'FIRECRAWL_API_KEY';

/** The renderer, or null when no key is configured — a skip, never a crash. */
export function createRenderer(
  env: NodeJS.ProcessEnv,
  overrides: Partial<RenderOptions> = {},
): ((url: string) => Promise<RenderOutcome>) | null {
  const apiKey = overrides.apiKey ?? env[RENDER_KEY_ENV]?.trim();
  if (!apiKey) return null;

  const doFetch = overrides.fetch ?? globalThis.fetch;
  const endpoint = overrides.endpoint ?? ENDPOINT;
  const timeoutMs = overrides.timeoutMs ?? 60_000;

  return async (url: string): Promise<RenderOutcome> => {
    const abort = AbortSignal.timeout(timeoutMs);
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url,
          // Markdown, not HTML: the extractor is handed flattened text either
          // way, and asking for markdown means the flattening was done by
          // something that understands the page rather than by a regex.
          formats: ['markdown'],
          onlyMainContent: true,
        }),
        signal: abort,
      });

      if (!res.ok) {
        return { ok: false, detail: `firecrawl http ${res.status}` };
      }

      const text = extractText(await res.json());
      if (text === null) {
        return { ok: false, detail: 'firecrawl returned no usable markdown' };
      }
      return { ok: true, text };
    } catch (error) {
      return {
        ok: false,
        detail: `firecrawl unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
