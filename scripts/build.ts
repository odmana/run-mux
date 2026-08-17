/**
 * Builds the release binaries.
 *
 * `rmux` ships as one self-contained executable per platform: a compiled binary
 * has no `dist/` to read, so the daemon and the TUI live inside it as argv roles
 * rather than as scripts, and the version is folded in here because there is no
 * package.json to read at runtime either.
 *
 * Cross-compiling every target from one host works only because pnpm fetches
 * OpenTUI's native core for all of them — see `supportedArchitectures` in
 * pnpm-workspace.yaml. Without that, a foreign target fails to resolve
 * `@opentui/core-<platform>` and the build stops.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src', 'cli', 'index.ts');
const OUT_DIR = join(ROOT, 'dist');

/** Every target we publish. The host build omits the suffix. */
const TARGETS = [
  'bun-windows-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
] as const;

function version(): string {
  const raw = readFileSync(join(ROOT, 'package.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { version?: string };
  if (parsed.version === undefined) throw new Error('package.json has no version');
  return parsed.version;
}

function build(target: string | undefined, outfile: string, buildVersion: string): void {
  const args = [
    'build',
    ENTRY,
    '--compile',
    '--minify',
    // No --bytecode: it cannot compile top-level await, which OpenTUI's chunks
    // use to resolve their native backend. It would only have bought ~15ms of
    // startup anyway, and it does not shrink the binary — Bun's runtime is
    // nearly all of it.
    '--define',
    `process.env.RUN_MUX_BUILD_VERSION=${JSON.stringify(buildVersion)}`,
    '--outfile',
    outfile,
  ];
  if (target !== undefined) args.push(`--target=${target}`);

  const label = target ?? 'host';
  process.stdout.write(`building ${label}\n`);
  const result = spawnSync('bun', args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw new Error(`could not run bun: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`build failed for ${label} (exit ${result.status})`);
}

const buildVersion = version();
const all = process.argv.includes('--all');

if (all) {
  for (const target of TARGETS) build(target, join(OUT_DIR, `rmux-${target}`), buildVersion);
} else {
  build(undefined, join(OUT_DIR, 'rmux'), buildVersion);
}
