/**
 * DEMO REPLAYS — `?demo=1`, ported from the old answer page's scripts.
 *
 * A scripted run: real frames from the answer contract, on a clock, fed through
 * the same reducer a live stream uses. No server, no spend. Each script carries
 * the cases that are invisible in a happy path — a flagged sentence whose
 * failure is inference or arithmetic, all four source kinds side by side, a
 * clarify round trip, a deep step that proves nothing, the plan revision that
 * follows, a skipped step, and a reflection that stops with a reason.
 * Deep timings are compressed about 5:1; the shape is what is being reviewed.
 */
import type { Frame, Mode } from './answer';

type Timed = { at: number; frame: Frame };

type Src = { i: number; url: string; domain: string; title: string; kind?: string; observedAt?: string };
type Sp = { id: number; sourceIndex: number; quote: string };
type Sent = { text: string; verdict: 'confirmed' | 'flagged'; why?: string };

const WEB_SOURCES: Src[] = [
  { i: 1, url: 'https://www.blogto.com/city/2025/09/toronto-snow-removal-contracts/', domain: 'blogto.com', title: 'When Toronto homeowners actually book snow removal' },
  { i: 2, url: 'https://www.jiffyondemand.com/services/snow-removal', domain: 'jiffyondemand.com', title: 'Snow Removal — Jiffy seasonal packages' },
  { i: 3, url: 'https://www.taskrabbit.ca/toronto', domain: 'taskrabbit.ca', title: 'TaskRabbit Toronto — browse tasks near you' },
  { i: 4, url: 'https://trends.google.com/trends/explore?q=snow%20removal%20toronto', domain: 'trends.google.com', title: 'snow removal toronto — Google Trends, 12 months' },
  { i: 5, url: 'https://www.theweathernetwork.com/ca/winter-forecast/ontario', domain: 'theweathernetwork.com', title: 'Ontario winter forecast and first-snow outlook' },
  { i: 6, url: 'https://www.statcan.gc.ca/en/subjects/household-spending', domain: 'statcan.gc.ca', title: 'Household spending on home maintenance services' },
];
const WEB_SPANS: Sp[] = [
  { id: 1, sourceIndex: 1, quote: 'Most seasonal contracts in the GTA are signed between mid-September and the first week of November, with sign-ups peaking in the first two weeks of October.' },
  { id: 2, sourceIndex: 2, quote: 'Snow removal is offered as a seasonal package. Per-visit pricing is quoted after an address check.' },
  { id: 3, sourceIndex: 3, quote: 'Browse tasks: Furniture Assembly, Mounting, Moving Help, Cleaning, Home Repairs, Yard Work.' },
  { id: 4, sourceIndex: 4, quote: 'Interest over time for “snow removal toronto” rises from 21 in the last week of September to 68 by the third week of October.' },
  { id: 5, sourceIndex: 5, quote: 'The first accumulating snowfall in southern Ontario typically arrives in the second half of November.' },
  { id: 6, sourceIndex: 6, quote: 'Canadian households spent an average of $1,161 on home maintenance and repair services.' },
];
const WEB_SENTENCES: Sent[] = [
  { text: 'Toronto homeowners sign seasonal snow-clearing contracts between mid-September and early November, and sign-ups peak in the first two weeks of October [1]. ', verdict: 'confirmed' },
  { text: 'Jiffy already sells snow removal as a seasonal package rather than an on-demand task, and quotes per-visit pricing only after an address check [2]. ', verdict: 'confirmed' },
  { text: 'TaskRabbit does not list a snow category in Toronto at all, which leaves the on-demand slot open [3]. ', verdict: 'confirmed' },
  { text: 'Search interest for “snow removal toronto” rises from 21 in the last week of September to 68 by the third week of October [4], while the first accumulating snowfall usually arrives in the second half of November [5]. ', verdict: 'confirmed' },
  { text: 'Demand therefore builds roughly six weeks before the first snow, so a campaign launched in late September would reach homeowners while they are still choosing a provider [1][4].', verdict: 'flagged', why: 'The sources establish when contracts are signed and when interest rises. Neither says that reaching homeowners earlier wins the contract — that step is the model’s, not the page’s.' },
];
const WEB_EPILOGUE = {
  related: ['What does a GTA snow-clearing visit actually cost a homeowner?', 'Did Jiffy’s seasonal package sell out last winter?', 'How early do Toronto landscapers start selling winter contracts?'],
  unanswered: ['What a snow-clearing visit costs per visit in the GTA.', 'How many Toronto households buy seasonal contracts versus per-visit clearing.'],
  note: '',
};

