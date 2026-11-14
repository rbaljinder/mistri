import {
  type ChangeDetails,
  createChange,
  createRovingFocus,
  createTransfer,
  definePrimitive,
  type TransferDraft,
  type TransferLists,
  type TransferReason,
} from '@ui-sdk/core';
import { dressCopyOf } from './dress';

/* Things moved between lists, as a UI SDK primitive: lanes of a board, two columns of a picker, a tray and a
   canvas. It is `createTransfer` given parts, so everything that behavior does arrives with it. An item is carried
   with a pointer, or picked up with Space and moved with the arrows (Left and Right between lists, Up and Down
   within one) and dropped with Space; Escape puts it back; a screen reader hears each step; and the move is a
   change that can be cancelled or controlled.

   What this adds for a composer is what it knows while something is carried, said as attributes and as part state:
   which lists would take the carried item (`data-takes`), which would not (`data-refuses`), and which one it is
   over now (`data-over`). A board's "letting go here books a visit" is those three, read by whoever draws the
   lane.

   It also adds one rule to a pointer's drop. `createTransfer` leaves a carried item in the last list that would
   take it, wherever the pointer goes next, so letting go over a list that refuses it, or over nothing, would
   still move it. Here a pointer that has left every list that would take the item is `astray`: no list is lit,
   and letting go puts the item back. What is lit is where it lands, and nothing lands where nothing is lit.

   An item is carried from anywhere on it by a mouse or a pen. A finger scrolls, so it carries by the handle only,
   which is also what the keyboard picks an item up by: a card with a link and a button in it cannot itself be the
   thing Space acts on. */

export type TransferMove = { key: string; from: string; to: string; index: number };

export type TransferOptions = {
  /* Every list by its name, each the keys of its items in order. A key is in one list. */
  value?: TransferLists;
  defaultValue?: TransferLists;
  onValueChange?: (value: TransferLists, details: ChangeDetails<TransferReason> & TransferMove) => void;
  /* Whether a list would take an item. Every list takes every item unless this says otherwise. */
  accepts?: (key: string, list: string) => boolean;
  /* The lists in the order the keyboard travels them: the order they are drawn in. */
  order?: string[];
  /* What a screen reader calls an item and a list, where their keys are not their names. */
  label?: (key: string) => string | undefined;
  listLabel?: (list: string) => string | undefined;
};

const listOf = (lists: TransferLists, key: string): string | undefined => Object.keys(lists).find((list) => lists[list]?.includes(key));

