/** `rmux config resolve`, `rmux reload`, `rmux env`. */

import {
  METHODS,
  type ConfigReloadResult,
  type ConfigResolveResult,
  type EnvResolveResult,
} from '../../protocol.js';
import { flagString } from '../args.js';
import { diag, emit, human, paint } from '../output.js';
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
  emit(ctx.out, { problems: result.problems, stale: result.stale });
  for (const problem of result.problems) diag(`warning: ${problem}`);
  human(ctx.out, 'reloaded the run-mux config');
  if (result.stale.length > 0) {
    human(
      ctx.out,
      `${result.stale.length} running target(s) still hold the old definition; restart to pick up the change:`,
    );
    for (const slug of result.stale) human(ctx.out, `  ${slug}`);
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
