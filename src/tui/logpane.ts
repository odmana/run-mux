/** The main pane: target header, filter chips, the log stream, key hints. */

import { parseColor, StyledText, type TextChunk } from '@opentui/core';
import type { ReactElement } from 'react';

import type { TargetView } from '../protocol.js';
import type { CommandState } from '../types.js';
import { ansiToChunks } from './ansi.js';
import { box, text } from './elements.js';
import { elapsedSince, fit } from './format.js';
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

export function Header({ target, now }: { target: TargetView | null; now: number }): ReactElement {
  if (target === null) {
    return box(
      { id: 'header', style: { height: 1, flexShrink: 0, backgroundColor: UI.panel } },
      text({ style: { fg: UI.muted } }, ' run-mux — no target selected '),
    );
  }
  const stale = target.staleDefinition === true ? '  ⚠ stale definition' : '';
  return box(
    {
      id: 'header',
      style: { height: 1, flexShrink: 0, flexDirection: 'row', backgroundColor: UI.panel },
    },
    text({ key: 'slug', style: { fg: UI.text } }, ` ${target.slug} `),
    text({ key: 'branch', style: { fg: UI.muted } }, ` ${target.branch}  slot ${target.slot}  `),
    text({ key: 'dot', style: { fg: TARGET_COLOUR[target.status] } }, TARGET_DOT[target.status]),
    text({ key: 'status', style: { fg: TARGET_COLOUR[target.status] } }, ` ${target.status}`),
    text(
      { key: 'elapsed', style: { fg: UI.muted } },
      `  ${elapsedSince(target.startedAt, now)}${stale}`,
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

export interface LogPaneProps {
  lines: readonly LogLine[];
  labels: readonly string[];
  width: number;
  empty: string;
  onScroll: (direction: 'up' | 'down', delta: number) => void;
  onLine: (line: LogLine, x: number, y: number) => void;
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

  return box(
    {
      id: 'log-pane',
      style: {
        flexGrow: 1,
        flexDirection: 'column',
        border: true,
        borderColor: UI.border,
        overflow: 'hidden',
      },
      onMouseScroll: (event) => {
        const scroll = event.scroll;
        if (scroll === undefined) return;
        if (scroll.direction === 'up' || scroll.direction === 'down') {
          props.onScroll(scroll.direction, scroll.delta);
        }
      },
    },
    ...rows,
  );
}

export function Footer({ hint, width }: { hint: string; width: number }): ReactElement {
  return box(
    { id: 'footer', style: { height: 1, flexShrink: 0, backgroundColor: UI.panel } },
    text({ style: { fg: UI.muted } }, fit(hint, Math.max(1, width))),
  );
}
