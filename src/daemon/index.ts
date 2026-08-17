/**
 * The daemon process. Autospawn re-execs the binary in its daemon role and points
 * its stdio at `daemon.log`, so everything written here ends up there.
 */

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

export async function runDaemon(): Promise<void> {
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
    console.error(
      `${stamp()} daemon failed to start: ${error instanceof Error ? error.stack : String(error)}`,
    );
    process.exit(70);
  }
  console.log(
    `${stamp()} daemon ${daemon.version} listening on ${daemon.path} (pid ${process.pid})`,
  );
}
