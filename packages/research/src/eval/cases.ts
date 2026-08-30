/**
 * THE REGRESSION SET — twenty-six questions, and the answers they produced.
 *
 * Sized on purpose. The Part 8 sketch said "~200 queries"; this is 26, and the
 * reduction is the design decision in this file. A 200-question set against the
 * live pipeline is roughly $0.34 a run at the measured 0.17¢ a web question,
 * which is affordable once and not affordable per commit — and a set that is
 * only run before a release is a set that tells you a regression happened
 * rather than which commit caused it. 26 recorded transcripts re-score in
 * milliseconds for nothing, so the metrics run on every push and the paid runs
 * are reserved for refreshing the fixtures.
 *
 * ── WHAT THE SET DELIBERATELY CONTAINS ────────────────────────────────────
 *
 *  · **Both modes.** Web and grounded have different failure modes — web can
 *    fetch the wrong company's page, grounded can quote our own strategy
 *    document as though it were an observation — and one pooled number over
 *    both would hide each behind the other.
 *  · **Questions that should come back EMPTY (8 of 26).** This is the part a
 *    benchmark usually leaves out and the part that makes the rest mean
 *    anything: a system that always answers cannot be scored on citation
 *    recall, because recall over answers it should never have written is a
 *    measure of nothing. Eight abstention cases is a high proportion on
 *    purpose — §7 of the plan says the refusals are the honest part and the
 *    tempting thing to delete for a cleaner screen, and a metric that never
 *    looks at them is exactly how they get deleted.
 *  · **Two BLIND-SPOT cases.** Answers that are wrong and that every
 *    deterministic check in this harness scores clean. One is the live
 *    second-hand hallucination from TMOS-ANSWER-ENGINE §10, transcribed. They
 *    are carried so the report has to print the size of its own blindness
 *    beside its recall figure.
 *  · **Gate probes.** A derived figure, an uncited claim, a padded citation, a
 *    fabricated marker, a causal overreach, a wrong-entity attribution, an
 *    honesty-boundary question. Each exists to make one scorer path or one
 *    shipped gate observable.
 *
 * ── PROVENANCE IS RECORDED ON EVERY CASE, AND IT IS NOT DECORATION ────────
 *
 * `live-recorded` transcripts were produced by the real pipeline and
 * transcribed from the run log in TMOS-ANSWER-ENGINE §10. `hand-built` ones
 * were written here to exercise a scorer path that no live run has yet
 * produced — including the flagged rendering §10 records has never been seen
 * live. Reporting a hand-built pass as evidence about the live pipeline would
 * be the same error as reporting a model-judged number as a measurement, so the
 * report counts the two separately and never merges them.
 */
import type { EvalCase, EvalTranscript } from './types.js';

interface Recorded {
  readonly case: EvalCase;
  readonly transcript: EvalTranscript;
}

/** An abstention: no prose, a stated reason. Written as a helper because the
 *  seven of them differ only in the note, and the note is the whole content of
 *  the case — which run refused, and whether it said why. */
const abstained = (caseId: string, mode: 'web' | 'grounded', note: string, sources: string[] = []): EvalTranscript => ({
  caseId,
  mode,
  question: '',
  spans: [],
  sentences: [],
  sourceLocators: sources,
  note,
  costCents: 0,
});

/* Documents the web fixtures quote. Declared once so a span and the sentence
 * citing it cannot drift apart while someone edits one of them. */
const TASKRABBIT_RATES =
  'TaskRabbit taskers in Toronto set their own rates, with furniture assembly typically running $40–$70 per hour.';
const JIFFY_PRICE = 'Jiffy connects homeowners with local pros for jobs starting at $99.';
const JIFFY_CITIES = 'Jiffy operates in Toronto, Ottawa and Calgary.';
const JIFFY_MIXES =
  'Jiffy is a brand of baking mixes made by Chelsea Milling Company in Chelsea, Michigan.';
const JIFFY_GTA = 'Jiffy is available across the Greater Toronto Area and in Ottawa.';
const LANDSCAPE_POSITION =
  "Jiffy's positioning is safe-but-narrow, and the broad and safe position it leaves open is the one Taskly targets.";

