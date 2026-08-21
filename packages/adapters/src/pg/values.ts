/**
 * Column value → TypeScript, without trusting the driver's type parsers.
 *
 * node-postgres decides what a column becomes by OID, and that table is global,
 * mutable process state (`pg.types.setTypeParser`). It also has real gaps that
 * matter here: `numeric` arrives as a STRING (deliberately — float64 cannot hold
 * every numeric), `timestamptz` arrives as a `Date`, and range types arrive as
 * an unparsed string, which is exactly why the fact adapter selects
 * `lower(valid)`/`upper(valid)` instead of the range itself.
 *
 * So nothing in this package indexes a row and assigns it to a typed field. It
 * goes through a coercion that accepts every representation the driver could
 * plausibly hand back and throws a `DecodeError` naming the column when it
 * cannot. The cost is a function call per field. The thing it buys is that a
 * changed parser somewhere else in the process cannot silently turn a
 * confidence of 0.9 into the string '0.9' three layers downstream.
 */
import { DecodeError } from '../errors.js';

/**
 * The canonical hyphenated form Postgres renders and `gen_random_uuid()`
 * produces. DELIBERATELY stricter than Postgres's own parser, which also
 * accepts unhyphenated and brace-wrapped forms: this guard exists so that an id
 * from the OTHER store ('fact_000001') is treated as "not found" rather than
 * crashing a read with 22P02, and every id this adapter ever emits is canonical.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

export function asText(value: unknown, column: string): string {
  if (typeof value === 'string') return value;
  throw new DecodeError(`${column}: expected text, got ${describe(value)}`);
}

export function asTextOrNull(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : asText(value, column);
}

/** `numeric` and `int8` arrive as strings; `real`, `int4` and `float8` as numbers. */
export function asNumber(value: unknown, column: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (value.trim() !== '' && Number.isFinite(n)) return n;
  }
  throw new DecodeError(`${column}: expected a number, got ${describe(value)}`);
}

export function asNumberOrNull(value: unknown, column: string): number | null {
  return value === null || value === undefined ? null : asNumber(value, column);
}

export function asBoolean(value: unknown, column: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new DecodeError(`${column}: expected a boolean, got ${describe(value)}`);
}

/**
 * `timestamptz` → ISO 8601, which is what every temporal type in `@tmos/world`
 * is: a string. Accepts `Date` (the driver default), a string (a custom parser,
 * or `::text` in the query) and a number.
 *
 * PRECISION: Postgres stores microseconds, `Date` holds milliseconds. Every
 * instant this system writes comes from `new Date().toISOString()`, so nothing
 * we wrote loses anything; a µs-precision timestamp written by hand or by
 * another tool is truncated on the way out, and would not compare equal to
 * itself across a round trip.
 */
export function asIso(value: unknown, column: string): string {
  const iso = asIsoOrNull(value, column);
  if (iso === null) throw new DecodeError(`${column}: expected a timestamp, got null`);
  return iso;
}

export function asIsoOrNull(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DecodeError(`${column}: timestamp is an Invalid Date`);
    }
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new DecodeError(`${column}: not a timestamp: ${describe(value)}`);
    }
    return d.toISOString();
  }

  throw new DecodeError(`${column}: expected a timestamp, got ${describe(value)}`);
}

/** `text[]`. Cast uuid arrays to `::text[]` in the query rather than parsing them here. */
export function asStringArray(value: unknown, column: string): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return [...value];
  throw new DecodeError(`${column}: expected text[], got ${describe(value)}`);
}

/** `jsonb` holding an object. JSON `null`, arrays and scalars are not objects. */
export function asJsonObject(value: unknown, column: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  if (typeof value === 'string') {
    // A custom parser (or `::text`) can hand back the raw document.
    try {
      return asJsonObject(JSON.parse(value), column);
    } catch (error) {
      throw new DecodeError(`${column}: not a JSON object: ${describe(value)}`, { cause: error });
    }
  }
  throw new DecodeError(`${column}: expected a JSON object, got ${describe(value)}`);
}

/**
 * A closed string union, checked rather than cast. `status` and `method` are
 * CHECK-constrained in 002, so this can only fire if the constraint is widened
 * without the union — which is precisely when a silent cast would be worst.
 */
export function asUnion<T extends string>(
  value: unknown,
  allowed: readonly T[],
  column: string,
): T {
  const text = asText(value, column);
  if ((allowed as readonly string[]).includes(text)) return text as T;
  throw new DecodeError(`${column}: ${text} is not one of ${allowed.join(' | ')}`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}
