/** `rmux config resolve`, `rmux config edit`, `rmux reload`, `rmux env`. */

import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { createInterface } from 'node:readline/promises';

// The only place the CLI reaches into `config/`: it must be able to create and
// validate the file with no daemon running. Resolving playbooks and writing
// config stay daemon-side.
import { ensureGlobalConfig, loadGlobalConfig } from '../../config/index.js';
import { tryConnect } from '../../ipc/index.js';
import {
  METHODS,
  type ConfigReloadResult,
  type ConfigResolveResult,
  type EnvResolveResult,
} from '../../protocol.js';
import { flagString } from '../args.js';
import { CliError, diag, emit, human, paint, type Out } from '../output.js';
import { renderEnv, renderPlaybook } from '../render.js';
import { call, type Ctx } from './daemon.js';
import { targetArg } from './target.js';

export async function resolve(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'config resolve');
  const result = await call<ConfigResolveResult>(ctx, METHODS.configResolve, { target });
  emit(ctx.out, {
    playbook: result.playbook,
    source: result.source,
    repoPath: result.repoPath,
    problems: result.problems,
  });
  for (const problem of result.problems) diag(`warning: ${problem}`);
  human(
    ctx.out,
    `${paint(ctx.out, 'bold', result.playbook.name)}  ${paint(ctx.out, 'dim', `from the ${result.source} config`)}`,
  );
  human(ctx.out, paint(ctx.out, 'dim', `  ${result.repoPath}`));
  human(ctx.out, '');
  for (const line of renderPlaybook(ctx.out, result.playbook)) human(ctx.out, line);
}

export async function reload(ctx: Ctx): Promise<void> {
  const result = await call<ConfigReloadResult>(ctx, METHODS.configReload);
  reportReload(ctx.out, result);
}

/** Shared so `reload` and `config edit` cannot drift on the stale-target message. */
function reportReload(out: Out, result: ConfigReloadResult): void {
  emit(out, { problems: result.problems, stale: result.stale });
  for (const problem of result.problems) diag(`warning: ${problem}`);
  human(out, 'reloaded the run-mux config');
  if (result.stale.length > 0) {
    human(
      out,
      `${result.stale.length} running target(s) still hold the old definition; restart to pick up the change:`,
    );
    for (const slug of result.stale) human(out, `  ${slug}`);
  }
}

/**
 * Opens the global config in $EDITOR and reloads when it closes.
 *
 * A parse failure leaves `loadGlobalConfig` returning an *empty* config plus a
 * problem, so a stray comma silently unregisters every repo. Hand-editing is
 * where that bites, so the file is validated here and the user is offered
 * another pass rather than being left with a live, broken config.
 */
export async function edit(ctx: Ctx): Promise<void> {
  if (ctx.out.json) {
    throw new CliError('bad_params', 'config edit is interactive; it has no --json form');
  }
  if (process.stdin.isTTY !== true) {
    throw new CliError('bad_params', 'config edit needs a terminal');
  }

  const path = ensureGlobalConfig();
  const editor = resolveEditor();

  for (;;) {
    launchEditor(editor, path);
    const { problems } = loadGlobalConfig();
    if (problems.length === 0) break;

    for (const problem of problems) diag(`warning: ${problem}`);
    diag('the config is invalid, so run-mux is reading it as empty.');
    if (!(await confirm('reopen the editor?'))) {
      throw new CliError('invalid_config', `left ${path} in an invalid state`);
    }
  }

  // Never autospawn: a daemon started here would load the config anyway, and
  // starting one just to tell it to re-read a file it never had is noise.
  const client = await tryConnect();
  if (!client) {
    human(ctx.out, `saved ${path}`);
    diag('note: the daemon is not running, so there was nothing to reload');
    return;
  }
  try {
    const result = (await client.request(METHODS.configReload)) as ConfigReloadResult;
    human(ctx.out, `saved ${path}`);
    reportReload(ctx.out, result);
  } finally {
    await client.close().catch(() => {});
  }
}

/** `$VISUAL`, then `$EDITOR`, then whatever the platform is certain to have. */
function resolveEditor(): { command: string; args: string[]; source: string } {
  const fromEnv = process.env.VISUAL ?? process.env.EDITOR;
  const source = process.env.VISUAL ? '$VISUAL' : process.env.EDITOR ? '$EDITOR' : 'the default';
  const raw = fromEnv?.trim() || (platform() === 'win32' ? 'notepad' : 'vi');
  const [command = raw, ...args] = tokenize(raw);
  return { command, args, source };
}

/**
 * The editor variable is a command line, not a bare path, so `EDITOR="code -w"`
 * works — and quoted segments survive, because the usual Windows editor lives
 * under a path with a space in it.
 */
function tokenize(input: string): string[] {
  const parts = input.match(/"[^"]*"|\S+/g) ?? [];
  return parts.map((part) => part.replace(/^"|"$/g, ''));
}

function launchEditor(editor: { command: string; args: string[]; source: string }, path: string) {
  // env is passed explicitly, as everywhere else we spawn: Bun does not hand a
  // child the mutations made to `process.env` after start.
  const result = spawnSync(editor.command, [...editor.args, path], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error !== undefined) {
    throw new CliError(
      'not_found',
      `could not run "${editor.command}" (from ${editor.source}): ${result.error.message}`,
    );
  }
  if (result.status !== 0 && result.status !== null) {
    throw new CliError(
      'unavailable',
      `${editor.command} exited ${result.status}; nothing reloaded`,
    );
  }
}

/** The prompt is a dialogue, not output: stderr, like every other CLI prompt. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [Y/n]: `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function env(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'env');
  const command = flagString(ctx.args, 'command');
  const result = await call<EnvResolveResult>(ctx, METHODS.envResolve, { target, command });
  emit(ctx.out, { vars: result.vars, problems: result.problems });
  for (const problem of result.problems) diag(`warning: ${problem}`);
  if (command === undefined) {
    diag('note: without --command <label> only the run-wide and injected layers resolve');
  }
  for (const line of renderEnv(ctx.out, result.vars)) human(ctx.out, line);
}
