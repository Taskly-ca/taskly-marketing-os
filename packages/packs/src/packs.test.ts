/**
 * The seam, tested as a claim rather than as a shape.
 *
 * Part 10 says a second domain should be addable "with zero core changes". A
 * test that only checked `PACKS.length === 2` would pass for two copies of the
 * same pack, which proves nothing — a copy exercises exactly the fields the
 * original did. So what is checked here is that the second pack is genuinely
 * unlike the first along the axes that would have needed a core change:
 * a different region, no corridor, no rivals, and a different question shape.
 *
 * And the invariants every pack must hold, because a bad pack must be able to
 * produce bad coverage and never an unsafe claim.
 */
import { describe, expect, it } from 'vitest';
import { assertHonest } from '@tmos/guardrails';

import { DEFAULT_PACK_ID, PACKS, marketingCanada, packById, platform, publishes } from './index.js';

describe('the registry', () => {
  it('resolves by id and refuses an unknown one rather than defaulting', () => {
    expect(packById('marketing-ca')).toBe(marketingCanada);
    // A silent fallback runs the wrong domain, and the output looks identical.
    expect(packById('marketing-in')).toBeUndefined();
  });

  it('defaults to the domain the system was built for', () => {
    expect(DEFAULT_PACK_ID).toBe('marketing-ca');
  });

  it('gives every pack a distinct id', () => {
    expect(new Set(PACKS.map((p) => p.id)).size).toBe(PACKS.length);
  });
});

describe('the second pack is a second DOMAIN, not a second copy', () => {
  it('is not marketing, and not in the same region', () => {
    expect(platform.region).not.toBe(marketingCanada.region);
    expect(platform.id).not.toMatch(/^marketing/);
  });

  it('has no corridor and no rivals — a supplier is neither', () => {
    // This is the axis that would have forced a core change if the scorer
    // assumed every domain has a home market and a competitor list.
    expect(platform.scoring.corridor.home).toEqual([]);
    expect(platform.scoring.competitors).toEqual([]);
    expect(marketingCanada.scoring.corridor.home.length).toBeGreaterThan(0);
    expect(marketingCanada.scoring.competitors.length).toBeGreaterThan(0);
  });

  it('watches different things, with different questions', () => {
    const a = new Set(marketingCanada.targets.map((t) => t.domain));
    const b = new Set(platform.targets.map((t) => t.domain));
    expect([...b].some((d) => a.has(d))).toBe(false);

    const questions = new Set(
      marketingCanada.targets.flatMap((t) => t.measures.map((m) => m.predicate)),
    );
    const theirs = new Set(platform.targets.flatMap((t) => t.measures.map((m) => m.predicate)));
    expect([...theirs].some((p) => questions.has(p))).toBe(false);
  });
});

/**
 * HIRING TARGETS — the taxonomy, exercised on a second kind of document.
 *
 * A careers page and a job board answer the same question and must be measured
 * differently, which is the whole reason these two targets exist side by side:
 * the board is machine-readable so it is read by an instrument and every
 * measure on it is `measured`; the page is prose so it is read by a model and
 * every measure on it has to be one a model cannot drift on.
 */
