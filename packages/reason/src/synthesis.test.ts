import { describe, expect, it } from 'vitest';
import type { WorkerOutcome } from './tier/workers.js';
import type { FindingDraft, SynthesisDeps } from './synthesis.js';
import {
  SO_WHAT_MAX_OVERLAP,
  assertSynthesisClean,
  evidencePoolFromWorkers,
  synthesize,
} from './synthesis.js';

/**
 * The real honesty gate, loaded through a computed specifier.
 *
 * `packages/guardrails/src/index.ts` does not re-export `honesty.js`, and this
 * lane may not edit that file. A static relative import across the package
 * boundary fails typecheck (TS6059, rootDir). This bridge is the only way to
 * exercise the production gate from here — replace it with
 * `import { assertHonest } from '@tmos/guardrails'` the moment that barrel
 * exports honesty. No library code depends on it; only this test does.
 */
type AssertHonest = (text: string, surface: string) => void;
const honestySpecifier = ['..', '..', 'guardrails', 'src', 'honesty.js'].join('/');
const { assertHonest } = (await import(honestySpecifier)) as { assertHonest: AssertHonest };

const URL_A = 'https://example.com/jiffy';
const OBSERVED = '2026-08-01T09:00:00Z';
const SPAN = 'Jiffy listed a flat $189 rate for drain clearing in Toronto. Updated 2026-07-28.';

const deps: SynthesisDeps = {
  honesty: assertHonest,
  now: () => new Date('2026-08-02T00:00:00Z'),
  generatedBy: 'agent:t3-synthesis@1',
};

const uuid = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;

const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  id: uuid(1),
  claim: 'Jiffy listed a flat $189 rate for drain clearing in Toronto on 2026-07-28.',
  so_what:
    'Our curated plumbing price now sits above the nearest comparable listing, so the ' +
    'category page needs a repricing decision before the autumn push.',
  subject_refs: ['company:jiffy'],
  evidence: [{ url: URL_A, span: SPAN, observed_at: OBSERVED }],
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'medium',
  region: 'ca',
  domain_score: 0.7,
  ...over,
});

const run = (drafts: FindingDraft[], retrievedUrls: string[] = [URL_A]) =>
  synthesize({ drafts, retrievedUrls }, deps);

const reasonCodes = (r: ReturnType<typeof run>, i = 0) =>
  (r.refused[i]?.reasons ?? []).map((x) => x.code);

describe('the happy path', () => {
  it('emits a schema-valid Finding carrying its evidence', () => {
    const res = run([draft()]);
    expect(res.refused).toEqual([]);
    expect(res.emitted).toHaveLength(1);
    const f = res.emitted[0];
    expect(f?.evidence[0]).toMatchObject({ source_url: URL_A, span: SPAN, signal_id: null });
    expect(f?.created_at).toBe('2026-08-02T00:00:00.000Z');
    expect(f?.generated_by).toBe('agent:t3-synthesis@1');
  });

  it('builds its retrieved-url set from worker output', () => {
    const outcomes: WorkerOutcome[] = [
      {
        status: 'ok',
        workerId: 'w1',
        evidence: [{ url: URL_A, span: SPAN, observed_at: OBSERVED }],
        notes: '',
        compression: {
          budgetTokens: 1_500,
          estimatedTokens: 30,
          kept: 1,
          dropped: 0,
          notesTruncated: false,
          overBudget: false,
        },
      },
      { status: 'failed', workerId: 'w2', code: 'threw', detail: 'boom' },
    ];
    const pool = evidencePoolFromWorkers(outcomes);
    expect(pool.retrievedUrls).toEqual([URL_A]);
    expect(pool.evidence).toHaveLength(1);
    const res = synthesize({ drafts: [draft()], retrievedUrls: pool.retrievedUrls }, deps);
    expect(res.emitted).toHaveLength(1);
  });
});

describe('L0 — evidence spans, enforced structurally', () => {
  it('REFUSES a finding whose number is in no cited span', () => {
    // The characteristic fabrication: a real sentence with a moved decimal.
    const res = run([
      draft({ claim: 'Jiffy listed a flat $199 rate for drain clearing in Toronto.' }),
    ]);
    expect(res.emitted).toEqual([]);
    expect(reasonCodes(res)).toContain('l0');
    expect(res.refused[0]?.reasons.find((r) => r.code === 'l0')?.detail).toContain(
      'number_not_in_span',
    );
  });

  it('REFUSES a citation to a url that was never retrieved', () => {
    const res = run([draft()], ['https://example.com/somewhere-else']);
    expect(res.emitted).toEqual([]);
    expect(res.refused[0]?.reasons.find((r) => r.code === 'l0')?.detail).toContain(
      'url_not_retrieved',
    );
  });

  it('REFUSES a finding with no evidence at all', () => {
    const res = run([draft({ evidence: [] })]);
    expect(res.emitted).toEqual([]);
    expect(reasonCodes(res)).toContain('l0');
  });
});

