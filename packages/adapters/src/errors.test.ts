/**
 * The translation table. Its job is that no caller ever has to know a SQLSTATE,
 * and that "the trigger fired" is distinguishable from "the connection died" —
 * the first is a decision the worker can act on, the second is not.
 */
import { describe, expect, it } from 'vitest';

import type { AdapterError } from './errors.js';
import {
  AppendOnlyError,
  ConstraintError,
  MissingReferenceError,
  NotFoundError,
  isPgError,
  translatePgError,
} from './errors.js';

const pgError = (code: string, message: string, extra: Record<string, string> = {}) => ({
  code,
  message,
  ...extra,
});

describe('translatePgError', () => {
  it('turns a foreign key violation into a missing reference, naming the constraint', () => {
    const error = translatePgError(
      pgError('23503', 'insert or update on table "fact" violates foreign key constraint', {
        constraint: 'fact_source_id_fkey',
        detail: 'Key (source_id)=(…) is not present in table "source".',
      }),
      'insert',
    );

    expect(error).toBeInstanceOf(MissingReferenceError);
    expect((error as Error).message).toContain('fact_source_id_fkey');
    expect((error as Error).message).toContain('insert:');
  });

  it('recognises migration 009’s raises as append-only violations', () => {
    for (const message of [
      'fact values are append-only — close asserted and insert a replacement (fact_id=…)',
      'lower(fact.valid) is immutable — when it began is a recorded value',
      'fact.asserted is already closed at 2026-07-15 00:00:00+00',
      'fact.valid cannot be emptied — an interval that contains no instant asserts nothing',
    ]) {
      expect(translatePgError(pgError('P0001', message), 'closeValid')).toBeInstanceOf(
        AppendOnlyError,
      );
    }
  });

  it('does not mistake every plpgsql raise for an append-only violation', () => {
    const error = translatePgError(pgError('P0001', 'a decision needs at least one prediction'), 'insert');
    expect(error).toBeInstanceOf(ConstraintError);
    expect(error).not.toBeInstanceOf(AppendOnlyError);
  });

  it('maps a malformed uuid and a check violation to a constraint error', () => {
    expect(
      translatePgError(pgError('22P02', 'invalid input syntax for type uuid: "fact_00000a"'), 'byId'),
    ).toBeInstanceOf(ConstraintError);
    expect(
      translatePgError(pgError('23514', 'violates check constraint "fact_status_check"'), 'setStatus'),
    ).toBeInstanceOf(ConstraintError);
  });

  it('leaves an error this package already built alone', () => {
    const original = new NotFoundError('closeAsserted: no such fact f_1');
    expect(translatePgError(original, 'closeAsserted')).toBe(original);
  });

  it('passes a non-database failure through untouched', () => {
    const boom = new TypeError('fetch failed');
    expect(translatePgError(boom, 'insert')).toBe(boom);
  });

  it('keeps the cause, so the SQLSTATE is still there for whoever needs it', () => {
    const cause = pgError('23505', 'duplicate key value violates unique constraint');
    const error = translatePgError(cause, 'upsert') as AdapterError;

    expect(error.cause).toBe(cause);
    expect(error.name).toBe('ConstraintError');
  });
});

describe('isPgError', () => {
  it('recognises the shape without importing pg', () => {
    expect(isPgError({ code: '23503', message: 'nope' })).toBe(true);
    // No SQLSTATE, so not a server error — it passes through untranslated.
    expect(isPgError(new Error('plain'))).toBe(false);
    expect(isPgError('a string')).toBe(false);
    expect(isPgError(null)).toBe(false);
  });
});
