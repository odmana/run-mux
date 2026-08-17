/**
 * One handler per method in `protocol.ts`. Handlers own no state of their own —
 * everything they need arrives through the `DaemonContext`, which is what makes
 * them directly testable and keeps the assembly in `daemon.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import {
  ensureGlobalConfig,
  expandPath,
  type Loaded,
  playbookProblems,
  resolveEnv,
  resolvePlaybook,
  resolvePlaybooks,
  samePath,
} from '../config/index.js';
import { findCheckout, isAvailable, listCheckouts, pathKey, repoRoot } from '../git/index.js';
import { methodRouter, type RequestHandler, rpcError, subscription } from '../ipc/index.js';
import { follow, latestRun, listRuns, query } from '../logs/index.js';
import { configDir, globalConfigPath, stateDir } from '../paths.js';
import {
  type AmbiguousData,
  type ConfigReloadResult,
  type ConfigResolveResult,
  type DaemonStatusResult,
  type EnvVarView,
  type EnvResolveResult,
  METHODS,
  type LogsQueryResult,
  type PingResult,
  type RepoAddResult,
  type RepoListResult,
  type RepoRemoveResult,
  type RepoView,
  type RunResult,
  type CheckoutListResult,
  type TargetAddResult,
  type TargetListResult,
  type TargetRemoveResult,
  type TargetUpdateResult,
  type TargetView,
  type UiGetResult,
  type UiSetResult,
} from '../protocol.js';
import {
  aliasMap,
  allocateSlot,
  createTarget,
  listTargets,
  loadUi,
  mergeUi,
  mutateState,
  removeTarget,
  resolveTarget,
  slotFor,
} from '../state/index.js';
import {
  type Checkout,
  type GlobalConfig,
  type LogQuery,
  type Playbook,
  PROTOCOL_VERSION,
  type TargetRecord,
  type TargetStatus,
  type UiState,
} from '../types.js';
import type { Registry, RunEntry } from './registry.js';

export interface DaemonContext {
  /** `process.env` as it was when the daemon started. Never re-read. */
  readonly env: NodeJS.ProcessEnv;
  readonly registry: Registry;
  readonly startedAt: number;
  readonly version: string;
  readonly socketPath: string;
  /** The in-memory global config. Refreshed by `config.reload` and by writes. */
  globalConfig(): Loaded<GlobalConfig>;
  reloadConfig(): Loaded<GlobalConfig>;
  /** Replies first, then tears the daemon down. */
  requestStop(): void;
}

