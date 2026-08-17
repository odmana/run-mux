import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import * as v from 'valibot';

import { statePath } from '../paths.js';
import type { AppState, ChildRecord, UiState } from '../types.js';

const NonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0));

export const TargetRecordSchema = v.object({
  slug: v.pipe(v.string(), v.minLength(1)),
  repoPath: v.string(),
  checkoutPath: v.string(),
  playbookName: v.string(),
  autostart: v.optional(v.boolean()),
  createdAt: v.number(),
});

export const ChildRecordSchema = v.object({
  pid: NonNegativeInt,
  startedAt: v.number(),
  label: v.string(),
  targetSlug: v.string(),
});

export const UiStateSchema = v.object({
  sidebarWidth: v.optional(v.number()),
  collapsedRepos: v.optional(v.array(v.string())),
  repoOrder: v.optional(v.array(v.string())),
  targetOrder: v.optional(v.record(v.string(), v.array(v.string()))),
});

export const AppStateSchema = v.object({
  targets: v.array(TargetRecordSchema),
  slots: v.record(v.string(), NonNegativeInt),
  children: v.array(ChildRecordSchema),
  ui: v.optional(UiStateSchema),
});

export function emptyState(): AppState {
  return { targets: [], slots: {}, children: [] };
}

/**
 * The daemon rewrites state on every child spawn, so a read is served from
 * memory unless the file changed underneath us (nanosecond mtime plus size).
 */
interface StateCache {
  path: string;
  mtimeNs: bigint;
  size: bigint;
  state: AppState;
}

let cache: StateCache | null = null;
let tempCounter = 0;

/** A missing, unreadable or invalid state file yields an empty state, never a throw. */
export function loadState(): AppState {
  const path = statePath();
  const stat = statOrNull(path);
  if (
    cache !== null &&
    cache.path === path &&
    stat !== null &&
    cache.mtimeNs === stat.mtimeNs &&
    cache.size === stat.size
  ) {
    return structuredClone(cache.state);
  }
  if (stat === null) {
    cache = null;
    return emptyState();
  }
  let state = emptyState();
  try {
    const result = v.safeParse(AppStateSchema, JSON.parse(readFileSync(path, 'utf-8')));
    if (result.success) state = result.output;
  } catch {
    // Truncated or non-JSON file: fall through to the empty state.
  }
  cache = { path, mtimeNs: stat.mtimeNs, size: stat.size, state };
  return structuredClone(state);
}

/**
 * Validates and writes atomically. An invalid state is dropped rather than
 * written, so a bad caller can never destroy a good file; the state on disk is
 * returned instead.
 */
export function saveState(state: AppState): AppState {
  const result = v.safeParse(AppStateSchema, state);
  if (!result.success) return loadState();
  writeAtomic(result.output);
  return structuredClone(result.output);
}

export function updateState(partial: Partial<AppState>): AppState {
  return saveState({ ...loadState(), ...partial });
}

/** Read-modify-write in one step. Mutate the draft in place or return a new state. */
export function mutateState(mutate: (state: AppState) => AppState | void): AppState {
  const draft = loadState();
  const next = (mutate(draft) as AppState | undefined) ?? draft;
  return saveState(next);
}

export function loadUi(): UiState {
  return loadState().ui ?? {};
}

/**
 * Field-wise merge, so the TUI can persist one setting without having to send —
 * and therefore without having to be the authority on — all the others.
 */
export function mergeUi(patch: UiState): UiState {
  return (
    mutateState((state) => {
      state.ui = { ...state.ui, ...patch };
    }).ui ?? {}
  );
}

export function listChildren(): ChildRecord[] {
  return loadState().children;
}

export function setChildren(children: ChildRecord[]): AppState {
  return updateState({ children });
}

export function addChild(child: ChildRecord): AppState {
  return mutateState((state) => {
    state.children = [...state.children.filter((c) => c.pid !== child.pid), child];
  });
}

export function removeChild(pid: number): AppState {
  return mutateState((state) => {
    state.children = state.children.filter((child) => child.pid !== pid);
  });
}

export function clearChildren(): AppState {
  return setChildren([]);
}

/**
 * Temp file plus rename, because the daemon writes on every spawn and a crash
 * mid-write would otherwise leave a truncated state file behind.
 */
function writeAtomic(state: AppState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${tempCounter++}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2));
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  const stat = statOrNull(path);
  cache =
    stat === null
      ? null
      : { path, mtimeNs: stat.mtimeNs, size: stat.size, state: structuredClone(state) };
}

function statOrNull(path: string): { mtimeNs: bigint; size: bigint } | null {
  try {
    return statSync(path, { bigint: true });
  } catch {
    return null;
  }
}
