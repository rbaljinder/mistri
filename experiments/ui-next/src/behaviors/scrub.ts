import { type ChangeDetails, createChange, definePrimitive } from '@ui-sdk/core';

/* One position out of several along a line, read by passing over it: the behavior under a chart's crosshair, a
   sparkline's readout and anything else where the reader points at a place and is told what is there. As a UI
   SDK primitive the position is a value with a change, so a page can hold it (two charts reading the same month)
   or leave it alone.

   The track is one stop in the Tab order and a slider to a screen reader, because that is what it is to a
   keyboard: arrows move along it, Home and End go to its ends, and what is at each position is its value's text,
   said as the position changes. Nothing is set by moving along it. Enter, Space or a press picks the position,
   for a page that opens something from it.

   A position is read while a pointer is over the track or the keyboard is on it, and none is when neither is.
   The last one read is kept, so the keyboard arrives where the reader left off. */

export type ScrubReason = 'scrub' | 'move-key' | 'focus-in' | 'focus-out' | 'escape-key';

export type ScrubOptions = {
  /* How many positions the track has. */
  count: number;
  value?: number | null;
  defaultValue?: number | null;
  onValueChange?: (value: number | null, details: ChangeDetails<ScrubReason>) => void;
  /* `band`: each position owns an equal stretch of the track (a column chart). `point`: the first and last
     positions are the track's two ends (a line drawn edge to edge). */
  scale?: 'band' | 'point';
  orientation?: 'horizontal' | 'vertical';
  /* What is at a position, in words: the slider's value text. */
  text?: (index: number) => string;
  /* A press, Enter or Space on a position. */
  onPick?: (index: number, event: Event) => void;
};

export const scrub = definePrimitive({
  name: 'scrub',
  options: {
    count: 'number',
    value: 'value',
    defaultValue: 'value',
    onValueChange: 'callback',
    scale: 'string',
    orientation: 'string',
    text: 'action',
    onPick: 'callback',
  },
  controlled: ['value'],
  state: (options: ScrubOptions) => ({
    value: (options.value ?? options.defaultValue ?? null) as number | null,
    last: 0,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const count = (): number => Math.max(context.options().count ?? 0, 0);
    const vertical = (): boolean => context.options().orientation === 'vertical';
    const set = (to: number | null, reason: ScrubReason, event?: Event): boolean => {
      const held = to === null || count() === 0 ? null : Math.min(Math.max(to, 0), count() - 1);
      if (held === context.store.get().value) return false;
      if (held !== null) context.store.set({ last: held });
      return change('value', held, { reason, event });
    };
    return {
      count,
      vertical,
      set,
      now: () => context.store.get(),
      text: (index: number): string | undefined => context.options().text?.(index),
      /* The position under a pointer. A share of the track's own box, so a zoomed page needs no correcting. */
      under(event: PointerEvent | MouseEvent, track: HTMLElement): number {
        const box = track.getBoundingClientRect();
        let share = vertical() ? (event.clientY - box.top) / (box.height || 1) : (event.clientX - box.left) / (box.width || 1);
        if (!vertical() && getComputedStyle(track).direction === 'rtl') share = 1 - share;
        share = Math.min(Math.max(share, 0), 1);
        const last = count() - 1;
        return context.options().scale === 'point' ? Math.round(share * last) : Math.min(last, Math.floor(share * count()));
      },
      pick(index: number | null, event: Event) {
        if (index !== null) context.options().onPick?.(index, event);
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, { at: number | null; last: number }>({
      state: (state) => ({ at: state.value, last: state.last }),
      attrs: (state) => ({ 'data-scrubbing': state.value === null ? undefined : '' }),
    }),
    track: slot<{}>({
      attrs: (state, part) => {
        const count = part.api.count();
        const at = Math.min(state.value ?? state.last, Math.max(count - 1, 0));
        return {
          role: 'slider',
          tabindex: count === 0 ? '-1' : '0',
          'aria-orientation': part.api.vertical() ? 'vertical' : 'horizontal',
          'aria-valuemin': '0',
          'aria-valuemax': String(Math.max(count - 1, 0)),
          'aria-valuenow': String(at),
          'aria-valuetext': count === 0 ? undefined : part.api.text(at),
          'data-at': state.value === null ? undefined : String(state.value),
        };
      },
      on: {
        pointermove: (event, { api, el }) => {
          if (el && api.count() > 0) api.set(api.under(event, el), 'scrub', event);
        },
        // A finger does not hover: the place it lands is read at once.
        pointerdown: (event, { api, el }) => {
          if (el && api.count() > 0) api.set(api.under(event, el), 'scrub', event);
        },
        pointerleave: (event, { api, el }) => {
          // The keyboard's reading outlasts a pointer that only passed over.
          if (!el?.matches(':focus-visible')) api.set(null, 'scrub', event);
        },
        focus: (event, { api, el }) => {
          const state = api.now();
          if (state.value === null && el?.matches(':focus-visible')) api.set(state.last, 'focus-in', event);
        },
        blur: (event, { api }) => {
          api.set(null, 'focus-out', event);
        },
        click: (event, { api, el }) => {
          if (el && api.count() > 0) api.pick(api.under(event, el), event);
        },
        keydown: (event, { api }) => {
          const state = api.now();
          const count = api.count();
          if (count === 0) return;
          const at = state.value ?? state.last;
          const back = api.vertical() ? 'ArrowUp' : 'ArrowLeft';
          const on = api.vertical() ? 'ArrowDown' : 'ArrowRight';
          const big = Math.max(1, Math.round(count / 6));
          const to =
            event.key === back
              ? at - 1
              : event.key === on
                ? at + 1
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? count - 1
                    : event.key === 'PageUp'
                      ? at - big
                      : event.key === 'PageDown'
                        ? at + big
                        : undefined;
          if (to !== undefined) {
            event.preventDefault();
            // A first arrow on a track nothing is read on reads the place the keyboard arrived at.
            api.set(state.value === null ? at : to, 'move-key', event);
          } else if (event.key === 'Escape' && state.value !== null) {
            event.preventDefault();
            api.set(null, 'escape-key', event);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            api.pick(at, event);
          }
        },
      },
    }),
  }),
});
