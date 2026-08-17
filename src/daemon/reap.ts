/**
 * Orphan cleanup. A daemon that died without running its shutdown code leaves
 * its children behind, and the `ChildRecord`s in state are the only trail back
 * to them.
 *
 * A pid alone is not enough to act on: the OS hands pids out again, so by the
 * time we read the record the number may belong to something else entirely.
 * Every kill is therefore gated on the recorded spawn time matching the
 * process's real creation time as the OS reports it. A process we cannot get a
 * creation time for is left alone — an orphan that survives is a nuisance, but
 * killing a stranger's process is not.
 *
 * Runs once, at boot, so the cost of asking the OS is irrelevant.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { clearChildren, listChildren } from '../state/index.js';
import type { ChildRecord } from '../types.js';

const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === 'win32';

/**
 * How far the recorded spawn time may sit from the OS creation time. Our stamp
 * is taken just before `spawn` returns, so the real creation is a few
 * milliseconds later; `ps -o lstart=` only resolves to the second, which is what
 * sets the floor here.
 */
export const CREATION_TOLERANCE_MS = 2000;

const PROBE_TIMEOUT_MS = 15_000;
const DEATH_TIMEOUT_MS = 5000;
const DEATH_POLL_MS = 25;
/** Linux reports process start in clock ticks; 100Hz is the universal default. */
const CLOCK_TICKS_PER_SECOND = 100;

export type SkipReason = 'gone' | 'mismatch' | 'unknown' | 'invalid';

export interface ReapResult {
  killed: ChildRecord[];
  skipped: { record: ChildRecord; reason: SkipReason }[];
}

export interface ReapOptions {
  /** Test seam. */
  toleranceMs?: number;
  onNote?: (message: string) => void;
}

/**
 * Kills every child a previous daemon left running, then clears the records.
 * Never re-adopts: we cannot attach to a surviving process's stdout, so it would
 * run with a permanent hole in its logs.
 */
export async function reapOrphans(options: ReapOptions = {}): Promise<ReapResult> {
  const tolerance = options.toleranceMs ?? CREATION_TOLERANCE_MS;
  const result: ReapResult = { killed: [], skipped: [] };
  const records = listChildren();
  if (records.length === 0) return result;

  const candidates: ChildRecord[] = [];
  for (const record of records) {
    if (!Number.isInteger(record.pid) || record.pid <= 0 || record.pid === process.pid) {
      result.skipped.push({ record, reason: 'invalid' });
      continue;
    }
    if (!isAlive(record.pid)) {
      result.skipped.push({ record, reason: 'gone' });
      continue;
    }
    candidates.push(record);
  }

  if (candidates.length > 0) {
    const created = await creationTimes([...new Set(candidates.map((c) => c.pid))]);
    const doomed: ChildRecord[] = [];
    for (const record of candidates) {
      const actual = created.get(record.pid);
      if (actual === undefined) {
        options.onNote?.(
          `pid ${record.pid} (${record.label}) is alive but its creation time is unknown; leaving it alone`,
        );
        result.skipped.push({ record, reason: 'unknown' });
        continue;
      }
      if (Math.abs(actual - record.startedAt) > tolerance) {
        options.onNote?.(
          `pid ${record.pid} was reused: created ${new Date(actual).toISOString()}, recorded ${new Date(record.startedAt).toISOString()}; leaving it alone`,
        );
        result.skipped.push({ record, reason: 'mismatch' });
        continue;
      }
      doomed.push(record);
    }

    if (doomed.length > 0) {
      await Promise.all(doomed.map((record) => killPidTree(record.pid)));
      await waitForDeath(doomed.map((record) => record.pid));
      result.killed.push(...doomed);
    }
  }

  clearChildren();
  return result;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Epoch ms the OS says each process was created, for the pids it can answer for. */
export async function creationTimes(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  return IS_WINDOWS ? windowsCreationTimes(pids) : posixCreationTimes(pids);
}

/**
 * One CIM query for every pid at once — a PowerShell start costs far more than
 * the query. The script deliberately contains no double quotes, so it survives
 * being handed to `powershell.exe` as a single argument unchanged.
 */
async function windowsCreationTimes(pids: number[]): Promise<Map<number, number>> {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' or ');
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    `ForEach-Object { $_.ProcessId.ToString() + ' ' + $_.CreationDate.ToUniversalTime().ToString('o') }`;

  const times = new Map<number, number>();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    ));
  } catch {
    return times;
  }

  for (const line of stdout.split(/\r?\n/)) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const pid = Number.parseInt(line.slice(0, space), 10);
    const ms = Date.parse(line.slice(space + 1).trim());
    if (Number.isInteger(pid) && Number.isFinite(ms)) times.set(pid, ms);
  }
  return times;
}

async function posixCreationTimes(pids: number[]): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  const boot = await bootTimeMs();
  for (const pid of pids) {
    const fromProc = boot === null ? null : await procStartTime(pid, boot);
    const ms = fromProc ?? (await psStartTime(pid));
    if (ms !== null) times.set(pid, ms);
  }
  return times;
}

/** `/proc/stat`'s `btime` is the boot time in epoch seconds. Linux only. */
async function bootTimeMs(): Promise<number | null> {
  try {
    const text = await readFile('/proc/stat', 'utf-8');
    const match = /^btime\s+(\d+)/m.exec(text);
    return match ? Number(match[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Field 22 of `/proc/<pid>/stat` is the start time in clock ticks since boot.
 * The comm field can contain spaces and parentheses, so the fields are counted
 * from after its closing paren rather than by splitting the whole line.
 */
async function procStartTime(pid: number, bootMs: number): Promise<number | null> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf-8');
    const close = text.lastIndexOf(')');
    if (close === -1) return null;
    const fields = text
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const ticks = Number(fields[19]);
    if (!Number.isFinite(ticks)) return null;
    return bootMs + (ticks / CLOCK_TICKS_PER_SECOND) * 1000;
  } catch {
    return null;
  }
}

/** Portable fallback: `ps -o lstart=` prints an absolute start time, to the second. */
async function psStartTime(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: PROBE_TIMEOUT_MS,
    });
    const ms = Date.parse(stdout.trim());
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Force from the start: this is a process whose parent is already dead, so there
 * is nobody left to ask it politely on behalf of.
 */
async function killPidTree(pid: number): Promise<void> {
  if (IS_WINDOWS) {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      /* already gone, or taskkill is unavailable */
    }
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* no such group or process */
    }
  }
}

async function waitForDeath(pids: number[]): Promise<void> {
  const deadline = Date.now() + DEATH_TIMEOUT_MS;
  while (pids.some(isAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DEATH_POLL_MS));
  }
}
