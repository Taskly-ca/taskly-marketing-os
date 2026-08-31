/**
 * A COMPETITOR'S JOB BOARD — the second instrument with no model in it.
 *
 * Two forecasts have been sitting open in the prediction ledger with nothing
 * observing them: "Jiffy lists at least 3 engineering roles" (p=0.30) and
 * "Jiffy lists a growth or performance-marketing role" (p=0.35). Hiring is a
 * roadmap leak — a company staffs a quarter or two before it ships — so a
 * careers page is one of the few first-party documents that says what a rival
 * INTENDS rather than what it has already done.
 *
 * Both of those forecasts are COUNTS, which is exactly the measure that burned
 * this system once already: `service_categories_count` read 4, then 5, then 4,
 * on a page nobody had edited, because the extractor chose a wider span the
 * second time. Asking a model to count roles on a careers page would reproduce
 * that failure with a different noun. So nothing here is extracted. The board
 * is JSON, published by the company's own ATS for machines, and the reading is
 * string rules over it: no model, no span to choose, no judgement to drift.
 *
 * ── WHY GREENHOUSE, AND WHY ONLY GREENHOUSE ─────────────────────────────────
 *
 * Verified against the live web on 2026-08-31, through this repo's transport so
 * robots.txt applied to every fetch:
 *
 *   Taskrabbit  `www.taskrabbit.com/careers` renders in the browser and links
 *               out to `job-boards.greenhouse.io/taskrabbit`. Greenhouse also
 *               serves the same board as JSON at
 *               `boards-api.greenhouse.io/v1/boards/taskrabbit/jobs`, whose
 *               robots.txt disallows only `/embed/`. 17 postings, with titles
 *               and locations. This is the instrument.
 *   Jiffy       `jiffyondemand.com/careers` is server-rendered, allowed, and
 *               lists NO roles: it delegates to an AngelList embed whose data
 *               comes from `wellfound.com/job_profiles/embed`, and Wellfound's
 *               robots.txt carries a literal `Disallow: /job_profiles/embed`.
 *               The gate refuses it, correctly, and Jiffy's role LIST is
 *               therefore not observable by us at all. Jiffy is watched as a
 *               page instead — see the careers measures in `marketing-ca.ts`.
 *   Handy       `www.handy.com/careers` redirects into `angi.com` and answers
 *               403 from Cloudflare. Not readable, so not watched.
 *
 * Adding Lever or Ashby later is a second parser and a second URL pattern; the
 * shape below does not change. Only Greenhouse is recognised today because only
 * Greenhouse was verified today, and a pattern that matched a board we have
 * never fetched would route an unfetchable URL away from the page reader.
 *
 * ── WHAT PUBLISHES, AND WHAT ONLY GETS RECORDED ─────────────────────────────
 *
 * Every reading here is `measured`: computed from a document with no model in
 * the loop. `publishes()` is false for `measured`, and the one exemption in
 * `watch.ts` is a measure that brings a SENTENCE with it — not "we trust it
 * more", but "there is a claim about it that a span can carry".
 *
 *   the COUNTS      never publish. "Taskrabbit lists 6 engineering roles" is
 *                   unciteable by construction: no span on any document
 *                   contains the number 6, and L0 is right to refuse it. They
 *                   are recorded, and the series they build is what the two
 *                   open forecasts can be resolved against later.
 *   the CATALOGUE   publishes, through `careersClaim`. A change in the SET of
 *                   role titles is real, and the sentence that names it —
 *                   "…now lists "Staff Machine Learning Engineer"" — is made of
 *                   values that came off the board, so the claim and its proof
 *                   are the same words. This is the sitemap catalogue's
 *                   argument, applied to a second document.
 *
 * ── THE DELIBERATE BLIND SPOT ───────────────────────────────────────────────
 *
 * An empty board is read as unreadable, so we can report a change between two
 * non-empty boards and never a hiring freeze. That loses a real signal, on
 * purpose: a board token that moved, an ATS outage and a genuine freeze all
 * serialise to `{"jobs":[]}`, the difference between them is not in the
 * document, and the alternative is a Finding announcing that a competitor
 * withdrew its entire catalogue overnight on the strength of a 200 with no
 * rows in it.
 */
