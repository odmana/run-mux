import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connect,
  createIpcServer,
  DecodeError,
  encodeFrame,
  ensureDaemon,
  FrameDecoder,
  methodRouter,
  rpcError,
  RpcFailure,
  subscription,
  type IpcClient,
  type IpcServer,
  type RequestHandler,
  type StreamEmitter,
} from '../src/ipc/index.js';
import { daemonLogPath, lockPath, socketPath } from '../src/paths.js';
import { PROTOCOL_VERSION } from '../src/types.js';
import { isAlive, useTempHome, waitFor, type TempHome } from './helpers.js';

const STUB_DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-daemon.mjs');

let home: TempHome;
const servers: IpcServer[] = [];
const clients: IpcClient[] = [];
const rawSockets: Socket[] = [];
const rawServers: Server[] = [];
const daemonPids: number[] = [];

beforeEach(() => {
  home = useTempHome();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  for (const socket of rawSockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
  await Promise.all(
    rawServers.splice(0).map((server) => new Promise<void>((res) => server.close(() => res()))),
  );
  const pids = daemonPids.splice(0);
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  if (pids.length > 0)
    await waitFor(() => pids.every((pid) => !isAlive(pid)), { label: 'daemon exit' });
  home.cleanup();
});

async function startServer(
  handler: RequestHandler,
  onError?: (error: Error) => void,
): Promise<IpcServer> {
  const server = createIpcServer({ handler, onError: onError ?? (() => {}) });
  servers.push(server);
  await server.listen();
  return server;
}

async function startClient(): Promise<IpcClient> {
  const client = await connect({ timeoutMs: 5000 });
  clients.push(client);
  return client;
}

interface RawClient {
  frames: Record<string, unknown>[];
  send(frame: unknown): void;
  waitForFrames(n: number): Promise<void>;
}

async function rawConnect(): Promise<RawClient> {
  const socket = netConnect(socketPath());
  rawSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  const decoder = new FrameDecoder({
    onFrame: (frame) => frames.push(frame as Record<string, unknown>),
  });
  socket.on('data', (chunk) => decoder.push(chunk));
  await new Promise<void>((res, rej) => {
    socket.once('connect', () => res());
    socket.once('error', rej);
  });
  return {
    frames,
    send: (frame) => void socket.write(encodeFrame(frame)),
    waitForFrames: (n) => waitFor(() => frames.length >= n, { label: `${n} frames` }),
  };
}

async function caught(promise: Promise<unknown>): Promise<RpcFailure> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (error === undefined) throw new Error('expected the promise to reject');
  return error as RpcFailure;
}

function decoderHarness(maxFrameBytes?: number) {
  const frames: unknown[] = [];
  const errors: DecodeError[] = [];
  const decoder = new FrameDecoder({
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
    maxFrameBytes,
  });
  return { decoder, frames, errors };
}

function findDeadPid(): number {
  for (let pid = 999_991; pid > 900_000; pid -= 13) {
    if (!isAlive(pid)) return pid;
  }
  throw new Error('could not find an unused pid');
}

function counter(emit: StreamEmitter, total: number, tag = 'n'): () => void {
  let sent = 0;
  const timer = setInterval(() => {
    sent++;
    emit.data(`${tag}${sent}`);
    if (sent >= total) emit.end();
  }, 5);
  return () => clearInterval(timer);
}

