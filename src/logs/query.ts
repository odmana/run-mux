import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

import type { LogEntry, LogQuery } from '../types.js';
import { activeRun, latestRun, logPath, subscribeLive, type LiveEvent } from './store.js';
import { matchesQuery } from './tail.js';

/** A run id, or `'latest'` for the newest run of the target. */
export type RunSelector = string | 'latest';

export type FollowUnsubscribe = () => void;

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<LogEntry>;
  return (
    typeof e.ts === 'number' &&
    typeof e.label === 'string' &&
    typeof e.text === 'string' &&
    (e.stream === 'stdout' || e.stream === 'stderr')
  );
}

/**
 * Streams a JSONL log line by line. A line that does not parse into a LogEntry
 * is skipped rather than thrown on — the daemon can be killed mid-write, which
 * leaves a torn final line behind.
 */
export async function* readEntries(file: string): AsyncGenerator<LogEntry> {
  for await (const { entry } of readIndexedEntries(file)) yield entry;
}

/**
 * As `readEntries`, but carrying each entry's line index. The store writes one
 * line per append, so that index is the entry's sequence number within the run
 * — which is what lets `follow` line the JSONL up against live entries. It
 * counts skipped lines too, so a torn line cannot shift the numbering.
 */
export async function* readIndexedEntries(
  file: string,
): AsyncGenerator<{ index: number; entry: LogEntry }> {
  if (!existsSync(file)) return;
  const input = createReadStream(file, { encoding: 'utf-8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let index = -1;
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      index++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isLogEntry(parsed)) yield { index, entry: parsed };
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Reads a run's log back, applying `label`, then `since`, then `tail`. Memory
 * stays bounded by `tail` when one is given; the file is never slurped whole.
 */
export async function query(
  targetSlug: string,
  run: RunSelector,
  q: LogQuery = {},
): Promise<LogEntry[]> {
  const runId = run === 'latest' ? latestRun(targetSlug) : run;
  if (!runId) return [];

  // An open run keeps recent lines buffered in memory, so make them durable
  // before reading or the newest entries would be missing.
  const handle = activeRun(targetSlug);
  if (handle && handle.runId === runId) await handle.flush();

  const out: LogEntry[] = [];
  for await (const entry of readEntries(logPath(targetSlug, runId))) {
    if (!matchesQuery(entry, q)) continue;
    out.push(entry);
    if (q.tail !== undefined && out.length > q.tail) out.shift();
  }
  return out;
}

/**
 * Replays matching history and then streams live entries, with no gap and no
 * duplicate between the two.
 *
 * The subscription is registered first, in the same tick as the read of the
 * open run's `appendCount`. That count is the cut: everything before it is
 * already on disk and gets replayed from the JSONL, everything from it onward
 * is guaranteed to reach the live subscription, which buffers until the replay
 * has finished. Nothing can be appended between the two halves.
 */
export function follow(
  targetSlug: string,
  q: LogQuery,
  onEntry: (entry: LogEntry) => void,
): FollowUnsubscribe {
  let stopped = false;
  let replaying = true;
  const buffered: LiveEvent[] = [];

  const unsubscribe = subscribeLive(targetSlug, (event) => {
    if (stopped) return;
    if (replaying) buffered.push(event);
    else if (matchesQuery(event.entry, q)) onEntry(event.entry);
  });

  const handle = activeRun(targetSlug);
  // Read synchronously, right after subscribing: no await may run in between or
  // an entry could slip past both halves.
  const cut = handle ? handle.appendCount : Infinity;
  const runId = handle?.runId ?? latestRun(targetSlug);

  void (async () => {
    try {
      if (handle) await handle.flush();
      if (runId) {
        const backlog: LogEntry[] = [];
        for await (const { index, entry } of readIndexedEntries(logPath(targetSlug, runId))) {
          if (index >= cut) break;
          if (!matchesQuery(entry, q)) continue;
          backlog.push(entry);
          if (q.tail !== undefined && backlog.length > q.tail) backlog.shift();
        }
        for (const entry of backlog) {
          if (stopped) return;
          onEntry(entry);
        }
      }
    } catch {
      /* an unreadable run just means there is no backlog */
    }
    if (stopped) return;
    // Drain by shifting so an entry appended from inside onEntry still lands in
    // order, then switch to live delivery.
    for (;;) {
      const event = buffered.shift();
      if (!event) break;
      if (stopped) return;
      if (event.runId === runId && event.seq < cut) continue;
      if (matchesQuery(event.entry, q)) onEntry(event.entry);
    }
    replaying = false;
  })();

  return () => {
    stopped = true;
    unsubscribe();
  };
}
