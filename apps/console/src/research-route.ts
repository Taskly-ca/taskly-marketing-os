/**
 * The research endpoint — a question in, a streamed answer out.
 *
 * Streamed for one reason and it is not decoration: a run takes 30–90 seconds
 * (a planning call, up to four searches, eight page fetches at a 2s-per-host
 * floor, then a synthesis call over eight documents). A spinner for ninety
 * seconds is indistinguishable from a hang, and the steps are genuinely worth
 * watching — which query it chose, which pages robots refused — because they
 * are what tells you whether a thin answer means a thin topic or bad queries.
 */
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { db, sql } from '@tmos/db';
import { loadEnv, type BudgetLimits } from '@tmos/shared';
import { createAsk, createResearchReader, searchProvidersFromEnv } from '@tmos/adapters';
import { research } from '@tmos/research';

const send = (res: ServerResponse, event: string, data: unknown): void => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

export async function runResearch(res: ServerResponse, question: string): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const q = question.trim();
  if (q.length < 8) {
    send(res, 'error_msg', 'Ask a fuller question — a few words cannot be turned into a search.');
    res.end();
    return;
  }

  const env = loadEnv();
  const providers = searchProvidersFromEnv();
  if (providers.length === 0) {
    send(res, 'error_msg', 'No search provider configured. Set TAVILY_API_KEY or EXA_API_KEY.');
    res.end();
    return;
  }
  send(res, 'step', `providers: ${providers.map((p) => p.name).join(', ')}`);

  const runId = randomUUID();
  const limits: BudgetLimits = {
    maxRunTokens: env.TMOS_MAX_RUN_TOKENS,
    maxDailyCostCents: env.TMOS_MAX_DAILY_COST_CENTS,
    maxToolDepth: env.TMOS_MAX_TOOL_DEPTH,
  };

  try {
    const answer = await research(q, {
      ask: createAsk({
        apiKey: env.GROQ_API_KEY ?? '',
        limits,
        runId,
        // The daily ceiling is reconstructed from this table on restart, so a
        // run that spends without logging silently raises tomorrow's budget.
        onUsage: async (usage, model) => {
          await db().execute(sql`
            insert into ai_usage_log (run_id, provider, model, tokens_in, tokens_out, cost_cents, outcome, reason)
            values (${runId}, 'groq', ${model}, ${usage.promptTokens}, ${usage.completionTokens},
                    ${usage.costCents}, 'allowed', 'research')`);
        },
      }),
      search: providers,
      read: createResearchReader(),
      onStep: (line) => send(res, 'step', line),
    });
    send(res, 'answer', answer);
  } catch (err) {
    send(res, 'error_msg', err instanceof Error ? err.message : String(err));
  }
  res.end();
}
