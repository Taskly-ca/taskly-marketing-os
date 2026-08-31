/**
 * The job-board reader.
 *
 * Same property as the sitemap reader, and for the same reason: determinism.
 * The two hiring forecasts this instrument exists to observe — "Jiffy lists at
 * least 3 engineering roles", "Jiffy lists a growth role" — are COUNTS, and a
 * count read by a model is the measure that already burned this system once.
 * So everything here is read by string rules over a first-party JSON document,
 * and the tests are about the ways that reading could still drift: a board that
 * reorders itself, two requisitions with the same title, a title whose spacing
 * changed, and a title with a comma in it — which is the one that would have
 * silently corrupted the catalogue if it had reused the sitemap's separator.
 */
import { describe, expect, it } from 'vitest';
import { assertL0 } from '@tmos/reason';
import { assertHonest } from '@tmos/guardrails';
import { marketingCanada } from '@tmos/packs';

import {
  BOARD_VALUES,
  boardReadings,
  boardUrlFor,
  careersClaim,
  quoteRoles,
  readBoard,
} from './careers.js';
import { retrievalLedger } from './watch.js';

const BOARD = 'https://boards-api.greenhouse.io/v1/boards/taskrabbit/jobs';
const AT = { sourceUrl: BOARD, observedAt: '2026-08-31T00:00:00.000Z' };

const job = (title: string, location: string, id = 1): unknown => ({
  title,
  location: { name: location },
  absolute_url: `https://job-boards.greenhouse.io/taskrabbit/jobs/${id}`,
  // The churn we must ignore. `updated_at` moves on every edit, `id` on every
  // repost; a reader that touched either would report a change every week.
  id,
  internal_job_id: id * 7,
  updated_at: '2026-08-10T14:40:05-04:00',
  requisition_id: String(id),
});

const board = (jobs: readonly unknown[]): string => JSON.stringify({ jobs });

/** The shape of the live Taskrabbit board on 2026-08-31, trimmed. */
const LIVE = board([
  job('Country Manager, Iberia', 'Madrid, Spain', 1),
  job('Senior Software Engineer', 'San Francisco, California, United States', 2),
  job('Senior Software Engineer', 'San Francisco, California, United States', 3),
  job('Staff Machine Learning Engineer', 'San Francisco, California, United States', 4),
  job('Senior Accountant', 'London, England, United Kingdom', 5),
  job('Sr.  Manager, Brand & Content', 'New York, New York, United States', 6),
]);

describe('boardUrlFor', () => {
  it('recognises a Greenhouse board API URL', () => {
    expect(boardUrlFor(BOARD)).toBe(BOARD);
  });

  it('refuses everything else, so a careers page is never parsed as a board', () => {
    // Fail closed: an unrecognised URL falls through to the page path, where a
    // model reads it. The dangerous direction is the other one — handing HTML
    // to a JSON reader yields zero roles, which reads as an empty board.
    expect(boardUrlFor('https://jiffyondemand.com/careers')).toBeNull();
    expect(boardUrlFor('https://job-boards.greenhouse.io/taskrabbit')).toBeNull();
    expect(boardUrlFor('https://boards-api.greenhouse.io/v1/boards/taskrabbit')).toBeNull();
    expect(boardUrlFor('https://boards-api.greenhouse.io/embed/job_board?for=x')).toBeNull();
  });
});

