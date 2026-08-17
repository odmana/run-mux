import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRun,
  follow,
  latestRun,
  listRunIds,
  listRuns,
  logPath,
  query,
  LogTail,
  RUNS_KEPT_PER_TARGET,
  TAIL_LIMIT_PER_LABEL,
  type RunHandle,
} from '../src/logs/index.js';
import { runDir } from '../src/paths.js';
import type { LogEntry, Playbook } from '../src/types.js';
import { chatty, useTempHome, waitFor, type TempHome } from './helpers.js';

const SLUG = 'my-repo/feature-a:dev';

const PLAYBOOK: Playbook = {
  name: 'dev',
  commands: [
    { label: 'web', command: 'noop' },
    { label: 'api', command: 'noop', type: 'task' },
  ],
};

let home: TempHome;
let clock = 1_700_000_000_000;
const opened: RunHandle[] = [];

function line(label: string, text: string, ts?: number): LogEntry {
  return { ts: ts ?? clock++, label, stream: 'stdout', text };
}

function startRun(slug = SLUG): RunHandle {
  const handle = createRun(slug, PLAYBOOK);
  opened.push(handle);
  return handle;
}

beforeEach(() => {
  home = useTempHome();
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of opened) await handle.finishRun();
  opened.length = 0;
  home.cleanup();
});

