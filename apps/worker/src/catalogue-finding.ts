/**
 * A COMPETITOR'S CATALOGUE CHANGED — the sentence that can actually be cited.
 *
 * The sitemap reading is the most reliable instrument in the system and it
 * could not publish, for a reason that was L0 rather than trust. T2's claim
 * template renders the observed value — "Jiffy's sitemap service count is now
 * 51" — and L0 requires every number in a claim to appear verbatim in a cited
 * span. A count derived from a document appears in no span, ever, so that
 * sentence is unciteable by construction and always will be.
 *
 * The sentence that IS citeable names the services:
 *
 *   "Jiffy's sitemap now lists mold-remediation and junk-removal, which it did
 *    not list before."
 *
 * Every value in it is a slug, every slug came off a `<loc>` line, and those
 * exact lines are the evidence. The claim and its proof are the same words.
 *
 * TWO DIRECTIONS, AND THE SECOND IS THE INTERESTING ONE. A service appearing is
 * an expansion; a service DISAPPEARING is a retreat, and it is the one a
 * competitor never announces. Both are reported, and removals lead when there
 * are any, because they are rarer and they are what nobody else will tell us.
 *
 * WHY THE SET AND NOT THE STRING. The stored value is a sorted comma-joined
 * catalogue, so any difference in it registers as a change — including one
 * caused by a sitemap that reordered itself, which is why sorting happens
 * before storage. Diffing the SETS is the second half of the same guarantee: if
 * the sets are equal the catalogue did not change, whatever the strings did,
 * and there is nothing to say.
 */

/** Sorted, comma-joined slugs — the stored form of a catalogue. */
type Catalogue = string;

interface CatalogueDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const parse = (c: Catalogue): string[] =>
  c
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

export function diffCatalogues(prior: Catalogue, next: Catalogue): CatalogueDiff {
  const before = new Set(parse(prior));
  const after = new Set(parse(next));
  return {
    added: [...after].filter((s) => !before.has(s)).sort(),
    removed: [...before].filter((s) => !after.has(s)).sort(),
  };
}

/** `a`, `a and b`, `a, b and c` — Oxford-free, because the claim is read aloud. */
export function list(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * How many services a claim names before it stops naming them.
 *
 * Above this the sentence stops being a claim and becomes a dump, and the span
 * that has to carry all of them stops being a citation anyone reads. The
 * remainder is counted — and the count is deliberately kept BELOW L0's
 * `BARE_INTEGER_FLOOR` of 10 in the common case, because a number in a claim
 * must appear in a span and "and 4 others" cannot.
 */
export const NAMED_LIMIT = 6;

interface CatalogueClaim {
  readonly claim: string;
  readonly so_what: string;
  /** Exactly the slugs the claim names — what the span must contain. */
  readonly cited: readonly string[];
}

/**
 * The claim, or null when the catalogue did not actually change.
 *
 * Null is not a failure. A reordered sitemap produces a different string and an
 * identical set, and saying nothing is the correct output for it.
 */
export function catalogueClaim(
  subject: string,
  prior: Catalogue,
  next: Catalogue,
): CatalogueClaim | null {
  const { added, removed } = diffCatalogues(prior, next);
  if (added.length === 0 && removed.length === 0) return null;

  const namedAdded = added.slice(0, NAMED_LIMIT);
  const namedRemoved = removed.slice(0, NAMED_LIMIT);
  const extra = added.length - namedAdded.length + (removed.length - namedRemoved.length);

  const parts: string[] = [];
  // Removals lead: a service withdrawn is rarer than one launched, and it is
  // the move a competitor will never put in a press release.
  if (namedRemoved.length > 0) {
    parts.push(`no longer lists ${list(namedRemoved)}`);
  }
  if (namedAdded.length > 0) {
    parts.push(`now lists ${list(namedAdded)}`);
  }

  const tail = extra > 0 ? `, among ${extra === 1 ? 'one other change' : 'other changes'}` : '';
  const claim = `${subject}'s sitemap ${parts.join(', and ')}${tail}.`;

  const soWhatParts: string[] = [];
  if (removed.length > 0) {
    soWhatParts.push(
      `${removed.length === 1 ? 'A service has' : `${removed.length} services have`} left their catalogue — check whether we can take that demand`,
    );
  }
  if (added.length > 0) {
    soWhatParts.push(
      `${added.length === 1 ? 'a category has' : `${added.length} categories have`} appeared in it — check whether our taxonomy covers them`,
    );
  }
  const so_what = `${soWhatParts.join('; ')}.`;

  return {
    claim,
    so_what: so_what.charAt(0).toUpperCase() + so_what.slice(1),
    cited: [...namedRemoved, ...namedAdded],
  };
}
