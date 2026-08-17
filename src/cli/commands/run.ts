/** `rmux start`, `rmux stop`, `rmux restart`, `rmux status`. */

import { METHODS, type RunResult } from '../../protocol.js';
import { flagString } from '../args.js';
import { emit, human } from '../output.js';
import { renderTargetDetail } from '../render.js';
import { call, type Ctx } from './daemon.js';
import { targetArg } from './target.js';

export async function start(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'start');
  const result = await call<RunResult>(ctx, METHODS.runStart, { target });
  report(ctx, result, `starting ${result.target.slug}`);
}

export async function stop(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'stop');
  const result = await call<RunResult>(ctx, METHODS.runStop, { target });
  report(ctx, result, `stopped ${result.target.slug}`);
}

export async function restart(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'restart');
  const command = flagString(ctx.args, 'command');
  const result = await call<RunResult>(ctx, METHODS.runRestart, { target, command });
  report(
    ctx,
    result,
    command === undefined
      ? `restarting ${result.target.slug}`
      : `restarting ${command} in ${result.target.slug}`,
  );
}

export async function status(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'status');
  const result = await call<RunResult>(ctx, METHODS.runStatus, { target });
  emit(ctx.out, { target: result.target });
  for (const line of renderTargetDetail(ctx.out, result.target)) human(ctx.out, line);
}

function report(ctx: Ctx, result: RunResult, headline: string): void {
  emit(ctx.out, { target: result.target });
  human(ctx.out, headline);
  human(ctx.out, '');
  for (const line of renderTargetDetail(ctx.out, result.target)) human(ctx.out, line);
}
