/**
 * The daemon side of the wire. Listens on a named pipe (Windows) or a unix
 * socket (everywhere else) — there is no port and no origin to check, because
 * pipe and filesystem permissions are the authorisation.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import { platform } from 'node:os';

import { socketPath } from '../paths.js';
import { PROTOCOL_VERSION, type HelloFrame, type RpcError } from '../types.js';
import { VERSION } from '../version.js';
import {
  DecodeError,
  encodeFrame,
  FrameDecoder,
  isRequestFrame,
  rpcError,
  toRpcError,
  UNSUBSCRIBE_METHOD,
} from './framing.js';

const IS_WINDOWS = platform() === 'win32';
const PROBE_TIMEOUT_MS = 500;

export type Unsubscribe = () => void;

export interface RequestContext {
  /** Request id; also the `stream` id of any subscription it opens. */
  id: number;
  method: string;
  /** Monotonic per-server connection number, for logging. */
  connectionId: number;
  /** Aborts when the client disconnects, so slow handlers can bail. */
  signal: AbortSignal;
}

export type RequestHandler = (
  method: string,
  params: unknown,
  ctx: RequestContext,
) => unknown | Promise<unknown>;

export type MethodHandler = (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;

/** Sink a subscription pushes into. Emits are ignored once ended or disconnected. */
export interface StreamEmitter {
  readonly closed: boolean;
  data(value: unknown): void;
  end(): void;
  error(reason: unknown): void;
}

const SUBSCRIPTION_BRAND = '__runMuxSubscription';

export interface SubscriptionHandle {
  readonly [SUBSCRIPTION_BRAND]: true;
  start(emit: StreamEmitter): Unsubscribe | void;
}

/**
 * Wraps a push source so a handler can return a stream instead of a value. The
 * returned function must stop the source; it runs on unsubscribe, on end, and
 * on disconnect.
 */
export function subscription(
  start: (emit: StreamEmitter) => Unsubscribe | void,
): SubscriptionHandle {
  return { [SUBSCRIPTION_BRAND]: true, start };
}

export function isSubscription(value: unknown): value is SubscriptionHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[SUBSCRIPTION_BRAND] === true
  );
}

/** Builds a handler from a method table, answering `unknown_method` for misses. */
export function methodRouter(methods: Record<string, MethodHandler>): RequestHandler {
  return (method, params, ctx) => {
    const fn = methods[method];
    if (!fn) throw rpcError('unknown_method', `unknown method: ${method}`);
    return fn(params, ctx);
  };
}

export interface IpcServerOptions {
  handler: RequestHandler;
  /** Anything the server survived: a bad frame, a handler throw, a write failure. */
  onError?: (error: Error, info: { connectionId?: number; method?: string }) => void;
  /** Reported in the hello frame; defaults to the package version. */
  version?: string;
  /** Defaults to `socketPath()`. */
  path?: string;
  maxFrameBytes?: number;
}

export interface IpcServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  readonly connections: number;
  readonly path: string;
}

