/**
 * `pnpm --filter @tmos/worker ingest` — one pass, and a report of what happened.
 *
 * NOT A DAEMON. It runs the pass, prints, closes the pool and exits; a scheduler
 * is Part 8's problem and this process has no opinion about how often it should
 * be invoked. That split is deliberate — a runner that also scheduled itself
 * would be the second place the cadence is configured.
 *
 * EXIT CODE. Zero when the pass completed, whatever the individual sources did:
 * a source failing is a normal, recorded, backed-off event and not a failed
 * run. Non-zero only when the pass itself could not complete — no database, bad
 * env, a bug. Anything else would page a human every time a feed had a bad
 * afternoon.
 *
 * `console` is avoided in favour of `process.stdout` for the zero-warning lint
 * policy, not for style.
 */
import { pathToFileURL } from 'node:url';

import { buildSystem } from './composition.js';
import { ingest, type IngestOptions, type IngestReport, type SourceOutcomeReport } from './ingest.js';

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export function parseArgs(argv: readonly string[]): IngestOptions & { help: boolean } {
  const out: { only?: string; limit?: number; force?: boolean; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm --filter … ingest -- --force` forwards the separator itself. It is
    // the documented invocation, so it must not be an unknown argument.
    if (arg === '--') continue;
    if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--only') out.only = argv[++i];
    else if (arg?.startsWith('--only=')) out.only = arg.slice('--only='.length);
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg?.startsWith('--limit=')) out.limit = Number(arg.slice('--limit='.length));
    else if (arg !== undefined) throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const USAGE = `tmos ingest — one collection pass

  --only <kind>   restrict to one collector kind (rss | hn | gdelt | ...)
  --limit <n>     stop after n sources
  --force         ignore the adaptive backoff hold
  --help`;

/** Cursors are long. The report needs identity, not the value. */
function short(value: string | null): string {
  if (value === null) return '-';
  return value.length <= 34 ? value : `${value.slice(0, 31)}...`;
}

function line(s: SourceOutcomeReport): string {
  const drops = Object.entries(s.dropped)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(' ');
  const parts = [
    `  ${s.status.padEnd(13)} ${s.source.padEnd(32)}`,
    `got=${s.collected} kept=${s.kept} wrote=${s.written} replay=${s.replays}`,
    drops === '' ? '' : `dropped[${drops}]`,
    `fails=${s.consecutiveFailures}`,
    `${s.ms}ms`,
  ];
  return parts.filter((p) => p !== '').join(' ');
}

function report(r: IngestReport): void {
  write('');
  write(`run ${r.runId}${r.forced ? '  [--force: backoff hold ignored]' : ''}`);
  write(`${r.startedAt} → ${r.finishedAt}`);
  write('');
  for (const s of r.sources) {
    write(line(s));
    write(`                ${' '.repeat(32)} ${s.detail}`);
    if (s.cursorBefore.etag !== s.cursorAfter.etag || s.cursorBefore.cursor !== s.cursorAfter.cursor) {
      write(
        `                ${' '.repeat(32)} cursor ${short(s.cursorBefore.cursor)} → ${short(s.cursorAfter.cursor)} | etag ${short(s.cursorBefore.etag)} → ${short(s.cursorAfter.etag)}`,
      );
    }
  }
  write('');
  write(
    `totals  http=${r.requests}  collected=${r.totals.collected}  kept=${r.totals.kept}  dropped=${r.totals.dropped}  signals=${r.totals.signals}  events=${r.totals.events}  replays=${r.totals.replays}`,
  );
  write('');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    write(USAGE);
    return 0;
  }

  const system = await buildSystem();
  try {
    const result = await ingest(args, {
      now: () => new Date(),
      transport: system.transport,
      env: system.processEnv,
    });
    report(result);
    // The ceilings this pass ran under. T0 spends nothing — that is the design,
    // and printing it is how a change to that becomes visible immediately.
    write(
      `budget  killswitch=${system.budget.killswitch}  spent_today=${system.budget.dailyCostCents}c / ${system.limits.maxDailyCostCents}c  (T0 spends nothing)`,
    );
    return 0;
  } finally {
    await system.close();
  }
}

/**
 * Run only when this file IS the process, never when it is imported.
 *
 * Without the guard, importing this module to unit-test `parseArgs` boots the
 * whole system — which in the deterministic suite means opening a pool and
 * failing on a missing DATABASE_URL, printing a stack trace beside a passing
 * test. A module with a side effect on import is a module that cannot be
 * tested, and a CLI is the one place that is easy to get wrong.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`ingest failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
