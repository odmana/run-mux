import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeOut, type Out } from '../src/cli/output.js';
import { renderLogEntry, renderTargets } from '../src/cli/render.js';
import type { TargetView } from '../src/protocol.js';
import { EXIT_CODES } from '../src/types.js';
import { isAlive, useTempHome, waitFor, type TempHome } from './helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = resolve(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = resolve(ROOT, 'src', 'cli', 'index.ts');
const FAKE_DAEMON = resolve(ROOT, 'test', 'fixtures', 'fake-daemon.mjs');
const TUI_STUB = resolve(ROOT, 'test', 'fixtures', 'tui-stub.mjs');
const FAKE_NODE_VERSION = resolve(ROOT, 'test', 'fixtures', 'fake-node-version.mjs');
const ESC = String.fromCharCode(27);
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string }
).version;

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(async () => {
  const pidFile = join(home.root, 'state', 'fake-daemon.pid');
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid);
      } catch {
        // already stopped by the test itself
      }
      await waitFor(() => !isAlive(pid), { label: 'fake daemon exit' });
    }
  }
  home.cleanup();
});

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs the real CLI as a child process. stdin is /dev/null, so anything that
 * would prompt has to fail instead of hanging.
 */
function rmux(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [TSX, CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RUN_MUX_HOME: home.root,
        RUN_MUX_DAEMON_ENTRY: FAKE_DAEMON,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', (code) => done({ stdout, stderr, code: code ?? -1 }));
  });
}

interface Recorded {
  method: string;
  params: Record<string, unknown> | null;
}

function requests(): Recorded[] {
  const file = join(home.root, 'state', 'fake-daemon-requests.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

function lastRequest(method: string): Recorded {
  const all = requests();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].method === method) return all[i];
  }
  throw new Error(`the fake daemon never received ${method}`);
}

