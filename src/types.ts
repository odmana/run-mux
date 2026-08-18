/**
 * Shared contracts for run-mux. Every module implements against this file and
 * nothing here depends on a module, so the pieces can be built independently.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type CommandKind = 'task' | 'service';
export type RestartPolicy = 'never' | 'on-failure' | 'always';

export interface PlaybookCommand {
  label: string;
  command: string;
  /** Defaults to 'service'. A task must exit 0 and gates its dependents. */
  type?: CommandKind;
  /** Labels that must have exited 0 before this command spawns. */
  dependsOn?: string[];
  /** Defaults to 'never': a command that dies stays dead until restarted by hand. */
  restart?: RestartPolicy;
  /** Relative to the checkout root. */
  cwd?: string;
  env?: Record<string, string>;
  /** Path to a dotenv-style file, relative to the checkout root. */
  envFile?: string;
}

export interface Playbook {
  name: string;
  commands: PlaybookCommand[];
}

/** A playbook definition plus where it came from, for precedence and badges. */
export interface ResolvedPlaybook extends Playbook {
  repoPath: string;
  source: 'global' | 'repo';
}

export interface RepoRegistration {
  path: string;
  playbooks: Playbook[];
}

export interface TargetOverrides {
  alias?: string;
  env?: Record<string, string>;
}

export interface GlobalConfig {
  /**
   * Keyed by the repo's name — lowercase, slug-safe, and the segment target slugs
   * are built from, so the string a user types is the string they wrote here.
   */
  repos: Record<string, RepoRegistration>;
  targets: Record<string, TargetOverrides>;
}

/** The committed `.run-mux.json` at a checkout root. */
export interface RepoConfig {
  playbooks: Playbook[];
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface Checkout {
  /** Absolute, forward-slashed. */
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

// ---------------------------------------------------------------------------
// Targets and state
// ---------------------------------------------------------------------------

export interface TargetRecord {
  /** `<repo>/<checkout>:<playbook>`, slugified. Stable identity. */
  slug: string;
  repoPath: string;
  checkoutPath: string;
  playbookName: string;
  autostart?: boolean;
  createdAt: number;
}

/** Recorded per spawned child so an unclean daemon death can be cleaned up. */
export interface ChildRecord {
  pid: number;
  /** Our own spawn time, matched against the OS process creation time before killing. */
  startedAt: number;
  label: string;
  targetSlug: string;
}

/**
 * TUI view state. The daemon only stores it: nothing in the CLI, the supervisor
 * or the config layer reads a field here, and an absent one means "the default".
 */
export interface UiState {
  sidebarWidth?: number;
  collapsedRepos?: string[];
  /** Repo paths in sidebar order. Anything absent follows, in the daemon's order. */
  repoOrder?: string[];
  /** repoPath -> target slugs in sidebar order, same rule for anything absent. */
  targetOrder?: Record<string, string[]>;
}

export interface AppState {
  targets: TargetRecord[];
  /** checkoutPath -> slot. Per-repo scoped; the main worktree is always 0. */
  slots: Record<string, number>;
  children: ChildRecord[];
  ui?: UiState;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export type CommandStatus = 'pending' | 'running' | 'restarting' | 'exited' | 'errored' | 'stopped';

export type TargetStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'failed'
  | 'unavailable';

export interface CommandState {
  label: string;
  status: CommandStatus;
  exitCode?: number;
  pid?: number;
  restarts: number;
  startedAt?: number;
}

export interface RunState {
  runId: string;
  targetSlug: string;
  startedAt: number;
  endedAt?: number;
  status: TargetStatus;
  commands: CommandState[];
  /** True once the config has been reloaded since this run started. */
  staleDefinition?: boolean;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: number;
  label: string;
  stream: 'stdout' | 'stderr';
  /** Raw chunk with ANSI preserved. */
  text: string;
}

export interface LogQuery {
  label?: string;
  /** Epoch ms; entries strictly newer than this. */
  since?: number;
  /** Last N entries after other filters. */
  tail?: number;
}

export interface RunMeta {
  runId: string;
  targetSlug: string;
  playbookSnapshot: Playbook;
  startedAt: number;
  endedAt?: number;
  exitSummary?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

export interface HelloFrame {
  hello: true;
  version: string;
  protocol: number;
  pid: number;
}

export interface RequestFrame {
  id: number;
  method: string;
  params?: unknown;
}

export interface OkResponse {
  id: number;
  ok: true;
  result: unknown;
}

export interface ErrResponse {
  id: number;
  ok: false;
  error: RpcError;
}

export type ResponseFrame = OkResponse | ErrResponse;

/** Server-initiated frames for subscriptions (log follow). */
export interface StreamFrame {
  stream: number;
  event: 'data' | 'end' | 'error';
  data?: unknown;
}

export type Frame = HelloFrame | ResponseFrame | StreamFrame | RequestFrame;

export interface RpcError {
  code: ErrorCode;
  message: string;
  /**
   * Structured detail for callers that need more than prose — notably the
   * candidate list on an `ambiguous` target. Without this a client has to
   * re-implement the daemon's matching rule to recover the candidates, and the
   * two copies drift.
   */
  data?: Record<string, unknown>;
}

export type ErrorCode =
  | 'unknown_method'
  | 'bad_params'
  | 'not_found'
  | 'ambiguous'
  | 'conflict'
  | 'invalid_config'
  | 'unavailable'
  | 'internal';

/** Maps an error code to the process exit code the CLI should use. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  unknown_method: 64,
  bad_params: 64,
  not_found: 65,
  ambiguous: 65,
  conflict: 66,
  invalid_config: 67,
  unavailable: 69,
  internal: 70,
};

// ---------------------------------------------------------------------------
// JSON output contract
// ---------------------------------------------------------------------------

/** Every object written to stdout under --json carries this version. */
export const JSON_CONTRACT_VERSION = 1;

export type JsonEnvelope<T> = T & { v: typeof JSON_CONTRACT_VERSION };
