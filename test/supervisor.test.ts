import { afterEach, describe, expect, it } from 'bun:test';

import {
  BackoffTracker,
  backoffDelay,
  DEFAULT_BACKOFF,
  nextAttempt,
} from '../src/supervisor/backoff.js';
import { KILL_GRACE_MS } from '../src/supervisor/kill.js';
import {
  type RunHandle,
  type StartOptions,
  startRun,
  Supervisor,
} from '../src/supervisor/supervisor.js';
import type { CommandState, LogEntry, PlaybookCommand } from '../src/types.js';
import { chatty, isAlive, service, spawner, ticker, waitFor } from './helpers.js';

interface Harness {
  run: RunHandle;
  output: LogEntry[];
  statuses: CommandState[][];
  text: (label: string) => string;
  state: (label: string) => CommandState;
  pid: (label: string) => number;
}

const live: RunHandle[] = [];

function launch(commands: PlaybookCommand[], overrides: Partial<StartOptions> = {}): Harness {
  const output: LogEntry[] = [];
  const statuses: CommandState[][] = [];
  const run = startRun({
    playbook: { name: 'test', commands },
    cwd: process.cwd(),
    env: inheritedEnv(),
    onOutput: (entry) => output.push(entry),
    onStatus: (snapshot) => statuses.push(snapshot),
    // Real kills, but the escalation window is short so the suite doesn't spend
    // a minute waiting for taskkill. One test below uses the real default.
    killGraceMs: 200,
    backoff: { baseMs: 20, maxMs: 40, healthyMs: 60_000 },
    ...overrides,
  });
  live.push(run);
  const state = (label: string): CommandState => {
    const found = run.commands.find((command) => command.label === label);
    if (!found) throw new Error(`no command ${label}`);
    return found;
  };
  return {
    run,
    output,
    statuses,
    state,
    text: (label) =>
      output
        .filter((entry) => entry.label === label && !entry.text.startsWith('run-mux:'))
        .map((entry) => entry.text)
        .join(''),
    pid: (label) => {
      const pid = state(label).pid;
      if (pid === undefined) throw new Error(`${label} has no pid`);
      return pid;
    },
  };
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function indexOfEntry(output: LogEntry[], label: string, needle: string): number {
  return output.findIndex((entry) => entry.label === label && entry.text.includes(needle));
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((run) => run.stop().catch(() => {})));
});

describe('backoff', () => {
  it('doubles from 500ms', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n))).toEqual([
      500, 1000, 2000, 4000, 8000, 16_000,
    ]);
  });

  it('caps at 30s', () => {
    expect(backoffDelay(7)).toBe(30_000);
    expect(backoffDelay(8)).toBe(30_000);
    expect(backoffDelay(200)).toBe(30_000);
  });

  it('resets the counter after 60s of healthy running', () => {
    expect(nextAttempt(4, DEFAULT_BACKOFF.healthyMs - 1)).toBe(5);
    expect(nextAttempt(4, DEFAULT_BACKOFF.healthyMs)).toBe(1);

    const tracker = new BackoffTracker();
    expect(tracker.recordExit(10)).toBe(500);
    expect(tracker.recordExit(10)).toBe(1000);
    expect(tracker.recordExit(10)).toBe(2000);
    expect(tracker.attempt).toBe(3);
    expect(tracker.recordExit(60_000)).toBe(500);
    expect(tracker.attempt).toBe(1);
    expect(tracker.recordExit(59_999)).toBe(1000);
  });

  it('honours an overridden config', () => {
    const config = { baseMs: 10, maxMs: 25, healthyMs: 100 };
    const tracker = new BackoffTracker(config);
    expect(tracker.recordExit(0)).toBe(10);
    expect(tracker.recordExit(0)).toBe(20);
    expect(tracker.recordExit(0)).toBe(25);
    expect(tracker.recordExit(100)).toBe(10);
    tracker.reset();
    expect(tracker.attempt).toBe(0);
  });
});

