// A stand-in daemon that serves the whole run-mux RPC surface from canned data,
// so the CLI can be driven as a real child process without a real daemon.
//
// It runs unbuilt and therefore cannot import the TypeScript sources: the socket
// path and the NDJSON framing are reimplemented here and must stay in step with
// src/paths.ts and src/ipc/framing.ts.
//
//   env FAKE_DAEMON_SCENARIO   default | empty | problems   (picks the canned data)
//   <state>/fake-daemon.pid            this process's pid, so a test can kill it
//   <state>/fake-daemon-requests.log   one {method, params} per line, as received
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
const REQUESTS_LOG = join(STATE, 'fake-daemon-requests.log');
writeFileSync(join(STATE, 'fake-daemon.pid'), `${process.pid}\n`);

const SCENARIO = process.env.FAKE_DAEMON_SCENARIO ?? 'default';
const STARTED = Date.now();

// --- canned data ------------------------------------------------------------

const ORDERS = '/projects/orders';
const ORDERS_FEAT = '/projects/orders-feat-ports';
const BILLING = '/projects/billing';

const PLAYBOOK = {
  name: 'Run Orders',
  commands: [
    { label: 'Build', type: 'task', command: 'dotnet build' },
    { label: 'API', command: 'dotnet run --project src/Orders.Api', dependsOn: ['Build'] },
    { label: 'Web', command: 'pnpm dev', dependsOn: ['Build'], cwd: 'web' },
  ],
};

const TARGETS = [
  {
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
    autostart: false,
    runId: 'run-0001',
    startedAt: STARTED - 725_000,
    commands: [
      { label: 'Build', status: 'exited', exitCode: 0, restarts: 0, startedAt: STARTED - 730_000 },
      { label: 'API', status: 'running', pid: 4242, restarts: 1, startedAt: STARTED - 725_000 },
      { label: 'Web', status: 'running', pid: 4243, restarts: 0, startedAt: STARTED - 720_000 },
    ],
  },
  {
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
    autostart: false,
    commands: [],
  },
  {
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
  },
];

const REPOS = [
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
    playbooks: [
      { name: 'dev', source: 'global' },
      { name: 'smoke', source: 'repo' },
    ],
    problems: SCENARIO === 'problems' ? ['.run-mux.json: playbooks[1].commands is empty'] : [],
  },
];

const ANSI_LINE = '\u001b[31mFAILED\u001b[0m Orders.Api.Tests\n';

const ENTRIES = [
  { ts: STARTED - 60_000, label: 'Build', stream: 'stdout', text: 'Determining projects...\n' },
  { ts: STARTED - 59_000, label: 'API', stream: 'stdout', text: ANSI_LINE },
  {
    ts: STARTED - 58_000,
    label: 'Web',
    stream: 'stderr',
    text: 'vite: two lines\nin a single chunk\n',
  },
];

const RUNS = [
  {
    runId: 'run-0001',
    targetSlug: 'orders/main:run-orders',
    playbookSnapshot: PLAYBOOK,
    startedAt: STARTED - 730_000,
  },
];

const ENV_VARS = [
  { name: 'PATH', value: '/usr/local/bin:/usr/bin', source: 'daemon' },
  { name: 'ASPNETCORE_URLS', value: 'http://localhost:5010', source: 'playbook' },
  { name: 'DB_PASSWORD', value: 'hunter2', source: 'envFile' },
  { name: 'FEATURE_PORTS', value: 'on', source: 'target' },
  { name: 'MUX_SLOT', value: '1', source: 'injected' },
];

const targets = () => (SCENARIO === 'empty' ? [] : TARGETS);
const repos = () => (SCENARIO === 'empty' ? [] : REPOS);
const problems = (text) => (SCENARIO === 'problems' ? [text] : []);

// --- protocol ---------------------------------------------------------------

class Failure extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function errorFrame(id, error) {
  const wire = { code: error.code ?? 'internal', message: error.message };
  if (error.data !== undefined) wire.data = error.data;
  return { id, ok: false, error: wire };
}

// The canned paths are posix-absolute, but the CLI resolves a relative path
// against its cwd, so a suffix match keeps the fixture usable on Windows too.
function findRepo(path) {
  if (typeof path !== 'string') return undefined;
  return repos().find((repo) => repo.path === path || path.endsWith(repo.path));
}

function resolveTarget(params) {
  const query = params?.target;
  if (typeof query !== 'string' || query === '') {
    throw new Failure('bad_params', 'target is required');
  }
  const all = targets();
  const exact = all.find((t) => t.slug === query || t.alias === query);
  if (exact) return exact;
  const matches = all.filter((t) => t.slug.includes(query) || (t.alias ?? '').includes(query));
  if (matches.length === 0) {
    throw new Failure('not_found', `no target matches ${query}`);
  }
  if (matches.length > 1) {
    // The candidates ride in `data`, exactly as the real daemon sends them.
    throw new Failure('ambiguous', `${query} matches ${matches.length} targets`, {
      matches: matches.map((t) => t.slug),
    });
  }
  return matches[0];
}

