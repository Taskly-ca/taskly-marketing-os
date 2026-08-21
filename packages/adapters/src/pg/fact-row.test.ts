/**
 * The mapping decisions, pinned.
 *
 * These three tests are the whole reason `fact-row.ts` is a separate module: a
 * value column chosen wrongly, an evidence key spelled in the other convention,
 * or a jsonb `null` mistaken for an empty column are all silent in production
 * and loud here.
 */
import { describe, expect, it } from 'vitest';
import type { Evidence, FactValue } from '@tmos/world';

import { DecodeError } from '../errors.js';
import {
  evidenceFromColumn,
  evidenceToColumn,
  factValueFromColumns,
  factValueToColumns,
  rowToFact,
} from './fact-row.js';

const columns = (over: Partial<Record<string, unknown>> = {}) => ({
  text: null,
  num: null,
  entity: null,
  json: null,
  hasJson: false,
  ...over,
});

describe('FactValue ↔ object_* columns', () => {
  it('populates exactly one column per variant, and round-trips it', () => {
    const cases: FactValue[] = [
      { datatype: 'text', text: 'same-day' },
      { datatype: 'num', num: 9900 },
      { datatype: 'entity', entityId: '11111111-1111-4111-8111-111111111111' },
      { datatype: 'json', json: { seats: 3 } },
    ];

    for (const value of cases) {
      const cols = factValueToColumns(value);
      const populated = [cols.text, cols.num, cols.entity, cols.json].filter((c) => c !== null);
      expect(populated).toHaveLength(1);

      const back = factValueFromColumns(
        {
          text: cols.text,
          num: cols.num,
          entity: cols.entity,
          json: cols.json === null ? null : JSON.parse(cols.json),
          hasJson: cols.json !== null,
        },
        'fact[x]',
      );
      expect(back).toEqual(value);
    }
  });

  it('decodes by the populated column, not by predicate_def.datatype', () => {
    // A fact whose value contradicts its predicate's declared datatype is not
    // this layer's problem to detect (`validateValue` does, in the domain) and
    // must still round-trip — the memory store round-trips it.
    expect(factValueFromColumns(columns({ text: 'not a number' }), 'fact[x]')).toEqual({
      datatype: 'text',
      text: 'not a number',
    });
  });

  it('refuses a row with no value, and a row with two', () => {
    expect(() => factValueFromColumns(columns(), 'fact[x]')).toThrow(/no object_\* column/);
    expect(() => factValueFromColumns(columns({ text: 'a', num: 1 }), 'fact[x]')).toThrow(
      /are both populated/,
    );
  });

  it('tells a jsonb document of `null` apart from an empty column', () => {
    // Both arrive as JS null; only `hasJson` distinguishes them, which is why
    // the query asks Postgres with `object_json is not null`.
    expect(() => factValueFromColumns(columns({ json: null, hasJson: true }), 'fact[x]')).toThrow(
      DecodeError,
    );
    expect(factValueFromColumns(columns({ json: {}, hasJson: true }), 'fact[x]')).toEqual({
      datatype: 'json',
      json: {},
    });
  });
});

describe('Evidence ↔ jsonb', () => {
  it('writes snake_case, reads camelCase — 002 documents the column, world declares the type', () => {
    const evidence: Evidence = {
      url: 'https://example.test',
      snippet: 'from $99',
      hash: 'abc',
      extractorVersion: 'extract@3',
      promptVersion: 'prompt@7',
    };

    const stored = evidenceToColumn(evidence);
    expect(stored).toEqual({
      url: 'https://example.test',
      snippet: 'from $99',
      hash: 'abc',
      extractor_version: 'extract@3',
      prompt_version: 'prompt@7',
    });
    expect(evidenceFromColumn(stored, 'evidence')).toEqual(evidence);
  });

  it('never drops a key it does not recognise — evidence is the audit trail', () => {
    const stored = evidenceToColumn({ url: 'u', future_field: 'keep me' } as Evidence);
    expect(stored.future_field).toBe('keep me');
    expect(evidenceFromColumn(stored, 'evidence')).toHaveProperty('future_field', 'keep me');
  });

  it('reads a missing evidence column as an empty object', () => {
    expect(evidenceFromColumn(null, 'evidence')).toEqual({});
  });
});

describe('rowToFact', () => {
  it('names the column when a row cannot be a FactRow', () => {
    expect(() =>
      rowToFact({
        fact_id: '99999999-9999-4999-8999-999999999999',
        entity_id: '11111111-1111-4111-8111-111111111111',
        predicate: 'price_cents',
        object_num: '1',
        has_json: false,
        valid_from: new Date(),
        asserted_from: new Date(),
        source_id: '33333333-3333-4333-8333-333333333333',
        observed_at: new Date(),
        confidence: 0.5,
        method: 'divination',
        evidence: {},
        status: 'active',
      }),
    ).toThrow(/method: divination is not one of/);
  });
});
