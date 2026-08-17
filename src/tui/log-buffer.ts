/**
 * Where log retention lives.
 *
 * The M0 spike measured the alternative: one `setState` per arriving line, every
 * line kept in component state, collapses to 1 fps and drops 31% of its input
 * inside 30 seconds. So the buffer holds the lines and React state holds only
 * the window that is actually drawn — `window()` is the only thing a component
 * ever puts in state, and it is bounded by the pane's height.
 */

import type { LogEntry } from '../types.js';

export interface LogLine {
  /** Monotonic across the whole run, so a line keeps its identity after a trim. */
  seq: number;
  ts: number;
  label: string;
  stream: 'stdout' | 'stderr';
  /** One line, ANSI preserved exactly as the command wrote it. */
  text: string;
}

export interface LogFilter {
  /** `null` means every label — the `a` chip and the initial state. */
  labels: ReadonlySet<string> | null;
  search: string | null;
}

export const ALL: LogFilter = { labels: null, search: null };

export interface LogWindow {
  lines: LogLine[];
  /** The caller's `scrollBack` clamped to what the buffer can actually offer. */
  scrollBack: number;
  atTop: boolean;
  atBottom: boolean;
}

const DEFAULT_RETAIN = 50_000;
/** Trimming in blocks keeps `append` O(1) amortised instead of shifting per line. */
const TRIM_SLACK = 2048;

export function matches(line: LogLine, filter: LogFilter): boolean {
  if (filter.labels !== null && !filter.labels.has(line.label)) return false;
  if (filter.search !== null && filter.search !== '') {
    return line.text.toLowerCase().includes(filter.search.toLowerCase());
  }
  return true;
}

export class LogBuffer {
  readonly #retain: number;
  #lines: LogLine[] = [];
  #nextSeq = 0;
  #dropped = 0;
  /**
   * The daemon forwards raw stdout chunks, which split mid-line whenever the
   * pipe felt like it. A chunk that does not end in a newline leaves its tail
   * here so the continuation lands on the same rendered line.
   */
  #partial = new Map<string, LogLine>();

  constructor(retain: number = DEFAULT_RETAIN) {
    this.#retain = Math.max(1, retain);
  }

  /** Lines ever produced, including any since trimmed. */
  get total(): number {
    return this.#nextSeq;
  }

  get retained(): number {
    return this.#lines.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get lines(): readonly LogLine[] {
    return this.#lines;
  }

  append(entry: LogEntry): void {
    const text = entry.text.replaceAll('\r\n', '\n').replaceAll('\r', '');
    const parts = text.split('\n');
    let start = 0;

    const pending = this.#partial.get(entry.label);
    if (pending !== undefined) {
      pending.text += parts[0] ?? '';
      this.#partial.delete(entry.label);
      if (parts.length === 1) {
        this.#partial.set(entry.label, pending);
        return;
      }
      start = 1;
    }

    for (let i = start; i < parts.length; i++) {
      const piece = parts[i]!;
      const last = i === parts.length - 1;
      if (last && piece === '') break;
      const line: LogLine = {
        seq: this.#nextSeq++,
        ts: entry.ts,
        label: entry.label,
        stream: entry.stream,
        text: piece,
      };
      this.#lines.push(line);
      if (last) this.#partial.set(entry.label, line);
    }

    this.#trim();
  }

  /** Newest-last slice of the lines matching `filter`, `height` rows at most. */
  window(filter: LogFilter, height: number, scrollBack: number): LogWindow {
    const rows = Math.max(0, height);
    const want = Math.max(0, scrollBack) + rows;
    const found: LogLine[] = [];
    let index = this.#lines.length - 1;
    for (; index >= 0 && found.length < want; index--) {
      const line = this.#lines[index]!;
      if (matches(line, filter)) found.push(line);
    }
    const exhausted = index < 0;
    const clamped = Math.min(Math.max(0, scrollBack), Math.max(0, found.length - rows));
    const lines = found.slice(clamped, clamped + rows).reverse();
    return {
      lines,
      scrollBack: clamped,
      atTop: exhausted && clamped + rows >= found.length,
      atBottom: clamped === 0,
    };
  }

  /**
   * Matching lines with `seq >= from`. A pane scrolled away from the tail adds
   * this to its scrollBack so the rows under the cursor do not slide upward
   * while new output arrives.
   */
  countSince(from: number, filter: LogFilter): number {
    let count = 0;
    for (let i = this.#lines.length - 1; i >= 0; i--) {
      const line = this.#lines[i]!;
      if (line.seq < from) break;
      if (matches(line, filter)) count++;
    }
    return count;
  }

  labels(): string[] {
    const seen = new Set<string>();
    for (const line of this.#lines) seen.add(line.label);
    return [...seen];
  }

  clear(): void {
    this.#lines = [];
    this.#partial.clear();
    this.#nextSeq = 0;
    this.#dropped = 0;
  }

  #trim(): void {
    if (this.#lines.length <= this.#retain + TRIM_SLACK) return;
    const excess = this.#lines.length - this.#retain;
    this.#lines.splice(0, excess);
    this.#dropped += excess;
  }
}
