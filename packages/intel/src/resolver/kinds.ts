/** The three machine-scoreable resolver kinds (plus `manual`, which always annuls
 *  under automation and must be resolved by a human). */
import {
  compare,
  parseAssertion,
  type Resolver,
  type ResolverContext,
  type ResolverOutcome,
  type ResolverSpec,
} from './types.js';

/** Read a dotted path out of parsed JSON. Deliberately tiny — a full JSONPath
 *  implementation is a dependency and an attack surface we do not need. */
export function readPath(value: unknown, path: string): unknown {
  const parts = path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let cur: unknown = value;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    const idx = /^\[?(\d+)\]?$/.exec(p);
    if (idx && Array.isArray(cur)) {
      cur = cur[Number(idx[1])];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** `sql` — the resolver kind used for anything already in our own warehouse.
 *  Spec is SQL returning exactly one row with one boolean-ish column. */
export const sqlResolver: Resolver = {
  kind: 'sql',
  parse(spec) {
    const s = spec.spec.trim().toLowerCase();
    if (!s.startsWith('select')) return { ok: false, error: 'sql resolver must start with SELECT' };
    if (/;\s*\S/.test(spec.spec))
      return { ok: false, error: 'multiple statements are not allowed' };
    if (/\b(insert|update|delete|drop|alter|truncate|grant)\b/.test(s)) {
      return { ok: false, error: 'sql resolver must be read-only' };
    }
    return { ok: true };
  },
  async run(spec, ctx): Promise<ResolverOutcome> {
    if (!ctx.query) return { outcome: 'annulled', reason: 'no query capability supplied' };
    const rows = await ctx.query(spec.spec);
    if (rows.length !== 1) {
      return { outcome: 'annulled', reason: `expected exactly 1 row, got ${rows.length}` };
    }
    const row = rows[0]!;
    const values = Object.values(row);
    if (values.length !== 1) {
      return { outcome: 'annulled', reason: `expected exactly 1 column, got ${values.length}` };
    }
    const v = values[0];
    if (v === null || v === undefined)
      return { outcome: 'annulled', reason: 'null result', observed: v };
    return { outcome: v === true || v === 1 || v === '1' || v === 't' ? 1 : 0, observed: v };
  },
};

/** `http_json` — spec is `<dotted.path> <op> <value>` against a JSON endpoint. */
export const httpJsonResolver: Resolver = {
  kind: 'http_json',
  parse(spec) {
    const p = parseAssertion(spec.spec);
    return p.ok ? { ok: true } : { ok: false, error: p.error };
  },
  async run(spec, ctx): Promise<ResolverOutcome> {
    if (!ctx.fetchJson) return { outcome: 'annulled', reason: 'no fetchJson capability supplied' };
    const parsed = parseAssertion(spec.spec);
    if (!parsed.ok) return { outcome: 'annulled', reason: parsed.error };

    let body: unknown;
    try {
      body = await ctx.fetchJson(spec.source_url);
    } catch (e) {
      // Source unreachable is NOT a failed prediction — it annuls.
      return { outcome: 'annulled', reason: `fetch failed: ${(e as Error).message}` };
    }
    const observed = readPath(body, parsed.lhs);
    if (observed === undefined) {
      return { outcome: 'annulled', reason: `path not found: ${parsed.lhs}` };
    }
    try {
      return { outcome: compare(observed, parsed.op, parsed.rhs) ? 1 : 0, observed };
    } catch (e) {
      return { outcome: 'annulled', reason: (e as Error).message, observed };
    }
  },
};

/** `scrape_assert` — spec is `<regex-or-count-target> <op> <value>` against page text.
 *  `count:<pattern>` counts regex matches; anything else is matched as a regex
 *  and the first capture group is compared. */
export const scrapeAssertResolver: Resolver = {
  kind: 'scrape_assert',
  parse(spec) {
    const p = parseAssertion(spec.spec);
    if (!p.ok) return { ok: false, error: p.error };
    const pattern = p.lhs.startsWith('count:') ? p.lhs.slice(6) : p.lhs;
    try {
      new RegExp(pattern);
    } catch (e) {
      return { ok: false, error: `invalid regex: ${(e as Error).message}` };
    }
    return { ok: true };
  },
  async run(spec, ctx): Promise<ResolverOutcome> {
    if (!ctx.fetchText) return { outcome: 'annulled', reason: 'no fetchText capability supplied' };
    const parsed = parseAssertion(spec.spec);
    if (!parsed.ok) return { outcome: 'annulled', reason: parsed.error };

    let text: string;
    try {
      text = await ctx.fetchText(spec.source_url);
    } catch (e) {
      return { outcome: 'annulled', reason: `fetch failed: ${(e as Error).message}` };
    }

    let observed: unknown;
    if (parsed.lhs.startsWith('count:')) {
      const re = new RegExp(parsed.lhs.slice(6), 'g');
      observed = (text.match(re) ?? []).length;
    } else {
      const m = new RegExp(parsed.lhs).exec(text);
      if (!m) return { outcome: 'annulled', reason: `pattern did not match: ${parsed.lhs}` };
      observed = m[1] ?? m[0];
    }
    try {
      return { outcome: compare(observed, parsed.op, parsed.rhs) ? 1 : 0, observed };
    } catch (e) {
      return { outcome: 'annulled', reason: (e as Error).message, observed };
    }
  },
};

/** `manual` — parses fine, but never auto-resolves. A human must record it. */
export const manualResolver: Resolver = {
  kind: 'manual',
  parse() {
    return { ok: true };
  },
  async run(): Promise<ResolverOutcome> {
    return { outcome: 'annulled', reason: 'manual resolver requires a human resolution' };
  },
};

const REGISTRY: Record<string, Resolver> = {
  sql: sqlResolver,
  http_json: httpJsonResolver,
  scrape_assert: scrapeAssertResolver,
  manual: manualResolver,
};

export function resolverFor(kind: string): Resolver | undefined {
  return REGISTRY[kind];
}

/**
 * THE GATE. A prediction may not be written unless its resolver executes today
 * and returns a usable value. `manual` is exempt from execution but still must
 * be declared deliberately.
 */
export async function dryRun(
  spec: ResolverSpec,
  ctx: ResolverContext,
): Promise<{ ok: true; observed: unknown } | { ok: false; error: string }> {
  const r = resolverFor(spec.kind);
  if (!r) return { ok: false, error: `unknown resolver kind: ${spec.kind}` };

  const parsed = r.parse(spec);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (spec.kind === 'manual') return { ok: true, observed: null };

  const res = await r.run(spec, ctx);
  if (res.outcome === 'annulled') {
    return { ok: false, error: `dry-run could not resolve: ${res.reason}` };
  }
  return { ok: true, observed: res.observed };
}
