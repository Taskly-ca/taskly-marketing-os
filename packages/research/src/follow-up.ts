/**
 * CONVERSATION — resolving a follow-up, and deciding what not to fetch again.
 *
 * `streamAnswer` plans searches from a bare question. That is correct for the
 * first thing anyone types and wrong for the second: "and in Vancouver?" is not
 * a query, "where did that price come from?" is not a query, and a planner
 * handed either of them in isolation writes a search for the literal words and
 * retrieves nothing. Everything a follow-up means lives in the turns before it.
 *
 * Two jobs, split out of `stream.ts` because both are decisions rather than
 * plumbing and both are worth testing without a pipeline around them:
 *
 *  1. **Plan.** Rewrite the follow-up into a standalone question and into
 *     standalone queries, and decide whether the pages the last turn read are
 *     still the right pages.
 *  2. **Propose.** After an answer exists, offer the questions it opens up —
 *     grounded in the quotes actually proven, never invented.
 *
 * ── THE RULE THAT GOVERNS THIS WHOLE FILE ──────────────────────────────────
 *
 * **History is context, never evidence.** It steers what we go and read. It is
 * never itself something a sentence may rest on. The previous turn's answer is
 * prose a model wrote — it carried badges because spans proven *in that run*
 * backed it, and those badges do not travel. So nothing here ever puts a prior
 * answer where the generator can copy from it, and nothing here lets a prior
 * turn stand in for a document. The failure this prevents has a shape: a
 * follow-up restating an earlier claim, cited to a page re-read this run that
 * no longer says it, reading as freshly confirmed because the conversation
 * around it was. Verification is per-run or it is decorative.
 */
import { checkCausalLanguage, checkHonesty } from '@tmos/guardrails';

import type { CitableSpan } from './attribute.js';
import type { ConversationTurn } from './events.js';
import type { AskPort, ReadDoc } from './types.js';
import { claimNumbers, normalise } from './verify.js';

/* ── planning ─────────────────────────────────────────────────────────────── */

/**
 * The base planner, character-for-character what `stream.ts` used before
 * conversation existed.
 *
 * It is sent ALONE when there is no history, so a first question plans exactly
 * as it always did. Follow-up rules are appended, never merged in: a planner
 * told about reuse and prior turns when there are none is a planner invited to
 * imagine them, and "reuse the previous sources" on turn one would resolve to
 * an empty list and silently cancel the search.
 */
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
 * Appended only when a conversation exists. Three things are being taught, and
 * each of them is a failure that was observed before it was written down:
 *
 *  1. **Resolve the reference.** "and in Vancouver?" searched literally returns
 *     nothing; searched as "Vancouver cleaning service prices" returns the
 *     answer. The model has the antecedent — it just has to be told to use it.
 *  2. **`[2]` is a citation, not noise.** `ConversationTurn` deliberately
 *     carries the answer with its markers intact, because a question ABOUT a
 *     marker is one of the most common follow-ups there is. A planner that has
 *     not been told what the brackets mean treats "where did [2] come from?" as
 *     a typo and plans a search for nothing.
 *  3. **Empty queries are a legal answer.** "Which of those was cheapest?"
 *     needs no new page on the web. Forcing a search for it spends a search
 *     call and eight fetches to arrive back at the documents we just read.
 *
 * `standalone` is asked for separately from `queries` because the two are used
 * in different places: queries go to a search provider, and the standalone
 * question goes to phase A and phase B in place of the follow-up. Attribution
 * against the literal text "and in Vancouver?" selects nothing.
 */
const FOLLOW_UP_RULES = [
  '',
  'THIS IS A FOLLOW-UP INSIDE A CONVERSATION. Return two more fields:',
  '{"standalone":"...","reuse":true}',
  '',
  'FOLLOW-UP RULES',
  '- "standalone" is the follow-up rewritten so it stands on its own, with',
  '  every it/that/those/there replaced by what it refers to earlier in the',
  '  conversation. Someone who has not read the conversation must be able to',
  '  answer it.',
  '- Plan queries from the STANDALONE question, never from the literal words.',
  '  "and in Vancouver?" after a question about Toronto prices is a search',
  '  about Vancouver prices.',
  '- A bracketed number in an earlier answer — [2] — is a citation marker. It',
  '  points at a quote that answer was built from. A question about one ("where',
  '  did that figure come from?") is a question about that SOURCE, so plan',
  '  queries that go back to the same material.',
  '- "reuse" is true when this follow-up is about the same subject as the last',
  '  turn, so the pages already read are likely to carry the answer too.',
  '- "queries" MAY BE EMPTY when reuse is true and the follow-up asks nothing',
  '  the last turn did not already read ("which of those was cheapest?").',
  '  Empty queries with reuse false means the question cannot be searched.',
].join('\n');

