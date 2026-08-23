/**
 * `pnpm --filter @tmos/worker digest` — decide what earns an interruption, and
 * send it.
 *
 * The selection rules live in `@tmos/surface` and the transports in
 * `deliver.ts`; this is the part that needs a database. Two reads and one
 * write, and each of the three is load-bearing:
 *
 *   CANDIDATES exclude superseded rows. A Finding we have withdrawn must never
 *   be pushed, and `selectDigest` holds one that slips through — but filtering
 *   in SQL means the retraction is enforced by the query rather than by
 *   remembering to check.
 *
 *   HISTORY is every push ever made, not the last week. The cap is windowed;
 *   the never-send-it-twice rule is not, and reading only a window would
 *   re-send a Finding on its eighth day.
 *
 *   SIGNALS EXAMINED is what makes a quiet week legible. A system that goes
 *   quiet and a system that is broken look identical from outside, so the count
 *   ships in every message including the empty one.
 */
import { pathToFileURL } from 'node:url';

import type { Finding } from '@tmos/contracts';
import type { DeliveryRecord } from '@tmos/surface';
import { closePool, db, sql } from '@tmos/db';

import { chooseDelivery, runDigest } from './deliver.js';

type DigestReport = Awaited<ReturnType<typeof runDigest>>;

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export const DEEP_LINK_ENV = 'TMOS_DEEP_LINK_BASE';

/**
 * Where a reader lands when they click through.
 *
 * The briefing is a file on disk today, so the honest default is a `file://`
 * URL to it: a link that opens the page someone can actually read beats a link
 * to a server nobody has deployed. `renderFinding` requires an absolute URL and
 * does not care which scheme.
 */
function deepLinkBase(env: NodeJS.ProcessEnv, cwd: string): string {
  const configured = env[DEEP_LINK_ENV]?.trim();
  if (configured) return configured;
  return `file://${cwd}/briefing.html`;
}

async function liveFindings(): Promise<Finding[]> {
  const rows = await db().query<{ row: Finding }>(sql`
    select to_jsonb(f) - 'created_at' - 'evidence'
           || jsonb_build_object(
                'created_at', to_char(f.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'evidence', f.evidence)
           as row
      from finding f
     where f.superseded_by is null
     order by f.created_at desc
     limit 200`);
  return rows.map((r) => r.row);
}

async function deliveryHistory(): Promise<DeliveryRecord[]> {
  const rows = await db().query<{ finding_id: string; delivered_at: string; preempted: boolean }>(sql`
    select finding_id::text as finding_id,
           to_char(delivered_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as delivered_at,
           preempted_cap as preempted
      from digest_delivery`);
  return rows.map((r) => ({
    findingId: r.finding_id,
    deliveredAt: r.delivered_at,
    preemptedCap: r.preempted,
  }));
}

/** Signals examined, over the same window the selector uses for its cap. */
async function signalsExamined(): Promise<number> {
  const rows = await db().query<{ n: number }>(sql`
    select count(*)::int as n from signal where created_at > now() - interval '7 days'`);
  return rows[0]?.n ?? 0;
}

export function reportDigest(r: DigestReport): void {
  write('');
  if (r.selection.kind === 'quiet') {
    write(`QUIET — ${r.selection.reason}, ${r.selection.checked} signals examined`);
    write(`  held: ${r.selection.held.length}   nothing pushed since ${r.selection.since}`);
  } else {
    write(`DIGEST — ${r.selection.items.length} of ${r.selection.checked} signals examined`);
    for (const f of r.rendered) write(`\n  ── ${f.text.split('\n')[0]}`);
    if (r.selection.held.length > 0) {
      write(`\n  held back: ${r.selection.held.map((h) => h.reason).join(', ')}`);
    }
  }

  for (const refusal of r.refusals) write(`  ✗ render refused — ${refusal}`);

  write('');
  if (r.outcome === null) {
    write('NOT SENT — no transport configured.');
    write('  Set SLACK_BOT_TOKEN + SLACK_DIGEST_CHANNEL, or RESEND_API_KEY +');
    write('  DIGEST_EMAIL_TO + DIGEST_EMAIL_FROM. Everything above still ran.');
  } else {
    write(`${r.outcome.ok ? 'SENT' : 'NOT SENT'} via ${r.outcome.channel}: ${r.outcome.detail}`);
    write(`  recorded as delivered: ${r.delivered.length}`);
  }
}

export async function digest(): Promise<DigestReport> {
  const [findings, history, checked] = await Promise.all([
    liveFindings(),
    deliveryHistory(),
    signalsExamined(),
  ]);

  return runDigest({
    findings,
    history,
    signalsExamined: checked,
    now: new Date(),
    deepLinkBase: deepLinkBase(process.env, process.cwd()),
    transport: chooseDelivery(process.env),
    record: async (r) => {
      // `on conflict do nothing`: the primary key IS the never-twice rule, and
      // a race between two runs must not turn a duplicate into a crash that
      // loses the rest of the batch.
      await db().execute(sql`
        insert into digest_delivery (finding_id, delivered_at, preempted_cap)
        values (${r.findingId}::uuid, ${r.deliveredAt}::timestamptz, ${r.preemptedCap ?? false})
        on conflict (finding_id) do nothing`);
    },
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  digest()
    .then(reportDigest)
    .catch((error: unknown) => {
      process.stderr.write(`digest failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}
