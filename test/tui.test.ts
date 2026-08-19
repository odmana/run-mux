/**
 * The TUI, driven through the real OpenTUI renderer.
 *
 * Mouse input is raw SGR-1006 written onto `renderer.stdin` (built by
 * `test/fixtures/sgr.ts`, not a mocked helper), so the renderer's own
 * parser and hit-tester run. Rows and columns are located by searching the
 * rendered frame, never hard-coded, so a layout change surfaces as a missing
 * row instead of a silently-passing assertion.
 *
 * The renderer lives in a child process so it can own a terminal of its own
 * size and be torn down between cases. Every assertion is still made here; the
 * child only replies with frames and state snapshots.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { METHODS, type TargetView } from '../src/protocol.js';
import { ansiToChunks, stripAnsi } from '../src/tui/ansi.js';
import type { AppSnapshot, PickerSnapshot } from '../src/tui/app.js';
import { elideStart } from '../src/tui/format.js';
import { fuzzyMatch, fuzzyRank } from '../src/tui/fuzzy.js';
import { ALL, LogBuffer } from '../src/tui/log-buffer.js';
import { jumpTo, thumb } from '../src/tui/logpane.js';
import { moveInto, sortByOrder } from '../src/tui/order.js';
import {
  applyFieldValue,
  buildItems,
  isPickable,
  rankItems,
  windowStart,
  type PickerItem,
  type PickerSource,
} from '../src/tui/picker.js';
import {
  clampSidebarWidth,
  groupTargets,
  MAIN_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../src/tui/sidebar.js';
import {
  INTERNAL_METHODS,
  seedValues,
  VERBS,
  VERB_LIST,
  type FieldKind,
} from '../src/tui/verbs.js';
import { useTempHome } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DAEMON = join(ROOT, 'test', 'fixtures', 'tui-daemon.mjs');
const HARNESS = join(ROOT, 'test', 'fixtures', 'tui-harness.ts');

const WIDTH = 120;
const HEIGHT = 30;
const SIDEBAR_WIDTH = 32;
const COALESCE_MS = 40;

interface Reply {
  id: number;
  ok: boolean;
  error?: string;
  frame?: string[];
  snapshot?: AppSnapshot;
  result?: unknown;
}

interface Harness {
  send: (command: Record<string, unknown>) => Promise<Reply>;
  frame: () => string[];
  snapshot: () => AppSnapshot;
  stop: () => Promise<void>;
}

const home = useTempHome();
let daemon: ChildProcess | undefined;
const harnesses: Harness[] = [];

function requestLog(): { method: string; params: unknown }[] {
  const path = join(home.root, 'state', 'tui-daemon-requests.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { method: string; params: unknown });
}

async function startDaemon(): Promise<void> {
  daemon = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, RUN_MUX_HOME: home.root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('tui-daemon did not start')), 10_000);
    daemon?.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf-8').includes('listening')) {
        clearTimeout(timer);
        done();
      }
    });
  });
}

async function boot(options: { width?: number; height?: number } = {}): Promise<Harness> {
  const child = spawn(process.execPath, [HARNESS], {
    cwd: ROOT,
    env: {
      ...process.env,
      RUN_MUX_HOME: home.root,
      TUI_HARNESS_WIDTH: String(options.width ?? WIDTH),
      TUI_HARNESS_HEIGHT: String(options.height ?? HEIGHT),
      TUI_HARNESS_COALESCE_MS: String(COALESCE_MS),
      TUI_HARNESS_POLL_MS: '250',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });

  const waiters = new Map<number, (reply: Reply) => void>();
  child.on('message', (raw) => waiters.get((raw as Reply).id)?.(raw as Reply));

  let latestFrame: string[] = [];
  let latestSnapshot: AppSnapshot | undefined;
  let nextId = 1;

  const record = (reply: Reply) => {
    if (reply.frame) latestFrame = reply.frame;
    if (reply.snapshot) latestSnapshot = reply.snapshot;
    return reply;
  };

  const ready = new Promise<Reply>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`tui harness did not boot: ${stderr || '(no stderr)'}`)),
      20_000,
    );
    waiters.set(0, (reply) => {
      clearTimeout(timer);
      done(reply);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`tui harness exited with ${code}: ${stderr || '(no stderr)'}`));
    });
  });

  const harness: Harness = {
    send(command) {
      const id = nextId++;
      return new Promise<Reply>((done, fail) => {
        const timer = setTimeout(
          () => fail(new Error(`harness timed out on ${command.op}`)),
          15_000,
        );
        waiters.set(id, (reply) => {
          clearTimeout(timer);
          waiters.delete(id);
          if (!reply.ok) fail(new Error(reply.error ?? 'harness command failed'));
          else done(record(reply));
        });
        child.send({ ...command, id });
      });
    },
    frame: () => latestFrame,
    snapshot: () => {
      if (latestSnapshot === undefined) throw new Error('the harness has not reported a snapshot');
      return latestSnapshot;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await harness.send({ op: 'stop' }).catch(() => undefined);
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          child.kill();
          done();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    },
  };

  record(await ready);
  harnesses.push(harness);
  return harness;
}

/** 1-based terminal row of the first frame line containing `needle` within `[from,to]`. */
function rowOf(frame: string[], needle: string, cols?: [number, number]): number {
  const index = frame.findIndex((line) =>
    (cols ? line.slice(cols[0] - 1, cols[1]) : line).includes(needle),
  );
  if (index < 0) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
  return index + 1;
}

const SIDE: [number, number] = [1, SIDEBAR_WIDTH];
const MAIN: [number, number] = [SIDEBAR_WIDTH + 1, WIDTH];
/** The log pane's scrollbar: the column inside its right border. */
const GUTTER = WIDTH - 1;

function colOf(frame: string[], row: number, needle: string): number {
  const line = frame[row - 1] ?? '';
  const at = line.indexOf(needle);
  if (at < 0) throw new Error(`row ${row} does not contain ${JSON.stringify(needle)}`);
  return at + 1;
}

const self = (value: string): string => value;

/** Sidebar rows in draw order: the label to search for, and the slug it must select. */
const ROWS: { name: string; slug: string }[] = [
  { name: 'main:run-ord', slug: 'orders/main:run-orders' },
  { name: 'ports', slug: 'orders/feat-ports:run-orders' },
  { name: 'main:dev', slug: 'billing/main:dev' },
  { name: 'hotfix:dev', slug: 'billing/hotfix:dev' },
  { name: 'main:web', slug: 'studio/main:web' },
  { name: 'feat-y:web', slug: 'studio/feat-y:web' },
];

/** `:` then a query that isolates one verb, then Enter — leaving its form open. */
async function openVerb(tui: Harness, query: string): Promise<void> {
  await tui.send({ op: 'keys', keys: [':'] });
  await tui.send({ op: 'keys', keys: [...query] });
  await tui.send({ op: 'keys', keys: ['\r'] });
}

/**
 * `Add target` opens on the selected target's repo and playbook; the tests that
 * exercise the pickers themselves want all three fields blank. Clearing the repo
 * cascades, so one backspace empties the form.
 */
async function blankAddTarget(tui: Harness): Promise<void> {
  await tui.send({ op: 'keys', keys: ['\u001b[A', '\u007f'] });
}

function pickerOf(tui: Harness): PickerSnapshot {
  const state = tui.snapshot().picker;
  if (state === null) throw new Error(`no picker open (mode: ${tui.snapshot().mode})`);
  return state;
}

beforeAll(async () => {
  await startDaemon();
}, 30_000);

// Before, not after: a harness flushes its last UI write while it is shutting
// down, so a clean-up that ran on the way out could be overtaken by it.
beforeEach(() => {
  rmSync(join(home.root, 'state', 'tui-daemon-ui.json'), { force: true });
  rmSync(join(home.root, 'state', 'tui-daemon-targets.json'), { force: true });
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.stop();
});

afterAll(async () => {
  daemon?.kill();
  home.cleanup();
});