const G_SOURCES: Src[] = [
  { i: 1, kind: 'world', url: 'https://www.jiffyondemand.com/pricing', domain: 'jiffyondemand.com', title: 'Jiffy — what a handyman visit costs', observedAt: '2026-08-28T13:40:00.000Z' },
  { i: 2, kind: 'world', url: 'https://www.taskrabbit.ca/toronto/handyman', domain: 'taskrabbit.ca', title: 'TaskRabbit Toronto — handyman rates', observedAt: '2026-07-14T09:05:00.000Z' },
  { i: 3, kind: 'brain', url: 'taskly-brain/60-business/pricing/PRICING_v3.md § Pricing v3 › 4. Commission and what it covers', domain: 'brain', title: 'taskly-brain/60-business/pricing/PRICING_v3.md' },
  { i: 4, kind: 'brain', url: 'taskly-brain/60-business/model/COMPETITIVE-LANDSCAPE.md § Competitive landscape › 2. Jiffy', domain: 'brain', title: 'taskly-brain/60-business/model/COMPETITIVE-LANDSCAPE.md' },
  { i: 5, kind: 'ledger', url: 'prediction ledger · row pr_0142', domain: 'ledger', title: 'Jiffy raises its published GTA rate before 1 Nov 2026', observedAt: '2026-08-09T00:00:00.000Z' },
  { i: 6, kind: 'web', url: 'https://www.thestar.com/business/home-services-prices-2026/', domain: 'thestar.com', title: 'What Torontonians paid for home help this year' },
];
const G_SPANS: Sp[] = [
  { id: 1, sourceIndex: 1, quote: 'Handyman visits start at $99 for the first hour, billed in 30-minute increments after that.' },
  { id: 2, sourceIndex: 2, quote: 'Taskers set their own rates. Handyman rates in Toronto start around $45/hr.' },
  { id: 3, sourceIndex: 3, quote: 'COMMISSION_RATE = 0.2 — the poster pays the agreed deal and the Tasker receives 80% on release.' },
  { id: 4, sourceIndex: 4, quote: 'Jiffy runs a closed network of pros and does not publish per-tasker rates.' },
  { id: 5, sourceIndex: 5, quote: 'P(Jiffy raises its published GTA handyman rate before 1 Nov 2026) = 0.35.' },
  { id: 6, sourceIndex: 6, quote: 'Households in the GTA reported paying a median $120 for a single home-repair visit.' },
];
const G_SENTENCES: Sent[] = [
  { text: 'Jiffy publishes a starting price and TaskRabbit does not: Jiffy’s own page said handyman visits start at $99 for the first hour when we read it on 28 August [1], while TaskRabbit lists tasker-set rates starting around $45/hr as we read it in mid-July [2]. ', verdict: 'confirmed' },
  { text: 'Our own take-rate is 20% of the agreed deal, with the Tasker receiving 80% on release [3]. ', verdict: 'confirmed' },
  { text: 'We have written down that Jiffy runs a closed network of pros and does not publish per-tasker rates [4]. ', verdict: 'confirmed' },
  { text: 'We put 35% on Jiffy raising its published GTA handyman rate before 1 November [5]. ', verdict: 'confirmed' },
  { text: 'A poster comparing the two therefore sees our commission before they see a rate [3][6].', verdict: 'flagged', why: 'The quotes establish our take-rate and a median paid price. Neither says anything about what a poster sees first, or in what order — that step is the model’s, not the record’s.' },
];
const G_EPILOGUE = {
  related: ['What did Jiffy’s page say the last three times we read it?', 'Which of our pricing decisions has no ledger row behind it?', 'What have we forecast about TaskRabbit that has already resolved?'],
  unanswered: ['What Jiffy charges after the first hour — we recorded the starting price only.', 'Whether TaskRabbit’s July rate still holds; nothing newer has been read.'],
  note: '',
};

