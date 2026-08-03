/**
 * T0 — near-duplicate detection via 64-bit SimHash.
 *
 * Catches "same article, different wrapper" that canonical-URL dedup misses.
 * 64-bit SimHash performs comparably to much larger MinHash signatures at a
 * fraction of the storage, and fits in a single bigint column with a bit index.
 * MinHash+LSH is the right tool at corpus sizes in the millions; we are nowhere
 * near that, and it is heavier to operate.
 *
 * Semantic dedup ("same story, different words") is deliberately NOT here —
 * SimHash scores those near zero. That is the embedding stage, and it runs on a
 * candidate set only, never the firehose.
 */
import { createHash } from 'node:crypto';

const BITS = 64n;
const MASK = (1n << BITS) - 1n;

/** Shingle into overlapping word 3-grams: robust to small edits, cheap. */
export function shingles(text: string, n = 3): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < n) return words.length ? [words.join(' ')] : [];
  const out: string[] = [];
  for (let i = 0; i <= words.length - n; i++) out.push(words.slice(i, i + n).join(' '));
  return out;
}

function hash64(s: string): bigint {
  const digest = createHash('sha1').update(s).digest();
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & MASK;
}

/** Returns the signature as a decimal string so it round-trips through a
 *  Postgres bigint without JS number precision loss. */
export function simhash(text: string): string {
  const grams = shingles(text);
  if (grams.length === 0) return '0';

  const weights = new Array<number>(64).fill(0);
  const counts = new Map<string, number>();
  for (const g of grams) counts.set(g, (counts.get(g) ?? 0) + 1);

  for (const [gram, weight] of counts) {
    const h = hash64(gram);
    for (let bit = 0; bit < 64; bit++) {
      const set = (h >> BigInt(bit)) & 1n;
      weights[bit]! += set === 1n ? weight : -weight;
    }
  }

  let sig = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit]! > 0) sig |= 1n << BigInt(bit);
  }
  // Store as signed 64-bit to match Postgres bigint range.
  const signed = sig >= 1n << 63n ? sig - (1n << 64n) : sig;
  return signed.toString();
}

export function hammingDistance(a: string, b: string): number {
  const toUnsigned = (v: string): bigint => {
    const n = BigInt(v);
    return n < 0n ? n + (1n << 64n) : n;
  };
  let x = toUnsigned(a) ^ toUnsigned(b);
  let d = 0;
  while (x) {
    x &= x - 1n;
    d++;
  }
  return d;
}

/**
 * Near-duplicate threshold, calibrated on OUR corpus rather than inherited.
 *
 * The canonical k=3 for 64-bit signatures comes from web-scale dedup, where a
 * document has hundreds or thousands of shingles and a small edit moves very
 * few bits. Our items are headlines, forum posts and article summaries — around
 * 20–200 shingles — so a proportionally larger share of the signature moves for
 * the same trivial edit.
 *
 * Measured on a representative pair (30 shingles): appending one word to an
 * otherwise identical article gives distance 4, while an unrelated article on a
 * different topic gives 35. The separation is wide, so 8 sits comfortably
 * between the two with room on both sides. Re-measure if the corpus shifts
 * toward much longer documents.
 */
export const NEAR_DUP_THRESHOLD = 8;

export const isNearDuplicate = (a: string, b: string, threshold = NEAR_DUP_THRESHOLD): boolean =>
  hammingDistance(a, b) <= threshold;
