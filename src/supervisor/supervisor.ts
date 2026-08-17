import { type ChildProcess, spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import type { Readable } from 'node:stream';

import type {
  CommandKind,
  CommandState,
  LogEntry,
  Playbook,
  PlaybookCommand,
  RestartPolicy,
  TargetStatus,
} from '../types.js';
import { type BackoffConfig, BackoffTracker, DEFAULT_BACKOFF } from './backoff.js';
import { KILL_GRACE_MS, killTree, killTrees } from './kill.js';

/**
 * How long an exited child's pipes may still be draining before we settle its
 * status anyway. Normally `close` follows `exit` immediately; an orphaned
 * grandchild holding the pipe open is the case this bound exists for.
 */
const STREAM_FLUSH_GRACE_MS = 1000;

export type CancelFn = () => void;
/** Returns a canceller, so a pending restart can be dropped on stop. */
export type Scheduler = (fn: () => void, ms: number) => CancelFn;

export interface StartOptions {
  playbook: Playbook;
  /** The checkout root. Per-command `cwd` is resolved against it. */
  cwd: string;
  /** Already resolved and layered; used verbatim as the child environment. */
  env: Record<string, string>;
  onOutput: (entry: LogEntry) => void;
  onStatus: (commands: CommandState[]) => void;
  onChildSpawn?: (label: string, pid: number, startedAt: number) => void;
  onChildExit?: (label: string, pid: number) => void;
  /** Test seams. */
  backoff?: Partial<BackoffConfig>;
  killGraceMs?: number;
  schedule?: Scheduler;
}

export interface RunHandle {
  readonly commands: CommandState[];
  readonly status: TargetStatus;
  stop(): Promise<void>;
  restartCommand(label: string): Promise<void>;
}

interface Slot {
  spec: PlaybookCommand;
  kind: CommandKind;
  policy: RestartPolicy;
  state: CommandState;
  /** No dependency chain can ever be satisfied, so this will never spawn. */
  blocked: boolean;
  /** Has exited 0 at least once, which is what opens a dependent's gate. */
  succeeded: boolean;
  child?: ChildProcess;
  /** Resolves once the current child's exit has been fully accounted for. */
  settled?: Promise<void>;
  /** Set while we are the one killing it, so the exit isn't read as a crash. */
  intent?: 'stop' | 'restart';
  backoff: BackoffTracker;
  cancelRestart?: CancelFn;
}

const defaultSchedule: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * Runs one playbook against one checkout. It knows nothing about targets,
 * config files or log storage — everything arrives as arguments and everything
 * it learns leaves through the callbacks.
 */
export class Supervisor implements RunHandle {
  private readonly slots: Slot[];
  private readonly byLabel = new Map<string, Slot>();
  /** label -> labels that name it in dependsOn. */
  private readonly dependents = new Map<string, string[]>();
  private readonly backoffConfig: BackoffConfig;
  private readonly graceMs: number;
  private readonly schedule: Scheduler;
  private readonly restartsInFlight = new Map<string, Promise<void>>();
  private started = false;
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: StartOptions) {
    this.backoffConfig = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.graceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.schedule = options.schedule ?? defaultSchedule;

    const commands = options.playbook.commands;
    const reachable = reachableLabels(commands);
    this.slots = commands.map((spec) => ({
      spec,
      kind: kindOf(spec),
      policy: policyOf(spec),
      state: { label: spec.label, status: 'pending', restarts: 0 },
      blocked: !reachable.has(spec.label),
      succeeded: false,
      backoff: new BackoffTracker(this.backoffConfig),
    }));

    for (const slot of this.slots) {
      if (!this.byLabel.has(slot.spec.label)) this.byLabel.set(slot.spec.label, slot);
      for (const dep of slot.spec.dependsOn ?? []) {
        this.dependents.set(dep, [...(this.dependents.get(dep) ?? []), slot.spec.label]);
      }
    }
  }

  /** Spawns everything whose gate is already open. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const slot of this.slots) {
      if (slot.blocked) this.note(slot, `will never start — ${this.blockReason(slot)}`);
    }
    this.spawnReady();
    this.emitStatus();
  }

  get commands(): CommandState[] {
    return this.slots.map((slot) => ({ ...slot.state }));
  }

  get status(): TargetStatus {
    if (this.stopped) return 'stopped';
    if (!this.started) return 'starting';

    let running = 0;
    let restarting = 0;
    let waiting = 0;
    let broken = 0;
    for (const slot of this.slots) {
      if (slot.blocked && slot.state.status === 'pending') {
        broken++;
        continue;
      }
      switch (slot.state.status) {
        case 'running':
          running++;
          break;
        case 'restarting':
          restarting++;
          break;
        case 'pending':
          waiting++;
          break;
        case 'errored':
        case 'stopped':
          broken++;
          break;
        default:
          break; // 'exited' — a task that finished cleanly
      }
    }

    // A restarting command is a live problem: healthy for now means nothing is
    // broken and nothing is still waiting to come up.
    if (broken === 0 && restarting === 0) return waiting > 0 ? 'starting' : 'running';
    if (running + restarting + waiting > 0) return 'degraded';
    return 'failed';
  }

  stop(): Promise<void> {
    // Concurrent callers share one in-flight kill rather than firing twice.
    this.stopPromise ??= this.runStop();
    return this.stopPromise;
  }

  /**
   * Kills exactly one command's process tree and spawns it again, leaving every
   * sibling untouched.
   */
  restartCommand(label: string): Promise<void> {
    const existing = this.restartsInFlight.get(label);
    if (existing) return existing;
    const attempt = this.runRestart(label).finally(() => {
      if (this.restartsInFlight.get(label) === attempt) this.restartsInFlight.delete(label);
    });
    this.restartsInFlight.set(label, attempt);
    return attempt;
  }

  private async runStop(): Promise<void> {
    this.stopped = true;
    const live: ChildProcess[] = [];
    const settling: Promise<void>[] = [];
    for (const slot of this.slots) {
      slot.cancelRestart?.();
      slot.cancelRestart = undefined;
      if (slot.child) {
        slot.intent = 'stop';
        live.push(slot.child);
        if (slot.settled) settling.push(slot.settled);
      } else if (slot.state.status === 'pending' || slot.state.status === 'restarting') {
        slot.state.status = 'stopped';
      }
    }
    this.emitStatus();

    await killTrees(live, { graceMs: this.graceMs });
    await Promise.all(settling);

    for (const slot of this.slots) {
      if (slot.state.status === 'running' || slot.state.status === 'restarting') {
        slot.state.status = 'stopped';
        slot.state.pid = undefined;
      }
    }
    this.emitStatus();
  }

  private async runRestart(label: string): Promise<void> {
    const slot = this.byLabel.get(label);
    if (!slot) throw new Error(`unknown command: ${label}`);
    if (this.stopped) throw new Error(`cannot restart "${label}": the run is stopped`);

    slot.cancelRestart?.();
    slot.cancelRestart = undefined;
    slot.backoff.reset();

    const child = slot.child;
    if (child) {
      slot.intent = 'restart';
      slot.state.status = 'restarting';
      this.emitStatus();
      const settled = slot.settled;
      await killTree(child, { graceMs: this.graceMs });
      if (settled) await settled;
    }
    if (this.stopped) return;
    if (!this.gateOpen(slot)) {
      this.note(slot, `not restarted — ${this.blockReason(slot)}`);
      this.emitStatus();
      return;
    }
    this.spawnSlot(slot, true);
    this.emitStatus();
  }

  /** Spawns every pending command whose dependencies have all exited 0. */
  private spawnReady(): void {
    if (this.stopped) return;
    for (const slot of this.slots) {
      if (slot.state.status !== 'pending' || slot.blocked) continue;
      if (!this.gateOpen(slot)) continue;
      this.spawnSlot(slot, false);
    }
  }

  private gateOpen(slot: Slot): boolean {
    return (slot.spec.dependsOn ?? []).every((dep) => this.byLabel.get(dep)?.succeeded === true);
  }

  private spawnSlot(slot: Slot, isRestart: boolean): void {
    const cwd = slot.spec.cwd ? resolvePath(this.options.cwd, slot.spec.cwd) : this.options.cwd;
    const env = slot.spec.env ? { ...this.options.env, ...slot.spec.env } : this.options.env;
    const startedAt = Date.now();

    let child: ChildProcess;
    try {
      child = spawn(slot.spec.command, {
        cwd,
        env,
        shell: true,
        windowsHide: true,
        // Detached makes the child lead its own process group, which is what
        // lets us signal its whole tree on POSIX. On Windows it would detach the
        // console instead, and taskkill walks the tree for us anyway.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.failToSpawn(slot, error);
      return;
    }

    slot.child = child;
    slot.intent = undefined;
    slot.state.status = 'running';
    slot.state.pid = child.pid;
    slot.state.startedAt = startedAt;
    slot.state.exitCode = undefined;
    if (isRestart) slot.state.restarts += 1;

    let settle = noop;
    slot.settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    if (child.pid !== undefined) {
      this.options.onChildSpawn?.(slot.spec.label, child.pid, startedAt);
    }
    this.pipe(slot, child.stdout, 'stdout');
    this.pipe(slot, child.stderr, 'stderr');

    let finished = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(flushTimer);
      this.handleExit(slot, child, code, startedAt);
      settle();
    };

    child.once('error', (error) => {
      this.note(slot, `spawn failed: ${errorMessage(error)}`);
      finish(null);
    });
    child.once('exit', (code) => {
      if (child.pid !== undefined) this.options.onChildExit?.(slot.spec.label, child.pid);
      // Give the pipes a moment so a command's last lines land before whatever
      // its exit unblocks starts writing, but never wait on them indefinitely.
      flushTimer = setTimeout(() => finish(code), STREAM_FLUSH_GRACE_MS);
    });
    child.once('close', (code) => finish(code));
  }

  private pipe(slot: Slot, stream: Readable | null, name: 'stdout' | 'stderr'): void {
    if (!stream) return;
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      this.options.onOutput({ ts: Date.now(), label: slot.spec.label, stream: name, text: chunk });
    });
    stream.on('error', () => {
      /* the exit path reports the failure */
    });
  }

  private handleExit(
    slot: Slot,
    child: ChildProcess,
    code: number | null,
    startedAt: number,
  ): void {
    if (slot.child !== child) return;
    slot.child = undefined;
    slot.state.pid = undefined;

    const intent = slot.intent;
    slot.intent = undefined;
    if (intent === 'restart') {
      slot.state.status = 'restarting';
      this.emitStatus();
      return;
    }
    if (intent === 'stop' || this.stopped) {
      slot.state.status = 'stopped';
      this.emitStatus();
      return;
    }

    slot.state.exitCode = code ?? undefined;
    const ok = code === 0;
    if (ok) slot.succeeded = true;

    if (this.shouldRestart(slot, code)) {
      slot.state.status = 'restarting';
      const wait = slot.backoff.recordExit(Date.now() - startedAt);
      slot.cancelRestart = this.schedule(() => {
        slot.cancelRestart = undefined;
        if (this.stopped || slot.child) return;
        this.spawnSlot(slot, true);
        this.emitStatus();
      }, wait);
      // A restarting task still opened its gate if this run exited 0.
      if (ok) this.spawnReady();
      this.emitStatus();
      return;
    }

    slot.state.status = ok ? 'exited' : 'errored';
    if (ok) {
      this.spawnReady();
    } else if (slot.kind === 'task') {
      // Only a task cascades, and only to its own dependents: unrelated
      // commands keep running.
      this.cascade(slot);
    }
    this.emitStatus();
  }

  private shouldRestart(slot: Slot, code: number | null): boolean {
    switch (slot.policy) {
      case 'never':
        return false;
      case 'always':
        return true;
      default:
        // A signalled child reports a null code, which counts as a failure.
        return code !== 0;
    }
  }

  /** Marks the failed task's transitive dependents as never going to run. */
  private cascade(failed: Slot): void {
    const queue = [failed.spec.label];
    const seen = new Set<string>([failed.spec.label]);
    while (queue.length > 0) {
      const label = queue.shift() as string;
      for (const dependentLabel of this.dependents.get(label) ?? []) {
        if (seen.has(dependentLabel)) continue;
        seen.add(dependentLabel);
        queue.push(dependentLabel);
        const dependent = this.byLabel.get(dependentLabel);
        if (!dependent || dependent.state.status !== 'pending') continue;
        dependent.state.status = 'errored';
        this.note(dependent, `skipped — "${label}" ${describeFailure(this.byLabel.get(label))}`);
      }
    }
  }

  private failToSpawn(slot: Slot, error: unknown): void {
    slot.state.status = 'errored';
    slot.state.pid = undefined;
    this.note(slot, `spawn failed: ${errorMessage(error)}`);
    if (slot.kind === 'task') this.cascade(slot);
    this.emitStatus();
  }

  /**
   * Why a gate can never open. Config validation rejects these, so reaching one
   * means something upstream let it through — say so rather than hang the run.
   */
  private blockReason(slot: Slot): string {
    for (const dep of slot.spec.dependsOn ?? []) {
      const target = this.byLabel.get(dep);
      if (!target) return `it depends on "${dep}", which is not in this playbook`;
      if (target.kind === 'service') {
        return `it depends on "${dep}", which is a service and never exits 0`;
      }
      if (target.blocked) return `it depends on "${dep}", which can never run`;
    }
    return 'its dependencies can never all succeed';
  }

  private note(slot: Slot, text: string): void {
    this.options.onOutput({
      ts: Date.now(),
      label: slot.spec.label,
      stream: 'stderr',
      text: `run-mux: ${text}\n`,
    });
  }

  private emitStatus(): void {
    this.options.onStatus(this.commands);
  }
}

