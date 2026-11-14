import {
  type ChangeDetails,
  createChange,
  createReorder,
  createRovingFocus,
  definePrimitive,
  type ReorderDraft,
  type ReorderReason,
} from '@ui-sdk/core';
import { dressCopyOf, zoomOf } from './dress';

/* A list whose order is the reader's to set, as a UI SDK primitive: defined the way UI SDK defines its own, from
   the behaviors it ships (`createReorder`, `createRovingFocus`, `createChange`), so it answers like one. The order
   is a value with a change that can be cancelled or controlled; an item is dragged with a pointer or picked up with
   Space and placed with the arrows; a screen reader hears the pick-up, each move and the drop; and every state is
   an attribute on a part with a `data-slot`. Nothing here draws: Sortable.tsx gives it React parts, and a
   component composes those (the column chooser, a checklist) and dresses them.

   It has two shapes, by what an item is picked up by. An item that is only its words is the thing itself: a
   listbox of options, each one focusable, Space on it picks it up. An item with controls of its own (a checkbox, a
   link) cannot be an option, so it is a list item with a handle: the handle is the button the keyboard and a
   finger pick it up by, and a mouse still carries it from anywhere that is not one of its controls. */

export type SortableOrientation = 'vertical' | 'horizontal' | 'grid';

export type SortableOptions = {
  /* The order, as the items' keys. */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[], details: ChangeDetails<ReorderReason>) => void;
  orientation?: SortableOrientation;
  /* What an item is picked up by: itself (the default), or the handle inside it. */
  by?: 'item' | 'handle';
  /* Carries a copy over the page while the item itself shows where it would land: for a list inside something that
     scrolls or clips, where a moved item would be cut off. */
  preview?: boolean;
};

const CONTROLS = 'button, input, select, textarea, a, [role="checkbox"], [role="switch"], [role="menu"]';

