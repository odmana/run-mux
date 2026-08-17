import { basename } from 'node:path';

import { canonicalPath, findCheckout, isAvailable, samePath } from '../git/worktrees.js';
import type { Checkout, TargetOverrides, TargetRecord } from '../types.js';
import { allocateSlot, releaseSlot } from './slots.js';
import { loadState, mutateState, updateState } from './state.js';

/** The checkout segment of a main worktree's slug, whatever its branch is called. */
const MAIN_SEGMENT = 'main';

export type CheckoutHint = Pick<Checkout, 'branch' | 'isMain'>;

export interface SlugInput {
  /** The repo's config key. Already slug-safe, so it is used verbatim. */
  repoKey: string;
  repoPath: string;
  checkoutPath: string;
  playbookName: string;
  /** Skips the git call when the caller already enumerated the checkout. */
  checkout?: CheckoutHint;
}

export interface CreateTargetInput extends SlugInput {
  autostart?: boolean;
}

export type CreateTargetResult =
  | { ok: true; target: TargetRecord; slot: number }
  | { ok: false; reason: 'duplicate' | 'slug_conflict'; existing: TargetRecord };

export type ResolveTargetResult =
  | { ok: true; target: TargetRecord }
  | { ok: false; reason: 'not_found' | 'ambiguous'; matches: string[] };

/** Lowercase, every run of non-alphanumerics collapsed to a single hyphen. */
export function slugify(part: string): string {
  const slug = part
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'unnamed' : slug;
}

/**
 * `<repo>/<checkout>:<playbook>` — e.g. `orders/main:run-orders`. The repo
 * segment is the config key, so the name a user registered is the name they
 * address. The checkout segment is `main` for the main worktree and the branch
 * for a linked one, falling back to the directory name for a detached HEAD.
 */
export function slugFor(input: SlugInput): string {
  const { repoKey, repoPath, checkoutPath, playbookName } = input;
  const resolved = input.checkout ?? findCheckout(repoPath, checkoutPath);
  const isMain = resolved?.isMain ?? samePath(repoPath, checkoutPath);
  const segment = isMain ? MAIN_SEGMENT : resolved?.branch || basename(canonicalPath(checkoutPath));
  return `${repoKey}/${slugify(segment)}:${slugify(playbookName)}`;
}

export function listTargets(): TargetRecord[] {
  return loadState().targets;
}

export function getTarget(slug: string): TargetRecord | undefined {
  return listTargets().find((target) => target.slug === slug);
}

/** Rejects a second target for the same checkout and playbook rather than duplicating it. */
export function createTarget(input: CreateTargetInput): CreateTargetResult {
  const repoPath = canonicalPath(input.repoPath);
  const checkoutPath = canonicalPath(input.checkoutPath);
  const state = loadState();

  const duplicate = state.targets.find(
    (target) =>
      samePath(target.checkoutPath, checkoutPath) && target.playbookName === input.playbookName,
  );
  if (duplicate) return { ok: false, reason: 'duplicate', existing: duplicate };

  const checkout = input.checkout ?? findCheckout(repoPath, checkoutPath);
  const isMain = checkout?.isMain ?? samePath(repoPath, checkoutPath);
  const slug = slugFor({ ...input, repoPath, checkoutPath, checkout });

  const collision = state.targets.find((target) => target.slug === slug);
  if (collision) return { ok: false, reason: 'slug_conflict', existing: collision };

  const slot = allocateSlot(repoPath, checkoutPath, isMain);
  const target: TargetRecord = {
    slug,
    repoPath,
    checkoutPath,
    playbookName: input.playbookName,
    createdAt: Date.now(),
    ...(input.autostart === undefined ? {} : { autostart: input.autostart }),
  };
  mutateState((draft) => {
    draft.targets = [...draft.targets, target];
  });
  return { ok: true, target, slot };
}

export function removeTarget(slug: string): boolean {
  const state = loadState();
  const target = state.targets.find((t) => t.slug === slug);
  if (target === undefined) return false;
  updateState({ targets: state.targets.filter((t) => t.slug !== slug) });
  releaseSlot(target.checkoutPath);
  return true;
}

/**
 * Exact slug, then alias, then unique prefix. Several prefix matches are
 * reported as ambiguous with every candidate, in registration order — never
 * silently resolved to one.
 * `aliases` maps alias to slug; it lives in the global config, so it is passed in.
 */
export function resolveTarget(
  query: string,
  aliases: Record<string, string> = {},
): ResolveTargetResult {
  const targets = listTargets();
  const needle = query.trim().toLowerCase();
  if (needle === '') return { ok: false, reason: 'not_found', matches: [] };

  const exact = targets.find((target) => target.slug === needle);
  if (exact) return { ok: true, target: exact };

  const aliasEntry = Object.entries(aliases).find(([alias]) => alias.toLowerCase() === needle);
  if (aliasEntry) {
    const aliased = targets.find((target) => target.slug === aliasEntry[1]);
    if (aliased) return { ok: true, target: aliased };
  }

  const prefixed = targets.filter((target) => target.slug.startsWith(needle));
  if (prefixed.length === 1) return { ok: true, target: prefixed[0]! };
  if (prefixed.length > 1) {
    return { ok: false, reason: 'ambiguous', matches: prefixed.map((t) => t.slug) };
  }
  return { ok: false, reason: 'not_found', matches: [] };
}

/** Inverts the global config's per-target overrides into the alias map `resolveTarget` wants. */
export function aliasMap(overrides: Record<string, TargetOverrides> = {}): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const [slug, override] of Object.entries(overrides)) {
    if (override.alias) aliases[override.alias] = slug;
  }
  return aliases;
}

/** A target whose checkout has vanished renders as `unavailable`; it is never deleted. */
export function isTargetAvailable(target: TargetRecord): boolean {
  return isAvailable(target.checkoutPath);
}
