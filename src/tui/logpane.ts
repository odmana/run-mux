/** The main pane: target header, filter chips, the log stream, key hints. */

import { parseColor, StyledText, type BoxRenderable, type TextChunk } from '@opentui/core';
import type { ReactElement, Ref } from 'react';

import type { TargetView } from '../protocol.js';
import type { CommandState } from '../types.js';
import { ansiToChunks } from './ansi.js';
import { box, text } from './elements.js';
import { elapsedSince, elideStart, fit } from './format.js';
import type { LogLine } from './log-buffer.js';
import {
  COMMAND_COLOUR,
  COMMAND_MARK,
  labelColour,
  TARGET_COLOUR,
  TARGET_DOT,
  UI,
} from './theme.js';

export const ALL_CHIP = 'all';

/** Identity line, then the checkout path. */
export const HEADER_HEIGHT = 2;

/** Everything the log pane is not: the header, the chips, the log box's own border rows, the footer. */
export const CHROME_HEIGHT = HEADER_HEIGHT + 1 + 2 + 1;

export interface HeaderProps {
  target: TargetView | null;
  now: number;
  width: number;
}

export function Header({ target, now, width }: HeaderProps): ReactElement {
  const identity =
    target === null
      ? text({ key: 'line1', style: { height: 1, fg: UI.muted } }, ' run-mux — no target selected ')
      : box(
          { key: 'line1', style: { height: 1, flexShrink: 0, flexDirection: 'row' } },
          text({ key: 'slug', style: { fg: UI.text } }, ` ${target.slug} `),
          text(
            { key: 'branch', style: { fg: UI.muted } },
            ` ${target.branch}  slot ${target.slot}  `,
          ),
          text(
            { key: 'dot', style: { fg: TARGET_COLOUR[target.status] } },
            TARGET_DOT[target.status],
          ),
          text({ key: 'status', style: { fg: TARGET_COLOUR[target.status] } }, ` ${target.status}`),
          text(
            { key: 'elapsed', style: { fg: UI.muted } },
            `  ${elapsedSince(target.startedAt, now)}${target.staleDefinition === true ? '  ⚠ stale definition' : ''}`,
          ),
        );

  return box(
    {
      id: 'header',
      style: {
        height: HEADER_HEIGHT,
        flexShrink: 0,
        flexDirection: 'column',
        backgroundColor: UI.panel,
      },
    },
    identity,
    text(
      { key: 'path', id: 'header-path', style: { height: 1, fg: UI.muted } },
      target === null ? '' : ` ${elideStart(target.checkoutPath, Math.max(1, width - 2))}`,
    ),
  );
}

export interface ChipsProps {
  labels: readonly string[];
  commands: readonly CommandState[];
  active: ReadonlySet<string> | null;
  onSolo: (label: string) => void;
  onAll: () => void;
}

export function Chips(props: ChipsProps): ReactElement {
  const all = props.active === null;
  const chips: ReactElement[] = props.labels.map((label, index) => {
    const state = props.commands.find((command) => command.label === label);
    const selected = !all && props.active?.has(label) === true;
    return box(
      {
        key: label,
        id: `chip-${label}`,
        style: {
          height: 1,
          marginRight: 1,
          flexShrink: 0,
          flexDirection: 'row',
          backgroundColor: selected ? UI.chipActive : UI.chip,
        },
        onMouseDown: () => props.onSolo(label),
      },
      text({ key: 'mark', style: { fg: labelColour(props.labels, label) } }, ' ●'),
      text({ key: 'name', style: { fg: selected ? UI.text : UI.muted } }, ` ${index + 1} ${label}`),
      text(
        { key: 'state', style: { fg: state ? COMMAND_COLOUR[state.status] : UI.muted } },
        `${state ? ` ${COMMAND_MARK[state.status]}` : ''} `,
      ),
    );
  });

  chips.push(
    box(
      {
        key: ALL_CHIP,
        id: `chip-${ALL_CHIP}`,
        style: {
          height: 1,
          marginRight: 1,
          flexShrink: 0,
          backgroundColor: all ? UI.chipActive : UI.chip,
        },
        onMouseDown: () => props.onAll(),
      },
      text({ style: { fg: all ? UI.text : UI.muted } }, ' a all '),
    ),
  );

  return box({ id: 'chips', style: { height: 1, flexShrink: 0, flexDirection: 'row' } }, ...chips);
}