export const sortable = definePrimitive({
  name: 'sortable',
  options: {
    value: 'list',
    defaultValue: 'list',
    onValueChange: 'callback',
    orientation: 'string',
    by: 'string',
    preview: 'boolean',
  },
  controlled: ['value'],
  state: (options: SortableOptions) => ({
    value: options.value ?? options.defaultValue ?? [],
    moving: null as ReorderDraft | null,
    focused: null as string | null,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const orientation = (): SortableOrientation => context.options().orientation ?? 'vertical';
    const handled = (): boolean => context.options().by === 'handle';
    const preview = context.options().preview ?? false;
    const reorder = createReorder<ReturnType<typeof context.store.get>, { value: string; disabled?: boolean }>(context, {
      slot: 'item',
      key: 'value',
      draft: 'moving',
      set: (value, details) => change('value', value, details),
      orientation,
      preview,
      disabled: (item) => item.props.disabled === true,
    });
    const roving = createRovingFocus(context, {
      slot: handled() ? 'handle' : 'item',
      key: 'focused',
      orientation: () => {
        const way = orientation();
        return way === 'grid' ? 'both' : way;
      },
    });
    /* Core writes where a dragged item belongs as `--drag-x` and `--drag-y`: how far the pointer has gone, less how
       far the item has already been moved by taking a new place in the list. On a zoomed page (mistri zooms its
       root for density) those two are not in the same pixels, the first the screen's and the second the
       stylesheet's, so the item runs ahead of the pointer by the zoom. Only the pointer's part is wrong, and core
       does not say it apart, so it is followed here from the press: `--drag-dx` and `--drag-dy` are how far the
       pointer has gone, and `--drag-ease` what to scale that by to take the excess back. The sheet adds the
       product. On a page that is not zoomed none of it is set. */
    const measure = (item: HTMLElement, down: PointerEvent): void => {
      const zoom = zoomOf(item);
      if (zoom === 1) return;
      const page = item.ownerDocument;
      item.style.setProperty('--drag-ease', String(1 / zoom - 1));
      const moved = (event: PointerEvent) => {
        item.style.setProperty('--drag-dx', `${event.clientX - down.clientX}px`);
        item.style.setProperty('--drag-dy', `${event.clientY - down.clientY}px`);
      };
      const lifted = () => {
        page.removeEventListener('pointermove', moved, true);
        page.removeEventListener('pointerup', lifted, true);
        page.removeEventListener('pointercancel', lifted, true);
        for (const name of ['--drag-ease', '--drag-dx', '--drag-dy']) item.style.removeProperty(name);
      };
      page.addEventListener('pointermove', moved, true);
      page.addEventListener('pointerup', lifted, true);
      page.addEventListener('pointercancel', lifted, true);
      context.onDestroy(lifted);
    };
    return { reorder, roving, orientation, handled, preview, measure };
  },
  slots: (slot) => ({
    root: slot<{}, { order: string[]; moving: string | null }>({
      state: (state, part) => ({ order: part.api.reorder.order(state), moving: state.moving?.key ?? null }),
      attrs: (state, part) => ({
        role: part.api.handled() ? 'list' : 'listbox',
        'aria-roledescription': part.api.handled() ? undefined : 'sortable list',
        'aria-orientation': !part.api.handled() && part.api.orientation() === 'horizontal' ? 'horizontal' : undefined,
        'data-orientation': part.api.orientation(),
        'data-sorting': state.moving ? '' : undefined,
      }),
    }),
    item: slot<{ value: string; disabled?: boolean }, { grabbed: boolean }>({
      props: { value: 'string', disabled: 'boolean' },
      state: (state, part) => ({ grabbed: part.api.reorder.moving(state, part.key) }),
      attrs: (state, part) => {
        const grabbed = part.api.reorder.moving(state, part.key);
        const marks = {
          'data-grabbed': grabbed ? '' : undefined,
          'data-dragging': part.api.reorder.dragging(state, part.key) ? '' : undefined,
          'data-disabled': part.props.disabled ? '' : undefined,
        };
        if (part.api.handled()) return { role: 'listitem', ...marks };
        return {
          role: 'option',
          'aria-roledescription': 'sortable item',
          'aria-selected': String(grabbed),
          'aria-disabled': part.props.disabled ? 'true' : undefined,
          tabindex: part.api.roving.tabIndex(state, part),
          ...marks,
        };
      },
      on: {
        keydown: (event, { el, api, key }) => {
          if (api.handled()) return;
          if (!api.reorder.keydown(event, key) && el) api.roving.keydown(event, el);
        },
        pointerdown: (event, { api, key, el }) => {
          if (api.handled() && (event.pointerType === 'touch' || (event.target as Element).closest(CONTROLS))) return;
          if (api.preview && el) dressCopyOf(el);
          if (el) api.measure(el, event);
          api.reorder.pointerdown(event, key);
        },
      },
      bind: (el, part) => {
        const undo = [part.api.reorder.bind(el, part)];
        if (!part.api.handled()) undo.push(part.api.roving.bind(el, part));
        return () => undo.forEach((each) => each());
      },
    }),
    handle: slot<{ value?: string }, { grabbed: boolean }>({
      props: { value: { kind: 'string', from: 'item', required: true } },
      state: (state, part) => ({ grabbed: part.api.reorder.moving(state, part.key) }),
      attrs: (state, part) => ({
        type: 'button',
        'aria-roledescription': 'sort handle',
        'aria-pressed': String(part.api.reorder.moving(state, part.key)),
        tabindex: part.api.roving.tabIndex(state, part),
        'data-grabbed': part.api.reorder.moving(state, part.key) ? '' : undefined,
      }),
      on: {
        keydown: (event, { el, api, key }) => {
          if (!api.reorder.keydown(event, key) && el) api.roving.keydown(event, el);
        },
        pointerdown: (event, { api, key, el }) => {
          const item = el?.closest<HTMLElement>('[data-slot="sortable-item"]');
          if (api.preview && item) dressCopyOf(item);
          if (item) api.measure(item, event);
          api.reorder.pointerdown(event, key);
          // The item around the handle hears the same press; it has been answered here.
          event.stopPropagation();
        },
      },
      bind: (el, part) => part.api.roving.bind(el, part),
    }),
  }),
});