describe('run store', () => {
  it('round-trips entries through JSONL with ANSI escapes byte-identical', async () => {
    const run = startRun();
    const ansi =
      '\u001b[31mred\u001b[0m \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\r\n';
    run.append({ ts: 41, label: 'web', stream: 'stdout', text: ansi });
    run.append({ ts: 42, label: 'api', stream: 'stderr', text: 'plain\n' });
    await run.finishRun({ web: 0, api: 1 });

    const raw = readFileSync(logPath(SLUG, run.runId), 'utf-8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);

    const entries = await query(SLUG, run.runId);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe(ansi);
    expect(Buffer.from(entries[0].text, 'utf-8').equals(Buffer.from(ansi, 'utf-8'))).toBe(true);
    expect(entries[1]).toEqual({ ts: 42, label: 'api', stream: 'stderr', text: 'plain\n' });

    const meta = listRuns(SLUG)[0];
    expect(meta.runId).toBe(run.runId);
    expect(meta.targetSlug).toBe(SLUG);
    expect(meta.playbookSnapshot).toEqual(PLAYBOOK);
    expect(meta.exitSummary).toEqual({ web: 0, api: 1 });
    expect(meta.endedAt).toBeGreaterThanOrEqual(meta.startedAt);
  });

  it('reads back entries that are still buffered in an open run', async () => {
    const run = startRun();
    run.append(line('web', 'buffered'));
    expect(await query(SLUG, 'latest')).toHaveLength(1);
    await run.finishRun();
  });

  it('still records a chunk that arrives after the run was finished', async () => {
    const run = startRun();
    run.append(line('web', 'during'));
    await run.finishRun();
    run.append(line('web', 'straggler'));

    const entries = await query(SLUG, run.runId);
    expect(entries.map((e) => e.text)).toEqual(['during', 'straggler']);
    expect(run.snapshot().map((e) => e.text)).toEqual(['during', 'straggler']);
  });

  it('snapshots the playbook so later mutation cannot rewrite history', async () => {
    const playbook: Playbook = { name: 'dev', commands: [{ label: 'web', command: 'noop' }] };
    const run = createRun(SLUG, playbook);
    opened.push(run);
    playbook.commands[0].label = 'changed';
    await run.finishRun();
    expect(listRuns(SLUG)[0].playbookSnapshot.commands[0].label).toBe('web');
  });
});

describe('in-memory tail', () => {
  it('trims each label independently so a chatty label cannot evict a quiet one', () => {
    const tail = new LogTail();
    const chunk = 'x'.repeat(4096);

    tail.push(line('quiet', 'q1'));
    for (let i = 0; i < 40; i++) tail.push(line('loud', chunk));
    tail.push(line('quiet', 'q2'));
    for (let i = 0; i < 40; i++) tail.push(line('loud', chunk));

    expect(tail.snapshot({ label: 'quiet' }).map((e) => e.text)).toEqual(['q1', 'q2']);
    expect(tail.snapshot({ label: 'loud' }).length).toBeGreaterThan(0);
    expect(tail.byteSize('loud')).toBeLessThanOrEqual(TAIL_LIMIT_PER_LABEL);
    expect(tail.byteSize('quiet')).toBe(4);

    const all = tail.snapshot();
    expect(all.filter((e) => e.label === 'quiet').map((e) => e.text)).toEqual(['q1', 'q2']);
    expect(all[0].text).toBe('q1');
    expect(all.at(-1)?.text).toBe(chunk);
  });

  it('keeps one entry per label even when a single chunk is larger than the budget', () => {
    const tail = new LogTail();
    tail.push(line('big', 'a'.repeat(TAIL_LIMIT_PER_LABEL * 3)));
    tail.push(line('big', 'b'.repeat(TAIL_LIMIT_PER_LABEL * 3)));

    const kept = tail.snapshot({ label: 'big' });
    expect(kept).toHaveLength(1);
    expect(kept[0].text.startsWith('b')).toBe(true);
  });

  it('trims the run handle tail while the JSONL keeps everything', async () => {
    const run = startRun();
    const chunk = 'x'.repeat(4096);
    run.append(line('quiet', 'q1'));
    for (let i = 0; i < 60; i++) run.append(line('loud', chunk));
    run.append(line('quiet', 'q2'));
    await run.finishRun();

    expect(run.snapshot({ label: 'quiet' }).map((e) => e.text)).toEqual(['q1', 'q2']);
    expect(run.snapshot({ label: 'loud' }).length).toBeLessThan(60);
    expect(run.snapshot({ label: 'loud' }).length).toBeGreaterThan(0);
    expect(await query(SLUG, 'latest')).toHaveLength(62);
  });

  it('applies label, since and tail to a snapshot', () => {
    const tail = new LogTail();
    tail.push({ ts: 10, label: 'web', stream: 'stdout', text: 'w1' });
    tail.push({ ts: 20, label: 'api', stream: 'stdout', text: 'a1' });
    tail.push({ ts: 30, label: 'web', stream: 'stdout', text: 'w2' });
    tail.push({ ts: 40, label: 'web', stream: 'stdout', text: 'w3' });

    expect(tail.snapshot({ label: 'web' }).map((e) => e.text)).toEqual(['w1', 'w2', 'w3']);
    expect(tail.snapshot({ since: 20 }).map((e) => e.text)).toEqual(['w2', 'w3']);
    expect(tail.snapshot({ tail: 2 }).map((e) => e.text)).toEqual(['w2', 'w3']);
    expect(tail.snapshot({ label: 'web', since: 10, tail: 1 }).map((e) => e.text)).toEqual(['w3']);
  });
});

describe('query', () => {
  async function seededRun(): Promise<RunHandle> {
    const run = startRun();
    run.append({ ts: 10, label: 'web', stream: 'stdout', text: 'w1' });
    run.append({ ts: 20, label: 'api', stream: 'stdout', text: 'a1' });
    run.append({ ts: 30, label: 'web', stream: 'stderr', text: 'w2' });
    run.append({ ts: 40, label: 'web', stream: 'stdout', text: 'w3' });
    run.append({ ts: 50, label: 'api', stream: 'stdout', text: 'a2' });
    await run.finishRun();
    return run;
  }

  it('filters by label', async () => {
    await seededRun();
    const entries = await query(SLUG, 'latest', { label: 'web' });
    expect(entries.map((e) => e.text)).toEqual(['w1', 'w2', 'w3']);
  });

  it('filters by since, exclusive of the given timestamp', async () => {
    await seededRun();
    expect((await query(SLUG, 'latest', { since: 30 })).map((e) => e.text)).toEqual(['w3', 'a2']);
    expect(await query(SLUG, 'latest', { since: 50 })).toEqual([]);
  });

  it('returns the last N entries for tail', async () => {
    await seededRun();
    expect((await query(SLUG, 'latest', { tail: 2 })).map((e) => e.text)).toEqual(['w3', 'a2']);
    expect(await query(SLUG, 'latest', { tail: 99 })).toHaveLength(5);
  });

  it('composes label, since and tail in that order', async () => {
    await seededRun();
    const entries = await query(SLUG, 'latest', { label: 'web', since: 10, tail: 1 });
    expect(entries.map((e) => e.text)).toEqual(['w3']);
    expect(await query(SLUG, 'latest', { label: 'api', since: 20, tail: 5 })).toHaveLength(1);
  });

  it('accepts an explicit run id and returns nothing for an unknown run', async () => {
    const run = await seededRun();
    expect(await query(SLUG, run.runId, { label: 'api' })).toHaveLength(2);
    expect(await query(SLUG, 'no-such-run')).toEqual([]);
    expect(await query('no-such-target', 'latest')).toEqual([]);
  });

  it('skips a torn final line rather than throwing', async () => {
    const run = startRun();
    run.append(line('web', 'one'));
    run.append(line('web', 'two'));
    await run.finishRun();

    appendFileSync(logPath(SLUG, run.runId), '{"ts":123,"label":"web","stream":"stdo');
    const entries = await query(SLUG, run.runId);
    expect(entries.map((e) => e.text)).toEqual(['one', 'two']);
  });

  it('skips garbage anywhere in the file', async () => {
    const run = startRun();
    run.append(line('web', 'one'));
    await run.finishRun();

    const file = logPath(SLUG, run.runId);
    const good = readFileSync(file, 'utf-8').trim();
    writeFileSync(file, `${good}\nnot json at all\n{"ts":1}\n\n${good}\n{"ts":2,"label`);
    const entries = await query(SLUG, run.runId);
    expect(entries.map((e) => e.text)).toEqual(['one', 'one']);
  });
});

describe('retention', () => {
  it('keeps the newest 10 runs per target and prunes the rest', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const run = createRun(SLUG, PLAYBOOK);
      ids.push(run.runId);
      run.append(line('web', `run ${i}`));
      await run.finishRun();
    }

    const kept = listRunIds(SLUG);
    expect(kept).toHaveLength(RUNS_KEPT_PER_TARGET);
    expect(kept[0]).toBe(ids.at(-1));
    const newest = ids.slice(2);
    newest.reverse();
    expect(kept).toEqual(newest);
    expect(existsSync(runDir(SLUG, ids[0]))).toBe(false);
    expect(existsSync(runDir(SLUG, ids[1]))).toBe(false);
  });

  it('prunes per target, not globally', async () => {
    const other = 'my-repo/main:dev';
    for (let i = 0; i < 12; i++) await createRun(SLUG, PLAYBOOK).finishRun();
    const survivor = createRun(other, PLAYBOOK);
    await survivor.finishRun();
    for (let i = 0; i < 12; i++) await createRun(SLUG, PLAYBOOK).finishRun();

    expect(listRunIds(other)).toEqual([survivor.runId]);
    expect(listRunIds(SLUG)).toHaveLength(RUNS_KEPT_PER_TARGET);
  });

  it('never prunes a run that is still open', async () => {
    const open = startRun();
    open.append(line('web', 'still going'));

    for (let i = 0; i < 12; i++) await createRun(SLUG, PLAYBOOK).finishRun();

    expect(existsSync(runDir(SLUG, open.runId))).toBe(true);
    expect(listRunIds(SLUG)).toContain(open.runId);

    await open.finishRun();
    expect((await query(SLUG, open.runId)).map((e) => e.text)).toEqual(['still going']);
  });
});

