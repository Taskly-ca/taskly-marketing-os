/**
 * The coercions. Every case here is a representation node-postgres can really
 * produce for the columns this package reads — `numeric` as a string is the one
 * that would otherwise put a string where the port promises a number, and
 * survive all the way to a comparison that silently never matches.
 */
import { describe, expect, it } from 'vitest';

import { DecodeError } from '../errors.js';
import {
  asBoolean,
  asIso,
  asIsoOrNull,
  asJsonObject,
  asNumber,
  asStringArray,
  asText,
  asUnion,
  isUuid,
} from './values.js';

describe('asNumber', () => {
  it('accepts the string node-postgres returns for numeric and int8', () => {
    expect(asNumber('9900', 'object_num')).toBe(9900);
    expect(asNumber('0.5', 'confidence')).toBe(0.5);
    expect(asNumber(3, 'occurrences')).toBe(3);
  });

  it('refuses anything that is not a finite number', () => {
    expect(() => asNumber('', 'c')).toThrow(DecodeError);
    expect(() => asNumber('nine thousand', 'c')).toThrow(/expected a number/);
    expect(() => asNumber(null, 'c')).toThrow(DecodeError);
  });
});

describe('asIso', () => {
  it('normalizes a Date, a string and a number to the same instant', () => {
    const iso = '2026-07-01T00:00:00.000Z';
    expect(asIso(new Date(iso), 'valid.from')).toBe(iso);
    expect(asIso(iso, 'valid.from')).toBe(iso);
    expect(asIso(Date.parse(iso), 'valid.from')).toBe(iso);
  });

  it('treats an absent upper bound as an open range, not as an error', () => {
    expect(asIsoOrNull(null, 'valid.to')).toBeNull();
  });

  it('refuses an Invalid Date rather than emitting one', () => {
    expect(() => asIso(new Date('nope'), 'valid.from')).toThrow(/Invalid Date/);
    expect(() => asIso('the third of never', 'valid.from')).toThrow(DecodeError);
  });
});

describe('asJsonObject / asStringArray / asBoolean / asText', () => {
  it('copies rather than aliasing the row object', () => {
    const source = { a: 1 };
    expect(asJsonObject(source, 'evidence')).not.toBe(source);
    expect(asJsonObject(source, 'evidence')).toEqual(source);
  });

  it('parses a JSON document handed back as text', () => {
    expect(asJsonObject('{"a":1}', 'evidence')).toEqual({ a: 1 });
  });

  it('refuses JSON that is not an object — null, arrays and scalars', () => {
    expect(() => asJsonObject(null, 'evidence')).toThrow(DecodeError);
    expect(() => asJsonObject([1, 2], 'evidence')).toThrow(DecodeError);
    expect(() => asJsonObject('7', 'evidence')).toThrow(DecodeError);
  });

  it('reads a null array column as empty', () => {
    expect(asStringArray(null, 'aliases')).toEqual([]);
    expect(asStringArray(['a'], 'aliases')).toEqual(['a']);
    expect(() => asStringArray([1], 'aliases')).toThrow(DecodeError);
  });

  it('does not coerce truthiness or numbers', () => {
    expect(() => asBoolean('t', 'subjective')).toThrow(DecodeError);
    expect(() => asText(9900, 'predicate')).toThrow(DecodeError);
    expect(asBoolean(false, 'subjective')).toBe(false);
  });
});

describe('asUnion', () => {
  it('checks the union instead of casting into it', () => {
    expect(asUnion('scrape', ['scrape', 'human'] as const, 'method')).toBe('scrape');
    expect(() => asUnion('telepathy', ['scrape', 'human'] as const, 'method')).toThrow(
      /not one of scrape \| human/,
    );
  });
});

describe('isUuid', () => {
  it('accepts the canonical form and rejects the memory store’s ids', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('fact_00000a')).toBe(false);
    // Postgres would accept this; the guard deliberately does not, so every id
    // this adapter emits or matches is the hyphenated form.
    expect(isUuid('11111111111141118111111111111111')).toBe(false);
  });
});
