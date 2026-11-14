import { createInlineEdit, definePrimitive, type InlineEditReason } from '@ui-sdk/core';

/* Values edited where they stand, as a UI SDK primitive over the inline edit `@ui-sdk/core` ships: one of a set
   of values is being edited at a time, a box takes its place, Enter and Tab keep what was typed and Escape puts
   the value back. A value is started on by Enter, F2, typing over it or a double press, and by a single press
   where the composer says so (a record's value, which is nothing but its value; a table's cell is also a place
   to select text and to open its row from, so there it takes two).

   Tab keeps and goes on to the next value in the page's order, Shift with Tab to the one before, as a
   spreadsheet does, so a row is filled in without the hand leaving the keys. What is kept is asked of the
   composer, which may refuse it (`onCommit` returning false): the box then stays, with what was typed. */

export type EditableOptions = {
  /* What a value says now, by its id: what the box starts with. */
  text: (id: string) => string;
  /* Asked to keep what was typed. Return false to refuse it and keep the box open. */
  onCommit?: (id: string, text: string, details: { reason: InlineEditReason; event?: Event }) => boolean | void;
  /* The box was left by Escape. */
  onCancel?: (id: string) => void;
  /* Whether a value cannot be edited now. */
  locked?: (id: string) => boolean;
};

const VALUE = '[data-slot="editable-value"]';

export const editable = definePrimitive({
  name: 'editable',
  options: {
    text: 'action',
    onCommit: 'action',
    onCancel: 'callback',
    locked: 'action',
  },
  state: (_options: EditableOptions) => ({ editing: null as string | null }),
  api: (context) => {
    const edit = createInlineEdit(context, {
      key: 'editing',
      value: (id) => context.options().text?.(id) ?? '',
      commit: (id, text, details) => context.options().onCommit?.(id, text, details) !== false,
      disabled: (id) => context.options().locked?.(id) ?? false,
    });
    return {
      edit,
      locked: (id: string): boolean => context.options().locked?.(id) ?? false,
      now: () => context.store.get(),
      canceled: (id: string) => context.options().onCancel?.(id),
      /* The value after this one in the page's order (or before it) that can be edited, started on. */
      onward(from: HTMLElement, id: string, by: 1 | -1, event: Event): boolean {
        const root = from.closest('[data-slot="editable"]');
        if (!root) return false;
        const values = [...root.querySelectorAll<HTMLElement>(VALUE)].filter((value) => !value.hasAttribute('data-locked'));
        const at = values.findIndex((value) => value.dataset.editId === id);
        const next = values[at + by]?.dataset.editId;
        return at >= 0 && next !== undefined && edit.start(next, { reason: 'tab-key', event });
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, { editing: string | null }>({
      state: (state) => ({ editing: state.editing }),
      attrs: (state) => ({ 'data-editing': state.editing === null ? undefined : '' }),
    }),
    /* Where a value stands, whether it is shown or being edited. */
    value: slot<{ value: string; press?: boolean }, { editing: boolean }>({
      props: { value: 'string', press: 'boolean' },
      state: (state, part) => ({ editing: state.editing === part.key }),
      attrs: (state, part) => ({
        'data-edit-id': part.key,
        'data-editing': state.editing === part.key ? '' : undefined,
        'data-locked': part.api.locked(part.key) ? '' : undefined,
      }),
      on: {
        keydown: (event, { api, key, el }) => {
          // A key in the box is the box's; only one on the value itself starts an edit.
          if (event.target !== el || api.now().editing === key) return;
          api.edit.keydown(event, key);
        },
        dblclick: (event, { api, key }) => {
          if (api.now().editing !== key) api.edit.dblclick(event, key);
        },
        click: (event, { api, key, props }) => {
          if (!props.press || api.now().editing === key) return;
          if ((event.target as Element).closest('a, button, input')) return;
          api.edit.start(key, { reason: 'double-click', event });
        },
      },
    }),
    input: slot<{}>({
      on: {
        keydown: (event, { api, el }) => {
          const id = api.now().editing;
          const tab = event.key === 'Tab';
          const escape = event.key === 'Escape';
          // Escape is this box's alone: a sheet around it does not also close.
          if (escape) event.stopPropagation();
          const handled = api.edit.inputKeydown(event);
          if (id === null || !el) return;
          if (escape) api.canceled(id);
          // With no value to go on to, Tab is the page's own and moves to whatever is next.
          else if (handled && tab && api.now().editing === null && api.onward(el, id, event.shiftKey ? -1 : 1, event))
            event.preventDefault();
        },
        focusout: (event, { api }) => {
          api.edit.end('focus-out', event);
        },
      },
      bind: (el, part) => part.api.edit.bindInput(el as HTMLInputElement),
    }),
  }),
});
