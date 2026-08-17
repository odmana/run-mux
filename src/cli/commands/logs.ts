/** `rmux logs`, the streaming primitive. */

import {
  METHODS,
  type LogsFollowParams,
  type LogsQueryParams,
  type LogsQueryResult,
} from '../../protocol.js';
import type { LogEntry } from '../../types.js';
import { flagNumber, flagString, parseSince } from '../args.js';
import { CliError, diag, emit, emitLine, human } from '../output.js';
import { renderLogEntry } from '../render.js';
import { call, type Ctx } from './daemon.js';
import { targetArg } from './target.js';

export async function logs(ctx: Ctx): Promise<void> {
  const target = targetArg(ctx, 'logs');
  const label = flagString(ctx.args, 'label');
  const since = readSince(ctx);
  const tail = readTail(ctx);
  const runId = flagString(ctx.args, 'run');
  const follow = ctx.args.flags.follow === true;

  let cursor = since;
  // A follow needs a query first only to honour --tail; without it the daemon
  // replays from `since` itself, which is what makes a follow resumable.
  if (!follow || tail !== undefined) {
    const params: LogsQueryParams = { target, label, since, tail, runId };
    const result = await call<LogsQueryResult>(ctx, METHODS.logsQuery, params);
    emit(ctx.out, { type: 'meta', runId: result.runId, runs: result.runs });
    for (const entry of result.entries) {
      write(ctx, entry);
      cursor = entry.ts;
    }
    if (result.entries.length === 0) diag('note: no log entries matched');
  }

  if (follow) await streamLogs(ctx, { target, label, since: cursor });
}

async function streamLogs(ctx: Ctx, params: LogsFollowParams): Promise<void> {
  const client = await ctx.client();
  let settle!: (failure?: CliError) => void;
  const finished = new Promise<CliError | undefined>((resolve) => {
    settle = resolve;
  });

  const unsubscribe = await client.subscribe(
    METHODS.logsFollow,
    params,
    (data) => write(ctx, data as LogEntry),
    {
      onEnd: () => settle(undefined),
      onError: (error) => settle(new CliError(error.code, error.message)),
    },
  );

  // Ctrl-C ends the stream rather than killing the process, so the closing
  // NDJSON frame still gets written for whoever is parsing us.
  const interrupt = (): void => settle(undefined);
  process.once('SIGINT', interrupt);
  try {
    const failure = await finished;
    if (failure) throw failure;
  } finally {
    process.off('SIGINT', interrupt);
    unsubscribe();
  }
  emit(ctx.out, { type: 'end' });
}

function write(ctx: Ctx, entry: LogEntry): void {
  emitLine(ctx.out, {
    type: 'log',
    ts: entry.ts,
    label: entry.label,
    stream: entry.stream,
    text: entry.text,
  });
  human(ctx.out, renderLogEntry(ctx.out, entry));
}

function readSince(ctx: Ctx): number | undefined {
  if (ctx.args.flags.since === undefined) return undefined;
  const raw = flagString(ctx.args, 'since');
  if (raw === undefined)
    throw new CliError('bad_params', '--since needs a value, e.g. `--since 5m`');
  const parsed = parseSince(raw);
  if (parsed === null) {
    throw new CliError(
      'bad_params',
      `could not read --since ${raw}; use a duration like 5m, 90s, 2h, 1d or an ISO timestamp`,
    );
  }
  return parsed;
}

function readTail(ctx: Ctx): number | undefined {
  if (ctx.args.flags.tail === undefined) return undefined;
  const value = flagNumber(ctx.args, 'tail');
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new CliError('bad_params', '--tail needs a whole number of entries, e.g. `--tail 200`');
  }
  return value;
}
