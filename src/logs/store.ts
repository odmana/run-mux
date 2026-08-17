import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { normalize, runDir, runsDir, slugToDirName } from '../paths.js';
import type { LogEntry, LogQuery, Playbook, RunMeta } from '../types.js';
import { LogTail } from './tail.js';

/** Runs kept on disk per target. Older ones are pruned when a run is created. */
export const RUNS_KEPT_PER_TARGET = 10;

/** Buffered bytes that force a write without waiting for the scheduled flush. */
const FLUSH_THRESHOLD_BYTES = 64 * 1024;

export const META_FILENAME = 'meta.json';
export const LOG_FILENAME = 'log.jsonl';

export interface RunHandle {
  readonly runId: string;
  readonly targetSlug: string;
  readonly dir: string;
  readonly meta: RunMeta;
  /** Entries appended so far. Doubles as the next entry's sequence number. */
  readonly appendCount: number;
  readonly closed: boolean;
  append: (entry: LogEntry) => void;
  snapshot: (query?: LogQuery) => LogEntry[];
  flush: () => Promise<void>;
  finishRun: (exitSummary?: Record<string, number>) => Promise<void>;
}

export interface LiveEvent {
  runId: string;
  targetSlug: string;
  /** 0-based index of this entry within its run, matching its line in the JSONL. */
  seq: number;
  entry: LogEntry;
}

export type LiveListener = (event: LiveEvent) => void;

const openRuns = new Map<string, RunHandle>();
const openRunIds = new Map<string, Set<string>>();
const listeners = new Map<string, Set<LiveListener>>();

export function targetDir(targetSlug: string): string {
  return normalize(join(runsDir(), slugToDirName(targetSlug)));
}

export function logPath(targetSlug: string, runId: string): string {
  return normalize(join(runDir(targetSlug, runId), LOG_FILENAME));
}

export function metaPath(targetSlug: string, runId: string): string {
  return normalize(join(runDir(targetSlug, runId), META_FILENAME));
}

let lastStampMs = 0;
let sameMsCounter = 0;

/**
 * Sorts lexicographically in creation order: a fixed-width UTC stamp, then a
 * counter that breaks ties inside one millisecond, then random bytes so two
 * daemons starting a run in the same millisecond cannot collide.
 */
export function newRunId(now: number = Date.now()): string {
  const ms = Math.max(now, lastStampMs);
  if (ms === lastStampMs) sameMsCounter++;
  else {
    lastStampMs = ms;
    sameMsCounter = 0;
  }
  const stamp = new Date(ms).toISOString().replaceAll(/[-:.]/g, '');
  return `${stamp}-${sameMsCounter.toString(36).padStart(3, '0')}-${randomBytes(2).toString('hex')}`;
}

/** The open handle for a target, if a run is currently in progress. */
export function activeRun(targetSlug: string): RunHandle | undefined {
  return openRuns.get(targetSlug);
}