export function createMethods(ctx: DaemonContext): RequestHandler {
  return methodRouter({
    [METHODS.ping]: (): PingResult => ping(ctx),

    [METHODS.daemonStatus]: (): DaemonStatusResult => ({
      ...ping(ctx),
      targets: listTargets().length,
      running: ctx.registry.size,
      socketPath: ctx.socketPath,
      stateDir: stateDir(),
    }),

    [METHODS.daemonStop]: (): { ok: true } => {
      ctx.requestStop();
      return { ok: true };
    },

    [METHODS.repoAdd]: (params): RepoAddResult => {
      const input = expandPath(requireString(params, 'path'));
      const root = repoRoot(input);
      if (root === null) {
        throw rpcError(
          'bad_params',
          `${input} is not a git repository (or git is not on PATH); run-mux only tracks real checkouts`,
        );
      }
      mutateGlobalConfig((raw) => {
        const repos = asArray(raw.repos);
        const known = repos.some(
          (entry) =>
            isRecord(entry) && typeof entry.path === 'string' && samePath(entry.path, root),
        );
        if (!known) repos.push({ path: root });
        raw.repos = repos;
      });
      ctx.reloadConfig();
      return { repo: repoView(root) };
    },

    [METHODS.repoList]: (): RepoListResult => ({
      repos: ctx.globalConfig().config.repos.map((repo) => repoView(repo.path, repo.alias)),
    }),

    [METHODS.repoRemove]: (params): RepoRemoveResult => {
      const input = expandPath(requireString(params, 'path'));
      let removed = false;
      mutateGlobalConfig((raw) => {
        const repos = asArray(raw.repos);
        const kept = repos.filter((entry) => {
          const match =
            isRecord(entry) && typeof entry.path === 'string' && samePath(entry.path, input);
          if (match) removed = true;
          return !match;
        });
        raw.repos = kept;
      });
      ctx.reloadConfig();
      return { removed };
    },

    [METHODS.checkoutList]: (params): CheckoutListResult => {
      const repoPath = expandPath(requireString(params, 'repoPath'));
      const checkouts = listCheckouts(repoPath);
      return { checkouts, playbooks: playbookSummaries(repoPath, checkouts) };
    },

    [METHODS.targetList]: (): TargetListResult => {
      const views = viewBuilder(ctx);
      return { targets: listTargets().map((record) => views.build(record)) };
    },

    [METHODS.targetAdd]: (params): TargetAddResult => {
      const repoPath = expandPath(requireString(params, 'repoPath'));
      const checkoutPath = expandPath(requireString(params, 'checkoutPath'));
      const playbookName = requireString(params, 'playbookName');

      if (!isAvailable(checkoutPath)) {
        throw rpcError('not_found', `no checkout at ${checkoutPath}`);
      }
      const playbook = resolvePlaybook(repoPath, checkoutPath, playbookName);
      if (playbook === null) {
        throw rpcError(
          'not_found',
          `no playbook named "${playbookName}" for ${checkoutPath}; run \`rmux repo list\` to see what is defined`,
        );
      }

      const created = createTarget({ repoPath, checkoutPath, playbookName });
      if (!created.ok) {
        throw rpcError(
          'conflict',
          created.reason === 'duplicate'
            ? `${created.existing.slug} already runs "${playbookName}" for this checkout`
            : `that target would collide with the existing ${created.existing.slug}`,
        );
      }
      return { target: viewBuilder(ctx).build(created.target) };
    },

    [METHODS.targetUpdate]: (params): TargetUpdateResult => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      const autostart = optionalBoolean(params, 'autostart');
      if (autostart === undefined) return { target: viewBuilder(ctx).build(record) };

      const updated: TargetRecord = { ...record, autostart };
      mutateState((state) => {
        state.targets = state.targets.map((target) =>
          target.slug === record.slug ? updated : target,
        );
      });
      return { target: viewBuilder(ctx).build(updated) };
    },

    [METHODS.targetRemove]: async (params): Promise<TargetRemoveResult> => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      await ctx.registry.stop(record.slug);
      return { removed: removeTarget(record.slug), slug: record.slug };
    },

    [METHODS.runStart]: async (params): Promise<RunResult> => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      await startTarget(ctx, record);
      return { target: viewBuilder(ctx).build(record) };
    },

    [METHODS.runStop]: async (params): Promise<RunResult> => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      await ctx.registry.stop(record.slug);
      return { target: viewBuilder(ctx).build(record) };
    },

    [METHODS.runRestart]: async (params): Promise<RunResult> => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      const label = optionalString(params, 'command');

      if (label === undefined) {
        await startTarget(ctx, record);
        return { target: viewBuilder(ctx).build(record) };
      }

      const entry = ctx.registry.get(record.slug);
      if (!entry) {
        throw rpcError('conflict', `${record.slug} is not running, so "${label}" cannot restart`);
      }
      if (!entry.commands.some((command) => command.label === label)) {
        throw rpcError('not_found', `${record.slug} has no command labelled "${label}"`);
      }
      await ctx.registry.restartCommand(record.slug, label);
      return { target: viewBuilder(ctx).build(record) };
    },

    [METHODS.runStatus]: (params): RunResult => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      return { target: viewBuilder(ctx).build(record) };
    },

    [METHODS.logsQuery]: async (params): Promise<LogsQueryResult> => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      const runId = optionalString(params, 'runId') ?? latestRun(record.slug);
      const filter = logFilter(params);
      const entries = runId === null ? [] : await query(record.slug, runId, filter);
      return { runId, entries, runs: listRuns(record.slug) };
    },

    [METHODS.logsFollow]: (params) => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      const filter = logFilter(params);
      return subscription((emit) => follow(record.slug, filter, (entry) => emit.data(entry)));
    },

    [METHODS.configReload]: (): ConfigReloadResult => {
      const reloaded = ctx.reloadConfig();
      const problems = [...reloaded.problems];
      const stale: string[] = [];

      for (const entry of ctx.registry.list()) {
        const record = listTargets().find((target) => target.slug === entry.slug);
        if (!record) continue;
        const { playbooks, problems: found } = resolvePlaybooks(
          record.repoPath,
          record.checkoutPath,
        );
        for (const problem of found) if (!problems.includes(problem)) problems.push(problem);
        const current = playbooks.find((pb) => pb.name === record.playbookName);
        if (definitionChanged(entry, current)) {
          ctx.registry.markStale(entry.slug);
          stale.push(entry.slug);
        }
      }

      for (const repo of reloaded.config.repos) {
        playbookSummaries(repo.path, listCheckouts(repo.path), problems);
      }
      return { problems, stale };
    },

    [METHODS.configResolve]: (params): ConfigResolveResult => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      const { playbooks, problems } = resolvePlaybooks(record.repoPath, record.checkoutPath);
      const playbook = playbooks.find((pb) => pb.name === record.playbookName);
      if (!playbook) {
        throw rpcError(
          'not_found',
          `no playbook named "${record.playbookName}" for ${record.checkoutPath}`,
        );
      }
      const { repoPath, source, ...definition } = playbook;
      return {
        playbook: definition,
        source,
        repoPath,
        problems: [...problems, ...playbookProblems(playbook.commands)],
      };
    },

    [METHODS.envResolve]: (params): EnvResolveResult => {
      const record = resolveOrThrow(ctx, requireString(params, 'target'));
      const label = optionalString(params, 'command');
      const plan = planRun(ctx, record);
      const resolvedPlaybook = playbookFor(record, plan.checkoutPath);
      const problems = [...resolvedPlaybook.problems];

      let command: { env?: Record<string, string>; envFile?: string } = {};
      if (label !== undefined) {
        const found = resolvedPlaybook.playbook?.commands.find((c) => c.label === label);
        if (!found) throw rpcError('not_found', `no command labelled "${label}" in this playbook`);
        command = { env: found.env, envFile: found.envFile };
      }

      const resolved = resolveEnv({
        daemonEnv: ctx.env,
        command,
        checkoutPath: plan.checkoutPath,
        targetEnv: plan.targetEnv,
        injected: plan.injected,
      });
      problems.push(...resolved.problems);

      const vars: EnvVarView[] = Object.keys(resolved.env)
        .sort()
        .map((name) => ({
          name,
          value: resolved.env[name] as string,
          source: resolved.sources[name] ?? 'daemon',
        }));
      return { vars, problems };
    },

    [METHODS.uiGet]: (): UiGetResult => ({ ui: loadUi() }),

    [METHODS.uiSet]: (params): UiSetResult => ({ ui: mergeUi(uiPatch(params)) }),
  });
}