function ndjson(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function onlyJson(text: string): Record<string, unknown> {
  const objects = ndjson(text);
  expect(objects).toHaveLength(1);
  return objects[0];
}

function daemonStarted(): boolean {
  return existsSync(join(home.root, 'state', 'fake-daemon.pid'));
}

describe('rmux ls', () => {
  it('emits one versioned JSON object and nothing else on stdout', async () => {
    const run = await rmux(['ls', '--json']);

    expect(run.code).toBe(0);
    const payload = onlyJson(run.stdout);
    expect(payload.v).toBe(1);
    const targets = payload.targets as TargetView[];
    expect(targets.map((t) => t.slug)).toEqual([
      'orders/main:run-orders',
      'orders/feat-ports:run-orders',
      'billing/main:dev',
    ]);
  });

  it('prints a grouped human table and still exits 0', async () => {
    const run = await rmux(['ls']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('orders');
    expect(run.stdout).toContain('billing');
    expect(run.stdout).toContain('feat-ports');
    expect(run.stdout).toContain('slot 1');
    expect(run.stdout).toContain('running');
    expect(run.stdout).toContain('(stale)');
    expect(run.stdout.trimStart().startsWith('{')).toBe(false);
  });

  it('says so when nothing has been added', async () => {
    const run = await rmux(['ls'], { FAKE_DAEMON_SCENARIO: 'empty' });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('no targets yet');
  });
});

describe('the --json contract', () => {
  it('keeps the autospawn note on stderr while stdout stays parseable', async () => {
    const run = await rmux(['ls', '--json']);

    expect(run.stderr).toContain('started the run-mux daemon');
    expect(onlyJson(run.stdout).v).toBe(1);
  });

  it('keeps daemon-reported problems on stderr and in the JSON body', async () => {
    const run = await rmux(['env', 'billing', '--command', 'Api', '--json'], {
      FAKE_DAEMON_SCENARIO: 'problems',
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('warning: envFile not found');
    const payload = onlyJson(run.stdout);
    expect(payload.v).toBe(1);
    expect(payload.problems).toEqual(['envFile not found: /projects/orders/.env.local']);
  });

  it('keeps the no-command note off stdout', async () => {
    const run = await rmux(['env', 'billing', '--json']);

    expect(run.stderr).toContain('only the run-wide and injected layers resolve');
    expect(onlyJson(run.stdout).v).toBe(1);
  });

  it('emits no escape sequences under --json', async () => {
    const run = await rmux(['status', 'billing', '--json'], { NO_COLOR: '' });

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain(ESC);
  });

  it('emits no escape sequences under NO_COLOR', async () => {
    const run = await rmux(['ls'], { NO_COLOR: '1' });

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain(ESC);
  });
});

describe('rmux logs', () => {
  it('streams NDJSON under --follow --json, one object per line', async () => {
    const run = await rmux(['logs', 'billing', '--follow', '--json']);

    expect(run.code).toBe(0);
    const objects = ndjson(run.stdout);
    expect(objects.length).toBeGreaterThanOrEqual(4);
    expect(objects.every((o) => o.v === 1)).toBe(true);
    expect(objects.filter((o) => o.type === 'log')).toHaveLength(3);
    expect(objects[objects.length - 1].type).toBe('end');
    expect(lastRequest('logs.follow').params).toEqual({ target: 'billing' });
  });

  it('forwards --label, --since and --tail as logs.query params', async () => {
    const before = Date.now();
    const run = await rmux([
      'logs',
      'billing',
      '--label',
      'API',
      '--since',
      '5m',
      '--tail',
      '2',
      '--json',
    ]);
    const after = Date.now();

    expect(run.code).toBe(0);
    const params = lastRequest('logs.query').params ?? {};
    expect(params.target).toBe('billing');
    expect(params.label).toBe('API');
    expect(params.tail).toBe(2);
    expect(params.since as number).toBeGreaterThanOrEqual(before - 300_000);
    expect(params.since as number).toBeLessThanOrEqual(after - 300_000);
  });

  it('rejects a --since it cannot read without calling the daemon', async () => {
    const run = await rmux(['logs', 'billing', '--since', 'yesterday', '--json']);

    expect(run.code).toBe(EXIT_CODES.bad_params);
    const error = onlyJson(run.stdout).error as Record<string, unknown>;
    expect(error.code).toBe('bad_params');
    expect(daemonStarted()).toBe(false);
  });

  it('passes the command own ANSI through untouched and prefixes every line', async () => {
    const run = await rmux(['logs', 'billing'], { NO_COLOR: '1' });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`${ESC}[31mFAILED${ESC}[0m Orders.Api.Tests`);
    expect(run.stdout).toContain('[API]');
    expect(run.stdout).toContain('[Web] vite: two lines');
    expect(run.stdout).toContain('[Web] in a single chunk');
  });

  it('carries the raw text through the JSON body too', async () => {
    const run = await rmux(['logs', 'billing', '--json']);

    const logs = ndjson(run.stdout).filter((o) => o.type === 'log');
    expect(logs).toHaveLength(3);
    expect(logs[1].text).toBe(`${ESC}[31mFAILED${ESC}[0m Orders.Api.Tests\n`);
    expect(ndjson(run.stdout)[0].type).toBe('meta');
  });
});

describe('target errors', () => {
  it('exits with the not_found code and a structured error under --json', async () => {
    const run = await rmux(['status', 'nope', '--json']);

    expect(run.code).toBe(EXIT_CODES.not_found);
    const payload = onlyJson(run.stdout);
    expect(payload.v).toBe(1);
    const error = payload.error as Record<string, unknown>;
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('nope');
  });

  it('exits with the not_found code and writes nothing to stdout in human mode', async () => {
    const run = await rmux(['status', 'nope']);

    expect(run.code).toBe(EXIT_CODES.not_found);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toContain('error:');
  });

  it('lists the candidates the daemon sent for an ambiguous target', async () => {
    const human = await rmux(['start', 'orders']);

    expect(human.code).toBe(EXIT_CODES.ambiguous);
    expect(human.stderr).toContain('orders/main:run-orders');
    expect(human.stderr).toContain('orders/feat-ports:run-orders');

    const json = await rmux(['start', 'orders', '--json']);
    expect(json.code).toBe(EXIT_CODES.ambiguous);
    const error = onlyJson(json.stdout).error as Record<string, unknown>;
    expect(error.code).toBe('ambiguous');
    expect(error.matches).toEqual(['orders/main:run-orders', 'orders/feat-ports:run-orders']);

    // The candidates come off the error itself; recovering them with a second
    // request would mean re-implementing the daemon's matching rule here.
    expect(requests().map((r) => r.method)).toEqual(['run.start', 'run.start']);
  });

  it('rejects an unknown verb with the unknown_method code', async () => {
    const run = await rmux(['frobnicate', '--json']);

    expect(run.code).toBe(EXIT_CODES.unknown_method);
    const error = onlyJson(run.stdout).error as Record<string, unknown>;
    expect(error.code).toBe('unknown_method');
  });
});

describe('run control', () => {
  it('sends the single-command restart param', async () => {
    const run = await rmux(['restart', 'billing', '--command', 'Api', '--json']);

    expect(run.code).toBe(0);
    expect(lastRequest('run.restart').params).toEqual({ target: 'billing', command: 'Api' });
  });

  it('omits the command param for a whole-stack restart', async () => {
    const run = await rmux(['restart', 'billing', '--json']);

    expect(run.code).toBe(0);
    expect(lastRequest('run.restart').params).toEqual({ target: 'billing' });
  });

  it('prints the per-command table for status', async () => {
    const run = await rmux(['status', 'billing']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('billing/main:dev');
    expect(run.stdout).toContain('LABEL');
    expect(run.stdout).toContain('Worker');
    expect(run.stdout).toContain('errored');
    expect(run.stdout).toContain('5150');
  });
});

describe('rmux add', () => {
  it('fails with bad_params instead of prompting when stdin is not a TTY', async () => {
    const run = await rmux(['add']);

    expect(run.code).toBe(EXIT_CODES.bad_params);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toContain('interactive');
    expect(run.stderr).toContain('--repo');
  });

  it('reports bad_params as a structured error under --json', async () => {
    const run = await rmux(['add', '--json']);

    expect(run.code).toBe(EXIT_CODES.bad_params);
    const error = onlyJson(run.stdout).error as Record<string, unknown>;
    expect(error.code).toBe('bad_params');
  });

  it('defaults the checkout to the main worktree and the only playbook', async () => {
    const run = await rmux(['add', '--repo', '/projects/orders', '--json']);

    expect(run.code).toBe(0);
    const params = lastRequest('target.add').params ?? {};
    expect(params.checkoutPath).toBe('/projects/orders');
    expect(params.playbookName).toBe('Run Orders');
  });

  it('asks for --playbook when the repo offers several', async () => {
    const run = await rmux(['add', '--repo', '/projects/billing', '--json']);

    expect(run.code).toBe(EXIT_CODES.bad_params);
    const error = onlyJson(run.stdout).error as Record<string, unknown>;
    expect(error.matches).toEqual(['dev', 'smoke']);
  });
});

describe('rmux autostart', () => {
  it('turns the flag on and off through target.update', async () => {
    const on = await rmux(['autostart', 'billing', '--json']);

    expect(on.code).toBe(0);
    expect(lastRequest('target.update').params).toEqual({ target: 'billing', autostart: true });
    expect((onlyJson(on.stdout).target as TargetView).autostart).toBe(true);

    const off = await rmux(['autostart', 'billing', '--off', '--json']);

    expect(off.code).toBe(0);
    expect(lastRequest('target.update').params).toEqual({ target: 'billing', autostart: false });
    expect((onlyJson(off.stdout).target as TargetView).autostart).toBe(false);
  });

  it('says which way it went in human mode', async () => {
    const on = await rmux(['autostart', 'billing']);
    expect(on.code).toBe(0);
    expect(on.stdout).toContain('billing/main:dev will start with the daemon');

    const off = await rmux(['autostart', 'billing', '--off']);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('will no longer start with the daemon');
  });

  it('needs a target', async () => {
    const run = await rmux(['autostart', '--json']);

    expect(run.code).toBe(EXIT_CODES.bad_params);
    expect((onlyJson(run.stdout).error as Record<string, unknown>).code).toBe('bad_params');
  });

  it('is discoverable from rmux ls, in JSON and in the table', async () => {
    const json = await rmux(['ls', '--json']);
    const targets = onlyJson(json.stdout).targets as TargetView[];
    expect(targets.find((t) => t.slug === 'billing/main:dev')?.autostart).toBe(true);
    expect(targets.find((t) => t.slug === 'orders/main:run-orders')?.autostart).toBe(false);

    const table = await rmux(['ls'], { NO_COLOR: '1' });
    expect(table.stdout).toContain('(autostart)');
  });
});

describe('repo, config and env', () => {
  it('lists repos with their checkouts and playbook sources', async () => {
    const run = await rmux(['repo', 'ls']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('orders');
    expect(run.stdout).toContain('feat-ports');
    expect(run.stdout).toContain('checkouts');
    expect(run.stdout).toContain('playbooks');
    expect(run.stdout).toContain('(global)');
  });

  it('resolves the effective playbook and where it came from', async () => {
    const run = await rmux(['config', 'resolve', 'billing']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Run Orders');
    expect(run.stdout).toContain('from the repo config');
    expect(run.stdout).toContain('dotnet build');
    expect(run.stdout).toContain('task');
  });

  it('reports the stale targets after a reload', async () => {
    const run = await rmux(['reload', '--json']);

    expect(run.code).toBe(0);
    expect(onlyJson(run.stdout).stale).toEqual(['billing/main:dev']);
  });

  it('attributes every variable to the layer it came from', async () => {
    const run = await rmux(['env', 'billing', '--command', 'Api']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('VARIABLE');
    expect(run.stdout).toContain('SOURCE');
    expect(run.stdout).toContain('MUX_SLOT');
    expect(run.stdout).toContain('injected');
    expect(run.stdout).toContain('envFile');
    expect(lastRequest('env.resolve').params).toEqual({ target: 'billing', command: 'Api' });
  });
});

describe('daemon lifecycle', () => {
  it('reports a missing daemon without starting one', async () => {
    const run = await rmux(['daemon', 'status', '--json']);

    expect(run.code).toBe(0);
    const daemon = onlyJson(run.stdout).daemon as Record<string, unknown>;
    expect(daemon.alive).toBe(false);
    expect(daemonStarted()).toBe(false);
  });

  it('stops a running daemon', async () => {
    await rmux(['ls', '--json']);
    const run = await rmux(['daemon', 'stop', '--json']);

    expect(run.code).toBe(0);
    const daemon = onlyJson(run.stdout).daemon as Record<string, unknown>;
    expect(daemon.stopped).toBe(true);

    const after = await rmux(['daemon', 'status', '--json']);
    expect((onlyJson(after.stdout).daemon as Record<string, unknown>).alive).toBe(false);
  });
});

describe('help and version', () => {
  it('answers --version without a daemon', async () => {
    const run = await rmux(['--version']);

    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(PACKAGE_VERSION);
    expect(daemonStarted()).toBe(false);
  });

  it('answers --help without a daemon', async () => {
    const run = await rmux(['--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('rmux logs');
    expect(run.stdout).toContain('--json');
    expect(daemonStarted()).toBe(false);
  });

  it('answers `help <verb>` for one verb', async () => {
    const run = await rmux(['help', 'logs']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('--follow');
    expect(run.stdout).toContain('--since');
  });

  it('lists the autostart verb in the usage text', async () => {
    const run = await rmux(['help', 'autostart']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('--off');
  });
});

describe('bare rmux launches the TUI', () => {
  it('spawns the entry with --experimental-ffi, inherits stdio and returns its exit code', async () => {
    const run = await rmux([], { RUN_MUX_TUI_ENTRY: TUI_STUB, TUI_STUB_EXIT: '7' });

    expect(run.code).toBe(7);
    expect(run.stdout).toContain('tui-stub: ffi=true');
    expect(run.stderr).toContain('tui-stub: on stderr');
    // The TUI opens its own connection; launching it must not autospawn one.
    expect(daemonStarted()).toBe(false);
  });

  it('suggests a build instead of crashing when the entry is missing', async () => {
    const run = await rmux([], { RUN_MUX_TUI_ENTRY: join(home.root, 'nowhere', 'index.js') });

    expect(run.code).toBe(EXIT_CODES.unavailable);
    expect(run.stderr).toContain('pnpm build');
    expect(run.stderr).toContain('not built');
    expect(run.stderr).not.toContain('ENOENT');
    expect(run.stdout.trim()).toBe('');
    expect(daemonStarted()).toBe(false);
  });

  it('refuses to spawn on a Node below 26.1 and says how to fix it', async () => {
    const run = await rmux([], {
      RUN_MUX_TUI_ENTRY: TUI_STUB,
      RUN_MUX_FAKE_NODE: '24.14.0',
      NODE_OPTIONS: `--import ${pathToFileURL(FAKE_NODE_VERSION).href}`,
    });

    expect(run.code).toBe(EXIT_CODES.unavailable);
    expect(run.stderr).toContain('needs Node 26.1 or newer');
    expect(run.stderr).toContain('this is Node 24.14.0');
    expect(run.stderr).toContain('fnm use');
    expect(run.stdout).not.toContain('tui-stub');
    expect(daemonStarted()).toBe(false);
  });
});

describe('output discipline', () => {
  it('never writes to stdout outside output.ts', () => {
    const dir = resolve(ROOT, 'src', 'cli');
    const files = readdirSync(dir, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('output.ts'));

    expect(files.length).toBeGreaterThan(4);
    const offenders = files.filter((file) => {
      const text = readFileSync(join(dir, file), 'utf-8');
      return text.includes('process.stdout') || text.includes('console.');
    });

    expect(offenders).toEqual([]);
  });

  it('paints only when colour is on', () => {
    const target: TargetView = {
      slug: 'orders/main:run-orders',
      repoPath: '/projects/orders',
      repoName: 'orders',
      checkoutPath: '/projects/orders',
      branch: 'main',
      isMain: true,
      playbookName: 'Run Orders',
      slot: 0,
      available: true,
      status: 'running',
      autostart: false,
      startedAt: Date.now() - 60_000,
    };
    const coloured: Out = { json: false, color: true };

    expect(renderTargets(coloured, [target]).join('\n')).toContain(ESC);
    expect(renderTargets(makeOut(false, true), [target]).join('\n')).not.toContain(ESC);
    expect(makeOut(true).color).toBe(false);
  });

  it('leaves the command own ANSI alone even when colour is off', () => {
    const entry = {
      ts: Date.now(),
      label: 'API',
      stream: 'stdout' as const,
      text: `${ESC}[31mred${ESC}[0m\n`,
    };

    expect(renderLogEntry(makeOut(false, true), entry)).toBe(`[API] ${ESC}[31mred${ESC}[0m`);
  });
});
