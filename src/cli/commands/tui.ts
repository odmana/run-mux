/**
 * Bare `rmux` — the TUI.
 *
 * The TUI runs as a child process so that an ordinary verb never loads the
 * renderer, React or any of OpenTUI's native machinery. The child opens its own
 * daemon connection, so nothing is autospawned here.
 */

import { spawn } from 'node:child_process';

import { roleArgs, TUI_ROLE } from '../../roles.js';
import { CliError } from '../output.js';
import { tuiEntry } from './daemon.js';

export async function launchTui(): Promise<number> {
  const entry = tuiEntry();
  return await run(entry === undefined ? roleArgs(TUI_ROLE) : [entry]);
}

function run(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('error', (error: Error) => {
      reject(new CliError('unavailable', `could not start the run-mux TUI: ${error.message}`));
    });
    child.once('close', (code) => resolve(code ?? 0));
  });
}
