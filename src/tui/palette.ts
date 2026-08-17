/**
 * The command palette. Every daemon verb is reachable from here — see
 * `verbs.ts` for why that is enforced by the type checker rather than by
 * discipline — so this is the only place a keybinding is allowed to be a
 * shortcut for rather than the sole route to a capability.
 */

import type { ReactElement } from 'react';

import { box, text } from './elements.js';
import { fit } from './format.js';
import { isPickable, Picker, type PickerView } from './picker.js';
import { UI } from './theme.js';
import type { Verb } from './verbs.js';

export interface PaletteForm {
  verb: Verb;
  values: Record<string, string>;
  field: number;
}

export interface PaletteProps {
  query: string;
  verbs: readonly Verb[];
  index: number;
  form: PaletteForm | null;
  /** When set, the picker owns the pane; the form is one Esc away. */
  picker: PickerView | null;
  status: string | null;
  width: number;
  height: number;
  onPick: (index: number) => void;
  onFocusField: (index: number) => void;
  onPickerPick: (index: number) => void;
  onPickerScroll: (delta: number) => void;
}

function chrome(title: string, ...children: ReactElement[]): ReactElement {
  return box(
    {
      id: 'palette',
      title,
      style: {
        flexGrow: 1,
        flexDirection: 'column',
        border: true,
        borderColor: UI.borderFocus,
        backgroundColor: UI.panel,
      },
    },
    ...children,
  );
}

function list(props: PaletteProps): ReactElement {
  const rows = Math.max(1, props.height - 4);
  // Keep the cursor on screen without paging: the window follows the selection.
  const first = Math.max(
    0,
    Math.min(props.index - Math.floor(rows / 2), props.verbs.length - rows),
  );
  const shown = props.verbs.slice(Math.max(0, first), Math.max(0, first) + rows);

  const items = shown.map((verb, offset) => {
    const at = Math.max(0, first) + offset;
    const selected = at === props.index;
    return box(
      {
        key: verb.method,
        id: `palette-${verb.method}`,
        style: {
          height: 1,
          flexDirection: 'row',
          flexShrink: 0,
          backgroundColor: selected ? UI.selection : undefined,
        },
        onMouseDown: () => props.onPick(at),
      },
      text(
        { key: 'title', style: { fg: selected ? UI.text : UI.muted } },
        ` ${fit(verb.title, 28)}`,
      ),
      text({ key: 'cli', style: { fg: UI.accent } }, `  ${fit(verb.cli, 42)}`),
      text({ key: 'method', style: { fg: UI.muted } }, `  ${verb.method}`),
    );
  });

  if (items.length === 0) {
    items.push(text({ key: 'none', style: { fg: UI.muted } }, '  nothing matches'));
  }

  return chrome(
    'command palette',
    box(
      { key: 'query', style: { height: 1, flexShrink: 0, flexDirection: 'row' } },
      text({ key: 'prompt', style: { fg: UI.accent } }, ' : '),
      text({ key: 'text', style: { fg: UI.text } }, `${props.query}█`),
    ),
    ...items,
    text({ key: 'hint', style: { fg: UI.muted } }, ' ↑↓ or Ctrl+n/p move · Enter run · Esc close'),
  );
}

function form(props: PaletteProps, active: PaletteForm): ReactElement {
  const fields = active.verb.fields.map((field, index) => {
    const focused = index === active.field;
    const picked = isPickable(field.kind);
    return box(
      {
        key: field.name,
        id: `field-${field.name}`,
        style: {
          height: 1,
          flexDirection: 'row',
          flexShrink: 0,
          backgroundColor: focused ? UI.selection : undefined,
        },
        onMouseDown: () => props.onFocusField(index),
      },
      text(
        { key: 'label', style: { fg: focused ? UI.text : UI.muted } },
        ` ${field.label}${field.required === true ? '*' : ''} `.padEnd(18),
      ),
      // The caret marks a field that is answered from a list, not typed into.
      text({ key: 'caret', style: { fg: UI.accent } }, picked ? '▾ ' : '  '),
      text(
        { key: 'value', style: { fg: UI.text } },
        `${active.values[field.name] ?? ''}${focused && !picked ? '█' : ''}`,
      ),
      text(
        { key: 'placeholder', style: { fg: UI.muted } },
        (active.values[field.name] ?? '') === '' && field.placeholder !== undefined
          ? `  ${field.placeholder}`
          : '',
      ),
    );
  });

  if (fields.length === 0) {
    fields.push(text({ key: 'none', style: { fg: UI.muted } }, '  no arguments — Enter to run'));
  }

  return chrome(
    active.verb.title,
    text({ key: 'cli', style: { fg: UI.accent } }, ` ${active.verb.cli}`),
    text({ key: 'hint', style: { fg: UI.muted } }, ` ${active.verb.hint}`),
    text({ key: 'gap' }, ' '),
    ...fields,
    text(
      { key: 'keys', style: { fg: UI.muted } },
      ' Tab/↑↓ field · typing or Enter opens a ▾ list · Enter run · Esc back',
    ),
  );
}

export function Palette(props: PaletteProps): ReactElement {
  const panel =
    props.picker !== null
      ? Picker({
          ...props.picker,
          width: props.width,
          height: props.height,
          onPick: props.onPickerPick,
          onScroll: props.onPickerScroll,
        })
      : props.form === null
        ? list(props)
        : form(props, props.form);
  if (props.status === null) return panel;
  return box(
    { style: { flexGrow: 1, flexDirection: 'column' } },
    panel,
    box(
      { key: 'status', style: { height: 1, flexShrink: 0, backgroundColor: UI.panel } },
      text({ style: { fg: UI.accent } }, ` ${fit(props.status, Math.max(1, props.width - 2))}`),
    ),
  );
}
