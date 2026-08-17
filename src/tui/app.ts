/**
 * The root component: two panes, one modal-ish key map, and a command palette
 * that is the complete verb surface.
 *
 * There is no focus juggling. `j/k` always moves the sidebar selection and the
 * log pane scrolls with `Ctrl+u/d` and `g/G`, because in a two-pane layout a
 * Tab-focus model costs a keystroke on every interaction and buys nothing.
 */

import type { KeyEvent } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { METHODS, type TargetView } from '../protocol.js';
import { stripAnsi } from './ansi.js';
import { copyToClipboard } from './clipboard.js';
import {
  useLogStream,
  usePickerCache,
  useRunStatus,
  useTargets,
  useUiState,
  type DaemonLink,
} from './data.js';
import { box } from './elements.js';
import { fit } from './format.js';
import type { LogFilter, LogLine } from './log-buffer.js';
import {
  ALL_CHIP,
  Chips,
  CHROME_HEIGHT,
  Footer,
  Header,
  HEADER_HEIGHT,
  LogPane,
} from './logpane.js';
import { Palette, type PaletteForm } from './palette.js';
import {
  applyFieldValue,
  buildItems,
  isPickable,
  rankItems,
  type PickerKind,
  type PickerSource,
  type PickerView,
} from './picker.js';
import {
  clampSidebarWidth,
  groupTargets,
  Sidebar,
  SIDEBAR_WIDTH,
  visibleSlugs,
  type RowAction,
} from './sidebar.js';
import { UI } from './theme.js';
import { buildParams, filterVerbs, missingFields, type Verb } from './verbs.js';

export type Mode = 'browse' | 'palette' | 'form' | 'picker' | 'search' | 'command';

/** The picker's own state. Its rows are derived, never stored — see `pickerView`. */
interface PickerState {
  kind: PickerKind;
  /** The form field being filled. */
  field: string;
  query: string;
  index: number;
}

/** What the picker tests read: the ranked rows and where each query character landed. */
export interface PickerSnapshot {
  kind: string;
  field: string;
  query: string;
  index: number;
  note: string | null;
  rows: {
    value: string;
    label: string;
    detail: string;
    match: number[];
    detailMatch: number[];
  }[];
}

/** What `test/tui.test.ts` reads. Production passes no probe. */
export interface AppSnapshot {
  mode: Mode;
  selected: string | null;
  slugs: string[];
  /** `kind:id@x,y` in element-local coordinates — the Ink offset bug's fingerprint. */
  lastHit: string | null;
  filterLabels: string[] | null;
  search: string | null;
  labels: string[];
  visibleLines: number;
  bufferLines: number;
  totalLines: number;
  scrollBack: number;
  collapsed: string[];
  paletteMethods: string[];
  paletteIndex: number;
  sidebarWidth: number;
  formMethod: string | null;
  formValues: Record<string, string>;
  picker: PickerSnapshot | null;
  status: string | null;
  copied: string | null;
  exited: boolean;
}

export interface AppProbe {
  report: (snapshot: AppSnapshot) => void;
}

export interface AppProps {
  link: DaemonLink | null;
  onExit: () => void;
  probe?: AppProbe;
  /** Overridden in tests so a key press does not reach the real clipboard. */
  copy?: (text: string) => void | Promise<void>;
  targetPollMs?: number;
  statusPollMs?: number;
  coalesceMs?: number;
  retain?: number;
  uiWriteMs?: number;
}

const FOOTER =
  's start/stop · r restart · R restart cmd · 1-9 solo · a all · / search · y copy · Enter fold · : palette · q quits the TUI only (the daemon keeps running) · Shift+drag selects natively';

function isPrintable(key: KeyEvent): boolean {
  return (
    !key.ctrl &&
    !key.meta &&
    key.sequence.length === 1 &&
    key.sequence >= ' ' &&
    key.sequence <= '~'
  );
}

function activeStatus(target: TargetView | undefined): boolean {
  return (
    target !== undefined &&
    (target.status === 'running' || target.status === 'starting' || target.status === 'degraded')
  );
}

/**
 * Focus lands on the next field still waiting for an answer, so `Add target` is
 * pick, pick, pick, Enter rather than a Tab between every one.
 */
function nextField(verb: Verb, values: Record<string, string>, from: number): number {
  for (let index = from + 1; index < verb.fields.length; index++) {
    const field = verb.fields[index]!;
    if ((values[field.name] ?? '').trim() === '') return index;
  }
  return from;
}

