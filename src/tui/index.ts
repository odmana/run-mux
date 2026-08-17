#!/usr/bin/env node
/**
 * `rmux` with no verb. Spawned as its own process with `--experimental-ffi`,
 * because OpenTUI's renderer reaches for `node:ffi` and that flag does not
 * exist before Node 26.1 — the check below exists so an older Node produces a
 * sentence a user can act on instead of "OpenTUI native FFI is not available
 * for this runtime yet".
 *
 * Quitting the TUI does not stop the daemon. That is the whole point of the
 * daemon, and the footer says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createElement } from 'react';

import { ensureDaemon, type IpcClient } from '../ipc/index.js';
import { App } from './app.js';

const START_TIMEOUT_MS = 5000;

/** Node prints this on every start once `--experimental-ffi` is on; it would land on the alt screen. */
function silenceFfiWarning(): void {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /FFI/i.test(warning.message)) return;
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

function daemonEntry(): string {
  return process.env.RUN_MUX_DAEMON_ENTRY ?? resolve(packageRoot(), 'dist', 'daemon', 'index.js');
}

function version(): string {
  try {
    const raw = readFileSync(join(packageRoot(), 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Indirect on purpose: `node:ffi` has no type declarations and does not exist before 26.1. */
async function ffiAvailable(): Promise<boolean> {
  const specifier = 'node:ffi';
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(69);
}

export async function runTui(): Promise<void> {
  silenceFfiWarning();

  if (!(await ffiAvailable())) {
    refuse(
      `the run-mux TUI needs Node >= 26.1 started with --experimental-ffi (this is node ${process.version}).\n` +
        'Everything else works without it: try `rmux ls`, `rmux logs <target> --follow`, or `rmux --help`.',
    );
  }
  if (process.stdout.isTTY !== true) {
    refuse('the run-mux TUI needs a terminal; use `rmux ls` or `rmux --json` when piping.');
  }

  let client: IpcClient;
  try {
    client = await ensureDaemon({ entry: daemonEntry(), timeoutMs: START_TIMEOUT_MS });
  } catch (error) {
    refuse(`could not reach the run-mux daemon: ${error instanceof Error ? error.message : error}`);
  }

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
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

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  if (process.argv.includes('--version')) {
    process.stdout.write(`${version()}\n`);
  } else {
    runTui().catch((error: unknown) => {
      process.stderr.write(`run-mux tui: ${error instanceof Error ? error.message : error}\n`);
      process.exitCode = 70;
    });
  }
}