const METHODS = {
  ping: () => ({ version: 'fake', protocol: 1, pid: process.pid, uptimeMs: Date.now() - STARTED }),
  'daemon.status': () => ({
    version: 'fake',
    protocol: 1,
    pid: process.pid,
    uptimeMs: Date.now() - STARTED,
    targets: targets().length,
    running: targets().filter((t) => t.status === 'running').length,
    socketPath: socketPath(),
    stateDir: STATE,
  }),
  'repo.add': (params) => {
    const path = params?.path;
    const known = repos().find((r) => r.path === path);
    return {
      repo: known ?? {
        path,
        name: String(path).replace(/\/+$/, '').split('/').pop() || 'repo',
        checkouts: [{ path, branch: 'main', head: 'aaaaaaa', isMain: true }],
        playbooks: [{ name: 'dev', source: 'repo' }],
        problems: [],
      },
    };
  },
  'repo.list': () => ({ repos: repos() }),
  'repo.remove': (params) => ({ removed: Boolean(findRepo(params?.path)) }),
  'checkout.list': (params) => {
    const repo = findRepo(params?.repoPath);
    if (!repo) throw new Failure('not_found', `${params?.repoPath} is not a registered repo`);
    return { checkouts: repo.checkouts, playbooks: repo.playbooks };
  },
  'target.list': () => ({ targets: targets() }),
  'target.add': (params) => {
    if (!params?.repoPath || !params?.checkoutPath || !params?.playbookName) {
      throw new Failure('bad_params', 'repoPath, checkoutPath and playbookName are required');
    }
    return {
      target: {
        ...TARGETS[0],
        slug: `added:${params.playbookName}`,
        repoPath: params.repoPath,
        checkoutPath: params.checkoutPath,
        playbookName: params.playbookName,
        status: 'stopped',
        commands: [],
        runId: undefined,
        startedAt: undefined,
      },
    };
  },
  'target.update': (params) => {
    const target = resolveTarget(params);
    if (params.autostart !== undefined && typeof params.autostart !== 'boolean') {
      throw new Failure('bad_params', 'autostart must be a boolean');
    }
    return {
      target: { ...target, autostart: params.autostart ?? target.autostart },
    };
  },
  'target.remove': (params) => ({ removed: true, slug: resolveTarget(params).slug }),
  'run.start': (params) => ({ target: { ...resolveTarget(params), status: 'starting' } }),
  'run.stop': (params) => ({ target: { ...resolveTarget(params), status: 'stopped' } }),
  'run.restart': (params) => ({ target: { ...resolveTarget(params), status: 'starting' } }),
  'run.status': (params) => ({ target: resolveTarget(params) }),
  'logs.query': (params) => {
    const target = resolveTarget(params);
    let entries = ENTRIES;
    if (params.label) entries = entries.filter((e) => e.label === params.label);
    if (typeof params.since === 'number') entries = entries.filter((e) => e.ts > params.since);
    if (typeof params.tail === 'number') entries = entries.slice(-params.tail);
    return { runId: target.runId ?? null, entries, runs: RUNS };
  },
  'config.reload': () => ({
    problems: problems('orders/.run-mux.json: playbooks[0].commands[2].dependsOn names a service'),
    stale: SCENARIO === 'empty' ? [] : ['billing/main:dev'],
  }),
  'config.resolve': (params) => {
    resolveTarget(params);
    return {
      playbook: PLAYBOOK,
      source: 'repo',
      repoPath: ORDERS,
      problems: problems('global playbook "Run Orders" replaces the repo one'),
    };
  },
  'env.resolve': (params) => {
    resolveTarget(params);
    return {
      vars: ENV_VARS,
      problems: problems('envFile not found: /projects/orders/.env.local'),
    };
  },
};

const SUBSCRIPTIONS = {
  'logs.follow': (params, emit) => {
    resolveTarget(params);
    let sent = 0;
    const pending = params.label ? ENTRIES.filter((e) => e.label === params.label) : ENTRIES;
    const timer = setInterval(() => {
      if (sent >= pending.length) {
        clearInterval(timer);
        emit.end();
        return;
      }
      emit.data({ ...pending[sent], ts: Date.now() });
      sent++;
    }, 5);
    return () => clearInterval(timer);
  },
};

// --- wire -------------------------------------------------------------------

const server = createServer((socket) => {
  const streams = new Map();
  let buffer = '';

  const write = (frame) => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(frame)}\n`);
  };

  write({ hello: true, version: 'fake', protocol: 1, pid: process.pid });

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
        stop = subscribe(params ?? {}, emit);
      } catch (error) {
        write(errorFrame(id, error));
        return;
      }
      streams.set(id, () => {
        stopped = true;
        stop?.();
      });
      return;
    }

    const handler = METHODS[method];
    if (!handler) {
      write({ id, ok: false, error: { code: 'unknown_method', message: `unknown: ${method}` } });
      return;
    }
    try {
      write({ id, ok: true, result: handler(params ?? {}) });
    } catch (error) {
      write(errorFrame(id, error));
    }
  }
});

server.on('error', (error) => {
  process.stderr.write(`fake-daemon: ${error.message}\n`);
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
  process.stdout.write(`fake-daemon: listening on ${path} (${SCENARIO})\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
