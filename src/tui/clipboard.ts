/**
 * `y` — the portable half of the selection story.
 *
 * Mouse reporting suppresses the terminal's own drag-select (Shift bypasses it
 * in Windows Terminal, conhost, Alacritty and WezTerm; iTerm2 uses Option), so
 * the TUI has to be able to hand over the buffer itself. OSC 52 goes through
 * the renderer, which knows whether the terminal advertised support; the host
 * tool is the fallback for the terminals that do not.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

export interface ClipboardSink {
  copyToClipboardOSC52(text: string): boolean;
}

export interface SelectionSource {
  getSelection(): { getSelectedText(): string } | null;
}

/**
 * What the user has highlighted, or null when that is nothing. A click with no
 * drag still leaves a selection object behind, so the emptiness test has to be
 * on the text rather than on `renderer.hasSelection`.
 */
export function selectedText(source: SelectionSource | undefined): string | null {
  let text: string;
  try {
    text = source?.getSelection()?.getSelectedText() ?? '';
  } catch {
    return null;
  }
  return text.trim() === '' ? null : text;
}

function hostCommand(): { command: string; args: string[] } | null {
  switch (platform()) {
    case 'win32':
      return { command: 'clip.exe', args: [] };
    case 'darwin':
      return { command: 'pbcopy', args: [] };
    default:
      return process.env.WAYLAND_DISPLAY
        ? { command: 'wl-copy', args: [] }
        : { command: 'xclip', args: ['-selection', 'clipboard'] };
  }
}

function viaHost(text: string): Promise<boolean> {
  const tool = hostCommand();
  if (tool === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(tool.command, tool.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => resolve(false));
    child.stdin.end(text);
  });
}

/**
 * OSC 52 first: it is the only path that reaches the clipboard of the machine
 * the *terminal* runs on, which is the one the user is actually looking at when
 * run-mux is on the far end of an ssh session.
 */
export async function copyToClipboard(text: string, sink?: ClipboardSink): Promise<boolean> {
  let viaTerminal = false;
  try {
    viaTerminal = sink?.copyToClipboardOSC52(text) === true;
  } catch {
    viaTerminal = false;
  }
  const viaTool = await viaHost(text);
  return viaTerminal || viaTool;
}