describe('dependency gating', () => {
  it('starts a dependent only after its task exits 0', async () => {
    const harness = launch([
      {
        label: 'build',
        type: 'task',
        command: ticker(['--lines', '2', '--interval', '30', '--label', 'build']),
      },
      {
        label: 'web',
        command: service(['--label', 'web', '--interval', '40']),
        dependsOn: ['build'],
      },
    ]);

    expect(harness.state('web').status).toBe('pending');
    expect(harness.run.status).toBe('starting');

    await waitFor(() => harness.text('web').includes('web: tick 1'), { label: 'web running' });

    expect(harness.state('build').status).toBe('exited');
    expect(harness.state('build').exitCode).toBe(0);
    expect(harness.state('web').status).toBe('running');
    expect(harness.run.status).toBe('running');

    const lastBuild = indexOfEntry(harness.output, 'build', 'build 2/2');
    const firstWeb = indexOfEntry(harness.output, 'web', 'web: tick 1');
    expect(lastBuild).toBeGreaterThanOrEqual(0);
    expect(lastBuild).toBeLessThan(firstWeb);
  });

  it('leaves a command depending on a service pending and says why', async () => {
    const harness = launch([
      { label: 'db', command: service(['--label', 'db']) },
      { label: 'web', command: service(['--label', 'web']), dependsOn: ['db'] },
    ]);

    await waitFor(() => harness.state('db').status === 'running', { label: 'db running' });

    expect(harness.state('web').status).toBe('pending');
    expect(harness.state('web').pid).toBeUndefined();
    const notes = harness.output.filter((entry) => entry.label === 'web');
    expect(notes.map((entry) => entry.text).join('')).toContain('never exits 0');
    expect(harness.run.status).toBe('degraded');
  });
});

describe('failure cascade', () => {
  it('cascades a failed task to its dependents and leaves the rest running', async () => {
    const harness = launch([
      {
        label: 'build',
        type: 'task',
        command: ticker(['--lines', '1', '--interval', '20', '--exit', '3', '--label', 'build']),
      },
      { label: 'test', type: 'task', command: ticker(['--lines', '1']), dependsOn: ['build'] },
      { label: 'web', command: service(['--label', 'web']), dependsOn: ['test'] },
      { label: 'db', command: service(['--label', 'db', '--interval', '40']) },
    ]);

    await waitFor(() => harness.state('web').status === 'errored', { label: 'cascade' });

    expect(harness.state('build').status).toBe('errored');
    expect(harness.state('build').exitCode).toBe(3);
    expect(harness.state('test').status).toBe('errored');
    expect(harness.state('test').startedAt).toBeUndefined();
    expect(harness.state('web').startedAt).toBeUndefined();

    const dbPid = harness.pid('db');
    expect(harness.state('db').status).toBe('running');
    expect(isAlive(dbPid)).toBe(true);
    await waitFor(() => harness.text('db').includes('db: tick 2'), { label: 'db still ticking' });
    expect(harness.run.status).toBe('degraded');
  });

  it('does not cascade when a service fails', async () => {
    const harness = launch([
      {
        label: 'api',
        restart: 'never',
        command: service(['--label', 'api', '--crash-after', '60', '--exit', '9']),
      },
      { label: 'db', command: service(['--label', 'db', '--interval', '40']) },
    ]);

    await waitFor(() => harness.state('api').status === 'errored', { label: 'api crash' });

    expect(harness.state('api').exitCode).toBe(9);
    expect(harness.state('db').status).toBe('running');
    expect(isAlive(harness.pid('db'))).toBe(true);
    expect(harness.run.status).toBe('degraded');
  });
});