export const transfer = definePrimitive({
  name: 'transfer',
  options: {
    value: 'value',
    defaultValue: 'value',
    onValueChange: 'callback',
    accepts: 'action',
    order: 'list',
    label: 'action',
    listLabel: 'action',
  },
  controlled: ['value'],
  state: (options: TransferOptions) => ({
    value: options.value ?? options.defaultValue ?? {},
    moving: null as TransferDraft | null,
    focused: null as string | null,
    astray: false,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const accepts = (key: string, list: string): boolean => context.options().accepts?.(key, list) ?? true;
    /* Each list's element, to tell which one a pointer is over. */
    const places = new Map<string, HTMLElement>();
    const moves = createTransfer(context, {
      key: 'value',
      draft: 'moving',
      set: (value, details) => (details.reason === 'drag' && context.store.get().astray ? false : change('value', value, details)),
      order: () => context.options().order ?? Object.keys(context.store.get().value),
      accepts,
      label: (key) => context.options().label?.(key),
      listLabel: (list) => context.options().listLabel?.(list),
    });
    const roving = createRovingFocus(context, { slot: 'handle', key: 'focused', orientation: () => 'both' });
    /* Follows the pointer that pressed an item until it lifts, and says when it has gone astray. */
    const follow = (key: string, page: Document): void => {
      context.store.set({ astray: false });
      const moved = (event: PointerEvent) => {
        const under = page.elementFromPoint(event.clientX, event.clientY);
        const list = [...places].find(([, el]) => el.contains(under))?.[0];
        const home = context.store.get().moving?.from;
        const astray = list === undefined || (list !== home && !accepts(key, list));
        if (astray === context.store.get().astray) return;
        context.store.set({ astray });
        // Gone astray, the item is shown back where it came from, which is where letting go would leave it.
        const at = home === undefined ? -1 : (context.store.get().value[home]?.indexOf(key) ?? -1);
        if (astray && home !== undefined && at >= 0) moves.moveTo(home, at);
      };
      const lifted = () => {
        page.removeEventListener('pointermove', moved, true);
        page.removeEventListener('pointerup', lifted, true);
        page.removeEventListener('pointercancel', lifted, true);
      };
      page.addEventListener('pointermove', moved, true);
      page.addEventListener('pointerup', lifted, true);
      page.addEventListener('pointercancel', lifted, true);
      context.onDestroy(lifted);
    };
    /* Where the carried item stands now, when that is not where it came from. */
    const over = (state: { moving: TransferDraft | null; astray: boolean }): string | undefined => {
      if (!state.moving || (state.moving.pointer && state.astray)) return undefined;
      const now = listOf(state.moving.lists, state.moving.key);
      return now === state.moving.from ? undefined : now;
    };
    /* What the last press on an item landed on. Following a press takes the pointer for the item, so the click
       that ends a press which never moved arrives at the item and not at the link inside it that was pressed;
       the item hands it on (see its `click`). */
    const pressed: { on?: Element } = {};
    return { moves, roving, accepts, over, pressed, places, follow };
  },
  slots: (slot) => ({
    root: slot<{}, { carrying: string | null }>({
      state: (state) => ({ carrying: state.moving?.key ?? null }),
      attrs: (state) => ({
        'data-carrying': state.moving ? '' : undefined,
        'data-astray': state.moving?.pointer && state.astray ? '' : undefined,
      }),
    }),
    list: slot<{ value: string }, { keys: string[]; over: boolean; takes: boolean; refuses: boolean; carrying: string | null }>({
      props: { value: 'string' },
      state: (state, part) => {
        const carried = state.moving;
        const home = carried?.from === part.key;
        const takes = Boolean(carried && !home && part.api.accepts(carried.key, part.key));
        return {
          keys: part.api.moves.lists(state)[part.key] ?? [],
          over: part.api.over(state) === part.key,
          takes,
          refuses: Boolean(carried && !home && !takes),
          carrying: carried?.key ?? null,
        };
      },
      attrs: (state, part) => {
        const carried = state.moving;
        const home = carried?.from === part.key;
        const takes = Boolean(carried && !home && part.api.accepts(carried.key, part.key));
        return {
          'data-list': part.key,
          'data-over': part.api.over(state) === part.key ? '' : undefined,
          'data-takes': takes ? '' : undefined,
          'data-refuses': carried && !home && !takes ? '' : undefined,
        };
      },
      bind: (el, part) => {
        part.api.places.set(part.key, el);
        const unbind = part.api.moves.bindList(el, part.key);
        return () => {
          part.api.places.delete(part.key);
          unbind();
        };
      },
    }),
    item: slot<{ value: string }, { carried: boolean }>({
      props: { value: 'string' },
      state: (state, part) => ({ carried: part.api.moves.moving(state, part.key) }),
      attrs: (state, part) => ({
        'data-carried': part.api.moves.moving(state, part.key) ? '' : undefined,
        'data-dragging': part.api.moves.dragging(state, part.key) ? '' : undefined,
      }),
      on: {
        pointerdown: (event, { api, key, el }) => {
          if (event.pointerType === 'touch' || !el) return;
          if ((event.target as Element).closest('button, input, select, textarea, [role="menu"]')) return;
          api.pressed.on = event.target as Element;
          dressCopyOf(el);
          api.follow(key, el.ownerDocument);
          api.moves.pointerdown(event, key);
        },
        click: (event, { api, el }) => {
          const link = api.pressed.on?.closest('a, [role="link"]');
          api.pressed.on = undefined;
          if (event.target !== el || !link || !el?.contains(link)) return;
          link.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
            }),
          );
        },
      },
      bind: (el, part) => part.api.moves.bindItem(el, part.key),
    }),
    handle: slot<{ value?: string }, { carried: boolean }>({
      props: { value: { kind: 'string', from: 'item', required: true } },
      state: (state, part) => ({ carried: part.api.moves.moving(state, part.key) }),
      attrs: (state, part) => ({
        type: 'button',
        'aria-roledescription': 'carry handle',
        'aria-pressed': String(part.api.moves.moving(state, part.key)),
        tabindex: part.api.roving.tabIndex(state, part),
        'data-carried': part.api.moves.moving(state, part.key) ? '' : undefined,
      }),
      on: {
        keydown: (event, { el, api, key }) => {
          if (!api.moves.keydown(event, key) && el) api.roving.keydown(event, el);
        },
        pointerdown: (event, { api, key, el }) => {
          const item = el?.closest<HTMLElement>('[data-slot="transfer-item"]');
          if (item) dressCopyOf(item);
          if (el) api.follow(key, el.ownerDocument);
          api.moves.pointerdown(event, key);
          // The item around the handle hears the same press; it has been answered here.
          event.stopPropagation();
        },
      },
      bind: (el, part) => part.api.roving.bind(el, part),
    }),
  }),
});