// ---------------------------------------------------------------------------
// Running a target
// ---------------------------------------------------------------------------

interface RunPlan {
  record: TargetRecord;
  repoPath: string;
  checkoutPath: string;
  branch: string;
  isMain: boolean;
  slot: number;
  available: boolean;
  targetEnv?: Record<string, string>;
  injected: Record<string, string>;
}

/**
 * Everything one target needs before it can run: where it lives, which slot it
 * owns, and the MUX_* layer that outranks every other source of environment.
 * Deliberately free of playbook resolution, which reads two files — `target.list`
 * builds one of these per row.
 */
function planRun(ctx: DaemonContext, record: TargetRecord, checkout?: Checkout): RunPlan {
  const resolved = checkout ?? findCheckout(record.repoPath, record.checkoutPath);
  const repoPath = record.repoPath;
  // git reports the real casing; the target record is canonicalised (lowercased
  // on Windows), so prefer git's answer when there is one.
  const checkoutPath = resolved?.path ?? record.checkoutPath;
  const isMain = resolved?.isMain ?? samePath(repoPath, checkoutPath);
  const branch = resolved?.branch ?? '';
  const slot = slotFor(record.checkoutPath) ?? allocateSlot(repoPath, record.checkoutPath, isMain);

  return {
    record,
    repoPath,
    checkoutPath,
    branch,
    isMain,
    slot,
    available: isAvailable(checkoutPath),
    targetEnv: ctx.globalConfig().config.targets[record.slug]?.env,
    injected: {
      MUX_SLOT: String(slot),
      MUX_IS_MAIN: isMain ? '1' : '0',
      MUX_REPO: repoPath,
      MUX_REPO_NAME: basename(repoPath),
      MUX_CHECKOUT: checkoutPath,
      MUX_BRANCH: branch,
      MUX_TARGET: record.slug,
      MUX_PLAYBOOK: record.playbookName,
    },
  };
}