describe('honesty gate', () => {
  it('blocks a forbidden trust claim, loudly', () => {
    const res = run([
      // A true observation about a competitor, written the wrong way. The
      // honest form quotes it; asserting it in our own voice is the failure.
      draft({ claim: 'Jiffy now advertises that every cleaner it sends is insured.' }),
    ]);
    expect(res.emitted).toEqual([]);
    const honesty = res.refused[0]?.reasons.find((r) => r.code === 'honesty');
    expect(honesty).toBeDefined();
    expect(honesty?.detail).toContain('honesty gate blocked');
    expect(honesty?.detail).toContain('insurance');
    expect(() => assertSynthesisClean(res)).toThrowError(/refused 1 finding/);
  });

  it('checks so_what as well as the claim — both are generated prose', () => {
    const res = run([
      draft({ so_what: 'We should say our Taskers carry liability insurance in the next brief.' }),
    ]);
    expect(res.emitted).toEqual([]);
    expect(res.refused[0]?.reasons.some((r) => r.code === 'honesty')).toBe(true);
  });

  it('permits the same words inside a quotation — we report, we do not assert', () => {
    const span = 'Jiffy: "every cleaner we send is insured". Posted 2026-07-28.';
    const res = run([
      draft({
        claim: 'Jiffy\'s site now says "every cleaner we send is insured" as of 2026-07-28.',
        evidence: [{ url: URL_A, span, observed_at: OBSERVED }],
      }),
    ]);
    expect(res.refused).toEqual([]);
    expect(res.emitted).toHaveLength(1);
  });

  it('refuses to run at all against a stubbed-out gate', () => {
    // Injection is only safe if a no-op cannot be wired in. The canary is
    // checked before any draft is looked at, so a disabled gate fails the run
    // rather than silently passing every finding.
    expect(() =>
      synthesize({ drafts: [draft()], retrievedUrls: [URL_A] }, { ...deps, honesty: () => {} }),
    ).toThrowError(/honesty gate/i);
  });
});

describe('causal language', () => {
  const causalDraft = (rung: 0 | 1 | 2) =>
    draft({
      claim: 'The Jiffy price cut caused a 12% drop in our organic leads.',
      evidence: [
        {
          url: URL_A,
          span: 'Organic leads fell 12% over the four weeks after the Jiffy price cut.',
          observed_at: OBSERVED,
        },
      ],
      causal_rung: rung,
    });

  it('refuses "caused" at rung 0', () => {
    const res = run([causalDraft(0)]);
    expect(res.emitted).toEqual([]);
    expect(reasonCodes(res)).toEqual(['causal']);
    expect(res.refused[0]?.reasons[0]?.detail).toContain('caused');
  });

  it('still refuses at rung 1 — a pre-registered before/after is not a control', () => {
    expect(run([causalDraft(1)]).emitted).toEqual([]);
  });

  it('allows it at rung 2', () => {
    const res = run([causalDraft(2)]);
    expect(res.refused).toEqual([]);
    expect(res.emitted).toHaveLength(1);
  });
});

describe('so_what must be a consequence', () => {
  it('refuses an empty so_what', () => {
    expect(reasonCodes(run([draft({ so_what: '   ' })]))).toContain('trivial_so_what');
  });

  it('refuses a so_what that only restates the claim', () => {
    const res = run([draft({ so_what: draft().claim })]);
    expect(reasonCodes(res)).toContain('trivial_so_what');
    expect(res.refused[0]?.reasons[0]?.detail).toContain(String(SO_WHAT_MAX_OVERLAP));
  });

  it('refuses a so_what too short to carry a consequence', () => {
    expect(reasonCodes(run([draft({ so_what: 'Watch it.' })]))).toContain('trivial_so_what');
  });
});

describe('one writer, deterministic', () => {
  it('emits the good drafts and refuses the bad ones in a single pass', () => {
    const res = run([
      draft({ id: uuid(1) }),
      draft({ id: uuid(2), claim: 'Jiffy listed a flat $999 rate for drain clearing.' }),
      draft({ id: uuid(3) }),
    ]);
    expect(res.emitted.map((f) => f.id)).toEqual([uuid(1), uuid(3)]);
    expect(res.refused.map((r) => r.draftId)).toEqual([uuid(2)]);
  });

  it('same inputs produce identical output', () => {
    const drafts = [draft({ id: uuid(1) }), draft({ id: uuid(2), so_what: 'no' })];
    expect(run(drafts)).toEqual(run(drafts));
  });

  it('assertSynthesisClean is silent when nothing was refused', () => {
    expect(() => assertSynthesisClean(run([draft()]))).not.toThrow();
  });
});