/**
 * How much of the conversation the planner is shown.
 *
 * Bounded on purpose: the transcript rides in the prompt of every follow-up, so
 * an unbounded history makes turn twenty cost more than turn one for no gain —
 * a reference almost always points at the turn it follows. The most recent turn
 * gets the larger cap because it is the one being referred to; older turns are
 * present only to keep a chain of pronouns resolvable.
 */
const MAX_HISTORY_TURNS = 4;
const RECENT_ANSWER_CHARS = 1_200;
const OLDER_ANSWER_CHARS = 400;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Domains, not URLs. The planner is judging whether the previous material is
 *  still the right material, and a domain answers that; a full URL in a prompt
 *  is a source a model can name without having read it, which is the habit
 *  `attribute.ts` keeps URLs out of its own prompt to avoid. */
const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Truncation is by character on the RENDERED answer, markers included, so a
 *  `[2]` the follow-up is asking about survives into the prompt. Stripping
 *  markers to "clean up" the history is the one edit that makes a question
 *  about a citation unanswerable. */
function transcript(history: readonly ConversationTurn[], question: string): string {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const lines: string[] = ['CONVERSATION SO FAR'];
  recent.forEach((t, i) => {
    const cap = i === recent.length - 1 ? RECENT_ANSWER_CHARS : OLDER_ANSWER_CHARS;
    const domains = [...new Set(t.sourceUrls.map(domainOf))].join(', ');
    lines.push(
      '',
      `Q: ${t.question}`,
      `A: ${clip(t.answer, cap)}`,
      domains === '' ? '(no sources were read for that turn)' : `(read: ${domains})`,
    );
  });
  lines.push('', `FOLLOW-UP: ${question}`);
  return lines.join('\n');
}

