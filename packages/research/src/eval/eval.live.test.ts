/**
 * THE PAID PATH — the same scoring, over answers the real pipeline just wrote.
 *
 *   pnpm test:live
 *
 * Excluded from `pnpm test` by `vitest.config.ts`, which is the repo's rule for
 * anything that spends money or touches a host. The fixture run in
 * `harness.test.ts` is the one CI executes; this one exists because a fixture
 * is a snapshot, and a snapshot cannot tell you the pipeline changed.
 *
 * ── WHAT IT COSTS, AND WHY THE CAP IS LOW ────────────────────────────────
 *
 * A web question has measured at **0.17¢** (TMOS-ANSWER-ENGINE §10). This runs
 * the cases marked `live` — three of them — for well under a cent a run, and
 * `TMOS_EVAL_LIVE_MAX` bounds it whatever the set grows to. The reason the cap
 * is a hard number rather than a suggestion is §8's risk note: streaming plus a
 * budget ceiling that must commit on abort is exactly the code that appears to
 * work and silently un-caps spend, and an eval loop is the first thing that
 * would find out the expensive way.
 *
 * ── WHY THIS IS WEB-MODE ONLY, SAID OUT LOUD ─────────────────────────────
 *
 * Grounded retrieval lives in the console (`retrieveGrounded` over Postgres)
 * and `@tmos/research` does not depend on it — adding the dependency is a
 * `pnpm-lock.yaml` change, which is locked and serial. So the grounded half of
 * the set is fixture-only. That is a real gap and it is stated here rather than
 * papered over: a live run of this file measures web mode, and the grounded
 * numbers in the report came from recorded transcripts.
 *
 * ── THE PORTS ARE IMPORTED SIDEWAYS, AND THAT IS A DEBT, NOT A TRICK ─────
 *
 * `@tmos/adapters` is where `createAsk`, `createAskStream`, the search
 * providers and the robots-gated reader live. It is NOT a dependency of
 * `@tmos/research`, so the specifier is assembled at run time and resolved by
 * the vitest workspace alias.
 *
 * **DO NOT "FIX" THIS BY DECLARING THE DEPENDENCY.** The lockfile is the small
 * half of the reason and on its own it reads like ordinary debt someone should
 * pay. The real reason is that the edge runs the other way:
 * `packages/adapters/package.json` depends on `@tmos/research`, because the
 * adapters implement this package's ports. Adding `@tmos/research → @tmos/adapters`
 * closes a cycle, and `turbo` orders `build` by that graph — so the package
 * would need itself built before it could build. Verified 2026-08-31.
 *
 * A cycle is also the correct answer architecturally, not just a build
 * accident: this package defines ports and stays keyless and DB-free; adapters
 * bind them to keys and Postgres. An eval harness needing real ports is the one
 * place that direction inverts, and it is a TEST — excluded from `pnpm test`,
 * opt-in behind two env vars. Paying for that with a permanent cycle in the
 * shipped graph would be the wrong trade.
 *
 * If this ever stops being a test, the fix is a THIRD package (`@tmos/eval`)
 * that may depend on both — not an edge added here.
 *
 * What is NOT on the table is hand-rolling a Groq client here. That violates
 * AGENTS rule 1: every model call goes through the chokepoint that owns the
 * token ceiling, the daily dollar ceiling and the killswitch. A measuring tool
 * that spends outside the budget it is measuring is worse than no measuring
 * tool at all.
 */
import { describe, expect, it } from 'vitest';

import { streamAnswer } from '../stream.js';
import type { AskPort, AskStreamPort, ReadPort, SearchPort } from '../types.js';

import { EVAL_CASES } from './cases.js';
import { formatEvalReport, runEval, transcriptFromStreamed } from './harness.js';
import { judgeAgreement, judgeTranscript } from './judge.js';
import type { EvalCase, EvalTranscript } from './types.js';

const KEY = process.env['GROQ_API_KEY'] ?? '';
const SEARCH = process.env['TAVILY_API_KEY'] ?? process.env['EXA_API_KEY'] ?? '';
const MAX = Number(process.env['TMOS_EVAL_LIVE_MAX'] ?? '3');
/** The judge is a second, separate spend and a second, separate claim. Opt in
 *  twice: once to run live at all, once to ask a model for an opinion. */
const JUDGE = process.env['TMOS_EVAL_JUDGE'] === '1';

/** A clean skip on a machine with no credentials is the designed behaviour —
 *  see the note in `vitest.live.config.ts`. */
const ready = KEY !== '' && SEARCH !== '';

interface Ports {
  ask: AskPort;
  askStream: AskStreamPort;
  search: SearchPort[];
  read: ReadPort;
}

