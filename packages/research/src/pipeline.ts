/**
 * QUESTION → QUERIES → PAGES → CITED POINTS.
 *
 * Four stages, and the ordering constraint that matters is that the model never
 * sees the question and the answer at the same time as a single job. Asking one
 * model to "research X" in one call produces an essay; asking it to (a) name
 * the searches and (b) summarise text it was handed produces something that can
 * be checked. The second job is deliberately menial — the intelligence is in
 * what got retrieved, not in what the model remembers.
 *
 * ── COST, WHICH IS THE REASON FOR EVERY LIMIT HERE ─────────────────────────
 *
 * A pass over the competitor watch costs a fraction of a cent. Deep research is
 * the first thing in TMOS that can cost real money — searches are billed per
 * call, and reading twelve pages means twelve documents through a strong model.
 * So: a hard cap on queries, on pages read, and on characters per page, all
 * declared here rather than left to the caller's good sense. `shared/llm`'s
 * daily ceiling is the backstop, not the plan.
 */
import type {
  AskPort,
  Point,
  ReadDoc,
  ReadPort,
  ResearchAnswer,
  SearchHit,
  SearchPort,
} from './types.js';
import { verifyPoints } from './verify.js';

export interface ResearchLimits {
  /** Searches to run. More queries buy coverage; they also multiply cost. */
  readonly maxQueries: number;
  /** Pages to actually fetch and read. The expensive number. */
  readonly maxPages: number;
  /** Characters of each page handed to the model. */
  readonly maxCharsPerPage: number;
}

export const DEFAULT_LIMITS: ResearchLimits = {
  maxQueries: 4,
  maxPages: 8,
  maxCharsPerPage: 6_000,
};

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
 * Quote FIRST, then write the claim from the quote.
 *
 * The first live run dropped four of five points, all for the same reason: the
 * model wrote the claim it wanted to make and then produced a span that said
 * the same thing in its own words. That is the natural order — decide, then
 * justify — and it produces paraphrase every time, because the model is
 * generating the span rather than locating it.
 *
 * Inverting the order fixes it at the source: `span` is the first key in the
 * object, and the instruction is to copy a sentence off the page before
 * deciding what it supports. A claim derived from a quote in hand is
 * automatically citeable; a quote reconstructed for a claim in hand is not.
 */
const SYNTH_SYSTEM = [
  'You answer a question using ONLY the numbered documents provided.',
  'Return JSON: {"summary":"...","points":[{"span":"...","doc":1,"claim":"..."}],"unanswered":["..."]}',
  '',
  'HOW TO WRITE EACH POINT — in this order, and the order is the method:',
  '  1. FIND a sentence in a document that answers part of the question.',
  '  2. COPY it into "span" character-for-character. Copy, do not retype.',
  '     Keep its punctuation, capitals and figures. Do not join two sentences.',
  '  3. Put that document\'s number in "doc".',
  '  4. THEN write "claim" as what that exact sentence establishes.',
  '',
  'If you cannot find a sentence, there is no point to make. Say so in',
  '"unanswered" instead of writing the claim anyway.',
  '',
  'CHECKED MECHANICALLY — a point that fails is deleted, so a guess costs you',
  'the point and gains you nothing:',
  '- The span must appear verbatim in the document you cite.',
  '- Every number in the claim must appear inside the span.',
  '- Do not describe the company asking the question unless a document does.',
  '- Plain language. No marketing register.',
].join('\n');

/** Canonical enough to dedupe a search result set — tracking params and a
 *  trailing slash are not different pages. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^www\./, '');
    return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim();
  }
}

export function dedupeHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = canonical(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

interface RawPoint {
  claim?: unknown;
  /** The flat form the prompt asks for — quote first. */
  span?: unknown;
  doc?: unknown;
  /** The nested form, tolerated. */
  citations?: unknown;
}

/**
 * Map the model's doc INDEXES onto real URLs.
 *
 * The model is given numbered documents rather than URLs on purpose: a model
 * handed URLs will cite one it recognises rather than one it read, and an index
 * out of range is an unambiguous signal that it did exactly that. An index we
 * did not hand it becomes an empty citation list, which the verifier then drops
 * with "no source cited" — the failure is preserved, not repaired.
 */
