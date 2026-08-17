/**
 * The command's own SGR colours, translated into the renderer's styled chunks.
 *
 * A cell renderer cannot be handed raw escape bytes — they would be drawn as
 * glyphs — so "passing the ANSI through untouched" means honouring every SGR
 * parameter rather than dropping it or re-emitting it. Nothing here rewrites a
 * colour: 31 stays red, a 24-bit triple stays that exact triple, and text
 * carrying no SGR at all is emitted as one unstyled chunk.
 *
 * Non-SGR sequences (cursor movement, erase, OSC) are discarded: their effect
 * belongs to a scrolling terminal, not to one line in a virtualized list, and
 * leaving the bytes in would corrupt the frame.
 */

import { parseColor, TextAttributes, type RGBA, type TextChunk } from '@opentui/core';

const ESC = '\u001b';

const ESCAPE_SEQUENCE =
  // oxlint-disable-next-line no-control-regex -- matching control bytes is the whole job
  /\u001b(?:\[[\d;:?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

const BASIC = [
  '#3b4252',
  '#bf616a',
  '#a3be8c',
  '#ebcb8b',
  '#81a1c1',
  '#b48ead',
  '#88c0d0',
  '#e5e9f0',
] as const;

const BRIGHT = [
  '#4c566a',
  '#d08770',
  '#b9d18c',
  '#f0d399',
  '#88a9d4',
  '#c49bc0',
  '#9fd3dd',
  '#eceff4',
] as const;

interface Style {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

function blank(fg?: string): Style {
  return {
    fg,
    bg: undefined,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    blink: false,
    inverse: false,
    strikethrough: false,
  };
}

function attributes(style: Style): number {
  let bits = TextAttributes.NONE;
  if (style.bold) bits |= TextAttributes.BOLD;
  if (style.dim) bits |= TextAttributes.DIM;
  if (style.italic) bits |= TextAttributes.ITALIC;
  if (style.underline) bits |= TextAttributes.UNDERLINE;
  if (style.blink) bits |= TextAttributes.BLINK;
  if (style.inverse) bits |= TextAttributes.INVERSE;
  if (style.strikethrough) bits |= TextAttributes.STRIKETHROUGH;
  return bits;
}

function byte(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

function hex(r: number, g: number, b: number): string {
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** xterm's 256-colour cube and greyscale ramp, so `38;5;n` lands on the right shade. */
function indexed(n: number): string {
  if (n < 8) return BASIC[n]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n < 232) {
    const c = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return hex(steps[Math.floor(c / 36)]!, steps[Math.floor(c / 6) % 6]!, steps[c % 6]!);
  }
  const level = 8 + (n - 232) * 10;
  return hex(level, level, level);
}

/** Consumes an extended-colour selector (`38;5;n` or `38;2;r;g;b`) from `codes`. */
function extended(codes: number[], at: number): { colour?: string; next: number } {
  const mode = codes[at + 1];
  if (mode === 5) {
    const value = codes[at + 2];
    return { colour: value === undefined ? undefined : indexed(value), next: at + 3 };
  }
  if (mode === 2) {
    const r = codes[at + 2];
    const g = codes[at + 3];
    const b = codes[at + 4];
    if (r === undefined || g === undefined || b === undefined) return { next: at + 5 };
    return { colour: hex(r, g, b), next: at + 5 };
  }
  return { next: at + 1 };
}

function apply(style: Style, codes: number[], defaultFg?: string): Style {
  let next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) next = blank(defaultFg);
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 5 || code === 6) next.blink = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strikethrough = true;
    else if (code === 21 || code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 25) next.blink = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strikethrough = false;
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30];
    else if (code === 38) {
      const picked = extended(codes, i);
      if (picked.colour) next.fg = picked.colour;
      i = picked.next - 1;
    } else if (code === 39) next.fg = defaultFg;
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40];
    else if (code === 48) {
      const picked = extended(codes, i);
      if (picked.colour) next.bg = picked.colour;
      i = picked.next - 1;
    } else if (code === 49) next.bg = undefined;
    else if (code >= 90 && code <= 97) next.fg = BRIGHT[code - 90];
    else if (code >= 100 && code <= 107) next.bg = BRIGHT[code - 100];
  }
  return next;
}

function chunkOf(text: string, style: Style): TextChunk {
  const bits = attributes(style);
  return {
    __isChunk: true,
    text,
    fg: style.fg === undefined ? undefined : (parseColor(style.fg) as RGBA),
    bg: style.bg === undefined ? undefined : (parseColor(style.bg) as RGBA),
    attributes: bits === TextAttributes.NONE ? undefined : bits,
  };
}

export function ansiToChunks(source: string, defaultFg?: string): TextChunk[] {
  if (isPlain(source)) return [chunkOf(source, blank(defaultFg))];

  const chunks: TextChunk[] = [];
  let style = blank(defaultFg);
  let cursor = 0;
  ESCAPE_SEQUENCE.lastIndex = 0;
  for (
    let match = ESCAPE_SEQUENCE.exec(source);
    match !== null;
    match = ESCAPE_SEQUENCE.exec(source)
  ) {
    if (match.index > cursor) chunks.push(chunkOf(source.slice(cursor, match.index), style));
    cursor = match.index + match[0].length;
    const sequence = match[0];
    if (!sequence.startsWith(`${ESC}[`) || !sequence.endsWith('m')) continue;
    const body = sequence.slice(2, -1);
    // A bare `ESC[m` means `ESC[0m`; `:` separates sub-parameters in the ITU form.
    const codes =
      body === ''
        ? [0]
        : body.split(';').map((part) => Number.parseInt(part.split(':')[0] ?? '', 10) || 0);
    style = apply(style, codes, defaultFg);
  }
  if (cursor < source.length) chunks.push(chunkOf(source.slice(cursor), style));
  return chunks.length > 0 ? chunks : [chunkOf('', style)];
}

/** True when the text carries no escape sequence at all, so it needs no chunking. */
function isPlain(source: string): boolean {
  return !source.includes(ESC);
}

/** What `y` puts on the clipboard: the text a user would have selected by hand. */
export function stripAnsi(source: string): string {
  if (isPlain(source)) return source;
  return source.replaceAll(ESCAPE_SEQUENCE, '');
}
