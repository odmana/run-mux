import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Daemon, type DaemonOptions, startDaemon } from '../src/daemon/index.js';
import { connect, type IpcClient, type RpcFailure } from '../src/ipc/index.js';
import { globalConfigPath, statePath } from '../src/paths.js';
import type {
  AmbiguousData,
  CheckoutListResult,
  ConfigReloadResult,
  ConfigResolveResult,
  DaemonStatusResult,
  EnvResolveResult,
  LogsQueryResult,
  PingResult,
  RepoAddResult,
  RepoListResult,
  RunResult,
  TargetAddResult,
  TargetListResult,
  TargetRemoveResult,
  TargetUpdateResult,
  TargetView,
} from '../src/protocol.js';
import { loadState, mutateState, resetSlotIndex } from '../src/state/index.js';
import {
  type AppState,
  type LogEntry,
  type Playbook,
  type PlaybookCommand,
  PROTOCOL_VERSION,
  type TargetRecord,
} from '../src/types.js';
import {
  addWorktree,
  envDump,
  isAlive,
  makeGitRepo,
  service,
  spawner,
  type TempHome,
  ticker,
  useTempHome,
  waitFor,
} from './helpers.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

let home: TempHome;
const daemons: Daemon[] = [];
const clients: IpcClient[] = [];
const scratch: string[] = [];
const strays: ChildProcess[] = [];

beforeEach(() => {
  home = useTempHome();
  resetSlotIndex();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop().catch(() => {})));
  for (const child of strays.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const dir of scratch.splice(0)) remove(dir);
  home.cleanup();
});

function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // A locked git directory just outlives the test run.
  }
}

async function boot(options: DaemonOptions = {}): Promise<IpcClient> {
  const daemon = await startDaemon({ onError: () => {}, killGraceMs: 800, ...options });
  daemons.push(daemon);
  const client = await connect({ timeoutMs: 5000 });
  clients.push(client);
  return client;
}

function repoWith(name: string, playbooks: Playbook[]): string {
  const dir = makeGitRepo(name, playbooks);
  scratch.push(dir);
  return dir;
}

function worktreeOf(repo: string, branch: string): string {
  const dir = addWorktree(repo, branch);
  scratch.push(dir);
  return dir;
}

function pb(name: string, commands: PlaybookCommand[]): Playbook {
  return { name, commands };
}

async function failure(promise: Promise<unknown>): Promise<RpcFailure> {
  try {
    await promise;
  } catch (error) {
    return error as RpcFailure;
  }
  throw new Error('expected the request to fail');
}

async function addTarget(
  client: IpcClient,
  repo: string,
  checkout: string,
  playbookName: string,
): Promise<TargetView> {
  await client.request('repo.add', { path: repo });
  const added = (await client.request('target.add', {
    repoPath: repo,
    checkoutPath: checkout,
    playbookName,
  })) as TargetAddResult;
  return added.target;
}

function pidOf(view: TargetView, label: string): number {
  return view.commands?.find((c) => c.label === label)?.pid as number;
}

async function status(client: IpcClient, target: string): Promise<TargetView> {
  return ((await client.request('run.status', { target })) as RunResult).target;
}

async function waitForStatus(client: IpcClient, target: string, want: string): Promise<TargetView> {
  let view: TargetView | undefined;
  await waitFor(
    async () => {
      view = await status(client, target);
      return view.status === want;
    },
    { interval: 60, label: `${target} to be ${want}` },
  );
  return view as TargetView;
}

async function entriesFor(
  client: IpcClient,
  target: string,
  extra: Record<string, unknown> = {},
): Promise<LogEntry[]> {
  const result = (await client.request('logs.query', { target, ...extra })) as LogsQueryResult;
  return result.entries;
}

async function dumpedEnv(client: IpcClient, target: string): Promise<Record<string, string>> {
  let parsed: Record<string, string> | undefined;
  await waitFor(
    async () => {
      const text = (await entriesFor(client, target)).map((entry) => entry.text).join('');
      const line = text.split('\n').find((l) => l.startsWith('ENV '));
      if (!line) return false;
      parsed = JSON.parse(line.slice(4)) as Record<string, string>;
      return true;
    },
    { interval: 40, label: `${target} env dump` },
  );
  return parsed as Record<string, string>;
}

/** Straight off disk, so a cached in-process state cannot fake persistence. */
function persistedTargets(): TargetRecord[] {
  return (JSON.parse(readFileSync(statePath(), 'utf-8')) as AppState).targets;
}

