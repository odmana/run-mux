import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { stateDir, statePath } from '../src/paths.js';
import {
  addChild,
  aliasMap,
  allocateSlot,
  clearChildren,
  createTarget,
  emptyState,
  listSlots,
  listTargets,
  loadState,
  releaseSlot,
  removeChild,
  removeTarget,
  resetSlotIndex,
  resolveTarget,
  slotFor,
  slugFor,
  updateState,
} from '../src/state/index.js';
import type { AppState, ChildRecord, TargetRecord } from '../src/types.js';
import { addWorktree, makeGitRepo, useTempHome, type TempHome } from './helpers.js';

const REPO_A = '/repos/orders';
const MAIN_A = '/repos/orders';
const WT_A1 = '/repos/worktrees/feat-x';
const WT_A2 = '/repos/worktrees/feat-y';
const WT_A3 = '/repos/worktrees/feat-z';
const REPO_B = '/repos/studio';
const MAIN_B = '/repos/studio';
const WT_B1 = '/repos/worktrees/studio-feat';

let home: TempHome;
const scratch: string[] = [];

beforeEach(() => {
  home = useTempHome();
  resetSlotIndex();
});

afterEach(() => {
  home.cleanup();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function repo(name: string): string {
  const dir = makeGitRepo(name);
  scratch.push(dir);
  return dir;
}

function worktree(repoDir: string, branch: string): string {
  const dir = addWorktree(repoDir, branch);
  scratch.push(dir);
  return dir;
}

function child(pid: number): ChildRecord {
  return { pid, startedAt: 1700000000000, label: 'web', targetSlug: 'orders/main:dev' };
}

function target(slug: string, checkoutPath = MAIN_A): TargetRecord {
  return {
    slug,
    repoPath: REPO_A,
    checkoutPath,
    playbookName: 'dev',
    createdAt: 1700000000000,
  };
}

/** Rewrites the file so the next load cannot be served from cache, then drops in-process indexes. */
function simulateRestart(): AppState {
  writeFileSync(statePath(), readFileSync(statePath(), 'utf-8'));
  resetSlotIndex();
  return loadState();
}

function tempFiles(): string[] {
  return readdirSync(stateDir()).filter((name) => name.endsWith('.tmp'));
}

describe('state file', () => {
  it('returns an empty state when the file is missing', () => {
    expect(loadState()).toEqual(emptyState());
  });

  it('returns an empty state for a truncated file without throwing', () => {
    writeFileSync(statePath(), '{"targets": [{"slug"');
    expect(loadState()).toEqual(emptyState());
  });

  it('returns an empty state when the file does not match the schema', () => {
    writeFileSync(statePath(), JSON.stringify({ targets: 'nope', slots: {}, children: [] }));
    expect(loadState()).toEqual(emptyState());
  });

  it('round-trips a valid state through disk', () => {
    const state: AppState = {
      targets: [target('orders/main:dev')],
      slots: { [MAIN_A]: 0, [WT_A1]: 1 },
      children: [child(4242)],
      ui: { sidebarWidth: 240, collapsedRepos: [REPO_A] },
    };
    updateState(state);
    expect(JSON.parse(readFileSync(statePath(), 'utf-8'))).toEqual(state);
    expect(simulateRestart()).toEqual(state);
  });

  it('writes through a temp file and rename, leaving no partial file behind', () => {
    updateState({ targets: [target('orders/main:dev')] });
    const before = statSync(statePath(), { bigint: true });

    updateState({ children: Array.from({ length: 200 }, (_, i) => child(1000 + i)) });
    const after = statSync(statePath(), { bigint: true });

    const overwrittenInPlace = before.ino !== 0n && after.ino === before.ino;
    expect(overwrittenInPlace).toBe(false);
    expect(tempFiles()).toEqual([]);
    const onDisk = JSON.parse(readFileSync(statePath(), 'utf-8'));
    expect(onDisk.children).toHaveLength(200);
    expect(onDisk.targets).toHaveLength(1);
  });

  it('leaves the existing file untouched when an update fails validation', () => {
    updateState({ targets: [target('orders/main:dev')] });
    const before = readFileSync(statePath(), 'utf-8');

    const returned = updateState({ children: [{ pid: 'nope' } as unknown as ChildRecord] });

    expect(readFileSync(statePath(), 'utf-8')).toBe(before);
    expect(returned.targets).toHaveLength(1);
    expect(returned.children).toEqual([]);
  });

  it('ignores a temp file left behind by a crashed write', () => {
    updateState({ targets: [target('orders/main:dev')] });
    writeFileSync(`${statePath()}.9999.0.tmp`, '{"targets": [{"slug"');
    expect(simulateRestart().targets).toHaveLength(1);
  });

  it('adds, removes and clears children', () => {
    addChild(child(11));
    addChild(child(12));
    expect(loadState().children.map((c) => c.pid)).toEqual([11, 12]);

    removeChild(11);
    expect(simulateRestart().children.map((c) => c.pid)).toEqual([12]);

    clearChildren();
    expect(simulateRestart().children).toEqual([]);
  });

  it('replaces a child record rather than duplicating the pid', () => {
    addChild(child(11));
    addChild({ ...child(11), label: 'api' });
    expect(loadState().children).toEqual([{ ...child(11), label: 'api' }]);
  });
});

describe('slots', () => {
  it('always gives the main worktree slot 0', () => {
    expect(allocateSlot(REPO_A, MAIN_A, true)).toBe(0);
    expect(listSlots()).toEqual({ [MAIN_A]: 0 });
  });

  it('gives additional checkouts the lowest free integer from 1', () => {
    expect(allocateSlot(REPO_A, MAIN_A, true)).toBe(0);
    expect(allocateSlot(REPO_A, WT_A1, false)).toBe(1);
    expect(allocateSlot(REPO_A, WT_A2, false)).toBe(2);
  });

  it('scopes slots per repo', () => {
    allocateSlot(REPO_A, MAIN_A, true);
    allocateSlot(REPO_A, WT_A1, false);

    expect(allocateSlot(REPO_B, MAIN_B, true)).toBe(0);
    expect(allocateSlot(REPO_B, WT_B1, false)).toBe(1);
  });

  it('returns the existing slot for a checkout it already knows', () => {
    allocateSlot(REPO_A, MAIN_A, true);
    const first = allocateSlot(REPO_A, WT_A1, false);
    expect(allocateSlot(REPO_A, WT_A1, false)).toBe(first);
    expect(Object.keys(listSlots())).toHaveLength(2);
  });

  it('keeps a checkout on the same slot across a restart', () => {
    allocateSlot(REPO_A, MAIN_A, true);
    const first = allocateSlot(REPO_A, WT_A1, false);

    simulateRestart();

    expect(slotFor(WT_A1)).toBe(first);
    expect(allocateSlot(REPO_A, WT_A1, false)).toBe(first);
  });

  it('recovers per-repo scoping from targets after a restart', () => {
    createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'dev' });
    createTarget({ repoPath: REPO_A, checkoutPath: WT_A1, playbookName: 'dev' });

    simulateRestart();

    expect(allocateSlot(REPO_A, WT_A2, false)).toBe(2);
  });

  it('reuses the lowest free integer after a release', () => {
    allocateSlot(REPO_A, MAIN_A, true);
    allocateSlot(REPO_A, WT_A1, false);
    allocateSlot(REPO_A, WT_A2, false);

    expect(releaseSlot(WT_A1)).toBe(true);
    expect(slotFor(WT_A1)).toBeUndefined();
    expect(allocateSlot(REPO_A, WT_A3, false)).toBe(1);
  });

  it('refuses to release a slot while a target still uses the checkout', () => {
    createTarget({ repoPath: REPO_A, checkoutPath: WT_A1, playbookName: 'dev' });
    expect(releaseSlot(WT_A1)).toBe(false);
    expect(slotFor(WT_A1)).toBe(1);
  });
});

