/**
 * Typed factories for OpenTUI's intrinsic renderables.
 *
 * The TUI is written without JSX on purpose: the repo's tsconfig has no `jsx`
 * setting, `test/tui.test.ts` has to be a plain `.ts` file to be picked up by
 * vitest's `test/**\/*.test.ts` glob, and a `.tsx` build would need root config
 * changes this milestone is not allowed to make. `createElement` with the same
 * prop types JSX would have checked costs nothing but a pair of parentheses.
 */

import type { BoxProps, ScrollBoxProps, TextProps } from '@opentui/react';
import { createElement, type ReactElement, type ReactNode } from 'react';

type Create = (tag: string, props: unknown, ...children: ReactNode[]) => ReactElement;

const create = createElement as unknown as Create;

function factory<P>(tag: string) {
  return (props: P, ...children: ReactNode[]): ReactElement => create(tag, props, ...children);
}

export const box = factory<BoxProps>('box');
export const text = factory<TextProps>('text');
export const scrollbox = factory<ScrollBoxProps>('scrollbox');
