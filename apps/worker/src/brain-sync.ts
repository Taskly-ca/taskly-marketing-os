/**
 * `pnpm --filter @tmos/worker brain:sync` — mirror `taskly-brain/` into the
 * cache, then embed what changed.
 *
 * Part 4 built the whole consumer: `ingestSnapshot` validates, diffs and
 * applies; `embedPending` re-embeds only the chunks whose content hash moved;
 * `createPostgresBrainStore` persists both. Its gate recorded that propagation
 * was "NOT proven", and the reason turns out to be simpler than anything in
 * that package — **nothing produced a snapshot.** The brain bridge has been a
 * consumer with nothing to consume since the day it was written.
 *
 * `scripts/brain-snapshot.mjs` in the marketplace repo is the producing half
 * now. This is the two lines that join them, plus the three decisions that are
 * not obvious:
 *
 * A SNAPSHOT IS READ FROM DISK, NOT FETCHED. The two repos live side by side on
 * one machine and TMOS has no git remote; inventing an HTTP endpoint to move a
 * file between two directories would be infrastructure with no user. The port
 * takes a `fetch()` of its own, so swapping this for a URL later is one class.
 *
 * EMBEDDING IS OPTIONAL AND THE SYNC IS NOT. Without `GEMINI_API_KEY` the
 * documents still mirror, still carry their status and caveats, and are still
 * retrievable by keyword — only vector search is missing. Refusing to sync at
 * all because one downstream capability is unavailable would leave the cache
 * empty AND unsearchable, which is strictly worse.
 *
 * THE SHRINK GUARD STAYS ON. `ingestSnapshot` refuses a snapshot that loses
 * most of the corpus, because a producer that half-failed and a corpus that was
 * genuinely deleted look identical in the data. The exporter skips a document
 * whose frontmatter the gate would reject, and a bad edit to one file's
 * frontmatter is exactly the kind of thing that quietly drops it — so the guard
 * is doing real work here, not defending against a hypothetical.
 */
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { closePool } from '@tmos/db';
import { createPostgresBrainStore } from '@tmos/adapters';
import { embedPending, ingestSnapshot, type BrainStorePort } from '@tmos/brain';
import { createGeminiEmbedder } from '@tmos/shared';

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export const SNAPSHOT_ENV = 'TASKLY_BRAIN_SNAPSHOT';

/**
 * No default path.
 *
 * A guessed one that happens to be wrong syncs nothing and reports a healthy
 * empty corpus — the same failure the FACT-SHEET reader refuses for the same
 * reason. The variable names the file the marketplace repo's exporter writes.
 */
export function snapshotPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = env[SNAPSHOT_ENV]?.trim();
  if (!path) {
    throw new Error(
      `${SNAPSHOT_ENV} is not set — it must point at the JSON written by ` +
        '`node scripts/brain-snapshot.mjs` in the taskly.ca repo. There is no default: a ' +
        'guessed path that is wrong syncs nothing and reports a healthy empty corpus.',
    );
  }
  return resolve(path);
}

export async function brainSync(store?: BrainStorePort): Promise<void> {
  const path = snapshotPath();
  const brain = store ?? createPostgresBrainStore();

  const result = await ingestSnapshot(
    { fetch: async () => JSON.parse(await readFile(path, 'utf8')) as unknown },
    brain,
    { now: () => new Date() },
  );

  if (!result.ok) {
    // Named, not swallowed. `suspicious_shrink` in particular is a REFUSAL and
    // not a bug — it means the exporter produced far fewer documents than the
    // cache holds, and obeying it would delete a corpus on the strength of a
    // half-failed run.
    throw new Error(`brain sync refused: ${result.reason} — ${result.detail}`);
  }

  const p = result.plan;
  write(`synced ${path}`);
  write(`  from taskly.ca ${p.commit.slice(0, 8)}, generated ${p.generatedAt}`);
  write(`  docs: ${p.added} added · ${p.changed} changed · ${p.unchanged} unchanged · ${p.removed} removed`);
  write(
    `  chunks: ${p.chunksUpserted} upserted · ${p.chunksUnchanged} unchanged · ${p.chunksDeleted} deleted`,
  );
  // The only chunks worth spending an embedding call on — the diff is the
  // product, and this is the number that says how much a sync will cost.
  write(`  to embed: ${p.toEmbed.length}`);

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    write('');
    write('EMBEDDINGS SKIPPED — GEMINI_API_KEY is not set.');
    write('  Groq serves no embedding endpoint, so vector search stays dark until it is.');
    write('  The corpus above is mirrored and keyword-retrievable regardless.');
    return;
  }

  const embedded = await embedPending(brain, createGeminiEmbedder({ apiKey }), {
    now: () => new Date(),
  });

  write('');
  if (!embedded.ok) {
    // `ok: false` means we could not even list the work — a different alert
    // from a run that happened and had failures, and collapsing the two makes a
    // broken provider look like a quiet one.
    write(`EMBEDDING FAILED: ${embedded.reason} — ${embedded.detail}`);
    return;
  }
  write(
    `embedded ${embedded.report.embedded} chunk(s) in ${embedded.report.batches} batch(es); ` +
      `${embedded.report.failed} failed`,
  );
  if (embedded.report.deferred > 0) {
    write(`  ${embedded.report.deferred} deferred to the next run — not a failure`);
  }
  for (const f of embedded.report.failures) write(`  ✗ ${f.reason}: ${f.detail}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  brainSync()
    .catch((error: unknown) => {
      process.stderr.write(`brain sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}
