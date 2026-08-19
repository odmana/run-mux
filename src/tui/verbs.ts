/**
 * The command palette's catalogue — and the reason "the TUI can do everything
 * the CLI can" stays true.
 *
 * It is a `Record<MethodName, Verb>` rather than an array on purpose: adding a
 * method to `protocol.ts` without adding it here is a **compile** error, not a
 * missing menu entry somebody notices six months later. `test/tui.test.ts`
 * asserts the same thing at runtime against `METHODS`.
 */

import { METHODS, type TargetView } from '../protocol.js';

export type MethodName = (typeof METHODS)[keyof typeof METHODS];

/**
 * Methods the palette deliberately has no entry for: the TUI's own view state,
 * which it reads and writes as a side effect of the mouse. "Set sidebar width"
 * is not a thing to go looking for in a command list.
 */
export const INTERNAL_METHODS = [METHODS.uiGet, METHODS.uiSet] as const;

export type VerbMethodName = Exclude<MethodName, (typeof INTERNAL_METHODS)[number]>;

/**
 * `repo`, `checkout`, `playbook`, `target` and `label` are answered from a fuzzy
 * picker (see `picker.ts`) rather than typed, which is what keeps the four
 * identifier schemes — repo path, checkout path, playbook name, target slug —
 * from being typed into each other's boxes.
 */
export type FieldKind =
  | 'target'
  | 'text'
  | 'label'
  | 'number'
  | 'boolean'
  | 'repo'
  | 'checkout'
  | 'playbook';

/**
 * The `TargetView` keys a field may be seeded from — the identifiers a picker
 * would otherwise ask for, and only those: seeding a slug or a slot would put a
 * value in a box the daemon reads differently.
 */
export type SeedKey = 'repoPath' | 'checkoutPath' | 'playbookName';

export interface VerbField {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  placeholder?: string;
  /**
   * The field whose value scopes this one's picker: a checkout belongs to a
   * repo, a command label to a target. Changing the named field invalidates
   * this one rather than letting a mismatched pair reach the daemon.
   */
  scopeField?: string;
  /**
   * The `TargetView` key this field opens with, taken from whichever target the
   * sidebar has selected. Adding a target is nearly always "the same repo and
   * playbook, a different worktree", so the two that do not change are answered
   * before the form is drawn.
   */
  seedFrom?: SeedKey;
}

export interface Verb {
  method: VerbMethodName;
  title: string;
  /** The equivalent shell invocation, shown so the palette teaches the CLI. */
  cli: string;
  hint: string;
  fields: readonly VerbField[];
  /** Refresh the target list once this has run. */
  mutates?: boolean;
  /** Streaming verbs answer with frames, not a value; the palette says so. */
  streaming?: boolean;
}

const target: VerbField = {
  name: 'target',
  label: 'target',
  kind: 'target',
  required: true,
  placeholder: 'pick a target',
};
const label: VerbField = {
  name: 'label',
  label: 'command',
  kind: 'label',
  placeholder: 'pick a command',
  scopeField: 'target',
};
const command: VerbField = { ...label, name: 'command' };

