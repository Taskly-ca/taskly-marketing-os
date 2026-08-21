/**
 * Typed database configuration.
 *
 * Same shape as `@tmos/shared`'s `loadEnv`: one zod object, one loader, a throw
 * with a prettified error. The one rule that is specific to this package is
 * that there is NO fallback. A client that quietly defaults to
 * `postgres://localhost/postgres` turns "the migration ran" into "the migration
 * ran somewhere else", and that failure is silent for as long as nobody looks.
 */
import { z } from 'zod';

/** `false` = plaintext. Otherwise node-postgres TLS options. */
export type SslConfig = false | { readonly rejectUnauthorized: boolean };

export interface DbConfig {
  readonly url: string;
  /** Max concurrent server connections held by this process. */
  readonly poolMax: number;
  /** Server-side `statement_timeout`. A runaway query is cancelled, not waited on. */
  readonly statementTimeoutMs: number;
  /** How long to wait for a free connection before failing the caller. */
  readonly connectionTimeoutMs: number;
  readonly ssl: SslConfig;
}

/** Not env-tunable: a caller waiting longer than this wants a queue, not a pool. */
const CONNECTION_TIMEOUT_MS = 10_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isPostgresUrl(raw: string): boolean {
  const u = parseUrl(raw);
  return u !== null && (u.protocol === 'postgres:' || u.protocol === 'postgresql:');
}

/**
 * TLS decision, following libpq's own `sslmode` semantics rather than inventing
 * new ones:
 *
 *   disable                 → plaintext
 *   verify-ca | verify-full → TLS, certificate chain verified
 *   anything else           → TLS, chain NOT verified
 *   absent                  → TLS unless the host is local
 *
 * The unverified default is deliberate and is the same posture libpq ships:
 * Supabase's pooler presents a chain Node will not validate without its CA
 * bundle, so verifying by default would mean every remote connection fails on
 * day one and someone "fixes" it by disabling TLS entirely. Traffic is
 * encrypted; the server is not authenticated. For full verification set
 * `?sslmode=verify-full` and point `NODE_EXTRA_CA_CERTS` at the provider's CA.
 */
export function sslFor(url: string): SslConfig {
  const u = parseUrl(url);
  if (u === null) return false;

  const mode = u.searchParams.get('sslmode');
  if (mode === 'disable') return false;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  if (mode !== null) return { rejectUnauthorized: false };

  return LOCAL_HOSTS.has(u.hostname) ? false : { rejectUnauthorized: false };
}

const schema = z.object({
  DATABASE_URL: z.string().min(1).refine(isPostgresUrl, {
    message: 'must be a postgres:// or postgresql:// connection string',
  }),

  // Supabase's transaction pooler is the real ceiling here, not this process.
  // Ten is a boring number that leaves room for a second worker.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export function loadDbConfig(source: NodeJS.ProcessEnv = process.env): DbConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid database environment:\n${z.prettifyError(parsed.error)}\n\n` +
        'DATABASE_URL must be set explicitly. @tmos/db never falls back to a local ' +
        'default — a connection that silently points somewhere else is worse than no ' +
        'connection at all.',
    );
  }

  const env = parsed.data;
  return {
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    ssl: sslFor(env.DATABASE_URL),
  };
}
