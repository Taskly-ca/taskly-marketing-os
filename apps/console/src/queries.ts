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
type SourceRow = {
  name: string;
  tier: string;
  last_ok: string | null;
  fails: number;
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

  const sources = await db().query<SourceRow>(sql`
    select name, tier, to_char(last_ok_at,'YYYY-MM-DD HH24:MI') as last_ok,
           consecutive_failures as fails
      from source order by name`);

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
