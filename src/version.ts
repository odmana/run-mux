/**
 * The single source of the version, for the CLI, the daemon's hello frame and
 * `daemon status` alike.
 *
 * A compiled binary has no package.json to read — the build folds the version in
 * with `--define process.env.RUN_MUX_BUILD_VERSION`, which makes the fallback
 * below unreachable there. The fallback is what keeps `bun src/cli/index.ts`
 * honest in development.
 */

import { readFileSync } from 'node:fs';

function fromPackageJson(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = process.env.RUN_MUX_BUILD_VERSION ?? fromPackageJson();
