/**
 * Two places in the crumb bar a room can draw into: the note, right after
 * the current crumb, and the tools, at the bar's far end. A list page puts
 * its title, count and star in the first and New and Export in the second,
 * so its name and its verbs share the bar that already says where it is.
 * Both are null where the App hides breadcrumbs, and the room draws its own.
 */
import { useLayoutEffect, useReducer, useSyncExternalStore } from 'react';

interface CrumbSlots {
  note: HTMLElement | null;
  tools: HTMLElement | null;
  /* Not the bar's: the end of a list page's control strip, where a phone's Records/Table switch stands beside the
     tabs instead of on a row of its own over the rows (TableView). */
  controls: HTMLElement | null;
}

let slots: CrumbSlots = { note: null, tools: null, controls: null };
const listeners = new Set<() => void>();

function set(kind: keyof CrumbSlots, element: HTMLElement | null) {
  if (slots[kind] === element) return;
  slots = { ...slots, [kind]: element };
  for (const listener of listeners) listener();
}

/* Stable ref callbacks: a fresh one per render would detach and reattach the slots every paint. */
export const crumbNoteRef = (element: HTMLElement | null) => set('note', element);
export const crumbToolsRef = (element: HTMLElement | null) => set('tools', element);
export const listControlsRef = (element: HTMLElement | null) => set('controls', element);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => slots;

export function useCrumbSlots(): CrumbSlots {
  const seen = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  /* The bar's slots attach in the same commit as the room that reads them,
     but a store's subscription only starts in a passive effect, after the
     paint: a list painted its own heading row first and then moved it into
     the bar, and every row under it jumped up a line (CLS, measured by
     test/built-client-vitals.mjs). An update asked for in a layout effect is
     drawn before the paint, so the first paint is already the final one. */
  useLayoutEffect(() => {
    if (slots !== seen) recheck();
  });
  return seen;
}
