/** `rmux ls`, `rmux add`, `rmux rm`. */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { normalize } from '../../paths.js';
import {
  METHODS,
  type CheckoutListResult,
  type RepoListResult,
  type TargetAddParams,
  type TargetAddResult,
  type TargetListResult,
  type TargetRemoveResult,
  type TargetUpdateResult,
} from '../../protocol.js';
import { flagString } from '../args.js';
import { CliError, diag, emit, human } from '../output.js';
import { renderTargetDetail, renderTargets } from '../render.js';
import { call, type Ctx } from './daemon.js';

/** Every target-addressed verb reads its argument the same way. */
export function targetArg(ctx: Ctx, verb: string): string {
  const value = ctx.args.positionals[0];
  if (value === undefined || value === '') {
    throw new CliError(
      'bad_params',
      `${verb} needs a target — a slug, an alias, or an unambiguous prefix, e.g. \`rmux ${verb} orders/main\``,
    );
  }
  return value;
}

export function absolutePath(input: string): string {
  const expanded =
    input === '~' || input.startsWith('~/') || input.startsWith('~\\')
      ? resolve(homedir(), input.slice(2))
      : input;
  return normalize(resolve(expanded));
}

export async function list(ctx: Ctx): Promise<void> {
  const { targets } = await call<TargetListResult>(ctx, METHODS.targetList);
  emit(ctx.out, { targets });
  for (const line of renderTargets(ctx.out, targets)) human(ctx.out, line);
}

export async function add(ctx: Ctx): Promise<void> {
  const repo = flagString(ctx.args, 'repo') ?? ctx.args.positionals[0];
  const checkout = flagString(ctx.args, 'checkout') ?? ctx.args.positionals[1];
  const playbook = flagString(ctx.args, 'playbook') ?? ctx.args.positionals[2];

  const params =
    repo === undefined ? await pick(ctx) : await complete(ctx, repo, checkout, playbook);

  const { target } = await call<TargetAddResult>(ctx, METHODS.targetAdd, params);
  emit(ctx.out, { target });
  human(ctx.out, `added ${target.slug}`);
  for (const line of renderTargetDetail(ctx.out, target)) human(ctx.out, line);
}

export async function remove(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'rm');
  const result = await call<TargetRemoveResult>(ctx, METHODS.targetRemove, { target });
  emit(ctx.out, { removed: result.removed, slug: result.slug });
  human(
    ctx.out,
    result.removed ? `removed ${result.slug}` : `no target matched ${target}; nothing removed`,
  );
}

export async function autostart(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'autostart');
  const enabled = ctx.args.flags.off !== true;
  const result = await call<TargetUpdateResult>(ctx, METHODS.targetUpdate, {
    target,
    autostart: enabled,
  });
  emit(ctx.out, { target: result.target });
  human(
    ctx.out,
    result.target.autostart
      ? `${result.target.slug} will start with the daemon`
      : `${result.target.slug} will no longer start with the daemon`,
  );
}

/** Fills in whatever the caller left out, so `rmux add <repo>` usually does. */
async function complete(
  ctx: Ctx,
  repoInput: string,
  checkoutInput: string | undefined,
  playbookInput: string | undefined,
): Promise<TargetAddParams> {
  const repoPath = absolutePath(repoInput);
  const listing = await call<CheckoutListResult>(ctx, METHODS.checkoutList, { repoPath });

  const checkoutPath = checkoutInput
    ? absolutePath(checkoutInput)
    : (listing.checkouts.find((c) => c.isMain) ?? listing.checkouts[0])?.path;
  if (checkoutPath === undefined) {
    throw new CliError('not_found', `no checkouts found under ${repoPath}`);
  }

  if (playbookInput !== undefined) {
    return { repoPath, checkoutPath, playbookName: playbookInput };
  }
  if (listing.playbooks.length === 0) {
    throw new CliError(
      'not_found',
      `${repoPath} defines no playbooks; add one to its .run-mux.json or to your global config`,
    );
  }
  if (listing.playbooks.length === 1) {
    return { repoPath, checkoutPath, playbookName: listing.playbooks[0].name };
  }
  throw new CliError('bad_params', `${repoPath} offers several playbooks; pass --playbook <name>`, {
    matches: listing.playbooks.map((p) => p.name),
  });
}

/**
 * The interactive picker. Deliberately thin, and never reached without a TTY —
 * a script that calls `rmux add` bare gets told to pass arguments rather than
 * hanging on a prompt nobody is there to answer.
 */
async function pick(ctx: Ctx): Promise<TargetAddParams> {
  if (ctx.out.json || process.stdin.isTTY !== true) {
    throw new CliError(
      'bad_params',
      'rmux add is interactive without arguments; pass `--repo <path> [--checkout <path>] [--playbook <name>]` instead',
    );
  }

  const { repos } = await call<RepoListResult>(ctx, METHODS.repoList);
  if (repos.length === 0) {
    throw new CliError('not_found', 'no repos registered — run `rmux repo add <path>` first');
  }

  // The prompt is a dialogue, not output: it belongs on stderr either way.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const repo = await choose(rl, 'repo', repos, (r) => `${r.name}  ${r.path}`);
    const listing = await call<CheckoutListResult>(ctx, METHODS.checkoutList, {
      repoPath: repo.path,
    });
    if (listing.checkouts.length === 0) {
      throw new CliError('not_found', `no checkouts found under ${repo.path}`);
    }
    if (listing.playbooks.length === 0) {
      throw new CliError('not_found', `${repo.path} defines no playbooks`);
    }
    const checkout = await choose(
      rl,
      'checkout',
      listing.checkouts,
      (c) => `${c.branch}${c.isMain ? ' (main)' : ''}  ${c.path}`,
    );
    const playbook = await choose(
      rl,
      'playbook',
      listing.playbooks,
      (p) => `${p.name}  (${p.source})`,
    );
    return { repoPath: repo.path, checkoutPath: checkout.path, playbookName: playbook.name };
  } finally {
    rl.close();
  }
}

async function choose<T>(
  rl: { question: (prompt: string) => Promise<string> },
  what: string,
  items: T[],
  render: (item: T) => string,
): Promise<T> {
  if (items.length === 1) return items[0];
  diag(`\n${what}:`);
  items.forEach((item, index) => diag(`  ${index + 1})  ${render(item)}`));
  const answer = (await rl.question(`${what} [1-${items.length}]: `)).trim();
  const index = Number.parseInt(answer, 10);
  if (!Number.isInteger(index) || index < 1 || index > items.length) {
    throw new CliError('bad_params', `not a ${what} on the list: ${answer || '(nothing)'}`);
  }
  return items[index - 1];
}
