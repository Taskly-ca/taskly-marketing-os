/**
 * Typed environment. Fails fast at boot rather than at 2am inside an agent run.
 * Budget ceilings are env-driven so the founder sets a number and the code
 * enforces it — they are never advisory.
 */
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) {
    throw new Error('Invalid environment: at least one of GROQ_API_KEY or GEMINI_API_KEY required');
  }
  return env;
}
