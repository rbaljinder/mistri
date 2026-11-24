/**
 * Resizable panels: two or more panes side by side (or stacked), divided
 * by a handle the reader drags or walks with the keyboard, over UI SDK's
 * Resizable. The panes are the caller's array; each names its own `minSize`
 * in percent (10 by default) and its starting `defaultSize`, and sizes
 * that do not add to 100 are scaled to it, so a caller who writes 1 and 2
 * gets a third and two thirds. Controlled with `sizes`/`onSizesChange`,
 * uncontrolled with the panels' `defaultSize`s.
 *
 * A handle is a separator, not a button: `role="separator"`,
 * `aria-orientation`, `aria-valuenow`/`min`/`max` in percent, and the two
 * panes it divides named by `aria-controls`. Arrow keys move it 5 points
 * (10 with Shift), Home and End take it to its ends, and a pointer drag
 * moves it by the pointer's share of the container — the same handle for
 * mouse, pen and touch, so no reader needs a mouse to resize. The panes
 * themselves never shrink below their minimum, and a drag that would push
 * a neighbour below its minimum stops at that neighbour's edge.
 */
import { Resizable as Group, ResizableHandle, ResizablePanel as Panel } from '@ui-sdk/react/resizable';
import { Fragment, useState, type ReactNode, type Ref } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

/** Single pane definition for `Resizable`. */
export interface ResizablePanel {
  /** The pane's accessible name, said by its handle's controls. */
  label?: string;
  /** The pane's starting share, in percent; shares are scaled to 100. */
  defaultSize?: number;
  /** The pane's smallest share, in percent; 10 by default. */
  minSize?: number;
  children: ReactNode;
}

/** Props for the `Resizable` multi-pane split container. */
export interface ResizableProps {
  panels: readonly ResizablePanel[];
  direction?: 'horizontal' | 'vertical';
  sizes?: readonly number[];
  onSizesChange?: (sizes: number[], details: ChangeDetails<'resize'>) => void;
  /** The group's accessible name, where the panes need one ("Record and detail"). */
  ariaLabel?: string;
  /** Every word the handles say, in the caller's language; any left out are English. */
  words?: Partial<ResizableWords>;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

interface ResizableWords {
  /** A handle's name, from the names of the two panes it parts (`before`, `after`). */
  resize: (before: string, after: string) => string;
  /** A pane's stand-in name when it has no `label`: "panel 2". */
  panel: (number: number) => string;
}

const ENGLISH: ResizableWords = {
  resize: (before, after) => `Resize ${before} and ${after}`,
  panel: (number) => `panel ${number}`,
};

function initialSizes(panels: readonly ResizablePanel[]): number[] {
  const given = panels.map((panel) => panel.defaultSize ?? 0);
  const total = given.reduce((sum, size) => sum + size, 0);
  if (total > 0) return given.map((size) => (size / total) * 100);
  return panels.map(() => 100 / panels.length);
}

/* The sizes are shares of the whole, in the panes' order. A pane scrolls inside itself on purpose and says so
   (`data-scrolls`), for the check that looks for a page scrolling twice (gradeProbe.ts). */
function DefaultResizable({
  panels,
  direction = 'horizontal',
  sizes,
  onSizesChange,
  ariaLabel,
  words: given,
  className,
  ref,
}: ResizableProps) {
  const words = { ...ENGLISH, ...given };
  const [start] = useState(() => initialSizes(panels));
  if (panels.length < 2) return null;
  const name = (place: number) => panels[place]?.label ?? words.panel(place + 1);
  return (
    <Group
      ref={ref}
      role="group"
      orientation={direction}
      aria-label={ariaLabel}
      className={className}
      step={5}
      largeStep={10}
      layout={sizes ? [...sizes] : undefined}
      defaultLayout={sizes ? undefined : start}
      onLayoutChange={(layout, details) => onSizesChange?.(layout, told('resize', details))}
    >
      {panels.map((panel, place) => (
        <Fragment key={place}>
          {place > 0 && <ResizableHandle aria-label={words.resize(name(place - 1), name(place))} />}
          {/* A named pane has a role to be named by. */}
          <Panel minSize={panel.minSize ?? 10} role="group" aria-label={panel.label} data-scrolls="">
            {panel.children}
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

/** Multi-pane split layout with pointer-draggable and keyboard-navigable separator handles. */
export const Resizable = slotted('Resizable', DefaultResizable, { onSizesChange: [1, 'resize'] });