export const VERBS: Record<VerbMethodName, Verb> = {
  [METHODS.targetList]: {
    method: METHODS.targetList,
    title: 'List targets',
    cli: 'rmux ls',
    hint: 'refresh the sidebar from the daemon',
    fields: [],
  },
  [METHODS.runStart]: {
    method: METHODS.runStart,
    title: 'Start target',
    cli: 'rmux start <target>',
    hint: 'run the playbook: tasks first, then services',
    fields: [target],
    mutates: true,
  },
  [METHODS.runStop]: {
    method: METHODS.runStop,
    title: 'Stop target',
    cli: 'rmux stop <target>',
    hint: 'kill every command in the target, process tree included',
    fields: [target],
    mutates: true,
  },
  [METHODS.runRestart]: {
    method: METHODS.runRestart,
    title: 'Restart target or one command',
    cli: 'rmux restart <target> [--command <label>]',
    hint: 'leave `command` empty to restart the whole stack',
    fields: [target, command],
    mutates: true,
  },
  [METHODS.runStatus]: {
    method: METHODS.runStatus,
    title: 'Target status',
    cli: 'rmux status <target>',
    hint: 'the target header and a row per command',
    fields: [target],
  },
  [METHODS.targetAdd]: {
    method: METHODS.targetAdd,
    title: 'Add target',
    cli: 'rmux add <repo> <checkout> <playbook>',
    hint: 'pair a checkout with a playbook — pick each, never type a path',
    fields: [
      {
        name: 'repoPath',
        label: 'repo',
        kind: 'repo',
        required: true,
        placeholder: 'pick a registered repo',
        seedFrom: 'repoPath',
      },
      {
        name: 'checkoutPath',
        label: 'checkout',
        kind: 'checkout',
        required: true,
        placeholder: 'pick a worktree',
        scopeField: 'repoPath',
      },
      {
        name: 'playbookName',
        label: 'playbook',
        kind: 'playbook',
        required: true,
        placeholder: 'pick a playbook',
        scopeField: 'repoPath',
        seedFrom: 'playbookName',
      },
    ],
    mutates: true,
  },
  [METHODS.targetUpdate]: {
    method: METHODS.targetUpdate,
    title: 'Set target autostart',
    cli: 'rmux add --autostart',
    hint: 'start this target when the daemon starts',
    fields: [target, { name: 'autostart', label: 'autostart', kind: 'boolean' }],
    mutates: true,
  },
  [METHODS.targetRemove]: {
    method: METHODS.targetRemove,
    title: 'Remove target',
    cli: 'rmux rm <target>',
    hint: 'the checkout is left alone — run-mux never removes a worktree',
    fields: [target],
    mutates: true,
  },
  [METHODS.logsQuery]: {
    method: METHODS.logsQuery,
    title: 'Query logs',
    cli: 'rmux logs <target> [--label] [--since] [--tail]',
    hint: 'a one-shot read of the stored run, no follow',
    fields: [
      target,
      label,
      { name: 'since', label: 'since (epoch ms)', kind: 'number' },
      { name: 'tail', label: 'tail (lines)', kind: 'number' },
    ],
  },
  [METHODS.logsFollow]: {
    method: METHODS.logsFollow,
    title: 'Follow logs',
    cli: 'rmux logs <target> --follow',
    hint: 'point the log pane at this target and stream it',
    fields: [target, label],
    streaming: true,
  },
  [METHODS.envResolve]: {
    method: METHODS.envResolve,
    title: 'Resolve environment',
    cli: 'rmux env <target> [--command <label>]',
    hint: 'every variable and the layer it came from',
    fields: [target, command],
  },
  [METHODS.configResolve]: {
    method: METHODS.configResolve,
    title: 'Resolve playbook',
    cli: 'rmux config resolve <target>',
    hint: 'the effective playbook, and whether the repo or your global config won',
    fields: [target],
  },
  [METHODS.configReload]: {
    method: METHODS.configReload,
    title: 'Reload config',
    cli: 'rmux reload',
    hint: 're-read every config; running targets keep the definition they started with',
    fields: [],
    mutates: true,
  },
  [METHODS.repoAdd]: {
    method: METHODS.repoAdd,
    title: 'Register repo',
    cli: 'rmux repo add <path>',
    hint: 'the daemon normalises the path, so type it however you like',
    // The one path still typed by hand: this repo is not registered yet, so
    // there is no list to pick it from.
    fields: [{ name: 'path', label: 'repo path', kind: 'text', required: true }],
    mutates: true,
  },
  [METHODS.repoList]: {
    method: METHODS.repoList,
    title: 'List repos',
    cli: 'rmux repo ls',
    hint: 'registered repos with their checkouts and playbooks',
    fields: [],
  },
  [METHODS.repoRemove]: {
    method: METHODS.repoRemove,
    title: 'Unregister repo',
    cli: 'rmux repo rm <path>',
    hint: 'targets built from it go too',
    fields: [
      { name: 'path', label: 'repo', kind: 'repo', required: true, placeholder: 'pick a repo' },
    ],
    mutates: true,
  },
  [METHODS.checkoutList]: {
    method: METHODS.checkoutList,
    title: 'List checkouts',
    cli: 'rmux repo ls',
    hint: 'worktrees of a registered repo, and the playbooks they offer',
    fields: [
      { name: 'repoPath', label: 'repo', kind: 'repo', required: true, placeholder: 'pick a repo' },
    ],
  },
  [METHODS.daemonStatus]: {
    method: METHODS.daemonStatus,
    title: 'Daemon status',
    cli: 'rmux daemon status',
    hint: 'pid, uptime, socket and how many targets it holds',
    fields: [],
  },
  [METHODS.daemonStop]: {
    method: METHODS.daemonStop,
    title: 'Stop the daemon',
    cli: 'rmux daemon stop',
    hint: 'processes are daemon-scoped, so every running target stops with it',
    fields: [],
    mutates: true,
  },
  [METHODS.ping]: {
    method: METHODS.ping,
    title: 'Ping daemon',
    cli: 'rmux daemon status',
    hint: 'version and protocol handshake, nothing else',
    fields: [],
  },
};

/** Display order is this file's order, which is task frequency, not alphabetical. */
export const VERB_LIST: readonly Verb[] = Object.values(VERBS);

export function filterVerbs(query: string): Verb[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...VERB_LIST];
  return VERB_LIST.filter((verb) =>
    `${verb.title} ${verb.method} ${verb.cli} ${verb.hint}`.toLowerCase().includes(needle),
  );
}

/**
 * The values a form opens with, read off the selected target.
 *
 * Nothing here is checked against a picker's list, because the caches are empty
 * the moment a form opens — but a repo and a playbook taken from the *same*
 * target are consistent by construction, which is all `applyFieldValue` could
 * have proved. A field whose seed no longer resolves is one the daemon rejects
 * by name, the same as a stale pick.
 */
export function seedValues(
  verb: Verb,
  slug: string,
  from: TargetView | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of verb.fields) {
    if (field.kind === 'target') values[field.name] = slug;
    else if (field.seedFrom !== undefined && from !== undefined) {
      values[field.name] = from[field.seedFrom];
    }
  }
  return values;
}

/** Coerces the form's strings into the params the method actually declares. */
export function buildParams(verb: Verb, values: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of verb.fields) {
    const raw = values[field.name]?.trim() ?? '';
    if (raw === '') continue;
    if (field.kind === 'number') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) params[field.name] = parsed;
      continue;
    }
    if (field.kind === 'boolean') {
      params[field.name] = raw === 'true' || raw === '1' || raw === 'yes';
      continue;
    }
    params[field.name] = raw;
  }
  return params;
}

export function missingFields(verb: Verb, values: Record<string, string>): string[] {
  return verb.fields
    .filter((field) => field.required === true && (values[field.name]?.trim() ?? '') === '')
    .map((field) => field.label);
}
