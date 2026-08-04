import { describe, expect, it } from 'vitest';
import { BRAIN_STALE_DAYS } from '@tmos/contracts';
import type { BrainChunk } from '@tmos/contracts';
import { basisFor, canSupportClaim, citationFor, groundingSet, retrieve } from './retrieve.js';
import type { BrainDocMeta, BrainIndexCandidate, BrainIndexPort } from './retrieve.js';

const NOW = new Date('2026-08-04T00:00:00.000Z');
const FRESH = '2026-07-20'; // well inside the review window
const LAPSED = '2026-01-01'; // well past BRAIN_STALE_DAYS

const SYSTEM = '20-architecture/SYSTEM.md';

const doc = (over: Partial<BrainDocMeta> = {}): BrainDocMeta => ({
  path: SYSTEM,
  title: 'Taskly — Application Architecture',
  type: 'spec',
  status: 'canonical',
  reviewed: FRESH,
  caveats: [],
  verify: [],
  supersededBy: [],
  docSha: 'sha-system',
  ...over,
});

const chunk = (over: Partial<BrainChunk> = {}): BrainChunk => ({
  chunkId: 'sha-system:0',
  ordinal: 0,
  heading: 'Roles',
  text: 'profiles.role is only customer or admin.',
  chunkSha: 'c0',
  ...over,
});

const candidate = (
  d: BrainDocMeta,
  distance: number,
  over: Partial<BrainChunk> = {},
): BrainIndexCandidate => ({
  doc: d,
  chunk: chunk({ chunkId: `${d.docSha}:${over.ordinal ?? 0}`, ...over }),
  distance,
});

/** A deliberately naive port: it hands back whatever it was seeded with,
 *  including rows a plain `select` would return but retrieval must refuse. */
const portOf = (...candidates: BrainIndexCandidate[]): BrainIndexPort => ({
  search: () => Promise.resolve(candidates),
});

const ask = (port: BrainIndexPort, limit = 10) =>
  retrieve(port, { text: 'what commission does Taskly charge', limit }, NOW);

describe('superseded documents are absent, not demoted', () => {
  const dead = doc({
    path: '60-business/pricing/PRICING_v2.md',
    status: 'superseded',
    reviewed: null,
    docSha: 'sha-v2',
    supersededBy: ['60-business/pricing/PRICING_v3.md'],
  });

  it('drops a superseded row even when the port ranks it first', async () => {
    // Defence must not depend on the caller: the port may be a naive select.
    const result = await ask(portOf(candidate(dead, 0.01), candidate(doc(), 0.9)));

    expect(result.hits.map((h) => h.doc.path)).toEqual([SYSTEM]);
    expect(result.hits.some((h) => h.doc.status === 'superseded')).toBe(false);
  });

  it('records the exclusion rather than filtering silently', async () => {
    // A silent filter is indistinguishable from a broken index.
    const result = await ask(portOf(candidate(dead, 0.01)));

    expect(result.hits).toEqual([]);
    expect(result.excluded).toEqual([
      { path: dead.path, chunkId: 'sha-v2:0', status: 'superseded', reason: expect.any(String) },
    ]);
  });
});

describe('drafts inform, drafts never ground', () => {
  const draft = doc({
    path: '10-product/DISPATCH-IDEA.md',
    status: 'draft',
    reviewed: null,
    docSha: 'sha-draft',
  });

  it('returns a draft as context', async () => {
    const result = await ask(portOf(candidate(draft, 0.1)));

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.right).toBe('context_only');
  });

  it('keeps a draft out of the grounding set even when it is the closest hit', async () => {
    const result = await ask(portOf(candidate(draft, 0.01), candidate(doc(), 0.6)));

    expect(result.hits).toHaveLength(2);
    expect(groundingSet(result).map((h) => h.doc.path)).toEqual([SYSTEM]);
  });

  it('grounds on nothing at all when only drafts came back', async () => {
    const result = await ask(portOf(candidate(draft, 0.1)));

    expect(groundingSet(result)).toEqual([]);
    expect(canSupportClaim(result.hits)).toBe(false);
  });
});

describe('supporting documents corroborate but cannot carry a claim', () => {
  const supporting = doc({
    path: '30-flows/MARKETPLACE_PLAN.md',
    status: 'supporting',
    reviewed: FRESH,
    docSha: 'sha-plan',
  });

  it('refuses a claim backed only by supporting documents', async () => {
    const result = await ask(portOf(candidate(supporting, 0.05), candidate(supporting, 0.06)));

    expect(result.hits.every((h) => h.right === 'corroborates')).toBe(true);
    expect(canSupportClaim(result.hits)).toBe(false);
  });

  it('allows the claim once a canonical document is among the hits', async () => {
    const result = await ask(portOf(candidate(supporting, 0.05), candidate(doc(), 0.4)));

    expect(canSupportClaim(result.hits)).toBe(true);
  });

  it('attaches the corroboration caveat at retrieval time', async () => {
    const result = await ask(portOf(candidate(supporting, 0.05)));

    expect(result.hits[0]?.caveats.join(' ')).toContain('sole basis');
  });
});

