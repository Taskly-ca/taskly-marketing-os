/**
 * Everything the console shows, read from the database in one round trip.
 *
 * These are the briefing's own queries. That is deliberate and it is the only
 * interesting decision in this file: two readers over one database is two
 * answers to "what does TMOS currently know", and the difference would show up
 * as a console that disagrees with the page it links to. If a query changes, it
 * changes for both.
 *
 * The one rule the briefing established and this keeps: **superseded findings
 * are included**, newest first. A system that quietly stops showing what it got
 * wrong has no track record anyone can read.
 */
import { db, sql } from '@tmos/db';

type FactRow = {
  company: string;
  predicate: string;
  value: string;
  url: string | null;
  span: string | null;
  since: string;
  method: string;
};
type FindingRow = {
  claim: string;
  so_what: string;
  subject: string;
  basis: string;
  score: string;
  created: string;
  by: string;
  url: string | null;
  span: string | null;
  /** Non-null ⇒ withdrawn, and the reason is what repairs trust. */
  supersede_reason: string | null;
};
type PredRow = {
  claim: string;
  p: string;
  resolves: string;
  resolver: string;
  author: string;
};
/**
 * WHAT KIND OF BROKEN — mirrors `healthFromFailure` in `apps/worker/src/backoff.ts`,
 * which is the definition.
 *
 * It is duplicated rather than imported because the console does not depend on
 * `@tmos/worker` and adding the dependency is a `package.json` + lockfile
 * change. Six lines and one union; if `CollectFailure` grows a member, the
 * worker stops compiling and this falls through to `transient` — which is why
 * the fallback is the *safe* answer (keep retrying, say nothing alarming)
 * rather than the loud one. Keep the two in step.
 */
type SourceHealth = 'healthy' | 'transient' | 'needs_operator' | 'refused';

const HEALTH_BY_REASON: Record<string, SourceHealth> = {
  blocked_by_policy: 'refused',
  auth: 'needs_operator',
  not_configured: 'needs_operator',
  network: 'transient',
  rate_limited: 'transient',
  parse: 'transient',
};

type SourceRow = {
  name: string;
  tier: string;
  last_ok: string | null;
  fails: number;
  /** The collector's own word for the most recent failure — null while healthy. */
  reason: string | null;
  /** What it actually said. This is the line that names the robots.txt rule. */
  detail: string | null;
  /** Start of the CURRENT streak: the first failure since the last success. */
  failing_since: string | null;
  /** Whole days that streak has been running. "…for nine days" comes from here. */
  failing_days: number | null;
  health: SourceHealth;
};

/** Attention first, then the quiet ones. A list read top-down should start with the work. */
const HEALTH_ORDER: Record<SourceHealth, number> = {
  needs_operator: 0,
  refused: 1,
  transient: 2,
  healthy: 3,
};
type Counts = {
  signals: number;
  events: number;
  entities: number;
  findings: number;
  facts: number;
  cents: string | null;
  calls: number;
};

interface ConsoleState {
  facts: FactRow[];
  findings: FindingRow[];
  preds: PredRow[];
  sources: SourceRow[];
  counts: Counts;
  generated: string;
}

