import { describe, expect, it } from 'bun:test';

import { flagNumber, flagString, parseArgs, parseSince } from '../src/cli/args.js';
import { makeOut, pad, paint } from '../src/cli/output.js';

describe('parseArgs', () => {
  it('reads a bare verb', () => {
    expect(parseArgs(['ls']).command).toEqual(['ls']);
  });

  it('treats the TUI invocation as an empty command', () => {
    const args = parseArgs([]);
    expect(args.command).toEqual([]);
    expect(args.positionals).toEqual([]);
  });

  it('reads a nested verb', () => {
    const args = parseArgs(['repo', 'add', '~/projects/orders']);
    expect(args.command).toEqual(['repo', 'add']);
    expect(args.positionals).toEqual(['~/projects/orders']);
  });

  it('does not swallow a target as a subcommand for non-nested verbs', () => {
    const args = parseArgs(['start', 'orders/main:run-orders']);
    expect(args.command).toEqual(['start']);
    expect(args.positionals).toEqual(['orders/main:run-orders']);
  });

  it('reads flags with values', () => {
    const args = parseArgs(['logs', 'orders', '--label', 'API', '--tail', '200']);
    expect(args.positionals).toEqual(['orders']);
    expect(flagString(args, 'label')).toBe('API');
    expect(flagNumber(args, 'tail')).toBe(200);
  });

  it('reads --key=value form', () => {
    const args = parseArgs(['logs', '--since=5m']);
    expect(flagString(args, 'since')).toBe('5m');
  });

  it('treats known boolean flags as booleans even when a word follows', () => {
    const args = parseArgs(['logs', '--follow', 'orders']);
    expect(args.flags.follow).toBe(true);
    expect(args.positionals).toEqual(['orders']);
  });

  it('sets json from --json', () => {
    expect(parseArgs(['ls', '--json']).json).toBe(true);
    expect(parseArgs(['ls']).json).toBe(false);
  });

  it('passes everything after -- through as positionals', () => {
    const args = parseArgs(['start', 'orders', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['orders', '--not-a-flag']);
  });

  it('reads the single-command restart flag', () => {
    const args = parseArgs(['restart', 'orders/main', '--command', 'API']);
    expect(args.command).toEqual(['restart']);
    expect(flagString(args, 'command')).toBe('API');
  });
});

describe('parseSince', () => {
  const now = 1_700_000_000_000;

  it('reads relative durations', () => {
    expect(parseSince('5m', now)).toBe(now - 300_000);
    expect(parseSince('90s', now)).toBe(now - 90_000);
    expect(parseSince('2h', now)).toBe(now - 7_200_000);
    expect(parseSince('500ms', now)).toBe(now - 500);
    expect(parseSince('1d', now)).toBe(now - 86_400_000);
  });

  it('reads an absolute ISO timestamp', () => {
    expect(parseSince('2026-08-17T00:00:00.000Z', now)).toBe(Date.parse('2026-08-17T00:00:00Z'));
  });

  it('returns null for input it cannot understand', () => {
    expect(parseSince('yesterday', now)).toBeNull();
    expect(parseSince('5 minutes', now)).toBeNull();
    expect(parseSince('', now)).toBeNull();
  });
});

describe('output', () => {
  it('never colours under --json', () => {
    expect(makeOut(true).color).toBe(false);
  });

  it('leaves text unpainted when colour is off', () => {
    const out = makeOut(false, true);
    expect(paint(out, 'green', 'running')).toBe('running');
  });

  it('pads by visible width, ignoring ANSI bytes', () => {
    const colour = makeOut(false, false);
    colour.color = true;
    const painted = paint(colour, 'green', 'ok');
    expect(painted.length).toBeGreaterThan(2);
    expect(pad(painted, 6)).toHaveLength(painted.length + 4);
  });
});