import type { Measure } from '@tmos/packs';

import { NAMED_LIMIT, list } from './catalogue-finding.js';
import type { ClaimWriter } from './change-finding.js';

/**
 * The board API, and nothing that merely looks like it.
 *
 * Anchored at both ends and pinned to the `/jobs` collection: the host also
 * serves a single job at `/jobs/<id>` and an `/embed/` path robots.txt
 * disallows, and neither is a catalogue. An unrecognised URL falls through to
 * the page reader, which is the safe direction — the dangerous one is handing
 * HTML to a JSON parser, which yields zero roles and reads as an empty board.
 */
const GREENHOUSE_BOARD =
  /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[a-z0-9][a-z0-9_-]*\/jobs$/;

export function boardUrlFor(url: string): string | null {
  return GREENHOUSE_BOARD.test(url) ? url : null;
}

/**
 * THE CATALOGUE SEPARATOR IS NOT A COMMA, and that is not a detail.
 *
 * The sitemap catalogue joins slugs on ",", which is safe because a slug cannot
 * contain one. Job titles can and do — "Country Manager, Iberia" is live on the
 * board this was written against — and a comma-joined catalogue would have
 * split it into two phantom roles that appear and vanish together forever,
 * minting a Finding about a role nobody ever posted.
 */
const SEP = ' | ';

/** One posting, as the board wrote it. `url` is the line a citation points at. */
export interface BoardRole {
  readonly title: string;
  readonly location: string;
  readonly url: string;
}

export interface BoardReading {
  /** The document this reading came from — the URL a citation points at. */
  readonly sourceUrl: string;
  /** When it was read. Carried so a citation is not stamped by its consumer. */
  readonly observedAt: string;
  /** Distinct roles, deduplicated by title and sorted. */
  readonly roles: readonly BoardRole[];
  /** Distinct roles, not postings — two open reqs for one title are one role. */
  readonly count: number;
  /** The comparable value: titles, sorted, joined on `SEP`. */
  readonly catalogue: string;
  /** The evidence: the board lines this reading was taken from, capped. */
  readonly span: string;
  readonly engineeringCount: number;
  readonly growthCount: number;
  readonly canadaCount: number;
}

/**
 * Whitespace is collapsed on BOTH the value and the span, deliberately.
 *
 * An ATS emits doubled spaces — "Sr.  Manager, Brand & Content" is on the live
 * board — and the day someone fixes that in the requisition it must not read as
 * a role leaving and a near-identical one arriving. Normalising both sides is
 * also what stops a claim and its citation disagreeing by an invisible
 * character, and it is the same normalisation `flatten()` applies to every
 * other document this system reads.
 *
 * A pipe becomes a slash because the separator must not appear inside a value.
 * Dropping such a role would be the quieter and worse choice: a role we cannot
 * store is a role we cannot notice arriving.
 */
const tidy = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * Function rules, fixed and dumb on purpose.
 *
 * No trailing `\b`, so "engineer" also catches "engineering" and "engineers".
 * These are string rules and they will be imperfect at the margin — a "Data
 * Scientist" is not counted as engineering, an "Engineering Program Manager"
 * is. That is fine and it is the point: the same rule applied to the same
 * document gives the same number every week, which is the property a model
 * counting the same page never had. Change a rule and the series breaks, so
 * treat these as part of the instrument rather than as a heuristic to tune.
 */
const ENGINEERING = /\b(engineer|developer|architect|programmer)/i;
const GROWTH = /\b(growth|performance marketing|paid (media|search|social|acquisition)|demand generation|user acquisition)/i;
/** Matched against title AND location: "Country Manager, Canada" is remote. */
const CANADA = /\b(canada|canadian|toronto|ontario|vancouver|montr[eé]al|calgary|ottawa|winnipeg|halifax|edmonton|quebec)/i;

interface RawJob {
  readonly title?: unknown;
  readonly location?: { readonly name?: unknown } | null;
  readonly absolute_url?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? tidy(v) : '');

/** How many board lines to quote. The whole board is the source, not evidence;
 *  a citation a human will not read is not a citation. */
const SPAN_LINES = 12;