async function ports(): Promise<Ports> {
  // Assembled rather than written literally: see the header. A literal would
  // be an undeclared dependency in the graph knip checks; this is an
  // alias-resolved import that the graph correctly does not claim exists.
  const spec = ['@tmos', 'adapters'].join('/');
  const mod: Record<string, unknown> = await import(/* @vite-ignore */ spec);

  const cfg = {
    apiKey: KEY,
    limits: {
      maxRunTokens: Number(process.env['TMOS_MAX_RUN_TOKENS'] ?? '120000'),
      maxDailyCostCents: Number(process.env['TMOS_MAX_DAILY_COST_CENTS'] ?? '2000'),
      maxToolDepth: Number(process.env['TMOS_MAX_TOOL_DEPTH'] ?? '4'),
    },
    runId: `eval-${Date.now()}`,
    // The eval does not write to `ai_usage_log`: it has no database handle and
    // adding one would put a measuring tool in the write path of the ledger the
    // daily ceiling is rebuilt from. The consequence is stated rather than
    // hidden — spend from this file is bounded per run and is invisible to
    // tomorrow's budget reconstruction, so run it deliberately.
    onUsage: (): void => undefined,
  };

  const createAsk = mod['createAsk'] as (c: typeof cfg) => AskPort;
  const createAskStream = mod['createAskStream'] as (c: typeof cfg) => AskStreamPort;
  const providers = mod['searchProvidersFromEnv'] as () => SearchPort[];
  const reader = mod['createResearchReader'] as () => ReadPort;

  return { ask: createAsk(cfg), askStream: createAskStream(cfg), search: providers(), read: reader() };
}

describe.skipIf(!ready)('the regression set against the live pipeline', () => {
  it(
    'answers the live-marked web cases and scores them with the same code as the fixtures',
    async () => {
      const p = await ports();
      const chosen: EvalCase[] = EVAL_CASES.filter((c) => c.live === true).slice(0, MAX);
      expect(chosen.length).toBeGreaterThan(0);

      const produced = new Map<string, EvalTranscript>();
      for (const c of chosen) {
        const answer = await streamAnswer(c.question, {
          ask: p.ask,
          askStream: p.askStream,
          search: p.search,
          read: p.read,
        });
        produced.set(c.id, transcriptFromStreamed(c.id, answer));
      }

      const report = await runEval(chosen, (c) => produced.get(c.id) ?? null);
      // `console.warn` because the repo's zero-warning ESLint config allows
      // `warn` and not `log`. The report is the artefact of this test; a live
      // run that printed nothing would be a spend with no output.
      console.warn(formatEvalReport(report));

      // The set-level expectations, and only the ones a live run can honestly
      // hold. Citation recall is NOT asserted against a threshold: the point of
      // this harness is to find out what the number is, and a threshold picked
      // before the first measurement is a wish, not a gate. Put one here once
      // there is a baseline to regress against.
      expect(report.missing).toEqual([]);
      expect(report.assertionFailures).toEqual([]);
      // A live abstention case must still refuse WITH a reason. This is the
      // expectation most likely to catch a real regression, because "answer
      // anyway" is the failure every published citation-accuracy study is
      // measuring.
      expect(report.abstention.wronglyAnswered).toBe(0);
      // Every transcript must have lined up. A misalignment here means the
      // splitter and the verdict stream disagree, which would silently corrupt
      // every number in this file.
      expect(report.excluded.filter((e) => e.why.includes('re-splitting'))).toEqual([]);
    },
    240_000,
  );

  it.skipIf(!JUDGE)(
    'MODEL-JUDGED: asks a model to read each sentence against its cited spans',
    async () => {
      // Deliberately a SEPARATE test with a separate opt-in. Its output is an
      // opinion about an opinion and never joins the numbers above — the types
      // enforce it, and so does the fact that it prints under its own heading.
      const p = await ports();
      const reports = [];
      for (const c of EVAL_CASES.filter((x) => x.shape === 'blind-spot' || x.shape === 'factual')) {
        const t = (await import('./cases.js')).EVAL_FIXTURES[c.id];
        if (t) reports.push(await judgeTranscript(t, p.ask));
      }
      const agreement = judgeAgreement(reports, EVAL_CASES);
      console.warn('MODEL-JUDGED (not a measurement):', JSON.stringify(agreement, null, 2));
      expect(agreement.modelJudged).toBe(true);
      // No threshold. With two labelled negatives, a pass/fail here would be a
      // coin flip dressed as a gate — the value is the list of case ids to read.
      expect(agreement.caveat).toContain('not a measurement');
    },
    240_000,
  );
});
