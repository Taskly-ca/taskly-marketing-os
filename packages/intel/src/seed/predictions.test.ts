import { describe, it, expect } from 'vitest';
import { SEED_QUESTIONS, SEED_COUNT } from './predictions.js';
import { resolverFor } from '../resolver/kinds.js';

describe('seed question set', () => {
  it('has 20 questions with unique keys', () => {
    expect(SEED_COUNT).toBe(20);
    expect(new Set(SEED_QUESTIONS.map((q) => q.key)).size).toBe(20);
  });

  it('every resolver spec PARSES — an unparseable one could never be scored', () => {
    for (const q of SEED_QUESTIONS) {
      const r = resolverFor(q.resolver.kind);
      expect(r, `no resolver for ${q.key}`).toBeDefined();
      const parsed = r!.parse(q.resolver);
      expect(parsed.ok, `${q.key}: ${parsed.ok ? '' : parsed.error}`).toBe(true);
    }
  });

  it('every claim is TIME-BOUNDED — an undated claim can never resolve', () => {
    for (const q of SEED_QUESTIONS) {
      const dated =
        /\b(20\d{2}-\d{2}-\d{2}|January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(
          q.claim,
        );
      expect(dated, `${q.key} has no date: ${q.claim}`).toBe(true);
    }
  });

  it('no claim uses vague-traction language — the shape we explicitly reject', () => {
    for (const q of SEED_QUESTIONS) {
      expect(
        /\b(traction|momentum|significant|meaningful|substantial|soon)\b/i.test(q.claim),
        `${q.key} is vague: ${q.claim}`,
      ).toBe(false);
    }
  });

  it('every question resolves in the future and carries a rationale', () => {
    for (const q of SEED_QUESTIONS) {
      expect(new Date(q.resolve_at).getTime()).toBeGreaterThan(Date.parse('2026-08-03'));
      expect(q.rationale.length).toBeGreaterThan(20);
    }
  });

  it('carries no probabilities — a seeded p would be a fabricated forecast', () => {
    for (const q of SEED_QUESTIONS) {
      expect(q).not.toHaveProperty('p');
    }
  });

  it('never uses a banned source: no LinkedIn/Instagram/TikTok scraping', () => {
    for (const q of SEED_QUESTIONS) {
      const banned = /linkedin|instagram|tiktok/i.test(q.resolver.source_url);
      if (banned) {
        // Allowed only as a MANUAL resolver — a human looking at a public page.
        expect(q.resolver.kind, `${q.key} must be manual, not scraped`).toBe('manual');
      }
    }
  });

  it('spreads across classes so we are not grading ourselves on easy questions', () => {
    const kinds = new Set(SEED_QUESTIONS.map((q) => q.resolver.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    const manual = SEED_QUESTIONS.filter((q) => q.resolver.kind === 'manual').length;
    expect(manual).toBeLessThan(SEED_COUNT / 2); // mostly automatable
  });
});
