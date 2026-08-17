/**
 * Everything that talks to the daemon.
 *
 * The TUI's only interface to run-mux is `protocol.ts` over the ipc client, so
 * the hooks here are the whole surface: poll `target.list` for the sidebar,
 * poll `run.status` for the selected row, and hold exactly one `logs.follow`
 * subscription — dropped the moment the selection moves, because a leaked
 * follow makes the daemon stream into nothing forever.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  METHODS,
  type ConfigResolveResult,
  type RepoListResult,
  type RepoView,
  type RunResult,
  type TargetListResult,
  type TargetView,
} from '../protocol.js';
import type { LogEntry, RpcError } from '../types.js';
import { LogBuffer, type LogFilter, type LogLine } from './log-buffer.js';
import type { CommandChoice, Loadable, PickerKind, ScopedLoadable } from './picker.js';

/** The slice of `IpcClient` the TUI uses; an `IpcClient` satisfies it as-is. */
export interface DaemonLink {
  readonly closed: boolean;
  request(method: string, params?: unknown): Promise<unknown>;
  subscribe(
    method: string,
    params: unknown,
    onData: (data: unknown) => void,
    handlers?: { onEnd?: () => void; onError?: (error: RpcError) => void },
  ): Promise<() => void>;
}

export const TARGET_POLL_MS = 2000;
export const STATUS_POLL_MS = 1000;
/**
 * The spike's number. At ~80ms the renderer redraws about 12 times a second,
 * which is under the flicker threshold and 437x fewer React commits than one
 * per line; at 5,000 lines/s that was the difference between 4,997 lines/s with
 * flat memory and 1 fps with a third of the input on the floor.
 */
export const COALESCE_MS = 80;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TargetsState {
  targets: TargetView[];
  error: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export function useTargets(link: DaemonLink | null, pollMs = TARGET_POLL_MS): TargetsState {
  const [targets, setTargets] = useState<TargetView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (link === null) return;
    try {
      const result = (await link.request(METHODS.targetList)) as TargetListResult;
      setTargets(result.targets);
      setError(null);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setLoaded(true);
    }
  }, [link]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { targets, error, loaded, refresh };
}

/**
 * The selected row is polled on its own, faster, interval: `target.list` is the
 * cheap overview, `run.status` is the authority for the pane that is on screen.
 */