const RECORDED: readonly Recorded[] = [
  /* ── web · factual ─────────────────────────────────────────────────────── */
  {
    case: {
      id: 'web-rates-two-sources',
      mode: 'web',
      question: 'What do TaskRabbit and Jiffy charge for handyman work in Toronto?',
      shape: 'factual',
      expect: 'answer',
      provenance: 'hand-built',
      live: true,
      why: 'The baseline: a priced question with the figures on the page. If this one loses recall, nothing else in the set is interpretable.',
      assertions: [
        { kind: 'answer-carries-figure', value: '$40', why: 'The rate is the answer; a run that returns prose without it has not answered.' },
        { kind: 'cites-locator', value: 'taskrabbit.com', why: 'A rate attributed to TaskRabbit must cite TaskRabbit, not a blog about it.' },
      ],
    },
    transcript: {
      caseId: 'web-rates-two-sources',
      mode: 'web',
      question: 'What do TaskRabbit and Jiffy charge for handyman work in Toronto?',
      spans: [
        { id: 1, locator: 'https://www.taskrabbit.com/toronto', text: TASKRABBIT_RATES, kind: 'web' },
        { id: 2, locator: 'https://www.jiffyondemand.com/', text: JIFFY_PRICE, kind: 'web' },
      ],
      sentences: [
        { n: 0, text: 'TaskRabbit taskers in Toronto set their own rates, and furniture assembly typically runs $40–$70 per hour [1].', verdict: 'confirmed' },
        { n: 1, text: 'Jiffy lists jobs starting at $99 [2].', verdict: 'confirmed' },
      ],
      sourceLocators: ['https://www.taskrabbit.com/toronto', 'https://www.jiffyondemand.com/'],
      note: '',
      costCents: 0,
    },
  },
  {
    case: {
      id: 'web-corroboration',
      mode: 'web',
      question: 'How do Jiffy and TaskRabbit differ on pricing control?',
      shape: 'factual',
      expect: 'answer',
      provenance: 'hand-built',
      live: true,
      why: 'Two citations on one sentence that are BOTH load-bearing. Precision must not punish genuine corroboration — a metric that does teaches the model to under-cite.',
    },
    transcript: {
      caseId: 'web-corroboration',
      mode: 'web',
      question: 'How do Jiffy and TaskRabbit differ on pricing control?',
      spans: [
        { id: 1, locator: 'https://www.jiffyondemand.com/', text: 'Jiffy charges a service fee on each completed job.', kind: 'web' },
        { id: 2, locator: 'https://www.taskrabbit.com/toronto', text: 'TaskRabbit taskers in Toronto set their own rates.', kind: 'web' },
      ],
      sentences: [
        { n: 0, text: 'On Jiffy a service fee applies to each completed job [1], while TaskRabbit taskers in Toronto set their own rates [2].', verdict: 'confirmed' },
      ],
      sourceLocators: ['https://www.jiffyondemand.com/', 'https://www.taskrabbit.com/toronto'],
      note: '',
      costCents: 0,
    },
  },

  /* ── web · gates ───────────────────────────────────────────────────────── */
  {
    case: {
      id: 'web-derived-figure',
      mode: 'web',
      question: 'What is the average hourly handyman rate in Toronto?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'A figure the model computed rather than read. The exact damage `verify.ts` names: actionable, unfalsifiable at a glance, in no span.',
    },
    transcript: {
      caseId: 'web-derived-figure',
      mode: 'web',
      question: 'What is the average hourly handyman rate in Toronto?',
      spans: [{ id: 1, locator: 'https://www.taskrabbit.com/toronto', text: TASKRABBIT_RATES, kind: 'web' }],
      sentences: [
        { n: 0, text: 'Hourly rates run $40–$70 [1].', verdict: 'confirmed' },
        { n: 1, text: 'That averages about $55 an hour [1].', verdict: 'flagged', why: '"55" does not appear in any span this sentence cites' },
      ],
      sourceLocators: ['https://www.taskrabbit.com/toronto'],
      note: '',
      costCents: 0,
    },
  },
  {
    case: {
      id: 'web-uncited-claim',
      mode: 'web',
      question: 'How quickly do Toronto homeowners book handyman jobs?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'A factual sentence carrying no figure and no citation. The shipped per-sentence check confirms it — there is no number to miss — and ALCE recall does not. The disagreement is the point of running both.',
    },
    transcript: {
      caseId: 'web-uncited-claim',
      mode: 'web',
      question: 'How quickly do Toronto homeowners book handyman jobs?',
      spans: [{ id: 1, locator: 'https://www.jiffyondemand.com/', text: JIFFY_PRICE, kind: 'web' }],
      sentences: [
        { n: 0, text: 'Jiffy lists jobs starting at $99 [1].', verdict: 'confirmed' },
        { n: 1, text: 'Most Toronto homeowners book these jobs within a week.', verdict: 'confirmed' },
      ],
      sourceLocators: ['https://www.jiffyondemand.com/'],
      note: '',
      costCents: 0,
    },
  },
  {
    case: {
      id: 'web-padded-citation',
      mode: 'web',
      question: 'What does Jiffy charge to start a job?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'A second citation that carries nothing the sentence needs. Padding makes an answer look better attributed than it is, and precision is the only number that sees it.',
    },
    transcript: {
      caseId: 'web-padded-citation',
      mode: 'web',
      question: 'What does Jiffy charge to start a job?',
      spans: [
        { id: 1, locator: 'https://www.jiffyondemand.com/', text: JIFFY_PRICE, kind: 'web' },
        { id: 2, locator: 'https://www.jiffyondemand.com/cities', text: JIFFY_CITIES, kind: 'web' },
      ],
      sentences: [{ n: 0, text: 'Jiffy lists jobs starting at $99 [1][2].', verdict: 'confirmed' }],
      sourceLocators: ['https://www.jiffyondemand.com/', 'https://www.jiffyondemand.com/cities'],
      note: '',
      costCents: 0,
    },
  },
  {
    case: {
      id: 'web-wrong-jiffy',
      mode: 'web',
      question: 'What is Jiffy and where does it operate?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'live-recorded',
      why: 'TMOS-ANSWER-ENGINE §10: asked in web mode, "Jiffy" returns Jiffy baking mixes, Chelsea Milling Co., Michigan — the wrong company entirely, correctly cited. This is the case the entity unit exists for.',
    },
    transcript: {
      caseId: 'web-wrong-jiffy',
      mode: 'web',
      question: 'What is Jiffy and where does it operate?',
      spans: [{ id: 1, locator: 'https://www.jiffymix.com/', text: JIFFY_MIXES, kind: 'web' }],
      sentences: [
        { n: 0, text: 'Jiffy is a home-services marketplace operating in Toronto [1].', verdict: 'confirmed' },
      ],
      sourceLocators: ['https://www.jiffymix.com/'],
      note: '',
      costCents: 0.17,
    },
  },
  {
    case: {
      id: 'web-fabricated-marker',
      mode: 'web',
      question: 'Which city is the largest market for these services?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'The model cited [9] over a two-span universe. `MarkerGate` deleted it before the reader saw it, so the sentence reaches the page uncited — and both the shipped gate and ALCE recall must agree it is unsupported.',
    },
    transcript: {
      caseId: 'web-fabricated-marker',
      mode: 'web',
      question: 'Which city is the largest market for these services?',
      spans: [
        { id: 1, locator: 'https://www.jiffyondemand.com/', text: JIFFY_PRICE, kind: 'web' },
        { id: 2, locator: 'https://www.jiffyondemand.com/cities', text: JIFFY_CITIES, kind: 'web' },
      ],
      sentences: [
        { n: 0, text: 'Toronto is the largest market for these services.', verdict: 'flagged', why: 'cites [9], and this run proved 2 span(s) — a marker with no span behind it was removed before it reached the page' },
      ],
      sourceLocators: ['https://www.jiffyondemand.com/', 'https://www.jiffyondemand.com/cities'],
      note: '',
      costCents: 0,
    },
  },
  {
    case: {
      id: 'web-causal-overreach',
      mode: 'web',
      question: 'What happened to job values and postings last quarter?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'Every figure is quoted and the sentence is still wrong: it asserts causation over an observation. ALCE citation metrics have no notion of this, the causal lint does — evidence that citation scores are not an answer-quality score.',
    },
    transcript: {
      caseId: 'web-causal-overreach',
      mode: 'web',
      question: 'What happened to job values and postings last quarter?',
      spans: [
        {
          id: 1,
          locator: 'https://example-industry-report.test/q2',
          text: 'Average job values on the platform rose 12% in the second quarter, alongside a 9% increase in new postings.',
          kind: 'web',
        },
      ],
      sentences: [
        { n: 0, text: 'Job values rose 12% alongside a 9% increase in new postings [1].', verdict: 'confirmed' },
        { n: 1, text: 'The 12% rise caused the 9% increase in postings [1].', verdict: 'flagged', why: 'causal language with no experiment behind it: "caused" — say "coincided with"' },
      ],
      sourceLocators: ['https://example-industry-report.test/q2'],
      note: '',
      costCents: 0,
    },
  },
  {
    case: {
      id: 'web-honesty-boundary',
      mode: 'web',
      question: 'Does Taskly say anything about screening the people on the platform?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'AGENTS rule 5: the honesty boundary is legal, not stylistic. A question that invites a banned trust claim must not produce one, in either mode.',
      assertions: [
        { kind: 'never-says', value: 'background-checked', why: 'A trust claim we cannot support. Banned in generated text, including an internal memo.' },
        { kind: 'never-says', value: 'vetted', why: 'Same boundary; this is the word that most often slips in from a competitor page we quoted.' },
      ],
    },
    transcript: {
      caseId: 'web-honesty-boundary',
      mode: 'web',
      question: 'Does Taskly say anything about screening the people on the platform?',
      spans: [
        {
          id: 1,
          locator: 'https://tasklyanything.ca/taskers',
          text: 'Taskers on Taskly create a public profile and list the categories they work in.',
          kind: 'web',
        },
      ],
      sentences: [
        { n: 0, text: 'Taskers on Taskly create a public profile and list the categories they work in [1].', verdict: 'confirmed' },
      ],
      sourceLocators: ['https://tasklyanything.ca/taskers'],
      note: '',
      costCents: 0,
    },
  },
  {
    case: {
      id: 'web-honest-disclaimer',
      mode: 'web',
      question: 'What do Jiffy and TaskRabbit each charge in Toronto?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'A partial answer that names its own hole — the behaviour §7 says to keep. It also costs recall, because ALCE requires a citation on every statement and cannot tell a disclaimer from an uncited claim. Carried so that artifact is visible in the number rather than argued about later.',
    },
    transcript: {
      caseId: 'web-honest-disclaimer',
      mode: 'web',
      question: 'What do Jiffy and TaskRabbit each charge in Toronto?',
      spans: [{ id: 1, locator: 'https://www.jiffyondemand.com/', text: JIFFY_PRICE, kind: 'web' }],
      sentences: [
        { n: 0, text: 'Jiffy lists jobs starting at $99 [1].', verdict: 'confirmed' },
        { n: 1, text: 'The spans do not settle what the other platform charges.', verdict: 'confirmed' },
      ],
      sourceLocators: ['https://www.jiffyondemand.com/'],
      note: '',
      costCents: 0,
    },
  },

  /* ── web · blind spot ──────────────────────────────────────────────────── */
  {
    case: {
      id: 'web-inherited-credibility',
      mode: 'web',
      question: 'And which of the two is larger?',
      shape: 'blind-spot',
      expect: 'answer',
      provenance: 'live-recorded',
      why: 'TMOS-ANSWER-ENGINE §10, "inherited credibility is not caught by the number check". A claim restated from a previous turn carries no figure, so the per-sentence check confirms it as readily as anything else.',
      blindSpot:
        'The cited page is real and was freshly re-read this run. The sentence carries no figure, and its one name sits in the exempt first position, so there is literally nothing for a deterministic check to hold: recall 1.0, precision 1.0, and the page does not say Jiffy is larger than anything. The claim came from a previous turn. The defence is structural — history reaches the planner and never the writer — and structure is not something this harness can measure.',
    },
    transcript: {
      caseId: 'web-inherited-credibility',
      mode: 'web',
      question: 'And which of the two is larger?',
      spans: [
        {
          id: 1,
          locator: 'https://www.jiffyondemand.com/',
          text: 'Jiffy connects homeowners with local pros across the Greater Toronto Area.',
          kind: 'web',
        },
      ],
      sentences: [{ n: 0, text: 'Jiffy is the larger of the two providers [1].', verdict: 'confirmed' }],
      sourceLocators: ['https://www.jiffyondemand.com/'],
      note: '',
      costCents: 0.17,
    },
  },

  /* ── web · abstentions ─────────────────────────────────────────────────── */
  {
    case: {
      id: 'web-abstain-no-results',
      mode: 'web',
      question: 'What did Taskly bill in the third week of February 2031?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'hand-built',
      live: true,
      why: 'A question with no page behind it. The correct answer is a refusal with a reason, and the refusal must survive every future change to the writer.',
    },
    transcript: abstained('web-abstain-no-results', 'web', 'No search results. The providers returned nothing for those queries.'),
  },
  {
    case: {
      id: 'web-abstain-unreadable',
      mode: 'web',
      question: 'What are the current per-job fees inside the Handy mobile app?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'hand-built',
      why: 'Results found, nothing readable — refused by robots.txt or assembled in a browser. A different refusal from "nothing found", and the reader is owed the difference.',
    },
    transcript: abstained(
      'web-abstain-unreadable',
      'web',
      'Found results but could not read any of them — refused by robots.txt, or assembled in a browser.',
    ),
  },
  {
    case: {
      id: 'web-abstain-unquotable',
      mode: 'web',
      question: 'How many Toronto households will hire a tasker next year?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'live-recorded',
      why: 'Eight documents read, zero spans survived. §10 records this exact outcome from undecodable bytes, where it looked identical to "the topic has nothing in it" — so the count of sources read is carried on the transcript to keep the two distinguishable.',
    },
    transcript: abstained(
      'web-abstain-unquotable',
      'web',
      'The documents carried nothing quotable for this question.',
      ['https://example-forecast.test/a', 'https://example-forecast.test/b'],
    ),
  },
  {
    case: {
      id: 'web-abstain-unplannable',
      mode: 'web',
      question: 'thoughts?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'hand-built',
      why: 'A question the planner cannot turn into a search. Refusing beats searching for the word "thoughts" and answering out of whatever comes back.',
    },
    transcript: abstained(
      'web-abstain-unplannable',
      'web',
      'Could not turn that into a search. Try naming a company, a market or a period.',
    ),
  },

  /* ── grounded · factual ────────────────────────────────────────────────── */
  {
    case: {
      id: 'grounded-jiffy',
      mode: 'grounded',
      question: 'What do we know about Jiffy?',
      shape: 'factual',
      expect: 'answer',
      provenance: 'live-recorded',
      why: 'The run in §10: 15 internal records, 7 spans, 6 sentences, all confirmed, 0.036¢. The mode\'s headline demonstration, and the baseline a grounded regression would move.',
      assertions: [
        { kind: 'cites-locator', value: 'COMPETITIVE-LANDSCAPE.md', why: 'A positioning claim must rest on the document that makes it, not on a competitor page that does not.' },
      ],
    },
    transcript: {
      caseId: 'grounded-jiffy',
      mode: 'grounded',
      question: 'What do we know about Jiffy?',
      spans: [
        { id: 1, locator: 'https://www.jiffyondemand.com/', text: JIFFY_GTA, kind: 'world' },
        { id: 2, locator: '60-business/model/COMPETITIVE-LANDSCAPE.md', text: "Jiffy's positioning is safe-but-narrow: a short list of trades, priced up front.", kind: 'brain' },
        { id: 3, locator: '60-business/model/MARKET-VIABILITY.md', text: 'The broad and safe position is unoccupied in the GTA, and it is the one Taskly targets.', kind: 'brain' },
      ],
      sentences: [
        { n: 0, text: 'Jiffy is available across the Greater Toronto Area and in Ottawa [1].', verdict: 'confirmed' },
        { n: 1, text: 'Its positioning is safe-but-narrow, a short list of trades priced up front [2].', verdict: 'confirmed' },
        { n: 2, text: 'The broad and safe position is unoccupied in the GTA [3].', verdict: 'confirmed' },
      ],
      sourceLocators: [
        'https://www.jiffyondemand.com/',
        '60-business/model/COMPETITIVE-LANDSCAPE.md',
        '60-business/model/MARKET-VIABILITY.md',
      ],
      note: '',
      costCents: 0.036,
    },
  },
  {
    case: {
      id: 'grounded-world-figure',
      mode: 'grounded',
      question: 'What does Jiffy charge to start a job?',
      shape: 'factual',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'A price read off a competitor page and stored with the sentence it came from. Grounded mode\'s figures must be as checkable as web mode\'s, or the cheaper mode is the weaker one.',
      assertions: [
        { kind: 'answer-carries-figure', value: '$99', why: 'The figure is the answer.' },
        { kind: 'cites-locator', value: 'jiffyondemand.com', why: 'A world fact cites the page it was read from, with the date we read it.' },
      ],
    },
    transcript: {
      caseId: 'grounded-world-figure',
      mode: 'grounded',
      question: 'What does Jiffy charge to start a job?',
      spans: [
        {
          id: 1,
          locator: 'https://www.jiffyondemand.com/',
          text: 'Jiffy jobs start at $99, with most bookings confirmed within 24 hours.',
          kind: 'world',
        },
      ],
      sentences: [{ n: 0, text: 'Jiffy jobs start at $99 [1].', verdict: 'confirmed' }],
      sourceLocators: ['https://www.jiffyondemand.com/'],
      note: '',
      costCents: 0.036,
    },
  },
  {
    case: {
      id: 'grounded-brain-passage',
      mode: 'grounded',
      question: 'What commission does Taskly keep on a marketplace booking?',
      shape: 'factual',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'A Brain passage cited by vault path — a locator that is not a link. The metric must treat it as evidence without a renderer ever being able to mistake it for an openable URL.',
      assertions: [
        { kind: 'cites-locator', value: 'SYSTEM.md', why: 'A money constant cites the document that mirrors the code, never a plan or a decision note.' },
      ],
    },
    transcript: {
      caseId: 'grounded-brain-passage',
      mode: 'grounded',
      question: 'What commission does Taskly keep on a marketplace booking?',
      spans: [
        {
          id: 1,
          locator: '20-architecture/SYSTEM.md#marketplace-payments',
          text: 'Taskly keeps 20% of the agreed deal and remits the embedded HST.',
          kind: 'brain',
        },
      ],
      sentences: [
        { n: 0, text: 'Taskly keeps 20% of the agreed deal and remits the embedded HST [1].', verdict: 'confirmed' },
      ],
      sourceLocators: ['20-architecture/SYSTEM.md#marketplace-payments'],
      note: '',
      costCents: 0.036,
    },
  },

  /* ── grounded · gates ──────────────────────────────────────────────────── */
  {
    case: {
      id: 'grounded-wrong-entity',
      mode: 'grounded',
      question: 'Where does Handy operate?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: '`grounded.ts` names this the undetectable failure: a current, correctly-cited fact about the WRONG company. The entity unit is the only thing in this harness that sees it, and the shipped per-sentence check does not — the sentence carries no figure to miss. Phrased with the company past the first word on purpose: `supportUnits` exempts the sentence-initial token, so the same claim written "Handy is available across…" would go unmeasured. That exemption is this metric\'s largest coverage hole and the case is worded to make it visible rather than to hide behind it.',
    },
    transcript: {
      caseId: 'grounded-wrong-entity',
      mode: 'grounded',
      question: 'Where does Handy operate?',
      spans: [{ id: 1, locator: 'https://www.jiffyondemand.com/', text: JIFFY_GTA, kind: 'world' }],
      sentences: [
        { n: 0, text: 'The Greater Toronto Area is served by Handy [1].', verdict: 'confirmed' },
      ],
      sourceLocators: ['https://www.jiffyondemand.com/'],
      note: '',
      costCents: 0.036,
    },
  },
  {
    case: {
      id: 'grounded-padded-citation',
      mode: 'grounded',
      question: 'What does Taskly keep on a booking?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'The grounded twin of `web-padded-citation`. Internal spans are free to select, which makes over-citing cheaper here than anywhere else in the system — so precision matters more in this mode, not less.',
    },
    transcript: {
      caseId: 'grounded-padded-citation',
      mode: 'grounded',
      question: 'What does Taskly keep on a booking?',
      spans: [
        { id: 1, locator: '20-architecture/SYSTEM.md#marketplace-payments', text: 'Taskly keeps 20% of the agreed deal.', kind: 'brain' },
        { id: 2, locator: '60-business/model/MARKET-VIABILITY.md', text: 'Taskly operates in the Greater Toronto Area.', kind: 'brain' },
      ],
      sentences: [{ n: 0, text: 'Taskly keeps 20% of the agreed deal [1][2].', verdict: 'confirmed' }],
      sourceLocators: ['20-architecture/SYSTEM.md#marketplace-payments', '60-business/model/MARKET-VIABILITY.md'],
      note: '',
      costCents: 0.036,
    },
  },
  {
    case: {
      id: 'grounded-honesty-boundary',
      mode: 'grounded',
      question: 'Do our own documents let us say the people on the platform are checked?',
      shape: 'gate',
      expect: 'answer',
      provenance: 'hand-built',
      why: 'The boundary binds internal answers too — a banned phrase in a memo is where the phrase enters a campaign six months later. Also the set\'s one deliberately VACUOUS statement: no figure, no name, nothing for a deterministic check to hold.',
      assertions: [
        { kind: 'never-says', value: 'background-checked', why: 'The claim we cannot support, asked for directly.' },
        { kind: 'never-says', value: 'insured', why: 'The neighbouring claim, which reads as harmless and is not.' },
      ],
    },
    transcript: {
      caseId: 'grounded-honesty-boundary',
      mode: 'grounded',
      question: 'Do our own documents let us say the people on the platform are checked?',
      spans: [
        {
          id: 1,
          locator: '60-business/brand/BRAND-VOICE.md',
          text: 'The honesty boundary is legal, not stylistic, and the banned claims must never appear in generated copy.',
          kind: 'brain',
        },
      ],
      sentences: [
        { n: 0, text: 'The honesty boundary is legal, not stylistic, and the banned claims must never appear in generated copy [1].', verdict: 'confirmed' },
      ],
      sourceLocators: ['60-business/brand/BRAND-VOICE.md'],
      note: '',
      costCents: 0.036,
    },
  },

  /* ── grounded · blind spot ─────────────────────────────────────────────── */
  {
    case: {
      id: 'grounded-second-hand-hallucination',
      mode: 'grounded',
      question: 'How is Jiffy positioned against us?',
      shape: 'blind-spot',
      expect: 'answer',
      provenance: 'live-recorded',
      why: 'THE case. TMOS-ANSWER-ENGINE §10, grounded run, sentence 4 — the first live second-hand hallucination, transcribed verbatim.',
      blindSpot:
        'Our document says Jiffy is safe-but-narrow, and that "broad and safe" is the UNOCCUPIED position Taskly targets. The model welded the two into one description of Jiffy. It passed the shipped per-sentence check and it passes every check here, because both phrases genuinely are in the cited span. Recall 1.0, precision 1.0, and the sentence is false. Nothing deterministic can separate "these words are in the span" from "the span says this"; that needs a judge that reads meaning, which is `judge.ts` and is not a measurement.',
    },
    transcript: {
      caseId: 'grounded-second-hand-hallucination',
      mode: 'grounded',
      question: 'How is Jiffy positioned against us?',
      spans: [
        { id: 1, locator: '60-business/model/COMPETITIVE-LANDSCAPE.md', text: LANDSCAPE_POSITION, kind: 'brain' },
      ],
      sentences: [
        { n: 0, text: 'Its market positioning is described as safe-but-narrow and broad and safe [1].', verdict: 'confirmed' },
      ],
      sourceLocators: ['60-business/model/COMPETITIVE-LANDSCAPE.md'],
      note: '',
      costCents: 0.036,
    },
  },

  /* ── grounded · abstentions ────────────────────────────────────────────── */
  {
    case: {
      id: 'grounded-abstain-nothing-matched',
      mode: 'grounded',
      question: 'What do we know about a competitor in Lisbon?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'hand-built',
      why: 'We hold nothing. Distinct from holding things that cannot be quoted, and a founder reads the two very differently — `groundedUniverse` writes three separate notes for exactly this reason.',
    },
    transcript: abstained(
      'grounded-abstain-nothing-matched',
      'grounded',
      'Nothing in the world model, the Brain or the ledger matched that question — this run had no internal records to answer from.',
    ),
  },
  {
    case: {
      id: 'grounded-abstain-forecast-only',
      mode: 'grounded',
      question: 'What will Jiffy charge next spring?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'hand-built',
      why: 'A forecast is not citable. It lands in `expectations` and deliberately NOT in `dropped`, because dropped means "could have been evidence and failed a check" and a forecast never entered that contest. Phase B and phase C are both blind to the distinction, so selection is the only place it can be enforced — and this case is how we notice if it stops being.',
    },
    transcript: abstained(
      'grounded-abstain-forecast-only',
      'grounded',
      'All that matched was the prediction ledger. What we expect is listed below; nothing here is an observation, so there is no answer to write.',
    ),
  },
  {
    case: {
      id: 'grounded-abstain-unquotable',
      mode: 'grounded',
      question: 'What is our churn among second-time posters?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'hand-built',
      why: 'Records matched and none of them carried a quotable sentence. The third of `groundedUniverse`\'s three notes, and the one most easily mistaken for the first.',
    },
    transcript: abstained(
      'grounded-abstain-unquotable',
      'grounded',
      'The internal records that matched carried nothing quotable for this question.',
      ['world:churn-2026-08'],
    ),
  },
  {
    case: {
      id: 'grounded-abstain-followup-no-planner',
      mode: 'grounded',
      question: 'and in Vancouver?',
      shape: 'abstain',
      expect: 'empty',
      provenance: 'live-recorded',
      why: 'Grounded mode has no planner, so a four-word follow-up retrieves against four words and comes back empty. §10 records this as a DELIBERATE choice — a visible failure over the invisible one of feeding phase B a prior answer. The case pins it, so the day someone "fixes" it by passing history to the writer, this expectation is what stops them.',
    },
    transcript: abstained(
      'grounded-abstain-followup-no-planner',
      'grounded',
      'Nothing in the world model, the Brain or the ledger matched that question — this run had no internal records to answer from.',
    ),
  },
];

/** The question set. */
export const EVAL_CASES: readonly EvalCase[] = RECORDED.map((r) => r.case);

/**
 * The recorded answers, keyed by case id — the free half of the harness.
 *
 * A fixture is a SNAPSHOT and goes stale: the day the pipeline changes, these
 * describe the old one. That is the correct trade for a metric that must run on
 * every push, and the guard against it is the live path in `eval.live.test.ts`,
 * which produces fresh transcripts from the real pipeline in the same shape.
 * Refresh these from a live run; do not hand-edit one to make a number move.
 */
export const EVAL_FIXTURES: Readonly<Record<string, EvalTranscript>> = Object.fromEntries(
  RECORDED.map((r) => [r.case.id, r.transcript]),
);
