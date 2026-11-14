/* A list worked through one at a time: the behavior under a queue of things to decide, a review, a set of cards
   to go through. As a UI SDK primitive what has been dealt with is a value with a change, so a page can hold it
   (the ones answered, kept) or leave it alone.

   One thing is in hand. Finishing it brings the next into its place; skipping leaves it for the end, where what
   was skipped comes round again. When the one in hand changes the keyboard is put on its name, so it is read out
   and the next key is about the new one. What is done to a thing, and whether it worked, is the caller's: it
   says `finish` when it has. */
import { type ChangeDetails, createChange, definePrimitive } from '@ui-sdk/core';

export type TurnsReason = 'next-press' | 'previous-press' | 'imperative';

export type TurnsOptions = {
  /* Everything to go through, in order, by its key. */
  keys: string[];
  /* The keys that have been dealt with. */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[], details: ChangeDetails<TurnsReason>) => void;
};

export const turns = definePrimitive({
  name: 'turns',
  options: { keys: 'list', value: 'list', defaultValue: 'list', onValueChange: 'callback' },
  controlled: ['value'],
  state: (options: TurnsOptions) => ({
    value: (options.value ?? options.defaultValue ?? []) as string[],
    /* The place, among what is left, of the one in hand. */
    at: 0,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const left = (): string[] => {
      const done = context.store.get().value;
      return (context.options().keys ?? []).filter((key) => !done.includes(key));
    };
    const current = (): string | null => {
      const all = left();
      return all[Math.min(context.store.get().at, all.length - 1)] ?? null;
    };
    /* The keyboard goes to the name of the one in hand once it is drawn. */
    const arrive = (from: HTMLElement | null | undefined) => {
      const root = from?.closest<HTMLElement>('[data-slot="turns"]');
      if (!root || typeof requestAnimationFrame === 'undefined') return;
      let tries = 0;
      const go = () => {
        const name = root.querySelector<HTMLElement>('[data-slot="turns-name"]');
        // The name of the last one is still there until the next is drawn: one frame is waited for it.
        if (name && tries > 0) name.focus();
        else if (++tries < 12) requestAnimationFrame(go);
      };
      go();
    };
    return {
      left,
      current,
      total: (): number => (context.options().keys ?? []).length,
      now: () => context.store.get(),
      arrive,
      /* The one in hand is left where it stands and the next comes up; past the last, the first that is left. */
      step(by: number, from?: HTMLElement | null): boolean {
        const count = left().length;
        if (count < 2) return false;
        const at = Math.min(context.store.get().at, count - 1);
        context.store.set({ at: (at + by + count) % count });
        arrive(from);
        return true;
      },
      /* The one in hand (or the one named) has been dealt with: the next slides into its place. */
      finish(key?: string, from?: HTMLElement | null, event?: Event): boolean {
        const done = key ?? current();
        const now = context.store.get();
        if (done === null || now.value.includes(done)) return false;
        const before = left();
        if (!change('value', [...now.value, done], { reason: 'imperative', event })) return false;
        // Past the last, what was skipped is what is left, from its start.
        if (Math.min(now.at, before.length - 1) >= before.length - 1) context.store.set({ at: 0 });
        arrive(from);
        return true;
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, { current: string | null; at: number; handled: string[]; left: string[]; total: number }>({
      state: (state, part) => {
        const left = part.api.left();
        return {
          current: part.api.current(),
          at: Math.min(state.at, Math.max(left.length - 1, 0)),
          handled: state.value,
          left,
          total: part.api.total(),
        };
      },
      attrs: (_state, part) => ({ 'data-done': part.api.current() === null ? '' : undefined }),
    }),
    /* What the one in hand is called: where the keyboard lands when it changes. */
    name: slot<{}>({
      attrs: () => ({ tabindex: '-1' }),
    }),
    skip: slot<{}>({
      attrs: (_state, part) => ({ type: 'button', disabled: part.api.left().length < 2 ? '' : undefined }),
      on: {
        click: (_event, { api, el }) => {
          api.step(1, el);
        },
      },
    }),
  }),
});
