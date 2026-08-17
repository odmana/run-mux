import { EXIT_CODES, JSON_CONTRACT_VERSION, type ErrorCode } from '../types.js';

/**
 * The --json contract, in one place. stdout carries only JSON when json mode is
 * on; every diagnostic goes to stderr. Breaking that split silently breaks any
 * agent parsing our output, so nothing else in the CLI may write to stdout.
 */

const ESC = String.fromCharCode(27);

export interface Out {
  json: boolean;
  color: boolean;
}

export function makeOut(json: boolean, noColor = false): Out {
  return {
    json,
    // Colour is suppressed under --json unconditionally: an escape code inside a
    // parsed field is a bug we would never see in a terminal.
    color: !json && !noColor && process.stdout.isTTY === true && !process.env.NO_COLOR,
  };
}

export function emit(out: Out, payload: Record<string, unknown>): void {
  if (!out.json) return;
  process.stdout.write(JSON.stringify({ v: JSON_CONTRACT_VERSION, ...payload }) + '\n');
}

/** One NDJSON object per line, for streaming verbs like `logs --follow`. */
export function emitLine(out: Out, payload: Record<string, unknown>): void {
  emit(out, payload);
}

export function human(out: Out, text: string): void {
  if (out.json) return;
  process.stdout.write(text + '\n');
}

export function diag(text: string): void {
  process.stderr.write(text + '\n');
}

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Errors are reported twice over: a structured object for parsers and a
 * non-zero exit for shell tests. Emitting only one of the two breaks half the
 * callers.
 */
export function reportError(out: Out, error: CliError): number {
  if (out.json) {
    process.stdout.write(
      JSON.stringify({
        v: JSON_CONTRACT_VERSION,
        error: { code: error.code, message: error.message, ...error.detail },
      }) + '\n',
    );
  } else {
    diag(`error: ${error.message}`);
    const matches = error.detail?.matches;
    if (Array.isArray(matches)) {
      for (const match of matches) diag(`  ${String(match)}`);
    }
  }
  return EXIT_CODES[error.code];
}

const CODES = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
  blue: `${ESC}[34m`,
  cyan: `${ESC}[36m`,
} as const;

export function paint(out: Out, code: keyof typeof CODES, text: string): string {
  return out.color ? `${CODES[code]}${text}${CODES.reset}` : text;
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Pads a column without counting ANSI bytes as visible width. */
export function pad(text: string, width: number): string {
  const visible = text.replaceAll(ANSI_PATTERN, '').length;
  return text + ' '.repeat(Math.max(0, width - visible));
}
