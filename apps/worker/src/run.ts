/**
 * `pnpm --filter @tmos/worker run:pass` — one whole pass, in order.
 *
 * Until now every part of this system ran because a person typed its name.
 * Collect, watch, reason, deliver, publish the page — five commands, in an
 * order held in somebody's head, with no record of whether last night's pass
 * happened. A marketing operating system that only operates when watched is a
 * library with a README.
 *
 * NOT A DAEMON, AND STILL NOT ONE. `cli.ts` made that call deliberately — "a
 * runner that also scheduled itself would be the second place the cadence is
 * configured" — and it is still right. This is one pass, invoked by cron,
 * launchd or a platform scheduler; `scripts/schedule.md` has the three lines
 * for each. pg_cron cannot do it: it runs SQL, and every stage here is Node.
 *
 * ── A FAILED STAGE DOES NOT FAIL THE PASS
 *
 * The stages are independent by design and their failure modes are not
 * correlated: a feed with a bad afternoon must not stop the competitor watch, a
 * Groq outage must not stop the briefing being regenerated from what is already
 * in the database, and none of them must stop the digest reporting that it had
 * nothing to say. So each stage is caught, timed and recorded, and the pass
 * prints a table of what happened.
 *
 * The exit code follows the same rule the ingest CLI set: non-zero only when
 * the pass could not run at all. A stage that failed is a recorded event, and
 * an exit code that goes red on a flaky feed is an exit code an operator learns
 * to ignore — which is worse than not having one.
 *
 * ── ORDER IS NOT ARBITRARY
 *
 * Collect before reasoning, or the reasoning reads yesterday's signals. Watch
 * before the digest, or a change found this morning waits a day to be sent.
 * Digest before the briefing, so the page shows what was delivered rather than
 * what was about to be. And the briefing last, always, so it reflects the pass
 * that just ran even when three stages before it failed.
 */
import { pathToFileURL } from 'node:url';

import { closePool } from '@tmos/db';

import { ingestOnce } from './cli.js';
import { watchCompetitors } from './watch.js';
import { cascade } from './cascade.js';
import { digest, reportDigest } from './digest.js';
import { writeBriefing } from './report.js';

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export interface Stage {
  readonly name: string;
  /** Why it is here, in one line — printed, so the pass explains itself. */
  readonly why: string;
  readonly run: () => Promise<unknown>;
  /**
   * True when the stage spends money on a model. `--free` skips these, which is
   * how a pass can be run on a schedule while a budget question is open.
   */
  readonly spends: boolean;
}

export const STAGES: readonly Stage[] = [
  {
    name: 'collect',
    why: 'free sources into `signal`, backed off per source',
    run: () => ingestOnce({}),
    spends: false,
  },
  {
    name: 'watch',
    why: 'competitor documents; a change becomes a verified Finding',
    run: watchCompetitors,
    spends: true,
  },
  {
    name: 'reason',
    why: 'T1 over what was collected, then synthesis on what survives',
    run: cascade,
    spends: true,
  },
  {
    name: 'digest',
    why: 'what earns an interruption, and sending it',
    // Printed here, not inside `digest()`: the first pass ran this stage and
    // showed nothing at all, because the reporting lived in the CLI wrapper.
    // A stage whose output is invisible inside the pass is a stage nobody can
    // tell ran.
    run: async () => reportDigest(await digest()),
    spends: false,
  },
  {
    name: 'briefing',
    why: 'the page, regenerated from the database',
    run: writeBriefing,
    spends: false,
  },
];

export interface StageResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

export interface RunArgs {
  readonly only: string | null;
  readonly free: boolean;
  readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): RunArgs {
  let only: string | null = null;
  let free = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' || arg === undefined) continue;
    if (arg === '--free') free = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--only') only = argv[++i] ?? null;
    else if (arg.startsWith('--only=')) only = arg.slice('--only='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (only !== null && !STAGES.some((s) => s.name === only)) {
    throw new Error(`unknown stage "${only}" — one of ${STAGES.map((s) => s.name).join(', ')}`);
  }
  return { only, free, help };
}

const USAGE = `tmos run — one pass: ${STAGES.map((s) => s.name).join(' → ')}

  --only <stage>  run one stage
  --free          skip the stages that spend on a model
  --help

Not a daemon. Invoke it from cron, launchd or a platform scheduler —
see scripts/schedule.md.`;

/** The stages this invocation will run, in order, after the flags. */
export function plan(args: RunArgs, stages: readonly Stage[] = STAGES): Stage[] {
  return stages
    .filter((s) => args.only === null || s.name === args.only)
    .filter((s) => !args.free || !s.spends);
}

export interface RunDeps {
  /** Injected so the deterministic suite can drive this without a network, a
   *  database or a model. A runner tested against its own real stages is a
   *  runner whose unit tests are an integration run with the errors swallowed. */
  readonly stages?: readonly Stage[];
  readonly clock?: () => number;
}

export async function runPass(args: RunArgs, deps: RunDeps = {}): Promise<StageResult[]> {
  const clock = deps.clock ?? ((): number => performance.now());
  const chosen = plan(args, deps.stages ?? STAGES);
  const results: StageResult[] = [];

  for (const stage of chosen) {
    write(`\n${'━'.repeat(72)}`);
    write(`▶ ${stage.name} — ${stage.why}`);
    write('━'.repeat(72));

    const started = clock();
    try {
      await stage.run();
      results.push({ name: stage.name, ok: true, ms: Math.round(clock() - started), detail: '' });
    } catch (error) {
      // Caught, recorded, and the pass continues. The stages' failure modes are
      // not correlated: a feed having a bad afternoon is not a reason to skip
      // regenerating the briefing from what is already in the database.
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name: stage.name, ok: false, ms: Math.round(clock() - started), detail });
      write(`\n✗ ${stage.name} failed: ${detail.slice(0, 300)}`);
    }
  }

  return results;
}

export function summarise(results: readonly StageResult[]): string[] {
  const lines = ['', '━'.repeat(72), 'PASS SUMMARY', '━'.repeat(72)];
  for (const r of results) {
    lines.push(
      `  ${(r.ok ? 'ok' : 'FAILED').padEnd(7)} ${r.name.padEnd(10)} ${String(r.ms).padStart(7)}ms` +
        (r.detail === '' ? '' : `  ${r.detail.slice(0, 90)}`),
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(
    failed === 0
      ? `${results.length} stage(s), all green.`
      : `${results.length} stage(s), ${failed} failed — recorded above, and the pass still completed.`,
  );
  return lines;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    write(USAGE);
    return 0;
  }

  const results = await runPass(args);
  for (const line of summarise(results)) write(line);
  // Zero whatever the stages did: see the header. A red exit on a flaky feed is
  // an exit code an operator learns to ignore.
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `pass could not run: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(closePool);
}