export async function readState(): Promise<ConsoleState> {
  const facts = await db().query<FactRow>(sql`
    select e.name as company, f.predicate,
           coalesce(f.object_text, f.object_num::text) as value,
           f.evidence->>'url' as url, f.evidence->>'snippet' as span,
           to_char(lower(f.valid), 'YYYY-MM-DD HH24:MI') as since, f.method
      from fact f join entity e on e.id = f.entity_id
     -- BITEMPORAL, BOTH AXES. "upper_inf(asserted)" alone means "we never
     -- retracted this", which is NOT "this is true now": the world changing
     -- closes "valid", and a closed "valid" is a PAST state we deliberately
     -- kept. Reading only the asserted axis showed Handy in seven contradictory
     -- city lists at once and called all of them current — 43 rows where the
     -- world model holds 29. AGENTS.md rule 3 names this exact conflation as
     -- the single most damaging error available here.
     where upper_inf(f.asserted) and upper_inf(f.valid) and f.status = 'active'
     order by e.name, f.predicate`);

  const findings = await db().query<FindingRow>(sql`
    select f.claim, f.so_what, array_to_string(f.subject_refs, ', ') as subject,
           f.basis, to_char(f.domain_score, 'FM0.00') as score,
           to_char(f.created_at, 'YYYY-MM-DD HH24:MI') as created,
           f.generated_by as by,
           f.evidence->0->>'source_url' as url,
           f.evidence->0->>'span' as span,
           f.supersede_reason
      from finding f
     order by f.created_at desc`);

  const preds = await db().query<PredRow>(sql`
    select claim, p::text as p, to_char(resolve_at,'YYYY-MM-DD') as resolves,
           resolver->>'kind' as resolver, author
      from prediction where outcome is null order by resolve_at`);

  /**
   * SOURCE HEALTH, NOT JUST A FAILURE COUNT.
   *
   * `consecutive_failures` alone said the same thing about all three of the
   * sources that were broken on 2026-08-30 — a feed the site forbids, an API
   * token that had expired, and a host serving no robots.txt — so the tab could
   * not tell an operator which one was waiting on THEM. The reason is already
   * being written, once per attempt, into the `source.collect_failed` payload
   * and was never read back; these two laterals are that read.
   *
   * The first takes the LAST failure (what it said). The second takes the FIRST
   * failure since the last success (when it started), because "how long has
   * this been broken" is the number that turns a red cell into a decision, and
   * the last attempt's timestamp cannot answer it. `-infinity` covers a source
   * that has never succeeded — all three of the broken ones — where there is no
   * success to measure from.
   */
  const sourceRows = await db().query<Omit<SourceRow, 'health'>>(sql`
    select s.name, s.tier,
           to_char(s.last_ok_at,'YYYY-MM-DD HH24:MI') as last_ok,
           s.consecutive_failures as fails,
           last_fail.reason, last_fail.detail,
           to_char(streak.since,'YYYY-MM-DD') as failing_since,
           floor(extract(epoch from (now() - streak.since)) / 86400)::int as failing_days
      from source s
      left join lateral (
        select e.payload->>'reason' as reason, e.payload->>'detail' as detail
          from events e
         where e.source_id = s.id and e.type = 'source.collect_failed'
         order by e.occurred_at desc
         limit 1) last_fail on s.consecutive_failures > 0
      left join lateral (
        select min(e.occurred_at) as since
          from events e
         where e.source_id = s.id and e.type = 'source.collect_failed'
           and e.occurred_at > coalesce(s.last_ok_at, '-infinity'::timestamptz)) streak
        on s.consecutive_failures > 0
     order by s.name`);

  const sources: SourceRow[] = sourceRows
    .map((row) => ({
      ...row,
      // A source with no failure streak is healthy whatever the log remembers;
      // an unrecognised reason stays `transient` rather than raising an alarm
      // nobody can act on.
      health:
        row.fails === 0
          ? 'healthy'
          : (HEALTH_BY_REASON[row.reason ?? ''] ?? 'transient'),
    }))
    .sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.name.localeCompare(b.name));

  const [counts] = await db().query<Counts>(sql`
    select (select count(*) from signal)::int  as signals,
           (select count(*) from events)::int  as events,
           (select count(*) from entity)::int  as entities,
           (select count(*) from finding)::int as findings,
           (select count(*) from fact)::int    as facts,
           (select coalesce(sum(cost_cents),0)::text from ai_usage_log) as cents,
           (select count(*) from ai_usage_log)::int as calls`);

  return {
    facts,
    findings,
    preds,
    sources,
    counts: counts ?? {
      signals: 0, events: 0, entities: 0, findings: 0, facts: 0, cents: '0', calls: 0,
    },
    generated: new Date().toISOString(),
  };
}
