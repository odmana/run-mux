/**
 * `rmux`. Parses argv, picks a verb, and reports the result on exactly one
 * stream: under --json stdout carries JSON and nothing else, and every
 * diagnostic — including the error text — goes to stderr.
 */

import { isRpcFailure } from '../ipc/index.js';
import { DAEMON_ROLE, isRole, type Role } from '../roles.js';
import { EXIT_CODES } from '../types.js';
import { VERSION } from '../version.js';
import { parseArgs } from './args.js';
import * as configCmd from './commands/config.js';
import {
  makeSession,
  restart as daemonRestart,
  status as daemonStatus,
  stop as daemonStop,
  type Ctx,
} from './commands/daemon.js';
import * as logsCmd from './commands/logs.js';
import * as repoCmd from './commands/repo.js';
import * as runCmd from './commands/run.js';
import * as targetCmd from './commands/target.js';
import { launchTui } from './commands/tui.js';
import { CliError, diag, emit, human, makeOut, reportError, type Out } from './output.js';

type Handler = (ctx: Ctx) => Promise<void>;

const VERBS: Record<string, Handler | Record<string, Handler>> = {
  ls: targetCmd.list,
  add: targetCmd.add,
  rm: targetCmd.remove,
  autostart: targetCmd.autostart,
  start: runCmd.start,
  stop: runCmd.stop,
  restart: runCmd.restart,
  status: runCmd.status,
  logs: logsCmd.logs,
  env: configCmd.env,
  reload: configCmd.reload,
  repo: { add: repoCmd.add, ls: repoCmd.list, rm: repoCmd.remove },
  config: { resolve: configCmd.resolve, edit: configCmd.edit },
  daemon: { status: daemonStatus, stop: daemonStop, restart: daemonRestart },
};

/** So `repo list` and `repo remove` do not read as typos to anyone. */
const SUB_ALIASES: Record<string, string> = { list: 'ls', remove: 'rm' };

const USAGE = `rmux — run your dev stack from a daemon, not a terminal tab

usage
  rmux                                     the TUI
  rmux ls [--json]                         targets and status
  rmux add [--repo <path>]                 create a target (interactive with no args)
  rmux rm <target>                         remove a target
  rmux autostart <target> [--off]          start this target with the daemon
  rmux repo add <path> [--as <name>]       register a repository
  rmux repo ls | rm <path>                 list or unregister one
  rmux start | stop | restart <target>     run control
  rmux restart <target> --command <label>  restart one command, not the stack
  rmux status <target> [--json]            the target and its commands
  rmux logs <target> [--follow] [--label <l>] [--since <5m>] [--tail <n>] [--json]
  rmux env <target> [--command <label>]    resolved environment, with provenance
  rmux config resolve <target>             the effective playbook, and where it came from
  rmux config edit                         open the global config in $EDITOR, then reload
  rmux reload                              re-read config (no file watching by design)
  rmux daemon status | stop | restart      daemon lifecycle

flags
  --json        machine-readable output on stdout, diagnostics on stderr
  --no-color    plain text (NO_COLOR is honoured too)
  --help        this text; \`rmux help <verb>\` for one verb
  --version

A target is addressed by slug (orders/main:run-orders), by alias, or by any
unambiguous prefix — so \`rmux start orders/main\` usually does.`;