describe('run ordering', () => {
  it('orders listRuns and latestRun newest first', async () => {
    const first = startRun();
    await first.finishRun();
    const second = startRun();
    await second.finishRun();

    expect(latestRun(SLUG)).toBe(second.runId);
    expect(listRuns(SLUG).map((m) => m.runId)).toEqual([second.runId, first.runId]);
    expect(latestRun('never-used')).toBeNull();
    expect(listRuns('never-used')).toEqual([]);
  });

  it('orders runs created within the same millisecond', async () => {
    const frozen = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozen);

    const a = createRun(SLUG, PLAYBOOK);
    const b = createRun(SLUG, PLAYBOOK);
    const c = createRun(SLUG, PLAYBOOK);
    vi.restoreAllMocks();

    expect(new Set([a.runId, b.runId, c.runId]).size).toBe(3);
    expect(listRunIds(SLUG)).toEqual([c.runId, b.runId, a.runId]);
    expect(latestRun(SLUG)).toBe(c.runId);
    expect(listRuns(SLUG).map((m) => m.startedAt)).toEqual([frozen, frozen, frozen]);

    await Promise.all([a, b, c].map((run) => run.finishRun()));
  });
});

describe('follow', () => {
  it('replays history and streams live entries with no gap and no duplicates', async () => {
    const run = startRun();
    for (let i = 1; i <= 5; i++) {
      run.append({ ts: 100 + i, label: 'web', stream: 'stdout', text: `h${i}` });
    }
    await run.flush();

    const seen: LogEntry[] = [];
    const stop = follow(SLUG, { since: 102 }, (entry) => seen.push(entry));

    // Same tick as the subscribe: the window a naive implementation drops or
    // double-delivers.
    for (let i = 6; i <= 10; i++) {
      run.append({ ts: 100 + i, label: 'web', stream: 'stdout', text: `h${i}` });
    }
    await Promise.resolve();
    for (let i = 11; i <= 15; i++) {
      run.append({ ts: 100 + i, label: 'web', stream: 'stdout', text: `h${i}` });
    }

    await waitFor(() => seen.length >= 13, { label: 'follow to catch up' });
    const expected = ['h3', 'h4', 'h5'];
    for (let i = 6; i <= 15; i++) expected.push(`h${i}`);
    expect(seen.map((e) => e.text)).toEqual(expected);

    stop();
    run.append({ ts: 999, label: 'web', stream: 'stdout', text: 'after-stop' });
    expect(seen).toHaveLength(expected.length);
    await run.finishRun();
  });

  it('sees every entry exactly once across many ticks', async () => {
    const run = startRun();
    const total = 600;
    for (let i = 0; i < 100; i++) {
      run.append({ ts: 1000 + i, label: 'web', stream: 'stdout', text: `e${i}` });
    }

    const seen: LogEntry[] = [];
    const stop = follow(SLUG, {}, (entry) => seen.push(entry));

    let next = 100;
    await new Promise<void>((resolve) => {
      const pump = (): void => {
        for (let i = 0; i < 50 && next < total; i++) {
          run.append({ ts: 1000 + next, label: 'web', stream: 'stdout', text: `e${next}` });
          next++;
        }
        if (next < total) setImmediate(pump);
        else resolve();
      };
      pump();
    });

    await waitFor(() => seen.length >= total, { label: 'all entries followed' });
    expect(seen).toHaveLength(total);
    expect(seen.map((e) => e.text)).toEqual(Array.from({ length: total }, (_unused, i) => `e${i}`));
    stop();
    await run.finishRun();
  });

  it('applies the query filters to replayed and live entries alike', async () => {
    const run = startRun();
    run.append({ ts: 10, label: 'web', stream: 'stdout', text: 'w-old' });
    run.append({ ts: 20, label: 'api', stream: 'stdout', text: 'a-old' });
    await run.flush();

    const seen: LogEntry[] = [];
    const stop = follow(SLUG, { label: 'web' }, (entry) => seen.push(entry));
    run.append({ ts: 30, label: 'api', stream: 'stdout', text: 'a-new' });
    run.append({ ts: 40, label: 'web', stream: 'stdout', text: 'w-new' });

    await waitFor(() => seen.length >= 2, { label: 'filtered follow' });
    expect(seen.map((e) => e.text)).toEqual(['w-old', 'w-new']);
    stop();
    await run.finishRun();
  });

  it('follows a target whose run starts after the subscription', async () => {
    const seen: LogEntry[] = [];
    const stop = follow(SLUG, {}, (entry) => seen.push(entry));

    const run = startRun();
    run.append(line('web', 'first'));
    await waitFor(() => seen.length >= 1, { label: 'live entry from a new run' });
    expect(seen.map((e) => e.text)).toEqual(['first']);
    stop();
    await run.finishRun();
  });

  it('replays a finished run when nothing is running', async () => {
    const previous = startRun();
    previous.append(line('web', 'done-1'));
    previous.append(line('web', 'done-2'));
    await previous.finishRun();

    const seen: LogEntry[] = [];
    const stop = follow(SLUG, {}, (entry) => seen.push(entry));
    await waitFor(() => seen.length >= 2, { label: 'finished run replay' });
    expect(seen.map((e) => e.text)).toEqual(['done-1', 'done-2']);
    stop();
  });
});