function startsLogLines(): string[] {
  const raw = readFileSync(join(home.root, 'state', 'stub-daemon-starts.log'), 'utf-8');
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

describe('framing', () => {
  it('reassembles a frame split across many chunks', () => {
    const { decoder, frames, errors } = decoderHarness();
    const bytes = Buffer.from(encodeFrame({ id: 1, method: 'go', params: { text: 'héllo 🌍' } }));
    for (let i = 0; i < bytes.length; i += 5) decoder.push(bytes.subarray(i, i + 5));

    expect(frames).toEqual([{ id: 1, method: 'go', params: { text: 'héllo 🌍' } }]);
    expect(errors).toEqual([]);
  });

  it('decodes several frames arriving in one chunk', () => {
    const { decoder, frames } = decoderHarness();
    const chunk = [1, 2, 3].map((id) => encodeFrame({ id, method: 'go' })).join('');
    decoder.push(chunk);

    expect(frames).toHaveLength(3);
    expect(frames.map((f) => (f as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it('survives a frame far larger than a chunk', () => {
    const { decoder, frames, errors } = decoderHarness();
    const payload = 'x'.repeat(1_000_000);
    const bytes = Buffer.from(encodeFrame({ id: 9, method: 'logs', params: { payload } }));
    for (let i = 0; i < bytes.length; i += 65_536) decoder.push(bytes.subarray(i, i + 65_536));

    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    expect((frames[0] as { params: { payload: string } }).params.payload).toHaveLength(1_000_000);
  });

  it('reports a malformed line without killing the stream', () => {
    const { decoder, frames, errors } = decoderHarness();
    decoder.push('{"id":1,"method":"a"}\nthis is not json\n{"id":2,"method":"b"}\n');

    expect(frames).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('malformed');
    expect(errors[0]?.sample).toContain('not json');
  });

  it('ignores empty lines and reports a truncated trailing frame at close', () => {
    const { decoder, frames, errors } = decoderHarness();
    decoder.push('\n\n{"id":1,"method":"a"}\n\n{"id":2,"met');
    expect(frames).toHaveLength(1);
    expect(errors).toEqual([]);

    decoder.end();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('truncated');
  });

  it('caps an oversized frame that arrives whole and recovers', () => {
    const { decoder, frames, errors } = decoderHarness(64);
    decoder.push(`{"id":1,"method":"${'y'.repeat(500)}"}\n`);
    decoder.push('{"id":2,"method":"ok"}\n');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('too_large');
    expect(frames).toEqual([{ id: 2, method: 'ok' }]);
  });

  it('caps an oversized frame before it has a newline, without buffering it', () => {
    const { decoder, frames, errors } = decoderHarness(64);
    decoder.push(`{"id":1,"method":"${'y'.repeat(200)}`);
    decoder.push(`${'y'.repeat(200)}"}`);
    decoder.push('\n{"id":2,"method":"ok"}\n');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toBe('too_large');
    expect(frames).toEqual([{ id: 2, method: 'ok' }]);
  });
});

describe('server and client', () => {
  it('sends the hello frame before anything else', async () => {
    await startServer(methodRouter({ ping: () => 'pong' }));
    const raw = await rawConnect();
    raw.send({ id: 1, method: 'ping' });
    await raw.waitForFrames(2);

    expect(raw.frames[0]).toEqual({
      hello: true,
      version: expect.any(String),
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
    });
    expect(raw.frames[1]).toEqual({ id: 1, ok: true, result: 'pong' });
  });

  it('exposes the handshake to the client', async () => {
    const server = await startServer(methodRouter({ ping: () => 'pong' }));
    const client = await startClient();

    expect(client.hello.protocol).toBe(PROTOCOL_VERSION);
    expect(client.hello.pid).toBe(process.pid);
    expect(server.connections).toBe(1);
  });

  it('round-trips a request carrying a complex result', async () => {
    const result = {
      targets: [{ slug: 'repo/main:dev', commands: [{ label: 'api', restarts: 2 }] }],
      slots: { 'repo/main': 0 },
      nested: { deep: { deeper: [1, 'two', null, true] } },
    };
    await startServer(methodRouter({ status: (params) => ({ ...result, echoed: params }) }));
    const client = await startClient();

    expect(await client.request('status', { filter: 'all' })).toEqual({
      ...result,
      echoed: { filter: 'all' },
    });
  });

  it('answers an unknown method with unknown_method', async () => {
    await startServer(methodRouter({ ping: () => 'pong' }));
    const client = await startClient();

    const error = await caught(client.request('nope'));
    expect(error).toBeInstanceOf(RpcFailure);
    expect(error.code).toBe('unknown_method');
    expect(error.message).toContain('nope');
  });

  it('turns a thrown handler into internal and stays up', async () => {
    const reported: Error[] = [];
    const server = await startServer(
      methodRouter({
        boom: () => {
          throw new Error('kaboom');
        },
        ping: () => 'pong',
      }),
      (error) => reported.push(error),
    );
    const client = await startClient();

    const error = await caught(client.request('boom'));
    expect(error.code).toBe('internal');
    expect(error.message).toBe('kaboom');
    expect(reported.map((e) => e.message)).toContain('kaboom');

    expect(await client.request('ping')).toBe('pong');
    expect(server.connections).toBe(1);
  });

  it('rejects an in-flight request when the daemon dies', async () => {
    const server = await startServer(methodRouter({ hang: () => new Promise(() => {}) }));
    const client = await startClient();

    const inFlight = client.request('hang');
    await waitFor(() => server.connections === 1, { label: 'connection' });
    await server.close();

    const error = await caught(inFlight);
    expect(error.code).toBe('unavailable');
  });
});

describe('structured error detail', () => {
  it('rejects the caller with the data the handler attached', async () => {
    await startServer(
      methodRouter({
        ambiguous: () => {
          throw rpcError('ambiguous', '"orders" matches 2 targets', {
            matches: ['orders/main:dev', 'orders/feat:dev'],
          });
        },
        plain: () => {
          throw rpcError('not_found', 'no target matches "nope"');
        },
        ping: () => 'pong',
      }),
    );
    const client = await startClient();

    const rich = await caught(client.request('ambiguous'));
    expect(rich.code).toBe('ambiguous');
    expect(rich.data).toEqual({ matches: ['orders/main:dev', 'orders/feat:dev'] });

    const plain = await caught(client.request('plain'));
    expect(plain.code).toBe('not_found');
    expect(plain.data).toBeUndefined();

    expect(await client.request('ping')).toBe('pong');
  });

  it('puts data on the wire only when there is some', async () => {
    await startServer(
      methodRouter({
        rich: () => {
          throw rpcError('conflict', 'busy', { slug: 'orders/main:dev' });
        },
        bare: () => {
          throw rpcError('conflict', 'busy');
        },
      }),
    );
    const raw = await rawConnect();
    raw.send({ id: 1, method: 'rich' });
    raw.send({ id: 2, method: 'bare' });
    await raw.waitForFrames(3);

    expect(raw.frames[1]).toEqual({
      id: 1,
      ok: false,
      error: { code: 'conflict', message: 'busy', data: { slug: 'orders/main:dev' } },
    });
    expect(raw.frames[2]).toEqual({
      id: 2,
      ok: false,
      error: { code: 'conflict', message: 'busy' },
    });
  });
});

describe('subscriptions', () => {
  it('delivers several frames then ends', async () => {
    await startServer(
      methodRouter({
        count: (params) => subscription((emit) => counter(emit, (params as { n: number }).n)),
      }),
    );
    const client = await startClient();

    const received: unknown[] = [];
    let ended = false;
    await client.subscribe('count', { n: 4 }, (data) => received.push(data), {
      onEnd: () => {
        ended = true;
      },
    });
    await waitFor(() => ended, { label: 'stream end' });

    expect(received).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('stops delivering once unsubscribed', async () => {
    let stopped = false;
    await startServer(
      methodRouter({
        forever: () =>
          subscription((emit) => {
            const stop = counter(emit, Number.MAX_SAFE_INTEGER);
            return () => {
              stopped = true;
              stop();
            };
          }),
        ping: () => 'pong',
      }),
    );
    const client = await startClient();

    const received: unknown[] = [];
    const unsubscribe = await client.subscribe('forever', {}, (data) => received.push(data));
    await waitFor(() => received.length >= 2, { label: 'first frames' });
    unsubscribe();

    await waitFor(() => stopped, { label: 'server-side stop' });
    const seen = received.length;
    await client.request('ping');
    await client.request('ping');
    expect(received).toHaveLength(seen);
  });

  it('tears the subscription down server-side when the client disconnects', async () => {
    let stopped = false;
    let ticks = 0;
    const server = await startServer(
      methodRouter({
        follow: () =>
          subscription((emit) => {
            const timer = setInterval(() => {
              ticks++;
              emit.data(ticks);
            }, 5);
            return () => {
              stopped = true;
              clearInterval(timer);
            };
          }),
        ping: () => 'pong',
      }),
    );
    const client = await connect({ timeoutMs: 5000 });

    const received: unknown[] = [];
    await client.subscribe('follow', {}, (data) => received.push(data));
    await waitFor(() => received.length >= 2, { label: 'first frames' });

    await client.close();
    await waitFor(() => stopped, { label: 'server-side teardown' });
    await waitFor(() => server.connections === 0, { label: 'connection drop' });

    const ticksAtTeardown = ticks;
    const probe = await startClient();
    await probe.request('ping');
    await probe.request('ping');
    expect(ticks).toBe(ticksAtTeardown);
  });

  it('gives concurrent clients independent responses and subscriptions', async () => {
    await startServer(
      methodRouter({
        who: (params) => ({ seen: params }),
        count: (params) => {
          const { n, tag } = params as { n: number; tag: string };
          return subscription((emit) => counter(emit, n, tag));
        },
      }),
    );
    const alpha = await startClient();
    const beta = await startClient();

    const [alphaSaid, betaSaid] = await Promise.all([
      alpha.request('who', 'alpha'),
      beta.request('who', 'beta'),
    ]);
    expect(alphaSaid).toEqual({ seen: 'alpha' });
    expect(betaSaid).toEqual({ seen: 'beta' });

    const alphaData: unknown[] = [];
    const betaData: unknown[] = [];
    let alphaEnded = false;
    let betaEnded = false;
    await alpha.subscribe('count', { n: 3, tag: 'a' }, (d) => alphaData.push(d), {
      onEnd: () => {
        alphaEnded = true;
      },
    });
    await beta.subscribe('count', { n: 2, tag: 'b' }, (d) => betaData.push(d), {
      onEnd: () => {
        betaEnded = true;
      },
    });
    await waitFor(() => alphaEnded && betaEnded, { label: 'both streams end' });

    expect(alphaData).toEqual(['a1', 'a2', 'a3']);
    expect(betaData).toEqual(['b1', 'b2']);
  });
});

describe('binding and protocol', () => {
  it('refuses to bind when a live daemon holds the address', async () => {
    await startServer(methodRouter({ ping: () => 'pong' }));
    const second = createIpcServer({ handler: () => null, onError: () => {} });
    servers.push(second);

    const error = await caught(second.listen());
    expect(error.message).toMatch(/already listening|in use/i);
  });

  it.skipIf(process.platform === 'win32')(
    'removes a stale unix socket file before binding',
    async () => {
      writeFileSync(socketPath(), '');

      await startServer(methodRouter({ ping: () => 'pong' }));
      const client = await startClient();
      expect(await client.request('ping')).toBe('pong');
    },
  );

  it('rejects a daemon speaking a different protocol major', async () => {
    const server = createServer((socket) => {
      socket.write(`${JSON.stringify({ hello: true, version: 'x', protocol: 2, pid: 1 })}\n`);
    });
    rawServers.push(server);
    await new Promise<void>((res, rej) => {
      server.once('error', rej);
      server.listen(socketPath(), () => res());
    });

    const error = await caught(connect({ timeoutMs: 5000 }));
    expect(error.message).toContain('rmux daemon restart');
    expect(error.message).toContain('protocol 2');
  });
});

describe('autospawn', () => {
  it('starts the daemon when none is running and connects to it', async () => {
    const client = await ensureDaemon({ entry: STUB_DAEMON, timeoutMs: 8000 });
    clients.push(client);
    daemonPids.push(client.hello.pid);

    expect(client.hello.protocol).toBe(PROTOCOL_VERSION);
    expect(client.hello.pid).not.toBe(process.pid);
    expect(await client.request('echo', { hi: 'there' })).toEqual({ hi: 'there' });
    expect(startsLogLines()).toHaveLength(1);

    await waitFor(() => readFileSync(daemonLogPath(), 'utf-8').includes('listening on'), {
      label: 'daemon log',
    });
    expect(existsSync(lockPath())).toBe(false);
  });

  it('streams a subscription from the spawned daemon', async () => {
    const client = await ensureDaemon({ entry: STUB_DAEMON, timeoutMs: 8000 });
    clients.push(client);
    daemonPids.push(client.hello.pid);

    const received: unknown[] = [];
    let ended = false;
    await client.subscribe('count', { n: 3 }, (data) => received.push(data), {
      onEnd: () => {
        ended = true;
      },
    });
    await waitFor(() => ended, { label: 'stub stream end' });
    expect(received).toEqual([1, 2, 3]);
  });

  it('spawns exactly one daemon when several callers race', async () => {
    const racers = await Promise.all(
      Array.from({ length: 5 }, () => ensureDaemon({ entry: STUB_DAEMON, timeoutMs: 8000 })),
    );
    for (const client of racers) clients.push(client);
    const pids = new Set(racers.map((client) => client.hello.pid));
    daemonPids.push(...pids);

    expect(pids.size).toBe(1);
    expect(startsLogLines()).toHaveLength(1);
    expect(await Promise.all(racers.map((c) => c.request('echo', 'ok')))).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
  });

  it('reclaims a lock left behind by a dead process', async () => {
    const dead = findDeadPid();
    writeFileSync(lockPath(), `${dead}\n`);

    const client = await ensureDaemon({ entry: STUB_DAEMON, timeoutMs: 8000 });
    clients.push(client);
    daemonPids.push(client.hello.pid);

    expect(await client.request('echo', 'alive')).toBe('alive');
    expect(startsLogLines()).toHaveLength(1);
  });

  it('reuses a daemon that is already running', async () => {
    const first = await ensureDaemon({ entry: STUB_DAEMON, timeoutMs: 8000 });
    clients.push(first);
    daemonPids.push(first.hello.pid);

    const second = await ensureDaemon({ entry: STUB_DAEMON, timeoutMs: 8000 });
    clients.push(second);

    expect(second.hello.pid).toBe(first.hello.pid);
    expect(startsLogLines()).toHaveLength(1);
  });
});
