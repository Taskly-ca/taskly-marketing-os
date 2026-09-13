/**
 * THE BRAIN FILES — the two the worker refuses to run without, made present.
 *
 * `TASKLY_FACT_SHEET` and `TASKLY_BRAIN_SNAPSHOT` name files that live in the
 * marketplace repo on the founder's disk. Both readers deliberately have no
 * default path, so a machine with neither file cannot run the verifier or the
 * brain stage — and must not guess. This script puts the same two files in
 * `brain/` (gitignored) from whichever source this machine has, first match:
 *
 *   1. `TASKLY_REPO_DIR` — a local checkout of taskly.ca. The laptop, and the
 *      deploy script, which stages `brain/` into the upload so Railway gets
 *      the files without a git credential.
 *   2. `GITHUB_TOKEN` — download the repo tarball from the GitHub API. The
 *      repo went PRIVATE (2026-09-13), so an anonymous download 404s; a
 *      fine-grained token with contents:read on Taskly-ca/taskly.ca is enough.
 *      This is the path for a Railway service built from the GitHub source.
 *   3. Neither, but both files already sit in `brain/` — shipped with the
 *      upload. Kept as they are.
 *
 * In every case the snapshot is produced by THAT repo's own
 * `scripts/brain-snapshot.mjs` against its own vault, so it is built by the
 * code that owns its schema rather than a copy that would drift.
 *
 * Nothing found: fail loud. A build that shipped without these would run a
 * pass whose verifier and brain stage both FAIL every day — reported, never
 * exited on — which is the quiet failure the readers exist to prevent.
 *
 * Point the env vars at the output. On Railway the app root is /app:
 *   TASKLY_FACT_SHEET=/app/brain/FACT-SHEET.md
 *   TASKLY_BRAIN_SNAPSHOT=/app/brain/taskly-brain-snapshot.json
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'brain');
const SHEET_REL = 'taskly-brain/00-brain/FACT-SHEET.md';
const SNAPSHOT_REL = 'scripts/brain-snapshot.mjs';
const OUT_SHEET = join(OUT, 'FACT-SHEET.md');
const OUT_SNAPSHOT = join(OUT, 'taskly-brain-snapshot.json');

const log = (line) => process.stdout.write(`[fetch-brain] ${line}\n`);

/** Copy the sheet and build the snapshot from a checkout at `repoDir`. */
function buildFrom(repoDir, label) {
  const sheet = join(repoDir, SHEET_REL);
  const script = join(repoDir, SNAPSHOT_REL);
  for (const f of [sheet, script]) {
    if (!existsSync(f)) throw new Error(`${label}: expected file missing: ${f}`);
  }
  mkdirSync(OUT, { recursive: true });
  copyFileSync(sheet, OUT_SHEET);
  log(`wrote brain/FACT-SHEET.md from ${label}`);
  execFileSync(process.execPath, [script, '--out', OUT_SNAPSHOT], { cwd: repoDir, stdio: 'inherit' });
  log(`wrote brain/taskly-brain-snapshot.json from ${label}`);
}

const localRepo = process.env['TASKLY_REPO_DIR']?.trim();
const token = process.env['GITHUB_TOKEN']?.trim();
const repo = process.env['TASKLY_SOURCE_REPO'] ?? 'Taskly-ca/taskly.ca';
const ref = process.env['TASKLY_SOURCE_REF'] ?? 'main';

const shipped = existsSync(OUT_SHEET) && existsSync(OUT_SNAPSHOT);

async function buildFromGitHub() {
  const url = `https://api.github.com/repos/${repo}/tarball/${ref}`;
  log(`downloading ${url}`);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'tmos-fetch-brain', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`tarball download failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  log(`${(bytes.length / 1e6).toFixed(1)} MB`);
  const work = mkdtempSync(join(tmpdir(), 'taskly-src-'));
  try {
    execFileSync('tar', ['-xzf', '-', '-C', work], { input: bytes, stdio: ['pipe', 'inherit', 'inherit'] });
    // The API tarball's single top directory is `<owner>-<repo>-<sha>`; find it
    // rather than predict it.
    const [top, ...rest] = readdirSync(work);
    if (!top || rest.length > 0) throw new Error(`unexpected tarball layout: ${[top, ...rest].join(', ')}`);
    buildFrom(join(work, top), `${repo}@${ref}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (localRepo) {
  buildFrom(resolve(localRepo), `TASKLY_REPO_DIR (${localRepo})`);
} else if (token) {
  try {
    await buildFromGitHub();
  } catch (err) {
    // A token that cannot read the repo (wrong owner, org policy, expired) must
    // not sink a build that already carries the files — that happened on
    // 2026-09-13, when a personal-owner token 404'd the private repo while the
    // upload had a perfectly good brain/ beside it. Keep the shipped copy, say so.
    if (!shipped) throw err;
    log(`GITHUB_TOKEN could not fetch the repo (${err instanceof Error ? err.message : err}) — keeping the brain/ files shipped with the upload`);
  }
} else if (shipped) {
  log('no TASKLY_REPO_DIR or GITHUB_TOKEN; brain/ already holds both files — keeping them');
} else {
  throw new Error(
    'no source for the brain files: set TASKLY_REPO_DIR (local checkout of taskly.ca), ' +
      'or GITHUB_TOKEN (contents:read on Taskly-ca/taskly.ca), or ship brain/ with the upload.',
  );
}
