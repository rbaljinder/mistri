/* How wide each of a set of columns is, as a UI SDK primitive: the widths are a value with a change, a bar at a
   column's far edge is dragged to set one, and the keyboard sets it from the column's own header (Alt with Left
   and Right, Alt with Backspace to give the width back), so the bars add no stops to the Tab order of a table
   that already has a header button a column. A width that was never set is the column's own: the value only
   holds what the reader changed, and taking a key out of it is how a column is given back.

   While a bar is dragged the width is a draft, so nothing is told until the pointer lifts, and Escape puts the
   column back. Every state is an attribute: `data-sized` on a column that has a width, `data-sizing` on the one
   being dragged and on the root. */
import { announce, bindDrag, type ChangeDetails, createChange, definePrimitive } from '@ui-sdk/core';
import { viewportBox } from '../internal/ruler.js';
import { zoomOf } from './dress.js';

/* The reasons are words of UI SDK's own vocabulary, which it holds a change's event to in development: a width
   given back is a `clear-press`, by a double-click or a key. */
/** Change reason emitted when a column width is dragged, stepped by keyboard, or reset. */
export type WidthsReason = 'drag' | 'move-key' | 'clear-press';

/** Configuration options for the `widths` column-sizing primitive. */
export type WidthsOptions = {
  /** The widths the reader has set, in CSS pixels, by column. */
  value?: Record<string, number>;
  defaultValue?: Record<string, number>;
  onValueChange?: (value: Record<string, number>, details: ChangeDetails<WidthsReason> & { key: string }) => void;
  /** The narrowest and widest a column may be made. */
  min?: number;
  max?: number;
  /** How far an arrow key moves an edge; Shift moves it five times as far. */
  step?: number;
  /** Screen-reader announcement formatter when a key sets a width or restores auto width (`undefined`). */
  formatWidth?: (label: string, width: number | undefined) => string;
  /** Accessible label for a column's resize handle. */
  resizeLabel?: (label: string) => string;
};

type Draft = { key: string; width: number };

