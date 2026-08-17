import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as v from 'valibot';

import { REPO_CONFIG_FILENAME, configDir, globalConfigPath, normalize } from '../paths.js';
import type { GlobalConfig, RepoConfig } from '../types.js';
import { GlobalConfigSchema, RepoConfigSchema, formatIssues } from './schema.js';

export interface Loaded<T> {
  config: T;
  problems: string[];
}

export function emptyGlobalConfig(): GlobalConfig {
  return { repos: {}, targets: {} };
}

export function emptyRepoConfig(): RepoConfig {
  return { playbooks: [] };
}

/** Expands a leading `~` and forward-slashes the result, for any configured path. */
export function expandPath(input: string): string {
  const trimmed = input.trim();
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
      ? join(homedir(), trimmed.slice(1))
      : trimmed;
  return normalize(expanded);
}

function readJson(path: string): { value: unknown } | { problem: string } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (err) {
    return { problem: `${path}: ${(err as Error).message}` };
  }
}

/**
 * Reads the global config. A missing file is normal and yields an empty config;
 * anything unreadable or invalid yields an empty config plus a problem, because
 * a bad config must never take the daemon down.
 */
export function loadGlobalConfig(): Loaded<GlobalConfig> {
  const path = globalConfigPath();
  if (!existsSync(path)) return { config: emptyGlobalConfig(), problems: [] };

  const read = readJson(path);
  if ('problem' in read) return { config: emptyGlobalConfig(), problems: [read.problem] };

  const result = v.safeParse(GlobalConfigSchema, read.value);
  if (!result.success) {
    return {
      config: emptyGlobalConfig(),
      problems: [`${path}: ${formatIssues(result.issues)}`],
    };
  }

  const parsed = result.output;
  return {
    config: {
      repos: Object.fromEntries(
        Object.entries(parsed.repos).map(([key, repo]) => [
          key,
          { ...repo, path: expandPath(repo.path) },
        ]),
      ),
      targets: parsed.targets,
    },
    problems: [],
  };
}

/** Reads `<checkoutPath>/.run-mux.json` under the same never-throw contract. */
export function loadRepoConfig(checkoutPath: string): Loaded<RepoConfig> {
  const path = repoConfigPath(checkoutPath);
  if (!existsSync(path)) return { config: emptyRepoConfig(), problems: [] };

  const read = readJson(path);
  if ('problem' in read) return { config: emptyRepoConfig(), problems: [read.problem] };

  const result = v.safeParse(RepoConfigSchema, read.value);
  if (!result.success) {
    return { config: emptyRepoConfig(), problems: [`${path}: ${formatIssues(result.issues)}`] };
  }
  return { config: { playbooks: result.output.playbooks }, problems: [] };
}

export function repoConfigPath(checkoutPath: string): string {
  return normalize(join(expandPath(checkoutPath), REPO_CONFIG_FILENAME));
}

/**
 * The starter file documents itself through `//` keys rather than real comments,
 * so it stays parseable by JSON.parse and loads as a valid empty config.
 */
const STARTER_CONFIG = {
  '//': [
    'run-mux global config.',
    'repos:   checkouts run-mux knows about, keyed by the short name you address them by:',
    '         "app": { "path": "~/code/app", "playbooks": [ ... ] }.',
    '         The key is lowercase letters, digits and hyphens, and it is the first',
    '         segment of every target slug — app/main:dev.',
    "         A playbook here replaces a same-named one from that repo's .run-mux.json",
    '         wholesale, so you can override one without inheriting commands you removed.',
    'targets: per-target overrides keyed by target slug, e.g. { "env": { "PORT": "4000" } }.',
    'A command is a service unless it sets "type": "task"; only a task may be depended on.',
  ],
  repos: {},
  targets: {},
};

/** Creates a self-documenting starter config when none exists. Returns the path. */
export function ensureGlobalConfig(): string {
  const path = globalConfigPath();
  if (!existsSync(path)) {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, 'utf-8');
  }
  return path;
}