const D_CLARIFY = {
  because: 'Two to four minutes is a long time to spend on the wrong reading of this. “Pricing against them” could mean our commission, what a poster pays at checkout, or what a Tasker takes home — and those three have different answers and different competitors.',
  questions: [
    'Which price do you mean — our commission, what a poster pays at checkout, or what a Tasker takes home?',
    'All categories, or the curated fixed-price flows only?',
    'GTA only, or does the answer have to hold if we open a second city?',
  ],
};
const D_PLAN_1 = { steps: [
  { n: 1, question: 'What do Jiffy and TaskRabbit charge a GTA poster right now, end to end?', why: 'Our number is only comparable against theirs at the same point in the flow.' },
  { n: 2, question: 'How have those two prices moved over the last four quarters?', why: 'One reading cannot tell a trend from a promotion.' },
  { n: 3, question: 'What does a GTA Tasker take home per job on each platform?', why: 'Supply follows take-home, and a take-rate that starves supply is not a price.' },
  { n: 4, question: 'What have we already written down about our own fee model, and why?', why: 'A pricing call has to be consistent with the one already made, or say that it overturns it.' },
] };
const D_PLAN_2 = {
  revisedBecause: 'Step 2 proved nothing: neither site publishes a price history, and the archive snapshots that would show the movement are not fetchable. The trend has to come from our own readings of them — a question our records can actually answer.',
  steps: [
    D_PLAN_1.steps[0]!,
    { n: 2, question: 'What did our own world model record for those prices each time we read them?', why: 'We have dated readings of both pages. That is a history their sites do not publish.' },
    D_PLAN_1.steps[2]!,
    D_PLAN_1.steps[3]!,
    { n: 5, question: 'What would a change in our take-rate do to what a Tasker earns per job?', why: 'The two numbers move together, and setting one without the other is half a decision.' },
  ],
};
const D_SOURCES: Src[] = [
  G_SOURCES[0]!, G_SOURCES[1]!, G_SOURCES[2]!,
  { i: 4, kind: 'brain', url: 'taskly-brain/70-decisions/ADR-005-two-sided-fee-model.md § ADR-005 › The poster side', domain: 'brain', title: 'taskly-brain/70-decisions/ADR-005-two-sided-fee-model.md' },
  { ...G_SOURCES[5]!, i: 5 },
  { ...WEB_SOURCES[5]!, i: 6 },
];
const D_SPANS: Sp[] = [
  G_SPANS[0]!, G_SPANS[1]!, G_SPANS[2]!,
  { id: 4, sourceIndex: 4, quote: 'The poster platform fee is max(4.9%, $2.99), charged once, at hire.' },
  { id: 5, sourceIndex: 5, quote: 'Households in the GTA reported paying a median $120 for a single home-repair visit.' },
  { id: 6, sourceIndex: 6, quote: 'Canadian households spent an average of $1,161 on home maintenance and repair services.' },
];
const D_SENTENCES: Sent[] = [
  { text: 'Jiffy’s own page said handyman visits start at $99 for the first hour when we read it on 28 August [1], while TaskRabbit lists tasker-set rates starting around $45/hr as we read it in mid-July [2]. ', verdict: 'confirmed' },
  { text: 'Our take-rate is 20% of the agreed deal with the Tasker receiving 80% on release [3], and the poster pays max(4.9%, $2.99) once, at hire [4]. ', verdict: 'confirmed' },
  { text: 'Against a median $120 GTA repair visit [5] that puts the poster-side add-on at $5.88 and the Tasker’s take at $96. ', verdict: 'flagged', why: 'The $120 median and both fee rules are quoted correctly. The two dollar figures are arithmetic this run did — neither $5.88 nor $96 appears in any span it cites.' },
  { text: 'Neither competitor publishes a price history, so nothing here establishes a trend: there are two readings, six weeks apart [1][2]. ', verdict: 'confirmed' },
  { text: 'For scale, Canadian households spend an average of $1,161 a year on home maintenance and repair services [6].', verdict: 'confirmed' },
];
const D_EPILOGUE = {
  related: ['What would our take-home look like to a Tasker at 15% instead of 20%?', 'Which of our competitors’ prices have we read more than twice?', 'What did we decide about the poster fee label, and is it still open?'],
  unanswered: ['What a poster pays end to end on either platform — neither publishes an all-in total.', 'How either price has moved: no fetchable history exists on either site.', 'Whether any of this holds outside the GTA.'],
  note: '',
};

