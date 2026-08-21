import { describe, it, expect } from 'vitest';
import { sql, isSqlQuery, createExecutor } from './sql.js';
import type { DbClient } from './pool.js';

/** Records what reached the wire. Nothing here needs a database. */
function recorder(rows: Record<string, unknown>[] = []): DbClient & { last?: string } {
  const self = {
    last: undefined as string | undefined,
    async query(text: string) {
      self.last = text;
      return { rows, rowCount: rows.length };
    },
  };
  return self;
}

describe('sql template', () => {
  it('parameterises every interpolation', () => {
    const q = sql`select * from tasks where id = ${7} and status = ${'open'}`;
    expect(q.text).toBe('select * from tasks where id = $1 and status = $2');
    expect(q.values).toEqual([7, 'open']);
  });

  it('keeps an injection payload in the VALUES, never in the text', () => {
    const evil = "'; drop table facts; --";
    const q = sql`select * from facts where predicate = ${evil}`;
    expect(q.text).toBe('select * from facts where predicate = $1');
    expect(q.text).not.toContain('drop table');
    expect(q.values).toEqual([evil]);
  });

  it('composes nested fragments and renumbers their placeholders', () => {
    const where = sql`where entity_id = ${'e1'} and predicate = ${'price'}`;
    const q = sql`select * from fact ${where} limit ${10}`;
    expect(q.text).toBe('select * from fact where entity_id = $1 and predicate = $2 limit $3');
    expect(q.values).toEqual(['e1', 'price', 10]);
  });

  it('renumbers a fragment that follows an earlier value', () => {
    const frag = sql`and b = ${'B'}`;
    const q = sql`select 1 where a = ${'A'} ${frag} and c = ${'C'}`;
    expect(q.text).toBe('select 1 where a = $1 and b = $2 and c = $3');
    expect(q.values).toEqual(['A', 'B', 'C']);
  });

  it('cannot be called as an ordinary function with a built string', () => {
    const notATag = sql as unknown as (s: string) => unknown;
    expect(() => notATag(`select * from t where id = ${1}`)).toThrow(/template/i);
  });

  it('identifies its own queries', () => {
    expect(isSqlQuery(sql`select 1`)).toBe(true);
    expect(isSqlQuery('select 1')).toBe(false);
    expect(isSqlQuery({ text: 'select 1', values: [] })).toBe(false);
  });
});

describe('executor', () => {
  it('refuses anything that is not a sql`` query', async () => {
    const ex = createExecutor(recorder());
    const raw = 'select * from tasks' as unknown as ReturnType<typeof sql>;
    await expect(ex.query(raw)).rejects.toThrow(/sql`/);
  });

  it('returns rows', async () => {
    const ex = createExecutor(recorder([{ n: 1 }, { n: 2 }]));
    await expect(ex.query(sql`select n`)).resolves.toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('one() demands exactly one row', async () => {
    await expect(createExecutor(recorder([{ n: 1 }])).one(sql`select n`)).resolves.toEqual({
      n: 1,
    });
    await expect(createExecutor(recorder([])).one(sql`select n`)).rejects.toThrow(/exactly one/);
    await expect(createExecutor(recorder([{ n: 1 }, { n: 2 }])).one(sql`select n`)).rejects.toThrow(
      /exactly one/,
    );
  });

  it('maybeOne() allows zero but never two', async () => {
    await expect(createExecutor(recorder([])).maybeOne(sql`select n`)).resolves.toBeNull();
    await expect(
      createExecutor(recorder([{ n: 1 }, { n: 2 }])).maybeOne(sql`select n`),
    ).rejects.toThrow(/at most one/);
  });

  it('execute() returns the affected row count', async () => {
    await expect(createExecutor(recorder([{ n: 1 }])).execute(sql`delete from t`)).resolves.toBe(1);
  });
});