describe('readBoard', () => {
  const reading = readBoard(LIVE, AT);

  it('gives the same answer for the same document', () => {
    expect(readBoard(LIVE, AT)).toEqual(reading);
  });

  it('is insensitive to the order the board lists them in', () => {
    // Greenhouse orders by whatever it likes and reorders on every edit. If
    // that read as a change, every run would mint a Finding about nothing.
    const shuffled = readBoard(
      board([
        job('Sr.  Manager, Brand & Content', 'New York, New York, United States', 6),
        job('Senior Accountant', 'London, England, United Kingdom', 5),
        job('Staff Machine Learning Engineer', 'San Francisco, California, United States', 4),
        job('Senior Software Engineer', 'San Francisco, California, United States', 3),
        job('Senior Software Engineer', 'San Francisco, California, United States', 2),
        job('Country Manager, Iberia', 'Madrid, Spain', 1),
      ]),
      AT,
    );
    expect(shuffled?.catalogue).toBe(reading?.catalogue);
  });

  it('collapses two requisitions for the same role into one', () => {
    // Two open "Senior Software Engineer" reqs are one thing they are hiring
    // FOR. Counting reqs would make a routine repost look like expansion.
    expect(reading?.count).toBe(5);
    expect(reading?.roles.filter((r) => r.title === 'Senior Software Engineer')).toHaveLength(1);
  });

  it('collapses the whitespace an ATS emits, so a spacing fix is not a change', () => {
    // "Sr.  Manager" — two spaces — is live on the real board today.
    expect(reading?.catalogue).toContain('Sr. Manager, Brand & Content');
    const respaced = readBoard(
      LIVE.replace('Sr.  Manager', 'Sr. Manager'),
      AT,
    );
    expect(respaced?.catalogue).toBe(reading?.catalogue);
  });

  it('keeps a comma inside a title, because the separator is not a comma', () => {
    // THE BUG THIS SEPARATOR EXISTS TO PREVENT. The sitemap catalogue joins on
    // ",", and "Country Manager, Iberia" would have split into two phantom
    // roles that appear and disappear together forever.
    const round = careersClaim('Taskrabbit', reading?.catalogue ?? '', reading?.catalogue ?? '');
    expect(round).toBeNull();
    expect(reading?.catalogue).toContain('Country Manager, Iberia');
  });

  it('cites the roles it read, so any title can be checked against the board', () => {
    for (const role of reading?.roles ?? []) expect(reading?.span).toContain(role.title);
  });

  it('counts by function with a fixed string rule, never a model', () => {
    expect(reading?.engineeringCount).toBe(2);
    expect(reading?.growthCount).toBe(0);
    expect(reading?.canadaCount).toBe(0);
  });

  it('sees a Canadian role in either the title or the location', () => {
    const ca = readBoard(
      board([job('Operations Manager', 'Toronto, Ontario, Canada', 9), job('Country Manager, Canada', 'Remote', 10)]),
      AT,
    );
    expect(ca?.canadaCount).toBe(2);
  });

  it('returns null rather than an exception on a document that is not a board', () => {
    expect(readBoard('<html>not json</html>', AT)).toBeNull();
    expect(readBoard('{"jobs":"nope"}', AT)).toBeNull();
  });

  it('returns null on an empty board — a moved token looks exactly like a freeze', () => {
    // The deliberate blind spot: we can report a change between two non-empty
    // boards and never a hiring freeze, because a board token that moved, an
    // ATS outage and a genuine freeze all serialise to `{"jobs":[]}` and the
    // difference between them is not in the document.
    expect(readBoard(board([]), AT)).toBeNull();
  });
});

describe('careersClaim', () => {
  const before = 'Senior Accountant | Senior Software Engineer';
  const after = 'Senior Software Engineer | Staff Machine Learning Engineer';

  it('says nothing when the board did not change', () => {
    expect(careersClaim('Taskrabbit', before, 'Senior Software Engineer | Senior Accountant')).toBeNull();
  });

  it('leads with the removal, because that is the move nobody announces', () => {
    const c = careersClaim('Taskrabbit', before, after);
    expect(c?.claim).toBe(
      'Taskrabbit\'s job board no longer lists "Senior Accountant", and now lists "Staff Machine Learning Engineer".',
    );
  });

  it('names only what it cites', () => {
    const c = careersClaim('Taskrabbit', before, after);
    expect(c?.cited).toEqual(['Senior Accountant', 'Staff Machine Learning Engineer']);
  });

  it('stops naming roles past the limit and counts the rest without a digit', () => {
    const many = Array.from({ length: 9 }, (_, i) => `Engineer ${String.fromCharCode(65 + i)}`).join(' | ');
    const c = careersClaim('Taskrabbit', 'Senior Accountant', many);
    // "among other changes" rather than "and 3 others": L0 demands every number
    // in a claim appear verbatim in a span, and a remainder appears in none.
    expect(c?.claim).toContain('among other changes');
    expect(c?.cited).toHaveLength(7);
  });

  it('writes a so_what a reader can act on, with no unciteable number in it', () => {
    const c = careersClaim('Taskrabbit', before, after);
    expect(c?.so_what ?? '').not.toMatch(/\d/);
    expect((c?.so_what ?? '').length).toBeGreaterThan(40);
  });

  it('passes the honesty gate on an ordinary board', () => {
    const c = careersClaim('Taskrabbit', before, after);
    expect(() => assertHonest(`${c?.claim} ${c?.so_what}`, 'internal')).not.toThrow();
  });

  it('survives a rival role title that contains a banned trust claim, BECAUSE it quotes it', () => {
    /**
     * A real exposure, not a hypothetical: marketplaces hire for exactly this,
     * and "background check" is a forbidden claim on every surface including
     * internal notes. The gate exempts text inside quotation marks — quoted
     * text is being REPORTED, not asserted — so wrapping every title in quotes
     * is not typography. It is what lets us say what a competitor is hiring for
     * without our own Finding asserting that anybody runs background checks.
     */
    const c = careersClaim('Taskrabbit', 'Senior Accountant', 'Background Check Operations Lead');
    expect(c?.claim).toContain('"Background Check Operations Lead"');
    expect(() => assertHonest(c?.claim ?? '', 'internal')).not.toThrow();
    // And the exemption is not a blanket hole: unquoted, the same words are
    // refused, which is the assertion the gate exists to stop.
    expect(() => assertHonest('Background Check Operations Lead', 'internal')).toThrow(/honesty gate/);
  });
});

