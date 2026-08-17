import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Killing a whole process tree. The direct child is usually a shell, so
 * signalling only its pid leaves the real work orphaned — that is the bug this
 * module exists to prevent.
 */

/** Time between the polite request and the force kill. */
export const KILL_GRACE_MS = 5000;

const IS_WINDOWS = process.platform === 'win32';

export interface KillOptions {
  graceMs?: number;
  /** Injected by tests so escalation can be exercised without real waiting. */
  delay?: (ms: number) => Promise<void>;
}

/** Kills one child and everything it spawned. Resolves once they are gone. */
export function killTree(child: ChildProcess, options: KillOptions = {}): Promise<void> {
  return killTrees([child], options);
}

/**
 * Kills several trees at once. Batching matters on Windows: `taskkill` accepts
 * many `/PID` arguments and spawning taskkill.exe costs far more than the kill
 * itself, so a whole playbook comes down in the time one command would take.
 *
 * Resolves only once every process has actually exited, so a caller can start a
 * fresh run without the old and new fighting over ports. If something refuses to
 * die the grace window still bounds the wait — a stuck child must never hang
 * shutdown forever.
 */
export async function killTrees(
  children: ChildProcess[],
  { graceMs = KILL_GRACE_MS, delay = sleep }: KillOptions = {},
): Promise<void> {
  const live = children.filter(isLive);
  if (live.length === 0) return;

  const pids = live.map((child) => child.pid as number);
  let childrenExited = false;
  let done = false;
  const isGone = (): boolean => childrenExited && groupsEmpty(pids);
  // The direct child is usually a shell, and a shell dies on SIGTERM even when
  // the process it launched shrugs it off — so its exit is not proof the tree
  // is gone. Poll the process group until it empties; the races below bound it.
  const treeGone = Promise.all(live.map(waitForExit)).then(() => {
    childrenExited = true;
    return whenGroupsEmpty(pids, () => done);
  });

  let escalate = noop;
  const softFailed = new Promise<void>((resolve) => {
    escalate = resolve;
  });

  try {
    requestTerminate(pids, escalate);
    await Promise.race([treeGone, delay(graceMs), softFailed]);
    if (isGone()) return;

    forceTerminate(live, pids);
    await Promise.race([treeGone, delay(graceMs)]);
  } finally {
    done = true;
  }
}

/**
 * POSIX: signal the process group, which the supervisor made the child lead by
 * spawning it detached. Windows: `taskkill /T` walks the child list itself and
 * sends WM_CLOSE, which a console app can handle. When Windows reports it could
 * not terminate a target — the usual answer for console apps — escalate straight
 * away instead of burning the whole grace window on a request that already failed.
 */
function requestTerminate(pids: number[], onDefiniteFailure: () => void): void {
  if (!IS_WINDOWS) {
    for (const pid of pids) signalGroup(pid, 'SIGTERM');
    return;
  }
  void runTaskkill([...pidArgs(pids), '/T']).then((code) => {
    if (code !== 0) onDefiniteFailure();
  });
}

function forceTerminate(children: ChildProcess[], pids: number[]): void {
  if (!IS_WINDOWS) {
    for (const pid of pids) signalGroup(pid, 'SIGKILL');
    return;
  }
  void runTaskkill([...pidArgs(pids), '/T', '/F']).then((code) => {
    // taskkill.exe missing or unusable — at least take out the shells we own.
    if (code === SPAWN_FAILED) for (const child of children) child.kill('SIGKILL');
  });
}

/**
 * The negated pid addresses the group. Falling back to the bare pid covers the
 * child having been reaped, or not leading a group at all.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* no such group */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

const SPAWN_FAILED = -1;
const GROUP_POLL_MS = 50;

/**
 * True when no process is left in any of the groups. Windows has no equivalent
 * notion here — `taskkill /T` already walked the descendants — so the direct
 * children exiting is the whole answer.
 */
function groupsEmpty(pids: number[]): boolean {
  if (IS_WINDOWS) return true;
  return pids.every((pid) => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  });
}

/** Polls until every group has emptied, or the caller stops caring. */
function whenGroupsEmpty(pids: number[], cancelled: () => boolean): Promise<void> {
  if (groupsEmpty(pids)) return Promise.resolve();
  return new Promise((resolve) => {
    const poll = (): void => {
      if (cancelled() || groupsEmpty(pids)) {
        resolve();
        return;
      }
      setTimeout(poll, GROUP_POLL_MS).unref();
    };
    setTimeout(poll, GROUP_POLL_MS).unref();
  });
}

function noop(): void {}

function runTaskkill(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    proc.once('error', () => resolve(SPAWN_FAILED));
    proc.once('close', (code) => resolve(code ?? SPAWN_FAILED));
  });
}

function pidArgs(pids: number[]): string[] {
  return pids.flatMap((pid) => ['/PID', String(pid)]);
}

export function isLive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/** `exit` rather than `close`: the process is gone even if a pipe is still held open. */
function waitForExit(child: ChildProcess): Promise<void> {
  if (!isLive(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

/** Unref'd: a grace timer that lost its race must not keep the process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