export function useRunStatus(
  link: DaemonLink | null,
  slug: string | null,
  pollMs = STATUS_POLL_MS,
): TargetView | null {
  const [status, setStatus] = useState<TargetView | null>(null);

  useEffect(() => {
    setStatus(null);
    if (link === null || slug === null) return;
    let live = true;
    const poll = async () => {
      try {
        const result = (await link.request(METHODS.runStatus, { target: slug })) as RunResult;
        if (live) setStatus(result.target);
      } catch {
        // The sidebar's copy stays on screen; a transient failure must not blank the pane.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [link, slug, pollMs]);

  return status;
}

export interface PickerCache {
  repos: Loadable<RepoView[]>;
  commands: ScopedLoadable<CommandChoice[]>;
  /** Called when a picker opens. Fetches only what that kind needs, and once. */
  load: (kind: PickerKind, scope: string) => void;
  /** Drops the cache so the next palette session sees the daemon's current answer. */
  reset: () => void;
}

const IDLE_REPOS: Loadable<RepoView[]> = { data: null, loading: false, error: null };
const IDLE_COMMANDS: ScopedLoadable<CommandChoice[]> = {
  data: null,
  loading: false,
  error: null,
  scope: '',
};

/**
 * Picker data, fetched on demand and held for one palette session.
 *
 * Deliberately not polled: a picker is open for seconds, and a list that
 * reordered itself under the cursor between keystrokes would move the row out
 * from under Enter. `repo.list` answers repos, checkouts *and* playbooks in one
 * call, and the target picker rides on the list the sidebar already polls, so a
 * whole `Add target` costs exactly one request.
 */
export function usePickerCache(
  link: DaemonLink | null,
  targets: readonly TargetView[],
): PickerCache {
  const [repos, setRepos] = useState<Loadable<RepoView[]>>(IDLE_REPOS);
  const [commands, setCommands] = useState<ScopedLoadable<CommandChoice[]>>(IDLE_COMMANDS);

  // Bumped by `reset`, so a reply that arrives after the palette closed cannot
  // repopulate the next session with the last one's answer.
  const generation = useRef(0);
  const askedRepos = useRef(false);
  const askedCommands = useRef<string | null>(null);
  const liveTargets = useRef(targets);
  liveTargets.current = targets;

  const reset = useCallback(() => {
    generation.current += 1;
    askedRepos.current = false;
    askedCommands.current = null;
    setRepos(IDLE_REPOS);
    setCommands(IDLE_COMMANDS);
  }, []);

  const loadRepos = useCallback(() => {
    if (link === null || askedRepos.current) return;
    askedRepos.current = true;
    const at = generation.current;
    setRepos({ data: null, loading: true, error: null });
    void link.request(METHODS.repoList).then(
      (result) => {
        if (generation.current !== at) return;
        setRepos({ data: (result as RepoListResult).repos, loading: false, error: null });
      },
      (failure: unknown) => {
        if (generation.current !== at) return;
        // Retryable: the message is shown, and the next open asks again.
        askedRepos.current = false;
        setRepos({ data: null, loading: false, error: message(failure) });
      },
    );
  }, [link]);

  const loadCommands = useCallback(
    (slug: string) => {
      if (link === null || slug === '' || askedCommands.current === slug) return;
      askedCommands.current = slug;
      const known =
        liveTargets.current.find((target) => target.slug === slug || target.alias === slug)
          ?.commands ?? [];
      if (known.length > 0) {
        setCommands({
          data: known.map((command) => ({ label: command.label, detail: command.status })),
          loading: false,
          error: null,
          scope: slug,
        });
        return;
      }
      const at = generation.current;
      setCommands({ data: null, loading: true, error: null, scope: slug });
      // A target that has never run reports no commands, so its playbook is the
      // only place the labels exist.
      void link.request(METHODS.configResolve, { target: slug }).then(
        (result) => {
          if (generation.current !== at) return;
          setCommands({
            data: (result as ConfigResolveResult).playbook.commands.map((command) => ({
              label: command.label,
              detail: command.command,
            })),
            loading: false,
            error: null,
            scope: slug,
          });
        },
        (failure: unknown) => {
          if (generation.current !== at) return;
          askedCommands.current = null;
          setCommands({ data: null, loading: false, error: message(failure), scope: slug });
        },
      );
    },
    [link],
  );

  const load = useCallback(
    (kind: PickerKind, scope: string) => {
      switch (kind) {
        case 'repo':
        case 'checkout':
        case 'playbook':
          loadRepos();
          return;
        case 'label':
          loadCommands(scope);
          return;
        case 'target':
          // Already polled for the sidebar; a second fetch would buy nothing.
          return;
        default: {
          const exhaustive: never = kind;
          return exhaustive;
        }
      }
    },
    [loadCommands, loadRepos],
  );

  return { repos, commands, load, reset };
}

export interface LogStream {
  /** The only log state React holds: at most `height` lines. */
  visible: LogLine[];
  scrollBack: number;
  atTop: boolean;
  atBottom: boolean;
  /** Lines the buffer has ever seen, dropped-by-filter and scrolled-past included. */
  total: number;
  retained: number;
  labels: string[];
  error: string | null;
  scrollBy: (rows: number) => void;
  toTop: () => void;
  toBottom: () => void;
  /** The filtered window as plain text, for `y`. */
  snapshot: () => LogLine[];
}

export interface LogStreamOptions {
  link: DaemonLink | null;
  slug: string | null;
  height: number;
  filter: LogFilter;
  coalesceMs?: number;
  retain?: number;
}

export function useLogStream(options: LogStreamOptions): LogStream {
  const { link, slug, height, filter, coalesceMs = COALESCE_MS, retain } = options;

  const buffer = useRef<LogBuffer>(new LogBuffer(retain));
  const pending = useRef<LogEntry[]>([]);
  const filterRef = useRef(filter);
  const heightRef = useRef(height);
  const scrollBackRef = useRef(0);

  const [visible, setVisible] = useState<LogLine[]>([]);
  const [edges, setEdges] = useState({ atTop: false, atBottom: true, scrollBack: 0 });
  const [counts, setCounts] = useState({ total: 0, retained: 0 });
  const [labels, setLabels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  filterRef.current = filter;
  heightRef.current = height;

  const project = useCallback((nextBack: number) => {
    const view = buffer.current.window(filterRef.current, heightRef.current, nextBack);
    scrollBackRef.current = view.scrollBack;
    setVisible(view.lines);
    setEdges({ atTop: view.atTop, atBottom: view.atBottom, scrollBack: view.scrollBack });
    setCounts({ total: buffer.current.total, retained: buffer.current.retained });
  }, []);

  useEffect(() => {
    const store = buffer.current;
    store.clear();
    pending.current = [];
    scrollBackRef.current = 0;
    setVisible([]);
    setEdges({ atTop: false, atBottom: true, scrollBack: 0 });
    setCounts({ total: 0, retained: 0 });
    setLabels([]);
    setError(null);

    if (link === null || slug === null) return;

    let cancelled = false;
    let stop: (() => void) | undefined;
    void link
      .subscribe(
        METHODS.logsFollow,
        { target: slug },
        (data) => pending.current.push(data as LogEntry),
        { onError: (failure) => setError(failure.message) },
      )
      .then((unsubscribe) => {
        // The selection can move while `subscribe` is still in flight; without
        // this the daemon keeps a stream nobody reads.
        if (cancelled) unsubscribe();
        else stop = unsubscribe;
      })
      .catch((failure: unknown) => setError(message(failure)));

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [link, slug]);

  // The coalescer. One timer for the life of the pane; nothing about a filter
  // or a resize is allowed to restart it, or a busy stream would never flush.
  useEffect(() => {
    const timer = setInterval(() => {
      const batch = pending.current;
      if (batch.length === 0) return;
      pending.current = [];
      const store = buffer.current;
      const mark = store.total;
      for (const entry of batch) store.append(entry);
      const arrived = store.countSince(mark, filterRef.current);
      // Scrolled away from the tail: hold position rather than letting the rows
      // slide out from under the cursor.
      const nextBack = scrollBackRef.current === 0 ? 0 : scrollBackRef.current + arrived;
      project(nextBack);
      setLabels((current) => {
        const seen = store.labels();
        return seen.length === current.length && seen.every((l, i) => l === current[i])
          ? current
          : seen;
      });
    }, coalesceMs);
    return () => clearInterval(timer);
  }, [coalesceMs, project]);

  // A filter change or a resize re-windows immediately; waiting for the next
  // flush would leave a visibly stale pane on an idle target.
  const filterKey = `${filter.labels === null ? '*' : [...filter.labels].sort().join(',')} ${filter.search ?? ''}`;
  useEffect(() => {
    project(scrollBackRef.current);
  }, [filterKey, height, project]);

  const scrollBy = useCallback(
    (rows: number) => project(Math.max(0, scrollBackRef.current + rows)),
    [project],
  );
  const toTop = useCallback(() => project(Number.MAX_SAFE_INTEGER), [project]);
  const toBottom = useCallback(() => project(0), [project]);
  const snapshot = useCallback(
    () => buffer.current.window(filterRef.current, heightRef.current, scrollBackRef.current).lines,
    [],
  );

  return {
    visible,
    scrollBack: edges.scrollBack,
    atTop: edges.atTop,
    atBottom: edges.atBottom,
    total: counts.total,
    retained: counts.retained,
    labels,
    error,
    scrollBy,
    toTop,
    toBottom,
    snapshot,
  };
}
