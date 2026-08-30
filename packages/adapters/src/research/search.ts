/**
 * THE SEARCH PROVIDERS — Tavily and Exa, which have been paid for and unread.
 *
 * Both keys have sat in `.env` since the paid-source Part was written, with no
 * code reading either. They are the whole of "deep research" and they cost
 * nothing while idle, so the interesting question is not whether to use them
 * but how to use them WITHOUT letting them become the answer.
 *
 * ── A SNIPPET IS NOT EVIDENCE ──────────────────────────────────────────────
 *
 * Both providers return an extract with every result, and both are good enough
 * that it is tempting to answer straight from them. That would be the single
 * worst decision available here: a provider's extract is unversioned, sometimes
 * generated, and cannot be checked against the page — so a claim citing one is
 * a claim citing nothing a reader can open. The snippet ranks; only text WE
 * fetched, through our own robots gate, is ever quoted.
 *
 * ── TWO PROVIDERS, ON PURPOSE ──────────────────────────────────────────────
 *
 * Tavily is keyword-shaped and finds the obvious primary source; Exa is
 * embedding-shaped and finds the page nobody linked. Their overlap is small,
 * the union is deduped by canonical URL, and either being down degrades
 * coverage rather than failing the run — which is why the pipeline treats a
 * provider throw as a reported skip, not an error.
 */
import type { SearchHit, SearchPort } from '@tmos/research';

const TIMEOUT_MS = 12_000;

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const rows = (v: unknown, key: string): Record<string, unknown>[] => {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const list = o[key];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Tavily. `search_depth: advanced` is the one that reads past the first page. */
export function createTavily(apiKey: string): SearchPort {
  return {
    name: 'tavily',
    async search(query, limit) {
      const data = await postJson(
        'https://api.tavily.com/search',
        { query, max_results: limit, search_depth: 'advanced', include_answer: false },
        { authorization: `Bearer ${apiKey}` },
      );
      return rows(data, 'results').map(
        (r): SearchHit => ({
          title: str(r['title']) || str(r['url']),
          url: str(r['url']),
          snippet: str(r['content']).slice(0, 400),
          publishedAt: str(r['published_date']) || null,
          provider: 'tavily',
        }),
      ).filter((h) => h.url !== '');
    },
  };
}

/** Exa. `type: auto` lets it pick neural vs keyword per query rather than us
 *  guessing which shape a founder's question has. */
export function createExa(apiKey: string): SearchPort {
  return {
    name: 'exa',
    async search(query, limit) {
      const data = await postJson(
        'https://api.exa.ai/search',
        { query, numResults: limit, type: 'auto', contents: { text: { maxCharacters: 400 } } },
        { 'x-api-key': apiKey },
      );
      return rows(data, 'results').map(
        (r): SearchHit => ({
          title: str(r['title']) || str(r['url']),
          url: str(r['url']),
          snippet: str((r['text'] as string | undefined) ?? '').slice(0, 400),
          publishedAt: str(r['publishedDate']) || null,
          provider: 'exa',
        }),
      ).filter((h) => h.url !== '');
    },
  };
}

/** Whichever providers have a key. An empty list is a real state — the pipeline
 *  reports "no results" rather than pretending it searched. */
export function searchProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): SearchPort[] {
  const out: SearchPort[] = [];
  const tavily = env['TAVILY_API_KEY'];
  const exa = env['EXA_API_KEY'];
  if (tavily) out.push(createTavily(tavily));
  if (exa) out.push(createExa(exa));
  return out;
}