/**
 * The board, or null when the document is not one.
 *
 * Never throws: a competitor's ATS returning an error page, a rate-limit body
 * or malformed JSON must not take a run down, and every one of those arrives
 * here as "no roles" rather than as an exception.
 */
export function readBoard(
  json: string,
  at: { sourceUrl: string; observedAt: string },
): BoardReading | null {
  let jobs: readonly RawJob[];
  try {
    const parsed: unknown = JSON.parse(json);
    const raw = (parsed as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(raw)) return null;
    jobs = raw as readonly RawJob[];
  } catch {
    return null;
  }

  // First title wins, so the citation is a line the document really carries.
  const byTitle = new Map<string, BoardRole>();
  for (const j of jobs) {
    const title = str(j?.title);
    if (title === '') continue;
    const key = title.toLowerCase();
    if (byTitle.has(key)) continue;
    byTitle.set(key, { title, location: str(j?.location?.name), url: str(j?.absolute_url) });
  }

  const roles = [...byTitle.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, role]) => role);
  if (roles.length === 0) return null;

  return {
    sourceUrl: at.sourceUrl,
    observedAt: at.observedAt,
    roles,
    count: roles.length,
    catalogue: roles.map((r) => r.title).join(SEP),
    span: quoteRoles(roles, roles.slice(0, SPAN_LINES).map((r) => r.title)),
    engineeringCount: roles.filter((r) => ENGINEERING.test(r.title)).length,
    growthCount: roles.filter((r) => GROWTH.test(r.title)).length,
    canadaCount: roles.filter((r) => CANADA.test(`${r.title} ${r.location}`)).length,
  };
}

/**
 * The evidence for a specific set of titles.
 *
 * A claim names the roles that appeared, so the span must contain THOSE lines
 * rather than the first twelve on the board. A title with no line in this
 * document — every removal, always — is dropped rather than invented: we can
 * prove what a board says and never what it stopped saying, which is the same
 * honest limit `quoteSlugs` carries and the same reason it is flagged here
 * instead of papered over.
 */
export function quoteRoles(
  roles: readonly BoardRole[],
  titles: readonly string[],
): string {
  const byKey = new Map(roles.map((r) => [r.title.toLowerCase(), r]));
  return titles
    .map((t) => byKey.get(t.toLowerCase()))
    .filter((r): r is BoardRole => r !== undefined)
    .map((r) => `${r.title} — ${r.location} — ${r.url}`)
    .join('\n');
}

/* ── the claim ────────────────────────────────────────────────────────────── */

interface CareersClaim {
  readonly claim: string;
  readonly so_what: string;
  /** Exactly the titles the claim names — what the span must contain. */
  readonly cited: readonly string[];
}

const parse = (catalogue: string): string[] =>
  catalogue
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * The sentence, or null when the board did not actually change.
 *
 * Null is not a failure. A reordered board produces a different string and an
 * identical set, and silence is the correct output for it — `mintWritten`
 * reports that as `restated`.
 *
 * Removals lead, for the same reason they do in the sitemap catalogue: a
 * requisition that closed is rarer than one that opened, and it is the move a
 * competitor will never put in a press release.
 *
 * NO DIGITS IN THE REMAINDER, and none in `so_what`. L0 requires every number
 * in a claim to appear verbatim in a cited span, and "and 4 others" appears in
 * none — so the tail counts nothing, exactly as `catalogueClaim`'s does.
 */
