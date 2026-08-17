/** `rmux repo add`, `rmux repo ls`, `rmux repo rm`. */

import {
  METHODS,
  type RepoAddResult,
  type RepoListResult,
  type RepoRemoveResult,
} from '../../protocol.js';
import { CliError, diag, emit, human } from '../output.js';
import { renderRepos } from '../render.js';
import { call, type Ctx } from './daemon.js';
import { absolutePath } from './target.js';

function pathArg(ctx: Ctx, verb: string): string {
  const value = ctx.args.positionals[0];
  if (value === undefined || value === '') {
    throw new CliError('bad_params', `repo ${verb} needs a path, e.g. \`rmux repo ${verb} .\``);
  }
  return absolutePath(value);
}

export async function add(ctx: Ctx): Promise<void> {
  const path = pathArg(ctx, 'add');
  const { repo } = await call<RepoAddResult>(ctx, METHODS.repoAdd, { path });
  emit(ctx.out, { repo });
  for (const problem of repo.problems) diag(`warning: ${problem}`);
  human(ctx.out, `registered ${repo.name}  ${repo.path}`);
  human(ctx.out, '');
  for (const line of renderRepos(ctx.out, [repo])) human(ctx.out, line);
}

export async function list(ctx: Ctx): Promise<void> {
  const { repos } = await call<RepoListResult>(ctx, METHODS.repoList);
  emit(ctx.out, { repos });
  for (const line of renderRepos(ctx.out, repos)) human(ctx.out, line);
}

export async function remove(ctx: Ctx): Promise<void> {
  const path = pathArg(ctx, 'rm');
  const result = await call<RepoRemoveResult>(ctx, METHODS.repoRemove, { path });
  emit(ctx.out, { removed: result.removed, path });
  human(ctx.out, result.removed ? `unregistered ${path}` : `${path} was not registered`);
}