describe('throughput', () => {
  it('takes several thousand appends without losing entries or blocking', async () => {
    const run = startRun();
    const filler = 'x'.repeat(200);
    const count = 5000;

    const started = Date.now();
    for (let i = 0; i < count; i++) {
      run.append({
        ts: 1000 + i,
        label: 'chatty',
        stream: 'stdout',
        text: `chatty ${i} ${filler}\n`,
      });
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);

    await run.finishRun();

    const lines = readFileSync(logPath(SLUG, run.runId), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(count);

    const entries = await query(SLUG, 'latest');
    expect(entries).toHaveLength(count);
    expect(entries[0].text.startsWith('chatty 0 ')).toBe(true);
    expect(entries.at(-1)?.text.startsWith(`chatty ${count - 1} `)).toBe(true);
    expect(run.snapshot({ label: 'chatty' }).length).toBeLessThan(count);
  });

  it('captures a real chatty command byte for byte', async () => {
    const run = startRun();
    const child = spawn(chatty(['--lines', 3000, '--size', 120]), { shell: true });
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      run.append({ ts: Date.now(), label: 'chatty', stream: 'stdout', text: chunk });
    });
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => resolve());
    });
    await run.finishRun();

    const entries = await query(SLUG, 'latest');
    expect(entries.length).toBeGreaterThan(0);
    const lines = entries
      .map((e) => e.text)
      .join('')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(3000);
    expect(lines[0]).toBe(`chatty 1 ${'x'.repeat(120)}`);
    expect(lines.at(-1)).toBe(`chatty 3000 ${'x'.repeat(120)}`);
  });
});
