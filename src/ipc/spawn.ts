/**
 * Autospawn: the CLI connects to the daemon, and starts one if nobody has. A
 * `wx` lock file makes the start single-flight, so ten shells running `rmux up`
 * at once still produce exactly one daemon.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { daemonLogPath, lockPath, socketPath } from '../paths.js';
import { DAEMON_ROLE, roleArgs } from '../roles.js';
import { connect, type IpcClient } from './client.js';
import { rpcError } from './framing.js';

const DEFAULT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 25;
const CONNECT_TIMEOUT_MS = 1000;
/**
 * The winner creates the lock and writes its pid in two steps, so a reader can
 * catch it empty. An empty lock younger than this is assumed to be mid-write.
 */
const LOCK_WRITE_GRACE_MS = 2000;
const LOCK_ATTEMPTS = 5;

export interface EnsureDaemonOptions {
  /**
   * Script to run instead of re-execing ourselves in the daemon role. Only set
   * by `RUN_MUX_DAEMON_ENTRY`, which is how tests substitute a stub daemon — a
   * compiled binary has no script to point at.
   */
  entry?: string;
  args?: string[];
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Budget for the whole start-and-connect dance. */
  timeoutMs?: number;
  /** Defaults to `socketPath()`. */
  path?: string;
}

/** Connects if a daemon is up, otherwise null. Never throws for a missing daemon. */
export async function tryConnect(
  options: { path?: string; timeoutMs?: number } = {},
): Promise<IpcClient | null> {
  try {
    return await connect({
      path: options.path ?? socketPath(),
      timeoutMs: options.timeoutMs ?? CONNECT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<IpcClient> {
  const path = options.path ?? socketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const running = await tryConnect({ path });
  if (running) return running;

  const deadline = Date.now() + timeoutMs;
  const lock = lockPath();

  for (;;) {
    if (await acquireLock(lock)) {
      try {
        // The lock is only released once the daemon answers, so re-checking here
        // closes the window where a waiter sees the lock freed but polled the
        // socket a moment too early and would otherwise spawn a second daemon.
        const startedByAnother = await tryConnect({ path });
        if (startedByAnother) return startedByAnother;

        const spawned: { failure?: Error } = {};
        spawnDaemon(options, (error) => {
          spawned.failure = error;
        });
        const client = await pollConnect(path, deadline, () => spawned.failure === undefined);
        if (client) return client;
        throw rpcError(
          'unavailable',
          spawned.failure
            ? `could not start the run-mux daemon: ${spawned.failure.message}`
            : `the run-mux daemon did not come up within ${timeoutMs}ms; see ${daemonLogPath()}`,
        );
      } finally {
        releaseLock(lock);
      }
    }

    // Somebody else is starting it. Wait for their socket rather than racing
    // them to a second daemon, but stop waiting if their lock goes stale.
    const client = await pollConnect(path, deadline, () => inspectLock(lock) === 'held');
    if (client) return client;
    if (Date.now() >= deadline) {
      throw rpcError(
        'unavailable',
        `another process holds ${lock} but no daemon appeared within ${timeoutMs}ms`,
      );
    }
  }
}

function spawnDaemon(
  options: EnsureDaemonOptions,
  onError: (error: Error) => void,
): number | undefined {
  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const command = options.entry === undefined ? roleArgs(DAEMON_ROLE) : [options.entry];
    const child = spawn(
      options.execPath ?? process.execPath,
      [...command, ...(options.args ?? [])],
      {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: options.env ?? process.env,
        windowsHide: true,
      },
    );
    child.once('error', onError);
    // Detached plus unref is what lets `rmux up` exit while the daemon lives on.
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

async function pollConnect(
  path: string,
  deadline: number,
  keepGoing: () => boolean,
): Promise<IpcClient | null> {
  for (;;) {
    const client = await tryConnect({ path, timeoutMs: CONNECT_TIMEOUT_MS });
    if (client) return client;
    if (Date.now() >= deadline || !keepGoing()) return null;
    await delay(POLL_INTERVAL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LockState = 'free' | 'held' | 'stale';

/**
 * `wx` is the whole race protection: the filesystem decides the single winner.
 * A lock left behind by a dead process is reclaimed rather than blocking
 * startup forever.
 */
async function acquireLock(path: string): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (inspectLock(path) !== 'stale') return false;
      releaseLock(path);
    }
  }
  return false;
}

function releaseLock(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A lock we cannot remove is reclaimed by the next caller's staleness check.
  }
}

function inspectLock(path: string): LockState {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, 'utf-8');
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return 'free';
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return Date.now() - mtimeMs < LOCK_WRITE_GRACE_MS ? 'held' : 'stale';
  }
  return isProcessAlive(pid) ? 'held' : 'stale';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