const TOPICS: Record<string, string> = {
  ls: `rmux ls [--json]

Every target you have created, grouped by repo, with its status, branch, slot
and — for anything running — how long it has been up.`,
  add: `rmux add
rmux add <repo> [<checkout>] [<playbook>]
rmux add --repo <path> [--checkout <path>] [--playbook <name>]

Creates a target from a repo, one of its checkouts, and a playbook. With no
arguments it walks you through the three choices; that path needs a terminal, so
scripts and --json callers must pass arguments instead.

--checkout defaults to the repo's main worktree, and --playbook may be omitted
when the repo offers exactly one.`,
  rm: `rmux rm <target>

Removes the target. The checkout is left alone — run-mux never creates or
removes a worktree.`,
  autostart: `rmux autostart <target>
rmux autostart <target> --off

Marks the target to start automatically whenever the daemon does, or clears the
mark with --off. \`rmux ls\` shows which targets carry it.`,
  repo: `rmux repo add <path>
rmux repo ls [--json]
rmux repo rm <path>

Registers a git repository, lists what is registered along with each repo's
checkouts and playbooks, or unregisters one. Targets are created separately with
\`rmux add\`.`,
  start: `rmux start <target>

Starts the target's playbook. Tasks run first and gate their dependents;
services come up and stay up.`,
  stop: `rmux stop <target>

Stops every command in the target, killing the process tree.`,
  restart: `rmux restart <target>
rmux restart <target> --command <label>

Restarts the whole stack, or just the one command when --command names a label.`,
  status: `rmux status <target> [--json]

The target header plus a row per command: label, status, pid, restarts and exit
code.`,
  logs: `rmux logs <target> [--follow] [--label <label>] [--since <when>] [--tail <n>] [--json]

Log output for the latest run, with each line prefixed by its command's label.
The command's own ANSI is passed through untouched.

  --follow    keep streaming; under --json this is NDJSON, one object per line
  --label     only this command's output
  --since     a duration (5m, 90s, 2h, 1d) or an ISO timestamp; resumable
  --tail      the last N entries after the other filters
  --run       an older run id, instead of the latest`,
  env: `rmux env <target> [--command <label>]

The resolved environment, and which layer each variable came from:

  daemon < playbook env < envFile < global target env < MUX_*

Without --command only the run-wide and injected layers resolve, because
playbook env and envFile are per command.`,
  config: `rmux config resolve <target>
rmux config edit

resolve  the playbook the target would actually run, and whether it came from
         the repo's committed .run-mux.json or from your global config. A global
         playbook with the same name replaces the repo one wholesale.
edit     open the global config in $VISUAL, $EDITOR, or your platform's default,
         then validate and reload it. An invalid config is read as empty, so you
         are offered another pass rather than left with one.

A GUI editor must be told to wait, or the reload fires before you have saved:
set EDITOR="code -w" (or "subl -w", "gedit -w", …).`,
  reload: `rmux reload

Re-reads the global config and every repo's .run-mux.json. Nothing watches files
by design. A target that is already running keeps the definition it started
with until you restart it.`,
  daemon: `rmux daemon status | stop | restart

status  is the daemon up, since when, and how many targets it holds
stop    ask it to exit; its processes are daemon-scoped, so they go with it
restart stop it and start a fresh one

status and stop never start a daemon. Every other verb does, automatically.`,
  help: USAGE,
};

/** Resolves to the process exit code, which only the TUI ever makes non-zero. */
async function route(ctx: Ctx): Promise<number> {
  const args = ctx.args;

  if (args.flags.version === true || args.flags.v === true) {
    emit(ctx.out, { version: VERSION });
    human(ctx.out, VERSION);
    return 0;
  }

  if (args.command[0] === 'help' || args.flags.help === true || args.flags.h === true) {
    const topic = args.command[0] === 'help' ? args.positionals[0] : args.command[0];
    showHelp(ctx.out, topic);
    return 0;
  }

  const verb = args.command[0];
  // The TUI opens its own daemon connection, so nothing is autospawned here.
  if (verb === undefined) return await launchTui();

  const entry = VERBS[verb];
  if (entry === undefined) {
    throw new CliError(
      'unknown_method',
      `unknown command: ${verb} — run \`rmux --help\` for the list`,
    );
  }
  if (typeof entry === 'function') {
    await entry(ctx);
    return 0;
  }

  const raw = args.command[1];
  const choices = Object.keys(entry).join(' | ');
  if (raw === undefined) {
    throw new CliError('bad_params', `${verb} needs a subcommand: ${choices}`);
  }
  const handler = entry[SUB_ALIASES[raw] ?? raw];
  if (handler === undefined) {
    throw new CliError('unknown_method', `unknown ${verb} subcommand: ${raw} — try ${choices}`);
  }
  await handler(ctx);
  return 0;
}

function showHelp(out: Out, topic: string | undefined): void {
  const text = topic === undefined ? USAGE : (TOPICS[topic] ?? USAGE);
  if (topic !== undefined && TOPICS[topic] === undefined) {
    diag(`note: no help topic for ${topic}`);
  }
  emit(out, { help: { topic: topic ?? null, text } });
  for (const line of text.split('\n')) human(out, line);
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (isRpcFailure(error)) return new CliError(error.code, error.message, error.data);
  if (error instanceof Error) return new CliError('internal', error.message);
  return new CliError('internal', String(error));
}

/**
 * Each role reaches its module through a dynamic import, so an ordinary verb —
 * `--version` above all — never loads a line of daemon or TUI code.
 */
async function runRole(role: Role): Promise<void> {
  if (role === DAEMON_ROLE) {
    const { runDaemon } = await import('../daemon/index.js');
    await runDaemon();
    return;
  }
  const { runTui } = await import('../tui/index.js');
  await runTui();
}

async function main(): Promise<number> {
  // Roles are dispatched before argv is parsed: they are how the binary re-execs
  // itself, not commands, and must never collide with a verb.
  const role = process.argv[2];
  if (isRole(role)) {
    await runRole(role);
    return 0;
  }

  const args = parseArgs(process.argv.slice(2));
  const out = makeOut(args.json, args.flags['no-color'] === true);
  const session = makeSession(args, out);
  try {
    return await route(session);
  } catch (error) {
    return reportError(out, toCliError(error));
  } finally {
    await session.dispose();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    diag(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_CODES.internal;
  },
);
