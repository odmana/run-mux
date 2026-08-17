import * as v from 'valibot';

import type { GlobalConfig, PlaybookCommand, RepoConfig } from '../types.js';

const NonEmptyString = v.pipe(v.string(), v.minLength(1));
const StringRecord = v.record(v.string(), v.string());

export const PlaybookCommandSchema = v.object({
  label: NonEmptyString,
  command: NonEmptyString,
  type: v.optional(v.picklist(['task', 'service'])),
  dependsOn: v.optional(v.array(NonEmptyString)),
  restart: v.optional(v.picklist(['never', 'on-failure', 'always'])),
  cwd: v.optional(NonEmptyString),
  env: v.optional(StringRecord),
  envFile: v.optional(NonEmptyString),
});

type ParsedCommand = v.InferOutput<typeof PlaybookCommandSchema>;

/** `type` is optional in the file, and an omitted one means service. */
export function effectiveType(command: Pick<PlaybookCommand, 'type'>): 'task' | 'service' {
  return command.type ?? 'service';
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

function unknownDeps(commands: readonly ParsedCommand[]): string[] {
  const labels = new Set(commands.map((c) => c.label));
  const missing = new Set<string>();
  for (const cmd of commands) {
    for (const dep of cmd.dependsOn ?? []) {
      if (!labels.has(dep)) missing.add(`${cmd.label} -> ${dep}`);
    }
  }
  return [...missing];
}

function serviceDeps(commands: readonly ParsedCommand[]): string[] {
  const byLabel = new Map(commands.map((c) => [c.label, c]));
  const offenders = new Set<string>();
  for (const cmd of commands) {
    for (const dep of cmd.dependsOn ?? []) {
      const target = byLabel.get(dep);
      if (target && effectiveType(target) === 'service') offenders.add(`${cmd.label} -> ${dep}`);
    }
  }
  return [...offenders];
}

/**
 * Depth-first cycle detection over the dependsOn graph. A command depending on
 * itself is a length-1 cycle, so it is caught here too.
 */
function hasDependencyCycle(commands: readonly ParsedCommand[]): boolean {
  const byLabel = new Map(commands.map((c) => [c.label, c]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (label: string): boolean => {
    const seen = state.get(label);
    if (seen === 'visiting') return true;
    if (seen === 'done') return false;
    state.set(label, 'visiting');
    for (const dep of byLabel.get(label)?.dependsOn ?? []) {
      if (visit(dep)) return true;
    }
    state.set(label, 'done');
    return false;
  };

  return commands.some((c) => visit(c.label));
}

/** True when every dependsOn label exists and the graph is acyclic. */
export function playbookDepsValid(commands: readonly ParsedCommand[]): boolean {
  return unknownDeps(commands).length === 0 && !hasDependencyCycle(commands);
}

/** Every structural problem in one playbook's command list, empty when valid. */
export function playbookProblems(commands: readonly ParsedCommand[]): string[] {
  const problems: string[] = [];

  const dupeLabels = duplicates(commands.map((c) => c.label));
  if (dupeLabels.length > 0) problems.push(`duplicate command labels: ${dupeLabels.join(', ')}`);

  const missing = unknownDeps(commands);
  if (missing.length > 0) {
    problems.push(`dependsOn references an unknown label: ${missing.join(', ')}`);
  }

  if (hasDependencyCycle(commands)) {
    problems.push(
      'dependsOn contains a cycle (a command may not depend on itself, directly or transitively)',
    );
  }

  const services = serviceDeps(commands);
  if (services.length > 0) {
    problems.push(
      `dependsOn targets a service: ${services.join(', ')} - a dependency is satisfied by exit 0` +
        ' and a service never exits, so the dependent would stay pending forever. Depend only on a' +
        ' command declared with "type": "task".',
    );
  }

  return problems;
}

const playbookEntries = {
  name: NonEmptyString,
  commands: v.pipe(v.array(PlaybookCommandSchema), v.minLength(1)),
};

export const PlaybookSchema = v.pipe(
  v.object(playbookEntries),
  v.check(
    (pb) => playbookProblems(pb.commands).length === 0,
    (issue) => playbookProblems(issue.input.commands).join('; '),
  ),
);

/**
 * A repo key lands verbatim in every target slug, so it is validated rather than
 * slugified — silently rewriting it here would hide a key the user has to type.
 */
const RepoKey = v.pipe(
  v.string(),
  v.regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'a repo key must be lowercase letters, digits and hyphens, and start with a letter or digit',
  ),
);

function duplicatePlaybookNames(playbooks: readonly { name: string }[]): string[] {
  return duplicates(playbooks.map((pb) => pb.name));
}

const playbookList = v.optional(
  v.pipe(
    v.array(PlaybookSchema),
    v.check(
      (playbooks) => duplicatePlaybookNames(playbooks).length === 0,
      (issue) => `duplicate playbook names: ${duplicatePlaybookNames(issue.input).join(', ')}`,
    ),
  ),
  () => [],
);

export const RepoRegistrationSchema = v.object({
  path: NonEmptyString,
  playbooks: playbookList,
});

export const TargetOverridesSchema = v.object({
  alias: v.optional(NonEmptyString),
  env: v.optional(StringRecord),
});

/** Comparable form of a configured path. Local so `schema` stays a leaf module. */
function configPathKey(path: string): string {
  const cleaned = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

function duplicateRepoPaths(repos: Record<string, { path: string }>): string[] {
  return duplicates(Object.values(repos).map((repo) => configPathKey(repo.path)));
}

export const GlobalConfigSchema = v.pipe(
  v.object({
    repos: v.optional(v.record(RepoKey, RepoRegistrationSchema), () => ({})),
    targets: v.optional(v.record(v.string(), TargetOverridesSchema), () => ({})),
  }),
  v.check(
    (cfg) => duplicateRepoPaths(cfg.repos).length === 0,
    (issue) =>
      `several repo keys point at the same path: ${duplicateRepoPaths(issue.input.repos).join(', ')}`,
  ),
);

export const RepoConfigSchema = v.object({ playbooks: playbookList });

export type ParsedGlobalConfig = v.InferOutput<typeof GlobalConfigSchema>;
export type ParsedRepoConfig = v.InferOutput<typeof RepoConfigSchema>;

type Assert<T extends true> = T;

/** Fails to compile if a schema drifts from the shared contract in types.ts. */
export type SchemaMatchesContract = [
  Assert<ParsedGlobalConfig extends GlobalConfig ? true : false>,
  Assert<ParsedRepoConfig extends RepoConfig ? true : false>,
  Assert<ParsedCommand extends PlaybookCommand ? true : false>,
];

/** Renders valibot issues as `path: message`, joined, for a problems list. */
export function formatIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map(formatIssue).join('; ');
}

export function formatIssue(issue: v.BaseIssue<unknown>): string {
  const path = issue.path?.map((p) => String(p.key)).join('.') ?? '';
  return path ? `${path}: ${issue.message}` : issue.message;
}