/** Column-width drag and keyboard-resize UI SDK primitive. */
export const widths = definePrimitive({
  name: 'widths',
  options: {
    value: 'value',
    defaultValue: 'value',
    onValueChange: 'callback',
    min: 'number',
    max: 'number',
    step: 'number',
    formatWidth: 'action',
    resizeLabel: 'action',
  },
  controlled: ['value'],
  state: (options: WidthsOptions) => ({
    value: options.value ?? options.defaultValue ?? {},
    sizing: null as Draft | null,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const said = (label: string, width: number | undefined): string => {
      const opts = context.options() as WidthsOptions & { say?: (label: string, width: number | undefined) => string };
      return (
        opts.formatWidth?.(label, width) ??
        opts.say?.(label, width) ??
        (width === undefined ? `${label}, its own width` : `${label}, ${width} pixels wide`)
      );
    };
    const min = (): number => context.options().min ?? 64;
    const max = (): number => context.options().max ?? 640;
    const held = (width: number): number => Math.round(Math.min(Math.max(width, min()), max()));
    /* The width a column has now: the draft's while its bar is dragged, else what the reader set, else none. */
    const of = (state: { value: Record<string, number>; sizing: Draft | null }, key: string): number | undefined =>
      state.sizing?.key === key ? state.sizing.width : state.value[key];
    const set = (key: string, width: number | undefined, reason: WidthsReason, event?: Event): boolean => {
      const next = { ...context.store.get().value };
      const to = width === undefined ? undefined : held(width);
      // An edge already at its limit, or a column with nothing to give back: nothing changed, so nothing is told.
      if (next[key] === to) return false;
      if (to === undefined) delete next[key];
      else next[key] = to;
      return change('value', next, { reason, event, key });
    };
    let stop: (() => void) | undefined;
    context.onDestroy(() => stop?.());
    return {
      of,
      min,
      max,
      handleLabel: (label: string): string => context.options().resizeLabel?.(label) ?? `Resize ${label}`,
      /* Follows the pointer that pressed a bar. The column is measured as it stands, so a column that was never
         sized starts from the width its words gave it. */
      drag(event: PointerEvent, bar: HTMLElement, key: string, column: HTMLElement) {
        if (event.button !== 0) return;
        event.preventDefault();
        // Under a zoomed page a width is in the stylesheet's pixels and the pointer moves in the screen's.
        const zoom = zoomOf(column);
        const from = viewportBox(column).width;
        const start = event.clientX;
        const towardEnd = getComputedStyle(column).direction === 'rtl' ? -1 : 1;
        stop?.();
        stop = bindDrag(bar, event, {
          cancelOnEscape: true,
          onMove: ({ x }) => context.store.set({ sizing: { key, width: held(from + ((x - start) / zoom) * towardEnd) } }),
          onEnd: (up, canceled) => {
            const draft = context.store.get().sizing;
            context.store.set({ sizing: null });
            stop = undefined;
            if (!canceled && draft && draft.width !== Math.round(from)) set(key, draft.width, 'drag', up);
          },
        });
      },
      /* The keyboard's way, from the column's header. Returns whether the key was one of its own. */
      keydown(event: KeyboardEvent, key: string, column: HTMLElement, label: string): boolean {
        if (!event.altKey) return false;
        const step = (context.options().step ?? 16) * (event.shiftKey ? 5 : 1);
        const now = of(context.store.get(), key) ?? viewportBox(column).width;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const next = held(now + (event.key === 'ArrowRight' ? step : -step));
          if (set(key, next, 'move-key', event)) announce(said(label, next));
          return true;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          event.preventDefault();
          if (set(key, undefined, 'clear-press', event)) announce(said(label, undefined));
          return true;
        }
        return false;
      },
      /* Direct keyboard interaction when focus is on the resize handle itself. */
      handleKeydown(event: KeyboardEvent, key: string, handleEl: HTMLElement, label: string): boolean {
        const column = handleEl.closest<HTMLElement>('[data-slot="widths-column"]') ?? handleEl;
        const step = (context.options().step ?? 16) * (event.shiftKey ? 5 : 1);
        const now = of(context.store.get(), key) ?? viewportBox(column).width;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          const next = held(now + (event.key === 'ArrowRight' ? step : -step));
          if (set(key, next, 'move-key', event)) announce(said(label, next));
          return true;
        }
        if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Home') {
          event.preventDefault();
          event.stopPropagation();
          if (set(key, undefined, 'clear-press', event)) announce(said(label, undefined));
          return true;
        }
        return false;
      },
      reset: (key: string, event?: Event) => set(key, undefined, 'clear-press', event),
    };
  },
  slots: (slot) => ({
    root: slot<{}, { widths: Record<string, number>; sizing: string | null }>({
      state: (state) => ({
        widths: state.sizing ? { ...state.value, [state.sizing.key]: state.sizing.width } : state.value,
        sizing: state.sizing?.key ?? null,
      }),
      attrs: (state) => ({ 'data-sizing': state.sizing ? '' : undefined }),
    }),
    /* The column itself: a table's header cell. It wears its width, and hears the keyboard for it. */
    column: slot<{ value: string; label?: string }>({
      props: { value: 'string', label: 'string' },
      attrs: (state, part) => {
        const width = part.api.of(state, part.key);
        return {
          'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight Alt+Backspace',
          'data-sized': width === undefined ? undefined : '',
          'data-sizing': state.sizing?.key === part.key ? '' : undefined,
          style: width === undefined ? undefined : `width:${width}px;min-width:${width}px;max-width:${width}px`,
        };
      },
      on: {
        keydown: (event, { api, key, el, props }) => {
          if (event.defaultPrevented) return;
          if (el) api.keydown(event, key, el, props.label ?? key);
        },
      },
    }),
    /* The bar at the column's far edge: focusable separator for pointer and keyboard resize. */
    handle: slot<{ value?: string; label?: string }>({
      props: { value: { kind: 'string', from: 'column', required: true }, label: { kind: 'string', from: 'column' } },
      attrs: (state, part) => {
        const width = part.api.of(state, part.key);
        return {
          role: 'separator',
          tabindex: '0',
          'aria-orientation': 'vertical',
          'aria-label': part.api.handleLabel(part.props.label ?? part.key),
          'aria-keyshortcuts': 'ArrowLeft ArrowRight Alt+ArrowLeft Alt+ArrowRight Backspace',
          'aria-valuemin': String(part.api.min()),
          'aria-valuemax': String(part.api.max()),
          'aria-valuenow': width !== undefined ? String(width) : undefined,
          'data-sizing': state.sizing?.key === part.key ? '' : undefined,
        };
      },
      on: {
        keydown: (event, { api, key, el, props }) => {
          if (el) api.handleKeydown(event, key, el, props.label ?? key);
        },
        pointerdown: (event, { api, key, el }) => {
          const column = el?.closest<HTMLElement>('[data-slot="widths-column"]');
          if (el && column) api.drag(event, el, key, column);
          event.stopPropagation();
        },
        dblclick: (event, { api, key }) => {
          api.reset(key, event);
          event.stopPropagation();
        },
        // A press on the bar is not a press on the header under it (which would sort the column).
        click: (event) => event.stopPropagation(),
      },
    }),
  }),
});
