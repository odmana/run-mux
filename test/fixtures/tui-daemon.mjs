// A daemon for the TUI tests: the whole run-mux RPC surface from canned data,
// plus a `logs.follow` that can be told to flood.
//
// `fake-daemon.mjs` serves the CLI's needs — three canned log entries and then
// `end` — which is the opposite of what the log pane has to be tested against.
// This one keeps every follow open and pushes on demand, so a test can drive
// thousands of lines through the real coalescer.
//
// It runs unbuilt and therefore cannot import the TypeScript sources: the socket
// path and the NDJSON framing are reimplemented here and must stay in step with
// src/paths.ts and src/ipc/framing.ts.
//
//   <state>/tui-daemon.pid            this process's pid, so a test can kill it
//   <state>/tui-daemon-requests.log   one {method, params} per line, as received
//
// Test-only extras, deliberately outside protocol.ts:
//   test.flood      {target?, lines, label?, ansi?}  push lines to every open follow
//   test.followers  {}                               how many follows are open, and on what
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

function hashString(input) {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function socketPath() {
  const root = process.env.RUN_MUX_HOME || undefined;
  if (platform() === 'win32') {
    return `\\\\.\\pipe\\run-mux${root ? `-${hashString(root)}` : ''}`;
  }
  if (root) return join(root, 'daemon.sock').replaceAll('\\', '/');
  const runtime = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(runtime, 'run-mux.sock').replaceAll('\\', '/');
}

function stateDir() {
  const root = process.env.RUN_MUX_HOME;
  return root ? join(root, 'state') : tmpdir();
}

const STATE = stateDir();
mkdirSync(STATE, { recursive: true });
const REQUESTS_LOG = join(STATE, 'tui-daemon-requests.log');
writeFileSync(REQUESTS_LOG, '');
writeFileSync(join(STATE, 'tui-daemon.pid'), `${process.pid}\n`);

const STARTED = Date.now();

// --- canned data ------------------------------------------------------------

const ORDERS = '/projects/orders';
const ORDERS_FEAT = '/projects/orders-feat-ports';
const BILLING = '/projects/billing';
const BILLING_HOTFIX = '/projects/billing-hotfix';
const STUDIO = '/projects/studio';
const STUDIO_FEAT = '/projects/studio-feat-y';

const ORDERS_COMMANDS = [
  { label: 'Build', status: 'exited', exitCode: 0, restarts: 0, startedAt: STARTED - 730_000 },
  { label: 'API', status: 'running', pid: 4242, restarts: 1, startedAt: STARTED - 725_000 },
  { label: 'Web', status: 'running', pid: 4243, restarts: 0, startedAt: STARTED - 720_000 },
];

function targetOf(overrides) {
  return {
    alias: undefined,
    autostart: false,
    commands: [],
    ...overrides,
  };
}

const TARGETS = [
  targetOf({
    slug: 'orders/main:run-orders',
    repoPath: ORDERS,
    repoName: 'orders',
    checkoutPath: ORDERS,
    branch: 'main',
    isMain: true,
    playbookName: 'Run Orders',
    slot: 0,
    available: true,
    status: 'running',
    runId: 'run-0001',
    startedAt: STARTED - 725_000,
    commands: ORDERS_COMMANDS,
  }),
  targetOf({
    slug: 'orders/feat-ports:run-orders',
    alias: 'ports',
    repoPath: ORDERS,
    repoName: 'orders',
    checkoutPath: ORDERS_FEAT,
    branch: 'feat-ports',
    isMain: false,
    playbookName: 'Run Orders',
    slot: 1,
    available: true,
    status: 'stopped',
  }),
  targetOf({
    slug: 'billing/main:dev',
    repoPath: BILLING,
    repoName: 'billing',
    checkoutPath: BILLING,
    branch: 'main',
    isMain: true,
    playbookName: 'dev',
    slot: 0,
    available: true,
    status: 'degraded',
    autostart: true,
    runId: 'run-0007',
    startedAt: STARTED - 45_000,
    staleDefinition: true,
    commands: [
      { label: 'Api', status: 'running', pid: 5150, restarts: 0, startedAt: STARTED - 45_000 },
      { label: 'Worker', status: 'errored', exitCode: 1, restarts: 3, startedAt: STARTED - 30_000 },
    ],
  }),
  targetOf({
    slug: 'billing/hotfix:dev',
    repoPath: BILLING,
    repoName: 'billing',
    checkoutPath: BILLING_HOTFIX,
    branch: 'hotfix',
    isMain: false,
    playbookName: 'dev',
    slot: 2,
    available: true,
    status: 'failed',
  }),
  targetOf({
    slug: 'studio/main:web',
    repoPath: STUDIO,
    repoName: 'studio',
    checkoutPath: STUDIO,
    branch: 'main',
    isMain: true,
    playbookName: 'web',
    slot: 0,
    available: true,
    status: 'running',
    runId: 'run-0011',
    startedAt: STARTED - 88_000,
    commands: [{ label: 'Vite', status: 'running', pid: 6001, restarts: 0 }],
  }),
  targetOf({
    slug: 'studio/feat-y:web',
    repoPath: STUDIO,
    repoName: 'studio',
    checkoutPath: STUDIO_FEAT,
    branch: 'feat-y',
    isMain: false,
    playbookName: 'web',
    slot: 3,
    available: false,
    status: 'unavailable',
  }),
];

const PLAYBOOK = {
  name: 'Run Orders',
  commands: [
    { label: 'Build', type: 'task', command: 'dotnet build' },
    { label: 'API', command: 'dotnet run --project src/Orders.Api', dependsOn: ['Build'] },
    { label: 'Web', command: 'pnpm dev', dependsOn: ['Build'], cwd: 'web' },
  ],
};

const BASE_REPOS = [
  {
    path: ORDERS,
    name: 'orders',
    checkouts: [
      { path: ORDERS, branch: 'main', head: 'a1b2c3d', isMain: true },
      { path: ORDERS_FEAT, branch: 'feat-ports', head: 'e4f5a6b', isMain: false },
    ],
    playbooks: [{ name: 'Run Orders', source: 'repo' }],
    problems: [],
  },
  {
    path: BILLING,
    name: 'billing',
    checkouts: [{ path: BILLING, branch: 'main', head: '9f8e7d6', isMain: true }],
    playbooks: [{ name: 'dev', source: 'global' }],
    problems: [],
  },
  {
    path: STUDIO,
    name: 'studio',
    checkouts: [
      { path: STUDIO, branch: 'main', head: 'c0ffee1', isMain: true },
      { path: STUDIO_FEAT, branch: 'feat-y', head: 'dec0de2', isMain: false },
    ],
    playbooks: [{ name: 'web', source: 'global' }],
    problems: [],
  },
];

/** Mutable so `test.repos` can grow it; `repo.list` always answers from here. */
const REPOS = [...BASE_REPOS];

const RED = '\u001b[31m';
const RESET = '\u001b[0m';

const SEED = [
  { label: 'Build', stream: 'stdout', text: 'Determining projects to restore...\n' },
  { label: 'API', stream: 'stdout', text: 'Now listening on http://localhost:5010\n' },
  { label: 'Web', stream: 'stderr', text: `${RED}vite: port taken${RESET}\n` },
];

const ENV_VARS = [
  { name: 'PATH', value: '/usr/local/bin:/usr/bin', source: 'daemon' },
  { name: 'MUX_SLOT', value: '1', source: 'injected' },
];

// --- protocol ---------------------------------------------------------------

class Failure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function resolveTarget(params) {
  const query = params?.target;
  if (typeof query !== 'string' || query === '') {
    throw new Failure('bad_params', 'target is required');
  }
  const exact = TARGETS.find((t) => t.slug === query || t.alias === query);
  if (exact) return exact;
  const matches = TARGETS.filter((t) => t.slug.includes(query) || (t.alias ?? '').includes(query));
  if (matches.length === 0) throw new Failure('not_found', `no target matches ${query}`);
  if (matches.length > 1) throw new Failure('ambiguous', `${query} matches ${matches.length}`);
  return matches[0];
}

function findRepo(path) {
  if (typeof path !== 'string') return undefined;
  return REPOS.find((repo) => repo.path === path || path.endsWith(repo.path));
}

const METHODS = {
  ping: () => ({
    version: 'tui-stub',
    protocol: 1,
    pid: process.pid,
    uptimeMs: Date.now() - STARTED,
  }),
  'daemon.status': () => ({
    version: 'tui-stub',
    protocol: 1,
    pid: process.pid,
    uptimeMs: Date.now() - STARTED,
    targets: TARGETS.length,
    running: TARGETS.filter((t) => t.status === 'running').length,
    socketPath: socketPath(),
    stateDir: STATE,
  }),
  'repo.add': (params) => ({
    repo: findRepo(params?.path) ?? {
      path: params?.path,
      name: 'added',
      checkouts: [],
      playbooks: [],
      problems: [],
    },
  }),
  'repo.list': () => ({ repos: REPOS }),
  'repo.remove': (params) => ({ removed: Boolean(findRepo(params?.path)) }),
  'checkout.list': (params) => {
    const repo = findRepo(params?.repoPath);
    if (!repo) throw new Failure('not_found', `${params?.repoPath} is not registered`);
    return { checkouts: repo.checkouts, playbooks: repo.playbooks };
  },
  'target.list': () => ({ targets: TARGETS }),
  'target.add': (params) => {
    if (!params?.repoPath || !params?.checkoutPath || !params?.playbookName) {
      throw new Failure('bad_params', 'repoPath, checkoutPath and playbookName are required');
    }
    return { target: { ...TARGETS[0], slug: `added:${params.playbookName}`, status: 'stopped' } };
  },
  'target.update': (params) => {
    const target = resolveTarget(params);
    if (typeof params.autostart === 'boolean') target.autostart = params.autostart;
    return { target };
  },
  'target.remove': (params) => ({ removed: true, slug: resolveTarget(params).slug }),
  'run.start': (params) => {
    const target = resolveTarget(params);
    target.status = 'running';
    target.startedAt = Date.now();
    return { target };
  },
  'run.stop': (params) => {
    const target = resolveTarget(params);
    target.status = 'stopped';
    target.startedAt = undefined;
    return { target };
  },
  'run.restart': (params) => {
    const target = resolveTarget(params);
    target.status = 'starting';
    return { target };
  },
  'run.status': (params) => ({ target: resolveTarget(params) }),
  'logs.query': (params) => {
    const target = resolveTarget(params);
    return {
      runId: target.runId ?? null,
      entries: SEED.map((entry) => ({ ...entry, ts: Date.now() })),
      runs: [],
    };
  },
  'config.reload': () => ({ problems: [], stale: [] }),
  'config.resolve': (params) => {
    resolveTarget(params);
    return { playbook: PLAYBOOK, source: 'repo', repoPath: ORDERS, problems: [] };
  },
  'env.resolve': (params) => {
    resolveTarget(params);
    return { vars: ENV_VARS, problems: [] };
  },
};

/** stream id -> { target, emit } for every open follow, across every socket. */
const followers = new Map();

const TEST_METHODS = {
  'test.flood': (params) => {
    const wanted = params?.target;
    const count = Number(params?.lines ?? 0);
    const label = params?.label ?? 'API';
    const ansi = params?.ansi === true;
    let sent = 0;
    for (const follower of followers.values()) {
      if (typeof wanted === 'string' && follower.target !== wanted) continue;
      for (let i = 0; i < count; i++) {
        const body = ansi ? `${RED}flood ${i}${RESET}` : `flood ${i}`;
        follower.emit.data({ ts: Date.now(), label, stream: 'stdout', text: `${body}\n` });
        sent++;
      }
    }
    return { sent, followers: followers.size };
  },
  'test.followers': () => ({
    count: followers.size,
    targets: [...followers.values()].map((f) => f.target),
  }),
  // Grows repo.list to prove a long picker still fits its pane. `{count: 0}` restores.
  'test.repos': (params) => {
    const count = Number(params?.count ?? 0);
    REPOS.length = 0;
    REPOS.push(...BASE_REPOS);
    for (let i = 0; i < count; i++) {
      const name = `synthetic-${String(i).padStart(2, '0')}`;
      const path = `/projects/${name}`;
      REPOS.push({
        path,
        name,
        checkouts: [{ path, branch: 'main', head: 'aaaaaaa', isMain: true }],
        playbooks: [{ name: 'ci', source: 'repo' }],
        problems: [],
      });
    }
    return { repos: REPOS.length };
  },
};

const SUBSCRIPTIONS = {
  'logs.follow': (params, emit, id) => {
    const target = resolveTarget(params);
    followers.set(id, { target: target.slug, emit });
    for (const entry of SEED) {
      if (params.label && entry.label !== params.label) continue;
      emit.data({ ...entry, ts: Date.now() });
    }
    return () => followers.delete(id);
  },
};

// --- wire -------------------------------------------------------------------

const server = createServer((socket) => {
  const streams = new Map();
  let buffer = '';

  const write = (frame) => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(frame)}\n`);
  };

  write({ hello: true, version: 'tui-stub', protocol: 1, pid: process.pid });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      handle(frame);
    }
  });

  socket.on('close', () => {
    for (const stop of streams.values()) stop();
    streams.clear();
  });
  socket.on('error', () => {});

  function handle(frame) {
    const { id, method, params } = frame ?? {};
    if (typeof id !== 'number' || typeof method !== 'string') return;
    appendFileSync(REQUESTS_LOG, `${JSON.stringify({ method, params: params ?? null })}\n`);

    if (method === '$unsubscribe') {
      const stop = streams.get(params?.stream);
      if (stop) {
        streams.delete(params.stream);
        stop();
      }
      write({ id, ok: true, result: { stopped: Boolean(stop) } });
      return;
    }

    if (method === 'daemon.stop') {
      write({ id, ok: true, result: { ok: true } });
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 10);
      return;
    }

    const subscribe = SUBSCRIPTIONS[method];
    if (subscribe) {
      let stopped = false;
      const emit = {
        data: (value) => {
          if (!stopped) write({ stream: id, event: 'data', data: value });
        },
        end: () => {
          if (stopped) return;
          stopped = true;
          streams.delete(id);
          write({ stream: id, event: 'end' });
        },
      };
      let stop;
      try {
        write({ id, ok: true, result: { subscribed: true, stream: id } });
        stop = subscribe(params ?? {}, emit, id);
      } catch (error) {
        write({ id, ok: false, error: { code: error.code ?? 'internal', message: error.message } });
        return;
      }
      streams.set(id, () => {
        stopped = true;
        stop?.();
      });
      return;
    }

    const handler = METHODS[method] ?? TEST_METHODS[method];
    if (!handler) {
      write({ id, ok: false, error: { code: 'unknown_method', message: `unknown: ${method}` } });
      return;
    }
    try {
      write({ id, ok: true, result: handler(params ?? {}) });
    } catch (error) {
      write({ id, ok: false, error: { code: error.code ?? 'internal', message: error.message } });
    }
  }
});

server.on('error', (error) => {
  process.stderr.write(`tui-daemon: ${error.message}\n`);
  process.exit(1);
});

const path = socketPath();
if (platform() !== 'win32' && existsSync(path)) {
  try {
    unlinkSync(path);
  } catch {
    // A live daemon still owning it surfaces as EADDRINUSE below.
  }
}
server.listen(path, () => {
  process.stdout.write(`tui-daemon: listening on ${path}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