function patchGlobalConfig(patch: (raw: Record<string, unknown>) => void): void {
  const path = globalConfigPath();
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  patch(raw);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

describe('daemon lifecycle', () => {
  it('answers ping and daemon.status', async () => {
    const client = await boot();
    const pong = (await client.request('ping')) as PingResult;
    expect(pong.protocol).toBe(PROTOCOL_VERSION);
    expect(pong.pid).toBe(process.pid);

    const state = (await client.request('daemon.status')) as DaemonStatusResult;
    expect(state.targets).toBe(0);
    expect(state.running).toBe(0);
    expect(state.stateDir).toContain('state');
  });

  it('rejects an unknown method', async () => {
    const client = await boot();
    expect((await failure(client.request('nope.nope'))).code).toBe('unknown_method');
  });

  it('replies to daemon.stop before tearing the server down', async () => {
    const client = await boot();
    expect(await client.request('daemon.stop')).toEqual({ ok: true });
    await waitFor(() => client.closed, { label: 'the client to notice the shutdown' });
  });
});

describe('ui state', () => {
  it('stores what the TUI sends and answers with it', async () => {
    const client = await boot();
    expect(await client.request('ui.get')).toEqual({ ui: {} });

    await client.request('ui.set', { ui: { sidebarWidth: 44 } });
    await client.request('ui.set', { ui: { collapsedRepos: ['/repos/orders'] } });

    expect(await client.request('ui.get')).toEqual({
      ui: { sidebarWidth: 44, collapsedRepos: ['/repos/orders'] },
    });
    expect(loadState().ui).toEqual({ sidebarWidth: 44, collapsedRepos: ['/repos/orders'] });
  });

  it('rounds a width and drops keys it does not know', async () => {
    const client = await boot();
    await client.request('ui.set', { ui: { sidebarWidth: 41.6, nonsense: 'go away' } });
    expect(await client.request('ui.get')).toEqual({ ui: { sidebarWidth: 42 } });
  });

  it('refuses a value of the wrong type rather than storing it', async () => {
    const client = await boot();
    expect((await failure(client.request('ui.set', { ui: { sidebarWidth: 'wide' } }))).code).toBe(
      'bad_params',
    );
    expect((await failure(client.request('ui.set', { ui: { collapsedRepos: [7] } }))).code).toBe(
      'bad_params',
    );
    expect(await client.request('ui.get')).toEqual({ ui: {} });
  });
});

describe('repos', () => {
  it('registers a real git repo and reports its checkouts and playbooks', async () => {
    const repo = repoWith('add', [
      pb('web', [{ label: 'tick', type: 'task', command: ticker(['--lines', '1']) }]),
    ]);
    const client = await boot();

    const added = (await client.request('repo.add', { path: repo })) as RepoAddResult;
    expect(added.repo.checkouts.map((c) => c.branch)).toEqual(['main']);
    expect(added.repo.playbooks).toEqual([{ name: 'web', source: 'repo' }]);
    expect(added.repo.problems).toEqual([]);

    const listed = (await client.request('repo.list')) as RepoListResult;
    expect(listed.repos).toHaveLength(1);
    expect(listed.repos[0].playbooks).toEqual([{ name: 'web', source: 'repo' }]);

    await client.request('repo.add', { path: repo });
    expect(((await client.request('repo.list')) as RepoListResult).repos).toHaveLength(1);

    expect(await client.request('repo.remove', { path: repo })).toEqual({ removed: true });
    expect(((await client.request('repo.list')) as RepoListResult).repos).toHaveLength(0);
  });

  it('rejects a directory that is not a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-mux-notrepo-'));
    scratch.push(dir);
    const client = await boot();

    const error = await failure(client.request('repo.add', { path: dir }));
    expect(error.code).toBe('bad_params');
    expect(error.message).toContain('not a git repository');
  });

  it('lists the checkouts of a repo with a linked worktree', async () => {
    const repo = repoWith('checkouts', [
      pb('web', [{ label: 'tick', type: 'task', command: ticker(['--lines', '1']) }]),
    ]);
    worktreeOf(repo, 'feature');
    const client = await boot();
    await client.request('repo.add', { path: repo });

    const result = (await client.request('checkout.list', {
      repoPath: repo,
    })) as CheckoutListResult;
    expect(result.checkouts).toHaveLength(2);
    expect(result.checkouts[0].isMain).toBe(true);
    expect(result.checkouts.map((c) => c.branch).sort()).toEqual(['feature', 'main']);
    expect(result.playbooks).toEqual([{ name: 'web', source: 'repo' }]);
  });
});