export function App(props: AppProps): ReactElement {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();

  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<Mode>('browse');
  const [filterLabels, setFilterLabels] = useState<ReadonlySet<string> | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [form, setForm] = useState<PaletteForm | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [lastHit, setLastHit] = useState<{ id: string; seq: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [storedWidth, setStoredWidth] = useState(SIDEBAR_WIDTH);
  const [edgeLit, setEdgeLit] = useState(false);
  const hitSeq = useRef(0);
  // The width as of the last drag event, not the last commit: `drag-end` has to
  // persist what the pointer actually landed on, and React may not have rendered it yet.
  const widthRef = useRef(SIDEBAR_WIDTH);
  const resizing = useRef(false);

  const ui = useUiState(props.link, props.uiWriteMs);

  const applyWidth = useCallback((next: number) => {
    widthRef.current = next;
    setStoredWidth(next);
  }, []);

  // One-shot: the daemon's copy seeds the session, and every change after this
  // is the user's, so a second pass would fight whatever they just did.
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !ui.loaded) return;
    hydrated.current = true;
    if (ui.ui.sidebarWidth !== undefined) applyWidth(ui.ui.sidebarWidth);
    if (ui.ui.collapsedRepos !== undefined) setCollapsed(new Set(ui.ui.collapsedRepos));
  }, [applyWidth, ui.loaded, ui.ui]);

  const { targets, refresh } = useTargets(props.link, props.targetPollMs);
  const groups = useMemo(() => groupTargets(targets), [targets]);
  const slugs = useMemo(() => visibleSlugs(groups, collapsed), [groups, collapsed]);

  // The daemon owns the target list, so a selection is only ever a slug that is
  // still in it; anything else would leave the pane pointed at nothing.
  useEffect(() => {
    if (slugs.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (selected === null || !slugs.includes(selected)) setSelected(slugs[0]!);
  }, [slugs, selected]);

  const live = useRunStatus(props.link, selected, props.statusPollMs);
  const current = live ?? targets.find((target) => target.slug === selected) ?? null;

  const cache = usePickerCache(props.link, targets);
  // Destructured because the hook hands back a fresh object each render while
  // these two are stable; the callbacks below depend on them.
  const { load: loadPickerData, reset: resetPickerData } = cache;
  const source = useMemo<PickerSource>(
    () => ({ repos: cache.repos, targets, commands: cache.commands }),
    [cache.repos, cache.commands, targets],
  );
  // Read inside callbacks that must not re-create themselves on every poll.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const pickerView = useMemo<PickerView | null>(() => {
    if (picker === null || form === null) return null;
    const field = form.verb.fields.find((candidate) => candidate.name === picker.field);
    if (field === undefined) return null;
    const scope =
      field.scopeField === undefined ? '' : (form.values[field.scopeField] ?? '').trim();
    const list = buildItems(picker.kind, scope, source);
    const rows = rankItems(picker.query, list.items);
    return {
      kind: picker.kind,
      field: picker.field,
      title: `${form.verb.title} · ${field.label}`,
      query: picker.query,
      rows,
      // Rows can shrink under the cursor as a query narrows or data arrives.
      index: Math.min(picker.index, Math.max(0, rows.length - 1)),
      note: list.note,
    };
  }, [picker, form, source]);

  // Clamped on the way out rather than on the way in, so a width that only fits
  // a wide terminal survives a spell in a narrow one.
  const sidebarWidth = clampSidebarWidth(storedWidth, dimensions.width);
  const mainWidth = Math.max(10, dimensions.width - sidebarWidth);
  const logHeight = Math.max(1, dimensions.height - CHROME_HEIGHT);

  const filter = useMemo<LogFilter>(
    () => ({ labels: filterLabels, search }),
    [filterLabels, search],
  );

  const logs = useLogStream({
    link: props.link,
    slug: selected,
    height: logHeight,
    filter,
    coalesceMs: props.coalesceMs,
    retain: props.retain,
  });

  const labels = useMemo(() => {
    const fromCommands = current?.commands?.map((command) => command.label) ?? [];
    if (fromCommands.length > 0) return fromCommands;
    return logs.labels;
  }, [current, logs.labels]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const hit = useCallback((id: string) => {
    hitSeq.current += 1;
    setLastHit({ id, seq: hitSeq.current });
  }, []);

  const call = useCallback(
    async (method: string, params: unknown, note: string) => {
      if (props.link === null) return;
      setStatus(`${note}…`);
      try {
        await props.link.request(method, params);
        setStatus(note);
        await refresh();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [props.link, refresh],
  );

  const toggleTarget = useCallback(
    (slug: string) => {
      const target = targets.find((candidate) => candidate.slug === slug);
      const stop = activeStatus(target);
      void call(
        stop ? METHODS.runStop : METHODS.runStart,
        { target: slug },
        stop ? 'stop' : 'start',
      );
    },
    [call, targets],
  );

  const rowAction = useCallback(
    (slug: string, action: RowAction) => {
      if (action === 'toggle') toggleTarget(slug);
      else void call(METHODS.runRestart, { target: slug }, 'restart');
    },
    [call, toggleTarget],
  );

  const openPalette = useCallback(
    (prefill?: string) => {
      setPaletteQuery('');
      setPaletteIndex(0);
      setForm(null);
      setPicker(null);
      // Picker data is cached for one palette session: a repo registered since
      // the last one has to show up, but not mid-keystroke.
      resetPickerData();
      setStatus(prefill === undefined ? null : `target: ${prefill}`);
      setMode('palette');
    },
    [resetPickerData],
  );

  const prefilled = useRef<string | null>(null);

  const startVerb = useCallback(
    (verb: Verb) => {
      if (verb.fields.length === 0) {
        setMode('browse');
        void call(verb.method, undefined, verb.title);
        return;
      }
      const values: Record<string, string> = {};
      for (const field of verb.fields) {
        if (field.kind === 'target') values[field.name] = prefilled.current ?? selected ?? '';
      }
      setForm({ verb, values, field: 0 });
      setMode('form');
    },
    [call, selected],
  );

  const openPicker = useCallback(
    (active: PaletteForm, index: number, seed: string) => {
      const field = active.verb.fields[index];
      if (field === undefined || !isPickable(field.kind)) return false;
      const scope =
        field.scopeField === undefined ? '' : (active.values[field.scopeField] ?? '').trim();
      loadPickerData(field.kind, scope);
      setForm({ ...active, field: index });
      setPicker({ kind: field.kind, field: field.name, query: seed, index: 0 });
      setMode('picker');
      return true;
    },
    [loadPickerData],
  );

  /**
   * The only way a picked value reaches the form. Anything scoped to the field
   * is re-checked against the new scope and dropped if it no longer belongs,
   * because a checkout from the previous repo would otherwise submit silently.
   */
  const writeField = useCallback((active: PaletteForm, name: string, value: string) => {
    const values = applyFieldValue(
      active.verb.fields,
      active.values,
      name,
      value,
      sourceRef.current,
    );
    const at = active.verb.fields.findIndex((field) => field.name === name);
    setForm({
      ...active,
      values,
      field: value === '' || at < 0 ? active.field : nextField(active.verb, values, at),
    });
  }, []);

  const movePicker = useCallback(
    (delta: number) => {
      const count = pickerView?.rows.length ?? 0;
      if (count === 0) return;
      setPicker((state) => {
        if (state === null) return state;
        const at = Math.min(state.index, count - 1);
        return { ...state, index: Math.min(count - 1, Math.max(0, at + delta)) };
      });
    },
    [pickerView],
  );

  const choosePick = useCallback(
    (index: number) => {
      if (pickerView === null || form === null) return;
      const row = pickerView.rows[index];
      if (row === undefined) return;
      writeField(form, pickerView.field, row.item.value);
      setPicker(null);
      setMode('form');
    },
    [form, pickerView, writeField],
  );

  const submitForm = useCallback(
    (active: PaletteForm) => {
      const missing = missingFields(active.verb, active.values);
      if (missing.length > 0) {
        setStatus(`needs ${missing.join(', ')}`);
        return;
      }
      // `logs.follow` is the pane itself, not a request/response call: running it
      // from the palette means "point the log pane here".
      if (active.verb.method === METHODS.logsFollow) {
        const wanted = active.values.target?.trim() ?? '';
        if (wanted !== '') setSelected(wanted);
        const label = active.values.label?.trim() ?? '';
        setFilterLabels(label === '' ? null : new Set([label]));
        setForm(null);
        setPicker(null);
        setMode('browse');
        setStatus(`following ${wanted}`);
        return;
      }
      setForm(null);
      setPicker(null);
      setMode('browse');
      void call(active.verb.method, buildParams(active.verb, active.values), active.verb.title);
    },
    [call],
  );

  const doCopy = useCallback(() => {
    const text = logs
      .snapshot()
      .map((line) => `[${line.label}] ${stripAnsi(line.text)}`)
      .join('\n');
    setCopied(text);
    setStatus(`copied ${logs.visible.length} lines`);
    if (props.copy !== undefined) void props.copy(text);
    else void copyToClipboard(text, renderer);
  }, [logs, props, renderer]);

  const soloLabel = useCallback((label: string) => setFilterLabels(new Set([label])), []);
  const soloIndex = useCallback(
    (index: number) => {
      const label = labels[index];
      if (label !== undefined) soloLabel(label);
    },
    [labels, soloLabel],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (slugs.length === 0) return;
      const at = selected === null ? -1 : slugs.indexOf(selected);
      const next = Math.min(slugs.length - 1, Math.max(0, at + delta));
      setSelected(slugs[next]!);
    },
    [selected, slugs],
  );

  // Destructured for the same reason as `cache`: the store is a fresh object
  // every render, `patch` is not, and the key handler depends on this callback.
  const { patch: patchUi } = ui;

  const toggleGroup = useCallback(
    (repoPath: string) => {
      const next = new Set(collapsed);
      if (next.has(repoPath)) next.delete(repoPath);
      else next.add(repoPath);
      setCollapsed(next);
      patchUi({ collapsedRepos: [...next] });
    },
    [collapsed, patchUi],
  );

  const verbs = useMemo(() => filterVerbs(paletteQuery), [paletteQuery]);

  const onKey = useCallback(
    (key: KeyEvent) => {
      if (key.eventType === 'release') return;
      const name = key.name;

      if (mode === 'search') {
        if (name === 'escape') {
          setMode('browse');
          setSearchDraft('');
          return;
        }
        if (name === 'return' || name === 'enter') {
          setSearch(searchDraft === '' ? null : searchDraft);
          setMode('browse');
          return;
        }
        if (name === 'backspace') {
          setSearchDraft((value) => value.slice(0, -1));
          return;
        }
        if (isPrintable(key)) setSearchDraft((value) => value + key.sequence);
        return;
      }

      if (mode === 'palette') {
        if (name === 'escape') {
          setMode('browse');
          return;
        }
        if (name === 'down' || (key.ctrl && name === 'n')) {
          setPaletteIndex((at) => Math.min(verbs.length - 1, at + 1));
          return;
        }
        if (name === 'up' || (key.ctrl && name === 'p')) {
          setPaletteIndex((at) => Math.max(0, at - 1));
          return;
        }
        if (name === 'return' || name === 'enter') {
          const verb = verbs[paletteIndex];
          if (verb !== undefined) startVerb(verb);
          return;
        }
        if (name === 'backspace') {
          setPaletteQuery((value) => value.slice(0, -1));
          setPaletteIndex(0);
          return;
        }
        if (isPrintable(key)) {
          setPaletteQuery((value) => value + key.sequence);
          setPaletteIndex(0);
        }
        return;
      }

      if (mode === 'picker') {
        if (pickerView === null) {
          setPicker(null);
          setMode(form === null ? 'palette' : 'form');
          return;
        }
        if (name === 'escape') {
          setPicker(null);
          setMode('form');
          return;
        }
        if (name === 'down' || (key.ctrl && name === 'n')) {
          movePicker(1);
          return;
        }
        if (name === 'up' || (key.ctrl && name === 'p')) {
          movePicker(-1);
          return;
        }
        if (name === 'return' || name === 'enter' || name === 'tab') {
          choosePick(pickerView.index);
          return;
        }
        if (name === 'backspace') {
          setPicker((state) =>
            state === null ? state : { ...state, query: state.query.slice(0, -1), index: 0 },
          );
          return;
        }
        if (isPrintable(key)) {
          setPicker((state) =>
            state === null ? state : { ...state, query: state.query + key.sequence, index: 0 },
          );
        }
        return;
      }

      if (mode === 'form') {
        const active = form;
        if (active === null) {
          setMode('browse');
          return;
        }
        if (name === 'escape') {
          setForm(null);
          setMode('palette');
          return;
        }
        const field = active.verb.fields[active.field];
        const pickable = field !== undefined && isPickable(field.kind);
        const empty = field === undefined || (active.values[field.name] ?? '').trim() === '';
        if (name === 'return' || name === 'enter') {
          // A required field with nothing in it has a list behind it; opening
          // that beats answering `needs repo` to a keystroke meant to fill it.
          if (
            pickable &&
            empty &&
            field?.required === true &&
            openPicker(active, active.field, '')
          ) {
            return;
          }
          submitForm(active);
          return;
        }
        if (name === 'tab' || name === 'down') {
          setForm({
            ...active,
            field: (active.field + 1) % Math.max(1, active.verb.fields.length),
          });
          return;
        }
        if (name === 'up') {
          const count = Math.max(1, active.verb.fields.length);
          setForm({ ...active, field: (active.field - 1 + count) % count });
          return;
        }
        if (field === undefined) return;
        if (name === 'backspace') {
          // A picked value is one thing, not a string being edited: backspace
          // clears it (and whatever was scoped to it) rather than shaving a
          // character off a path nobody typed.
          if (pickable) writeField(active, field.name, '');
          else {
            const value = active.values[field.name] ?? '';
            setForm({ ...active, values: { ...active.values, [field.name]: value.slice(0, -1) } });
          }
          return;
        }
        if (isPrintable(key)) {
          if (pickable) {
            openPicker(active, active.field, key.sequence);
            return;
          }
          const value = (active.values[field.name] ?? '') + key.sequence;
          setForm({ ...active, values: { ...active.values, [field.name]: value } });
        }
        return;
      }

      if (mode === 'command') {
        if (name === 'escape') {
          setMode('browse');
          return;
        }
        const index = Number.parseInt(key.sequence, 10);
        if (Number.isInteger(index) && index >= 1 && index <= labels.length) {
          const label = labels[index - 1]!;
          setMode('browse');
          if (selected !== null) {
            void call(METHODS.runRestart, { target: selected, command: label }, `restart ${label}`);
          }
        }
        return;
      }

      // browse
      if (name === 'q') {
        setExited(true);
        props.onExit();
        return;
      }
      if (name === ':' || key.sequence === ':' || (key.ctrl && name === 'p')) {
        prefilled.current = null;
        openPalette();
        return;
      }
      if (name === '/') {
        setSearchDraft(search ?? '');
        setMode('search');
        return;
      }
      if (name === 'j' || name === 'down') {
        moveSelection(1);
        return;
      }
      if (name === 'k' || name === 'up') {
        moveSelection(-1);
        return;
      }
      if (key.ctrl && name === 'd') {
        logs.scrollBy(-Math.floor(logHeight / 2));
        return;
      }
      if (key.ctrl && name === 'u') {
        logs.scrollBy(Math.floor(logHeight / 2));
        return;
      }
      if (name === 'g' && !key.shift && key.sequence === 'g') {
        logs.toTop();
        return;
      }
      if (key.sequence === 'G') {
        logs.toBottom();
        return;
      }
      if (key.sequence === 'R') {
        if (labels.length > 0) setMode('command');
        else setStatus('no commands to restart');
        return;
      }
      if (name === 'r') {
        if (selected !== null) void call(METHODS.runRestart, { target: selected }, 'restart');
        return;
      }
      if (name === 's') {
        if (selected !== null) toggleTarget(selected);
        return;
      }
      if (name === 'a') {
        setFilterLabels(null);
        return;
      }
      if (name === 'y') {
        doCopy();
        return;
      }
      if (name === 'return' || name === 'enter') {
        const target = targets.find((candidate) => candidate.slug === selected);
        if (target !== undefined) toggleGroup(target.repoPath);
        return;
      }
      if (name === 'escape') {
        setSearch(null);
        setStatus(null);
        return;
      }
      if (key.sequence >= '1' && key.sequence <= '9') {
        soloIndex(Number.parseInt(key.sequence, 10) - 1);
      }
    },
    [
      call,
      choosePick,
      doCopy,
      form,
      labels,
      logHeight,
      logs,
      mode,
      movePicker,
      moveSelection,
      openPalette,
      openPicker,
      paletteIndex,
      pickerView,
      props,
      search,
      searchDraft,
      selected,
      soloIndex,
      startVerb,
      submitForm,
      targets,
      toggleGroup,
      toggleTarget,
      verbs,
      writeField,
    ],
  );

  useKeyboard(onKey);

  useEffect(() => {
    props.probe?.report({
      mode,
      selected,
      slugs,
      lastHit: lastHit?.id ?? null,
      filterLabels: filterLabels === null ? null : [...filterLabels],
      search,
      labels,
      visibleLines: logs.visible.length,
      bufferLines: logs.retained,
      totalLines: logs.total,
      scrollBack: logs.scrollBack,
      collapsed: [...collapsed],
      paletteMethods: verbs.map((verb) => verb.method),
      paletteIndex,
      sidebarWidth,
      formMethod: form?.verb.method ?? null,
      formValues: form?.values ?? {},
      picker:
        pickerView === null
          ? null
          : {
              kind: pickerView.kind,
              field: pickerView.field,
              query: pickerView.query,
              index: pickerView.index,
              note: pickerView.note,
              rows: pickerView.rows.map((row) => ({
                value: row.item.value,
                label: row.item.label,
                detail: row.item.detail,
                match: row.labelMatch,
                detailMatch: row.detailMatch,
              })),
            },
      status,
      copied,
      exited,
    });
  });

  const chipsRow = Chips({
    labels,
    commands: current?.commands ?? [],
    active: filterLabels,
    onSolo: (label) => {
      hit(`chip:${label}`);
      soloLabel(label);
    },
    onAll: () => {
      hit(`chip:${ALL_CHIP}`);
      setFilterLabels(null);
    },
  });

  const inPalette = mode === 'palette' || mode === 'form' || mode === 'picker';

  const pane = inPalette
    ? Palette({
        query: paletteQuery,
        verbs,
        index: paletteIndex,
        form,
        picker: pickerView,
        status,
        width: mainWidth,
        height: dimensions.height - HEADER_HEIGHT - 1,
        onPick: (index) => {
          setPaletteIndex(index);
          const verb = verbs[index];
          if (verb !== undefined) startVerb(verb);
        },
        // Clicking a ▾ field is the mouse's Enter: it focuses and opens the list.
        onFocusField: (index) => {
          if (form === null) return;
          if (!openPicker(form, index, '')) setForm({ ...form, field: index });
        },
        onPickerPick: choosePick,
        onPickerScroll: movePicker,
      })
    : LogPane({
        lines: logs.visible,
        labels,
        width: mainWidth,
        empty:
          logs.error !== null
            ? `  ${logs.error}`
            : props.link === null
              ? '  not connected'
              : '  waiting for output…',
        onScroll: (direction, delta) =>
          logs.scrollBy(direction === 'up' ? Math.max(1, delta) : -Math.max(1, delta)),
        onLine: (line: LogLine, x, y) => hit(`log:${line.seq}@${x},${y}`),
      });

  const hintLine =
    mode === 'search'
      ? `/${searchDraft}█   Enter to apply · Esc to cancel`
      : mode === 'command'
        ? `restart which command? ${labels.map((label, i) => `${i + 1} ${label}`).join('  ')} · Esc`
        : status !== null
          ? `${fit(status, Math.max(10, mainWidth - 2))}   ${FOOTER}`
          : FOOTER;

  // The resize handlers live on the root because OpenTUI captures on the first
  // *drag* event, not on the press: flick off a one-column border fast enough
  // and the log pane owns the capture. Drag events bubble, so the root sees them
  // whatever grabbed them, and `resizing` is what says they are ours.
  return box(
    {
      style: { width: '100%', height: '100%', flexDirection: 'row', backgroundColor: UI.panel },
      onMouseDrag: (event) => {
        if (!resizing.current) return;
        applyWidth(clampSidebarWidth(event.x + 1, dimensions.width));
        setEdgeLit(true);
      },
      onMouseDragEnd: () => {
        if (!resizing.current) return;
        resizing.current = false;
        setEdgeLit(false);
        patchUi({ sidebarWidth: widthRef.current });
      },
      onMouseUp: () => {
        resizing.current = false;
      },
    },
    Sidebar({
      groups,
      selected,
      hovered,
      collapsed,
      now,
      width: sidebarWidth,
      edgeLit,
      onEdge: setEdgeLit,
      onResizeStart: () => {
        resizing.current = true;
        widthRef.current = sidebarWidth;
      },
      onSelect: (slug, x, y) => {
        hit(`target:${slug}@${x},${y}`);
        setSelected(slug);
      },
      onContext: (slug) => {
        hit(`context:${slug}`);
        prefilled.current = slug;
        setSelected(slug);
        openPalette(slug);
      },
      onAction: rowAction,
      onToggleGroup: (repoPath) => {
        hit(`repo:${repoPath}`);
        toggleGroup(repoPath);
      },
      onHover: setHovered,
    }),
    box(
      { key: 'main', style: { flexGrow: 1, flexDirection: 'column' } },
      Header({ target: current, now, width: mainWidth }),
      ...(inPalette ? [] : [chipsRow]),
      pane,
      Footer({ hint: hintLine, width: mainWidth }),
    ),
  );
}
