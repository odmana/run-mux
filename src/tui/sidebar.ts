/** The target list: repo headers, one row per target, scrollable and reorderable. */

import type { ScrollBoxRenderable } from '@opentui/core';
import type { TextProps } from '@opentui/react';
import type { ReactElement, Ref } from 'react';

import type { TargetView } from '../protocol.js';
import { box, scrollbox, text } from './elements.js';
import { elapsedSince, fit, padTo, shortName } from './format.js';
import { sortByOrder, type SidebarOrder } from './order.js';
import { TARGET_COLOUR, TARGET_DOT, UI } from './theme.js';

export const SIDEBAR_WIDTH = 32;
/** Below this the branch and elapsed columns collapse into nothing useful. */
export const SIDEBAR_MIN_WIDTH = 20;
/** The log pane is the point of the TUI; the sidebar never squeezes it past this. */
export const MAIN_MIN_WIDTH = 24;

export function clampSidebarWidth(width: number, terminalWidth: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, terminalWidth - MAIN_MIN_WIDTH);
  return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

const REPO_ID = 'repo-';
const TARGET_ID = 'target-';

export function targetElementId(slug: string): string {
  return `${TARGET_ID}${slug}`;
}

/**
 * What a drag picked up, and what it was dropped on.
 *
 * What was picked up is recorded at mouse-down rather than read off the drop
 * event's `source`. OpenTUI captures on the first *motion* report, which is
 * already a cell away from the press — enough to be the next row — so the
 * capture is not a reliable answer to "what is being dragged".
 */
export type DragHandle = { kind: 'repo'; key: string } | { kind: 'target'; key: string };

function sameHandle(a: DragHandle | null, b: DragHandle): boolean {
  return a !== null && a.kind === b.kind && a.key === b.key;
}

/**
 * Every glyph in the sidebar opts out of OpenTUI's text selection. A left press
 * on selectable text starts a selection, and the drag events then go to the
 * selection instead of the reorder handlers. Selection still works in the log
 * pane, which is the only place anyone wants to sweep text with the mouse.
 */
function label(props: TextProps, content: string): ReactElement {
  return text({ ...props, selectable: false }, content);
}

export interface RepoGroup {
  repoPath: string;
  repoName: string;
  targets: TargetView[];
}

/**
 * Repos and targets in the user's order where they have one, otherwise
 * first-seen and daemon order respectively.
 */
export function groupTargets(targets: readonly TargetView[], order?: SidebarOrder): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const target of targets) {
    let group = groups.get(target.repoPath);
    if (group === undefined) {
      group = { repoPath: target.repoPath, repoName: target.repoName, targets: [] };
      groups.set(target.repoPath, group);
    }
    group.targets.push(target);
  }
  if (order === undefined) return [...groups.values()];

  const ordered = sortByOrder([...groups.values()], (group) => group.repoPath, order.repos);
  for (const group of ordered) {
    const within = order.targets[group.repoPath];
    if (within !== undefined) {
      group.targets = sortByOrder(group.targets, (target) => target.slug, within);
    }
  }
  return ordered;
}

/** The rows a keyboard selection walks: collapsed groups hide their targets. */
export function visibleSlugs(
  groups: readonly RepoGroup[],
  collapsed: ReadonlySet<string>,
): string[] {
  const slugs: string[] = [];
  for (const group of groups) {
    if (collapsed.has(group.repoPath)) continue;
    for (const target of group.targets) slugs.push(target.slug);
  }
  return slugs;
}

/**
 * Something the sidebar can be clicked to do. Reported as a press and a release
 * rather than acted on at mouse-down, because every one of these hit areas is
 * also somewhere a drag can start, and a drag must not fold a group or stop a
 * target on its way past.
 */
export type SidebarClick =
  | { kind: 'fold'; key: string }
  | { kind: 'toggle'; key: string }
  | { kind: 'restart'; key: string };

export function sameClick(a: SidebarClick | null, b: SidebarClick): boolean {
  return a !== null && a.kind === b.kind && a.key === b.key;
}