describe('caveats ride along with the citation', () => {
  it('keeps a stale canonical grounding, but warns about the lapsed review', async () => {
    // Demoting the designated answer silently would be worse than citing it.
    const stale = doc({ reviewed: LAPSED, verify: ['lib/marketplace/fees.ts'] });
    const result = await ask(portOf(candidate(stale, 0.2)));
    const hit = result.hits[0];

    expect(hit?.right).toBe('grounds');
    expect(hit?.stale).toBe(true);
    expect(hit?.caveats.join(' ')).toContain(String(BRAIN_STALE_DAYS));
    expect(hit?.caveats.join(' ')).toContain('lib/marketplace/fees.ts');
  });

  it('carries the authored caveats out of the frontmatter', async () => {
    const caveated = doc({ caveats: ['Pre-dates the Phase-4 capability refactor.'] });
    const result = await ask(portOf(candidate(caveated, 0.2)));

    expect(result.hits[0]?.caveats).toContain('Pre-dates the Phase-4 capability refactor.');
  });

  it('leaves a fresh canonical uncaveated', async () => {
    const result = await ask(portOf(candidate(doc(), 0.2)));

    expect(result.hits[0]?.stale).toBe(false);
    expect(result.hits[0]?.caveats).toEqual([]);
  });
});

describe('citations name a section, not just a file', () => {
  it('renders path § heading', async () => {
    const result = await ask(portOf(candidate(doc(), 0.2, { heading: 'Roles' })));
    const hit = result.hits[0];

    // "it says so in SYSTEM.md" is not checkable; "SYSTEM.md § Roles" is.
    expect(hit && citationFor(hit)).toBe(`${SYSTEM} § Roles`);
    expect(hit?.citation).toContain('§ Roles');
  });

  it('falls back to the path when the chunk sits above any heading', async () => {
    const result = await ask(portOf(candidate(doc(), 0.2, { heading: '  ' })));

    expect(result.hits[0]?.citation).toBe(SYSTEM);
  });
});

describe('basis is conservative', () => {
  const basisOf = async (...candidates: BrainIndexCandidate[]) =>
    basisFor((await ask(portOf(...candidates))).hits);

  it('never claims a verified metric — a Brain document is prose, not an instrument', async () => {
    expect(await basisOf(candidate(doc(), 0.1))).not.toBe('verified_metric');
  });

  it('treats a fresh canonical as a governed lookup of the record', async () => {
    expect(await basisOf(candidate(doc(), 0.1))).toBe('governed_query');
  });

  it('downgrades when the only grounding document has a lapsed review', async () => {
    expect(await basisOf(candidate(doc({ reviewed: LAPSED }), 0.1))).toBe('inferred_from_sources');
  });

  it('downgrades when nothing but supporting documents came back', async () => {
    const supporting = doc({ status: 'supporting', docSha: 'sha-sup' });
    expect(await basisOf(candidate(supporting, 0.1))).toBe('inferred_from_sources');
  });

  it('is exploratory when only drafts, or nothing, came back', async () => {
    const draft = doc({ status: 'draft', reviewed: null, docSha: 'sha-draft' });
    expect(await basisOf(candidate(draft, 0.1))).toBe('exploratory_unverified');
    expect(basisFor([])).toBe('exploratory_unverified');
  });
});

describe('ordering is deterministic', () => {
  const a = doc({ path: '10-product/A.md', docSha: 'sha-a' });
  const b = doc({ path: '20-architecture/B.md', docSha: 'sha-b' });

  it('sorts by distance, then breaks ties stably by path and ordinal', async () => {
    const result = await ask(
      portOf(
        candidate(b, 0.5, { ordinal: 1 }),
        candidate(a, 0.5, { ordinal: 2 }),
        candidate(a, 0.5, { ordinal: 0 }),
        candidate(b, 0.1),
      ),
    );

    expect(result.hits.map((h) => h.chunk.chunkId)).toEqual([
      'sha-b:0',
      'sha-a:0',
      'sha-a:2',
      'sha-b:1',
    ]);
  });

  it('returns the same order however the port shuffles its candidates', async () => {
    const one = await ask(portOf(candidate(a, 0.5), candidate(b, 0.5)));
    const two = await ask(portOf(candidate(b, 0.5), candidate(a, 0.5)));

    expect(one.hits.map((h) => h.citation)).toEqual(two.hits.map((h) => h.citation));
  });

  it('caps at the requested limit, and returns fewer rather than padding', async () => {
    const dead = doc({ status: 'superseded', reviewed: null, docSha: 'sha-dead' });
    expect((await ask(portOf(candidate(a, 0.1), candidate(b, 0.2)), 1)).hits).toHaveLength(1);
    // Two asked for, one survived the ladder. A short answer beats one padded
    // with a document the company has already decided is wrong.
    expect((await ask(portOf(candidate(dead, 0.1), candidate(a, 0.2)), 2)).hits).toHaveLength(1);
  });
});
