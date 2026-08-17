/**
 * Assembly. Everything with a lifetime lives here: the frozen environment, the
 * config snapshot, the registry, the IPC server, and the order those come up and
 * go down in.
 */

import { type Loaded, loadGlobalConfig } from '../config/index.js';
import { createIpcServer, type IpcServer } from '../ipc/index.js';
import { socketPath } from '../paths.js';
import { listTargets } from '../state/index.js';
import type { GlobalConfig } from '../types.js';
import { VERSION } from '../version.js';
import { createMethods, type DaemonContext, startTarget } from './methods.js';
import { reapOrphans, type ReapResult } from './reap.js';
import { Registry } from './registry.js';

export interface DaemonOptions {
  /** Defaults to `socketPath()`. */
  path?: string;
  /**
   * The environment children inherit. Captured once, because the daemon is
   * autospawned from whichever terminal happened to run a command first and must
   * not drift with it afterwards.
   */
  env?: NodeJS.ProcessEnv;
  /** Boot-time orphan cleanup. On by default; off makes tests deterministic. */
  reap?: boolean;
  /** Restore `autostart: true` targets after the server is listening. */
  autostart?: boolean;
  /** How long a stop waits before escalating to a force kill. Defaults to the supervisor's. */
  killGraceMs?: number;
  /** Diagnostics. The autospawned daemon points this at its log file. */
  onError?: (error: Error, context: string) => void;
  onNote?: (message: string) => void;
  /** Runs after a clean shutdown; the real entry point exits the process here. */
  onShutdown?: () => void;
}

export interface Daemon {
  readonly startedAt: number;
  readonly registry: Registry;
  readonly server: IpcServer;
  readonly path: string;
  readonly version: string;
  readonly reaped: ReapResult | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const daemon = createDaemon(options);
  await daemon.start();
  return daemon;
}

export function createDaemon(options: DaemonOptions = {}): Daemon {
  const startedAt = Date.now();
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const version = VERSION;
  const path = options.path ?? socketPath();
  const note = options.onNote ?? ((): void => {});
  const report = options.onError ?? ((): void => {});

  let config: Loaded<GlobalConfig> = loadGlobalConfig();
  let reaped: ReapResult | null = null;
  let stopping: Promise<void> | undefined;

  const registry = new Registry({ onError: report, killGraceMs: options.killGraceMs });

  const context: DaemonContext = {
    env,
    registry,
    startedAt,
    version,
    socketPath: path,
    globalConfig: () => config,
    reloadConfig: () => {
      config = loadGlobalConfig();
      return config;
    },
    requestStop: () => {
      // The reply is written when this handler returns, so the teardown has to
      // wait for a turn of the loop or the client would lose its answer.
      setTimeout(() => void stop().catch(() => {}), 10);
    },
  };

  const server = createIpcServer({
    handler: createMethods(context),
    version,
    path,
    onError: (error, info) => report(error, info.method ? `method ${info.method}` : 'ipc'),
  });

  async function start(): Promise<void> {
    // Before anything else: a surviving child of a dead daemon would fight the
    // run we are about to start for the same ports.
    if (options.reap !== false) {
      reaped = await reapOrphans({ onNote: note });
      if (reaped.killed.length > 0) {
        note(`reaped ${reaped.killed.length} orphaned process(es) from a previous daemon`);
      }
    }

    await server.listen();

    if (options.autostart !== false) await restoreAutostart();
  }

  async function restoreAutostart(): Promise<void> {
    for (const target of listTargets()) {
      if (target.autostart !== true) continue;
      try {
        await startTarget(context, target);
        note(`autostarted ${target.slug}`);
      } catch (error) {
        report(
          error instanceof Error ? error : new Error(String(error)),
          `autostart ${target.slug}`,
        );
      }
    }
  }

  /**
   * Idempotent, and every step is guarded: a run that refuses to die must not
   * stop the socket being released or the process being allowed to exit.
   */
  async function stop(): Promise<void> {
    stopping ??= (async () => {
      try {
        await registry.stopAll();
      } catch (error) {
        report(error instanceof Error ? error : new Error(String(error)), 'stopping runs');
      }
      try {
        await server.close();
      } catch (error) {
        report(error instanceof Error ? error : new Error(String(error)), 'closing the server');
      }
      options.onShutdown?.();
    })();
    return stopping;
  }

  return {
    startedAt,
    registry,
    server,
    path,
    version,
    get reaped() {
      return reaped;
    },
    start,
    stop,
  };
}

/**
 * Stops the daemon cleanly on a signal. Returns a function that removes the
 * handlers, so an in-process daemon does not leave them on the host process.
 */
export function installSignalHandlers(daemon: Daemon): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map((signal) => {
    const handler = (): void => {
      void daemon.stop().catch(() => {});
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
}
