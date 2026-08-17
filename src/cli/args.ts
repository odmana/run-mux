/**
 * A small argv parser. Deliberately hand-rolled: the surface is a dozen verbs
 * and a handful of flags, and a dependency here would be the only one in the
 * CLI path.
 */

export interface ParsedArgs {
  /** Verb path, e.g. ['repo','add'] or ['start']. */
  command: string[];
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
}

/** Verbs that take a subcommand rather than a target as their second word. */
const NESTED_VERBS = new Set(['repo', 'daemon', 'config']);

/** Flags that are booleans, so the word after them is a positional, not a value. */
const BOOLEAN_FLAGS = new Set([
  'json',
  'follow',
  'help',
  'version',
  'force',
  'all',
  'off',
  'no-color',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;

  // The verb path comes first and never starts with a dash.
  if (i < argv.length && !argv[i].startsWith('-')) {
    command.push(argv[i]);
    i++;
    if (NESTED_VERBS.has(command[0]) && i < argv.length && !argv[i].startsWith('-')) {
      command.push(argv[i]);
      i++;
    }
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      // Short flags are only ever boolean here.
      for (const ch of arg.slice(1)) flags[ch] = true;
      continue;
    }

    positionals.push(arg);
  }

  return { command, positionals, flags, json: flags.json === true };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Turns `--since` into an absolute epoch ms. Accepts a relative duration
 * (`5m`, `90s`, `2h`) or an absolute ISO timestamp. Returns null when the input
 * is not understood, so the caller can report bad_params rather than silently
 * defaulting to "everything".
 */
export function parseSince(input: string, now = Date.now()): number | null {
  const relative = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(input.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = DURATION_UNITS[relative[2]];
    return now - amount * unit;
  }

  const absolute = Date.parse(input);
  return Number.isNaN(absolute) ? null : absolute;
}
