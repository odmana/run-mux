/**
 * Bare `rmux` — the TUI.
 *
 * The TUI runs as a child process rather than in-process because OpenTUI's
 * renderer calls `node:ffi`, which only exists behind `--experimental-ffi`.
 * That flag cannot be set from `NODE_OPTIONS`, and a shebang carrying it would
 * not survive Windows, so the only portable place to put it is a spawn.
 *
 * The child opens its own daemon connection, so nothing is autospawned here.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { CliError } from '../output.js';
import { tuiEntry } from './daemon.js';

const FFI_FLAG = '--experimental-ffi';
const MIN_NODE_MAJOR = 26;
const MIN_NODE_MINOR = 1;
const MIN_NODE = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

export async function launchTui(): Promise<number> {
  const running = process.versions.node;
  if (!meetsNodeFloor(running)) {
    throw new CliError('unavailable', tooOldMessage(running));
  }

  const entry = tuiEntry();
  if (!existsSync(entry)) {
    throw new CliError(
      'unavailable',
      `the run-mux TUI is not built: nothing at ${entry}\nRun \`pnpm build\`, then \`rmux\` again. Every other verb works without it.`,
    );
  }

  return await run(entry);
}

/** Node 26.1 is the first release with `node:ffi`; the flag does not parse before it. */
function meetsNodeFloor(version: string): boolean {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major !== MIN_NODE_MAJOR) return major > MIN_NODE_MAJOR;
  return minor >= MIN_NODE_MINOR;
}

/**
 * The likeliest first-run failure there is, so it names the floor, what is
 * actually running, and the one command that fixes it.
 */
function tooOldMessage(running: string): string {
  return [
    `the run-mux TUI needs Node ${MIN_NODE} or newer, but this is Node ${running}.`,
    `OpenTUI's renderer calls node:ffi, which older Node has no ${FFI_FLAG} flag for.`,
    'Run `fnm use` in the run-mux checkout — it pins the right version in .node-version — then run `rmux` again.',
    'Every other rmux verb works fine on this Node.',
  ].join('\n');
}

function run(entry: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FFI_FLAG, entry], { stdio: 'inherit' });
    child.once('error', (error: Error) => {
      reject(new CliError('unavailable', `could not start the run-mux TUI: ${error.message}`));
    });
    child.once('close', (code) => resolve(code ?? 0));
  });
}
