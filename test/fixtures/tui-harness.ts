/**
 * Hosts the real OpenTUI renderer for `test/tui.test.ts`.
 *
 * It runs as a child process because the renderer needs `--experimental-ffi`
 * and vitest's own workers cannot be given the flag without editing the shared
 * vitest config. The child owns nothing but the renderer: every assertion still
 * happens in vitest, against the snapshots and frames replied over IPC.
 *
 * Input is injected as raw bytes on `renderer.stdin` — real SGR-1006 for the
 * mouse, real escape sequences for keys — so the renderer's own parser and
 * hit-tester run, not a test-only shortcut.
 */

import { connect, type IpcClient } from '../../src/ipc/index.js';
import { socketPath } from '../../src/paths.js';
import { App, type AppSnapshot } from '../../src/tui/app.js';
import { click, feed, move, wheel } from './sgr.js';

const { testRender } = await import('@opentui/react/test-utils');
const { createElement } = await import('react');

// `testRender` never wraps dispatch in act(), so React warns on every synthetic
// event. It would bury the harness's own output for no signal.
const realError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
  realError(...args);
};

export type HarnessCommand =
  | { id: number; op: 'snapshot' }
  | { id: number; op: 'frame' }
  | { id: number; op: 'click'; col: number; row: number; button?: number; mods?: number }
  | { id: number; op: 'wheel'; col: number; row: number; dir: 'up' | 'down'; n?: number }
  | { id: number; op: 'move'; col: number; row: number }
  | { id: number; op: 'keys'; keys: string[] }
  | { id: number; op: 'resize'; width: number; height: number }
  | { id: number; op: 'request'; method: string; params?: unknown }
  | { id: number; op: 'settle'; ms?: number }
  | { id: number; op: 'stop' };

export interface HarnessReply {
  id: number;
  ok: boolean;
  error?: string;
  frame?: string[];
  snapshot?: AppSnapshot;
  result?: unknown;
}

const WIDTH = Number(process.env.TUI_HARNESS_WIDTH ?? 120);
const HEIGHT = Number(process.env.TUI_HARNESS_HEIGHT ?? 30);
const COALESCE_MS = Number(process.env.TUI_HARNESS_COALESCE_MS ?? 80);
const POLL_MS = Number(process.env.TUI_HARNESS_POLL_MS ?? 250);
const RETAIN = Number(process.env.TUI_HARNESS_RETAIN ?? 50_000);

let latest: AppSnapshot | null = null;
let copied: string | null = null;
let exits = 0;

const client: IpcClient = await connect({ path: socketPath(), timeoutMs: 5000 });

const { renderer, flush, captureCharFrame, resize } = await testRender(
  createElement(App, {
    link: client,
    onExit: () => {
      exits += 1;
    },
    probe: {
      report: (snapshot) => {
        latest = snapshot;
      },
    },
    copy: (text: string) => {
      copied = text;
    },
    targetPollMs: POLL_MS,
    statusPollMs: POLL_MS,
    coalesceMs: COALESCE_MS,
    retain: RETAIN,
  }),
  { width: WIDTH, height: HEIGHT, targetFps: 60 },
);

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function snapshot(): AppSnapshot | undefined {
  if (latest === null) return undefined;
  return { ...latest, copied, exited: latest.exited || exits > 0 };
}

/**
 * Two real timer ticks around the flush, always. OpenTUI drains stdin on its own
 * schedule, so a flush issued in the same tick as the injected bytes renders the
 * frame *before* the input is parsed; the second pass then lets React commit the
 * state that the input produced. Without both, an assertion reads stale state.
 */
async function settle(ms = 0): Promise<void> {
  if (ms > 0) await delay(ms);
  await delay(2);
  await flush();
  await delay(2);
  await flush();
}

async function run(command: HarnessCommand): Promise<unknown> {
  switch (command.op) {
    case 'snapshot':
    case 'frame':
      await settle();
      return undefined;
    case 'click':
      click(renderer.stdin, command.col, command.row, command.button ?? 0, command.mods ?? 0);
      await settle();
      return undefined;
    case 'wheel':
      wheel(renderer.stdin, command.col, command.row, command.dir, command.n ?? 1);
      await settle();
      return undefined;
    case 'move':
      move(renderer.stdin, command.col, command.row);
      await settle();
      return undefined;
    case 'keys':
      for (const key of command.keys) {
        feed(renderer.stdin, key);
        await settle();
      }
      return undefined;
    case 'resize':
      resize(command.width, command.height);
      await settle();
      return undefined;
    case 'request': {
      const result = await client.request(command.method, command.params);
      await settle();
      return result;
    }
    case 'settle':
      await settle(command.ms ?? COALESCE_MS * 3);
      return undefined;
    case 'stop':
      renderer.destroy();
      await client.close().catch(() => {});
      setTimeout(() => process.exit(0), 10);
      return undefined;
  }
}

process.on('message', (raw: unknown) => {
  const command = raw as HarnessCommand;
  void (async () => {
    const reply: HarnessReply = { id: command.id, ok: true };
    try {
      reply.result = await run(command);
      reply.snapshot = snapshot();
      reply.frame = captureCharFrame().split('\n');
    } catch (error) {
      reply.ok = false;
      reply.error = error instanceof Error ? error.message : String(error);
    }
    process.send?.(reply);
  })();
});

await settle(COALESCE_MS * 3);
process.send?.({ id: 0, ok: true, snapshot: snapshot(), frame: captureCharFrame().split('\n') });
