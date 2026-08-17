import type { LogEntry, LogQuery } from '../types.js';

/**
 * Per-label budget. Each command label keeps its own recent output up to this
 * many bytes so a chatty command cannot evict a quiet one's history. Total
 * memory is roughly (number of labels) * this limit.
 */
export const TAIL_LIMIT_PER_LABEL = 64 * 1024;

/** True when the entry passes the `label` and `since` filters. */
export function matchesQuery(entry: LogEntry, query: LogQuery): boolean {
  if (query.label !== undefined && entry.label !== query.label) return false;
  if (query.since !== undefined && entry.ts <= query.since) return false;
  return true;
}

/** Last N entries, or all of them when no tail was asked for. */
export function applyTail<T>(entries: T[], tail: number | undefined): T[] {
  if (tail === undefined) return entries;
  if (tail <= 0) return [];
  return entries.length <= tail ? entries : entries.slice(entries.length - tail);
}

interface Slot {
  order: number;
  entry: LogEntry;
}

interface LabelBuffer {
  slots: Slot[];
  bytes: number;
}

/**
 * The in-memory tail an attaching client gets instantly, before it reads any
 * JSONL. Entries are bucketed per label and trimmed within their own bucket;
 * `order` is what puts them back into append order on the way out.
 */
export class LogTail {
  private readonly buffers = new Map<string, LabelBuffer>();
  private order = 0;

  constructor(private readonly limitPerLabel: number = TAIL_LIMIT_PER_LABEL) {}

  push(entry: LogEntry): void {
    let buffer = this.buffers.get(entry.label);
    if (!buffer) {
      buffer = { slots: [], bytes: 0 };
      this.buffers.set(entry.label, buffer);
    }
    buffer.slots.push({ order: this.order++, entry });
    buffer.bytes += Buffer.byteLength(entry.text);

    // Trim only this label's oldest entries until it is back under its own
    // budget, leaving every other label untouched. Keep at least one entry so a
    // single oversized chunk cannot erase the label entirely.
    while (buffer.bytes > this.limitPerLabel && buffer.slots.length > 1) {
      const dropped = buffer.slots.shift();
      if (!dropped) break;
      buffer.bytes -= Buffer.byteLength(dropped.entry.text);
    }
  }

  snapshot(query: LogQuery = {}): LogEntry[] {
    const slots: Slot[] = [];
    for (const [label, buffer] of this.buffers) {
      if (query.label !== undefined && query.label !== label) continue;
      for (const slot of buffer.slots) {
        if (matchesQuery(slot.entry, query)) slots.push(slot);
      }
    }
    slots.sort((a, b) => a.order - b.order);
    return applyTail(
      slots.map((slot) => slot.entry),
      query.tail,
    );
  }

  /** Buffered bytes for one label, or for everything when no label is given. */
  byteSize(label?: string): number {
    if (label !== undefined) return this.buffers.get(label)?.bytes ?? 0;
    let total = 0;
    for (const buffer of this.buffers.values()) total += buffer.bytes;
    return total;
  }

  labels(): string[] {
    return [...this.buffers.keys()];
  }

  clear(): void {
    this.buffers.clear();
  }
}
