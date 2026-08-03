#!/usr/bin/env node
// Migration numbering gate. Sequential numbering breaks under parallel agents —
// two branches both claim 005 and the second silently wins on merge. This fails
// the build instead, and prints the next free number.
//
//   node scripts/check-migrations.mjs
import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'supabase/migrations');

if (!existsSync(DIR)) {
  console.log('No migrations directory yet — nothing to check.');
  process.exit(0);
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const seen = new Map();
const errors = [];

for (const f of files) {
  const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f);
  if (!m) {
    errors.push(`${f}: must match NNN_snake_case.sql`);
    continue;
  }
  const n = m[1];
  if (seen.has(n)) errors.push(`duplicate migration number ${n}: ${seen.get(n)} and ${f}`);
  else seen.set(n, f);
}

const numbers = [...seen.keys()].map(Number).sort((a, b) => a - b);
const next = String((numbers.at(-1) ?? 0) + 1).padStart(3, '0');

if (errors.length) {
  console.error(`\n✗ ${errors.length} migration error(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`\nNext free number: ${next}`);
  process.exit(1);
}

console.log(`✓ ${files.length} migrations, numbering OK. Next free number: ${next}`);
