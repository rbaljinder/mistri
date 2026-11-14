import {
  announce,
  type ChangeDetails,
  createChange,
  createSpans,
  definePrimitive,
  type Span,
  type SpanAction,
  type SpansReason,
  stackSpans,
} from '@ui-sdk/core';

/* Stretches of something along a line, each on a track of its own or sharing one: the bars of a Gantt chart,
   the visits of a day by the hour. As a UI SDK primitive over the spans `@ui-sdk/core` ships, the stretches are
   a value with a change, a stretch is carried along its track by a pointer or lengthened from either end, and
   the same is done from the keyboard.

   The keyboard's part is this primitive's own, so that a stretch is not moved by a key meant to walk: the spans
   are one stop in the Tab order, the arrows walk between them (along a track and across tracks), and a stretch
   is moved with Alt and an arrow along its track and lengthened or shortened with Shift as well, each said as
   it lands; across the tracks, Alt with an arrow takes it to the track beside, where it is not held to its own.
   Enter or Space picks one, for a page that opens something from it. Stretches that share a track and overlap
   stand side by side in it.

   With `stay`, a stretch keeps to its track: a task does not become another task by being dragged over its row. */

export type SpansChange = ChangeDetails<SpansReason> & { id: string; action: SpanAction };

export type SpansOptions = {
  value?: Span[];
  defaultValue?: Span[];
  onValueChange?: (value: Span[], details: SpansChange) => void;
  /* Where a track starts and ends, and what a start and an end snap to, in the track's own units. */
  min?: number;
  max?: number;
  step?: number;
  /* The shortest a stretch may be made. */
  minSize?: number;
  /* Which way tracks run: `x` across (a Gantt's rows), `y` down (a day's hours). */
  axis?: 'x' | 'y';
  /* A stretch keeps to the track it is on. */
  stay?: boolean;
  /* Whether a stretch cannot be changed. */
  locked?: (span: Span) => boolean;
  /* What a stretch is called, with where it is: what is said as it is changed. */
  label?: (span: Span) => string | undefined;
  /* Enter, Space or a press that did not carry it. */
  onPick?: (id: string, event: Event) => void;
};

type State = { value: Span[]; draft: unknown; focused: string | null };