export interface FollowUpPlan {
  /** Standalone search queries, capped by the caller's `maxQueries`. */
  readonly queries: readonly string[];
  readonly unanswerable: readonly string[];
  /** The follow-up made self-contained. Equals `question` when there is no
   *  history, or when the model returned nothing usable. */
  readonly standalone: string;
  /** The planner's claim that the last turn's pages still apply. Advisory: it
   *  decides what we FETCH, never what we may claim. */
  readonly reuse: boolean;
  readonly costCents: number;
  /** Non-empty when planning failed and the caller must stop. */
  readonly note: string;
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

/** Plan searches for a question that may be a follow-up. */
export async function planSearches(
  question: string,
  history: readonly ConversationTurn[],
  ask: AskPort,
  maxQueries: number,
): Promise<FollowUpPlan> {
  const conversational = history.length > 0;
  const reply = await ask.ask(
    conversational ? PLAN_SYSTEM + FOLLOW_UP_RULES : PLAN_SYSTEM,
    conversational ? transcript(history, question) : question,
    conversational ? 900 : 700,
  );
  if (!reply) {
    return {
      queries: [], unanswerable: [], standalone: question, reuse: false, costCents: 0,
      note: 'The model was unavailable or the budget ceiling refused the call.',
    };
  }

  const plan = parseJson(reply.text);
  const standalone = plan['standalone'];
  return {
    queries: strings(plan['queries']).slice(0, maxQueries),
    unanswerable: strings(plan['unanswerable']),
    // A rewrite is only accepted when it is a non-empty string. Falling back to
    // the literal follow-up is always safe — worst case attribution is weak and
    // the answer is short. Falling back to a truncated or empty rewrite is not.
    standalone:
      conversational && typeof standalone === 'string' && standalone.trim() !== ''
        ? standalone.trim()
        : question,
    reuse: conversational && plan['reuse'] === true,
    costCents: reply.costCents,
    note: '',
  };
}

/* ── source reuse ─────────────────────────────────────────────────────────── */

/**
 * Which previously-read URLs to put back on the reading list.
 *
 * ── WHAT IS REUSED, AND WHAT DELIBERATELY IS NOT ───────────────────────────
 *
 * The URL LIST is reused. The document TEXT is not — every reused page is
 * fetched again through the same `ReadPort`, robots gate and all. That looks
 * like leaving the saving on the table, and it is the only version of reuse
 * this design can honestly ship:
 *
 *  - **Staleness is real.** A pricing page can change between two turns of one
 *    conversation. A cached body would let a follow-up answer out of a snapshot
 *    while presenting it as current, and nothing on screen would say which.
 *  - **The guarantee is per-run.** A span is proven a verbatim substring of a
 *    document *this run fetched*. Carrying text across turns quietly downgrades
 *    that to "was on the page at some earlier point", which is a different and
 *    much weaker promise wearing the same badge.
 *
 * What reuse actually saves is the search call and the funnel behind it —
 * which is the line item the answer-engine plan §6 records as dominating token
 * cost for short queries — plus the fetches of whatever the search would have
 * turned up that we had already read.
 *
 * ── ONLY THE MOST RECENT TURN ──────────────────────────────────────────────
 *
 * Reuse is a claim of continuity with the turn just answered. Pulling URLs from
 * further back re-imports material the conversation has already moved past, and
 * a long chain would accumulate every page it ever read — answering turn ten
 * out of turn one's sources. When the subject really did move back, the planner
 * has a search to spend.
 *
 * ── AND WHY THE BUDGET IS HALVED WHEN THERE ARE ALSO QUERIES ───────────────
 *
 * "And in Vancouver?" reuses AND searches. If the old set may fill every read
 * slot, the new search returns pages there is no room to read, and the new
 * question gets answered out of the old pages — the retrieval half of the same
 * inherited-credibility problem. Leaving half the slots for new material is
 * what makes the search worth having made.
 */
export function reuseUrls(
  history: readonly ConversationTurn[],
  plan: FollowUpPlan,
  maxPages: number,
): string[] {
  if (!plan.reuse) return [];
  const last = history[history.length - 1];
  if (!last) return [];
  const budget = plan.queries.length > 0 ? Math.max(1, Math.floor(maxPages / 2)) : maxPages;
  return [...new Set(last.sourceUrls)].slice(0, budget);
}

/* ── related questions ────────────────────────────────────────────────────── */

/** Three or four. Fewer reads as an afterthought; more is a menu nobody scans,
 *  and the marginal suggestion is always the ungrounded one. */
const MAX_RELATED = 4;

/** Sized for four short questions and nothing else. */
const RELATED_MAX_TOKENS = 300;

/**
 * Nothing here crosses the honesty boundary — a banned phrase in a system
 * prompt generates itself into the output, and the gate below would then be
 * catching its own instructions. The wording mirrors `GEN_SYSTEM`'s for that
 * reason rather than by accident.
 */
const RELATED_SYSTEM = [
  'You propose the questions a reader would ask NEXT, given some quotes.',
  'Return JSON: {"questions":["...","..."]}',
  '',
  'RULES',
  `- Three or four questions. Each one sentence, plain, ending in "?".`,
  '- Every question must be about something the quotes NAME: a company, a city,',
  '  a figure, a fee, a policy. A question about anything they do not mention',
  '  is deleted before anyone sees it.',
  '- Do not restate the question you were given.',
  '- Do not put a figure in a question unless that figure is in a quote.',
  '- Never ask what caused, drove or led to what. Nothing here is an experiment.',
  '- Never ask whether Taskly screens, checks, covers or promises anything',
  '  about anyone.',
].join('\n');

/** Common words carry no grounding — a question sharing only "about" with a
 *  quote shares nothing. Short tokens are excluded for the same reason, which
 *  also disposes of most of English without needing a list. */
const STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'that', 'this', 'those', 'these', 'their',
  'there', 'they', 'them', 'then', 'than', 'from', 'with', 'have', 'does',
  'much', 'many', 'more', 'most', 'into', 'over', 'about', 'other', 'would',
  'could', 'should', 'been', 'being', 'also', 'each', 'like', 'make', 'take',
  'work', 'year', 'years', 'time', 'compare', 'compared',
]);