describe('targets', () => {
  it('adds, lists and removes a target', async () => {
    const repo = repoWith('targets', [
      pb('web', [{ label: 'tick', type: 'task', command: ticker(['--lines', '1']) }]),
    ]);
    const client = await boot();

    const target = await addTarget(client, repo, repo, 'web');
    expect(target.slug).toMatch(/\/main:web$/);
    expect(target.isMain).toBe(true);
    expect(target.slot).toBe(0);
    expect(target.branch).toBe('main');
    expect(target.status).toBe('stopped');
    expect(target.available).toBe(true);
    expect(target.autostart).toBe(false);

    const listed = (await client.request('target.list')) as TargetListResult;
    expect(listed.targets.map((t) => t.slug)).toEqual([target.slug]);

    const removed = (await client.request('target.remove', {
      target: target.slug,
    })) as TargetRemoveResult;
    expect(removed).toEqual({ removed: true, slug: target.slug });
    expect(((await client.request('target.list')) as TargetListResult).targets).toHaveLength(0);
  });

  it('refuses a playbook that does not exist and a duplicate target', async () => {
    const repo = repoWith('dupes', [
      pb('web', [{ label: 'tick', type: 'task', command: ticker(['--lines', '1']) }]),
    ]);
    const client = await boot();
    await client.request('repo.add', { path: repo });

    const missing = await failure(
      client.request('target.add', { repoPath: repo, checkoutPath: repo, playbookName: 'nope' }),
    );
    expect(missing.code).toBe('not_found');

    await client.request('target.add', {
      repoPath: repo,
      checkoutPath: repo,
      playbookName: 'web',
    });
    const duplicate = await failure(
      client.request('target.add', { repoPath: repo, checkoutPath: repo, playbookName: 'web' }),
    );
    expect(duplicate.code).toBe('conflict');
  });

  it('reports every candidate when a prefix is ambiguous', async () => {
    const repo = repoWith('ambiguous', [
      pb('web', [{ label: 'tick', type: 'task', command: ticker(['--lines', '1']) }]),
      pb('worker', [{ label: 'tick', type: 'task', command: ticker(['--lines', '1']) }]),
    ]);
    const client = await boot();
    const web = await addTarget(client, repo, repo, 'web');
    const worker = (
      (await client.request('target.add', {
        repoPath: repo,
        checkoutPath: repo,
        playbookName: 'worker',
      })) as TargetAddResult
    ).target;

    const prefix = web.slug.slice(0, web.slug.indexOf(':'));
    const error = await failure(client.request('run.status', { target: prefix }));
    expect(error.code).toBe('ambiguous');
    expect(error.message).toContain(web.slug);
    expect(error.message).toContain(worker.slug);
    expect((error.data as AmbiguousData | undefined)?.matches).toEqual([web.slug, worker.slug]);

    const missing = await failure(client.request('run.status', { target: 'nothing' }));
    expect(missing.code).toBe('not_found');
    expect(missing.data).toBeUndefined();
  });

  it('reports a target whose checkout has gone as unavailable and refuses to start it', async () => {
    const repo = repoWith('vanish', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api']) }]),
    ]);
    const worktree = worktreeOf(repo, 'gone');
    const client = await boot();
    const target = await addTarget(client, repo, worktree, 'svc');
    expect(target.available).toBe(true);

    remove(worktree);

    const view = await status(client, target.slug);
    expect(view.available).toBe(false);
    expect(view.status).toBe('unavailable');

    const error = await failure(client.request('run.start', { target: target.slug }));
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('is gone');
  });
});

