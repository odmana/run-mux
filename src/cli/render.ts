/**
 * Human-readable formatting. Every function returns strings and writes nothing,
 * so the caller stays in control of which stream the text lands on — the --json
 * contract depends on that never being decided down here.
 */

import type { EnvVarView, RepoView, TargetView } from '../protocol.js';
import type { CommandState, CommandStatus, LogEntry, Playbook, TargetStatus } from '../types.js';
import { pad, paint, type Out } from './output.js';

/** The colour names `paint` accepts, named so helpers can return one. */
export type Colour = Parameters<typeof paint>[1];

const TARGET_COLOURS: Record<TargetStatus, Colour> = {
  running: 'green',
  starting: 'yellow',
  degraded: 'yellow',
  failed: 'red',
  stopped: 'dim',
  unavailable: 'dim',
};

const COMMAND_COLOURS: Record<CommandStatus, Colour> = {
  pending: 'dim',
  running: 'green',
  restarting: 'yellow',
  exited: 'dim',
  errored: 'red',
  stopped: 'dim',
};

const ACTIVE: ReadonlySet<TargetStatus> = new Set<TargetStatus>([
  'running',
  'starting',
  'degraded',
]);

export function statusDot(out: Out, status: TargetStatus): string {
  const glyph = status === 'stopped' || status === 'unavailable' ? '○' : '●';
  return paint(out, TARGET_COLOURS[status], glyph);
}