/** The playbook a target names, as currently defined on disk. */
function playbookFor(
  record: TargetRecord,
  checkoutPath: string,
): { playbook: Playbook | null; problems: string[] } {
  const { playbooks, problems } = resolvePlaybooks(record.repoPath, checkoutPath);
  return { playbook: playbooks.find((pb) => pb.name === record.playbookName) ?? null, problems };
}

/**
 * The supervisor deliberately never reads disk, so every command's environment
 * is layered here and travels with the command. The run-wide `env` it also
 * receives is the frozen daemon snapshot, which the per-command layer already
 * contains.
 */
function materialise(
  ctx: DaemonContext,
  plan: RunPlan,
  playbook: Playbook,
): { playbook: Playbook; problems: string[] } {
  const problems: string[] = [];
  const commands = playbook.commands.map((command) => {
    const resolved = resolveEnv({
      daemonEnv: ctx.env,
      command,
      checkoutPath: plan.checkoutPath,
      targetEnv: plan.targetEnv,
      injected: plan.injected,
    });
    for (const problem of resolved.problems) problems.push(`${command.label}: ${problem}`);
    const { envFile: _envFile, ...rest } = command;
    return { ...rest, env: resolved.env };
  });
  return { playbook: { name: playbook.name, commands }, problems };
}

/** Shared by `run.start`, `run.restart` and the daemon's autostart restore. */
export async function startTarget(ctx: DaemonContext, record: TargetRecord): Promise<RunEntry> {
  const plan = planRun(ctx, record);
  if (!plan.available) {
    throw rpcError(
      'unavailable',
      `${record.slug} cannot start: its checkout ${plan.checkoutPath} is gone`,
    );
  }
  const { playbook, problems: configProblems } = playbookFor(record, plan.checkoutPath);
  if (playbook === null) {
    throw rpcError(
      'invalid_config',
      `${record.slug} cannot start: no playbook named "${record.playbookName}" for ${plan.checkoutPath}`,
    );
  }
  const invalid = playbookProblems(playbook.commands);
  if (invalid.length > 0) {
    throw rpcError(
      'invalid_config',
      `playbook "${playbook.name}" is invalid: ${invalid.join('; ')}`,
    );
  }

  const definition: Playbook = { name: playbook.name, commands: playbook.commands };
  const { playbook: materialised, problems } = materialise(ctx, plan, definition);
  return ctx.registry.start({
    slug: record.slug,
    definition,
    materialised,
    cwd: plan.checkoutPath,
    env: definedEnv(ctx.env),
    notes: [...configProblems, ...problems],
  });
}

