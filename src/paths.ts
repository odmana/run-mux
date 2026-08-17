import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

/** The committed per-checkout playbook file. */
export const REPO_CONFIG_FILENAME = '.run-mux.json';

/**
 * Every path is rooted here when RUN_MUX_HOME is set, which is how tests keep
 * off the real user directories. Read at call time, never cached, so a test can
 * set it per-case.
 */
function overrideRoot(): string | undefined {
  return process.env.RUN_MUX_HOME || undefined;
}

export function normalize(p: string): string {
  return p.replaceAll('\\', '/');
}

export function configDir(): string {
  const root = overrideRoot();
  if (root) return normalize(join(root, 'config'));
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return normalize(join(appData, 'run-mux'));
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return normalize(join(xdg, 'run-mux'));
}

export function stateDir(): string {
  const root = overrideRoot();
  if (root) return normalize(join(root, 'state'));
  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return normalize(join(localAppData, 'run-mux'));
  }
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return normalize(join(xdg, 'run-mux'));
}

export function globalConfigPath(): string {
  return normalize(join(configDir(), 'config.json'));
}

export function statePath(): string {
  return normalize(join(stateDir(), 'state.json'));
}

export function runsDir(): string {
  return normalize(join(stateDir(), 'runs'));
}

export function runDir(targetSlug: string, runId: string): string {
  return normalize(join(runsDir(), slugToDirName(targetSlug), runId));
}

/** Slugs contain `/` and `:`, neither of which is usable in a path segment. */
export function slugToDirName(slug: string): string {
  return slug.replaceAll(':', '__').replaceAll('/', '_');
}

export function daemonLogPath(): string {
  return normalize(join(stateDir(), 'daemon.log'));
}

export function lockPath(): string {
  return normalize(join(stateDir(), 'daemon.lock'));
}

/**
 * A named pipe on Windows, a unix socket elsewhere. When RUN_MUX_HOME is set the
 * pipe name is salted with it so concurrent test runs don't collide on the one
 * well-known name.
 */
export function socketPath(): string {
  const root = overrideRoot();
  if (platform() === 'win32') {
    const suffix = root ? `-${hashString(root)}` : '';
    return `\\\\.\\pipe\\run-mux${suffix}`;
  }
  if (root) return normalize(join(root, 'daemon.sock'));
  const runtime = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  return normalize(join(runtime, 'run-mux.sock'));
}

function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