export interface SidebarProps {
  groups: readonly RepoGroup[];
  selected: string | null;
  hovered: string | null;
  collapsed: ReadonlySet<string>;
  now: number;
  width?: number;
  /** The right border doubles as the resize grip, and says so by lighting up. */
  edgeLit: boolean;
  dragging: DragHandle | null;
  boxRef?: Ref<ScrollBoxRenderable>;
  onSelect: (slug: string, x: number, y: number) => void;
  onContext: (slug: string) => void;
  onPress: (click: SidebarClick) => void;
  onRelease: (click: SidebarClick) => void;
  onHover: (slug: string | null) => void;
  onEdge: (overEdge: boolean) => void;
  onResizeStart: () => void;
  /** Pressed, and therefore what a drag from here would carry. */
  onGrab: (handle: DragHandle) => void;
  onDrop: (onto: DragHandle) => void;
}

interface Columns {
  name: number;
  branch: number;
  elapsed: number;
}

/**
 * Two lines per target: `dot + name`, then an indented `branch + elapsed`.
 * A single line forced the name through a 12-column gap, which truncated every
 * real slug to something like `main:demo-st…`.
 */
export const ROW_HEIGHT = 2;

function columns(width: number): Columns {
  const inner = Math.max(10, width - 2);
  const name = Math.max(6, inner - 3);
  // 7 so the widest `formatElapsed` tier, `59m 59s`, is not clipped to `59m 5…`.
  const elapsed = 7;
  const branch = Math.max(4, inner - 3 - elapsed);
  return { name, branch, elapsed };
}

function header(props: SidebarProps, group: RepoGroup, width: number): ReactElement {
  const collapsed = props.collapsed.has(group.repoPath);
  const self: DragHandle = { kind: 'repo', key: group.repoPath };
  const fold: SidebarClick = { kind: 'fold', key: group.repoPath };
  const dragged = sameHandle(props.dragging, self);

  return box(
    {
      key: `repo-${group.repoPath}`,
      id: `${REPO_ID}${group.repoPath}`,
      style: {
        height: 1,
        flexDirection: 'row',
        flexShrink: 0,
        backgroundColor: dragged ? UI.drag : undefined,
      },
      onMouseDown: () => {
        props.onPress(fold);
        props.onGrab(self);
      },
      onMouseUp: () => props.onRelease(fold),
      onMouseDrop: () => props.onDrop(self),
    },
    label(
      { style: { fg: dragged ? UI.accent : UI.muted } },
      `${collapsed ? '▸' : '▾'} ${fit(group.repoName.toUpperCase(), Math.max(4, width - 5))}`,
    ),
  );
}