describe('restart policy', () => {
  it('restarts a crashing service under on-failure', async () => {
    const harness = launch([
      {
        label: 'api',
        restart: 'on-failure',
        command: service(['--label', 'api', '--crash-after', '80', '--exit', '7']),
      },
    ]);

    await waitFor(() => harness.state('api').restarts >= 2, { label: 'two restarts' });
    await waitFor(() => harness.state('api').status === 'running', { label: 'back up' });
    expect(harness.state('api').pid).toBeDefined();
  });

  it('leaves a crashing service dead when the playbook asks for no policy', async () => {
    const harness = launch([
      {
        label: 'api',
        command: service(['--label', 'api', '--crash-after', '60', '--exit', '7']),
      },
      {
        label: 'clock',
        type: 'task',
        command: ticker(['--lines', '6', '--interval', '60', '--label', 'clock']),
      },
    ]);

    await waitFor(() => harness.state('clock').status === 'exited', { label: 'clock done' });

    expect(harness.state('api').status).toBe('errored');
    expect(harness.state('api').restarts).toBe(0);
  });

  it('does not restart under never, and the run reports failed', async () => {
    const harness = launch([
      {
        label: 'api',
        restart: 'never',
        command: service(['--label', 'api', '--crash-after', '60', '--exit', '7']),
      },
      {
        label: 'clock',
        type: 'task',
        command: ticker(['--lines', '6', '--interval', '60', '--label', 'clock']),
      },
    ]);

    // The clock is the wait, so nothing here sleeps a fixed duration: by the
    // time it has run its course a restart would long since have happened.
    await waitFor(() => harness.state('clock').status === 'exited', { label: 'clock done' });

    expect(harness.state('api').status).toBe('errored');
    expect(harness.state('api').exitCode).toBe(7);
    expect(harness.state('api').restarts).toBe(0);
    expect(harness.run.status).toBe('failed');
  });

  it('restarts a successful task under always', async () => {
    const harness = launch([
      {
        label: 'poll',
        type: 'task',
        restart: 'always',
        command: ticker(['--lines', '1', '--interval', '20', '--label', 'poll']),
      },
    ]);

    await waitFor(() => harness.state('poll').restarts >= 2, { label: 'repeat runs' });

    expect(harness.state('poll').restarts).toBeGreaterThanOrEqual(2);
    expect(harness.text('poll').split('poll 1/1').length - 1).toBeGreaterThanOrEqual(2);
  });
});

describe('stopping', () => {
  it('kills a grandchild the direct kill would miss', async () => {
    const harness = launch([{ label: 'tree', command: spawner() }]);

    await waitFor(() => /grandchild pid (\d+)/.test(harness.text('tree')), {
      label: 'grandchild pid',
    });
    const match = /grandchild pid (\d+)/.exec(harness.text('tree'));
    const grandchild = Number(match?.[1]);
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(isAlive(grandchild)).toBe(true);

    const parent = harness.pid('tree');
    await harness.run.stop();

    expect(isAlive(grandchild)).toBe(false);
    expect(isAlive(parent)).toBe(false);
    expect(harness.run.status).toBe('stopped');
    expect(harness.state('tree').status).toBe('stopped');
  });

  it('force kills a child that ignores the polite signal, inside the grace window', async () => {
    const harness = launch(
      [{ label: 'stubborn', command: service(['--label', 'stubborn', '--ignore-sigterm']) }],
      { killGraceMs: undefined },
    );

    await waitFor(() => harness.text('stubborn').includes('stubborn: tick 1'), {
      label: 'stubborn up',
    });
    const pid = harness.pid('stubborn');

    const startedAt = Date.now();
    await harness.run.stop();
    const elapsed = Date.now() - startedAt;

    expect(isAlive(pid)).toBe(false);
    // The escalation is capped, not open-ended; the slack covers how long
    // spawning taskkill.exe takes on a Windows box with a scanner in the way.
    expect(elapsed).toBeLessThan(KILL_GRACE_MS + 8000);
  }, 25_000);

  it('shares one kill between concurrent stop calls', async () => {
    const harness = launch([
      { label: 'a', command: service(['--label', 'a']) },
      { label: 'b', command: service(['--label', 'b']) },
    ]);

    await waitFor(
      () => harness.state('a').status === 'running' && harness.state('b').status === 'running',
      { label: 'both up' },
    );
    const pids = [harness.pid('a'), harness.pid('b')];

    const first = harness.run.stop();
    const second = harness.run.stop();
    expect(second).toBe(first);
    await Promise.all([first, second, harness.run.stop()]);

    for (const pid of pids) expect(isAlive(pid)).toBe(false);
    expect(harness.run.status).toBe('stopped');
  });

  it('marks a pending command stopped rather than leaving it hanging', async () => {
    const harness = launch([
      {
        label: 'build',
        type: 'task',
        command: ticker(['--lines', '20', '--interval', '80', '--label', 'build']),
      },
      { label: 'web', command: service(['--label', 'web']), dependsOn: ['build'] },
    ]);

    await waitFor(() => harness.text('build').includes('build 1/20'), { label: 'build up' });
    await harness.run.stop();

    expect(harness.state('build').status).toBe('stopped');
    expect(harness.state('web').status).toBe('stopped');
  });
});