/** Deterministic 2–7 character pieces that cut through markers, so the held-bracket path runs every replay. */
function chunk(text: string): string[] {
  const out: string[] = [];
  let i = 0, k = 0;
  while (i < text.length) { const n = 2 + ((k++ * 7 + 3) % 6); out.push(text.slice(i, i + n)); i += n; }
  return out;
}

class Clock {
  t = 0;
  out: Timed[] = [];
  at(dt: number, event: string, data: unknown) { this.t += dt; this.out.push({ at: this.t, frame: { event, data } }); }
  write(sentences: Sent[], settle: number) {
    sentences.forEach((s, n) => {
      for (const piece of chunk(s.text)) this.at(24, 'delta', { n, text: piece });
      this.out.push({ at: this.t + settle, frame: { event: 'sentence', data: { n, verdict: s.verdict, why: s.why } } });
    });
  }
}

function webScript(): Timed[] {
  const c = new Clock();
  c.at(90, 'status', { phase: 'planning' });
  c.at(560, 'status', { phase: 'searching', detail: 'toronto snow removal seasonal contract timing · jiffy snow removal pricing toronto · taskrabbit toronto snow' });
  c.at(800, 'status', { phase: 'reading', detail: '27 result(s)' });
  WEB_SOURCES.forEach((s, i) => c.at(i === 0 ? 300 : 700, 'source', s));
  c.at(240, 'status', { phase: 'attributing', detail: `${WEB_SOURCES.length} document(s)` });
  WEB_SPANS.forEach((s, i) => c.at(i === 0 ? 120 : 60, 'span', s));
  c.at(340, 'status', { phase: 'writing' });
  c.write(WEB_SENTENCES, 900);
  c.at(900, 'status', { phase: 'checking' });
  c.at(500, 'status', { phase: 'done', detail: `${WEB_SENTENCES.length} sentence(s), 1 flagged` });
  c.at(150, 'epilogue', WEB_EPILOGUE);
  c.at(150, 'done', { costCents: 0.24, threadId: null, messageId: null, flagged: 1 });
  return c.out;
}

function groundedScript(): Timed[] {
  const c = new Clock();
  c.at(90, 'status', { phase: 'planning' });
  c.at(480, 'status', { phase: 'reading', detail: 'the world model, findings, the Brain and the ledger' });
  c.at(620, 'status', { phase: 'attributing', detail: `${G_SOURCES.length} internal record(s)` });
  G_SOURCES.forEach((s, i) => c.at(i === 0 ? 260 : 380, 'source', s));
  G_SPANS.forEach((s, i) => c.at(i === 0 ? 110 : 55, 'span', s));
  c.at(120, 'unused', { dropped: [{ span: 'Jiffy charges a $15 booking fee.', why: 'superseded — a later reading of the same page no longer carries it' }], expectations: [{ id: 'pr_0142', locator: 'prediction ledger · row pr_0142', title: 'Jiffy raises its rate', claim: 'Jiffy raises its published GTA handyman rate before 1 Nov 2026', p: 0.35, resolveAt: '2026-11-01' }] });
  c.at(300, 'status', { phase: 'writing' });
  c.write(G_SENTENCES, 800);
  c.at(800, 'status', { phase: 'checking' });
  c.at(500, 'status', { phase: 'done', detail: `${G_SENTENCES.length} sentence(s), 1 flagged` });
  c.at(150, 'epilogue', G_EPILOGUE);
  c.at(150, 'done', { costCents: 0.06, threadId: null, messageId: null, flagged: 1 });
  return c.out;
}

