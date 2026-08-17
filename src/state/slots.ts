import { canonicalPath, pathKey, samePath } from '../git/worktrees.js';
import type { AppState } from '../types.js';
import { loadState, updateState } from './state.js';

export const MAIN_SLOT = 0;

/**
 * checkout -> repo, learned as slots are handed out. `slots` on disk is keyed by
 * checkout alone (that is the contract other modules read), so the repo a
 * checkout belongs to is recovered from its targets after a restart and from
 * this index within a run.
 */
const repoIndex = new Map<string, string>();

/**
 * The main worktree is always slot 0 so `main` keeps the ports the repo's own
 * config already expects; every other checkout takes the lowest free integer
 * >= 1 within its repo. An already-known checkout keeps the slot it has, which
 * is what makes slots survive a daemon restart.
 */
export function allocateSlot(repoPath: string, checkoutPath: string, isMain: boolean): number {
  const repo = canonicalPath(repoPath);
  const checkout = canonicalPath(checkoutPath);
  repoIndex.set(pathKey(checkout), repo);

  const state = loadState();
  const existing = findSlotKey(state, checkout);
  if (existing !== undefined) return state.slots[existing]!;

  const slot = isMain ? MAIN_SLOT : lowestFree(state, repo);
  updateState({ slots: { ...state.slots, [checkout]: slot } });
  return slot;
}

export function slotFor(checkoutPath: string): number | undefined {
  const state = loadState();
  const key = findSlotKey(state, checkoutPath);
  return key === undefined ? undefined : state.slots[key];
}

export function listSlots(): Record<string, number> {
  return loadState().slots;
}

/** Frees the slot unless a target still points at the checkout. */
export function releaseSlot(checkoutPath: string): boolean {
  const state = loadState();
  const key = findSlotKey(state, checkoutPath);
  if (key === undefined) return false;
  if (state.targets.some((target) => samePath(target.checkoutPath, checkoutPath))) return false;
  const slots = Object.fromEntries(Object.entries(state.slots).filter(([k]) => k !== key));
  updateState({ slots });
  return true;
}

/** Drops the in-process repo index; the daemon rebuilds it from targets on the next allocation. */
export function resetSlotIndex(): void {
  repoIndex.clear();
}

function findSlotKey(state: AppState, checkoutPath: string): string | undefined {
  return Object.keys(state.slots).find((key) => samePath(key, checkoutPath));
}

function lowestFree(state: AppState, repo: string): number {
  const taken = new Set<number>();
  for (const [checkout, slot] of Object.entries(state.slots)) {
    if (repoOf(state, checkout) === repo) taken.add(slot);
  }
  let slot = MAIN_SLOT + 1;
  while (taken.has(slot)) slot++;
  return slot;
}

function repoOf(state: AppState, checkoutPath: string): string | undefined {
  const key = pathKey(checkoutPath);
  const known = repoIndex.get(key);
  if (known !== undefined) return known;
  const target = state.targets.find((t) => samePath(t.checkoutPath, checkoutPath));
  if (target === undefined) return undefined;
  const repo = canonicalPath(target.repoPath);
  repoIndex.set(key, repo);
  return repo;
}
