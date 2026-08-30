/**
 * RUNNING A PASS FROM A BUTTON.
 *
 * The worker is a CLI that exits, and that stays true — a runner which also
 * owned the cadence would be the second place the cadence is configured. What
 * this adds is a way to press it, and to watch the output arrive rather than
 * discovering it in scrollback afterwards.
 *
 * ── ONE RUN AT A TIME, AND WHY THAT IS NOT MERELY TIDY ─────────────────────
 *
 * Two concurrent passes are not two views of the same work. `watch` reads the
 * world model, decides whether an observation is new, and then writes it — so
 * two passes interleaved can both read "50", both mint a change to 52, and
 * produce a duplicate Finding; or worse, the second reads the first's write and
 * classifies a real change as `restated`, losing it silently. The collector
 * side is equally unkeen: two passes hitting the same feeds doubles the request
 * rate against hosts we have promised ≤1 req/2s.
 *
 * So a second run is REFUSED while one is in flight, and refused loudly. A
 * queue would be worse: the founder pressed a button, and a pass that runs
 * several minutes later against different data is not what they asked for.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

/** The stages a button may ask for. `all` is the full pass. */
export const STAGES = [
  'all', 'collect', 'brain', 'watch', 'reason', 'resolve', 'digest', 'briefing',
] as const;
type Stage = (typeof STAGES)[number];

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

/**
 * The worker's argv for a stage.
 *
 * `--only` is the runner's own flag, so `all` is simply its absence. Building
 * this as data rather than string concatenation is what keeps a stage name from
 * ever reaching a shell — `spawn` is given an argv array and no shell is
 * involved, so even if `isStage` were bypassed there is nothing to inject into.
 */
export function argsFor(stage: Stage, free: boolean): string[] {
  const args: string[] = [];
  if (stage !== 'all') args.push('--only', stage);
  if (free) args.push('--free');
  return args;
}

interface RunHandle {
  readonly id: string;
  readonly stage: Stage;
  readonly startedAt: number;
  readonly events: EventEmitter;
  /** Every line so far, so a browser that connects late still sees the run. */
  readonly lines: string[];
  finished: boolean;
  exitCode: number | null;
}

export class RunBusy extends Error {
  constructor(stage: Stage) {
    super(
      `a "${stage}" pass is already running — two passes interleaved can lose a real change ` +
        `by classifying it as already-seen. Wait for it, or reload to watch it.`,
    );
    this.name = 'RunBusy';
  }
}

export class Runner {
  private current: RunHandle | null = null;
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  constructor(private readonly repoRoot: string) {}

  active(): RunHandle | null {
    return this.current?.finished === false ? this.current : null;
  }

  last(): RunHandle | null {
    return this.current;
  }

  start(stage: Stage, free: boolean): RunHandle {
    const running = this.active();
    if (running) throw new RunBusy(running.stage);

    const handle: RunHandle = {
      id: `${Date.now()}`,
      stage,
      startedAt: Date.now(),
      events: new EventEmitter(),
      lines: [],
      finished: false,
      exitCode: null,
    };
    // A pass emits a line every few seconds for two minutes; the default cap of
    // 10 would warn once several browser tabs watch the same run.
    handle.events.setMaxListeners(64);
    this.current = handle;

    /**
     * cwd is the WORKER's directory, not the repo root, and that is not
     * cosmetic: `report.ts` resolves its output against `process.cwd()`, so a
     * pass spawned from the repo root writes `briefing.html` there while the
     * CLI writes `apps/worker/briefing.html`. Two files in two places, each
     * stale whenever the other was the one that ran — and the founder would be
     * reading whichever they happened to open.
     *
     * These args mirror the worker's own package.json script exactly, so a
     * button press and a terminal invocation are the same run.
     */
    const cwd = resolve(this.repoRoot, 'apps/worker');
    const child = spawn(
      process.execPath,
      ['--env-file-if-exists=../../.env', resolve(cwd, 'dist/run.js'), ...argsFor(stage, free)],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;

    const push = (chunk: string): void => {
      for (const line of chunk.split('\n')) {
        handle.lines.push(line);
        handle.events.emit('line', line);
      }
    };
    // The worker prints progress with process.stdout.write and no trailing
    // newline in places, so buffering per-chunk rather than per-line would
    // stall the display for seconds at a time. Splitting on write is enough:
    // the UI joins them back.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const done = (code: number | null): void => {
      if (handle.finished) return;
      handle.finished = true;
      handle.exitCode = code;
      handle.events.emit('end', code);
      this.child = null;
    };
    child.on('close', done);
    child.on('error', (err) => {
      push(`\ncould not start the worker: ${err.message}`);
      done(1);
    });

    return handle;
  }

  /** Stop the run in flight. The worker's stages are independent, so a pass
   *  killed mid-stage loses that stage's work and nothing else's. */
  stop(): boolean {
    if (!this.child || !this.active()) return false;
    this.child.kill('SIGTERM');
    return true;
  }
}