export function createIpcServer(options: IpcServerOptions): IpcServer {
  const path = options.path ?? socketPath();
  const version = options.version ?? VERSION;
  const sockets = new Set<Socket>();
  let connectionSeq = 0;
  let listening = false;

  const report = (error: unknown, info: { connectionId?: number; method?: string } = {}): void => {
    const normalised = error instanceof Error ? error : new Error(String(error));
    options.onError?.(normalised, info);
  };

  const server: Server = createServer((socket) => {
    handleConnection(socket, ++connectionSeq);
  });
  server.on('error', (error) => report(error));

  function handleConnection(socket: Socket, connectionId: number): void {
    sockets.add(socket);
    socket.setNoDelay(true);

    const aborter = new AbortController();
    const subscriptions = new Map<number, Unsubscribe>();

    const write = (frame: unknown): boolean => {
      if (socket.destroyed || !socket.writable) return false;
      try {
        socket.write(encodeFrame(frame));
        return true;
      } catch (error) {
        report(error, { connectionId });
        return false;
      }
    };

    const hello: HelloFrame = {
      hello: true,
      version,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
    };
    write(hello);

    const decoder = new FrameDecoder({
      onFrame: (frame) => {
        if (!isRequestFrame(frame)) {
          report(new DecodeError('malformed', 'frame is not a request', JSON.stringify(frame)), {
            connectionId,
          });
          return;
        }
        void dispatch(frame.id, frame.method, frame.params);
      },
      onError: (error) => report(error, { connectionId }),
      maxFrameBytes: options.maxFrameBytes,
    });

    async function dispatch(id: number, method: string, params: unknown): Promise<void> {
      if (method === UNSUBSCRIBE_METHOD) {
        const target = streamIdOf(params);
        const dispose = target === undefined ? undefined : subscriptions.get(target);
        dispose?.();
        write({ id, ok: true, result: { stopped: dispose !== undefined } });
        return;
      }

      const ctx: RequestContext = { id, method, connectionId, signal: aborter.signal };
      let result: unknown;
      try {
        result = await options.handler(method, params, ctx);
      } catch (error) {
        const wire = toRpcError(error);
        if (wire.code === 'internal') report(error, { connectionId, method });
        write({ id, ok: false, error: wire });
        return;
      }

      if (isSubscription(result)) {
        openSubscription(id, method, result);
        return;
      }
      write({ id, ok: true, result });
    }

    function openSubscription(id: number, method: string, handle: SubscriptionHandle): void {
      if (subscriptions.has(id)) {
        const error: RpcError = { code: 'conflict', message: `stream ${id} is already open` };
        write({ id, ok: false, error });
        return;
      }

      let stop: Unsubscribe | undefined;
      let disposed = false;
      let finished = false;

      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        subscriptions.delete(id);
        if (!stop) return;
        try {
          stop();
        } catch (error) {
          report(error, { connectionId, method });
        }
      };

      const emit: StreamEmitter = {
        get closed() {
          return finished || disposed || socket.destroyed;
        },
        data(value) {
          if (finished || disposed) return;
          write({ stream: id, event: 'data', data: value });
        },
        end() {
          if (finished) return;
          finished = true;
          write({ stream: id, event: 'end' });
          dispose();
        },
        error(reason) {
          if (finished) return;
          finished = true;
          write({ stream: id, event: 'error', data: toRpcError(reason) });
          dispose();
        },
      };

      subscriptions.set(id, dispose);
      write({ id, ok: true, result: { subscribed: true, stream: id } });

      let returned: Unsubscribe | void;
      try {
        returned = handle.start(emit);
      } catch (error) {
        report(error, { connectionId, method });
        emit.error(error);
        return;
      }
      if (typeof returned === 'function') {
        stop = returned;
        // start() may have ended or the client may have unsubscribed before it
        // returned, in which case dispose() ran without a stop function to call.
        if (disposed) {
          try {
            stop();
          } catch (error) {
            report(error, { connectionId, method });
          }
        }
      }
    }

    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', (error) => report(error, { connectionId }));
    socket.on('close', () => {
      sockets.delete(socket);
      decoder.end();
      aborter.abort();
      // A leaked follow would keep the daemon pushing at a socket nobody reads.
      for (const dispose of subscriptions.values()) dispose();
      subscriptions.clear();
    });
  }

  return {
    get connections() {
      return sockets.size;
    },
    path,
    async listen(): Promise<void> {
      if (!IS_WINDOWS) await clearStaleSocket(path);
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
          server.off('error', onError);
          listening = true;
          resolve();
        };
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off('listening', onListening);
          reject(describeBindError(error, path));
        };
        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(path);
      });
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!listening) return;
      listening = false;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (!IS_WINDOWS && existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // Node normally unlinks it for us; a missing file is the goal anyway.
        }
      }
    },
  };
}

function streamIdOf(params: unknown): number | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const value = (params as { stream?: unknown }).stream;
  return typeof value === 'number' ? value : undefined;
}

/**
 * Bun on Windows reports a busy named pipe as a bare `Failed to listen at ...`
 * TypeError carrying a misleading `ERR_INVALID_ARG_TYPE` code and no `errno`,
 * where Node sets `EADDRINUSE`. Its genuine listen failures (a malformed path)
 * do carry an `errno`, so that is what tells the two apart.
 */
function describeBindError(error: NodeJS.ErrnoException, path: string): Error {
  const addressInUse =
    error.code === 'EADDRINUSE' ||
    (error.errno === undefined && error.message.startsWith('Failed to listen at '));
  if (addressInUse) {
    return rpcError(
      'conflict',
      `another run-mux daemon is already listening on ${path}; run \`rmux daemon restart\` if it is wedged`,
    );
  }
  return error;
}

/**
 * POSIX only: a unix socket file outlives the process that made it, so a crashed
 * daemon leaves one behind. Probing tells a corpse apart from a live daemon —
 * silently taking over a live address would split the world in two.
 */
async function clearStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  if (await isAddressLive(path)) {
    throw rpcError('conflict', `another run-mux daemon is already listening on ${path}`);
  }
  try {
    unlinkSync(path);
  } catch (error) {
    throw rpcError(
      'conflict',
      `could not remove the stale socket at ${path}: ${(error as Error).message}`,
    );
  }
}

function isAddressLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(path);
    const done = (live: boolean): void => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
