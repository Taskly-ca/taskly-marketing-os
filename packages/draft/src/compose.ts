/**
 * JOINING THE FIVE THINGS TMOS KNOWS INTO ONE QUESTION.
 *
 * The architecture's worked example is multi-hop and every hop already exists
 * in a different table:
 *
 *   "Competitor launched X"          → finding / fact  (the world model)
 *   "our roadmap already includes it" → brain           (the Brain bridge)
 *   "our positioning is different"    → brain
 *   "back-to-school starts in two weeks" → season       (the pack calendar)
 *   "recommendation: launch Y"        → nothing joined them
 *
 * The reasoning layer was never the missing piece. The JOIN was. So this file
 * is mostly assembly: build one numbered evidence list out of five sources,
 * hand it over once, and check every proposal back against it.
 *
 * ── WHY EVIDENCE IS NUMBERED ───────────────────────────────────────────────
 *
 * The same trick the research pipeline uses, for the same reason. A model given
 * URLs and document names cites the one it recognises; a model given `[7]` can
 * only cite a number it was handed, and an out-of-range index is an unambiguous
 * signal that it invented the support rather than used it. The index is not
 * convenience — it is what makes the citation checkable at all.
 */
import type { SeasonWindow } from '@tmos/packs';

import { activeSeasons, describeSeason } from './season.js';
import { verifyRecommendations, type RawRecommendation } from './verify.js';
import type { AskPort, Draft, Evidence } from './types.js';

export interface DraftInputs {
  /** Verified competitor changes, newest first. The strongest evidence here. */
  readonly findings: readonly { claim: string; soWhat: string; url: string | null; created: string }[];
  /** Values read off competitor pages, and when we first saw them. */
  readonly facts: readonly { company: string; predicate: string; value: string; url: string | null; since: string }[];
  /** Open forecasts. What we EXPECT — about us, not evidence about the world. */
  readonly forecasts: readonly { claim: string; p: string; resolves: string }[];
  /** Retrieved Taskly documents: positioning, roadmap, pricing, brand. */
  readonly brain: readonly { text: string; citation: string }[];
  readonly calendar: readonly SeasonWindow[] | undefined;
  /** The pack's own sentence naming whose interests this reasons for. A
   *  persona would change the voice; this changes the criteria. */
  readonly subject?: string;
}

/**
 * Build the numbered list.
 *
 * Order is deliberate and it is the order of evidential strength: what the
 * world did, then what the world says, then what we scheduled, then what we
 * expect, then what we believe. A model reading top-down meets the checkable
 * things first.
 */
export function buildEvidence(inputs: DraftInputs, now: Date): Evidence[] {
  const out: Evidence[] = [];
  const add = (e: Omit<Evidence, 'id'>): void => {
    out.push({ ...e, id: out.length + 1 });
  };

  for (const f of inputs.findings.slice(0, 12)) {
    add({ kind: 'finding', text: `${f.claim} — ${f.soWhat}`, source: f.url ?? 'competitor watch', observedAt: f.created });
  }
  for (const f of inputs.facts.slice(0, 40)) {
    add({
      kind: 'fact',
      text: `${f.company}: ${f.predicate.replace(/_/g, ' ')} is "${f.value.slice(0, 220)}"`,
      source: f.url ?? 'competitor watch',
      observedAt: f.since,
    });
  }
  for (const s of activeSeasons(inputs.calendar, now)) {
    add({ kind: 'season', text: describeSeason(s), source: 'domain calendar' });
  }
  for (const p of inputs.forecasts.slice(0, 10)) {
    add({ kind: 'forecast', text: `We put p=${p.p} on: ${p.claim} (resolves ${p.resolves})`, source: 'prediction ledger' });
  }
  for (const b of inputs.brain.slice(0, 14)) {
    add({ kind: 'brain', text: b.text.slice(0, 500), source: b.citation });
  }

  return out;
}

const SYSTEM = [
  'You are a marketing strategist for a company, reading an evidence file.',
  'Return JSON: {"note":"...","recommendations":[{"action":"...","reasoning":"...","falsifier":"...","evidence":[1,4],"horizon":"..."}]}',
  '',
  'THE EVIDENCE FILE IS ALL YOU KNOW. You have no other information about this',
  'company, its competitors or its market. Anything not in the file is not',
  'available to you, including things you believe you know.',
  '',
  'EACH RECOMMENDATION MUST HAVE',
  '  action     — one specific thing to start. Imperative. Something a person',
  '               could begin on Monday. "Explore" and "consider" are not actions.',
  '  reasoning  — why the cited evidence leads here. Not a restatement of it.',
  '  falsifier  — what would show this was the WRONG call. Concrete and',
  '               checkable. If you cannot name one, do not make the',
  '               recommendation.',
  '  evidence   — the numbers from the file this rests on. At least one, and',
  '               only numbers that appear in the file.',
  '  horizon    — when this stops being worth doing.',
  '',
  'RULES, CHECKED MECHANICALLY — a recommendation that fails is deleted:',
  '- Never write that one thing CAUSED another. Nothing here has a control',
  '  group. Say observed, associated with, consistent with.',
  '- Never claim the company screens, vets, insures or guarantees anything.',
  '- Do not invent numbers. Do not invent evidence indexes.',
  '',
  'FEWER, BETTER. Three recommendations that rest on observed evidence beat',
  'eight that rest on the calendar. If the file supports nothing, return an',
  'empty list and say so in "note". An empty answer is a correct answer.',
].join('\n');

const parse = (t: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export async function composeDraft(
  inputs: DraftInputs,
  ask: AskPort,
  now: Date = new Date(),
): Promise<Draft> {
  const evidence = buildEvidence(inputs, now);
  const base = { generatedAt: now.toISOString(), evidence, costCents: 0 };

  const observed = evidence.filter((e) => e.kind === 'finding' || e.kind === 'fact').length;
  if (observed === 0) {
    // Not a failure and not worth a model call. Everything the file would
    // contain is something we wrote about ourselves, and a plan built only on
    // our own documents and our own calendar is a plan with no world in it.
    return {
      ...base,
      recommendations: [],
      dropped: [],
      note: 'Nothing has been observed about the world yet — run the competitor watch first. A draft built only on our own documents and calendar would be a plan with no evidence in it.',
    };
  }

  const file = evidence.map((e) => `[${e.id}] (${e.kind}) ${e.text}\n      source: ${e.source}`).join('\n');
  const who = inputs.subject ? `WHO YOU ARE REASONING FOR: ${inputs.subject}\n\n` : '';
  const answer = await ask.ask(
    SYSTEM,
    `${who}EVIDENCE FILE (today is ${now.toISOString().slice(0, 10)}):\n\n${file}`,
    3_000,
  );
  if (!answer) {
    return { ...base, recommendations: [], dropped: [], note: 'The model call failed or the budget ceiling refused it. No draft was produced — nothing here is a fallback.' };
  }

  const out = parse(answer.text);
  const raw = Array.isArray(out['recommendations']) ? (out['recommendations'] as RawRecommendation[]) : [];
  const { kept, dropped } = verifyRecommendations(raw, evidence);

  return {
    ...base,
    costCents: answer.costCents,
    recommendations: kept,
    dropped,
    note: typeof out['note'] === 'string' ? out['note'] : '',
  };
}