export const spans = definePrimitive({
  name: 'spans',
  options: {
    value: 'value',
    defaultValue: 'value',
    onValueChange: 'callback',
    min: 'number',
    max: 'number',
    step: 'number',
    minSize: 'number',
    axis: 'string',
    stay: 'boolean',
    locked: 'action',
    label: 'action',
    onPick: 'callback',
  },
  controlled: ['value'],
  state: (options: SpansOptions): State => ({ value: options.value ?? options.defaultValue ?? [], draft: null, focused: null }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const options = () => context.options() as SpansOptions;
    const step = (): number => options().step ?? 1;
    const said = (span: Span): string => options().label?.(span) ?? span.id;
    /* What is asked for, with every stretch back on its own track where they are held to them. */
    const held = (next: Span[]): Span[] => {
      if (!options().stay) return next;
      const home = new Map(context.store.get().value.map((span) => [span.id, span.track]));
      return next.map((span) =>
        home.get(span.id) === undefined || home.get(span.id) === span.track ? span : { ...span, track: home.get(span.id) as string },
      );
    };
    const core = createSpans<State>(context, {
      key: 'value',
      draft: 'draft',
      set: (value, details) => change('value', held(value as Span[]), details),
      min: () => options().min ?? 0,
      max: () => options().max ?? 100,
      step,
      minSize: () => options().minSize ?? step(),
      axis: (options().axis ?? 'x') as 'x' | 'y',
      overlap: true,
      disabled: (span) => options().locked?.(span) ?? false,
      label: said,
    });
    const find = (id: string): Span | undefined => context.store.get().value.find((span) => span.id === id);
    return {
      core,
      find,
      step,
      /* Where a press on a stretch began, to tell a press from a carry once it is let go. */
      pressed: { x: 0, y: 0 },
      locked: (id: string): boolean => {
        const span = find(id);
        return span ? (options().locked?.(span) ?? false) : true;
      },
      focused: (state: State): string | null =>
        state.focused !== null && state.value.some((span) => span.id === state.focused) ? state.focused : (state.value[0]?.id ?? null),
      focus: (id: string) => context.store.set({ focused: id }),
      pick: (id: string, event: Event) => options().onPick?.(id, event),
      /* Alt with an arrow along the track: the whole stretch a step, or with Shift its far end. */
      nudge(id: string, by: number, end: boolean): boolean {
        const span = find(id);
        if (!span || (options().locked?.(span) ?? false)) return false;
        const low = options().min ?? 0;
        const high = options().max ?? 100;
        const size = span.end - span.start;
        const next = end
          ? { ...span, end: Math.min(Math.max(span.end + by, span.start + (options().minSize ?? step())), high) }
          : {
              ...span,
              start: Math.min(Math.max(span.start + by, low), high - size),
              end: Math.min(Math.max(span.start + by, low), high - size) + size,
            };
        if (next.start === span.start && next.end === span.end) return false;
        // A composer that draws its stretches from its own records turns the change down and makes it itself
        // (a Gantt, a week): what was asked for is said either way.
        core.update(id, { start: next.start, end: next.end });
        announce(said(next));
        return true;
      },
      /* Alt with an arrow across the tracks: the same stretch on the track beside, where it may leave its own. */
      across(el: HTMLElement, id: string, forward: boolean): boolean {
        const span = find(id);
        const root = el.closest('[data-slot="spans"]');
        if (!span || !root || options().stay || (options().locked?.(span) ?? false)) return false;
        const tracks = [...root.querySelectorAll<HTMLElement>('[data-slot="spans-track"]')].map((track) => track.dataset.track ?? '');
        const next = tracks[tracks.indexOf(span.track) + (forward ? 1 : -1)];
        if (next === undefined) return false;
        core.update(id, { track: next });
        announce(said({ ...span, track: next }));
        return true;
      },
      vertical: (): boolean => options().axis === 'y',
      /* The stretch the arrows walk to: the next along this track, or the nearest on the track above or below. */
      toward(el: HTMLElement, key: string): HTMLElement | undefined {
        const root = el.closest('[data-slot="spans"]');
        if (!root) return undefined;
        const all = [...root.querySelectorAll<HTMLElement>('[data-slot="spans-span"]')];
        const here = el.getBoundingClientRect();
        const along = options().axis === 'y' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
        const track = el.closest('[data-slot="spans-track"]');
        if (along.includes(key)) {
          const same = all.filter((span) => span.closest('[data-slot="spans-track"]') === track);
          return same[same.indexOf(el) + (key === along[1] ? 1 : -1)];
        }
        const tracks = [...root.querySelectorAll<HTMLElement>('[data-slot="spans-track"]')];
        const forward = key === 'ArrowDown' || key === 'ArrowRight';
        for (let at = tracks.indexOf(track as HTMLElement) + (forward ? 1 : -1); at >= 0 && at < tracks.length; at += forward ? 1 : -1) {
          const there = all.filter((span) => span.closest('[data-slot="spans-track"]') === tracks[at]);
          if (there.length === 0) continue;
          const middle = (box: DOMRect) => (options().axis === 'y' ? box.top + box.height / 2 : box.left + box.width / 2);
          return there.reduce((best, span) =>
            Math.abs(middle(span.getBoundingClientRect()) - middle(here)) < Math.abs(middle(best.getBoundingClientRect()) - middle(here))
              ? span
              : best,
          );
        }
        return undefined;
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, { spans: Span[]; changing: string | null }>({
      state: (state, part) => ({ spans: part.api.core.spans(state), changing: (state.draft as { id?: string } | null)?.id ?? null }),
      attrs: (state) => ({ 'data-changing': state.draft ? '' : undefined }),
    }),
    track: slot<{ value: string }, { spans: Span[] }>({
      props: { value: 'string' },
      state: (state, part) => ({ spans: part.api.core.spansOn(state, part.key) }),
      attrs: (_state, part) => ({ 'data-track': part.key }),
      bind: (el, part) => part.api.core.bindTrack(el, part.key),
    }),
    span: slot<{ value: string }, { span: Span | undefined; action: SpanAction | undefined }>({
      props: { value: 'string' },
      state: (state, part) => ({
        span: part.api.core.spans(state).find((span) => span.id === part.key),
        action: part.api.core.action(state, part.key),
      }),
      attrs: (state, part) => {
        const span = part.api.core.spans(state).find((each) => each.id === part.key);
        return {
          ...part.api.core.spanAttrs(state, part.key),
          // Beside the stretches it overlaps on its track, each a share of the track's breadth.
          style: span ? part.api.core.spanStyle(span, stackSpans(part.api.core.spansOn(state, span.track)).get(span.id)) : undefined,
          tabindex: part.api.focused(state) === part.key ? '0' : '-1',
          'data-locked': part.api.locked(part.key) ? '' : undefined,
          'aria-keyshortcuts': part.api.locked(part.key)
            ? undefined
            : 'Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight',
        };
      },
      bind: (el, part) => part.api.core.bindSpan(el, part.key),
      on: {
        pointerdown: (event, { api, key }) => {
          api.focus(key);
          api.pressed.x = event.clientX;
          api.pressed.y = event.clientY;
          api.core.spanPointerdown(event, key);
        },
        focus: (_event, { api, key }) => api.focus(key),
        click: (event, { api, key }) => {
          // A press that carried the stretch somewhere is not a press on it.
          if (event.detail !== 0 && Math.hypot(event.clientX - api.pressed.x, event.clientY - api.pressed.y) > 4) return;
          api.pick(key, event);
        },
        keydown: (event, { api, key, el }) => {
          if (!el) return;
          const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            api.pick(key, event);
          } else if (arrows.includes(event.key) && event.altKey) {
            event.preventDefault();
            const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
            const along = api.vertical()
              ? event.key === 'ArrowUp' || event.key === 'ArrowDown'
              : event.key === 'ArrowLeft' || event.key === 'ArrowRight';
            const id = key;
            if (along) api.nudge(id, (back ? -1 : 1) * api.step(), event.shiftKey);
            else if (api.across(el, id, !back)) {
              // It is drawn again on its new track, which may take the caller a moment: the keyboard goes with
              // it once it is there.
              const follow = (tries: number) => {
                const there = el.ownerDocument.querySelector<HTMLElement>(`[data-slot="spans-span"][data-span-id="${CSS.escape(id)}"]`);
                if (there && there !== el.ownerDocument.activeElement && there.isConnected) there.focus();
                if ((!there || el.ownerDocument.activeElement !== there) && tries > 0) requestAnimationFrame(() => follow(tries - 1));
              };
              requestAnimationFrame(() => follow(12));
            }
          } else if (arrows.includes(event.key)) {
            const next = api.toward(el, event.key);
            if (next) {
              event.preventDefault();
              next.focus();
            }
          } else if (event.key === 'Escape') api.core.cancel();
        },
      },
    }),
  }),
});
