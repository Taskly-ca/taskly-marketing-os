/**
 * Typed environment. Fails fast at boot rather than at 2am inside an agent run.
 * Budget ceilings are env-driven so the founder sets a number and the code
 * enforces it — they are never advisory.
 */
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Both OPTIONAL, because nothing in TMOS uses them. Every database access
  // goes through DATABASE_URL and a `pg` connection (@tmos/db) — the world model
  // needs tstzrange, GiST and recursive CTEs that PostgREST cannot express, so
  // the service-role key has no call site. Requiring it meant the worker could
  // not boot without a credential nobody has, which is a boot failure that
  // teaches the operator to paste a placeholder — the opposite of fail-fast.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // LLM providers — at least one must be present; checked below.
  GROQ_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  // Delivery
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),

  // The ceilings. Defaults are deliberately small — a wrong config should cost
  // pennies and stop, never run up a bill.
  TMOS_MAX_RUN_TOKENS: z.coerce.number().int().positive().default(100_000),
  TMOS_MAX_DAILY_COST_CENTS: z.coerce.number().int().positive().default(2_000),
  TMOS_MAX_TOOL_DEPTH: z.coerce.number().int().positive().default(8),
  TMOS_KILLSWITCH: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof schema>;

/**
 * An EMPTY value is ABSENT, not present-and-invalid.
 *
 * Node's `--env-file` materialises every declared-but-blank line in a `.env` as
 * `''`, and a `.env` copied from `.env.example` is mostly blank lines. Without
 * this, `z.string().min(1).optional()` rejects them — so the process dies at
 * boot listing four credentials the operator does not have and does not need,
 * and the lesson learned is "paste a placeholder", which defeats the point of
 * validating at all. `vitest.live.config.ts` already had to solve this in its
 * own parser; the rule belongs here, once.
 */
function omitEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v.trim() !== '') out[k] = v;
  }
  return out;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(omitEmpty(source));
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) {
    throw new Error('Invalid environment: at least one of GROQ_API_KEY or GEMINI_API_KEY required');
  }
  return env;
}
