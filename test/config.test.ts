import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureGlobalConfig,
  expandPath,
  loadGlobalConfig,
  loadRepoConfig,
  parseEnvFile,
  resolveEnv,
  resolvePlaybook,
  resolvePlaybooks,
} from '../src/config/index.js';
import { globalConfigPath, normalize } from '../src/paths.js';
import { service, ticker, useTempHome, type TempHome } from './helpers.js';

let home: TempHome;
let checkout: string;

beforeEach(() => {
  home = useTempHome();
  checkout = join(home.root, 'checkout').replaceAll('\\', '/');
  mkdirSync(checkout, { recursive: true });
});

afterEach(() => {
  home.cleanup();
});

function writeGlobal(config: unknown): void {
  writeFileSync(globalConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

function writeRepo(config: unknown, dir = checkout): void {
  writeFileSync(join(dir, '.run-mux.json'), JSON.stringify(config, null, 2), 'utf-8');
}

const migrate = { label: 'migrate', command: ticker([1]), type: 'task' as const };
const api = { label: 'api', command: service([]) };

describe('schema validation', () => {
  it('round-trips a valid repo config', () => {
    writeRepo({
      playbooks: [
        {
          name: 'dev',
          commands: [
            migrate,
            { ...api, dependsOn: ['migrate'], restart: 'always', cwd: 'packages/api' },
          ],
        },
      ],
    });

    const { config, problems } = loadRepoConfig(checkout);
    expect(problems).toEqual([]);
    expect(config.playbooks).toHaveLength(1);
    expect(config.playbooks[0]?.commands[1]).toMatchObject({
      label: 'api',
      dependsOn: ['migrate'],
      restart: 'always',
      cwd: 'packages/api',
    });
  });

  it('round-trips a valid global config', () => {
    writeGlobal({
      repos: [{ path: '/code/app', alias: 'app' }],
      playbooks: [{ name: 'dev', repo: '/code/app', commands: [api] }],
      targets: { 'app/main:dev': { alias: 'main', env: { PORT: '4000' } } },
    });

    const { config, problems } = loadGlobalConfig();
    expect(problems).toEqual([]);
    expect(config.repos).toEqual([{ path: '/code/app', alias: 'app' }]);
    expect(config.playbooks[0]?.name).toBe('dev');
    expect(config.targets['app/main:dev']?.env).toEqual({ PORT: '4000' });
  });

  it('rejects dependsOn on an unknown label', () => {
    writeRepo({
      playbooks: [{ name: 'dev', commands: [{ ...api, dependsOn: ['nope'] }] }],
    });

    const { config, problems } = loadRepoConfig(checkout);
    expect(config.playbooks).toEqual([]);
    expect(problems[0]).toMatch(/playbooks\.0/);
    expect(problems[0]).toMatch(/unknown label/);
  });

  it('rejects a dependsOn cycle', () => {
    writeRepo({
      playbooks: [
        {
          name: 'dev',
          commands: [
            { label: 'a', command: ticker([1]), type: 'task', dependsOn: ['b'] },
            { label: 'b', command: ticker([1]), type: 'task', dependsOn: ['a'] },
          ],
        },
      ],
    });

    const { config, problems } = loadRepoConfig(checkout);
    expect(config.playbooks).toEqual([]);
    expect(problems[0]).toMatch(/cycle/);
  });

  it('rejects a self-dependency', () => {
    writeRepo({
      playbooks: [
        {
          name: 'dev',
          commands: [{ label: 'a', command: ticker([1]), type: 'task', dependsOn: ['a'] }],
        },
      ],
    });

    const { problems } = loadRepoConfig(checkout);
    expect(problems[0]).toMatch(/cycle/);
  });

  it('rejects depending on a service', () => {
    writeRepo({
      playbooks: [
        {
          name: 'dev',
          commands: [api, { label: 'web', command: service([]), dependsOn: ['api'] }],
        },
      ],
    });

    const { config, problems } = loadRepoConfig(checkout);
    expect(config.playbooks).toEqual([]);
    expect(problems[0]).toMatch(/service/);
    expect(problems[0]).toMatch(/pending/);
  });

  it('rejects depending on a command whose type defaults to service', () => {
    writeRepo({
      playbooks: [
        {
          name: 'dev',
          commands: [
            { label: 'seed', command: ticker([1]) },
            { label: 'web', command: service([]), dependsOn: ['seed'] },
          ],
        },
      ],
    });

    expect(loadRepoConfig(checkout).problems[0]).toMatch(/service/);
  });

  it('accepts depending on an explicit task', () => {
    writeRepo({
      playbooks: [{ name: 'dev', commands: [migrate, { ...api, dependsOn: ['migrate'] }] }],
    });

    const { config, problems } = loadRepoConfig(checkout);
    expect(problems).toEqual([]);
    expect(config.playbooks[0]?.commands).toHaveLength(2);
  });

  it('rejects duplicate command labels', () => {
    writeRepo({
      playbooks: [{ name: 'dev', commands: [api, { ...api, command: ticker([1]) }] }],
    });

    const { config, problems } = loadRepoConfig(checkout);
    expect(config.playbooks).toEqual([]);
    expect(problems[0]).toMatch(/duplicate command labels: api/);
  });

  it('rejects duplicate playbook names in a repo config', () => {
    writeRepo({
      playbooks: [
        { name: 'dev', commands: [api] },
        { name: 'dev', commands: [migrate] },
      ],
    });

    expect(loadRepoConfig(checkout).problems[0]).toMatch(/duplicate playbook names: dev/);
  });

  it('rejects duplicate playbook names for the same repo in the global config', () => {
    writeGlobal({
      playbooks: [
        { name: 'dev', repo: '/code/app', commands: [api] },
        { name: 'dev', repo: '/code/app/', commands: [migrate] },
      ],
    });

    const { config, problems } = loadGlobalConfig();
    expect(config.playbooks).toEqual([]);
    expect(problems[0]).toMatch(/duplicate playbook names for the same repo/);
  });

  it('allows the same playbook name for different repos', () => {
    writeGlobal({
      playbooks: [
        { name: 'dev', repo: '/code/app', commands: [api] },
        { name: 'dev', repo: '/code/other', commands: [migrate] },
      ],
    });

    expect(loadGlobalConfig().problems).toEqual([]);
  });
});

describe('loading', () => {
  it('treats a missing global config as empty without a problem', () => {
    const { config, problems } = loadGlobalConfig();
    expect(config).toEqual({ repos: [], playbooks: [], targets: {} });
    expect(problems).toEqual([]);
  });

  it('treats a missing repo config as empty without a problem', () => {
    const { config, problems } = loadRepoConfig(checkout);
    expect(config).toEqual({ playbooks: [] });
    expect(problems).toEqual([]);
  });

  it('reports malformed JSON without throwing', () => {
    writeFileSync(globalConfigPath(), '{ "repos": [', 'utf-8');
    writeFileSync(join(checkout, '.run-mux.json'), 'not json at all', 'utf-8');

    const global = loadGlobalConfig();
    expect(global.config).toEqual({ repos: [], playbooks: [], targets: {} });
    expect(global.problems).toHaveLength(1);
    expect(global.problems[0]).toContain('config.json');

    const repo = loadRepoConfig(checkout);
    expect(repo.config).toEqual({ playbooks: [] });
    expect(repo.problems).toHaveLength(1);
    expect(repo.problems[0]).toContain('.run-mux.json');
  });

  it('reports a schema-invalid config without throwing', () => {
    writeGlobal({ repos: 'nope', playbooks: [] });
    writeRepo({ playbooks: [{ name: '', commands: [] }] });

    const global = loadGlobalConfig();
    expect(global.config).toEqual({ repos: [], playbooks: [], targets: {} });
    expect(global.problems[0]).toMatch(/repos/);

    const repo = loadRepoConfig(checkout);
    expect(repo.config).toEqual({ playbooks: [] });
    expect(repo.problems).toHaveLength(1);
  });

  it('defaults missing top-level sections', () => {
    writeGlobal({});
    const { config, problems } = loadGlobalConfig();
    expect(problems).toEqual([]);
    expect(config).toEqual({ repos: [], playbooks: [], targets: {} });
  });

  it('expands a leading tilde and normalises separators', () => {
    writeGlobal({
      repos: [{ path: '~/code/app' }, { path: 'C:\\code\\other' }],
      playbooks: [{ name: 'dev', repo: '~/code/app', commands: [api] }],
    });

    const { config } = loadGlobalConfig();
    expect(config.repos[0]?.path).toBe(normalize(join(homedir(), 'code/app')));
    expect(config.repos[1]?.path).toBe('C:/code/other');
    expect(config.playbooks[0]?.repo).toBe(normalize(join(homedir(), 'code/app')));
    expect(expandPath('~')).toBe(normalize(homedir()));
  });

  it('creates a starter config that loads cleanly and is not overwritten', () => {
    const path = ensureGlobalConfig();
    expect(path).toBe(globalConfigPath());

    const first = loadGlobalConfig();
    expect(first.problems).toEqual([]);
    expect(first.config).toEqual({ repos: [], playbooks: [], targets: {} });

    const contents = readFileSync(path, 'utf-8');
    expect(contents).toContain('//');
    expect(ensureGlobalConfig()).toBe(path);
    expect(readFileSync(path, 'utf-8')).toBe(contents);
  });
});

describe('playbook precedence', () => {
  const repoPath = () => checkout;

  it('returns repo playbooks tagged as repo', () => {
    writeRepo({ playbooks: [{ name: 'dev', commands: [api] }] });

    const { playbooks, problems } = resolvePlaybooks(repoPath(), checkout);
    expect(problems).toEqual([]);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]).toMatchObject({ name: 'dev', source: 'repo', repoPath: checkout });
  });

  it('replaces a same-named repo playbook wholesale', () => {
    writeRepo({
      playbooks: [
        { name: 'dev', commands: [api, { label: 'only-in-repo', command: ticker([1]) }] },
      ],
    });
    writeGlobal({
      playbooks: [
        { name: 'dev', repo: checkout, commands: [{ label: 'api', command: ticker([1]) }] },
      ],
    });

    const { playbooks } = resolvePlaybooks(repoPath(), checkout);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]?.source).toBe('global');
    expect(playbooks[0]?.commands.map((c) => c.label)).toEqual(['api']);
    expect(playbooks[0]?.commands.some((c) => c.label === 'only-in-repo')).toBe(false);
  });

  it('adds a global playbook with a new name alongside repo ones', () => {
    writeRepo({ playbooks: [{ name: 'dev', commands: [api] }] });
    writeGlobal({
      playbooks: [{ name: 'e2e', repo: checkout, commands: [migrate] }],
    });

    const { playbooks } = resolvePlaybooks(repoPath(), checkout);
    expect(playbooks.map((pb) => [pb.name, pb.source])).toEqual([
      ['dev', 'repo'],
      ['e2e', 'global'],
    ]);
  });

  it('ignores global playbooks belonging to another repo', () => {
    writeRepo({ playbooks: [{ name: 'dev', commands: [api] }] });
    writeGlobal({
      playbooks: [{ name: 'dev', repo: join(home.root, 'elsewhere'), commands: [migrate] }],
    });

    const { playbooks } = resolvePlaybooks(repoPath(), checkout);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]?.source).toBe('repo');
  });

  it('matches the repo path across separators and trailing slashes', () => {
    writeRepo({ playbooks: [{ name: 'dev', commands: [api] }] });
    writeGlobal({
      playbooks: [
        { name: 'dev', repo: `${checkout.replaceAll('/', '\\')}\\`, commands: [migrate] },
      ],
    });

    expect(resolvePlaybooks(repoPath(), checkout).playbooks[0]?.source).toBe('global');
  });

  it.skipIf(process.platform !== 'win32')(
    'matches the repo path case-insensitively on Windows',
    () => {
      writeRepo({ playbooks: [{ name: 'dev', commands: [api] }] });
      writeGlobal({
        playbooks: [{ name: 'dev', repo: checkout.toUpperCase(), commands: [migrate] }],
      });

      expect(resolvePlaybooks(repoPath(), checkout).playbooks[0]?.source).toBe('global');
    },
  );

  it('surfaces problems from both files while still resolving the other', () => {
    writeRepo({ playbooks: [{ name: 'dev', commands: [api] }] });
    writeFileSync(globalConfigPath(), '{ broken', 'utf-8');

    const { playbooks, problems } = resolvePlaybooks(repoPath(), checkout);
    expect(playbooks).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  it('resolves one playbook by name or null', () => {
    writeRepo({ playbooks: [{ name: 'dev', commands: [api] }] });

    expect(resolvePlaybook(repoPath(), checkout, 'dev')?.name).toBe('dev');
    expect(resolvePlaybook(repoPath(), checkout, 'missing')).toBeNull();
  });
});

