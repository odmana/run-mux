/**
 * The CLI side of the wire. One socket carries every request and every
 * subscription, correlated by request id.
 */

import { connect as netConnect } from 'node:net';

import { socketPath } from '../paths.js';
import {
  PROTOCOL_VERSION,
  type ErrResponse,
  type HelloFrame,
  type OkResponse,
  type RpcError,
} from '../types.js';
import {
  encodeFrame,
  FrameDecoder,
  isHelloFrame,
  isResponseFrame,
  isStreamFrame,
  RpcFailure,
  rpcError,
  UNSUBSCRIBE_METHOD,
} from './framing.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 1000;

export type Unsubscribe = () => void;

export interface SubscribeHandlers {
  onEnd?: () => void;
  onError?: (error: RpcError) => void;
}

export interface IpcClient {
  readonly hello: HelloFrame;
  readonly closed: boolean;
  request(method: string, params?: unknown): Promise<unknown>;
  subscribe(
    method: string,
    params: unknown,
    onData: (data: unknown) => void,
    handlers?: SubscribeHandlers,
  ): Promise<Unsubscribe>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Defaults to `socketPath()`. */
  path?: string;
  /** How long to wait for the hello frame. */
  timeoutMs?: number;
  /** Fires when the daemon goes away, including on a clean `close()`. */
  onClose?: (error?: Error) => void;
  maxFrameBytes?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface StreamHandlers {
  onData: (data: unknown) => void;
  onEnd?: () => void;
  onError?: (error: RpcError) => void;
}

/**
 * Resolves once the daemon's hello frame lands, so a caller never talks to a
 * daemon it has not shaken hands with.
 */
export function connect(options: ConnectOptions = {}): Promise<IpcClient> {
  const path = options.path ?? socketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise<IpcClient>((resolve, reject) => {
    const socket = netConnect(path);
    const pending = new Map<number, Pending>();
    const streams = new Map<number, StreamHandlers>();
    let hello: HelloFrame | undefined;
    let settled = false;
    let closed = false;
    let failure: Error | undefined;
    let nextId = 1;

    const timer = setTimeout(() => {
      abort(
        rpcError(
          'unavailable',
          `timed out after ${timeoutMs}ms connecting to the daemon at ${path}`,
        ),
      );
    }, timeoutMs);
    timer.unref();

    function abort(error: Error): void {
      failure ??= error;
      socket.destroy();
    }

    function settleReject(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }

    const send = (frame: unknown): boolean => {
      if (closed || socket.destroyed || !socket.writable) return false;
      try {
        socket.write(encodeFrame(frame));
        return true;
      } catch {
        return false;
      }
    };

    function sendRequest(id: number, method: string, params: unknown): Promise<unknown> {
      return new Promise<unknown>((res, rej) => {
        if (closed) {
          rej(rpcError('unavailable', 'the run-mux daemon connection is closed'));
          return;
        }
        pending.set(id, { resolve: res, reject: rej });
        if (!send({ id, method, params })) {
          pending.delete(id);
          rej(rpcError('unavailable', 'the run-mux daemon connection is closed'));
        }
      });
    }

    const client: IpcClient = {
      get hello() {
        if (!hello) throw rpcError('unavailable', 'the daemon handshake has not completed');
        return hello;
      },
      get closed() {
        return closed;
      },
      request(method, params) {
        return sendRequest(nextId++, method, params);
      },
      async subscribe(method, params, onData, handlers) {
        const id = nextId++;
        // Registered before the request goes out so a fast first frame is never
        // dropped between the ok response and the handler landing.
        streams.set(id, { onData, onEnd: handlers?.onEnd, onError: handlers?.onError });
        try {
          await sendRequest(id, method, params);
        } catch (error) {
          streams.delete(id);
          throw error;
        }
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          streams.delete(id);
          if (closed) return;
          void sendRequest(nextId++, UNSUBSCRIBE_METHOD, { stream: id }).catch(() => {});
        };
      },
      close() {
        return new Promise<void>((res) => {
          if (socket.destroyed) {
            res();
            return;
          }
          socket.once('close', () => res());
          const force = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
          force.unref();
          socket.end();
        });
      },
    };

    function route(frame: unknown): void {
      if (!hello) {
        if (!isHelloFrame(frame)) {
          abort(rpcError('internal', 'the daemon sent a frame before its hello frame'));
          return;
        }
        const mismatch = protocolMismatch(frame.protocol);
        if (mismatch) {
          abort(mismatch);
          return;
        }
        hello = frame;
        settled = true;
        clearTimeout(timer);
        resolve(client);
        return;
      }

      if (isResponseFrame(frame)) {
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve((frame as OkResponse).result);
        else {
          const error = (frame as ErrResponse).error;
          waiter.reject(new RpcFailure(error.code, error.message, error.data));
        }
        return;
      }

      if (isStreamFrame(frame)) {
        const handlers = streams.get(frame.stream);
        if (!handlers) return;
        if (frame.event === 'data') {
          handlers.onData(frame.data);
          return;
        }
        streams.delete(frame.stream);
        if (frame.event === 'end') handlers.onEnd?.();
        else handlers.onError?.(asRpcError(frame.data));
      }
    }

    const decoder = new FrameDecoder({
      onFrame: route,
      onError: (error) => {
        // A bad frame before the handshake means this is not a run-mux daemon.
        if (!hello) abort(rpcError('internal', `unreadable daemon handshake: ${error.message}`));
      },
      maxFrameBytes: options.maxFrameBytes,
    });

    socket.setNoDelay(true);
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      failure ??= describeSocketError(error, path);
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      decoder.end();
      const error = failure ?? rpcError('unavailable', 'the run-mux daemon connection closed');
      // Anything still in flight is never getting an answer; fail it now rather
      // than leaving the caller hanging on a dead daemon.
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      const wire: RpcError = { code: 'unavailable', message: error.message };
      for (const handlers of streams.values()) handlers.onError?.(wire);
      streams.clear();
      settleReject(error);
      options.onClose?.(failure);
    });
  });
}

/** The integer part is the major; a bump means the frames themselves changed. */
function protocolMismatch(protocol: number): Error | undefined {
  if (Math.floor(protocol) === Math.floor(PROTOCOL_VERSION)) return undefined;
  return rpcError(
    'conflict',
    `the running run-mux daemon speaks protocol ${protocol} but this build speaks ${PROTOCOL_VERSION}; run \`rmux daemon restart\``,
  );
}

function describeSocketError(error: NodeJS.ErrnoException, path: string): Error {
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return rpcError('unavailable', `no run-mux daemon is listening at ${path}`);
  }
  return error;
}

function asRpcError(data: unknown): RpcError {
  if (typeof data === 'object' && data !== null) {
    const candidate = data as { code?: unknown; message?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return { code: candidate.code as RpcError['code'], message: candidate.message };
    }
  }
  return { code: 'internal', message: typeof data === 'string' ? data : 'stream failed' };
}
