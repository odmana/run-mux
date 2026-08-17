/**
 * The fuzzy picker: one overlay list, five kinds of thing to pick.
 *
 * It exists because creating a target used to mean typing absolute paths into a
 * form while four different identifier schemes — repos by path, checkouts by
 * path, playbooks by name, targets by slug — all looked alike in the same text
 * box. The picker shows a friendly **label** and submits the **value** the
 * daemon actually wants, so the two can differ without the user ever knowing.
 *
 * Everything above `Picker` is pure: `buildItems` turns cached daemon answers
 * into rows, `rankItems` orders and highlights them, and `test/tui.test.ts`
 * calls both directly.
 */

import { parseColor, StyledText, TextAttributes, type TextChunk } from '@opentui/core';
import type { ReactElement } from 'react';

import type { RepoView, TargetView } from '../protocol.js';
import { box, text } from './elements.js';
import { fit, padTo } from './format.js';
import { compareRanked, fuzzyMatch } from './fuzzy.js';
import { UI } from './theme.js';
import type { FieldKind, VerbField } from './verbs.js';

/** The field kinds answered from a list instead of typed. */
export type PickerKind = Extract<FieldKind, 'repo' | 'checkout' | 'playbook' | 'target' | 'label'>;

/** Every `PickerKind` has to appear here, so widening the union is a compile error. */
const PICKABLE: Record<PickerKind, true> = {
  repo: true,
  checkout: true,
  playbook: true,
  target: true,
  label: true,
};

export function isPickable(kind: FieldKind): kind is PickerKind {
  return Object.hasOwn(PICKABLE, kind);
}

export interface PickerItem {
  /** What the form submits: a path, a playbook name, a slug or a command label. */
  value: string;
  /** What the user reads and types against. */
  label: string;
  /** The path or extra context, so the label alone need not be unambiguous. */
  detail: string;
  /** A short flag beside the label — `main` on the primary worktree. */
  badge?: string;
}

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** A per-target cache entry: the slug it was fetched for travels with it. */
export interface ScopedLoadable<T> extends Loadable<T> {
  scope: string;
}

export interface CommandChoice {
  label: string;
  detail: string;
}

/**
 * Everything a picker can draw from. `repo.list` alone covers repos, checkouts
 * and playbooks; targets come from the list the sidebar already polls, so the
 * target picker costs no request at all.
 */
export interface PickerSource {
  repos: Loadable<RepoView[]>;
  targets: readonly TargetView[];
  commands: ScopedLoadable<CommandChoice[]>;
}

export interface PickerList {
  items: PickerItem[];
  /** Why the list is empty, when that is worth saying: loading, scope, error. */
  note: string | null;
}

const LOADING: PickerList = { items: [], note: 'loading…' };

function pending<T>(state: Loadable<T>): PickerList | null {
  if (state.error !== null) return { items: [], note: state.error };
  if (state.data === null) return { items: [], note: state.loading ? 'loading…' : null };
  return null;
}

function repoItems(repos: readonly RepoView[]): PickerItem[] {
  // `RepoView.name` is already the registered alias when there is one, so the
  // friendly name and the alias are the same string here.
  return repos.map((repo) => ({ value: repo.path, label: repo.name, detail: repo.path }));
}

function checkoutItems(repo: RepoView, targets: readonly TargetView[]): PickerItem[] {
  return repo.checkouts.map((checkout) => {
    // A checkout carries no slot of its own; a target already built on it does.
    const slot = targets.find((target) => target.checkoutPath === checkout.path)?.slot;
    return {
      value: checkout.path,
      label: checkout.branch,
      detail: slot === undefined ? checkout.path : `slot ${slot}  ${checkout.path}`,
      badge: checkout.isMain ? 'main' : undefined,
    };
  });
}

function scopedRepo(scope: string, source: PickerSource, what: string): RepoView | PickerList {
  if (scope === '') return { items: [], note: `choose a repo first — ${what} belong to one` };
  const waiting = pending(source.repos);
  if (waiting !== null) return waiting;
  const repo = (source.repos.data ?? []).find((candidate) => candidate.path === scope);
  if (repo === undefined) return { items: [], note: `${scope} is not a registered repo` };
  return repo;
}

