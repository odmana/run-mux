#!/usr/bin/env node
/**
 * The daemon process. Autospawn runs this file with the current node binary and
 * points its stdio at `daemon.log`, so everything written here ends up there.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDaemon, installSignalHandlers } from './daemon.js';

export { createDaemon, installSignalHandlers, startDaemon } from './daemon.js';
export type { Daemon, DaemonOptions } from './daemon.js';
export { createMethods, startTarget } from './methods.js';
export type { DaemonContext } from './methods.js';
export { CREATION_TOLERANCE_MS, reapOrphans } from './reap.js';
export type { ReapResult } from './reap.js';
export { NOTE_LABEL, Registry } from './registry.js';
export type { RunEntry, StartInput } from './registry.js';

function stamp(): string {
  return new Date().toISOString();
}

async function main(): Promise<void> {
  const daemon = createDaemon({
    onNote: (message) => console.log(`${stamp()} ${message}`),
    onError: (error, context) => console.error(`${stamp()} ${context}: ${error.stack ?? error}`),
    onShutdown: () => {
      console.log(`${stamp()} daemon stopped`);
      process.exit(0);
    },
  });

  const removeSignalHandlers = installSignalHandlers(daemon);
  try {
    await daemon.start();
  } catch (error) {
    removeSignalHandlers();
    throw error;
  }
  console.log(
    `${stamp()} daemon ${daemon.version} listening on ${daemon.path} (pid ${process.pid})`,
  );
}

/** True only when node was pointed at this file, so an import cannot start a daemon. */
function runDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = resolve(fileURLToPath(import.meta.url));
  const invoked = resolve(entry);
  return process.platform === 'win32'
    ? self.toLowerCase() === invoked.toLowerCase()
    : self === invoked;
}

if (runDirectly()) {
  main().catch((error: unknown) => {
    console.error(
      `daemon failed to start: ${error instanceof Error ? error.stack : String(error)}`,
    );
    process.exit(70);
  });
}
