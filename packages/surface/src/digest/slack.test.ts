import { describe, expect, it, vi } from 'vitest';
import { findingSchema } from '@tmos/contracts';
import type { Finding } from '@tmos/contracts';
import { assertNoConfidenceNumber } from '../basis.js';
import { ALL_DISMISS_REASONS } from '../feedback.js';
import { renderFindings, type FormatDeps, type RenderedFinding } from './format.js';
import { selectDigest } from './select.js';
import * as slack from './slack.js';
import {
  MAX_BLOCKS,
  MAX_FINDINGS_PER_MESSAGE,
  MAX_TEXT_CHARS,
  assertPayloadClean,
  buildDigestMessage,
  buildQuietMessage,
  buildSlackMessage,
  type SlackActionsBlock,
  type SlackMessage,
  type SlackSectionBlock,
  type SlackTransportPort,
} from './slack.js';

import { assertHonest, assertCausalLanguage } from '@tmos/guardrails';
const deps: FormatDeps = { honesty: assertHonest, causal: assertCausalLanguage };

const BASE = 'https://tmos.example/app';
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const rendered = (n: number, over: Partial<RenderedFinding> = {}): RenderedFinding => {
  const id = uuid(n);
  const lines = [
    `Jiffy listed a flat $189 rate for drain clearing in Toronto (${n}).`,
    'So what — our drain price sits above theirs in the same postal codes.',
    'Basis — Inferred from 2 independent sources',
    'Stakes — high · observational, no control group',
    `${BASE}/findings/${id}`,
  ];
  return { id, lines, text: lines.join('\n'), deepLink: `${BASE}/findings/${id}`, ...over };
};

const finding = (n: number, over: Partial<Finding> = {}): Finding =>
  findingSchema.parse({
    id: uuid(n),
    claim: `Jiffy listed a flat $189 rate for drain clearing in Toronto (${n}).`,
    so_what: 'Our drain price sits above theirs in the same postal codes.',
    subject_refs: ['competitor:jiffy'],
    evidence: [
      {
        signal_id: null,
        fact_id: null,
        source_url: 'https://jiffy.example/pricing',
        span: 'Drain clearing from $189, Toronto.',
        observed_at: '2026-08-01T09:00:00Z',
      },
    ],
    basis: 'governed_query',
    causal_rung: 0,
    stakes: 'high',
    region: 'ca',
    domain_score: 0.95 - n * 0.01,
    generated_by: 'agent:t2@1',
    reviewed_by: null,
    superseded_by: null,
    supersede_reason: null,
    created_at: '2026-08-02T09:00:00Z',
    ...over,
  });

const sections = (m: SlackMessage) =>
  m.blocks.filter((b): b is SlackSectionBlock => b.type === 'section');
const actions = (m: SlackMessage) =>
  m.blocks.filter((b): b is SlackActionsBlock => b.type === 'actions');

describe('the builder builds; it does not send', () => {
  it('never calls the transport', async () => {
    // The transport is deliberately not a parameter of any builder. Sending a
    // real message to a real workspace is an owner decision, not a build step.
    const transport: SlackTransportPort = { post: vi.fn(async () => ({ ok: true })) };

    buildDigestMessage({ findings: [rendered(1), rendered(2)], checked: 300, held: 1 });
    buildQuietMessage({ since: '2026-08-01T09:00:00Z', checked: 300, reason: 'nothing_material' });

    expect(transport.post).not.toHaveBeenCalled();
  });

  it('exports no sender at all', () => {
    const senders = Object.keys(slack).filter((k) =>
      /^(send|post|deliver|notify|publish)/i.test(k),
    );
    expect(senders).toEqual([]);
  });
});

describe('what a finding looks like in Slack', () => {
  const message = buildDigestMessage({ findings: [rendered(1)], checked: 412, held: 0 });

  it('carries the rendered lines verbatim', () => {
    expect(sections(message).some((s) => s.text.text.includes(rendered(1).text))).toBe(true);
  });

  it('gives every finding a deep link', () => {
    const buttons = actions(message).flatMap((a) => a.elements);
    const open = buttons.find((e) => e.type === 'button' && e.action_id.startsWith('open:'));
    expect(open && open.type === 'button' ? open.url : undefined).toBe(
      `${BASE}/findings/${uuid(1)}`,
    );
  });

  it('makes a dismissal impossible without a reason', () => {
    // A bare dismiss button is exactly what the taxonomy exists to prevent: an
    // unreasoned dismissal routes to no component and teaches nothing.
    const select = actions(message)
      .flatMap((a) => a.elements)
      .find((e) => e.type === 'static_select');
    expect(select).toBeDefined();
    if (!select || select.type !== 'static_select') return;

    expect(select.options.map((o) => o.value)).toEqual(
      ALL_DISMISS_REASONS.map((r) => `dismiss:${r}:${uuid(1)}`),
    );
    expect(select.options).toHaveLength(5);
    // Every option carries which finding it is about, so the payload alone is
    // a complete feedback event.
    for (const o of select.options) expect(o.value.endsWith(uuid(1))).toBe(true);
  });

  it('offers the one unambiguous success signal', () => {
    const acted = actions(message)
      .flatMap((a) => a.elements)
      .find((e) => e.action_id.startsWith('acted_on:'));
    expect(acted).toBeDefined();
  });

  it('passes assertNoConfidenceNumber over every text in the payload', () => {
    expect(() => assertPayloadClean(message)).not.toThrow();
  });
});

