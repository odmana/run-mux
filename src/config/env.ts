import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { normalize } from '../paths.js';
import type { PlaybookCommand } from '../types.js';

export type EnvSource = 'daemon' | 'playbook' | 'envFile' | 'target' | 'injected';

export interface ResolveEnvInput {
  /** The daemon's own environment, frozen at startup. */
  daemonEnv: Record<string, string | undefined>;
  command: Pick<PlaybookCommand, 'env' | 'envFile'>;
  /** Checkout root, which a relative `envFile` resolves against. */
  checkoutPath: string;
  /** `targets[slug].env` from the global config. */
  targetEnv?: Record<string, string>;
  /** Already-computed MUX_* values; slot allocation belongs to state/. */
  injected?: Record<string, string>;
}

export interface ResolvedEnv {
  env: Record<string, string>;
  /** Which layer each final value came from, for `rmux env`. */
  sources: Record<string, EnvSource>;
  problems: string[];
}

/**
 * Layers the environment for one command, lowest precedence first:
 * daemon < playbook `env` < `envFile` < target overrides < injected MUX_*.
 */
export function resolveEnv(input: ResolveEnvInput): ResolvedEnv {
  const env: Record<string, string> = {};
  const sources: Record<string, EnvSource> = {};
  const problems: string[] = [];
  const caseInsensitive = process.platform === 'win32';

  const apply = (values: Record<string, string | undefined>, source: EnvSource): void => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      // Windows env names are case-insensitive, so PATH must not shadow Path.
      if (caseInsensitive) {
        const folded = key.toLowerCase();
        for (const existing of Object.keys(env)) {
          if (existing !== key && existing.toLowerCase() === folded) {
            delete env[existing];
            delete sources[existing];
          }
        }
      }
      env[key] = value;
      sources[key] = source;
    }
  };

  apply(input.daemonEnv, 'daemon');
  apply(input.command.env ?? {}, 'playbook');

  const envFile = input.command.envFile;
  if (envFile) {
    const path = normalize(
      isAbsolute(envFile) ? envFile : resolvePath(input.checkoutPath, envFile),
    );
    if (!existsSync(path)) {
      problems.push(`envFile not found: ${path}`);
    } else {
      try {
        apply(parseEnvFile(readFileSync(path, 'utf-8')), 'envFile');
      } catch (err) {
        problems.push(`envFile unreadable: ${path}: ${(err as Error).message}`);
      }
    }
  }

  apply(input.targetEnv ?? {}, 'target');
  apply(input.injected ?? {}, 'injected');

  return { env, sources, problems };
}

/**
 * Minimal dotenv reader: `KEY=VALUE` lines, `#` comments and blank lines
 * skipped, an `export ` prefix tolerated, and one layer of surrounding single
 * or double quotes stripped. `=` inside a value is kept.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const assignment =
      line.startsWith('export ') || line.startsWith('export\t')
        ? line.slice('export'.length).trim()
        : line;

    const eq = assignment.indexOf('=');
    if (eq <= 0) continue;

    const key = assignment.slice(0, eq).trim();
    if (key === '') continue;

    const value = assignment.slice(eq + 1).trim();
    result[key] = stripQuotes(value);
  }
  return result;
}

function stripQuotes(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}