/* ── the claim, through the real L0 and the real retrieval ledger ─────────── */

describe('a board change, end to end', () => {
  const prior = readBoard(board([job('Senior Accountant', 'London, England, United Kingdom', 5)]), AT);
  const next = readBoard(LIVE, AT);
  const claim = careersClaim('Taskrabbit', prior?.catalogue ?? '', next?.catalogue ?? '');
  const evidence = [
    {
      signal_id: null,
      fact_id: null,
      source_url: next?.sourceUrl ?? '',
      span: quoteRoles(next?.roles ?? [], claim?.cited ?? []),
      observed_at: next?.observedAt ?? '',
    },
  ];

  it('cites the board line every named role came from', () => {
    for (const title of claim?.cited ?? []) {
      // Except the removal: it has no line in THIS document, which is the
      // honest limit a one-document citation has. `quoteRoles` drops it rather
      // than inventing a line, exactly as `quoteSlugs` does.
      if (title === 'Senior Accountant') continue;
      expect(evidence[0]!.span).toContain(title);
    }
  });

  it('passes L0 with the ledger built from what was actually fetched', () => {
    const res = assertL0({
      claim: claim?.claim ?? '',
      evidence,
      retrievedUrls: retrievalLedger({ pageUrl: BOARD, pageRead: true, sitemapUrl: null }),
    });
    expect(res).toEqual({ ok: true, violations: [] });
  });

  it('is refused when the board is not in the ledger', () => {
    const res = assertL0({
      claim: claim?.claim ?? '',
      evidence,
      retrievedUrls: retrievalLedger({ pageUrl: BOARD, pageRead: false, sitemapUrl: null }),
    });
    expect(res.ok).toBe(false);
    expect(res.violations.map((v) => v.code)).toContain('url_not_retrieved');
  });
});

/* ── the pack and the instrument must agree ───────────────────────────────── */

describe('what the pack declares, this reader can actually fill', () => {
  const boardTargets = marketingCanada.targets.filter((t) => boardUrlFor(t.url) !== null);

  it('the pack has at least one job-board target', () => {
    expect(boardTargets.length).toBeGreaterThan(0);
  });

  for (const t of boardTargets) {
    it(`${t.company}: every measure it declares is one this reader computes`, () => {
      // The failure this prevents is silent: a renamed predicate in the pack
      // would leave the measure declared, unfilled and never recorded, and the
      // watch would print a healthy run with a fact missing from it.
      for (const m of t.measures) {
        expect(m.answer, m.predicate).toBe('measured');
        expect(Object.keys(BOARD_VALUES), m.predicate).toContain(m.predicate);
      }
    });

    it(`${t.company}: asks a model nothing — a board is read, not interpreted`, () => {
      expect(t.measures.every((m) => m.answer === 'measured')).toBe(true);
    });

    it(`${t.company}: the counts are recorded and never published`, () => {
      // A count is unciteable by construction: no span contains "6". Only the
      // catalogue publishes, and only through a written claim that names roles.
      const reading = readBoard(LIVE, AT);
      const rows = boardReadings(t.company, t.measures, reading!);
      for (const row of rows) {
        if (row.measure.datatype === 'num') expect(row.writeClaim, row.measure.predicate).toBeUndefined();
      }
      expect(rows.filter((r) => r.writeClaim !== undefined)).toHaveLength(1);
    });
  }
});
