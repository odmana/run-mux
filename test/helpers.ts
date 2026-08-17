import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Playbook } from '../src/types.js';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Builds a shell command string that runs one of the mock fixtures. Everything
 * is double-quoted because the runtime path and the repo path both contain
 * spaces on a normal Windows install.
 */
export function mock(fixture: string, args: (string | number)[] = []): string {
  const script = join(FIXTURE_DIR, fixture).replaceAll('\\', '/');
  const rendered = args.map((a) => String(a)).join(' ');
  return `"${process.execPath.replaceAll('\\', '/')}" "${script}"${rendered ? ' ' + rendered : ''}`;
}

export const ticker = (args: (string | number)[] = []): string => mock('ticker.mjs', args);
export const service = (args: (string | number)[] = []): string => mock('service.mjs', args);
export const spawner = (): string => mock('spawner.mjs');
export const envDump = (names: string[] = []): string => mock('env-dump.mjs', names);
export const chatty = (args: (string | number)[] = []): string => mock('chatty.mjs', args);

export interface TempHome {
  root: string;
  cleanup: () => void;
}

/**
 * Points every run-mux path at a throwaway directory for the duration of a test.
 * Restores the previous value so suites can't leak into each other.
 */
export function useTempHome(): TempHome {
  const previous = process.env.RUN_MUX_HOME;
  const root = mkdtempSync(join(tmpdir(), 'run-mux-test-')).replaceAll('\\', '/');
  process.env.RUN_MUX_HOME = root;
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  return {
    root,
    cleanup: () => {
      if (previous === undefined) delete process.env.RUN_MUX_HOME;
      else process.env.RUN_MUX_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * A real git repo with one commit, optionally carrying a committed
 * `.run-mux.json`. Real git because worktree enumeration shells out to it.
 */
export function makeGitRepo(name: string, playbooks?: Playbook[]): string {
  const dir = mkdtempSync(join(tmpdir(), `run-mux-repo-${name}-`)).replaceAll('\\', '/');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  if (playbooks) {
    writeFileSync(join(dir, '.run-mux.json'), JSON.stringify({ playbooks }, null, 2));
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

/** Adds a linked worktree on a new branch and returns its absolute path. */
export function addWorktree(repoDir: string, branch: string): string {
  const dir = join(repoDir, '..', `${branch}-wt-${Date.now()}`).replaceAll('\\', '/');
  git(repoDir, ['worktree', 'add', '-q', '-b', branch, dir]);
  return dir;
}

/** Polls until the predicate holds, so tests never sleep a fixed duration. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeout = 8000, interval = 25, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** True while the pid is alive; the portable way to assert a kill landed. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
