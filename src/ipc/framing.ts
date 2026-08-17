/**
 * Newline-delimited JSON framing plus the error type both ends of the wire
 * share. Nothing here touches a socket, so it is directly testable.
 */

import type {
  ErrorCode,
  Frame,
  HelloFrame,
  RequestFrame,
  ResponseFrame,
  RpcError,
  StreamFrame,
} from '../types.js';

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
const SAMPLE_CHARS = 160;

/** Log replay frames are the big ones; anything past this is a runaway. */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Reserved method: cancels the subscription named by `params.stream`. */
export const UNSUBSCRIBE_METHOD = '$unsubscribe';

export type DecodeErrorReason = 'malformed' | 'too_large' | 'truncated';

export class DecodeError extends Error {
  readonly reason: DecodeErrorReason;
  /** Head of the offending text, for logs. */
  readonly sample: string;

  constructor(reason: DecodeErrorReason, message: string, sample = '') {
    super(message);
    this.name = 'DecodeError';
    this.reason = reason;
    this.sample = sample;
  }
}

export function encodeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}

export interface FrameDecoderOptions {
  onFrame: (frame: unknown) => void;
  onError?: (error: DecodeError) => void;
  maxFrameBytes?: number;
}

/**
 * Feeds bytes in, whole JSON values out. Chunk boundaries are irrelevant: a
 * frame may span many chunks and a chunk may hold many frames. A line that
 * fails to parse is reported and skipped rather than killing the connection.
 */
export class FrameDecoder {
  private buffer: Buffer = EMPTY;
  /** Set while skipping the tail of a frame that blew the size limit. */
  private discarding = false;
  private readonly onFrame: (frame: unknown) => void;
  private readonly onError: ((error: DecodeError) => void) | undefined;
  private readonly maxFrameBytes: number;

  constructor(options: FrameDecoderOptions) {
    this.onFrame = options.onFrame;
    this.onError = options.onError;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  push(chunk: Buffer | Uint8Array | string): void {
    const next =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next]);

    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf(NEWLINE, start);
      if (nl === -1) break;
      const line = this.buffer.subarray(start, nl);
      start = nl + 1;
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (line.length > this.maxFrameBytes) {
        this.fail(
          new DecodeError(
            'too_large',
            `frame exceeds the ${this.maxFrameBytes} byte limit`,
            line.subarray(0, SAMPLE_CHARS).toString('utf8'),
          ),
        );
        continue;
      }
      this.handleLine(line);
    }
    this.buffer = start === 0 ? this.buffer : this.buffer.subarray(start);

    if (this.discarding) {
      this.buffer = EMPTY;
      return;
    }
    if (this.buffer.length > this.maxFrameBytes) {
      const sample = this.buffer.subarray(0, SAMPLE_CHARS).toString('utf8');
      this.buffer = EMPTY;
      this.discarding = true;
      this.fail(
        new DecodeError('too_large', `frame exceeds the ${this.maxFrameBytes} byte limit`, sample),
      );
    }
  }

  /** Call when the stream ends so a truncated trailing frame is reported. */
  end(): void {
    const leftover = this.buffer;
    const wasDiscarding = this.discarding;
    this.buffer = EMPTY;
    this.discarding = false;
    if (wasDiscarding || leftover.length === 0) return;
    const text = leftover.toString('utf8').trim();
    if (text.length === 0) return;
    this.fail(new DecodeError('truncated', 'stream ended mid-frame', text.slice(0, SAMPLE_CHARS)));
  }

  private handleLine(line: Buffer): void {
    if (line.length === 0) return;
    const text = line.toString('utf8').trim();
    if (text.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.fail(
        new DecodeError(
          'malformed',
          `malformed frame: ${error instanceof Error ? error.message : String(error)}`,
          text.slice(0, SAMPLE_CHARS),
        ),
      );
      return;
    }
    this.onFrame(parsed);
  }

  private fail(error: DecodeError): void {
    this.onError?.(error);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A failure that carries a wire `ErrorCode`, so the CLI can pick an exit code. */
export class RpcFailure extends Error {
  readonly code: ErrorCode;
  /** Structured detail, e.g. the candidates behind an `ambiguous`. Optional. */
  readonly data?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'RpcFailure';
    this.code = code;
    this.data = data;
  }
}

export function rpcError(
  code: ErrorCode,
  message: string,
  data?: Record<string, unknown>,
): RpcFailure {
  return new RpcFailure(code, message, data);
}

export function isRpcFailure(value: unknown): value is RpcFailure {
  if (value instanceof RpcFailure) return true;
  return (
    value instanceof Error &&
    value.name === 'RpcFailure' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

/** Anything a handler throws becomes a wire error; unknown throws are internal. */
export function toRpcError(error: unknown): RpcError {
  if (isRpcFailure(error)) {
    const { code, message, data } = error;
    // `data` is omitted rather than sent as null, so an old client reading the
    // frame sees exactly the shape it saw before.
    return data === undefined ? { code, message } : { code, message, data };
  }
  if (error instanceof Error) return { code: 'internal', message: error.message };
  return { code: 'internal', message: String(error) };
}

// ---------------------------------------------------------------------------
// Frame guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isHelloFrame(frame: unknown): frame is HelloFrame {
  return isRecord(frame) && frame.hello === true && typeof frame.protocol === 'number';
}

export function isRequestFrame(frame: unknown): frame is RequestFrame {
  return isRecord(frame) && typeof frame.id === 'number' && typeof frame.method === 'string';
}

export function isResponseFrame(frame: unknown): frame is ResponseFrame {
  return isRecord(frame) && typeof frame.id === 'number' && typeof frame.ok === 'boolean';
}

export function isStreamFrame(frame: unknown): frame is StreamFrame {
  return isRecord(frame) && typeof frame.stream === 'number' && typeof frame.event === 'string';
}

export type { Frame };
