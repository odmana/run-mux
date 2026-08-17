import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { platform } from 'node:os';

import { normalize } from '../paths.js';
import type { Checkout } from '../types.js';

const GIT_TIMEOUT_MS = 15_000;

/** Forward slashes and no trailing separator, so two spellings of a path compare equal. */
export function canonicalPath(p: string): string {
  const forward = normalize(p).replace(/\/+$/, '');
  return forward === '' ? '/' : forward;
}

/** Windows paths are case-insensitive, so a slot or target lookup has to be too. */
export function pathKey(p: string): string {
  const canonical = canonicalPath(p);
  return platform() === 'win32' ? canonical.toLowerCase() : canonical;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * Every checkout of the repo, main worktree first. Read-only: run-mux never
 * creates or removes a worktree. Any git failure (missing git, not a repo,
 * vanished directory) is reported as "no checkouts" rather than thrown.
 */
export function listCheckouts(repoPath: string): Checkout[] {
  const output = git(repoPath, ['worktree', 'list', '--porcelain']);
  return output === null ? [] : parsePorcelain(output);
}

export function findCheckout(repoPath: string, checkoutPath: string): Checkout | undefined {
  return listCheckouts(repoPath).find((checkout) => samePath(checkout.path, checkoutPath));
}

export function repoRoot(dir: string): string | null {
  const output = git(dir, ['rev-parse', '--show-toplevel']);
  const root = output?.trim();
  return root ? canonicalPath(root) : null;
}

/** False once the working tree is gone; the target it backs becomes `unavailable`, never removed. */
export function isAvailable(checkoutPath: string): boolean {
  try {
    return statSync(checkoutPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `git worktree list --porcelain` emits one record per worktree separated by a
 * blank line: `worktree <path>`, then `HEAD <sha>` plus either `branch
 * refs/heads/<name>` or a bare `detached`, and optional `bare`/`locked`/
 * `prunable` markers. The first record is the main worktree — except in a bare
 * repo, where it is the bare repository itself and there is no main worktree.
 */
function parsePorcelain(output: string): Checkout[] {
  const checkouts: Checkout[] = [];
  let recordIndex = 0;
  for (const block of output.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      if (line === '') continue;
      const space = line.indexOf(' ');
      if (space === -1) fields.set(line, '');
      else fields.set(line.slice(0, space), line.slice(space + 1));
    }
    const path = fields.get('worktree');
    if (path === undefined) continue;
    const isMain = recordIndex === 0;
    recordIndex++;
    if (fields.has('bare')) continue;
    checkouts.push({
      path: canonicalPath(path),
      branch: (fields.get('branch') ?? '').replace(/^refs\/heads\//, ''),
      head: fields.get('HEAD') ?? '',
      isMain,
    });
  }
  return checkouts;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