describe('a quiet week gets its own message, not an empty digest', () => {
  const quiet = buildQuietMessage({
    since: '2026-07-29T09:00:00Z',
    checked: 1_284,
    reason: 'nothing_material',
    held: 6,
  });

  it('says plainly that nothing cleared the bar', () => {
    const all = JSON.stringify(quiet);
    expect(all).toContain('Nothing worth your attention this week');
    expect(sections(quiet).length).toBeGreaterThan(0);
  });

  it('shows the work done, so silence is legible', () => {
    const all = JSON.stringify(quiet);
    expect(all).toContain('1284'); // signals examined
    expect(all).toContain('2026-07-29T09:00:00Z');
    expect(all).toContain('6 held');
  });

  it('has no finding sections and no dismiss controls', () => {
    expect(actions(quiet)).toHaveLength(0);
  });

  it('names a spent cap differently from an empty week', () => {
    const capped = buildQuietMessage({
      since: '2026-08-03T09:00:00Z',
      checked: 90,
      reason: 'weekly_cap_reached',
    });
    expect(JSON.stringify(capped)).toContain('weekly cap');
    expect(JSON.stringify(capped)).not.toBe(JSON.stringify(quiet));
  });
});

describe('Slack limits degrade by dropping whole findings', () => {
  it('never exceeds 50 blocks, and keeps every surviving finding intact', () => {
    const many = Array.from({ length: 40 }, (_, i) => rendered(i + 1));
    const m = buildDigestMessage({ findings: many, checked: 900, held: 0 });

    expect(m.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(sections(m).filter((s) => s.text.text.includes('Jiffy'))).toHaveLength(
      MAX_FINDINGS_PER_MESSAGE,
    );
    // Whole findings only — every kept section is byte-identical to what was
    // rendered, so nothing survived as a fragment.
    const keptTexts = sections(m).map((s) => s.text.text);
    for (let i = 0; i < MAX_FINDINGS_PER_MESSAGE; i++) {
      expect(keptTexts).toContain(many[i]?.text);
    }
    expect(m.dropped).toBe(40 - MAX_FINDINGS_PER_MESSAGE);
    expect(JSON.stringify(m)).toContain(`${40 - MAX_FINDINGS_PER_MESSAGE} dropped`);
  });

  it('drops an over-long finding whole rather than truncating its evidence', () => {
    const huge = rendered(1, { text: 'x'.repeat(MAX_TEXT_CHARS + 1) });
    const m = buildDigestMessage({ findings: [huge, rendered(2)], checked: 10, held: 0 });

    expect(m.dropped).toBe(1);
    expect(JSON.stringify(m)).not.toContain('xxxx');
    expect(sections(m).some((s) => s.text.text.includes(rendered(2).text))).toBe(true);
  });

  it('still produces a valid message when everything is dropped', () => {
    const huge = rendered(1, { text: 'x'.repeat(MAX_TEXT_CHARS + 1) });
    const m = buildDigestMessage({ findings: [huge], checked: 10, held: 0 });
    expect(m.blocks.length).toBeGreaterThan(0);
    expect(m.dropped).toBe(1);
    expect(() => assertPayloadClean(m)).not.toThrow();
  });
});

describe('select → format → slack', () => {
  const now = new Date('2026-08-05T09:00:00Z');

  it('turns a strong week into three Slack findings', () => {
    const selection = selectDigest({
      candidates: [1, 2, 3, 4].map((n) => finding(n)),
      history: [],
      signalsExamined: 512,
      now,
    });
    if (selection.kind !== 'digest') throw new Error('expected a digest');

    const batch = renderFindings(
      selection.items.map((i) => ({
        finding: i.finding,
        deepLinkBase: BASE,
        independentSources: 2,
      })),
      deps,
    );
    expect(batch.refused).toHaveLength(0);

    const m = buildSlackMessage(selection, batch.rendered);
    expect(actions(m)).toHaveLength(3);
    expect(m.dropped).toBe(0);
    expect(() => assertPayloadClean(m)).not.toThrow();
    expect(() => assertNoConfidenceNumber(m.text)).not.toThrow();
  });

  it('turns a quiet week into the quiet message, never an empty digest', () => {
    const selection = selectDigest({
      candidates: [
        finding(1, { stakes: 'low', basis: 'exploratory_unverified', domain_score: 0.2 }),
      ],
      history: [],
      signalsExamined: 512,
      now,
    });
    if (selection.kind !== 'quiet') throw new Error('expected quiet');

    const m = buildSlackMessage(selection, []);
    expect(JSON.stringify(m)).toContain('Nothing worth your attention this week');
    expect(actions(m)).toHaveLength(0);
  });
});
