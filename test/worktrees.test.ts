import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalPath, isAvailable, listCheckouts, repoRoot } from '../src/git/index.js';
import {
  createTarget,
  isTargetAvailable,
  listTargets,
  resetSlotIndex,
} from '../src/state/index.js';
import { addWorktree, makeGitRepo, useTempHome, type TempHome } from './helpers.js';

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

function plainDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-mux-plain-')).replaceAll('\\', '/');
  scratch.push(dir);
  return dir;
}

describe('listCheckouts', () => {
  it('reports the main worktree of a repo with no linked worktrees', () => {
    const dir = repo('orders');

    const checkouts = listCheckouts(dir);

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.isMain).toBe(true);
    expect(checkouts[0]!.branch).toBe('main');
    expect(checkouts[0]!.path).toBe(canonicalPath(dir));
    expect(checkouts[0]!.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('lists a linked worktree alongside the main one', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');

    const checkouts = listCheckouts(dir);

    expect(checkouts).toHaveLength(2);
    expect(checkouts.filter((c) => c.isMain)).toHaveLength(1);
    expect(checkouts.find((c) => c.isMain)!.path).toBe(canonicalPath(dir));
    const branchWorktree = checkouts.find((c) => !c.isMain)!;
    expect(branchWorktree.branch).toBe('feature-x');
    expect(branchWorktree.path).toBe(canonicalPath(linked));
  });

  it('enumerates the same checkouts from inside a linked worktree', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');

    expect(listCheckouts(linked)).toEqual(listCheckouts(dir));
  });

  it('reports an empty branch for a detached HEAD', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');
    execFileSync('git', ['checkout', '--detach'], { cwd: linked, stdio: 'pipe' });

    const detached = listCheckouts(dir).find((c) => !c.isMain)!;

    expect(detached.branch).toBe('');
    expect(detached.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns an empty array for a directory that is not a git repo', () => {
    expect(listCheckouts(plainDir())).toEqual([]);
  });

  it('returns an empty array for a directory that does not exist', () => {
    expect(listCheckouts(join(tmpdir(), 'run-mux-does-not-exist'))).toEqual([]);
  });

  it('still lists a worktree whose directory has been deleted', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');
    rmSync(linked, { recursive: true, force: true, maxRetries: 3 });

    const checkouts = listCheckouts(dir);

    expect(checkouts).toHaveLength(2);
    expect(checkouts.find((c) => !c.isMain)!.branch).toBe('feature-x');
  });
});

describe('repoRoot', () => {
  it('returns the checkout root for a directory inside a repo', () => {
    const dir = repo('orders');
    expect(repoRoot(dir)).toBe(canonicalPath(dir));
  });

  it('returns the linked worktree root from inside a linked worktree', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');
    expect(repoRoot(linked)).toBe(canonicalPath(linked));
  });

  it('returns null outside a repo', () => {
    expect(repoRoot(plainDir())).toBeNull();
  });
});

describe('isAvailable', () => {
  it('goes false once the checkout directory is deleted', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');

    expect(isAvailable(linked)).toBe(true);

    rmSync(linked, { recursive: true, force: true, maxRetries: 3 });

    expect(isAvailable(linked)).toBe(false);
  });

  it('leaves a target on a vanished checkout registered but unavailable', () => {
    const dir = repo('orders');
    const linked = worktree(dir, 'feature-x');
    const created = createTarget({ repoPath: dir, checkoutPath: linked, playbookName: 'dev' });
    expect(created.ok).toBe(true);

    rmSync(linked, { recursive: true, force: true, maxRetries: 3 });

    const target = listTargets()[0]!;
    expect(target.slug.endsWith('/feature-x:dev')).toBe(true);
    expect(isTargetAvailable(target)).toBe(false);
  });
});