function styled(line: LogLine, labels: readonly string[], width: number): StyledText {
  const prefix = `[${line.label}] `;
  const chunks: TextChunk[] = [
    { __isChunk: true, text: prefix, fg: parseColor(labelColour(labels, line.label)) },
  ];
  // A runaway line (a minified bundle, a base64 blob) would cost more to chunk
  // and lay out than it could ever show, so cap it well past the visible width.
  const room = Math.max(1, width - prefix.length) * 4;
  const body = line.text.length > room ? line.text.slice(0, room) : line.text;
  for (const chunk of ansiToChunks(body, line.stream === 'stderr' ? UI.danger : undefined)) {
    chunks.push(chunk);
  }
  return new StyledText(chunks);
}

/**
 * Where the thumb sits, in rows from the top of the gutter. The pane never holds
 * more than `rows` lines, so the scrollbar is drawn against the buffer's count
 * rather than against anything the renderer could measure for itself.
 */
export function thumb(rows: number, total: number, back: number): { top: number; size: number } {
  if (rows <= 0) return { top: 0, size: 0 };
  if (total <= rows) return { top: 0, size: rows };
  const size = Math.max(1, Math.round((rows * rows) / total));
  const first = Math.max(0, total - Math.max(0, back) - rows);
  return { top: Math.round((first / (total - rows)) * (rows - size)), size };
}

/** The scrollBack a press on gutter row `row` asks for — the inverse of `thumb`. */
export function jumpTo(rows: number, total: number, row: number): number {
  if (rows <= 1 || total <= rows) return 0;
  const fraction = Math.min(1, Math.max(0, row / (rows - 1)));
  return total - rows - Math.round(fraction * (total - rows));
}

export interface LogPaneProps {
  lines: readonly LogLine[];
  labels: readonly string[];
  width: number;
  /** The rows the pane can draw, which is the gutter's height too. */
  height: number;
  matching: number;
  scrollBack: number;
  empty: string;
  onScroll: (direction: 'up' | 'down', delta: number) => void;
  onLine: (line: LogLine, x: number, y: number) => void;
  /** The absolute row a press or drag landed on; the caller owns the geometry. */
  onGutter: (y: number) => void;
  gutterRef?: Ref<BoxRenderable>;
}

/**
 * The scrollbar. Its glyphs opt out of selection for the sidebar's reason: a
 * press on selectable text starts a text selection, and the drag events would
 * then never reach the handler that moves the view.
 */
function Gutter(props: LogPaneProps): ReactElement {
  const { top, size } = thumb(props.height, props.matching, props.scrollBack);
  const cells: ReactElement[] = [];
  for (let row = 0; row < props.height; row++) {
    const held = row >= top && row < top + size;
    cells.push(
      text(
        {
          key: row,
          selectable: false,
          style: { height: 1, flexShrink: 0, fg: held ? UI.muted : UI.border },
        },
        held ? '█' : '░',
      ),
    );
  }

  return box(
    {
      id: 'log-scroll',
      ref: props.gutterRef,
      style: { width: 1, flexShrink: 0, flexDirection: 'column' },
      onMouseDown: (event) => props.onGutter(event.y),
      onMouseDrag: (event) => props.onGutter(event.y),
    },
    ...cells,
  );
}

export function LogPane(props: LogPaneProps): ReactElement {
  const rows: ReactElement[] = props.lines.map((line) =>
    text({
      key: line.seq,
      id: `log-${line.seq}`,
      content: styled(line, props.labels, props.width),
      style: { height: 1, flexShrink: 0 },
      onMouseDown: (event) => props.onLine(line, event.x, event.y),
    }),
  );

  if (rows.length === 0) {
    rows.push(text({ key: 'empty', style: { fg: UI.muted } }, props.empty));
  }

  // Deliberately unclipped: a clipped box loses the hit cell of its last row, so
  // `overflow` lives on the main column instead — see `app.ts`.
  return box(
    {
      id: 'log-pane',
      style: {
        flexGrow: 1,
        flexDirection: 'row',
        border: true,
        borderColor: UI.border,
      },
      onMouseScroll: (event) => {
        const scroll = event.scroll;
        if (scroll === undefined) return;
        if (scroll.direction === 'up' || scroll.direction === 'down') {
          props.onScroll(scroll.direction, scroll.delta);
        }
      },
    },
    box({ key: 'rows', id: 'log-rows', style: { flexGrow: 1, flexDirection: 'column' } }, ...rows),
    Gutter(props),
  );
}

export function Footer({ hint, width }: { hint: string; width: number }): ReactElement {
  return box(
    { id: 'footer', style: { height: 1, flexShrink: 0, backgroundColor: UI.panel } },
    text({ style: { fg: UI.muted } }, fit(hint, Math.max(1, width))),
  );
}