describe('restartCommand', () => {
  it('restarts only the named command', async () => {
    const harness = launch([
      { label: 'a', command: service(['--label', 'a', '--interval', '40']) },
      { label: 'b', command: service(['--label', 'b', '--interval', '40']) },
    ]);

    await waitFor(
      () => harness.state('a').status === 'running' && harness.state('b').status === 'running',
      { label: 'both up' },
    );
    const before = { a: harness.pid('a'), b: harness.pid('b') };

    await harness.run.restartCommand('a');

    expect(harness.state('a').status).toBe('running');
    expect(harness.state('a').pid).not.toBe(before.a);
    expect(harness.state('a').restarts).toBe(1);
    expect(isAlive(before.a)).toBe(false);

    expect(harness.state('b').pid).toBe(before.b);
    expect(isAlive(before.b)).toBe(true);
    await waitFor(() => harness.text('a').includes('a: tick 1'), { label: 'a back up' });
  });

  it('rejects an unknown label', async () => {
    const harness = launch([{ label: 'a', command: service(['--label', 'a']) }]);
    await expect(harness.run.restartCommand('nope')).rejects.toThrow(/unknown command/);
  });
});

describe('output', () => {
  it('tags stdout and stderr distinctly, per label', async () => {
    const harness = launch([
      {
        label: 'out',
        type: 'task',
        command: ticker(['--lines', '2', '--interval', '20', '--label', 'OUT']),
      },
      {
        label: 'err',
        type: 'task',
        command: ticker(['--lines', '2', '--interval', '20', '--label', 'ERR', '--stderr']),
      },
    ]);

    await waitFor(
      () => harness.state('out').status === 'exited' && harness.state('err').status === 'exited',
      { label: 'both done' },
    );

    const fromOut = harness.output.filter((entry) => entry.label === 'out');
    const fromErr = harness.output.filter((entry) => entry.label === 'err');
    expect(fromOut.length).toBeGreaterThan(0);
    expect(fromErr.length).toBeGreaterThan(0);
    expect(fromOut.every((entry) => entry.stream === 'stdout')).toBe(true);
    expect(fromErr.every((entry) => entry.stream === 'stderr')).toBe(true);
    expect(harness.text('out')).toContain('OUT 2/2');
    expect(harness.text('err')).toContain('ERR 2/2');
    expect(fromOut.every((entry) => entry.ts > 0)).toBe(true);
  });

  it('passes every chunk through without trimming', async () => {
    const harness = launch([
      {
        label: 'noisy',
        type: 'task',
        command: chatty(['--lines', '300', '--size', '120', '--label', 'noisy']),
      },
    ]);

    await waitFor(() => harness.state('noisy').status === 'exited', { label: 'noisy done' });

    const lines = harness.text('noisy').split('\n').filter(Boolean);
    expect(lines).toHaveLength(300);
    expect(lines[0]).toContain('noisy 1 ');
    expect(lines[299]).toContain('noisy 300 ');
  });
});

describe('reporting', () => {
  it('reports each spawn and exit with a pid', async () => {
    const spawns: { label: string; pid: number; startedAt: number }[] = [];
    const exits: { label: string; pid: number }[] = [];
    const harness = launch(
      [
        {
          label: 'once',
          type: 'task',
          command: ticker(['--lines', '1', '--interval', '20', '--label', 'once']),
        },
      ],
      {
        onChildSpawn: (label, pid, startedAt) => spawns.push({ label, pid, startedAt }),
        onChildExit: (label, pid) => exits.push({ label, pid }),
      },
    );

    await waitFor(() => exits.length === 1, { label: 'exit reported' });

    expect(spawns).toHaveLength(1);
    expect(spawns[0].label).toBe('once');
    expect(spawns[0].startedAt).toBeGreaterThan(0);
    expect(exits[0].pid).toBe(spawns[0].pid);
    expect(harness.statuses.length).toBeGreaterThan(0);
  });

  it('reports starting before anything has been spawned', () => {
    const supervisor = new Supervisor({
      playbook: { name: 'idle', commands: [{ label: 'a', command: service() }] },
      cwd: process.cwd(),
      env: inheritedEnv(),
      onOutput: () => {},
      onStatus: () => {},
    });
    expect(supervisor.status).toBe('starting');
    expect(supervisor.commands).toEqual([{ label: 'a', status: 'pending', restarts: 0 }]);
  });
});