/** Every entry appended for this target, whatever run it belongs to. */
export function subscribeLive(targetSlug: string, listener: LiveListener): () => void {
  let set = listeners.get(targetSlug);
  if (!set) {
    set = new Set();
    listeners.set(targetSlug, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(targetSlug);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(targetSlug);
  };
}

function emit(event: LiveEvent): void {
  const set = listeners.get(event.targetSlug);
  if (!set || set.size === 0) return;
  // Copy so a subscriber unsubscribing from its own callback is safe, and
  // swallow throws so one bad subscriber cannot break logging for the rest.
  const current = [...set];
  for (const listener of current) {
    try {
      listener(event);
    } catch {
      /* subscriber's problem */
    }
  }
}

export function createRun(targetSlug: string, playbook: Playbook): RunHandle {
  const startedAt = Date.now();
  const runId = newRunId(startedAt);
  const dir = runDir(targetSlug, runId);
  mkdirSync(dir, { recursive: true });

  const meta: RunMeta = {
    runId,
    targetSlug,
    playbookSnapshot: structuredClone(playbook),
    startedAt,
  };
  const metaFile = metaPath(targetSlug, runId);
  const logFile = logPath(targetSlug, runId);
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  const stream = createWriteStream(logFile, { flags: 'a' });
  // A failed write must not take the daemon down with an unhandled 'error'.
  stream.on('error', () => {});

  const tail = new LogTail();
  const pending: string[] = [];
  let pendingBytes = 0;
  let scheduled = false;
  let appendCount = 0;
  let closed = false;
  let ended = false;
  let writeQueue: Promise<void> = Promise.resolve();
  // Chunks that arrive after the run was finished. Held until the stream has
  // actually closed so a straggler cannot overtake the last buffered lines.
  const stragglers: string[] = [];

  const writeDirect = (chunk: string): void => {
    try {
      appendFileSync(logFile, chunk);
    } catch {
      /* the run directory may already have been pruned */
    }
  };

  const writePending = (): void => {
    if (pending.length === 0) return;
    const chunk = pending.join('');
    pending.length = 0;
    pendingBytes = 0;
    // Writes complete in queue order, so awaiting the newest one is enough to
    // know every earlier line has landed.
    writeQueue = new Promise<void>((resolve) => {
      stream.write(chunk, () => resolve());
    });
  };

  const scheduleFlush = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      writePending();
    });
  };

  const handle: RunHandle = {
    runId,
    targetSlug,
    dir,
    meta,
    get appendCount() {
      return appendCount;
    },
    get closed() {
      return closed;
    },

    append(entry: LogEntry): void {
      tail.push(entry);
      const seq = appendCount++;
      const line = `${JSON.stringify(entry)}\n`;
      if (closed) {
        // A straggler chunk after the run was finished. Rare enough that a
        // direct write beats keeping the stream open for it.
        if (ended) writeDirect(line);
        else stragglers.push(line);
      } else {
        pending.push(line);
        pendingBytes += line.length;
        if (pendingBytes >= FLUSH_THRESHOLD_BYTES) writePending();
        else scheduleFlush();
      }
      emit({ runId, targetSlug, seq, entry });
    },

    snapshot(query: LogQuery = {}): LogEntry[] {
      return tail.snapshot(query);
    },

    async flush(): Promise<void> {
      writePending();
      await writeQueue;
    },

    async finishRun(exitSummary?: Record<string, number>): Promise<void> {
      if (closed) return;
      closed = true;
      meta.endedAt = Date.now();
      if (exitSummary) meta.exitSummary = exitSummary;
      writeFileSync(metaFile, JSON.stringify(meta, null, 2));
      writePending();
      await new Promise<void>((resolve) => stream.end(resolve));
      ended = true;
      if (stragglers.length > 0) {
        writeDirect(stragglers.join(''));
        stragglers.length = 0;
      }
      if (openRuns.get(targetSlug) === handle) openRuns.delete(targetSlug);
      openRunIds.get(targetSlug)?.delete(runId);
    },
  };

  openRuns.set(targetSlug, handle);
  let open = openRunIds.get(targetSlug);
  if (!open) {
    open = new Set();
    openRunIds.set(targetSlug, open);
  }
  open.add(runId);

  pruneRuns(targetSlug);
  return handle;
}

/** Run ids for a target, newest first. */
export function listRunIds(targetSlug: string): string[] {
  const dir = targetDir(targetSlug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

export function latestRun(targetSlug: string): string | null {
  return listRunIds(targetSlug)[0] ?? null;
}

export function readRunMeta(targetSlug: string, runId: string): RunMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(targetSlug, runId), 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

/** Metadata for every run of a target, newest first. */
export function listRuns(targetSlug: string): RunMeta[] {
  const metas: RunMeta[] = [];
  for (const runId of listRunIds(targetSlug)) {
    const meta = readRunMeta(targetSlug, runId);
    if (meta) metas.push(meta);
  }
  return metas;
}

function pruneRuns(targetSlug: string): void {
  const open = openRunIds.get(targetSlug);
  for (const runId of listRunIds(targetSlug).slice(RUNS_KEPT_PER_TARGET)) {
    if (open?.has(runId)) continue;
    try {
      rmSync(runDir(targetSlug, runId), { recursive: true, force: true });
    } catch {
      /* a locked directory just survives until the next prune */
    }
  }
}
