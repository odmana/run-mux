import { platform } from 'node:os';

import type { GlobalConfig, ResolvedPlaybook } from '../types.js';
import { expandPath, loadGlobalConfig, loadRepoConfig } from './load.js';

/** Comparable form of a path: tilde expanded, forward-slashed, no trailing slash. */
export function canonicalPath(input: string): string {
  const expanded = expandPath(input).replace(/\/+$/, '');
  return platform() === 'win32' ? expanded.toLowerCase() : expanded;
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/**
 * The config key for a registered repo, or undefined when it isn't registered —
 * a checkout with only a committed `.run-mux.json` is still a legitimate target.
 * Takes the config rather than loading it so the daemon can pass its cached copy.
 */
export function repoKeyFor(config: GlobalConfig, repoPath: string): string | undefined {
  return Object.entries(config.repos).find(([, repo]) => samePath(repo.path, repoPath))?.[0];
}

export interface ResolvedPlaybooks {
  playbooks: ResolvedPlaybook[];
  problems: string[];
}

/**
 * Playbooks visible for one checkout: the committed `.run-mux.json` first, then
 * the global config's playbooks for this repo layered on top. A global playbook
 * with the same name replaces the repo's definition wholesale — never a merge,
 * so a user can override a playbook without inheriting commands they removed.
 */
export function resolvePlaybooks(repoPath: string, checkoutPath: string): ResolvedPlaybooks {
  const repoFile = loadRepoConfig(checkoutPath);
  const global = loadGlobalConfig();
  const owner = expandPath(repoPath);

  const playbooks: ResolvedPlaybook[] = repoFile.config.playbooks.map((pb) => ({
    ...pb,
    repoPath: owner,
    source: 'repo',
  }));

  const entry = Object.values(global.config.repos).find((repo) => samePath(repo.path, owner));
  for (const playbook of entry?.playbooks ?? []) {
    const resolved: ResolvedPlaybook = { ...playbook, repoPath: owner, source: 'global' };
    const existing = playbooks.findIndex((pb) => pb.name === resolved.name);
    if (existing === -1) playbooks.push(resolved);
    else playbooks[existing] = resolved;
  }

  return { playbooks, problems: [...repoFile.problems, ...global.problems] };
}

export function resolvePlaybook(
  repoPath: string,
  checkoutPath: string,
  name: string,
): ResolvedPlaybook | null {
  const { playbooks } = resolvePlaybooks(repoPath, checkoutPath);
  return playbooks.find((pb) => pb.name === name) ?? null;
}
