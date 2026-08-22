/**
 * The verifier wiring, without a model.
 *
 * Two things are worth pinning and neither is the HTTP call. The first is the
 * scope rule: a true claim about a competitor's 15% must not be refuted for
 * disagreeing with our 20%, because refuting a true statement trains a reader
 * to overrule the gate. The second is that an abstention does not ship — a
 * verifier that throws must produce `uncertain` and a Finding that needs a
 * human, never a quiet pass.
 */
import { describe, expect, it, vi } from 'vitest';
import { passesVerification, type FactSheet, type VerifierPort } from '@tmos/reason';

import { VERIFIER_VERSION, mentionsTaskly, verifyForPublication } from './verifier.js';

const FACTS: FactSheet = {
  tasker_side_commission: { value: '20%', source: 'lib/marketplace/fees.ts' },
};

const URL = 'https://www.handy.com/';

const finding = (claim: string) => ({
  claim,
  evidence: [
    { source_url: URL, span: 'Our commission is 15% of every job.', observed_at: '2026-08-23T00:00:00.000Z' },
  ],
  // A different family from the verifier, so independence is not the thing
  // under test in any case below.
  generated_by: 'agent:openai/gpt-oss-120b@watch-3',
});

const verifierThat = (response: unknown): VerifierPort => ({
  identity: { model: 'qwen/qwen3.6-27b', version: VERIFIER_VERSION },
  refute: vi.fn(async () => response as never),
});

describe('mentionsTaskly', () => {
  it('matches the brand however it is written', () => {
    expect(mentionsTaskly("Taskly's commission is 20%.")).toBe(true);
    expect(mentionsTaskly('taskly.ca changed its fee.')).toBe(true);
  });

  it('does not match a claim about someone else', () => {
    expect(mentionsTaskly("Handy's commission is 15%.")).toBe(false);
  });
});

describe('verifyForPublication — the scope rule', () => {
  it('does not check a competitor claim against our constants', async () => {
    const got = await verifyForPublication(finding("Handy's commission is 15%."), {
      verifier: verifierThat({ verdict: 'survives', reason: 'the span states it', span: 'Our commission is 15% of every job.' }),
      retrievedUrls: [URL],
      facts: FACTS,
    });

    expect(got.stage).toBe('refutation');
    expect(got.verdict).toBe('survives');
    expect(passesVerification(got)).toBe(true);
  });

  it('does check a claim about us, and refutes one that contradicts the sheet', async () => {
    const got = await verifyForPublication(finding("Taskly's commission is 15%."), {
      verifier: verifierThat({ verdict: 'survives', reason: 'should never be reached', span: null }),
      retrievedUrls: [URL],
      facts: FACTS,
    });

    expect(got.stage).toBe('fact_sheet');
    expect(got.verdict).toBe('refuted');
    expect(got.reason).toMatch(/lib\/marketplace\/fees\.ts/);
    expect(passesVerification(got)).toBe(false);
  });
});

describe('verifyForPublication — an abstention does not ship', () => {
  it('turns a verifier that throws into uncertain, needing a human', async () => {
    const verifier: VerifierPort = {
      identity: { model: 'qwen/qwen3.6-27b', version: VERIFIER_VERSION },
      refute: async () => {
        throw new Error('429 rate limited');
      },
    };

    const got = await verifyForPublication(finding("Handy's commission is 15%."), {
      verifier,
      retrievedUrls: [URL],
      facts: FACTS,
    });

    expect(got.verdict).toBe('uncertain');
    expect(got.needs_human).toBe(true);
    expect(passesVerification(got)).toBe(false);
  });

  it('refuses a verdict citing a span nobody sent', async () => {
    const got = await verifyForPublication(finding("Handy's commission is 15%."), {
      verifier: verifierThat({ verdict: 'refuted', reason: 'invented', span: 'a span from nowhere' }),
      retrievedUrls: [URL],
      facts: FACTS,
    });

    expect(got.verdict).toBe('uncertain');
    expect(got.reason).toMatch(/never sent/);
  });

  it('refuses a verifier of the writer’s own family before spending anything', async () => {
    const sibling: VerifierPort = {
      identity: { model: 'openai/gpt-oss-20b', version: VERIFIER_VERSION },
      refute: vi.fn(),
    };

    const got = await verifyForPublication(finding("Handy's commission is 15%."), {
      verifier: sibling,
      retrievedUrls: [URL],
      facts: FACTS,
    });

    expect(got.stage).toBe('independence');
    expect(got.verdict).toBe('uncertain');
    expect(sibling.refute).not.toHaveBeenCalled();
  });
});
