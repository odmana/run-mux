// Raw SGR (1006) mouse sequence injection.
//
// Deliberately NOT @opentui/core/testing's createMockMouse: these are the exact bytes a terminal
// emits, written onto the renderer's stdin, so the renderer's own parser and hit-tester run rather
// than a test-only shortcut. That distinction is what makes the mouse tests meaningful — it is how
// the M0 spike proved OpenTUI does not have Ink's coordinate-offset bug. col/row are 1-based, as a
// terminal reports them.

export const BTN = {
  LEFT: 0,
  MIDDLE: 1,
  RIGHT: 2,
  WHEEL_UP: 64,
  WHEEL_DOWN: 65,
} as const;

export const MOD = { SHIFT: 4, ALT: 8, CTRL: 16 } as const;

export function sgr(button: number, col: number, row: number, press: boolean): string {
  return `\x1b[<${button};${col};${row}${press ? 'M' : 'm'}`;
}

interface StdinLike {
  emit(event: string, chunk: Buffer): boolean;
}

export function feed(stdin: StdinLike, seq: string): void {
  stdin.emit('data', Buffer.from(seq, 'ascii'));
}

export function click(
  stdin: StdinLike,
  col: number,
  row: number,
  button: number = BTN.LEFT,
  mods = 0,
) {
  feed(stdin, sgr(button | mods, col, row, true));
  feed(stdin, sgr(button | mods, col, row, false));
}

export function wheel(stdin: StdinLike, col: number, row: number, dir: 'up' | 'down', n = 1) {
  for (let i = 0; i < n; i++) {
    feed(stdin, sgr(dir === 'up' ? BTN.WHEEL_UP : BTN.WHEEL_DOWN, col, row, true));
  }
}

export function move(stdin: StdinLike, col: number, row: number) {
  feed(stdin, sgr(35, col, row, true));
}

/** Motion bit. A held button reports as `button | MOTION`, which is what makes it a drag. */
const MOTION = 32;

/**
 * Press, several motion reports, release — the intermediate frames matter,
 * because OpenTUI decides what a drag has captured on the first one.
 */
export function drag(
  stdin: StdinLike,
  from: [col: number, row: number],
  to: [col: number, row: number],
  button: number = BTN.LEFT,
  steps = 4,
) {
  const [fromCol, fromRow] = from;
  const [toCol, toRow] = to;
  feed(stdin, sgr(button, fromCol, fromRow, true));
  for (let step = 1; step <= steps; step++) {
    const col = Math.round(fromCol + ((toCol - fromCol) * step) / steps);
    const row = Math.round(fromRow + ((toRow - fromRow) * step) / steps);
    feed(stdin, sgr(button | MOTION, col, row, true));
  }
  feed(stdin, sgr(button, toCol, toRow, false));
}