const terms = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9$%.,-]{4,}/g) ?? []) {
    const t = w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (t.length >= 4 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
};

/**
 * The deterministic half. The model proposes; this disposes — the same
 * asymmetry `attribute.ts` relies on, and the reason a cheap model is safe here
 * too: the worst a bad pass can do is produce fewer suggestions.
 *
 * Five checks, each naming a way a "related question" goes wrong:
 *
 *  1. **Shape.** A string, one sentence, actually a question. A statement in
 *     the related-questions rail is an uncited claim in a rail that looks like
 *     navigation, which is the most credulous place on the page.
 *  2. **Grounded in the evidence in hand.** At least one distinctive term
 *     shared with a proven span or a source title. The user's own question is
 *     NOT part of the haystack: echoing the reader back is not grounding, and
 *     "what else about Toronto?" would otherwise always pass.
 *  3. **No unsourced figure**, by the same `claimNumbers` rule phase C applies
 *     to prose. "Is the 22% fee competitive?" asserts a 22% fee inside a
 *     question mark, where nothing on the page ever checks it.
 *  4. **Honesty**, at `internal`. A suggestion is generated text on the page.
 *  5. **Causal language at rung 0.** "What caused the drop?" presupposes a drop
 *     and a cause, out of documents that are observations.
 *
 * Duplicates and restatements of the question are dropped last, so a near-miss
 * never consumes one of the four slots.
 */
export function bindRelated(
  raw: unknown,
  question: string,
  spans: readonly CitableSpan[],
  docs: readonly ReadDoc[],
): string[] {
  const evidence = terms([...spans.map((s) => s.span), ...docs.map((d) => d.title)].join(' '));
  const figures = new Set(claimNumbers(spans.map((s) => s.span).join(' ')));
  const asked = new Set<string>([normalise(question).toLowerCase()]);
  const out: string[] = [];

  for (const item of strings(raw)) {
    const q = normalise(item);
    if (q.length < 12 || q.length > 160 || !q.endsWith('?')) continue;

    const words = terms(q);
    if (![...words].some((w) => evidence.has(w))) continue;
    if (claimNumbers(q).some((n) => !figures.has(n))) continue;
    if (!checkHonesty(q, 'internal').ok) continue;
    if (!checkCausalLanguage(q, 0).ok) continue;

    const key = q.toLowerCase();
    if (asked.has(key)) continue;
    asked.add(key);
    out.push(q);
    if (out.length >= MAX_RELATED) break;
  }
  return out;
}

export interface RelatedResult {
  readonly related: readonly string[];
  readonly costCents: number;
}

/**
 * Propose follow-ups from what this run actually proved.
 *
 * The model is shown the spans and nothing else — not the answer prose, not the
 * conversation. Suggestions are meant to be grounded in the evidence, and prose
 * is the one thing on hand that is not evidence; feeding it back would let a
 * suggestion be generated from a paraphrase and then presented as a lead the
 * sources support.
 */
export async function relatedQuestions(
  question: string,
  spans: readonly CitableSpan[],
  docs: readonly ReadDoc[],
  ask: AskPort,
): Promise<RelatedResult> {
  // No universe, no suggestions. Proposing next steps out of nothing is the
  // plain-LLM behaviour this package exists to refuse, and it would be doing it
  // in the one place on the page that carries no badge to contradict it.
  if (spans.length === 0) return { related: [], costCents: 0 };

  const quotes = spans.map((s) => `[${s.id}] "${s.span}"`).join('\n');
  const reply = await ask.ask(
    RELATED_SYSTEM,
    `QUESTION JUST ANSWERED: ${question}\n\nQUOTES:\n${quotes}`,
    RELATED_MAX_TOKENS,
  );
  if (!reply) return { related: [], costCents: 0 };

  return {
    related: bindRelated(parseJson(reply.text)['questions'], question, spans, docs),
    costCents: reply.costCents,
  };
}
