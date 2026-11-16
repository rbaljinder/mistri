/* One of a list, picked, and shown beside the list: the behavior under a list with its detail, an inbox, a set of
   settings by section. As a UI SDK primitive the pick is a value with a change, so a page can hold it (the pick in
   the address) or leave it alone.

   The list is one stop in the Tab order. Up, Down, Home and End walk it, and where the list and what is picked
   are both in view (`follow`, the default) walking picks as it goes, so the pane keeps up with the keyboard.
   Enter or Space picks a row and takes the keyboard into the pane; Escape there brings it back to the row. Where
   only one of the two is in view (`follow` off: a phone), walking only moves along the rows, a press on a row
   picks it and goes to the pane, and Escape or the back part unpicks it and returns to its row.

   What is drawn after a pick is not there yet when the key is handled, so the keyboard is landed a frame or two
   later, on the pane or on the row it came from. */
import { type ChangeDetails, createChange, definePrimitive } from '@ui-sdk/core';

export type PickReason = 'move-key' | 'enter-key' | 'item-press' | 'escape-key' | 'close-press';

export type PickOptions = {
  /* The rows, in order, by their keys. */
  keys: string[];
  /* The picked row's key, or none. */
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null, details: ChangeDetails<PickReason>) => void;
  /* Walking the list picks as it goes. Off where the list and the pane are not both in view. */
  follow?: boolean;
};

export const pick = definePrimitive({
  name: 'pick',
  options: { keys: 'list', value: 'value', defaultValue: 'value', onValueChange: 'callback', follow: 'boolean' },
  controlled: ['value'],
  state: (options: PickOptions) => ({
    value: (options.value ?? options.defaultValue ?? null) as string | null,
    /* The row the keyboard was last on, where that is not the picked one. */
    cursor: null as string | null,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const keys = (): string[] => context.options().keys ?? [];
    const follows = (): boolean => context.options().follow !== false;
    /* The keyboard goes to the pane or to a row once it is drawn. */
    const land = (from: HTMLElement | null | undefined, to: 'pane' | string) => {
      const root = from?.closest<HTMLElement>('[data-slot="pick"]');
      if (!root) return;
      const find = () =>
        to === 'pane'
          ? root.querySelector<HTMLElement>('[data-slot="pick-pane"]')
          : root.querySelector<HTMLElement>(`[data-slot="pick-option"][data-key="${CSS.escape(to)}"]`);
      let tries = 0;
      const go = () => {
        const target = find();
        if (target) target.focus();
        else if (++tries < 12 && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(go);
      };
      go();
    };
    return {
      keys,
      follows,
      now: () => context.store.get(),
      land,
      /* The row that is the list's one stop in the Tab order: the picked one, else the one last walked to, else
         the first. */
      stop(): string | null {
        const { value, cursor } = context.store.get();
        const all = keys();
        if (value !== null && all.includes(value)) return value;
        if (cursor !== null && all.includes(cursor)) return cursor;
        return all[0] ?? null;
      },
      walked(key: string) {
        if (context.store.get().cursor !== key) context.store.set({ cursor: key });
      },
      choose(key: string | null, reason: PickReason, event?: Event): boolean {
        if (key === context.store.get().value) return true;
        return change('value', key, { reason, event });
      },
      /* Where a key takes the keyboard from a row, or nowhere. */
      step(from: string, key: string): string | undefined {
        const all = keys();
        const at = all.indexOf(from);
        const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[key];
        return to === undefined || at < 0 ? undefined : all[Math.min(Math.max(to, 0), all.length - 1)];
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, { value: string | null; follow: boolean }>({
      state: (state, part) => ({ value: state.value, follow: part.api.follows() }),
      attrs: (state) => ({ 'data-picked': state.value === null ? undefined : '' }),
    }),
    list: slot<{}>({
      attrs: () => ({ role: 'listbox' }),
    }),
    option: slot<{ value: string }, { picked: boolean }>({
      props: { value: 'string' },
      state: (state, part) => ({ picked: state.value === part.props.value }),
      attrs: (state, part) => ({
        role: 'option',
        tabindex: part.api.stop() === part.props.value ? '0' : '-1',
        'data-key': part.props.value,
        'aria-selected': String(state.value === part.props.value),
        'data-picked': state.value === part.props.value ? '' : undefined,
      }),
      on: {
        keydown: (event, { api, el, props }) => {
          if (event.target !== el) return;
          const to = api.step(props.value, event.key);
          if (to !== undefined) {
            event.preventDefault();
            if (to === props.value) return;
            api.walked(to);
            // Where both are seen, walking picks as it goes; where one is, a row is only walked to.
            if (api.follows()) api.choose(to, 'move-key', event);
            api.land(el, to);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (api.choose(props.value, 'enter-key', event)) api.land(el, 'pane');
          }
        },
        focus: (event, { api, el, props }) => {
          if (event.target === el) api.walked(props.value);
        },
        click: (event, { api, el, props }) => {
          api.walked(props.value);
          if (api.choose(props.value, 'item-press', event) && !api.follows()) api.land(el, 'pane');
        },
      },
    }),
    pane: slot<{}, { value: string | null }>({
      state: (state) => ({ value: state.value }),
      attrs: (state) => ({ tabindex: '-1', 'data-empty': state.value === null ? '' : undefined }),
      on: {
        keydown: (event, { api, el }) => {
          const picked = api.now().value;
          if (event.key !== 'Escape' || event.defaultPrevented || picked === null) return;
          event.preventDefault();
          // Where only the pane is in view, leaving it is unpicking; where both are, it is going back to the row.
          if (!api.follows() && !api.choose(null, 'escape-key', event)) return;
          api.land(el, picked);
        },
      },
    }),
    /* The way back to the list, for where only the pane is in view. */
    back: slot<{}>({
      attrs: () => ({ type: 'button' }),
      on: {
        click: (event, { api, el }) => {
          const picked = api.now().value;
          if (picked !== null && api.choose(null, 'close-press', event)) api.land(el, picked);
        },
      },
    }),
  }),
});