/** `process.env` types every value as optional; a child environment cannot be. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface ViewBuilder {
  build(record: TargetRecord): TargetView;
}

/**
 * A `TargetView` needs config, git, state and the registry at once, so it is
 * built in exactly one place. The builder caches the git call per repo, which is
 * what keeps `target.list` from shelling out once per row.
 */
function viewBuilder(ctx: DaemonContext): ViewBuilder {
  const config = ctx.globalConfig().config;
  const aliases = new Map<string, string>();
  for (const [slug, override] of Object.entries(config.targets)) {
    if (override.alias) aliases.set(slug, override.alias);
  }
  const checkouts = new Map<string, Checkout[]>();
  const forRepo = (repoPath: string): Checkout[] => {
    const key = pathKey(repoPath);
    let found = checkouts.get(key);
    if (!found) {
      found = listCheckouts(repoPath);
      checkouts.set(key, found);
    }
    return found;
  };

  return {
    build(record: TargetRecord): TargetView {
      const checkout = forRepo(record.repoPath).find((c) => samePath(c.path, record.checkoutPath));
      const plan = planRun(ctx, record, checkout);
      const entry = ctx.registry.get(record.slug);
      const alias = aliases.get(record.slug);

      return {
        slug: record.slug,
        ...(alias === undefined ? {} : { alias }),
        repoPath: plan.repoPath,
        repoName: basename(plan.repoPath),
        checkoutPath: plan.checkoutPath,
        branch: plan.branch,
        isMain: plan.isMain,
        playbookName: record.playbookName,
        slot: plan.slot,
        available: plan.available,
        status: statusOf(plan.available, entry),
        autostart: record.autostart ?? false,
        ...(entry === undefined
          ? {}
          : {
              runId: entry.runId,
              startedAt: entry.startedAt,
              commands: entry.commands,
              staleDefinition: entry.staleDefinition,
            }),
      };
    },
  };
}

/** A vanished checkout outranks whatever the supervisor thinks it is doing. */
function statusOf(available: boolean, entry: RunEntry | undefined): TargetStatus {
  if (!available) return 'unavailable';
  return entry === undefined ? 'stopped' : entry.status;
}

function repoView(repoPath: string, alias?: string): RepoView {
  const problems: string[] = [];
  const checkouts = listCheckouts(repoPath);
  if (checkouts.length === 0) {
    problems.push(`${repoPath}: no checkouts (is it still a git repository?)`);
  }
  return {
    path: repoPath,
    name: alias ?? basename(repoPath),
    checkouts,
    playbooks: playbookSummaries(repoPath, checkouts, problems),
    problems,
  };
}

/**
 * A repo's playbooks are read from its main checkout: the committed
 * `.run-mux.json` belongs to the repo, and a linked worktree normally carries
 * the same file.
 */
function playbookSummaries(
  repoPath: string,
  checkouts: Checkout[],
  problems?: string[],
): { name: string; source: 'global' | 'repo' }[] {
  const main = checkouts.find((checkout) => checkout.isMain)?.path ?? repoPath;
  const resolved = resolvePlaybooks(repoPath, main);
  if (problems) {
    for (const problem of resolved.problems) {
      if (!problems.includes(problem)) problems.push(problem);
    }
  }
  return resolved.playbooks.map((pb) => ({ name: pb.name, source: pb.source }));
}

