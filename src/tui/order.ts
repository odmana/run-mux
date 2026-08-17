/**
 * The sidebar's display order, layered over the daemon's.
 *
 * Deliberately not a permutation of the daemon's target list: `rmux ls` and
 * `--json` answer in registration order and must keep doing so, and grouping is
 * by `repoPath`, so moving a target's array position could reshuffle a repo's
 * whole block as a side effect. An explicit order is a view concern and stays
 * one.
 */

/** Keys absent from a list keep the daemon's order, after the ones that are listed. */
export interface SidebarOrder {
  repos: readonly string[];
  targets: Readonly<Record<string, readonly string[]>>;
}

export const NO_ORDER: SidebarOrder = { repos: [], targets: {} };

/** Stable: listed keys first in the order given, everything else after, undisturbed. */
export function sortByOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...items];
  const listed = new Map<string, T[]>(order.map((key) => [key, []]));
  const rest: T[] = [];
  for (const item of items) {
    const bucket = listed.get(keyOf(item));
    if (bucket === undefined) rest.push(item);
    else bucket.push(item);
  }
  return [...order.flatMap((key) => listed.get(key) ?? []), ...rest];
}

/**
 * Moves `from` into the slot `to` currently occupies, which is what the pointer
 * is pointing at. Everything else keeps its relative order.
 */
export function moveInto(list: readonly string[], from: string, to: string): string[] {
  if (from === to) return [...list];
  const fromAt = list.indexOf(from);
  const toAt = list.indexOf(to);
  if (fromAt < 0 || toAt < 0) return [...list];
  const without = list.filter((entry) => entry !== from);
  const anchor = without.indexOf(to);
  without.splice(fromAt < toAt ? anchor + 1 : anchor, 0, from);
  return without;
}