export function statusText(out: Out, status: TargetStatus): string {
  return paint(out, TARGET_COLOURS[status], status);
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function rowName(target: TargetView): string {
  if (target.alias) return target.alias;
  const prefix = `${target.repoName}/`;
  return target.slug.startsWith(prefix) ? target.slug.slice(prefix.length) : target.slug;
}

function width(values: string[], min: number): number {
  return values.reduce((widest, value) => Math.max(widest, value.length), min);
}

function row(cells: string[]): string {
  return cells.join('').trimEnd();
}

/** `rmux ls`: one block per repo, one row per target. */
export function renderTargets(out: Out, targets: TargetView[], now = Date.now()): string[] {
  if (targets.length === 0) {
    return ['no targets yet — run `rmux add` to create one'];
  }

  const groups = new Map<string, TargetView[]>();
  for (const target of targets) {
    const existing = groups.get(target.repoPath);
    if (existing) existing.push(target);
    else groups.set(target.repoPath, [target]);
  }

  const nameWidth = width(targets.map(rowName), 8) + 2;
  const branchWidth =
    width(
      targets.map((t) => t.branch),
      6,
    ) + 2;
  const statusWidth =
    width(
      targets.map((t) => t.status),
      8,
    ) + 2;

  const lines: string[] = [];
  for (const [repoPath, rows] of groups) {
    if (lines.length > 0) lines.push('');
    lines.push(`${paint(out, 'bold', rows[0].repoName)}  ${paint(out, 'dim', repoPath)}`);
    for (const target of rows) {
      const elapsed =
        ACTIVE.has(target.status) && target.startedAt !== undefined
          ? formatElapsed(now - target.startedAt)
          : '';
      const badges: string[] = [];
      if (target.autostart) badges.push(paint(out, 'cyan', '(autostart)'));
      if (target.staleDefinition) badges.push(paint(out, 'yellow', '(stale)'));
      if (!target.available) badges.push(paint(out, 'red', '(checkout missing)'));
      lines.push(
        row([
          `  ${statusDot(out, target.status)} `,
          pad(rowName(target), nameWidth),
          pad(paint(out, 'dim', target.branch), branchWidth),
          pad(`slot ${target.slot}`, 8),
          pad(statusText(out, target.status), statusWidth),
          pad(paint(out, 'dim', elapsed), elapsed ? 8 : 0),
          badges.join(' '),
        ]),
      );
    }
  }
  return lines;
}

/** `rmux status`: the target header, then the per-command table. */
export function renderTargetDetail(out: Out, target: TargetView, now = Date.now()): string[] {
  const elapsed =
    ACTIVE.has(target.status) && target.startedAt !== undefined
      ? ` ${paint(out, 'dim', formatElapsed(now - target.startedAt))}`
      : '';
  const lines = [
    `${statusDot(out, target.status)} ${paint(out, 'bold', target.slug)}  ${statusText(out, target.status)}${elapsed}`,
    `  ${pad('repo', 10)}${target.repoName}  ${paint(out, 'dim', target.repoPath)}`,
    `  ${pad('checkout', 10)}${target.branch}  ${paint(out, 'dim', target.checkoutPath)}`,
    `  ${pad('playbook', 10)}${target.playbookName}`,
    `  ${pad('slot', 10)}${target.slot}${target.isMain ? paint(out, 'dim', '  (main worktree)') : ''}`,
  ];
  if (target.alias) lines.push(`  ${pad('alias', 10)}${target.alias}`);
  if (target.runId) lines.push(`  ${pad('run', 10)}${target.runId}`);
  if (!target.available) {
    lines.push(
      `  ${paint(out, 'red', 'the checkout directory is gone; the target is kept, not deleted')}`,
    );
  }
  if (target.staleDefinition) {
    lines.push(
      `  ${paint(out, 'yellow', 'running an old definition — restart to pick up the reloaded config')}`,
    );
  }
  if (target.commands && target.commands.length > 0) {
    lines.push('');
    lines.push(...renderCommands(out, target.commands));
  }
  return lines;
}

export function renderCommands(out: Out, commands: CommandState[]): string[] {
  const labelWidth =
    width(
      commands.map((c) => c.label),
      5,
    ) + 2;
  const statusWidth =
    width(
      commands.map((c) => c.status),
      6,
    ) + 2;

  const lines = [
    row([
      '  ',
      pad(paint(out, 'dim', 'LABEL'), labelWidth),
      pad(paint(out, 'dim', 'STATUS'), statusWidth),
      pad(paint(out, 'dim', 'PID'), 9),
      pad(paint(out, 'dim', 'RESTARTS'), 10),
      paint(out, 'dim', 'EXIT'),
    ]),
  ];
  for (const command of commands) {
    const exit = command.exitCode === undefined ? '-' : String(command.exitCode);
    const exitCell =
      command.exitCode !== undefined && command.exitCode !== 0
        ? paint(out, 'red', exit)
        : paint(out, 'dim', exit);
    lines.push(
      row([
        '  ',
        pad(command.label, labelWidth),
        pad(paint(out, COMMAND_COLOURS[command.status], command.status), statusWidth),
        pad(command.pid === undefined ? '-' : String(command.pid), 9),
        pad(String(command.restarts), 10),
        exitCell,
      ]),
    );
  }
  return lines;
}

export function renderRepos(out: Out, repos: RepoView[]): string[] {
  if (repos.length === 0) {
    return ['no repos registered — run `rmux repo add <path>`'];
  }
  const lines: string[] = [];
  for (const repo of repos) {
    if (lines.length > 0) lines.push('');
    lines.push(`${paint(out, 'bold', repo.name)}  ${paint(out, 'dim', repo.path)}`);

    const branchWidth =
      width(
        repo.checkouts.map((c) => c.branch),
        6,
      ) + 2;
    lines.push(`  ${paint(out, 'dim', 'checkouts')}`);
    for (const checkout of repo.checkouts) {
      const main = checkout.isMain ? paint(out, 'dim', ' (main)') : '';
      lines.push(
        `    ${pad(checkout.branch, branchWidth)}${paint(out, 'dim', checkout.path)}${main}`,
      );
    }

    lines.push(`  ${paint(out, 'dim', 'playbooks')}`);
    const nameWidth =
      width(
        repo.playbooks.map((p) => p.name),
        6,
      ) + 2;
    for (const playbook of repo.playbooks) {
      lines.push(
        `    ${pad(playbook.name, nameWidth)}${paint(out, 'dim', `(${playbook.source})`)}`,
      );
    }
    if (repo.playbooks.length === 0) lines.push(`    ${paint(out, 'dim', 'none')}`);

    for (const problem of repo.problems) {
      lines.push(`  ${paint(out, 'red', problem)}`);
    }
  }
  return lines;
}

/** `rmux env`: the provenance column is the reason this verb exists. */
export function renderEnv(out: Out, vars: EnvVarView[]): string[] {
  if (vars.length === 0) return ['no environment variables resolved'];
  const nameWidth =
    width(
      vars.map((v) => v.name),
      8,
    ) + 2;
  const sourceWidth =
    width(
      vars.map((v) => v.source),
      6,
    ) + 2;
  const lines = [
    row([
      pad(paint(out, 'dim', 'VARIABLE'), nameWidth),
      pad(paint(out, 'dim', 'SOURCE'), sourceWidth),
      paint(out, 'dim', 'VALUE'),
    ]),
  ];
  for (const entry of vars) {
    lines.push(
      row([
        pad(entry.name, nameWidth),
        pad(paint(out, entry.source === 'injected' ? 'cyan' : 'dim', entry.source), sourceWidth),
        entry.value,
      ]),
    );
  }
  return lines;
}

/** The command list only; the caller owns the heading, which carries the source. */
export function renderPlaybook(out: Out, playbook: Playbook): string[] {
  const lines: string[] = [];
  for (const command of playbook.commands) {
    const kind = command.type ?? 'service';
    const parts = [
      `  ${pad(command.label, 16)}`,
      pad(paint(out, 'dim', kind), 10),
      command.command,
    ];
    lines.push(row(parts));
    const notes: string[] = [];
    if (command.dependsOn?.length) notes.push(`dependsOn ${command.dependsOn.join(', ')}`);
    if (command.cwd) notes.push(`cwd ${command.cwd}`);
    if (command.envFile) notes.push(`envFile ${command.envFile}`);
    if (command.restart) notes.push(`restart ${command.restart}`);
    if (notes.length > 0) lines.push(`  ${' '.repeat(16)}${paint(out, 'dim', notes.join('  '))}`);
  }
  return lines;
}

const LABEL_COLOURS: Colour[] = ['cyan', 'green', 'yellow', 'blue', 'red'];

/** Stable per-label colour, so a label keeps its colour across runs. */
export function labelColour(label: string): Colour {
  let hash = 5381;
  for (let i = 0; i < label.length; i++) hash = ((hash << 5) + hash + label.charCodeAt(i)) | 0;
  return LABEL_COLOURS[Math.abs(hash) % LABEL_COLOURS.length];
}

/**
 * One `[label]` prefix per line of the chunk. The command's own bytes are copied
 * through verbatim: stripping or re-escaping its ANSI would corrupt the output
 * of anything that draws.
 */
export function renderLogEntry(out: Out, entry: LogEntry): string {
  const prefix = paint(out, labelColour(entry.label), `[${entry.label}]`);
  const pieces = entry.text.split('\n');
  if (pieces.length > 1 && pieces[pieces.length - 1] === '') pieces.pop();
  return pieces.map((line) => `${prefix} ${line}`).join('\n');
}
