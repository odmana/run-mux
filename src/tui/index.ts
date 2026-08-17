/**
 * `rmux` with no verb. Runs as its own process so an ordinary verb never pays
 * for the renderer; OpenTUI reaches its native core through `bun:ffi`, which
 * needs no flag.
 *
 * Quitting the TUI does not stop the daemon. That is the whole point of the
 * daemon, and the footer says so.
 */

import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createElement } from 'react';

import { ensureDaemon, type IpcClient } from '../ipc/index.js';
import { App } from './app.js';

const START_TIMEOUT_MS = 5000;

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(69);
}

export async function runTui(): Promise<void> {
  if (process.stdout.isTTY !== true) {
    refuse('the run-mux TUI needs a terminal; use `rmux ls` or `rmux --json` when piping.');
  }

  let client: IpcClient;
  try {
    // Undefined entry re-execs the binary in its daemon role; the override is
    // how tests substitute a stub daemon.
    client = await ensureDaemon({
      entry: process.env.RUN_MUX_DAEMON_ENTRY,
      timeoutMs: START_TIMEOUT_MS,
    });
  } catch (error) {
    refuse(`could not reach the run-mux daemon: ${error instanceof Error ? error.message : error}`);
  }

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
    // Nothing here takes focus — every key goes through the one handler in
    // `app.ts`. Left on, a click would focus the sidebar's scroll box, whose own
    // key bindings include j/k, and every selection move would also scroll it.
    autoFocus: false,
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    try {
      renderer.destroy();
    } catch {
      // A renderer that already tore itself down must not mask the exit.
    }
    // Closing the socket is the only thing the TUI does to the daemon on the
    // way out. `daemon.stop` is a palette verb, never a side effect of `q`.
    void client.close().finally(() => process.exit(0));
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  createRoot(renderer).render(createElement(App, { link: client, onExit: shutdown }));
}
