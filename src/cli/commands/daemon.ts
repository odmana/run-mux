/**
 * The daemon connection every other verb borrows, plus the `rmux daemon` verbs.
 *
 * `daemon status` and `daemon stop` deliberately do *not* autospawn: starting a
 * daemon to ask whether one is running, or to stop it, would be a lie. Every
 * other verb goes through `ctx.client()`, which does.
 */

import { ensureDaemon, isRpcFailure, tryConnect, type IpcClient } from '../../ipc/index.js';
import { socketPath } from '../../paths.js';
import { METHODS, type DaemonStatusResult } from '../../protocol.js';
import type { ParsedArgs } from '../args.js';
import { CliError, diag, emit, human, type Out } from '../output.js';
import { formatElapsed } from '../render.js';

const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 3000;
const STOP_POLL_MS = 25;

export interface Ctx {
  readonly args: ParsedArgs;
  readonly out: Out;
  /** Connects, autospawning the daemon if nobody has started one. Memoised. */
  client(): Promise<IpcClient>;
}

export interface Session extends Ctx {
  dispose(): Promise<void>;
}

/**
 * The daemon is spawned as its own process, never imported: the CLI must start
 * and answer `--version` without loading a line of daemon code. Undefined means
 * re-exec this binary in its daemon role, which is the only thing that works
 * once compiled; `RUN_MUX_DAEMON_ENTRY` overrides it with a script, which is how
 * tests substitute a stub.
 */
export function daemonEntry(): string | undefined {
  return process.env.RUN_MUX_DAEMON_ENTRY;
}

/** The TUI is spawned the same way, and for the same reason. */
export function tuiEntry(): string | undefined {
  return process.env.RUN_MUX_TUI_ENTRY;
}

async function open(): Promise<IpcClient> {
  const running = await tryConnect();
  if (running) return running;
  const client = await ensureDaemon({ entry: daemonEntry(), timeoutMs: START_TIMEOUT_MS });
  diag(`note: started the run-mux daemon (pid ${client.hello.pid})`);
  return client;
}

export function makeSession(args: ParsedArgs, out: Out): Session {
  let opened: IpcClient | undefined;
  let pending: Promise<IpcClient> | undefined;
  return {
    args,
    out,
    client() {
      pending ??= open().then((client) => {
        opened = client;
        return client;
      });
      return pending;
    },
    async dispose() {
      if (!opened) return;
      await opened.close().catch(() => {});
    },
  };
}

/**
 * The single point where a wire error becomes a CLI error, so every verb gets
 * the same exit code mapping. The daemon's structured `data` — the candidates
 * behind an `ambiguous`, say — is carried through verbatim rather than
 * recomputed here, which would be a second copy of the daemon's matching rule.
 */
export async function call<T>(ctx: Ctx, method: string, params?: unknown): Promise<T> {
  const client = await ctx.client();
  try {
    return (await client.request(method, params)) as T;
  } catch (error) {
    if (!isRpcFailure(error)) throw error;
    throw new CliError(error.code, error.message, error.data);
  }
}

export async function status(ctx: Ctx): Promise<void> {
  const client = await tryConnect();
  if (!client) {
    emit(ctx.out, { daemon: { alive: false, socketPath: socketPath() } });
    human(ctx.out, 'run-mux daemon: not running');
    human(ctx.out, `  socket   ${socketPath()}`);
    human(ctx.out, '  start it by running any verb, e.g. `rmux ls`');
    return;
  }
  try {
    const result = (await client.request(METHODS.daemonStatus)) as DaemonStatusResult;
    emit(ctx.out, { daemon: { alive: true, ...result } });
    human(ctx.out, `run-mux daemon: running (pid ${result.pid})`);
    human(ctx.out, `  version  ${result.version}  protocol ${result.protocol}`);
    human(ctx.out, `  uptime   ${formatElapsed(result.uptimeMs)}`);
    human(ctx.out, `  targets  ${result.targets} (${result.running} running)`);
    human(ctx.out, `  socket   ${result.socketPath}`);
    human(ctx.out, `  state    ${result.stateDir}`);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function stop(ctx: Ctx): Promise<void> {
  const stopped = await stopRunning();
  emit(ctx.out, { daemon: { alive: false, stopped } });
  human(ctx.out, stopped ? 'stopped the run-mux daemon' : 'run-mux daemon: not running');
}

export async function restart(ctx: Ctx): Promise<void> {
  await stopRunning();
  const client = await ctx.client();
  const result = (await client.request(METHODS.daemonStatus)) as DaemonStatusResult;
  emit(ctx.out, { daemon: { alive: true, restarted: true, ...result } });
  human(ctx.out, `restarted the run-mux daemon (pid ${result.pid})`);
}

async function stopRunning(): Promise<boolean> {
  const client = await tryConnect();
  if (!client) return false;
  try {
    await client.request(METHODS.daemonStop);
  } catch (error) {
    // A daemon that exits before answering is a successful stop, not a failure.
    if (!isRpcFailure(error) || error.code !== 'unavailable') {
      throw new CliError(
        isRpcFailure(error) ? error.code : 'internal',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  await client.close().catch(() => {});
  await waitForExit();
  return true;
}

async function waitForExit(): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  for (;;) {
    const probe = await tryConnect({ timeoutMs: 500 });
    if (!probe) return;
    await probe.close().catch(() => {});
    if (Date.now() >= deadline) {
      diag('warning: the daemon is still answering after being asked to stop');
      return;
    }
    await new Promise((done) => setTimeout(done, STOP_POLL_MS));
  }
}
