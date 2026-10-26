/**
 * The walk, from inside a component.
 *
 * core.js owns the stack and mutates it in place — a crumb's label arrives
 * after the row does, a page learns its root — and ticks a counter on every
 * render and every crumb correction. This subscribes a component to that
 * tick, so it re-reads the stack whenever the vanilla client would have
 * redrawn the trail.
 */
import { useSyncExternalStore } from 'react';
import { state, subscribeWalk, walkVersion } from '../core.js';

export interface WalkEntry {
  kind: 'table' | 'breakdown' | 'row' | 'page';
  table?: string;
  query?: string;
  tab?: string;
  key?: Record<string, unknown>;
  label?: string;
  pageId?: string;
  rootBody?: string;
  /** The key of the App view that opened a list, or a row read beside it. */
  view?: string;
}

/** The stack as it stands; the component re-renders when it changes. */
export function useWalk(): WalkEntry[] {
  useSyncExternalStore(subscribeWalk, walkVersion, walkVersion);
  return state.stack as WalkEntry[];
}