export function bindCitations(raw: unknown, docs: readonly ReadDoc[]): Point[] {
  if (!Array.isArray(raw)) return [];
  const out: Point[] = [];
  for (const item of raw as RawPoint[]) {
    if (typeof item?.claim !== 'string') continue;
    const cites: { url: string; span: string }[] = [];

    // The flat shape the prompt asks for: one span, one doc, per point.
    if (typeof item.span === 'string') {
      const doc = docs[Number(item.doc) - 1];
      if (doc) cites.push({ url: doc.url, span: item.span });
    }
    // The nested shape, still accepted: a model that ignores the format is a
    // reason to read its answer, not to discard it before the gate has looked.
    if (Array.isArray(item.citations)) {
      for (const c of item.citations as { doc?: unknown; span?: unknown }[]) {
        const doc = docs[Number(c?.doc) - 1];
        if (!doc || typeof c?.span !== 'string') continue;
        cites.push({ url: doc.url, span: c.span });
      }
    }
    out.push({ claim: item.claim, citations: cites });
  }
  return out;
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

export interface ResearchDeps {
  readonly ask: AskPort;
  readonly search: readonly SearchPort[];
  readonly read: ReadPort;
  readonly limits?: ResearchLimits;
  /** Progress for a UI that is watching. Never the transport for results. */
  readonly onStep?: (line: string) => void;
}

export async function research(question: string, deps: ResearchDeps): Promise<ResearchAnswer> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const say = deps.onStep ?? ((): void => undefined);
  let cost = 0;

  const empty = (summary: string, unanswered: string[] = []): ResearchAnswer => ({
    question, summary, points: [], dropped: [], unanswered, sources: [], queries: [], costCents: cost,
  });

  /* 1 ─ plan */
  say('planning searches…');
  const planned = await deps.ask.ask(PLAN_SYSTEM, question, 700);
  if (!planned) return empty('The model was unavailable or the budget ceiling refused the call.');
  cost += planned.costCents;
  const plan = parseJson(planned.text);
  const queries = strings(plan['queries']).slice(0, limits.maxQueries);
  const cannot = strings(plan['unanswerable']);
  if (queries.length === 0) return empty('Could not turn that into a search. Try naming a company, a market or a period.', cannot);
  for (const q of queries) say(`  search: ${q}`);

  /* 2 ─ search */
  const hits: SearchHit[] = [];
  for (const q of queries) {
    for (const provider of deps.search) {
      try {
        hits.push(...(await provider.search(q, limits.maxPages)));
      } catch (err) {
        say(`  ${provider.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const unique = dedupeHits(hits);
  say(`${hits.length} results, ${unique.length} unique`);
  if (unique.length === 0) return empty('No search results. The providers returned nothing for those queries.', cannot);

  /* 3 ─ read. Robots decides; a refusal is normal and is reported, not retried. */
  const docs: ReadDoc[] = [];
  for (const h of unique) {
    if (docs.length >= limits.maxPages) break;
    const doc = await deps.read.read(h.url);
    if (doc === null || doc.text.trim().length < 200) {
      say(`  unreadable: ${h.url}`);
      continue;
    }
    docs.push({ ...doc, text: doc.text.slice(0, limits.maxCharsPerPage) });
    say(`  read: ${doc.title || doc.url}`);
  }
  if (docs.length === 0) {
    return empty('Found results but could not read any of them — refused by robots.txt, or assembled in a browser.', cannot);
  }

  /* 4 ─ synthesise, then check every point against what was actually read */
  say(`reading ${docs.length} document(s)…`);
  const corpus = docs
    .map((d, i) => `[${i + 1}] ${d.title}\nURL: ${d.url}\n${d.text}`)
    .join('\n\n---\n\n');
  const answered = await deps.ask.ask(SYNTH_SYSTEM, `QUESTION: ${question}\n\nDOCUMENTS:\n\n${corpus}`, 2_500);
  if (!answered) {
    return { ...empty('Retrieved the documents but the model call failed.', cannot), sources: docs, queries };
  }
  cost += answered.costCents;
  const out = parseJson(answered.text);

  const { kept, dropped } = verifyPoints(bindCitations(out['points'], docs), docs);
  say(`${kept.length} point(s) survived, ${dropped.length} dropped`);

  return {
    question,
    summary: typeof out['summary'] === 'string' ? out['summary'] : '',
    points: kept,
    dropped,
    unanswered: [...cannot, ...strings(out['unanswered'])],
    sources: docs,
    queries,
    costCents: cost,
  };
}
