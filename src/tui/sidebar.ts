/** The 32-column target list: repo headers, one row per target. */

import type { ReactElement } from 'react';

import type { TargetView } from '../protocol.js';
import { box, text } from './elements.js';
import { elapsedSince, fit, padTo, shortName } from './format.js';
import { TARGET_COLOUR, TARGET_DOT, UI } from './theme.js';

export const SIDEBAR_WIDTH = 32;

export interface RepoGroup {
  repoPath: string;
  repoName: string;
  targets: TargetView[];
}

/** Repos in first-seen order, targets in the order the daemon reported them. */
export function groupTargets(targets: readonly TargetView[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const target of targets) {
    let group = groups.get(target.repoPath);
    if (group === undefined) {
      group = { repoPath: target.repoPath, repoName: target.repoName, targets: [] };
      groups.set(target.repoPath, group);
    }
    group.targets.push(target);
  }
  return [...groups.values()];
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

export type RowAction = 'toggle' | 'restart';

export interface SidebarProps {
  groups: readonly RepoGroup[];
  selected: string | null;
  hovered: string | null;
  collapsed: ReadonlySet<string>;
  now: number;
  width?: number;
  onSelect: (slug: string, x: number, y: number) => void;
  onContext: (slug: string) => void;
  onAction: (slug: string, action: RowAction) => void;
  onToggleGroup: (repoPath: string) => void;
  onHover: (slug: string | null) => void;
}

interface Columns {
  name: number;
  branch: number;
  slot: number;
  elapsed: number;
}

/**
 * Two lines per target: `dot + name`, then an indented `branch + slot + elapsed`.
 * A single line forced the name through a 12-column gap, which truncated every
 * real slug to something like `main:demo-st…`.
 */
export const ROW_HEIGHT = 2;

function columns(width: number): Columns {
  const inner = Math.max(10, width - 2);
  const name = Math.max(6, inner - 3);
  const elapsed = 6;
  const slot = 7;
  const branch = Math.max(4, inner - 3 - slot - elapsed);
  return { name, branch, slot, elapsed };
}

function header(group: RepoGroup, collapsed: boolean, width: number, onToggle: () => void) {
  return box(
    {
      key: `repo-${group.repoPath}`,
      id: `repo-${group.repoPath}`,
      style: { height: 1, flexDirection: 'row', flexShrink: 0 },
      onMouseDown: onToggle,
    },
    text(
      { style: { fg: UI.muted } },
      `${collapsed ? '▸' : '▾'} ${fit(group.repoName.toUpperCase(), Math.max(4, width - 5))}`,
    ),
  );
}

function row(props: SidebarProps, target: TargetView, cols: Columns): ReactElement {
  const selected = target.slug === props.selected;
  const hovered = target.slug === props.hovered;
  const running =
    target.status === 'running' || target.status === 'starting' || target.status === 'degraded';

  const background = selected ? UI.selection : hovered ? UI.hover : undefined;

  const nameLine = box(
    { key: 'line1', style: { height: 1, flexDirection: 'row', flexShrink: 0 } },
    text(
      {
        key: 'dot',
        style: { fg: TARGET_COLOUR[target.status] },
        onMouseDown: (event) => {
          event.stopPropagation();
          props.onSelect(target.slug, event.x, event.y);
          props.onAction(target.slug, 'toggle');
        },
      },
      ` ${TARGET_DOT[target.status]} `,
    ),
    text(
      { key: 'name', style: { fg: UI.text, flexShrink: 1 } },
      padTo(fit(shortName(target.slug, target.alias), cols.name), cols.name),
    ),
  );

  const detail: ReactElement[] = [text({ key: 'indent', style: { fg: UI.muted } }, '   ')];

  if (hovered) {
    // Per-row controls appear under the pointer, taking the branch column's
    // space on the detail line rather than eating into the name above.
    detail.push(
      text(
        {
          key: 'run',
          style: { fg: running ? UI.danger : UI.ok },
          onMouseDown: (event) => {
            event.stopPropagation();
            props.onAction(target.slug, 'toggle');
          },
        },
        running ? '■' : '▶',
      ),
      text(
        {
          key: 'restart',
          style: { fg: UI.accent },
          onMouseDown: (event) => {
            event.stopPropagation();
            props.onAction(target.slug, 'restart');
          },
        },
        ' ↻',
      ),
      text({ key: 'pad', style: { fg: UI.muted } }, ' '.repeat(Math.max(0, cols.branch - 3))),
    );
  } else {
    detail.push(
      text(
        { key: 'branch', style: { fg: UI.muted } },
        padTo(fit(target.branch, cols.branch), cols.branch),
      ),
    );
  }

  detail.push(
    text({ key: 'slot', style: { fg: UI.muted } }, padTo(`slot ${target.slot}`, cols.slot)),
    text(
      { key: 'elapsed', style: { fg: UI.muted } },
      padTo(fit(elapsedSince(target.startedAt, props.now), cols.elapsed), cols.elapsed),
    ),
  );

  const detailLine = box(
    { key: 'line2', style: { height: 1, flexDirection: 'row', flexShrink: 0 } },
    ...detail,
  );

  return box(
    {
      key: target.slug,
      id: `target-${target.slug}`,
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
      },
      onMouseOver: () => props.onHover(target.slug),
      onMouseOut: () => props.onHover(null),
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
    const collapsed = props.collapsed.has(group.repoPath);
    children.push(header(group, collapsed, width, () => props.onToggleGroup(group.repoPath)));
    if (collapsed) continue;
    for (const target of group.targets) children.push(row(props, target, cols));
  }

  if (children.length === 0) {
    children.push(
      text({ key: 'empty', style: { fg: UI.muted } }, ' no targets — `:` then "Add target"'),
    );
  }

  return box(
    {
      id: 'sidebar',
      title: 'targets',
      style: {
        width,
        flexShrink: 0,
        flexDirection: 'column',
        border: true,
        borderColor: UI.border,
      },
    },
    ...children,
  );
}
