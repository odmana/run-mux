/**
 * The live runs. One entry per target that is currently running, holding the
 * supervisor handle, the log run its output is written into, and the playbook
 * definition it was started from.
 *
 * Everything the supervisor learns leaves through callbacks, so this is where
 * output becomes log entries and spawned pids become `ChildRecord`s — written as
 * they happen, because the whole point of those records is surviving a daemon
 * that dies without running any shutdown code.
 */

import { createRun, type RunHandle as LogRun } from '../logs/index.js';
import { addChild, removeChild } from '../state/index.js';
import { startRun, type RunHandle as SupervisorHandle } from '../supervisor/index.js';
import type { CommandState, Playbook, TargetStatus } from '../types.js';

export interface StartInput {
  slug: string;
  /** The playbook as configured. Snapshotted into the run meta and compared on reload. */
  definition: Playbook;
  /** The same commands, each carrying its fully resolved `env`. */
  materialised: Playbook;
  /** The checkout root; per-command `cwd` resolves against it. */
  cwd: string;
  /** The frozen daemon environment, used as the run-wide layer. */
  env: Record<string, string>;
  /** Non-fatal problems found while resolving the run, recorded into its log. */
  notes?: string[];
}

export interface RunEntry {
  readonly slug: string;
  readonly runId: string;
  readonly startedAt: number;
  readonly definition: Playbook;
  readonly log: LogRun;
  readonly handle: SupervisorHandle;
  readonly commands: CommandState[];
  readonly status: TargetStatus;
  /** Set by `config.reload` when the definition changed under a running target. */
  staleDefinition: boolean;
}

/** Label the daemon's own notes are logged under, distinct from any command's. */
export const NOTE_LABEL = 'run-mux';

export interface RegistryOptions {
  /** Anything survivable: a state write that failed, a log that could not be flushed. */
  onError?: (error: Error, context: string) => void;
  /** Passed to the supervisor; tests shorten it so a stop does not wait out the grace. */
  killGraceMs?: number;
}

export class Registry {
  private readonly entries = new Map<string, RunEntry>();
  /** Per-slug operation queue, so a start can never overlap the stop it follows. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: RegistryOptions = {}) {}

  get size(): number {
    return this.entries.size;
  }

  get(slug: string): RunEntry | undefined {
    return this.entries.get(slug);
  }

  has(slug: string): boolean {
    return this.entries.has(slug);
  }

  list(): RunEntry[] {
    return [...this.entries.values()];
  }

  markStale(slug: string): boolean {
    const entry = this.entries.get(slug);
    if (!entry || entry.staleDefinition) return false;
    entry.staleDefinition = true;
    return true;
  }

  /** Stops any run already on this slug and waits for it before spawning the new one. */
  start(input: StartInput): Promise<RunEntry> {
    return this.serialise(input.slug, async () => {
      await this.teardown(input.slug);
      return this.spawn(input);
    });
  }

  stop(slug: string): Promise<boolean> {
    return this.serialise(slug, () => this.teardown(slug));
  }

  restartCommand(slug: string, label: string): Promise<void> {
    return this.serialise(slug, async () => {
      const entry = this.entries.get(slug);
      if (!entry) return;
      await entry.handle.restartCommand(label);
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((slug) => this.stop(slug)));
  }

  private serialise<T>(slug: string, op: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(slug) ?? Promise.resolve();
    const next = previous.then(op, op);
    this.queues.set(
      slug,
      next.catch(() => {}),
    );
    return next;
  }

  private spawn(input: StartInput): RunEntry {
    const { slug } = input;
    const log = createRun(slug, input.definition);
    const startedAt = Date.now();
    for (const note of input.notes ?? []) {
      log.append({ ts: startedAt, label: NOTE_LABEL, stream: 'stderr', text: `${note}\n` });
    }
    let commands: CommandState[] = input.materialised.commands.map((command) => ({
      label: command.label,
      status: 'pending',
      restarts: 0,
    }));

    let handle: SupervisorHandle;
    try {
      handle = startRun({
        playbook: input.materialised,
        cwd: input.cwd,
        env: input.env,
        ...(this.options.killGraceMs === undefined
          ? {}
          : { killGraceMs: this.options.killGraceMs }),
        onOutput: (entry) => log.append(entry),
        onStatus: (next) => {
          commands = next;
        },
        onChildSpawn: (label, pid, spawnedAt) => {
          this.guard(
            () => addChild({ pid, startedAt: spawnedAt, label, targetSlug: slug }),
            `recording child ${pid} of ${slug}`,
          );
        },
        onChildExit: (_label, pid) => {
          this.guard(() => removeChild(pid), `clearing child ${pid} of ${slug}`);
        },
      });
    } catch (error) {
      void log.finishRun().catch(() => {});
      throw error;
    }

    const entry: RunEntry = {
      slug,
      runId: log.runId,
      startedAt,
      definition: input.definition,
      log,
      handle,
      get commands() {
        return commands;
      },
      get status() {
        return handle.status;
      },
      staleDefinition: false,
    };
    this.entries.set(slug, entry);
    return entry;
  }

  private async teardown(slug: string): Promise<boolean> {
    const entry = this.entries.get(slug);
    if (!entry) return false;
    this.entries.delete(slug);
    try {
      await entry.handle.stop();
    } catch (error) {
      this.report(error, `stopping ${slug}`);
    }
    try {
      await entry.log.finishRun(exitSummary(entry.commands));
    } catch (error) {
      this.report(error, `closing the log for ${slug}`);
    }
    return true;
  }

  private guard(fn: () => void, context: string): void {
    try {
      fn();
    } catch (error) {
      this.report(error, context);
    }
  }

  private report(error: unknown, context: string): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
  }
}

function exitSummary(commands: CommandState[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const command of commands) {
    if (command.exitCode !== undefined) summary[command.label] = command.exitCode;
  }
  return summary;
}
