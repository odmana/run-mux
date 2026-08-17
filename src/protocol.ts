/**
 * The daemon's RPC surface. The CLI, the TUI and the daemon all compile against
 * this file, so a method's name, params and result shape are agreed in exactly
 * one place.
 *
 * Method names are `noun.verb`. Anything returning a stream is marked below and
 * is served through the ipc layer's `subscription()` helper rather than a value.
 */

import type {
  Checkout,
  CommandState,
  LogEntry,
  Playbook,
  RunMeta,
  TargetStatus,
  UiState,
} from './types.js';

export const METHODS = {
  ping: 'ping',
  daemonStatus: 'daemon.status',
  daemonStop: 'daemon.stop',

  repoAdd: 'repo.add',
  repoList: 'repo.list',
  repoRemove: 'repo.remove',
  checkoutList: 'checkout.list',

  targetList: 'target.list',
  targetAdd: 'target.add',
  targetUpdate: 'target.update',
  targetRemove: 'target.remove',

  runStart: 'run.start',
  runStop: 'run.stop',
  runRestart: 'run.restart',
  runStatus: 'run.status',

  logsQuery: 'logs.query',
  logsFollow: 'logs.follow',

  configReload: 'config.reload',
  configResolve: 'config.resolve',
  envResolve: 'env.resolve',

  uiGet: 'ui.get',
  uiSet: 'ui.set',
} as const;

/** How a target is named on the wire: a slug, an alias, or a unique prefix. */
export type TargetQuery = string;

/** Everything the sidebar and `rmux ls` need for one row. */
export interface TargetView {
  slug: string;
  alias?: string;
  repoPath: string;
  repoName: string;
  checkoutPath: string;
  branch: string;
  isMain: boolean;
  playbookName: string;
  slot: number;
  /** False when the checkout directory has gone; the target is kept, not deleted. */
  available: boolean;
  status: TargetStatus;
  autostart: boolean;
  runId?: string;
  startedAt?: number;
  commands?: CommandState[];
  /** Config was reloaded after this run started, so it is running old definitions. */
  staleDefinition?: boolean;
}

export interface RepoView {
  path: string;
  name: string;
  checkouts: Checkout[];
  playbooks: { name: string; source: 'global' | 'repo' }[];
  problems: string[];
}

export interface EnvVarView {
  name: string;
  value: string;
  source: 'daemon' | 'playbook' | 'envFile' | 'target' | 'injected';
}

// --- params -----------------------------------------------------------------

export interface PingResult {
  version: string;
  protocol: number;
  pid: number;
  uptimeMs: number;
}

export interface DaemonStatusResult extends PingResult {
  targets: number;
  running: number;
  socketPath: string;
  stateDir: string;
}

/**
 * Clients may send any form the user typed — relative, `~`-prefixed, backslashed.
 * The **daemon** owns normalisation (tilde expansion, absolute, forward slashes)
 * so the CLI and the TUI cannot disagree about what identifies a repo.
 */
export interface RepoAddParams {
  path: string;
}
export interface RepoAddResult {
  repo: RepoView;
}
export interface RepoListResult {
  repos: RepoView[];
}
export interface RepoRemoveParams {
  path: string;
}
export interface RepoRemoveResult {
  removed: boolean;
}

export interface CheckoutListParams {
  repoPath: string;
}
export interface CheckoutListResult {
  checkouts: Checkout[];
  playbooks: { name: string; source: 'global' | 'repo' }[];
}

export interface TargetListResult {
  targets: TargetView[];
}
export interface TargetAddParams {
  repoPath: string;
  checkoutPath: string;
  playbookName: string;
}
export interface TargetAddResult {
  target: TargetView;
}
/** Mutable per-target settings. Omitted fields are left unchanged. */
export interface TargetUpdateParams {
  target: TargetQuery;
  autostart?: boolean;
}
export interface TargetUpdateResult {
  target: TargetView;
}

export interface TargetRemoveParams {
  target: TargetQuery;
}
export interface TargetRemoveResult {
  removed: boolean;
  slug: string;
}

