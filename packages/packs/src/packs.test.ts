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
