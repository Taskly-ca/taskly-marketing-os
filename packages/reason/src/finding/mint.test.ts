import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertHonest } from '@tmos/guardrails';
import type { EvidenceRef } from '@tmos/contracts';

import { mintFinding, mintOrThrow } from './mint.js';
import type { MintDraft, MintGates } from './mint.js';

const URL_ = 'https://jiffyondemand.com/pricing';
const SPAN = 'Jiffy listed a flat $189 rate for drain clearing in Toronto. Updated 2026-07-28.';

const evidence: EvidenceRef[] = [
  {
    signal_id: null,
    fact_id: null,
    source_url: URL_,
    span: SPAN,
    observed_at: '2026-08-01T09:00:00Z',
  },
];

const draft = (over: Partial<MintDraft> = {}): MintDraft => ({
  id: '11111111-1111-4111-8111-111111111111',
  claim: 'Jiffy listed a flat $189 rate for drain clearing in Toronto on 2026-07-28.',
  so_what:
    'Our curated plumbing price now sits above the nearest comparable listing, so the ' +
    'category page needs a repricing decision before the autumn push.',
  subject_refs: ['company:jiffy'],
  evidence,
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'medium',
  region: 'ca',
  domain_score: 0.7,
  generated_by: 'agent:t3-synthesis@1',
  created_at: '2026-08-02T00:00:00.000Z',
  ...over,
});

const gates: MintGates = { honesty: assertHonest, retrievedUrls: [URL_] };

const codes = (d: Partial<MintDraft>, g: Partial<MintGates> = {}) => {
  const r = mintFinding(draft(d), { ...gates, ...g });
  return r.ok ? [] : r.reasons.map((x) => x.code);
};

describe('the gates, all of them, on every mint', () => {
  it('emits a schema-valid Finding when every gate passes', () => {
    const r = mintFinding(draft(), gates);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finding.reviewed_by).toBeNull();
    expect(r.finding.superseded_by).toBeNull();
    expect(r.finding.supersede_reason).toBeNull();
  });

  it('refuses a forbidden trust claim in the claim', () => {
    expect(codes({ claim: 'Jiffy says every cleaner it sends is insured.' })).toContain('honesty');
  });

  it('refuses one in so_what too — half a gate is not a gate', () => {
    expect(
      codes({ so_what: 'We should say our Taskers carry liability insurance in the next brief.' }),
    ).toContain('honesty');
  });

  it('refuses causal language below rung 2', () => {
    expect(codes({ claim: "Jiffy's cut caused a $189 drop in our leads." })).toContain('causal');
  });

  it('refuses a number that appears in no cited span', () => {
    expect(codes({ claim: 'Jiffy listed a flat $199 rate for drain clearing.' })).toContain('l0');
  });

  it('refuses a citation to a url that was never retrieved', () => {
    expect(codes({}, { retrievedUrls: ['https://example.com/elsewhere'] })).toContain('l0');
  });

  it('refuses a so_what that only restates the claim', () => {
    expect(codes({ so_what: draft().claim })).toContain('trivial_so_what');
  });

  it('refuses an id the contract cannot accept', () => {
    expect(codes({ id: 'not-a-uuid' })).toContain('schema');
  });

  it('collects every reason at once rather than the first', () => {
    const found = codes({
      claim: 'The $199 discount caused our insured competitor to win.',
      so_what: 'Bad.',
    });
    expect(new Set(found)).toEqual(new Set(['trivial_so_what', 'honesty', 'causal', 'l0']));
  });
});

describe('the canary — a stubbed gate cannot pass for a live one', () => {
  it('refuses to mint at all against a no-op honesty gate', () => {
    expect(() => mintFinding(draft(), { ...gates, honesty: () => {} })).toThrowError(
      /honesty gate accepted its canary/i,
    );
  });

  it('checks the canary before reading the draft, so a clean draft cannot mask it', () => {
    // The draft below violates nothing. Without the canary it would mint, and
    // the disabled gate would be discovered by whoever read the output.
    expect(() => mintFinding(draft(), { ...gates, honesty: () => undefined })).toThrow();
  });
});

describe('mintOrThrow', () => {
  it('names the finding and every reason in one error', () => {
    expect(() => mintOrThrow(draft({ so_what: 'no' }), gates)).toThrowError(
      /refusing to mint finding 11111111.*trivial_so_what/s,
    );
  });
});

/* ── the structural claim ────────────────────────────────────────────────── */

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [full] : [];
  });

describe('one writer, enforced', () => {
  /**
   * A TRIPWIRE, not a proof. `Finding` is defined in `@tmos/contracts` and
   * cannot be branded from here, so nothing in the type system stops a fourth
   * module from writing the object literal itself — which is exactly how T2
   * came to be a second writer running one gate out of five.
   *
   * `superseded_by: null` + `supersede_reason: null` is the signature of a
   * FRESH Finding: only a newly minted one sets both to null in a literal (the
   * store's correction path spreads an existing row and sets them from its
   * arguments). If this fails, the fix is not to add the gates to the new file
   * — it is to call `mintFinding`.
   */
  it('has exactly one module in this package that constructs a Finding', () => {
    const root = resolve(import.meta.dirname, '..');
    const fresh = /superseded_by:\s*null/;
    const writers = sources(root)
      .filter((f) => fresh.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1));
    expect(writers).toEqual(['finding/mint.ts']);
  });
});