function definitionChanged(entry: RunEntry, current: Playbook | undefined): boolean {
  if (!current) return true;
  const now: Playbook = { name: current.name, commands: current.commands };
  return JSON.stringify(now) !== JSON.stringify(entry.definition);
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Several prefix matches are never resolved silently. The candidates ride in
 * `error.data` as well as the message: the matching rule lives here, and a
 * client that had to recompute the list would be keeping a second copy of it.
 */
function resolveOrThrow(ctx: DaemonContext, queryText: string): TargetRecord {
  const result = resolveTarget(queryText, aliasMap(ctx.globalConfig().config.targets));
  if (result.ok) return result.target;
  if (result.reason === 'ambiguous') {
    const data: AmbiguousData = { matches: result.matches };
    throw rpcError(
      'ambiguous',
      `"${queryText}" matches ${result.matches.length} targets: ${result.matches.join(', ')}`,
      { ...data },
    );
  }
  throw rpcError('not_found', `no target matches "${queryText}"`);
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireString(params: unknown, key: string): string {
  const value = isRecord(params) ? params[key] : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw rpcError('bad_params', `"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(params: unknown, key: string): string | undefined {
  const value = isRecord(params) ? params[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw rpcError('bad_params', `"${key}" must be a string`);
  return value;
}

function optionalBoolean(params: unknown, key: string): boolean | undefined {
  const value = isRecord(params) ? params[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw rpcError('bad_params', `"${key}" must be a boolean`);
  return value;
}

function optionalNumber(params: unknown, key: string): number | undefined {
  const value = isRecord(params) ? params[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw rpcError('bad_params', `"${key}" must be a number`);
  }
  return value;
}

function optionalStringArray(params: unknown, key: string): string[] | undefined {
  const value = isRecord(params) ? params[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw rpcError('bad_params', `"${key}" must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArrayMap(
  params: unknown,
  key: string,
): Record<string, string[]> | undefined {
  const value = isRecord(params) ? params[key] : undefined;
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw rpcError('bad_params', `"${key}" must be an object`);
  const map: Record<string, string[]> = {};
  for (const entry of Object.keys(value)) map[entry] = optionalStringArray(value, entry) ?? [];
  return map;
}

/** Unknown keys are dropped rather than stored, so a newer TUI cannot smuggle junk into state. */
function uiPatch(params: unknown): UiState {
  const ui = isRecord(params) ? params.ui : undefined;
  const patch: UiState = {};
  const sidebarWidth = optionalNumber(ui, 'sidebarWidth');
  const collapsedRepos = optionalStringArray(ui, 'collapsedRepos');
  const repoOrder = optionalStringArray(ui, 'repoOrder');
  const targetOrder = optionalStringArrayMap(ui, 'targetOrder');
  if (sidebarWidth !== undefined) patch.sidebarWidth = Math.max(0, Math.round(sidebarWidth));
  if (collapsedRepos !== undefined) patch.collapsedRepos = collapsedRepos;
  if (repoOrder !== undefined) patch.repoOrder = repoOrder;
  if (targetOrder !== undefined) patch.targetOrder = targetOrder;
  return patch;
}

function logFilter(params: unknown): LogQuery {
  const filter: LogQuery = {};
  const label = optionalString(params, 'label');
  const since = optionalNumber(params, 'since');
  const tail = optionalNumber(params, 'tail');
  if (label !== undefined) filter.label = label;
  if (since !== undefined) filter.since = since;
  if (tail !== undefined) filter.tail = tail;
  return filter;
}

// ---------------------------------------------------------------------------
// Global config writes
// ---------------------------------------------------------------------------

/**
 * Reads the file as raw JSON rather than through the parsed config, so the
 * starter file's self-documenting `//` key and anything a newer build wrote
 * survive a round trip.
 */
function mutateGlobalConfig(mutate: (raw: Record<string, unknown>) => void): void {
  ensureGlobalConfig();
  const path = globalConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (isRecord(parsed)) raw = parsed;
    } catch {
      // An unparseable config is replaced rather than allowed to block a write;
      // loadGlobalConfig already reports it as a problem on every read.
    }
  }
  mutate(raw);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

function ping(ctx: DaemonContext): PingResult {
  return {
    version: ctx.version,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    uptimeMs: Date.now() - ctx.startedAt,
  };
}
