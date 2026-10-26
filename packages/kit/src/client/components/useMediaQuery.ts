/**
 * Whether a media query matches, re-read when it changes: the one
 * subscription the components that lay themselves out differently on a phone
 * share, so a breakpoint is asked of the browser the same way everywhere.
 */
import { useSyncExternalStore } from 'react';

const watched = new Map<string, { subscribe: (listener: () => void) => () => void; snapshot: () => boolean }>();

function watch(query: string) {
  let entry = watched.get(query);
  if (entry) return entry;
  const list = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null);
  entry = {
    snapshot: () => list()?.matches ?? false,
    subscribe: (listener) => {
      const media = list();
      if (!media) return () => {};
      media.addEventListener?.('change', listener);
      /* Older WebKit has the deprecated listener pair but no addEventListener. */
      if (!media.addEventListener) media.addListener(listener);
      return () => {
        media.removeEventListener?.('change', listener);
        if (!media.removeEventListener) media.removeListener(listener);
      };
    },
  };
  watched.set(query, entry);
  return entry;
}

export function useMediaQuery(query: string): boolean {
  const { subscribe, snapshot } = watch(query);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** A phone: where a record's actions fold into one menu rather than wrap. */
export const PHONE_QUERY = '(max-width: 600px)';

/** Where a filter rail has no room to stand beside the rows. The rail is
    12-15rem and a card grid wants 520px before it draws a second column, so
    under about 860px the two together leave the rows a single narrow column —
    measured at 641px: 352px of rows beside the rail, 606px without it. Wider
    than a phone on purpose: the rail's sheet is the right shape for every
    window too narrow for the column, not only for a handset. */
export const RAIL_QUERY = '(max-width: 860px)';
