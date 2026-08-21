import type { RawItem } from '@tmos/collectors';
import { simhash } from '@tmos/gate';
import { describe, expect, it } from 'vitest';

import { contentHashOf, dropHistogram, emptySeen, runGate } from './gate.js';

const item = (over: Partial<RawItem> = {}): RawItem => ({
  externalId: 'x1',
  url: 'https://example.ca/a-story',
  title: 'Toronto contractors report a busy August',
  body: 'Demand for handyman work across the GTA rose through the month, several operators said.',
  publishedAt: '2026-08-20T10:00:00.000Z',
  meta: {},
  ...over,
});

describe('runGate', () => {
  it('keeps a clean item and canonicalises its url', () => {
    const out = runGate([item({ url: 'https://www.Example.ca/a-story/?utm_source=news&b=2' })], emptySeen());
    expect(out.dropped).toEqual([]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0]?.canonicalUrl).toBe('https://example.ca/a-story?b=2');
  });

  it('refuses an item pointing at a never-scrape host, however it reached us', () => {
    const out = runGate([item({ url: 'https://www.linkedin.com/posts/whatever' })], emptySeen());
    expect(out.kept).toEqual([]);
    expect(out.dropped[0]?.reason).toBe('banned_host');
  });

  it('drops a url it cannot canonicalise rather than ingesting something undedupable', () => {
    // A real host, so the never-scrape check passes and the failure is squarely
    // the canonicaliser refusing a scheme that is not http(s).
    const out = runGate([item({ url: 'ftp://example.ca/file.xml' })], emptySeen());
    expect(out.dropped[0]?.reason).toBe('unusable_url');
  });

  it('drops an item with neither title nor body', () => {
    const out = runGate([item({ title: null, body: '   ' })], emptySeen());
    expect(out.dropped[0]?.reason).toBe('empty_content');
  });

  it('drops content it already holds — the second-pass mechanism', () => {
    const seen = emptySeen();
    const first = runGate([item()], seen);
    expect(first.kept).toHaveLength(1);

    // Same content, different id and a tracking-decorated url: still one story.
    const second = runGate([item({ externalId: 'x2', url: 'https://example.ca/a-story?utm_campaign=x' })], seen);
    expect(second.kept).toEqual([]);
    expect(second.dropped[0]?.reason).toBe('duplicate_content');
  });

  it('drops a repeat url even when the body was edited past the near-dup threshold', () => {
    const seen = emptySeen();
    runGate([item()], seen);
    const rewritten = item({ externalId: 'x3', body: 'Completely different words about an unrelated subject entirely.' });
    const out = runGate([rewritten], seen);
    expect(out.dropped[0]?.reason).toBe('duplicate_url');
  });

  it('drops a near-duplicate: same article, different wrapper', () => {
    const seen = emptySeen();
    runGate([item()], seen);
    const nearly = item({
      externalId: 'x4',
      url: 'https://other-outlet.ca/a-story',
      body: `${item().body} Reported Thursday.`,
    });
    const out = runGate([nearly], seen);
    expect(out.dropped[0]?.reason).toBe('near_duplicate');
  });

  it('keeps a genuinely different story from the same source', () => {
    const seen = emptySeen();
    runGate([item()], seen);
    const different = item({
      externalId: 'x5',
      url: 'https://example.ca/other',
      title: 'Provincial licensing rules change for electrical work',
      body: 'Ontario is amending the certification path for apprentices starting next spring.',
    });
    expect(runGate([different], seen).kept).toHaveLength(1);
  });

  it('collapses duplicates that arrive inside the SAME pass, not just across passes', () => {
    const out = runGate([item(), item({ externalId: 'dup' })], emptySeen());
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toHaveLength(1);
  });

  it('redacts PII a collector left in rather than dropping the item', () => {
    const out = runGate([item({ body: 'Call 416-555-0199 or email tips@example.ca for details.' })], emptySeen());
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0]?.piiRedacted).toBe(true);
    expect(out.kept[0]?.item.body).toContain('[phone]');
    expect(out.kept[0]?.item.body).toContain('[email]');
    // And the hash is of the REDACTED text, so the same item cannot come back
    // under a different hash once a collector starts stripping it properly.
    expect(out.kept[0]?.contentHash).toBe(
      contentHashOf(`${item().title}\nCall [phone] or email [email] for details.`),
    );
  });

  it('compares against signatures loaded from the database, not just this pass', () => {
    const seen = emptySeen();
    // What `recentContent` returns: a bigint-safe decimal string.
    seen.signatures.push(simhash(`${item().title}\n${item().body}`));
    const out = runGate([item({ externalId: 'fresh', url: 'https://elsewhere.ca/x' })], seen);
    expect(out.dropped[0]?.reason).toBe('near_duplicate');
  });
});

describe('dropHistogram', () => {
  it('counts by reason, which is what the report prints', () => {
    const out = runGate(
      [item({ url: 'https://x.com/a' }), item({ externalId: 'b', url: 'https://twitter.com/b' }), item()],
      emptySeen(),
    );
    expect(dropHistogram(out.dropped)).toEqual({ banned_host: 2 });
  });
});