describe('targets', () => {
  it('slugs a main worktree as <repo>/main:<playbook>', () => {
    const dir = repo('orders');
    const slug = slugFor(dir, dir, 'run orders');
    expect(slug.endsWith('/main:run-orders')).toBe(true);
  });

  it('slugs a linked worktree with its branch name', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');
    expect(slugFor(dir, linked, 'dev').endsWith('/feature-x:dev')).toBe(true);
  });

  it('lowercases and collapses dots and spaces', () => {
    expect(
      slugFor('/src/TicketSolutions.Orders', '/src/TicketSolutions.Orders', 'Run Orders'),
    ).toBe('ticketsolutions-orders/main:run-orders');
    expect(
      slugFor('/src/orders', '/src/wt', 'Dev', { branch: 'feature/API  v2', isMain: false }),
    ).toBe('orders/feature-api-v2:dev');
  });

  it('falls back to the directory name for a checkout with no branch', () => {
    expect(slugFor('/src/orders', '/src/wt-detached', 'dev', { branch: '', isMain: false })).toBe(
      'orders/wt-detached:dev',
    );
  });

  it('creates a target with a slot and rejects a duplicate', () => {
    const created = createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'dev' });
    expect(created).toMatchObject({ ok: true, slot: 0 });

    const again = createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'dev' });
    expect(again).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(listTargets()).toHaveLength(1);
  });

  it('keeps the slot until the last target on a checkout is removed', () => {
    createTarget({ repoPath: REPO_A, checkoutPath: WT_A1, playbookName: 'dev' });
    createTarget({ repoPath: REPO_A, checkoutPath: WT_A1, playbookName: 'test' });
    const [first, second] = listTargets();

    expect(removeTarget(first!.slug)).toBe(true);
    expect(slotFor(WT_A1)).toBe(1);

    expect(removeTarget(second!.slug)).toBe(true);
    expect(slotFor(WT_A1)).toBeUndefined();
    expect(listTargets()).toEqual([]);
  });

  it('resolves an exact slug, an alias and a unique prefix', () => {
    createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'dev' });
    createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'devtools' });
    const aliases = aliasMap({ 'orders/main:dev': { alias: 'o' } });

    const exact = resolveTarget('orders/main:dev');
    expect(exact.ok && exact.target.playbookName).toBe('dev');

    const aliased = resolveTarget('o', aliases);
    expect(aliased.ok && aliased.target.slug).toBe('orders/main:dev');

    const prefixed = resolveTarget('orders/main:devt');
    expect(prefixed.ok && prefixed.target.playbookName).toBe('devtools');
  });

  it('reports every candidate for an ambiguous prefix instead of picking one', () => {
    createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'dev' });
    createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'devtools' });

    const result = resolveTarget('orders/main:d');

    expect(result).toEqual({
      ok: false,
      reason: 'ambiguous',
      matches: ['orders/main:dev', 'orders/main:devtools'],
    });
  });

  it('reports not_found for an unknown query', () => {
    createTarget({ repoPath: REPO_A, checkoutPath: MAIN_A, playbookName: 'dev' });
    expect(resolveTarget('studio')).toEqual({ ok: false, reason: 'not_found', matches: [] });
  });
});