/** Turns the cache into the rows for one picker, or says why it cannot. */
export function buildItems(kind: PickerKind, scope: string, source: PickerSource): PickerList {
  switch (kind) {
    case 'repo': {
      const waiting = pending(source.repos);
      if (waiting !== null) return waiting;
      const repos = source.repos.data ?? [];
      if (repos.length === 0) return { items: [], note: 'no repos registered — “Register repo”' };
      return { items: repoItems(repos), note: null };
    }
    case 'checkout': {
      const repo = scopedRepo(scope, source, 'checkouts');
      if (!('checkouts' in repo)) return repo;
      if (repo.checkouts.length === 0) return { items: [], note: `${repo.name} has no checkouts` };
      return { items: checkoutItems(repo, source.targets), note: null };
    }
    case 'playbook': {
      const repo = scopedRepo(scope, source, 'playbooks');
      if (!('checkouts' in repo)) return repo;
      if (repo.playbooks.length === 0) {
        return { items: [], note: `${repo.name} defines no playbooks` };
      }
      return {
        items: repo.playbooks.map((playbook) => ({
          value: playbook.name,
          label: playbook.name,
          detail: `(${playbook.source})`,
        })),
        note: null,
      };
    }
    case 'target': {
      if (source.targets.length === 0) return { items: [], note: 'no targets yet — “Add target”' };
      return {
        items: source.targets.map((target) => ({
          value: target.slug,
          label: target.alias ?? target.slug,
          detail: `${target.repoName}  ${target.branch}`,
          badge: target.available ? undefined : 'gone',
        })),
        note: null,
      };
    }
    case 'label': {
      if (scope === '')
        return { items: [], note: 'choose a target first — commands belong to one' };
      // The cache holds one target's commands; anything else is still on its way.
      if (source.commands.scope !== scope) return LOADING;
      const waiting = pending(source.commands);
      if (waiting !== null) return waiting;
      const commands = source.commands.data ?? [];
      if (commands.length === 0) return { items: [], note: `${scope} has no commands` };
      return {
        items: commands.map((command) => ({
          value: command.label,
          label: command.label,
          detail: command.detail,
        })),
        note: null,
      };
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Writes `value` into `name` and invalidates every field scoped to it.
 *
 * This is the cascade: choosing a repo re-checks the checkout and the playbook
 * against *that* repo and drops whichever no longer belongs, so a half-changed
 * form cannot submit a checkout from one repo with a playbook from another.
 * A field whose list is not cached cannot be proven valid, so it is cleared —
 * asking again costs a keystroke, submitting a mismatched pair costs a target.
 */
export function applyFieldValue(
  fields: readonly VerbField[],
  values: Readonly<Record<string, string>>,
  name: string,
  value: string,
  source: PickerSource,
): Record<string, string> {
  const next = { ...values, [name]: value };
  const changed = [name];
  const cleared = new Set<string>([name]);
  while (changed.length > 0) {
    const scope = changed.pop()!;
    for (const field of fields) {
      if (field.scopeField !== scope || cleared.has(field.name)) continue;
      const current = (next[field.name] ?? '').trim();
      if (current === '' || !isPickable(field.kind)) continue;
      const under = (next[scope] ?? '').trim();
      const valid =
        under !== '' &&
        buildItems(field.kind, under, source).items.some((item) => item.value === current);
      if (valid) continue;
      next[field.name] = '';
      cleared.add(field.name);
      changed.push(field.name);
    }
  }
  return next;
}

export interface PickerRow {
  item: PickerItem;
  /** Highlight positions within the label; empty when the detail matched instead. */
  labelMatch: number[];
  detailMatch: number[];
  score: number;
}

/** A label match always outranks a detail match, however good the detail's score. */
const LABEL_TIER = 1000;

export function rankItems(query: string, items: readonly PickerItem[]): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const item of items) {
    const onLabel = fuzzyMatch(query, item.label);
    if (onLabel !== null) {
      rows.push({
        item,
        labelMatch: onLabel.matchIndices,
        detailMatch: [],
        score: onLabel.score + LABEL_TIER,
      });
      continue;
    }
    const onDetail = fuzzyMatch(query, item.detail);
    if (onDetail !== null) {
      rows.push({
        item,
        labelMatch: [],
        detailMatch: onDetail.matchIndices,
        score: onDetail.score,
      });
    }
  }
  return rows.sort((a, b) =>
    compareRanked({ score: a.score, text: a.item.label }, { score: b.score, text: b.item.label }),
  );
}

/**
 * The first row to draw. The window follows the cursor rather than paging, so a
 * long list scrolls under a selection that never leaves the screen — the only
 * reason a 40-repo picker cannot push its own chrome off the bottom.
 */
export function windowStart(index: number, count: number, rows: number): number {
  if (count <= rows) return 0;
  return Math.max(0, Math.min(index - Math.floor(rows / 2), count - rows));
}

export interface PickerView {
  kind: PickerKind;
  /** The form field this picker fills. */
  field: string;
  title: string;
  query: string;
  rows: readonly PickerRow[];
  index: number;
  note: string | null;
}

export interface PickerProps extends PickerView {
  width: number;
  height: number;
  onPick: (index: number) => void;
  onScroll: (delta: number) => void;
}

function chunk(value: string, colour: string, bold = false): TextChunk {
  return {
    __isChunk: true,
    text: value,
    fg: parseColor(colour),
    attributes: bold ? TextAttributes.BOLD : undefined,
  };
}

/**
 * Splits `value` into runs of matched and unmatched characters. Indices past the
 * truncation point are dropped rather than shifted, so a highlight can never
 * land on the wrong character of an elided string.
 */
function highlighted(
  value: string,
  indices: readonly number[],
  base: string,
  accent: string,
): TextChunk[] {
  const marks = new Set(indices);
  const chunks: TextChunk[] = [];
  let run = '';
  let hot = false;
  for (let i = 0; i < value.length; i++) {
    const isHot = marks.has(i);
    if (isHot !== hot) {
      if (run !== '') chunks.push(chunk(run, hot ? accent : base, hot));
      run = '';
      hot = isHot;
    }
    run += value[i];
  }
  if (run !== '') chunks.push(chunk(run, hot ? accent : base, hot));
  return chunks.length === 0 ? [chunk(value, base)] : chunks;
}

const LABEL_WIDTH = 28;
const BADGE_WIDTH = 6;

function rowElement(props: PickerProps, row: PickerRow, at: number): ReactElement {
  const selected = at === props.index;
  // Padded rather than laid out to a fixed width: the label is styled per
  // character, and a short StyledText would let the detail column slide left.
  const label = padTo(fit(row.item.label, LABEL_WIDTH), LABEL_WIDTH);
  const badge = row.item.badge ?? '';
  const detailWidth = Math.max(8, props.width - LABEL_WIDTH - BADGE_WIDTH - 5);
  const detail = fit(row.item.detail, detailWidth);

  return box(
    {
      key: `${row.item.value}:${at}`,
      id: `pick-${row.item.value}`,
      style: {
        height: 1,
        flexDirection: 'row',
        flexShrink: 0,
        backgroundColor: selected ? UI.selection : undefined,
      },
      onMouseDown: () => props.onPick(at),
    },
    text({ key: 'gutter', style: { fg: UI.accent } }, selected ? ' ▸ ' : '   '),
    text({
      key: 'label',
      content: new StyledText(
        highlighted(label, row.labelMatch, selected ? UI.text : UI.muted, UI.accent),
      ),
      style: { flexShrink: 0 },
    }),
    text(
      { key: 'badge', style: { fg: UI.ok } },
      padTo(badge === '' ? '' : ` ${badge}`, BADGE_WIDTH),
    ),
    text({
      key: 'detail',
      content: new StyledText(highlighted(detail, row.detailMatch, UI.muted, UI.accent)),
      style: { flexShrink: 1 },
    }),
  );
}

export function Picker(props: PickerProps): ReactElement {
  const noteRows = props.note === null ? 0 : 1;
  const capacity = Math.max(1, props.height - 4 - noteRows);
  const first = windowStart(props.index, props.rows.length, capacity);
  const shown = props.rows.slice(first, first + capacity);

  const children: ReactElement[] = [
    box(
      { key: 'query', style: { height: 1, flexShrink: 0, flexDirection: 'row' } },
      text({ key: 'prompt', style: { fg: UI.accent } }, ' › '),
      text({ key: 'text', style: { fg: UI.text } }, `${props.query}█`),
    ),
  ];

  if (props.note !== null) {
    children.push(
      text(
        { key: 'note', style: { fg: UI.warn } },
        ` ${fit(props.note, Math.max(1, props.width - 2))}`,
      ),
    );
  }

  for (const [offset, row] of shown.entries()) {
    children.push(rowElement(props, row, first + offset));
  }

  if (shown.length === 0 && props.note === null) {
    children.push(text({ key: 'none', style: { fg: UI.muted } }, '   nothing matches'));
  }

  const more = props.rows.length > capacity ? `  ${props.index + 1}/${props.rows.length}` : '';
  children.push(
    text(
      { key: 'keys', style: { fg: UI.muted } },
      ` ↑↓ or Ctrl+n/p · Enter picks · Esc back to the form${more}`,
    ),
  );

  return box(
    {
      id: 'picker',
      title: props.title,
      style: {
        flexGrow: 1,
        flexDirection: 'column',
        border: true,
        borderColor: UI.borderFocus,
        backgroundColor: UI.panel,
        overflow: 'hidden',
      },
      onMouseScroll: (event) => {
        const scroll = event.scroll;
        if (scroll === undefined) return;
        if (scroll.direction === 'up') props.onScroll(-Math.max(1, scroll.delta));
        else if (scroll.direction === 'down') props.onScroll(Math.max(1, scroll.delta));
      },
    },
    ...children,
  );
}