describe('env layering', () => {
  function envFileAt(name: string, text: string): string {
    writeFileSync(join(checkout, name), text, 'utf-8');
    return name;
  }

  it('applies all five layers with the highest winning', () => {
    envFileAt('.env', 'SHARED=fromFile\nFROM_FILE=yes\n');

    const { env, sources, problems } = resolveEnv({
      daemonEnv: { SHARED: 'fromDaemon', FROM_DAEMON: 'yes' },
      command: { env: { SHARED: 'fromPlaybook', FROM_PLAYBOOK: 'yes' }, envFile: '.env' },
      checkoutPath: checkout,
      targetEnv: { SHARED: 'fromTarget', FROM_TARGET: 'yes' },
      injected: { SHARED: 'fromInjected', MUX_SLOT: '2' },
    });

    expect(problems).toEqual([]);
    expect(env.SHARED).toBe('fromInjected');
    expect(sources.SHARED).toBe('injected');
    expect(sources).toMatchObject({
      FROM_DAEMON: 'daemon',
      FROM_PLAYBOOK: 'playbook',
      FROM_FILE: 'envFile',
      FROM_TARGET: 'target',
      MUX_SLOT: 'injected',
    });
    expect(env.MUX_SLOT).toBe('2');
  });

  it('lets each layer override only the ones below it', () => {
    envFileAt('.env', 'SHARED=fromFile\n');
    const base = {
      daemonEnv: { SHARED: 'fromDaemon' },
      checkoutPath: checkout,
    };

    const daemonOnly = resolveEnv({ ...base, command: {} });
    expect([daemonOnly.env.SHARED, daemonOnly.sources.SHARED]).toEqual(['fromDaemon', 'daemon']);

    const withPlaybook = resolveEnv({ ...base, command: { env: { SHARED: 'fromPlaybook' } } });
    expect([withPlaybook.env.SHARED, withPlaybook.sources.SHARED]).toEqual([
      'fromPlaybook',
      'playbook',
    ]);

    const withFile = resolveEnv({
      ...base,
      command: { env: { SHARED: 'fromPlaybook' }, envFile: '.env' },
    });
    expect([withFile.env.SHARED, withFile.sources.SHARED]).toEqual(['fromFile', 'envFile']);

    const withTarget = resolveEnv({
      ...base,
      command: { env: { SHARED: 'fromPlaybook' }, envFile: '.env' },
      targetEnv: { SHARED: 'fromTarget' },
    });
    expect([withTarget.env.SHARED, withTarget.sources.SHARED]).toEqual(['fromTarget', 'target']);
  });

  it('drops undefined daemon values', () => {
    const { env, sources } = resolveEnv({
      daemonEnv: { SET: 'yes', UNSET: undefined },
      command: {},
      checkoutPath: checkout,
    });

    expect(env).toEqual({ SET: 'yes' });
    expect(sources).toEqual({ SET: 'daemon' });
  });

  it('reports a missing envFile instead of throwing', () => {
    const { env, problems } = resolveEnv({
      daemonEnv: {},
      command: { env: { KEEP: 'yes' }, envFile: 'missing.env' },
      checkoutPath: checkout,
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/missing\.env/);
    expect(env.KEEP).toBe('yes');
  });

  it('resolves a relative envFile against the checkout', () => {
    mkdirSync(join(checkout, 'apps'), { recursive: true });
    writeFileSync(join(checkout, 'apps', 'local.env'), 'NESTED=1\n', 'utf-8');

    const { env, sources } = resolveEnv({
      daemonEnv: {},
      command: { envFile: 'apps/local.env' },
      checkoutPath: checkout,
    });

    expect(env.NESTED).toBe('1');
    expect(sources.NESTED).toBe('envFile');
  });
});

describe('parseEnvFile', () => {
  it('handles comments, blanks, quotes, export and embedded equals', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        '   ',
        'PLAIN=value',
        'export EXPORTED=exported',
        "SINGLE='single quoted'",
        'DOUBLE="double quoted"',
        'URL=postgres://user:pass@host:5432/db?ssl=true',
        'SPACED  =  padded  ',
        'EMPTY=',
        '#COMMENTED=nope',
        'no equals sign',
        '=novalue',
      ].join('\r\n'),
    );

    expect(parsed).toEqual({
      PLAIN: 'value',
      EXPORTED: 'exported',
      SINGLE: 'single quoted',
      DOUBLE: 'double quoted',
      URL: 'postgres://user:pass@host:5432/db?ssl=true',
      SPACED: 'padded',
      EMPTY: '',
    });
  });

  it('keeps quotes that do not surround the value', () => {
    expect(parseEnvFile('MSG=it\'s fine\nJSON={"a":1}')).toEqual({
      MSG: "it's fine",
      JSON: '{"a":1}',
    });
  });
});