describe('the careers targets', () => {
  const careers = marketingCanada.targets.filter((t) =>
    t.measures.some((m) => m.predicate.startsWith('careers_')),
  );

  it('watches hiring at all — two forecasts depended on it and nothing did', () => {
    expect(careers.length).toBeGreaterThan(1);
  });

  it('reads a machine-readable board with an instrument, and asks it nothing', () => {
    const board = careers.find((t) => t.url.includes('boards-api.greenhouse.io'));
    expect(board).toBeDefined();
    // Every measure `measured` means `extractFromPage` is never reached for it:
    // `asked` filters `measured` out, so there is no model call and no span to
    // drift. That is the property, not an accident of how it was declared.
    expect(board?.measures.every((m) => m.answer === 'measured')).toBe(true);
  });

  it('reads a prose careers page only with measures a model cannot drift on', () => {
    const page = careers.find((t) => t.url.endsWith('/careers'));
    expect(page).toBeDefined();
    // Bounded or quoted, never open: an `open` measure here would be the
    // category count again, wearing a job title.
    for (const m of page?.measures ?? []) {
      expect(['bounded', 'quoted'], m.predicate).toContain(m.answer);
      expect(publishes(m), m.predicate).toBe(true);
    }
  });

  it('asks the page the BOOLEAN the open forecasts are really about', () => {
    /**
     * "Jiffy lists at least 3 engineering roles" is a count and cannot publish.
     * "Does the page name an engineering role, yes or no" is bounded, cannot
     * drift by a word, and its flip from no to yes is the event the forecast is
     * actually about. Both are kept: the count as a recorded series, the
     * boolean as the thing that can be reported.
     */
    const predicates = new Set(careers.flatMap((t) => t.measures.map((m) => m.predicate)));
    expect(predicates).toContain('careers_page_names_engineering_role');
    expect(predicates).toContain('careers_page_names_growth_role');
    expect(predicates).toContain('careers_engineering_role_count');
    expect(predicates).toContain('careers_growth_role_count');
  });

  it('never gives one company two documents that fight over one predicate', () => {
    // Both careers targets and both service targets resolve to entities by
    // `domain`, so a predicate declared on two targets with the same domain is
    // two readings racing for one fact slot, and the last write silently wins.
    const seen = new Map<string, Set<string>>();
    for (const t of marketingCanada.targets) {
      const held = seen.get(t.domain) ?? new Set<string>();
      for (const m of t.measures) {
        expect(held.has(m.predicate), `${t.domain}:${m.predicate}`).toBe(false);
        held.add(m.predicate);
      }
      seen.set(t.domain, held);
    }
  });
});

describe('invariants every pack holds', () => {
  for (const pack of PACKS) {
    describe(pack.id, () => {
      it('names a subject a prompt can use, and it passes the honesty gate', () => {
        expect(pack.subject.length).toBeGreaterThan(40);
        // AGENTS.md rule 5: the denylist applies to PROMPTS too, since a banned
        // word in a prompt generates itself into output. A pack's subject is
        // interpolated into one.
        expect(() => assertHonest(pack.subject, `pack:${pack.id}:subject`)).not.toThrow();
      });

      it('gives every source a question it is FOR', () => {
        for (const s of pack.sources) expect(s.question.trim().length, s.collector.name).toBeGreaterThan(10);
      });

      it('gives every target at least one measure, and a reason to read it', () => {
        for (const t of pack.targets) {
          expect(t.measures.length, t.company).toBeGreaterThan(0);
          expect(t.reading_for.trim().length, t.company).toBeGreaterThan(10);
        }
      });

      it('gives every bounded measure a complete answer set', () => {
        for (const t of pack.targets) {
          for (const m of t.measures.filter((x) => x.answer === 'bounded')) {
            expect(m.allowed?.length ?? 0, m.predicate).toBeGreaterThan(1);
            expect(m.allowed, m.predicate).toContain('unstated');
          }
        }
      });

      it('never declares a measure that both publishes and cannot be checked', () => {
        for (const t of pack.targets) {
          for (const m of t.measures) {
            // `open` and `measured` are exactly the two that may not publish.
            if (m.answer === 'open' || m.answer === 'measured') {
              expect(publishes(m), m.predicate).toBe(false);
            }
          }
        }
      });

      it('never lets a COUNT publish, however it was obtained', () => {
        /**
         * The lesson `service_categories_count` cost us, generalised.
         *
         * A count is unciteable by construction — no span on any document
         * contains the number 6 — so it may never publish, and that holds
         * whether a model composed it (`open`) or an instrument computed it
         * (`measured`). The careers measures added the second case: a role
         * count read deterministically off a JSON job board is stable in a way
         * the category count never was, and it is STILL unpublishable, for a
         * different reason. Declaring one `bounded` would slip a number past
         * L0 by relabelling it.
         */
        for (const t of pack.targets) {
          for (const m of t.measures.filter((x) => x.unit === 'count')) {
            expect(publishes(m), m.predicate).toBe(false);
          }
        }
      });

      it('uses a distinct predicate for each measure on a target', () => {
        for (const t of pack.targets) {
          const names = t.measures.map((m) => m.predicate);
          // A repeated predicate on one target is two facts fighting over one
          // slot, and the last write silently wins.
          expect(new Set(names).size, t.company).toBe(names.length);
        }
      });
    });
  }
});