export function careersClaim(
  subject: string,
  prior: string,
  next: string,
): CareersClaim | null {
  const before = new Map(parse(prior).map((t) => [t.toLowerCase(), t]));
  const after = new Map(parse(next).map((t) => [t.toLowerCase(), t]));

  const added = [...after].filter(([k]) => !before.has(k)).map(([, t]) => t).sort();
  const removed = [...before].filter(([k]) => !after.has(k)).map(([, t]) => t).sort();
  if (added.length === 0 && removed.length === 0) return null;

  const namedAdded = added.slice(0, NAMED_LIMIT);
  const namedRemoved = removed.slice(0, NAMED_LIMIT);
  const extra = added.length - namedAdded.length + (removed.length - namedRemoved.length);

  const quote = (titles: readonly string[]): string => list(titles.map((t) => `"${t}"`));

  const parts: string[] = [];
  if (namedRemoved.length > 0) parts.push(`no longer lists ${quote(namedRemoved)}`);
  if (namedAdded.length > 0) parts.push(`now lists ${quote(namedAdded)}`);

  const tail = extra > 0 ? ', among other changes' : '';
  const claim = `${subject}'s job board ${parts.join(', and ')}${tail}.`;

  const soWhat: string[] = [];
  if (removed.length > 0) {
    soWhat.push(
      `${removed.length === 1 ? 'A role has' : 'Roles have'} left their board — a requisition was filled or pulled, and what a rival stops hiring for is the retreat they never announce`,
    );
  }
  if (added.length > 0) {
    soWhat.push(
      `${added.length === 1 ? 'a role has' : 'roles have'} appeared on it — headcount leads shipping by a quarter or two, so read this as what they intend to build and check whether it points at our corridor`,
    );
  }
  const so_what = `${soWhat.join('; ')}.`;

  return {
    claim,
    so_what: so_what.charAt(0).toUpperCase() + so_what.slice(1),
    cited: [...namedRemoved, ...namedAdded],
  };
}

/* ── wiring the reading onto the measures a pack declared ─────────────────── */

/**
 * Predicate → the value this reader computes for it.
 *
 * The pack is the declaration site — "what do we watch" is a pack's job, not
 * the worker's — so the measures live in `marketing-ca.ts` and this table is
 * how a declared predicate gets filled. A predicate the pack declares and this
 * table does not know is SKIPPED rather than guessed, and `careers.test.ts`
 * asserts the two agree, because the failure is otherwise silent: a renamed
 * predicate leaves the measure declared, unfilled and never recorded, and the
 * run prints as healthy with a fact missing from it.
 */
export const BOARD_VALUES: Readonly<Record<string, (r: BoardReading) => string>> = {
  careers_role_catalogue: (r) => r.catalogue,
  careers_role_count: (r) => String(r.count),
  careers_engineering_role_count: (r) => String(r.engineeringCount),
  careers_growth_role_count: (r) => String(r.growthCount),
  careers_canada_role_count: (r) => String(r.canadaCount),
};

/** The one predicate whose change can be described in a sentence a span carries. */
const CATALOGUE = 'careers_role_catalogue';

/** Structurally the watcher's `Reading`. Declared here so `careers.ts` needs no
 *  import from `watch.ts`, which imports it — a cycle nobody benefits from, and
 *  deliberately NOT exported: nothing outside names it, and an exported type
 *  nobody imports is an API surface with no caller. */
interface BoardValue {
  readonly measure: Measure;
  readonly value: string;
  readonly span: string;
  readonly writeClaim?: ClaimWriter;
}

function careersWriter(company: string, reading: BoardReading): ClaimWriter {
  return (prior, next) => {
    if (prior.kind !== 'text' || next.kind !== 'text') return null;
    const written = careersClaim(company, prior.text, next.text);
    if (written === null) return null;

    const span = quoteRoles(reading.roles, written.cited);
    // Every named role was a removal, so nothing in THIS document carries it.
    // A written claim with no evidence is refused downstream anyway; refusing
    // it here says why.
    if (span === '') return null;

    return {
      claim: written.claim,
      so_what: written.so_what,
      evidence: [
        {
          signal_id: null,
          fact_id: null,
          source_url: reading.sourceUrl,
          span: span.slice(0, 1_000),
          observed_at: reading.observedAt,
        },
      ],
    };
  };
}

export function boardReadings(
  company: string,
  measures: readonly Measure[],
  reading: BoardReading,
): BoardValue[] {
  const out: BoardValue[] = [];
  for (const measure of measures) {
    // `measured` is the only kind this path may fill. Anything else on a board
    // target is a question for a model, and there is no model here.
    if (measure.answer !== 'measured') continue;
    const value = BOARD_VALUES[measure.predicate];
    if (value === undefined) continue;
    out.push({
      measure,
      value: value(reading),
      span: reading.span,
      ...(measure.predicate === CATALOGUE
        ? { writeClaim: careersWriter(company, reading) }
        : {}),
    });
  }
  return out;
}