function deepScript(): Timed[] {
  const c = new Clock();
  c.at(120, 'status', { phase: 'planning', detail: 'breaking the question into steps' });
  c.at(1500, 'plan', D_PLAN_1);
  c.at(700, 'step', { n: 1, state: 'running', detail: 'jiffyondemand.com · taskrabbit.ca · 7 more' });
  c.at(200, 'status', { phase: 'searching', detail: 'step 1: jiffy handyman price toronto · taskrabbit toronto rates' });
  c.at(2600, 'status', { phase: 'reading', detail: 'step 1: 31 result(s)' });
  c.at(1800, 'step', { n: 1, state: 'done', found: 2, detail: '9 pages read' });
  c.at(500, 'reflect', { after: 1, note: 'Both publish a starting price and neither publishes an all-in total, so an end-to-end comparison has to be assembled rather than read off a page.', stillOpen: ['What a poster actually pays after fees on either platform', 'Whether the starting price includes a callout charge'] });
  c.at(600, 'step', { n: 2, state: 'running', detail: 'archive.org · pricing pages, 2025 snapshots' });
  c.at(3400, 'step', { n: 2, state: 'done', found: 0, detail: '11 pages read, none quotable' });
  c.at(500, 'reflect', { after: 2, note: 'Nothing survived the check. Both sites carry only today’s price, and the archived snapshots that would show the movement did not fetch.', stillOpen: ['How either price has moved since 2025'] });
  c.at(900, 'plan', D_PLAN_2);
  c.at(400, 'step', { n: 2, state: 'running', detail: 'our world model — readings of both pages' });
  c.at(2100, 'step', { n: 2, state: 'done', found: 2, detail: '2 dated readings' });
  c.at(200, 'source', D_SOURCES[0]); c.at(420, 'source', D_SOURCES[1]);
  c.at(500, 'step', { n: 3, state: 'running', detail: 'tasker earnings, both platforms' });
  c.at(2300, 'step', { n: 3, state: 'done', found: 1, detail: '6 pages read' });
  c.at(400, 'step', { n: 4, state: 'running', detail: 'our own documents' });
  c.at(300, 'source', D_SOURCES[2]); c.at(400, 'source', D_SOURCES[3]);
  c.at(1200, 'step', { n: 4, state: 'done', found: 1, detail: 'PRICING_v3 · ADR-005' });
  c.at(500, 'step', { n: 5, state: 'skipped', detail: 'nothing to retrieve — it is arithmetic on the other four' });
  c.at(200, 'source', D_SOURCES[4]); c.at(420, 'source', D_SOURCES[5]);
  c.at(400, 'reflect', { after: 5, note: 'The plan is answered for the GTA and for our own fee model. The second-city part of the question is not, and more searching will not settle it.', stillOpen: ['Whether any of this holds outside the GTA'], stop: 'the plan is answered — what is left needs a market we have no evidence for, not more searching' });
  c.at(600, 'status', { phase: 'attributing', detail: `${D_SOURCES.length} document(s)` });
  D_SPANS.forEach((s, i) => c.at(i === 0 ? 150 : 70, 'span', s));
  c.at(500, 'status', { phase: 'writing' });
  c.write(D_SENTENCES, 850);
  c.at(850, 'status', { phase: 'checking' });
  c.at(500, 'status', { phase: 'done', detail: `${D_SENTENCES.length} sentence(s), 1 flagged` });
  c.at(150, 'epilogue', D_EPILOGUE);
  c.at(200, 'done', { costCents: 2.84, threadId: null, messageId: null, flagged: 1 });
  return c.out;
}

/** The frames a scripted run plays. Deep asks to clarify first, once, on the first question of a conversation. */
export function demoScript(mode: Mode, { firstTurn, answered }: { firstTurn: boolean; answered: boolean }): Timed[] {
  if (mode === 'deep') {
    if (firstTurn && !answered) return [{ at: 150, frame: { event: 'status', data: { phase: 'planning', detail: 'checking the question is specific enough to research' } } }, { at: 780, frame: { event: 'clarify', data: D_CLARIFY } }];
    return deepScript();
  }
  return mode === 'grounded' ? groundedScript() : webScript();
}

export const DEMO_QUESTION: Record<Mode, string> = {
  web: 'Should we run a snow-removal campaign in Toronto this October?',
  grounded: 'What do we know about how Jiffy prices a handyman visit?',
  verified: 'Should we run a snow-removal campaign in Toronto this October?',
  deep: 'How should we price against Jiffy and TaskRabbit next quarter?',
};