function row(props: SidebarProps, target: TargetView, cols: Columns): ReactElement {
  const selected = target.slug === props.selected;
  const hovered = target.slug === props.hovered;
  const running =
    target.status === 'running' || target.status === 'starting' || target.status === 'degraded';

  const self: DragHandle = { kind: 'target', key: target.slug };
  const toggle: SidebarClick = { kind: 'toggle', key: target.slug };
  const restart: SidebarClick = { kind: 'restart', key: target.slug };
  const dragged = sameHandle(props.dragging, self);
  // The pointer is over this row while something else is being dragged, so this
  // is where it would land.
  const landing = props.dragging !== null && hovered && !dragged;

  const background = dragged
    ? UI.drag
    : landing
      ? UI.selection
      : selected
        ? UI.selection
        : hovered
          ? UI.hover
          : undefined;

  const nameLine = box(
    { key: 'line1', style: { height: 1, flexDirection: 'row', flexShrink: 0 } },
    label(
      {
        key: 'dot',
        style: { fg: TARGET_COLOUR[target.status] },
        // Left to bubble: the row below arms the drag and moves the selection,
        // and a right-click is the row's context menu, not a start/stop.
        onMouseDown: (event) => {
          if (event.button !== 2) props.onPress(toggle);
        },
        onMouseUp: () => props.onRelease(toggle),
      },
      ` ${TARGET_DOT[target.status]} `,
    ),
    label(
      { key: 'name', style: { fg: UI.text, flexShrink: 1 } },
      padTo(fit(shortName(target.slug, target.alias), cols.name), cols.name),
    ),
  );

  const detail: ReactElement[] = [
    label(
      { key: 'indent', style: { fg: landing ? UI.accent : UI.muted } },
      landing ? ' ▸ ' : '   ',
    ),
  ];

  // Per-row controls appear under the pointer, taking the branch column's space
  // on the detail line rather than eating into the name above. Not mid-drag:
  // the pointer is carrying a row, not reaching for a button.
  if (hovered && props.dragging === null) {
    detail.push(
      label(
        {
          key: 'run',
          style: { fg: running ? UI.danger : UI.ok },
          onMouseDown: (event) => {
            if (event.button !== 2) props.onPress(toggle);
          },
          onMouseUp: () => props.onRelease(toggle),
        },
        running ? '■' : '▶',
      ),
      label(
        {
          key: 'restart',
          style: { fg: UI.accent },
          onMouseDown: (event) => {
            if (event.button !== 2) props.onPress(restart);
          },
          onMouseUp: () => props.onRelease(restart),
        },
        ' ↻',
      ),
      label({ key: 'pad', style: { fg: UI.muted } }, ' '.repeat(Math.max(0, cols.branch - 3))),
    );
  } else {
    detail.push(
      label(
        { key: 'branch', style: { fg: UI.muted } },
        padTo(fit(target.branch, cols.branch), cols.branch),
      ),
    );
  }

  detail.push(
    label(
      { key: 'elapsed', style: { fg: UI.muted } },
      // Right-aligned: the tiers differ in width, and a ragged left edge reads
      // better than a run time that appears to drift as it ticks over.
      fit(elapsedSince(target.startedAt, props.now), cols.elapsed).padStart(cols.elapsed),
    ),
  );

  const detailLine = box(
    { key: 'line2', style: { height: 1, flexDirection: 'row', flexShrink: 0 } },
    ...detail,
  );

  return box(
    {
      key: target.slug,
      id: targetElementId(target.slug),
      style: {
        height: ROW_HEIGHT,
        flexDirection: 'column',
        flexShrink: 0,
        backgroundColor: background,
      },
      onMouseDown: (event) => {
        if (event.button === 2) {
          props.onContext(target.slug);
          return;
        }
        props.onSelect(target.slug, event.x, event.y);
        props.onGrab(self);
      },
      onMouseOver: () => props.onHover(target.slug),
      onMouseOut: () => props.onHover(null),
      onMouseDrop: () => props.onDrop(self),
    },
    nameLine,
    detailLine,
  );
}

export function Sidebar(props: SidebarProps): ReactElement {
  const width = props.width ?? SIDEBAR_WIDTH;
  const cols = columns(width);
  const children: ReactElement[] = [];

  for (const group of props.groups) {
    children.push(header(props, group, width));
    if (props.collapsed.has(group.repoPath)) continue;
    for (const target of group.targets) children.push(row(props, target, cols));
  }

  if (children.length === 0) {
    children.push(
      label({ key: 'empty', style: { fg: UI.muted } }, ' no targets — `:` then "Add target"'),
    );
  }

  // The sidebar sits at column 0, so its right border is the last column it owns.
  // Nothing is drawn there, which is what lets the box itself answer the press.
  const edge = width - 1;

  return scrollbox(
    {
      id: 'sidebar',
      title: 'targets',
      ref: props.boxRef,
      scrollY: true,
      stickyScroll: false,
      viewportCulling: true,
      contentOptions: { flexDirection: 'column' },
      style: {
        width,
        flexShrink: 0,
        border: true,
        borderColor: props.edgeLit ? UI.accent : UI.border,
      },
      onMouseDown: (event) => {
        if (event.x >= edge) props.onResizeStart();
      },
      onMouseMove: (event) => props.onEdge(event.x >= edge),
      onMouseOut: () => props.onEdge(false),
    },
    ...children,
  );
}