/** Constructs a supervisor and starts it. */
export function startRun(options: StartOptions): RunHandle {
  const supervisor = new Supervisor(options);
  supervisor.start();
  return supervisor;
}

function noop(): void {}

function kindOf(spec: PlaybookCommand): CommandKind {
  return spec.type ?? 'service';
}

function policyOf(spec: PlaybookCommand): RestartPolicy {
  return spec.restart ?? (kindOf(spec) === 'task' ? 'never' : 'on-failure');
}

/**
 * Labels whose gate can eventually open: every dependency is a known task that
 * is itself reachable. Anything left out depends on a service, a missing label
 * or a cycle, and would otherwise sit pending forever.
 */
function reachableLabels(commands: PlaybookCommand[]): Set<string> {
  const byLabel = new Map<string, PlaybookCommand>();
  for (const command of commands) {
    if (!byLabel.has(command.label)) byLabel.set(command.label, command);
  }
  const reachable = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const command of commands) {
      if (reachable.has(command.label)) continue;
      const satisfiable = (command.dependsOn ?? []).every((dep) => {
        const target = byLabel.get(dep);
        return target !== undefined && kindOf(target) === 'task' && reachable.has(dep);
      });
      if (satisfiable) {
        reachable.add(command.label);
        changed = true;
      }
    }
  }
  return reachable;
}

function describeFailure(slot: Slot | undefined): string {
  const code = slot?.state.exitCode;
  return code === undefined ? 'failed' : `exited ${code}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