describe('runs', () => {
  it('starts a playbook, reports its commands and kills the whole tree on stop', async () => {
    const repo = repoWith('run', [
      pb('svc', [
        { label: 'api', command: service(['--label', 'api', '--interval', '40']) },
        { label: 'tree', command: spawner() },
      ]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'svc');

    const started = (
      (await client.request('run.start', {
        target: target.slug,
      })) as RunResult
    ).target;
    expect(started.runId).toBeTruthy();

    const running = await waitForStatus(client, target.slug, 'running');
    expect(running.commands?.map((c) => c.label).sort()).toEqual(['api', 'tree']);
    expect(running.commands?.every((c) => c.status === 'running')).toBe(true);

    const pids = (running.commands ?? []).map((c) => c.pid as number);
    expect(pids.every((pid) => typeof pid === 'number')).toBe(true);

    let grandchild = 0;
    await waitFor(
      async () => {
        const text = (await entriesFor(client, target.slug)).map((e) => e.text).join('');
        const match = /grandchild pid (\d+)/.exec(text);
        if (!match) return false;
        grandchild = Number(match[1]);
        return true;
      },
      { interval: 40, label: 'the spawner grandchild' },
    );
    expect(isAlive(grandchild)).toBe(true);

    const stopped = ((await client.request('run.stop', { target: target.slug })) as RunResult)
      .target;
    expect(stopped.status).toBe('stopped');
    expect(stopped.runId).toBeUndefined();

    await waitFor(() => pids.every((pid) => !isAlive(pid)) && !isAlive(grandchild), {
      label: 'the whole process tree to die',
    });
    expect(loadState().children).toEqual([]);
  });

  it('restarts one command and leaves its siblings running', async () => {
    const repo = repoWith('restart', [
      pb('svc', [
        { label: 'a', command: service(['--label', 'a', '--interval', '40']) },
        { label: 'b', command: service(['--label', 'b', '--interval', '40']) },
      ]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'svc');
    await client.request('run.start', { target: target.slug });

    const before = await waitForStatus(client, target.slug, 'running');
    const oldA = pidOf(before, 'a');
    const oldB = pidOf(before, 'b');

    await client.request('run.restart', { target: target.slug, command: 'a' });
    const after = await waitForStatus(client, target.slug, 'running');

    expect(pidOf(after, 'a')).not.toBe(oldA);
    expect(pidOf(after, 'b')).toBe(oldB);
    expect(isAlive(oldB)).toBe(true);
    expect(after.commands?.find((c) => c.label === 'a')?.restarts).toBe(1);
    await waitFor(() => !isAlive(oldA), { label: 'the old command to die' });
  });

  it('stops a running target before starting it again', async () => {
    const repo = repoWith('respawn', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api', '--interval', '40']) }]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'svc');

    await client.request('run.start', { target: target.slug });
    const first = await waitForStatus(client, target.slug, 'running');
    const firstPid = first.commands?.[0]?.pid as number;

    await client.request('run.start', { target: target.slug });
    const second = await waitForStatus(client, target.slug, 'running');

    expect(second.runId).not.toBe(first.runId);
    expect(second.commands?.[0]?.pid).not.toBe(firstPid);
    expect(isAlive(firstPid)).toBe(false);
  });
});

describe('environment', () => {
  it('gives the main worktree slot 0 and a linked worktree slot 1', async () => {
    const repo = repoWith('slots', [
      pb('env', [{ label: 'dump', type: 'task', command: envDump() }]),
    ]);
    const worktree = worktreeOf(repo, 'feature');
    const client = await boot();

    const main = await addTarget(client, repo, repo, 'env');
    const linked = (
      (await client.request('target.add', {
        repoPath: repo,
        checkoutPath: worktree,
        playbookName: 'env',
      })) as TargetAddResult
    ).target;

    await client.request('run.start', { target: main.slug });
    const mainEnv = await dumpedEnv(client, main.slug);
    expect(mainEnv.MUX_SLOT).toBe('0');
    expect(mainEnv.MUX_IS_MAIN).toBe('1');
    expect(mainEnv.MUX_BRANCH).toBe('main');
    expect(mainEnv.MUX_TARGET).toBe(main.slug);
    expect(mainEnv.MUX_PLAYBOOK).toBe('env');
    expect(mainEnv.MUX_CHECKOUT?.toLowerCase()).toBe(repo.toLowerCase());
    expect(mainEnv.MUX_REPO?.toLowerCase()).toBe(repo.toLowerCase());
    expect(mainEnv.MUX_REPO_NAME?.toLowerCase()).toBe(repo.split('/').pop()!.toLowerCase());

    await client.request('run.start', { target: linked.slug });
    const linkedEnv = await dumpedEnv(client, linked.slug);
    expect(linkedEnv.MUX_SLOT).toBe('1');
    expect(linkedEnv.MUX_IS_MAIN).toBe('0');
    expect(linkedEnv.MUX_BRANCH).toBe('feature');
    expect(linkedEnv.MUX_CHECKOUT?.toLowerCase()).toBe(worktree.toLowerCase());
  });

  it('layers daemon, playbook, envFile, target and injected values in that order', async () => {
    const repo = repoWith('precedence', [
      pb('prec', [
        {
          label: 'dump',
          type: 'task',
          command: envDump(['A_VAR', 'B_VAR', 'C_VAR', 'D_VAR']),
          env: {
            B_VAR: 'playbook',
            C_VAR: 'playbook',
            D_VAR: 'playbook',
            MUX_SLOT: 'playbook',
          },
          envFile: '.env.test',
        },
      ]),
    ]);
    writeFileSync(join(repo, '.env.test'), '# a comment\nC_VAR=envfile\nD_VAR="envfile"\n');

    const client = await boot({
      env: {
        ...process.env,
        A_VAR: 'daemon',
        B_VAR: 'daemon',
        C_VAR: 'daemon',
        D_VAR: 'daemon',
      },
    });
    const target = await addTarget(client, repo, repo, 'prec');

    patchGlobalConfig((raw) => {
      raw.targets = { [target.slug]: { env: { D_VAR: 'target', MUX_SLOT: 'target' } } };
    });
    await client.request('config.reload');

    const resolved = (await client.request('env.resolve', {
      target: target.slug,
      command: 'dump',
    })) as EnvResolveResult;
    const source = (name: string): string | undefined =>
      resolved.vars.find((v) => v.name === name)?.source;
    expect(source('A_VAR')).toBe('daemon');
    expect(source('B_VAR')).toBe('playbook');
    expect(source('C_VAR')).toBe('envFile');
    expect(source('D_VAR')).toBe('target');
    expect(source('MUX_SLOT')).toBe('injected');
    expect(resolved.problems).toEqual([]);

    await client.request('run.start', { target: target.slug });
    const env = await dumpedEnv(client, target.slug);
    expect(env.A_VAR).toBe('daemon');
    expect(env.B_VAR).toBe('playbook');
    expect(env.C_VAR).toBe('envfile');
    expect(env.D_VAR).toBe('target');
    expect(env.MUX_SLOT).toBe('0');
  });

  it('resolves only the run-wide layers without a command', async () => {
    const repo = repoWith('envwide', [
      pb('env', [
        { label: 'dump', type: 'task', command: envDump(['E_VAR']), env: { E_VAR: 'playbook' } },
      ]),
    ]);
    const client = await boot({ env: { ...process.env, E_VAR: 'daemon' } });
    const target = await addTarget(client, repo, repo, 'env');

    const resolved = (await client.request('env.resolve', {
      target: target.slug,
    })) as EnvResolveResult;
    expect(resolved.vars.find((v) => v.name === 'E_VAR')?.value).toBe('daemon');
    expect(resolved.vars.find((v) => v.name === 'MUX_TARGET')?.value).toBe(target.slug);
  });
});

describe('logs', () => {
  it('queries entries and filters them by label and timestamp', async () => {
    const repo = repoWith('logs', [
      pb('two', [
        {
          label: 'one',
          type: 'task',
          command: ticker(['--lines', '4', '--interval', '40', '--label', 'alpha']),
        },
        {
          label: 'two',
          type: 'task',
          command: ticker(['--lines', '4', '--interval', '40', '--label', 'beta']),
        },
      ]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'two');
    await client.request('run.start', { target: target.slug });

    await waitFor(
      async () => {
        const text = (await entriesFor(client, target.slug)).map((e) => e.text).join('');
        return text.includes('alpha 4/4') && text.includes('beta 4/4');
      },
      { interval: 40, label: 'both tickers to finish' },
    );

    const all = await entriesFor(client, target.slug);
    const labelled = await entriesFor(client, target.slug, { label: 'one' });
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled.every((entry) => entry.label === 'one')).toBe(true);
    expect(labelled.length).toBeLessThan(all.length);

    const since = all[0].ts;
    const newer = await entriesFor(client, target.slug, { since });
    expect(newer.every((entry) => entry.ts > since)).toBe(true);
    expect(newer.length).toBeLessThan(all.length);

    const result = (await client.request('logs.query', {
      target: target.slug,
    })) as LogsQueryResult;
    expect(result.runId).toBeTruthy();
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].playbookSnapshot.name).toBe('two');
  });

  it('streams live entries to a follower that attached after the run started', async () => {
    const repo = repoWith('follow', [
      pb('tick', [
        {
          label: 'tick',
          type: 'task',
          command: ticker(['--lines', '8', '--interval', '30', '--label', 'line']),
        },
      ]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'tick');
    await client.request('run.start', { target: target.slug });

    await waitFor(async () => (await entriesFor(client, target.slug)).length > 0, {
      interval: 20,
      label: 'the first log entry',
    });

    const seen: LogEntry[] = [];
    const stop = await client.subscribe(
      'logs.follow',
      { target: target.slug },
      (data) => void seen.push(data as LogEntry),
    );

    await waitFor(
      () =>
        seen
          .map((e) => e.text)
          .join('')
          .includes('line 8/8'),
      {
        interval: 20,
        label: 'the follower to see every line',
      },
    );
    const text = seen.map((e) => e.text).join('');
    for (let i = 1; i <= 8; i++) expect(text).toContain(`line ${i}/8`);

    await stop();
  });

  it('stops delivering once the subscriber unsubscribes', async () => {
    const repo = repoWith('unfollow', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api', '--interval', '30']) }]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'svc');
    await client.request('run.start', { target: target.slug });

    const seen: LogEntry[] = [];
    const stop = await client.subscribe(
      'logs.follow',
      { target: target.slug },
      (data) => void seen.push(data as LogEntry),
    );
    await waitFor(() => seen.length > 0, { interval: 20, label: 'the first streamed entry' });

    await stop();
    const frozen = seen.length;
    const before = (await entriesFor(client, target.slug)).length;
    await waitFor(async () => (await entriesFor(client, target.slug)).length > before + 2, {
      interval: 40,
      label: 'the run to keep producing output',
    });
    expect(seen.length).toBe(frozen);
  });
});

describe('config.reload', () => {
  it('marks a running target stale without restarting it', async () => {
    const repo = repoWith('stale', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api', '--interval', '40']) }]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'svc');
    await client.request('run.start', { target: target.slug });
    const before = await waitForStatus(client, target.slug, 'running');
    const pid = before.commands?.[0]?.pid as number;
    expect(before.staleDefinition).toBe(false);

    const unchanged = (await client.request('config.reload')) as ConfigReloadResult;
    expect(unchanged.stale).toEqual([]);

    writeFileSync(
      join(repo, '.run-mux.json'),
      JSON.stringify(
        {
          playbooks: [
            pb('svc', [
              { label: 'api', command: service(['--label', 'changed', '--interval', '40']) },
            ]),
          ],
        },
        null,
        2,
      ),
    );

    const reloaded = (await client.request('config.reload')) as ConfigReloadResult;
    expect(reloaded.stale).toEqual([target.slug]);
    expect(reloaded.problems).toEqual([]);

    const after = await status(client, target.slug);
    expect(after.staleDefinition).toBe(true);
    expect(after.commands?.[0]?.pid).toBe(pid);
    expect(after.runId).toBe(before.runId);
    expect(isAlive(pid)).toBe(true);
  });

  it('resolves the playbook behind a target', async () => {
    const repo = repoWith('resolve', [
      pb('web', [{ label: 'tick', type: 'task', command: ticker(['--lines', '1']) }]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'web');

    const resolved = (await client.request('config.resolve', {
      target: target.slug,
    })) as ConfigResolveResult;
    expect(resolved.source).toBe('repo');
    expect(resolved.playbook.name).toBe('web');
    expect(resolved.playbook.commands.map((c) => c.label)).toEqual(['tick']);
    expect(resolved.problems).toEqual([]);
  });
});

describe('orphan reaping', () => {
  it('kills a recorded child whose creation time matches and spares a reused pid', async () => {
    const fixture = join(FIXTURES, 'service.mjs');
    const startedAt = Date.now();
    const doomed = spawn(process.execPath, [fixture, '--label', 'doomed'], { stdio: 'ignore' });
    const survivor = spawn(process.execPath, [fixture, '--label', 'survivor'], { stdio: 'ignore' });
    strays.push(doomed, survivor);

    const doomedPid = doomed.pid as number;
    const survivorPid = survivor.pid as number;
    await waitFor(() => isAlive(doomedPid) && isAlive(survivorPid), { label: 'both fixtures' });

    mutateState((state) => {
      state.children = [
        { pid: doomedPid, startedAt, label: 'doomed', targetSlug: 'repo/main:svc' },
        {
          pid: survivorPid,
          startedAt: startedAt - 3_600_000,
          label: 'survivor',
          targetSlug: 'repo/main:svc',
        },
      ];
    });

    const daemon = await startDaemon({ onError: () => {} });
    daemons.push(daemon);

    expect(daemon.reaped?.killed.map((record) => record.label)).toEqual(['doomed']);
    expect(daemon.reaped?.skipped.map((s) => s.reason)).toEqual(['mismatch']);
    await waitFor(() => !isAlive(doomedPid), { label: 'the orphan to die' });
    expect(isAlive(survivorPid)).toBe(true);
    expect(loadState().children).toEqual([]);
  }, 20_000);

  it('leaves state clean when a recorded child is already gone', async () => {
    const fixture = join(FIXTURES, 'ticker.mjs');
    const child = spawn(process.execPath, [fixture, '--lines', '1', '--interval', '5'], {
      stdio: 'ignore',
    });
    const pid = child.pid as number;
    await waitFor(() => !isAlive(pid), { label: 'the fixture to exit' });

    mutateState((state) => {
      state.children = [{ pid, startedAt: Date.now(), label: 'gone', targetSlug: 'repo/main:svc' }];
    });

    const daemon = await startDaemon({ onError: () => {} });
    daemons.push(daemon);
    expect(daemon.reaped?.killed).toEqual([]);
    expect(daemon.reaped?.skipped.map((s) => s.reason)).toEqual(['gone']);
    expect(loadState().children).toEqual([]);
  });
});

describe('autostart', () => {
  it('sets and clears the flag through target.update and writes it to disk', async () => {
    const repo = repoWith('setflag', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api', '--interval', '40']) }]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'svc');
    expect(target.autostart).toBe(false);

    const on = (await client.request('target.update', {
      target: target.slug,
      autostart: true,
    })) as TargetUpdateResult;
    expect(on.target.autostart).toBe(true);
    expect(persistedTargets().find((t) => t.slug === target.slug)?.autostart).toBe(true);

    const listed = (await client.request('target.list')) as TargetListResult;
    expect(listed.targets[0].autostart).toBe(true);

    const off = (await client.request('target.update', {
      target: target.slug,
      autostart: false,
    })) as TargetUpdateResult;
    expect(off.target.autostart).toBe(false);
    expect(persistedTargets().find((t) => t.slug === target.slug)?.autostart).toBe(false);
  });

  it('keeps the flag across a daemon restart and resolves a prefix like every other verb', async () => {
    const repo = repoWith('keepflag', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api', '--interval', '40']) }]),
    ]);
    const first = await boot();
    const target = await addTarget(first, repo, repo, 'svc');
    const prefix = target.slug.slice(0, target.slug.indexOf(':'));

    const updated = (await first.request('target.update', {
      target: prefix,
      autostart: true,
    })) as TargetUpdateResult;
    expect(updated.target.slug).toBe(target.slug);

    await first.close();
    await (daemons.pop() as Daemon).stop();

    const client = await boot({ autostart: false });
    const listed = (await client.request('target.list')) as TargetListResult;
    expect(listed.targets.map((t) => t.autostart)).toEqual([true]);
  });

  it('rejects a non-boolean flag and an unknown target', async () => {
    const repo = repoWith('badflag', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api', '--interval', '40']) }]),
    ]);
    const client = await boot();
    const target = await addTarget(client, repo, repo, 'svc');

    const bad = await failure(
      client.request('target.update', { target: target.slug, autostart: 'yes' }),
    );
    expect(bad.code).toBe('bad_params');

    const missing = await failure(
      client.request('target.update', { target: 'nothing', autostart: true }),
    );
    expect(missing.code).toBe('not_found');
    expect(persistedTargets()[0].autostart).toBeUndefined();
  });

  it('restores targets flagged autostart once the server is listening', async () => {
    const repo = repoWith('autostart', [
      pb('svc', [{ label: 'api', command: service(['--label', 'api', '--interval', '40']) }]),
    ]);
    const first = await boot();
    const target = await addTarget(first, repo, repo, 'svc');
    mutateState((state) => {
      state.targets = state.targets.map((t) => ({ ...t, autostart: true }));
    });
    await first.close();
    await (daemons.pop() as Daemon).stop();

    const client = await boot();
    const view = await waitForStatus(client, target.slug, 'running');
    expect(view.autostart).toBe(true);
    expect(view.commands?.[0]?.pid).toBeTypeOf('number');
  });
});
