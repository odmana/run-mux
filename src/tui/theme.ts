/** Colours and glyphs. One place, so the sidebar and the log pane cannot drift. */

import type { CommandStatus, TargetStatus } from '../types.js';

export const UI = {
  panel: '#20242c',
  border: '#3b4252',
  borderFocus: '#5e81ac',
  selection: '#2e3a4a',
  hover: '#28303c',
  text: '#d8dee9',
  muted: '#7b8494',
  accent: '#88c0d0',
  ok: '#a3be8c',
  warn: '#ebcb8b',
  danger: '#bf616a',
  chip: '#2a303a',
  chipActive: '#3a5f8a',
} as const;

/** Ported from agent-mux's PlaybookView, so a label keeps the colour users learnt. */
const LABEL_COLOURS = [
  '#81a1c1',
  '#a3be8c',
  '#ebcb8b',
  '#b48ead',
  '#88c0d0',
  '#bf616a',
  '#d08770',
  '#5e81ac',
] as const;

/**
 * Colour follows the command's position in the playbook, not a hash of its
 * name: the eye learns "the second chip is green" and a rename must not shuffle
 * every other colour.
 */
export function labelColour(labels: readonly string[], label: string): string {
  const index = labels.indexOf(label);
  if (index < 0) return UI.muted;
  return LABEL_COLOURS[index % LABEL_COLOURS.length]!;
}

export const TARGET_DOT: Record<TargetStatus, string> = {
  stopped: '○',
  starting: '◌',
  running: '●',
  degraded: '◑',
  failed: '✖',
  unavailable: '⊗',
};

export const TARGET_COLOUR: Record<TargetStatus, string> = {
  stopped: UI.muted,
  starting: UI.warn,
  running: UI.ok,
  degraded: UI.warn,
  failed: UI.danger,
  unavailable: UI.muted,
};

export const COMMAND_MARK: Record<CommandStatus, string> = {
  pending: '⋯',
  running: '●',
  restarting: '◌',
  exited: '✓',
  errored: '✗',
  stopped: '○',
};

export const COMMAND_COLOUR: Record<CommandStatus, string> = {
  pending: UI.muted,
  running: UI.ok,
  restarting: UI.warn,
  exited: UI.muted,
  errored: UI.danger,
  stopped: UI.muted,
};