export interface RunStartParams {
  target: TargetQuery;
}
export interface RunStopParams {
  target: TargetQuery;
}
export interface RunRestartParams {
  target: TargetQuery;
  /** Restart just this command, leaving its siblings alone. */
  command?: string;
}
export interface RunStatusParams {
  target: TargetQuery;
}
export interface RunResult {
  target: TargetView;
}

export interface LogsQueryParams {
  target: TargetQuery;
  label?: string;
  /** Epoch ms; entries strictly newer than this. */
  since?: number;
  tail?: number;
  /** Defaults to the latest run. */
  runId?: string;
}
export interface LogsQueryResult {
  runId: string | null;
  entries: LogEntry[];
  runs: RunMeta[];
}

/** Streaming. Each frame's `data` is a LogEntry. */
export interface LogsFollowParams {
  target: TargetQuery;
  label?: string;
  since?: number;
}

/**
 * Subscriptions are deliberately absent from MethodMap — they yield a stream of
 * frames, not one result — so they get their own map for typed clients.
 */
export interface SubscriptionMap {
  [METHODS.logsFollow]: { params: LogsFollowParams; frame: LogEntry };
}

/** `error.data` shape when the code is `ambiguous`. */
export interface AmbiguousData {
  matches: string[];
}

export interface ConfigReloadResult {
  problems: string[];
  /** Targets running definitions that changed under them. */
  stale: string[];
}

export interface ConfigResolveParams {
  target: TargetQuery;
}
export interface ConfigResolveResult {
  playbook: Playbook;
  source: 'global' | 'repo';
  repoPath: string;
  problems: string[];
}

export interface EnvResolveParams {
  target: TargetQuery;
  /** Without a label, only the run-wide and injected layers are resolved. */
  command?: string;
}
export interface EnvResolveResult {
  vars: EnvVarView[];
  problems: string[];
}

/**
 * The TUI's own view state, parked in the daemon because the daemon owns the
 * state file: the TUI is a second process, and a whole-file write from it would
 * land on top of whatever the supervisor recorded in between.
 */
export interface UiGetResult {
  ui: UiState;
}
/** Only the fields present are written; the rest are left as they are. */
export interface UiSetParams {
  ui: UiState;
}
export interface UiSetResult {
  ui: UiState;
}

/** Maps a method name to its params and result, for typed client helpers. */
export interface MethodMap {
  [METHODS.ping]: { params: void; result: PingResult };
  [METHODS.daemonStatus]: { params: void; result: DaemonStatusResult };
  [METHODS.daemonStop]: { params: void; result: { ok: true } };
  [METHODS.repoAdd]: { params: RepoAddParams; result: RepoAddResult };
  [METHODS.repoList]: { params: void; result: RepoListResult };
  [METHODS.repoRemove]: { params: RepoRemoveParams; result: RepoRemoveResult };
  [METHODS.checkoutList]: { params: CheckoutListParams; result: CheckoutListResult };
  [METHODS.targetList]: { params: void; result: TargetListResult };
  [METHODS.targetAdd]: { params: TargetAddParams; result: TargetAddResult };
  [METHODS.targetUpdate]: { params: TargetUpdateParams; result: TargetUpdateResult };
  [METHODS.targetRemove]: { params: TargetRemoveParams; result: TargetRemoveResult };
  [METHODS.runStart]: { params: RunStartParams; result: RunResult };
  [METHODS.runStop]: { params: RunStopParams; result: RunResult };
  [METHODS.runRestart]: { params: RunRestartParams; result: RunResult };
  [METHODS.runStatus]: { params: RunStatusParams; result: RunResult };
  [METHODS.logsQuery]: { params: LogsQueryParams; result: LogsQueryResult };
  [METHODS.configReload]: { params: void; result: ConfigReloadResult };
  [METHODS.configResolve]: { params: ConfigResolveParams; result: ConfigResolveResult };
  [METHODS.envResolve]: { params: EnvResolveParams; result: EnvResolveResult };
  [METHODS.uiGet]: { params: void; result: UiGetResult };
  [METHODS.uiSet]: { params: UiSetParams; result: UiSetResult };
}