describe('log buffer', () => {
  it('splits chunks into lines and rejoins a chunk that split mid-line', () => {
    const buffer = new LogBuffer();
    buffer.append({ ts: 1, label: 'API', stream: 'stdout', text: 'one\ntwo\nthr' });
    buffer.append({ ts: 2, label: 'API', stream: 'stdout', text: 'ee\nfour\n' });
    expect(buffer.lines.map((line) => line.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(buffer.total).toBe(4);
  });

  it('keeps interleaved labels apart when both are mid-line', () => {
    const buffer = new LogBuffer();
    buffer.append({ ts: 1, label: 'A', stream: 'stdout', text: 'aa' });
    buffer.append({ ts: 1, label: 'B', stream: 'stdout', text: 'bb' });
    buffer.append({ ts: 2, label: 'A', stream: 'stdout', text: 'AA\n' });
    buffer.append({ ts: 2, label: 'B', stream: 'stdout', text: 'BB\n' });
    expect(buffer.lines.map((line) => `${line.label}:${line.text}`)).toEqual(['A:aaAA', 'B:bbBB']);
  });

  it('windows from the tail and clamps a scrollBack past the top', () => {
    const buffer = new LogBuffer();
    for (let i = 0; i < 100; i++) {
      buffer.append({ ts: i, label: 'A', stream: 'stdout', text: `line ${i}\n` });
    }
    const tail = buffer.window(ALL, 10, 0);
    expect(tail.lines.map((line) => line.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${90 + i}`),
    );
    expect(tail.atBottom).toBe(true);

    const top = buffer.window(ALL, 10, Number.MAX_SAFE_INTEGER);
    expect(top.lines[0]?.text).toBe('line 0');
    expect(top.scrollBack).toBe(90);
  });

  it('filters by label without losing the unfiltered lines', () => {
    const buffer = new LogBuffer();
    for (let i = 0; i < 30; i++) {
      buffer.append({ ts: i, label: i % 3 === 0 ? 'A' : 'B', stream: 'stdout', text: `l${i}\n` });
    }
    const only = buffer.window({ labels: new Set(['A']), search: null }, 5, 0);
    expect(only.lines.every((line) => line.label === 'A')).toBe(true);
    expect(buffer.retained).toBe(30);
  });

  it('counts every matching line, not just the windowed ones', () => {
    const buffer = new LogBuffer();
    for (let i = 0; i < 30; i++) {
      buffer.append({ ts: i, label: i % 3 === 0 ? 'A' : 'B', stream: 'stdout', text: `l${i}\n` });
    }
    expect(buffer.window(ALL, 5, 0).matching).toBe(30);
    expect(buffer.window({ labels: new Set(['A']), search: null }, 5, 0).matching).toBe(10);
    expect(buffer.window({ labels: null, search: 'l1' }, 5, 0).matching).toBe(11);
  });
});

describe('log scrollbar', () => {
  it('parks a full-height thumb while everything fits', () => {
    expect(thumb(24, 10, 0)).toEqual({ top: 0, size: 24 });
    expect(thumb(24, 24, 0)).toEqual({ top: 0, size: 24 });
  });

  it('sizes the thumb by the share on screen and sinks it to the tail', () => {
    const tail = thumb(24, 240, 0);
    expect(tail.size).toBe(2);
    expect(tail.top).toBe(24 - tail.size);

    const top = thumb(24, 240, 216);
    expect(top.top).toBe(0);
    expect(top.size).toBe(tail.size);

    const middle = thumb(24, 240, 108);
    expect(middle.top).toBeGreaterThan(0);
    expect(middle.top).toBeLessThan(tail.top);
  });

  it('answers a press with the scrollBack that row stands for', () => {
    expect(jumpTo(24, 240, 23)).toBe(0);
    expect(jumpTo(24, 240, 0)).toBe(216);
    expect(jumpTo(24, 10, 0)).toBe(0);
    // A press where the thumb already sits lands back within the row it covers.
    const rowWorth = Math.ceil((240 - 24) / 23);
    expect(Math.abs(jumpTo(24, 240, thumb(24, 240, 108).top) - 108)).toBeLessThanOrEqual(rowWorth);
  });
});

describe('ansi pass-through', () => {
  it('keeps the command colour rather than dropping or re-escaping it', () => {
    const chunks = ansiToChunks('\u001b[31mFAILED\u001b[0m Orders.Api.Tests');
    expect(chunks.map((chunk) => chunk.text).join('')).toBe('FAILED Orders.Api.Tests');
    expect(chunks[0]?.fg).toBeDefined();
    expect(chunks[1]?.fg).toBeUndefined();
  });

  it('decodes 256-colour and truecolour selectors', () => {
    const indexed = ansiToChunks('\u001b[38;5;196mred');
    const truecolour = ansiToChunks('\u001b[38;2;10;20;30mrgb');
    expect(indexed[0]?.fg).toBeDefined();
    expect(truecolour[0]?.fg).toBeDefined();
    expect(truecolour[0]?.text).toBe('rgb');
  });

  it('strips escapes only for the clipboard', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });
});

describe('command palette coverage', () => {
  it('has an entry for every method the protocol declares, bar the internal ones', () => {
    const internal: readonly string[] = INTERNAL_METHODS;
    const listed = Object.values(METHODS).filter((method) => !internal.includes(method));
    const offered: string[] = VERB_LIST.map((verb) => verb.method);
    expect(new Set(offered)).toEqual(new Set(listed));
  });

  it('never lists a verb that is not a real method', () => {
    for (const verb of VERB_LIST) {
      expect(Object.values(METHODS)).toContain(verb.method);
      expect(VERBS[verb.method]).toBe(verb);
    }
  });

  it('opens Add target on the repo and playbook of the selection, never its worktree', () => {
    const from = {
      slug: 'orders/main:run-orders',
      repoPath: '/projects/orders',
      checkoutPath: '/projects/orders',
      playbookName: 'Run Orders',
    } as TargetView;
    expect(seedValues(VERBS[METHODS.targetAdd], from.slug, from)).toEqual({
      repoPath: '/projects/orders',
      playbookName: 'Run Orders',
    });
  });

  it('seeds a slug into every target field, and nothing at all with no selection', () => {
    expect(seedValues(VERBS[METHODS.runRestart], 'billing/main:dev', undefined)).toEqual({
      target: 'billing/main:dev',
    });
    expect(seedValues(VERBS[METHODS.targetAdd], '', undefined)).toEqual({});
  });
});

describe('fuzzy matching', () => {
  it('matches a subsequence and reports where every query character landed', () => {
    expect(fuzzyMatch('ord', 'orders')?.matchIndices).toEqual([0, 1, 2]);
    expect(fuzzyMatch('fp', 'feat-ports')?.matchIndices).toEqual([0, 5]);
    expect(fuzzyMatch('rr', 'run-orders')?.matchIndices).toEqual([0, 5]);
  });

  it('ignores case in both directions', () => {
    expect(fuzzyMatch('ORD', 'orders')).toEqual(fuzzyMatch('ord', 'orders'));
    expect(fuzzyMatch('run', 'Run Orders')?.matchIndices).toEqual([0, 1, 2]);
  });

  it('returns null when a character is missing or out of order', () => {
    expect(fuzzyMatch('zz', 'orders')).toBeNull();
    expect(fuzzyMatch('so', 'orders')).toBeNull();
  });

  it('matches everything at a neutral score on an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, matchIndices: [] });
    expect(fuzzyRank('', ['b', 'a'], (x) => x).map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('ranks a prefix above a buried match, and breaks ties alphabetically', () => {
    const ranked = fuzzyRank('ord', ['records', 'orders', 'word-order'], (x) => x);
    expect(ranked.map((entry) => entry.text)).toEqual(['orders', 'records', 'word-order']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[1]!.score).toBe(ranked[2]!.score);
  });

  it('rewards consecutive characters over scattered ones', () => {
    const tight = fuzzyMatch('abc', 'abcxyz')!;
    const loose = fuzzyMatch('abc', 'axbxc')!;
    expect(tight.score).toBeGreaterThan(loose.score);
  });
});

describe('picker rows', () => {
  const REPO_SOURCE: PickerSource = {
    repos: {
      data: [
        {
          path: '/projects/orders',
          name: 'orders',
          checkouts: [
            { path: '/projects/orders', branch: 'main', head: 'a', isMain: true },
            { path: '/projects/orders-feat-ports', branch: 'feat-ports', head: 'b', isMain: false },
          ],
          playbooks: [{ name: 'Run Orders', source: 'repo' }],
          problems: [],
        },
        {
          path: '/projects/billing',
          name: 'billing',
          checkouts: [{ path: '/projects/billing', branch: 'main', head: 'c', isMain: true }],
          playbooks: [{ name: 'dev', source: 'global' }],
          problems: [],
        },
      ],
      loading: false,
      error: null,
    },
    targets: [],
    commands: { data: null, loading: false, error: null, scope: '' },
  };

  it('knows which field kinds are answered from a list', () => {
    const kinds: FieldKind[] = ['repo', 'checkout', 'playbook', 'target', 'label'];
    expect(kinds.every((kind) => isPickable(kind))).toBe(true);
    expect(isPickable('text')).toBe(false);
    expect(isPickable('number')).toBe(false);
  });

  it('refuses to list every checkout when no repo has been chosen', () => {
    const list = buildItems('checkout', '', REPO_SOURCE);
    expect(list.items).toEqual([]);
    expect(list.note).toContain('choose a repo first');
  });

  it('scopes checkouts and playbooks to one repo, and marks the main worktree', () => {
    const checkouts = buildItems('checkout', '/projects/orders', REPO_SOURCE).items;
    expect(checkouts.map((item) => item.value)).toEqual([
      '/projects/orders',
      '/projects/orders-feat-ports',
    ]);
    expect(checkouts.find((item) => item.label === 'main')?.badge).toBe('main');

    const playbooks = buildItems('playbook', '/projects/billing', REPO_SOURCE).items;
    expect(playbooks).toEqual([{ value: 'dev', label: 'dev', detail: '(global)' }]);
  });

  it('says the daemon is still answering rather than showing an empty list', () => {
    const list = buildItems('repo', '', {
      ...REPO_SOURCE,
      repos: { data: null, loading: true, error: null },
    });
    expect(list.note).toBe('loading…');
    expect(
      buildItems('repo', '', {
        ...REPO_SOURCE,
        repos: { data: null, loading: false, error: 'socket closed' },
      }).note,
    ).toBe('socket closed');
  });

  it('ranks a label match above a detail match and highlights the right string', () => {
    const items: PickerItem[] = [
      { value: '/a/zeta', label: 'zeta', detail: '/a/zeta' },
      { value: '/b/other', label: 'other', detail: '/zeta/other' },
    ];
    const rows = rankItems('zet', items);
    expect(rows.map((row) => row.item.label)).toEqual(['zeta', 'other']);
    expect(rows[0]!.labelMatch).toEqual([0, 1, 2]);
    expect(rows[0]!.detailMatch).toEqual([]);
    expect(rows[1]!.labelMatch).toEqual([]);
    expect(rows[1]!.detailMatch).toEqual([1, 2, 3]);
  });

  it('keeps the cursor inside the drawn window however long the list is', () => {
    expect(windowStart(0, 60, 10)).toBe(0);
    expect(windowStart(30, 60, 10)).toBe(25);
    expect(windowStart(59, 60, 10)).toBe(50);
    expect(windowStart(3, 4, 10)).toBe(0);
  });

  it('drops a checkout and a playbook that do not belong to the new repo', () => {
    const fields = VERBS[METHODS.targetAdd].fields;
    const filled = {
      repoPath: '/projects/orders',
      checkoutPath: '/projects/orders-feat-ports',
      playbookName: 'Run Orders',
    };

    const moved = applyFieldValue(fields, filled, 'repoPath', '/projects/billing', REPO_SOURCE);
    expect(moved.checkoutPath).toBe('');
    expect(moved.playbookName).toBe('');

    const same = applyFieldValue(fields, filled, 'repoPath', '/projects/orders', REPO_SOURCE);
    expect(same.checkoutPath).toBe('/projects/orders-feat-ports');
    expect(same.playbookName).toBe('Run Orders');
  });
});

describe('mouse hit-testing', () => {
  it('routes a click on the Nth sidebar row to the Nth target', async () => {
    const tui = await boot();
    const seen: string[] = [];

    for (const row of ROWS) {
      const at = rowOf(tui.frame(), row.name, SIDE);
      await tui.send({ op: 'click', col: 5, row: at });
      const snapshot = tui.snapshot();
      seen.push(`${snapshot.lastHit ?? '?'}|${snapshot.selected ?? '?'}`);
      expect(snapshot.lastHit).toBe(`target:${row.slug}@4,${at - 1}`);
      expect(snapshot.selected).toBe(row.slug);
    }

    expect(new Set(seen).size).toBe(ROWS.length);
  }, 30_000);

  it('reports red when the routing is wrong (negative control)', async () => {
    const tui = await boot();
    const third = ROWS[2]!;
    const at = rowOf(tui.frame(), third.name, SIDE);
    await tui.send({ op: 'click', col: 5, row: at });

    // The Ink failure mode: row 3 answering as row 1. If this assertion could
    // pass, every green assertion above would be worthless.
    let wentRed = false;
    try {
      expect(tui.snapshot().lastHit).toBe(`target:${ROWS[0]!.slug}@4,${at - 1}`);
    } catch {
      wentRed = true;
    }
    expect(wentRed).toBe(true);
    expect(tui.snapshot().lastHit).toBe(`target:${third.slug}@4,${at - 1}`);
  }, 30_000);

  it('misses every target when the click lands right of the sidebar', async () => {
    const tui = await boot();
    const at = rowOf(tui.frame(), ROWS[2]!.name, SIDE);
    await tui.send({ op: 'click', col: 5, row: at });
    const inside = `target:${ROWS[2]!.slug}@4,${at - 1}`;
    expect(tui.snapshot().lastHit).toBe(inside);

    // lastHit only moves when an element with a handler is hit, so a click into
    // dead space leaves it alone. Had this been routed to the row, the recorded
    // element-local x would be ~SIDEBAR_WIDTH+20, not the 4 from the click above.
    await tui.send({ op: 'click', col: SIDEBAR_WIDTH + 20, row: at });
    expect(tui.snapshot().lastHit).toBe(inside);
  }, 30_000);

  it('still hits the right row after the log pane has scrolled', async () => {
    const tui = await boot();
    await tui.send({ op: 'request', method: 'test.flood', params: { lines: 400 } });
    await tui.send({ op: 'settle', ms: 300 });

    const logRow = 6;
    const before = tui.frame()[logRow - 1];
    await tui.send({ op: 'wheel', col: SIDEBAR_WIDTH + 20, row: logRow, dir: 'up', n: 8 });
    expect(tui.snapshot().scrollBack).toBeGreaterThan(0);
    expect(tui.frame()[logRow - 1]).not.toBe(before);

    const third = ROWS[2]!;
    const at = rowOf(tui.frame(), third.name, SIDE);
    await tui.send({ op: 'click', col: 5, row: at });
    expect(tui.snapshot().lastHit).toBe(`target:${third.slug}@4,${at - 1}`);
  }, 30_000);

  it('still hits the right row after a resize', async () => {
    const tui = await boot();
    for (const [width, height] of [
      [80, 24],
      [160, 44],
      [120, 30],
    ] as [number, number][]) {
      await tui.send({ op: 'resize', width, height });
      const third = ROWS[2]!;
      const at = rowOf(tui.frame(), third.name, SIDE);
      await tui.send({ op: 'click', col: 5, row: at });
      expect(tui.snapshot().lastHit).toBe(`target:${third.slug}@4,${at - 1}`);
      expect(tui.snapshot().selected).toBe(third.slug);
    }
  }, 40_000);

  it('opens the palette pre-filled with the target on a right-click', async () => {
    const tui = await boot();
    const at = rowOf(tui.frame(), ROWS[3]!.name, SIDE);
    await tui.send({ op: 'click', col: 5, row: at, button: 2 });
    const snapshot = tui.snapshot();
    expect(snapshot.mode).toBe('palette');
    expect(snapshot.lastHit).toBe(`context:${ROWS[3]!.slug}`);
    expect(snapshot.status).toContain(ROWS[3]!.slug);
  }, 30_000);

  it('folds a repo group when its header is clicked', async () => {
    const tui = await boot();
    const at = rowOf(tui.frame(), 'BILLING', SIDE);
    await tui.send({ op: 'click', col: 3, row: at });
    expect(tui.snapshot().collapsed).toEqual(['/projects/billing']);
    expect(tui.snapshot().slugs).not.toContain('billing/main:dev');
  }, 30_000);

  it('reveals per-row controls on hover and stops the target from them', async () => {
    const tui = await boot();
    const row = ROWS[4]!;
    // Earlier cases mutate the stub's run state, so pin it before asserting on the glyph.
    await tui.send({ op: 'request', method: METHODS.runStart, params: { target: row.slug } });
    await tui.send({ op: 'settle', ms: 300 });

    const at = rowOf(tui.frame(), row.name, SIDE);
    // A target occupies two lines: the name, then branch/elapsed. The hover
    // controls take the branch column on that second line.
    const detail = at + 1;
    expect(tui.frame()[detail - 1]).not.toContain('■');

    await tui.send({ op: 'move', col: 10, row: at });
    expect(tui.frame()[detail - 1]).toContain('■');
    expect(tui.frame()[detail - 1]).toContain('↻');

    await tui.send({ op: 'click', col: colOf(tui.frame(), detail, '■'), row: detail });
    await tui.send({ op: 'settle', ms: 300 });
    expect(
      requestLog().some(
        (entry) =>
          entry.method === METHODS.runStop &&
          (entry.params as { target?: string } | null)?.target === row.slug,
      ),
    ).toBe(true);
  }, 40_000);

  it('toggles a run from the status dot', async () => {
    const tui = await boot();
    const row = ROWS[3]!;
    const at = rowOf(tui.frame(), row.name, SIDE);
    await tui.send({ op: 'click', col: 2, row: at });
    await tui.send({ op: 'settle', ms: 300 });
    expect(tui.snapshot().selected).toBe(row.slug);
    expect(
      requestLog().some(
        (entry) =>
          entry.method === METHODS.runStart &&
          (entry.params as { target?: string } | null)?.target === row.slug,
      ),
    ).toBe(true);
  }, 30_000);
});

describe('sidebar scrolling', () => {
  async function withBulkTargets(count: number): Promise<Harness> {
    const tui = await boot();
    await tui.send({ op: 'request', method: 'test.targets', params: { count } });
    await tui.send({ op: 'settle', ms: 400 });
    return tui;
  }

  it('scrolls the last row into view as the selection walks down to it', async () => {
    const tui = await withBulkTargets(24);
    const slugs = tui.snapshot().slugs;
    const last = slugs.at(-1) ?? '';
    expect(slugs).toHaveLength(30);
    expect(last).toBe('studio/feat-y:web');
    // Sixty-three rows of sidebar in a thirty-line terminal: the tail is below the fold.
    expect(tui.frame().join('\n')).not.toContain('feat-y:web');

    await tui.send({ op: 'keys', keys: Array.from({ length: slugs.length - 1 }, () => 'j') });
    await tui.send({ op: 'settle', ms: 200 });

    expect(tui.snapshot().selected).toBe(last);
    expect(tui.frame().join('\n')).toContain('feat-y:web');
  }, 40_000);

  it('scrolls with the wheel over the sidebar, leaving the log pane alone', async () => {
    const tui = await withBulkTargets(24);
    const before = tui.frame().map((line) => line.slice(0, SIDEBAR_WIDTH));
    const logBefore = tui.snapshot().scrollBack;

    await tui.send({ op: 'wheel', col: 10, row: 8, dir: 'down', n: 6 });

    const after = tui.frame().map((line) => line.slice(0, SIDEBAR_WIDTH));
    expect(after).not.toEqual(before);
    expect(tui.snapshot().scrollBack).toBe(logBefore);
  }, 40_000);
});

describe('sidebar ordering', () => {
  it('moves an item into the slot it was dropped on', () => {
    expect(moveInto(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveInto(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveInto(['a', 'b', 'c'], 'a', 'a')).toEqual(['a', 'b', 'c']);
    expect(moveInto(['a', 'b', 'c'], 'a', 'gone')).toEqual(['a', 'b', 'c']);
  });

  it('puts listed keys first and leaves the rest where the daemon had them', () => {
    expect(sortByOrder(['a', 'b', 'c', 'd'], self, ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
    expect(sortByOrder(['a', 'b'], self, [])).toEqual(['a', 'b']);
    expect(sortByOrder(['a', 'b'], self, ['gone', 'b'])).toEqual(['b', 'a']);
  });

  it('groups by repo and applies both levels of the order', () => {
    const view = (slug: string, repoPath: string): TargetView =>
      ({ slug, repoPath, repoName: repoPath.slice(1) }) as TargetView;
    const targets = [view('a/1', '/a'), view('a/2', '/a'), view('b/1', '/b')];

    expect(groupTargets(targets).map((group) => group.repoPath)).toEqual(['/a', '/b']);

    const reordered = groupTargets(targets, {
      repos: ['/b', '/a'],
      targets: { '/a': ['a/2', 'a/1'] },
    });
    expect(reordered.map((group) => group.repoPath)).toEqual(['/b', '/a']);
    expect(reordered[1]?.targets.map((target) => target.slug)).toEqual(['a/2', 'a/1']);
  });

  it('reorders targets within a repo when one is dragged onto another', async () => {
    const tui = await boot();
    expect(tui.snapshot().slugs.slice(0, 2)).toEqual([
      'orders/main:run-orders',
      'orders/feat-ports:run-orders',
    ]);

    const from = rowOf(tui.frame(), ROWS[0]!.name, SIDE);
    const to = rowOf(tui.frame(), ROWS[1]!.name, SIDE);
    await tui.send({ op: 'drag', fromCol: 12, fromRow: from, toCol: 12, toRow: to });

    expect(tui.snapshot().slugs.slice(0, 2)).toEqual([
      'orders/feat-ports:run-orders',
      'orders/main:run-orders',
    ]);
  }, 30_000);

  it('carries the whole group when a repo header is dragged', async () => {
    const tui = await boot();
    expect(tui.snapshot().slugs[0]).toBe('orders/main:run-orders');

    const from = rowOf(tui.frame(), 'STUDIO', SIDE);
    const to = rowOf(tui.frame(), 'ORDERS', SIDE);
    await tui.send({ op: 'drag', fromCol: 6, fromRow: from, toCol: 6, toRow: to });

    expect(tui.snapshot().slugs.slice(0, 2)).toEqual(['studio/main:web', 'studio/feat-y:web']);
  }, 30_000);

  it('refuses to drop a target into another repo', async () => {
    const tui = await boot();
    const before = tui.snapshot().slugs;

    const from = rowOf(tui.frame(), ROWS[0]!.name, SIDE);
    const to = rowOf(tui.frame(), ROWS[2]!.name, SIDE);
    await tui.send({ op: 'drag', fromCol: 12, fromRow: from, toCol: 12, toRow: to });

    expect(tui.snapshot().slugs).toEqual(before);
  }, 30_000);

  it('does not stop a target that was picked up by its status dot', async () => {
    const tui = await boot();
    const from = rowOf(tui.frame(), ROWS[0]!.name, SIDE);
    const to = rowOf(tui.frame(), ROWS[1]!.name, SIDE);
    const before = requestLog().length;

    await tui.send({ op: 'drag', fromCol: 2, fromRow: from, toCol: 2, toRow: to });

    const since = requestLog().slice(before);
    expect(since.some((entry) => entry.method === METHODS.runStop)).toBe(false);
    expect(since.some((entry) => entry.method === METHODS.runStart)).toBe(false);
    expect(tui.snapshot().slugs[0]).toBe('orders/feat-ports:run-orders');
  }, 30_000);

  it('does not fold a repo group that was only dragged past', async () => {
    const tui = await boot();
    const from = rowOf(tui.frame(), 'STUDIO', SIDE);
    const to = rowOf(tui.frame(), 'ORDERS', SIDE);
    await tui.send({ op: 'drag', fromCol: 6, fromRow: from, toCol: 6, toRow: to });
    expect(tui.snapshot().collapsed).toEqual([]);
  }, 30_000);

  it('remembers both orders across a restart', async () => {
    const first = await boot();
    const target = rowOf(first.frame(), ROWS[0]!.name, SIDE);
    const onto = rowOf(first.frame(), ROWS[1]!.name, SIDE);
    await first.send({ op: 'drag', fromCol: 12, fromRow: target, toCol: 12, toRow: onto });

    const studio = rowOf(first.frame(), 'STUDIO', SIDE);
    const orders = rowOf(first.frame(), 'ORDERS', SIDE);
    await first.send({ op: 'drag', fromCol: 6, fromRow: studio, toCol: 6, toRow: orders });

    const expected = first.snapshot().slugs;
    expect(expected.slice(0, 3)).toEqual([
      'studio/main:web',
      'studio/feat-y:web',
      'orders/feat-ports:run-orders',
    ]);
    await first.send({ op: 'settle', ms: 300 });
    await first.stop();

    const second = await boot();
    expect(second.snapshot().slugs).toEqual(expected);
  }, 40_000);
});

describe('sidebar resizing', () => {
  it('clamps a width to the terminal it has to fit in', () => {
    expect(clampSidebarWidth(SIDEBAR_WIDTH, 120)).toBe(SIDEBAR_WIDTH);
    expect(clampSidebarWidth(4, 120)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(300, 120)).toBe(120 - MAIN_MIN_WIDTH);
    expect(clampSidebarWidth(60, 200)).toBe(60);
  });

  it('widens the sidebar when its right border is dragged', async () => {
    const tui = await boot();
    expect(tui.snapshot().sidebarWidth).toBe(SIDEBAR_WIDTH);

    const at = rowOf(tui.frame(), 'targets');
    await tui.send({
      op: 'drag',
      fromCol: SIDEBAR_WIDTH,
      fromRow: at + 2,
      toCol: SIDEBAR_WIDTH + 12,
      toRow: at + 2,
    });

    expect(tui.snapshot().sidebarWidth).toBe(SIDEBAR_WIDTH + 12);
    expect(tui.frame()[at - 1]?.indexOf('┐')).toBe(SIDEBAR_WIDTH + 11);
  }, 30_000);

  it('will not let the drag squeeze the log pane away', async () => {
    const tui = await boot();
    await tui.send({ op: 'drag', fromCol: SIDEBAR_WIDTH, fromRow: 4, toCol: WIDTH, toRow: 4 });
    expect(tui.snapshot().sidebarWidth).toBe(WIDTH - MAIN_MIN_WIDTH);
  }, 30_000);

  it('only resizes from the border: a drag across a row leaves the width alone', async () => {
    const tui = await boot();
    const at = rowOf(tui.frame(), ROWS[1]!.name, SIDE);
    await tui.send({ op: 'drag', fromCol: 5, fromRow: at, toCol: 24, toRow: at });
    expect(tui.snapshot().sidebarWidth).toBe(SIDEBAR_WIDTH);
  }, 30_000);

  it('remembers the width and the folded groups across a restart', async () => {
    const first = await boot();
    const targetsRow = rowOf(first.frame(), 'targets');
    await first.send({
      op: 'drag',
      fromCol: SIDEBAR_WIDTH,
      fromRow: targetsRow + 2,
      toCol: 44,
      toRow: targetsRow + 2,
    });
    const billing = rowOf(first.frame(), 'BILLING', SIDE);
    await first.send({ op: 'click', col: 3, row: billing });

    expect(first.snapshot().sidebarWidth).toBe(44);
    expect(first.snapshot().collapsed).toEqual(['/projects/billing']);
    await first.send({ op: 'settle', ms: 300 });
    await first.stop();

    const second = await boot();
    expect(second.snapshot().sidebarWidth).toBe(44);
    expect(second.snapshot().collapsed).toEqual(['/projects/billing']);
    expect(second.snapshot().slugs).not.toContain('billing/main:dev');
  }, 40_000);
});

describe('pane header', () => {
  it('keeps the tail of a path that does not fit', () => {
    expect(elideStart('/projects/orders', 40)).toBe('/projects/orders');
    expect(elideStart('/projects/orders-feat-ports', 12)).toBe('…-feat-ports');
    expect(elideStart('/projects/orders', 1)).toBe('…');
    expect(elideStart('/projects/orders', 0)).toBe('');
  });

  it('shows the checkout path under the identity line, above the chips', async () => {
    const tui = await boot();
    const identity = rowOf(tui.frame(), 'orders/main:run-orders', MAIN);
    const path = rowOf(tui.frame(), '/projects/orders', MAIN);
    const chips = rowOf(tui.frame(), ' a all ', MAIN);

    expect(path).toBe(identity + 1);
    expect(chips).toBe(path + 1);
  }, 30_000);

  it('follows the selection onto a linked worktree', async () => {
    const tui = await boot();
    const at = rowOf(tui.frame(), 'ports', SIDE);
    await tui.send({ op: 'click', col: 5, row: at });
    await tui.send({ op: 'settle', ms: 200 });

    const identity = rowOf(tui.frame(), 'orders/feat-ports:run-orders', MAIN);
    expect(tui.frame()[identity]).toContain('/projects/orders-feat-ports');
  }, 30_000);
});

describe('filter chips', () => {
  it('solos a command when its chip is clicked, and resets on "all"', async () => {
    const tui = await boot();
    const chipRow = rowOf(tui.frame(), ' 2 API');
    const col = colOf(tui.frame(), chipRow, ' 2 API') + 1;

    await tui.send({ op: 'click', col, row: chipRow });
    expect(tui.snapshot().lastHit).toBe('chip:API');
    expect(tui.snapshot().filterLabels).toEqual(['API']);

    const allCol = colOf(tui.frame(), chipRow, ' a all ') + 1;
    await tui.send({ op: 'click', col: allCol, row: chipRow });
    expect(tui.snapshot().lastHit).toBe('chip:all');
    expect(tui.snapshot().filterLabels).toBeNull();
  }, 30_000);

  it('solos the same command from the keyboard with 1-9, and "a" clears it', async () => {
    const tui = await boot();
    expect(tui.snapshot().labels).toEqual(['Build', 'API', 'Web']);

    await tui.send({ op: 'keys', keys: ['2'] });
    expect(tui.snapshot().filterLabels).toEqual(['API']);

    await tui.send({ op: 'keys', keys: ['3'] });
    expect(tui.snapshot().filterLabels).toEqual(['Web']);

    await tui.send({ op: 'keys', keys: ['a'] });
    expect(tui.snapshot().filterLabels).toBeNull();
  }, 30_000);

  it('orders a stopped target by its playbook, not by what the log said first', async () => {
    const tui = await boot();
    const at = rowOf(tui.frame(), ROWS[1]!.name, SIDE);
    await tui.send({ op: 'click', col: 5, row: at });
    await tui.send({ op: 'settle', ms: 400 });

    expect(tui.snapshot().selected).toBe(ROWS[1]!.slug);
    expect(tui.snapshot().labels).toEqual(['Build', 'API', 'Web']);

    await tui.send({ op: 'keys', keys: ['1'] });
    expect(tui.snapshot().filterLabels).toEqual(['Build']);
  }, 40_000);

  it('hides the other labels from the rendered pane once soloed', async () => {
    const tui = await boot();
    await tui.send({ op: 'settle', ms: 200 });
    expect(tui.frame().join('\n')).toContain('[Build]');

    await tui.send({ op: 'keys', keys: ['2'] });
    await tui.send({ op: 'settle', ms: 200 });
    const pane = tui.frame().join('\n');
    expect(pane).toContain('[API]');
    expect(pane).not.toContain('[Build]');
  }, 30_000);
});

describe('log pane throughput', () => {
  it('coalesces and virtualizes: state holds the window, the buffer holds them all', async () => {
    const tui = await boot();
    const seeded = tui.snapshot().totalLines;
    const flooded = 6000;

    const started = Date.now();
    for (let batch = 0; batch < 6; batch++) {
      await tui.send({ op: 'request', method: 'test.flood', params: { lines: 1000 } });
    }
    await tui.send({ op: 'settle', ms: 400 });
    const elapsedMs = Date.now() - started;

    const snapshot = tui.snapshot();
    // Nothing is allowed to fall on the floor between the socket and the buffer.
    expect(snapshot.totalLines).toBe(seeded + flooded);
    expect(snapshot.bufferLines).toBe(seeded + flooded);
    // …while React only ever held the rows the pane can draw.
    expect(snapshot.visibleLines).toBeLessThanOrEqual(HEIGHT - 5);
    expect(snapshot.visibleLines).toBeGreaterThan(0);

    process.stderr.write(
      `\n  log pane: ${flooded} lines in ${elapsedMs}ms (${Math.round(flooded / (elapsedMs / 1000))}/s), ` +
        `state held ${snapshot.visibleLines} of ${snapshot.bufferLines}\n`,
    );
  }, 60_000);

  it('keeps answering clicks while the stream is running', async () => {
    const tui = await boot();
    await tui.send({ op: 'request', method: 'test.flood', params: { lines: 3000 } });
    const at = rowOf(tui.frame(), ROWS[4]!.name, SIDE);
    await tui.send({ op: 'click', col: 5, row: at });
    expect(tui.snapshot().selected).toBe(ROWS[4]!.slug);
  }, 40_000);

  it('scrolls with the wheel and returns to the tail with G', async () => {
    const tui = await boot();
    await tui.send({ op: 'request', method: 'test.flood', params: { lines: 500 } });
    await tui.send({ op: 'settle', ms: 300 });

    await tui.send({ op: 'wheel', col: SIDEBAR_WIDTH + 20, row: 6, dir: 'up', n: 5 });
    expect(tui.snapshot().scrollBack).toBeGreaterThan(0);

    await tui.send({ op: 'keys', keys: ['G'] });
    expect(tui.snapshot().scrollBack).toBe(0);

    await tui.send({ op: 'keys', keys: ['g'] });
    expect(tui.snapshot().scrollBack).toBeGreaterThan(0);
  }, 40_000);

  it('draws a scrollbar that tracks the view', async () => {
    const tui = await boot();
    await tui.send({ op: 'request', method: 'test.flood', params: { lines: 500 } });
    await tui.send({ op: 'settle', ms: 300 });

    const held = (frame: string[]): number[] =>
      frame.flatMap((line, index) => (line[GUTTER - 1] === '█' ? [index + 1] : []));

    // 500 lines through a 24-row pane: a short thumb, parked at the tail.
    const tail = held(tui.frame());
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(HEIGHT - 6);
    expect(tail.at(-1)).toBe(rowOf(tui.frame(), '└', MAIN) - 1);

    await tui.send({ op: 'wheel', col: SIDEBAR_WIDTH + 20, row: 8, dir: 'up', n: 60 });
    await tui.send({ op: 'settle', ms: 200 });
    const scrolled = held(tui.frame());
    expect(scrolled[0]).toBeLessThan(tail[0]!);
    expect(scrolled.length).toBe(tail.length);
  }, 40_000);

  it('jumps the view when the scrollbar is pressed and dragged', async () => {
    const tui = await boot();
    await tui.send({ op: 'request', method: 'test.flood', params: { lines: 500 } });
    await tui.send({ op: 'settle', ms: 300 });
    const top = rowOf(tui.frame(), '┌', MAIN) + 1;
    const bottom = rowOf(tui.frame(), '└', MAIN) - 1;

    await tui.send({ op: 'click', col: GUTTER, row: top });
    await tui.send({ op: 'settle', ms: 200 });
    const back = tui.snapshot().scrollBack;
    expect(back).toBeGreaterThan(0);
    expect(tui.snapshot().totalLines - back).toBeLessThanOrEqual(HEIGHT);

    // Dragging the thumb back down to the last row returns to the tail.
    await tui.send({ op: 'drag', fromCol: GUTTER, fromRow: top, toCol: GUTTER, toRow: bottom });
    await tui.send({ op: 'settle', ms: 200 });
    expect(tui.snapshot().scrollBack).toBe(0);
  }, 40_000);
});

async function followers(tui: Harness): Promise<{ count: number; targets: string[] }> {
  const reply = await tui.send({ op: 'request', method: 'test.followers' });
  return reply.result as { count: number; targets: string[] };
}

describe('subscriptions', () => {
  it('unsubscribes logs.follow when the selection changes', async () => {
    const tui = await boot();
    await tui.send({ op: 'settle', ms: 200 });

    const before = requestLog();
    expect(before.filter((entry) => entry.method === METHODS.logsFollow).length).toBeGreaterThan(0);
    const unsubsBefore = before.filter((entry) => entry.method === '$unsubscribe').length;

    await tui.send({ op: 'keys', keys: ['j'] });
    await tui.send({ op: 'settle', ms: 300 });

    const after = requestLog();
    expect(after.filter((entry) => entry.method === '$unsubscribe').length).toBe(unsubsBefore + 1);

    // Exactly one follow is live on this connection: the new selection's.
    const live = await followers(tui);
    expect(live.count).toBe(1);
    expect(live.targets).toEqual([ROWS[1]!.slug]);
  }, 40_000);
});

describe('quitting', () => {
  it('q exits the TUI and leaves the daemon running', async () => {
    const tui = await boot();
    await tui.send({ op: 'keys', keys: ['q'] });
    expect(tui.snapshot().exited).toBe(true);
    expect(requestLog().some((entry) => entry.method === METHODS.daemonStop)).toBe(false);

    await tui.stop();

    // The daemon is still there to answer a brand new client.
    const probe = await boot();
    const pong = (await probe.send({ op: 'request', method: METHODS.ping })).result as {
      protocol: number;
    };
    expect(pong.protocol).toBe(1);
    expect(daemon?.exitCode).toBeNull();
  }, 40_000);
});

describe('command palette', () => {
  it('opens on ":" and offers every verb', async () => {
    const tui = await boot();
    await tui.send({ op: 'keys', keys: [':'] });
    const snapshot = tui.snapshot();
    expect(snapshot.mode).toBe('palette');
    const internal: readonly string[] = INTERNAL_METHODS;
    expect(new Set(snapshot.paletteMethods)).toEqual(
      new Set(Object.values(METHODS).filter((method) => !internal.includes(method))),
    );
  }, 30_000);

  it('filters as you type and runs the picked verb through the daemon', async () => {
    const tui = await boot();
    await tui.send({ op: 'keys', keys: [':', 'r', 'e', 'l', 'o', 'a', 'd'] });
    expect(tui.snapshot().paletteMethods).toEqual([METHODS.configReload]);

    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(tui.snapshot().mode).toBe('browse');
    expect(requestLog().some((entry) => entry.method === METHODS.configReload)).toBe(true);
  }, 30_000);

  it('opens a form for a verb that needs arguments, pre-filled with the selection', async () => {
    const tui = await boot();
    await tui.send({ op: 'keys', keys: [':', 's', 't', 'o', 'p', ' ', 't'] });
    expect(tui.snapshot().paletteMethods).toContain(METHODS.runStop);

    await tui.send({ op: 'keys', keys: ['\r'] });
    const snapshot = tui.snapshot();
    expect(snapshot.mode).toBe('form');
    expect(snapshot.formMethod).toBe(METHODS.runStop);
    expect(snapshot.formValues.target).toBe(ROWS[0]!.slug);

    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(
      requestLog().some(
        (entry) =>
          entry.method === METHODS.runStop &&
          (entry.params as { target?: string } | null)?.target === ROWS[0]!.slug,
      ),
    ).toBe(true);
  }, 30_000);

  it('closes on Escape without running anything', async () => {
    const tui = await boot();
    await tui.send({ op: 'keys', keys: [':'] });
    expect(tui.snapshot().mode).toBe('palette');
    // A lone ESC is ambiguous to any terminal parser, so give it a beat to be
    // decided as a key rather than the head of a sequence.
    await tui.send({ op: 'keys', keys: ['\u001b'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(tui.snapshot().mode).toBe('browse');
  }, 30_000);
});

describe('fuzzy pickers', () => {
  it('adds a target by fuzzy typing alone, and submits paths not names', async () => {
    const tui = await boot();
    const before = requestLog().length;
    await openVerb(tui, 'add target');
    expect(tui.snapshot().formMethod).toBe(METHODS.targetAdd);
    await blankAddTarget(tui);
    expect(tui.snapshot().formValues.repoPath).toBe('');
    expect(tui.snapshot().formValues.playbookName).toBe('');

    await tui.send({ op: 'keys', keys: ['o', 'r', 'd'] });
    await tui.send({ op: 'settle', ms: 300 });
    expect(tui.snapshot().mode).toBe('picker');
    expect(pickerOf(tui).kind).toBe('repo');
    expect(pickerOf(tui).rows.map((row) => row.label)).toEqual(['orders']);
    await tui.send({ op: 'keys', keys: ['\r'] });
    expect(tui.snapshot().mode).toBe('form');
    expect(tui.snapshot().formValues.repoPath).toBe('/projects/orders');

    await tui.send({ op: 'keys', keys: ['f', 'e'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(pickerOf(tui).kind).toBe('checkout');
    expect(pickerOf(tui).rows.map((row) => row.label)).toEqual(['feat-ports']);
    await tui.send({ op: 'keys', keys: ['\r'] });

    await tui.send({ op: 'keys', keys: ['r', 'u', 'n'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(pickerOf(tui).kind).toBe('playbook');
    expect(pickerOf(tui).rows.map((row) => row.label)).toEqual(['Run Orders']);
    await tui.send({ op: 'keys', keys: ['\r'] });

    expect(tui.snapshot().formValues).toEqual({
      repoPath: '/projects/orders',
      checkoutPath: '/projects/orders-feat-ports',
      playbookName: 'Run Orders',
    });

    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 300 });

    const since = requestLog().slice(before);
    // The friendly names went in; the paths and the playbook name came out.
    expect(since.filter((entry) => entry.method === METHODS.targetAdd).pop()?.params).toEqual({
      repoPath: '/projects/orders',
      checkoutPath: '/projects/orders-feat-ports',
      playbookName: 'Run Orders',
    });
    // One `repo.list` fed all three pickers, and nothing polled it.
    expect(since.filter((entry) => entry.method === METHODS.repoList).length).toBe(1);
  }, 60_000);

  it('opens Add target ready for a worktree and nothing else', async () => {
    const tui = await boot();
    const before = requestLog().length;
    await tui.send({ op: 'keys', keys: ['j', 'j'] });
    await openVerb(tui, 'add target');
    expect(tui.snapshot().formValues).toEqual({
      repoPath: '/projects/billing',
      playbookName: 'dev',
    });

    // Focus skipped the two seeded fields, so Enter opens the checkout picker
    // rather than submitting a form that is one worktree short.
    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 300 });
    expect(pickerOf(tui).kind).toBe('checkout');
    expect(pickerOf(tui).rows.map((row) => row.label)).toEqual(['main']);

    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 300 });
    expect(
      requestLog()
        .slice(before)
        .filter((entry) => entry.method === METHODS.targetAdd)
        .pop()?.params,
    ).toEqual({
      repoPath: '/projects/billing',
      checkoutPath: '/projects/billing',
      playbookName: 'dev',
    });
  }, 60_000);

  it('narrows as you type and marks the characters the query hit', async () => {
    const tui = await boot();
    await openVerb(tui, 'add target');
    await blankAddTarget(tui);
    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 300 });

    expect(pickerOf(tui).query).toBe('');
    expect(pickerOf(tui).rows.map((row) => row.label)).toEqual(['billing', 'orders', 'studio']);

    await tui.send({ op: 'keys', keys: ['o'] });
    const wide = pickerOf(tui);
    expect(wide.rows.map((row) => row.label)).toEqual(['orders', 'studio', 'billing']);
    expect(wide.rows[0]?.match).toEqual([0]);
    expect(wide.rows[1]?.match).toEqual([5]);
    // `billing` has no o in its name — its path matched, so the path is what lights up.
    expect(wide.rows[2]?.match).toEqual([]);
    expect(wide.rows[2]?.detailMatch).toEqual([3]);

    await tui.send({ op: 'keys', keys: ['r', 'd'] });
    const narrowed = pickerOf(tui);
    expect(narrowed.rows.map((row) => row.label)).toEqual(['orders']);
    expect(narrowed.rows[0]?.match).toEqual([0, 1, 2]);
    expect(narrowed.rows[0]?.value).toBe('/projects/orders');
  }, 40_000);

  it('says which field to answer first instead of listing every checkout', async () => {
    const tui = await boot();
    await openVerb(tui, 'add target');
    await blankAddTarget(tui);
    await tui.send({ op: 'keys', keys: ['\t'] });
    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 200 });

    const state = pickerOf(tui);
    expect(state.kind).toBe('checkout');
    expect(state.rows).toEqual([]);
    expect(state.note).toContain('choose a repo first');
  }, 40_000);

  it('scopes checkouts to the chosen repo and invalidates them when it changes', async () => {
    const tui = await boot();
    await openVerb(tui, 'add target');
    await blankAddTarget(tui);
    await tui.send({ op: 'keys', keys: ['o', 'r', 'd'] });
    await tui.send({ op: 'settle', ms: 300 });
    await tui.send({ op: 'keys', keys: ['\r'] });

    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(pickerOf(tui).rows.map((row) => row.value)).toEqual([
      '/projects/orders-feat-ports',
      '/projects/orders',
    ]);
    await tui.send({ op: 'keys', keys: ['\r'] });
    expect(tui.snapshot().formValues.checkoutPath).toBe('/projects/orders-feat-ports');

    // Back to the repo field, and pick a different repo.
    await tui.send({ op: 'keys', keys: ['\u001b[A', '\u001b[A'] });
    await tui.send({ op: 'keys', keys: ['b'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(pickerOf(tui).rows.map((row) => row.label)).toEqual(['billing']);
    await tui.send({ op: 'keys', keys: ['\r'] });

    expect(tui.snapshot().formValues.repoPath).toBe('/projects/billing');
    expect(tui.snapshot().formValues.checkoutPath).toBe('');

    // …and the checkout picker now offers only the new repo's worktree.
    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(pickerOf(tui).rows.map((row) => row.value)).toEqual(['/projects/billing']);
  }, 60_000);

  it('picks a row with the mouse', async () => {
    const tui = await boot();
    await openVerb(tui, 'add target');
    await blankAddTarget(tui);
    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 300 });

    const at = rowOf(tui.frame(), 'studio', MAIN);
    const col = colOf(tui.frame(), at, 'studio');
    await tui.send({ op: 'click', col, row: at });

    expect(tui.snapshot().mode).toBe('form');
    expect(tui.snapshot().formValues.repoPath).toBe('/projects/studio');
  }, 40_000);

  it('Esc returns to the form without filling it or calling the daemon', async () => {
    const tui = await boot();
    const before = requestLog().length;
    await openVerb(tui, 'add target');
    await blankAddTarget(tui);
    await tui.send({ op: 'keys', keys: ['\r'] });
    await tui.send({ op: 'settle', ms: 300 });
    expect(tui.snapshot().mode).toBe('picker');

    await tui.send({ op: 'keys', keys: ['\u001b'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(tui.snapshot().mode).toBe('form');
    expect(tui.snapshot().formValues.repoPath ?? '').toBe('');
    expect(
      requestLog()
        .slice(before)
        .some((entry) => entry.method === METHODS.targetAdd),
    ).toBe(false);
  }, 40_000);

  it('scopes the command picker to the target, falling back to its playbook', async () => {
    const tui = await boot();
    const before = requestLog().length;
    await openVerb(tui, 'query logs');
    expect(tui.snapshot().formValues.target).toBe(ROWS[0]!.slug);

    // Typing on a filled target field opens the picker rather than editing it.
    await tui.send({ op: 'keys', keys: ['p'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(pickerOf(tui).kind).toBe('target');
    expect(pickerOf(tui).rows.map((row) => row.label)).toEqual(['ports']);
    await tui.send({ op: 'keys', keys: ['\r'] });
    expect(tui.snapshot().formValues.target).toBe(ROWS[1]!.slug);

    // That target has never run, so its labels come from the resolved playbook.
    const field = rowOf(tui.frame(), 'command', MAIN);
    await tui.send({ op: 'click', col: colOf(tui.frame(), field, 'command'), row: field });
    await tui.send({ op: 'settle', ms: 300 });
    expect(pickerOf(tui).kind).toBe('label');
    expect(pickerOf(tui).rows.map((row) => row.value)).toEqual(['API', 'Build', 'Web']);
    expect(
      requestLog()
        .slice(before)
        .some(
          (entry) =>
            entry.method === METHODS.configResolve &&
            (entry.params as { target?: string } | null)?.target === ROWS[1]!.slug,
        ),
    ).toBe(true);

    await tui.send({ op: 'keys', keys: ['\u001b[B', '\r'] });
    expect(tui.snapshot().formValues.label).toBe('Build');
  }, 60_000);

  it('keeps a 40-repo picker inside its pane and scrolls it with the wheel', async () => {
    const tui = await boot();
    try {
      await tui.send({ op: 'request', method: 'test.repos', params: { count: 40 } });
      await openVerb(tui, 'add target');
      await blankAddTarget(tui);
      await tui.send({ op: 'keys', keys: ['\r'] });
      await tui.send({ op: 'settle', ms: 400 });

      expect(pickerOf(tui).rows.length).toBe(43);
      const drawn = tui.frame().filter((line) => line.includes('synthetic-')).length;
      expect(drawn).toBeGreaterThan(0);
      expect(drawn).toBeLessThanOrEqual(HEIGHT - 4);
      // The chrome is still on screen, so the list did not push the pane apart.
      expect(tui.frame().join('\n')).toContain('Enter picks');

      const top = tui.frame()[rowOf(tui.frame(), 'billing', MAIN) - 1];
      await tui.send({ op: 'wheel', col: SIDEBAR_WIDTH + 20, row: 10, dir: 'down', n: 12 });
      expect(pickerOf(tui).index).toBeGreaterThan(0);
      expect(tui.frame()[rowOf(tui.frame(), 'synthetic-', MAIN) - 1]).not.toBe(top);
    } finally {
      await tui.send({ op: 'request', method: 'test.repos', params: { count: 0 } });
    }
  }, 60_000);
});

describe('keys', () => {
  it('j and k walk the sidebar, arrows do the same', async () => {
    const tui = await boot();
    expect(tui.snapshot().selected).toBe(ROWS[0]!.slug);
    await tui.send({ op: 'keys', keys: ['j', 'j'] });
    expect(tui.snapshot().selected).toBe(ROWS[2]!.slug);
    await tui.send({ op: 'keys', keys: ['\u001b[A'] });
    expect(tui.snapshot().selected).toBe(ROWS[1]!.slug);
    await tui.send({ op: 'keys', keys: ['\u001b[B', '\u001b[B'] });
    expect(tui.snapshot().selected).toBe(ROWS[3]!.slug);
  }, 30_000);

  it('s starts a stopped target and stops a running one', async () => {
    const tui = await boot();
    await tui.send({ op: 'keys', keys: ['s'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(
      requestLog().some(
        (entry) =>
          entry.method === METHODS.runStop &&
          (entry.params as { target?: string } | null)?.target === ROWS[0]!.slug,
      ),
    ).toBe(true);
  }, 30_000);

  it('/ searches within the log buffer', async () => {
    const tui = await boot();
    await tui.send({ op: 'settle', ms: 200 });
    await tui.send({ op: 'keys', keys: ['/', 'l', 'i', 's', 't', 'e', 'n', '\r'] });
    expect(tui.snapshot().search).toBe('listen');
    await tui.send({ op: 'settle', ms: 200 });
    const pane = tui.frame().join('\n');
    expect(pane).toContain('Now listening');
    expect(pane).not.toContain('Determining projects');
  }, 30_000);

  it('y copies the visible filtered buffer with the ANSI stripped', async () => {
    const tui = await boot();
    await tui.send({ op: 'settle', ms: 200 });
    await tui.send({ op: 'keys', keys: ['y'] });
    const copied = tui.snapshot().copied ?? '';
    expect(copied).toContain('[API] Now listening on http://localhost:5010');
    expect(copied).toContain('[Web] vite: port taken');
    expect(copied).not.toContain('\u001b[');
  }, 30_000);

  it('y copies only the highlighted text when a selection is live', async () => {
    const tui = await boot();
    await tui.send({ op: 'settle', ms: 200 });
    const row = rowOf(tui.frame(), 'Now listening', MAIN);
    const from = colOf(tui.frame(), row, 'Now listening');
    await tui.send({ op: 'drag', fromCol: from, fromRow: row, toCol: from + 13, toRow: row });
    await tui.send({ op: 'keys', keys: ['y'] });
    const copied = tui.snapshot().copied ?? '';
    expect(copied).toContain('Now listening');
    expect(copied).not.toContain('[API]');
    expect(copied).not.toContain('vite: port taken');
    expect(tui.snapshot().status).toBe('copied selection');
  }, 30_000);

  it('starts a selection on the pane’s bottom row, not just the rows above it', async () => {
    const tui = await boot();
    await tui.send({ op: 'request', method: 'test.flood', params: { lines: 200 } });
    await tui.send({ op: 'settle', ms: 400 });
    const frame = tui.frame();
    // The row above the log box's bottom border: the one a clipped pane loses.
    const last = rowOf(frame, '└', MAIN) - 1;
    const newest = /flood \d+/.exec(frame[last - 1] ?? '')?.[0] ?? '';
    expect(newest).not.toBe('');

    const from = colOf(frame, last, 'flood');
    await tui.send({ op: 'drag', fromCol: from, fromRow: last, toCol: WIDTH - 2, toRow: last });
    await tui.send({ op: 'keys', keys: ['y'] });
    expect(tui.snapshot().copied).toBe(newest);
    expect(tui.snapshot().status).toBe('copied selection');
  }, 60_000);

  it('R offers a per-command restart picker', async () => {
    const tui = await boot();
    await tui.send({ op: 'keys', keys: ['R'] });
    expect(tui.snapshot().mode).toBe('command');
    await tui.send({ op: 'keys', keys: ['2'] });
    await tui.send({ op: 'settle', ms: 200 });
    expect(tui.snapshot().mode).toBe('browse');
    expect(
      requestLog().some(
        (entry) =>
          entry.method === METHODS.runRestart &&
          (entry.params as { command?: string } | null)?.command === 'API',
      ),
    ).toBe(true);
  }, 30_000);

  it('mentions in the footer that q leaves the daemon running', async () => {
    const tui = await boot({ width: 220, height: 30 });
    const footer = tui.frame()[rowOf(tui.frame(), 'start/stop') - 1] ?? '';
    expect(footer).toContain('q quits the TUI only');
    expect(footer).toContain('Shift+drag selects natively');
  }, 30_000);
});
