/**
 * One binary, three programs.
 *
 * A compiled executable has no scripts on disk to point a runtime at, so the CLI
 * re-execs *itself* with one of these as the first argument instead of spawning
 * `dist/daemon/index.js`. The leading underscores keep them out of the verb
 * namespace: they are an internal calling convention, not commands anyone types.
 */

export const DAEMON_ROLE = '__daemon';
export const TUI_ROLE = '__tui';

export type Role = typeof DAEMON_ROLE | typeof TUI_ROLE;

export function isRole(value: string | undefined): value is Role {
  return value === DAEMON_ROLE || value === TUI_ROLE;
}

/**
 * A compiled binary runs its entry out of Bun's embedded filesystem — the same
 * marker OpenTUI keys its own asset resolution off — and that is the only
 * dependable way to tell a release binary from `bun src/cli/index.ts`.
 */
const EMBEDDED_MARKERS = ['/$bunfs/', '~BUN'];

function entryPath(): string {
  return process.argv[1] ?? '';
}

export function isCompiled(): boolean {
  const entry = entryPath();
  return EMBEDDED_MARKERS.some((marker) => entry.includes(marker));
}

/**
 * The arguments that re-exec this program in the given role. Compiled, the role
 * is the whole list; in development argv[0] is the bun binary rather than us, so
 * the entry script has to be named ahead of it.
 */
export function roleArgs(role: Role): string[] {
  return isCompiled() ? [role] : [entryPath(), role];
}
