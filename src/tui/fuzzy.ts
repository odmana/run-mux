/**
 * The subsequence matcher every picker ranks with.
 *
 * Ported from agent-mux's `server/src/fuzzy-match.ts` rather than reinvented, so
 * a query a user already had in their fingers still finds the same thing. It
 * returns `matchIndices` as well as a score because the picker highlights the
 * characters the query actually hit — a score alone cannot draw that.
 *
 * Pure and dependency-free; `test/tui.test.ts` exercises it directly.
 */

export interface FuzzyMatch {
  score: number;
  /** Ascending indices into the candidate — the characters the query matched. */
  matchIndices: number[];
}

function isWordBoundary(candidate: string, index: number): boolean {
  if (index === 0) return true;
  const previous = candidate[index - 1] ?? '';
  if (previous === '-' || previous === '_' || previous === '.' || previous === ' ') return true;
  if (previous === '/' || previous === '\\' || previous === ':') return true;
  const here = candidate[index] ?? '';
  // camelCase: a lowercase letter followed by an uppercase one starts a word.
  return (
    previous === previous.toLowerCase() &&
    previous !== previous.toUpperCase() &&
    here === here.toUpperCase() &&
    here !== here.toLowerCase()
  );
}

/**
 * `null` when the query is not a subsequence of the candidate. An empty query
 * matches everything at a neutral score, which is what makes a freshly opened
 * picker show the whole list.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  if (query === '') return { score: 0, matchIndices: [] };

  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();

  const matchIndices: number[] = [];
  let from = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, from);
    if (found === -1) return null;
    matchIndices.push(found);
    from = found + 1;
  }

  let score = 0;
  for (let i = 0; i < matchIndices.length; i++) {
    const at = matchIndices[i]!;
    score += 1;
    if (at === 0) score += 5;
    if (isWordBoundary(candidate, at)) score += 3;
    if (i > 0) {
      const previous = matchIndices[i - 1]!;
      if (at === previous + 1) score += 4;
      score -= at - previous - 1;
    }
  }

  return { score, matchIndices };
}

export interface Ranked<T> extends FuzzyMatch {
  item: T;
  /** The text the match was made against, and the alphabetical tie-break. */
  text: string;
}

/**
 * Score first, then the text. Without the second key an equal-scoring pair would
 * reorder itself every time the daemon answered in a different order, and the
 * row under the cursor would move out from under Enter.
 */
export function compareRanked(
  a: { score: number; text: string },
  b: {
    score: number;
    text: string;
  },
): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.text.localeCompare(b.text);
}

export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
): Ranked<T>[] {
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const candidate = text(item);
    const match = fuzzyMatch(query, candidate);
    if (match !== null) ranked.push({ item, text: candidate, ...match });
  }
  return ranked.sort(compareRanked);
}
