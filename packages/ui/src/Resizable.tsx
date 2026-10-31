/**
 * Resizable panels: two or more panes side by side (or stacked), divided
 * by a handle the reader drags or walks with the keyboard. Plain React —
 * Base UI has no resizable, and a flex row with a draggable divider is all
 * one is. The panes are the caller's array; each names its own `minSize`
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
import { Fragment, useId, useRef, useState, type ReactNode } from 'react';

export interface ResizablePanel {
  /** The pane's accessible name, said by its handle's controls. */
  label?: string;
  /** The pane's starting share, in percent; shares are scaled to 100. */
  defaultSize?: number;
  /** The pane's smallest share, in percent; 10 by default. */
  minSize?: number;
  children: ReactNode;
}

export interface ResizableProps {
  panels: readonly ResizablePanel[];
  direction?: 'horizontal' | 'vertical';
  sizes?: readonly number[];
  onSizesChange?: (sizes: number[]) => void;
  /** The group's accessible name, where the panes need one ("Record and detail"). */
  label?: string;
  className?: string;
}

function initialSizes(panels: readonly ResizablePanel[]): number[] {
  const given = panels.map((panel) => panel.defaultSize ?? 0);
  const total = given.reduce((sum, size) => sum + size, 0);
  if (total > 0) return given.map((size) => (size / total) * 100);
  return panels.map(() => 100 / panels.length);
}

function clampSizes(panels: readonly ResizablePanel[], sizes: readonly number[]): number[] {
  const mins = panels.map((panel) => panel.minSize ?? 10);
  const clamped = sizes.map((size, i) =>
    Math.min(Math.max(size, mins[i]!), 100 - mins.reduce((sum, min, j) => (j === i ? sum : sum + min), 0)),
  );
  const total = clamped.reduce((sum, size) => sum + size, 0);
  return total ? clamped.map((size) => (size / total) * 100) : clamped;
}

export function ResizablePanels({ panels, direction = 'horizontal', sizes, onSizesChange, label, className }: ResizableProps) {
  const [uncontrolled, setUncontrolled] = useState(() => initialSizes(panels));
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ handle: number; start: number; sizes: number[] } | null>(null);
  const baseId = useId();
  if (panels.length < 2) return null;
  const current = clampSizes(panels, sizes ?? uncontrolled);
  const mins = panels.map((panel) => panel.minSize ?? 10);
  const setSizes = (next: number[]) => {
    const clamped = clampSizes(panels, next);
    if (sizes === undefined) setUncontrolled(clamped);
    onSizesChange?.(clamped);
  };
  /** Move handle `i` so pane `i` grows by `delta` points and pane `i + 1` shrinks by the same. */
  const move = (i: number, delta: number) => {
    const next = [...current];
    const low = mins[i]! - current[i]!;
    const high = current[i + 1]! - mins[i + 1]!;
    const applied = Math.min(Math.max(delta, low), high);
    next[i] = current[i]! + applied;
    next[i + 1] = current[i + 1]! - applied;
    setSizes(next);
  };
  const onHandleKeyDown = (i: number) => (event: React.KeyboardEvent) => {
    const horizontal = direction === 'horizontal';
    const step = event.shiftKey ? 10 : 5;
    if (event.key === (horizontal ? 'ArrowRight' : 'ArrowDown')) {
      event.preventDefault();
      move(i, step);
    } else if (event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')) {
      event.preventDefault();
      move(i, -step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      move(i, -(current[i]! - mins[i]!));
    } else if (event.key === 'End') {
      event.preventDefault();
      move(i, current[i + 1]! - mins[i + 1]!);
    }
  };
  const onPointerDown = (i: number) => (event: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const horizontal = direction === 'horizontal';
    const pos = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const span = horizontal ? rect.width : rect.height;
    dragRef.current = { handle: i, start: span ? (pos / span) * 100 : 0, sizes: current };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container) return;
    const rect = container.getBoundingClientRect();
    const horizontal = direction === 'horizontal';
    const pos = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const span = horizontal ? rect.width : rect.height;
    if (!span) return;
    const delta = (pos / span) * 100 - drag.start;
    const next = [...drag.sizes];
    const low = mins[drag.handle]! - drag.sizes[drag.handle]!;
    const high = drag.sizes[drag.handle + 1]! - mins[drag.handle + 1]!;
    const applied = Math.min(Math.max(delta, low), high);
    next[drag.handle] = drag.sizes[drag.handle]! + applied;
    next[drag.handle + 1] = drag.sizes[drag.handle + 1]! - applied;
    setSizes(next);
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };
  return (
    <div
      ref={containerRef}
      className={['ui-resizable', direction === 'vertical' ? 'ui-resizable-vertical' : 'ui-resizable-horizontal', className]
        .filter(Boolean)
        .join(' ')}
      role="group"
      aria-label={label}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {panels.map((panel, i) => (
        /* A fragment, not a wrapper: the flex row's children must be the
           panes and their handles, or the handles never sit between them. */
        <Fragment key={i}>
          {/* Grow shares, not basis percents: basis percents add to 100%
              before the handles' fixed widths, so every extra pane
              overflowed sideways by one handle width. With basis zero the
              handles take their width first and the free space splits by
              share, so panes plus handles always fit the container. */}
          {/* A pane scrolls inside itself (overflow: auto) on purpose, and says so, so the double-scroll probe
              (gradeProbe.ts) does not take it for a page that scrolls twice. A name needs a role to be spoken. */}
          <div
            id={`${baseId}-panel-${i}`}
            className="ui-resizable-panel"
            style={{ flex: `${current[i]} 1 0` }}
            role="group"
            aria-label={panel.label}
            data-scrolls=""
          >
            {panel.children}
          </div>
          {i < panels.length - 1 ? (
            <div
              className="ui-resizable-handle"
              role="separator"
              /* The separator's orientation is the line's, not the layout's: panes side by side ('horizontal') are
                 parted by a vertical line, and stacked panes by a horizontal one. */
              aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
              aria-valuenow={Math.round(current[i]!)}
              aria-valuemin={mins[i]}
              aria-valuemax={100 - mins[i + 1]!}
              aria-controls={`${baseId}-panel-${i} ${baseId}-panel-${i + 1}`}
              aria-label={`Resize ${panels[i]?.label ?? `panel ${i + 1}`} and ${panels[i + 1]?.label ?? `panel ${i + 2}`}`}
              tabIndex={0}
              onKeyDown={onHandleKeyDown(i)}
              onPointerDown={onPointerDown(i)}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

/** The short name, as the other primitives export theirs. */
export const Resizable = ResizablePanels;
