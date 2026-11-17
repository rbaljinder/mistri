/* Asking someone else before a move is final, for the parts that move things (Spans, Sortable, Transfer). A page
   that saves a move on a server has the same three problems each time, a field report said: the item must stay
   where it was put while the server answers, a run of keystrokes must be one request and not six, and a refusal
   must put it back and say so. This is that, once, over any of them.

   With `onCommit` the part does not hand the page its value on every change. It draws the move itself (the item is
   `data-pending`, `aria-busy`), batches the keyboard's steps that come within `commitDelay` of each other into one
   call carrying the net change, commits a pointer's drop at once, and then:
   - `true`: the move stands. `onValueChange` is heard now, with the value, so a controlled page takes it as it
     would have; the part keeps drawing the move until the value it is given catches up, so nothing jumps back in
     between;
   - `false` or a rejection: the part goes back to the last place that was committed and says so to a screen reader
     (the live announcer the behavior's own steps use).
   Moves made while one is being asked about are allowed, and wait their turn, each asked about as the page left
   things after the one before. Without `onCommit` nothing here runs: the part is exactly what it was. */
import { announce } from '@ui-sdk/core';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Change } from './heard.js';

/** What `onCommit` is asked: where the move leaves things, where they were, and what moved. */
export type Committing<Value, Details = Change> = {
  /** The whole value as the moves leave it: what a controlled page would have been given. */
  value: Value;
  /** The whole value as it was last committed. */
  from: Value;
  /** The keys (or ids) of what the moves, taken together, left somewhere else. */
  moved: string[];
  /** The last change behind it: its reason, its hand, and what the behavior adds (a stretch's `id` and `action`). */
  details: Details;
};

export type CommitProps<Value, Details = Change> = {
  /** Asked once the moves settle; `true` keeps them, `false` or a rejection puts everything back. */
  onCommit?: (change: Committing<Value, Details>) => Promise<boolean>;
  /** How long keyboard steps are gathered into one commit, in milliseconds. */
  commitDelay?: number;
};

/** Said when a move is put back, to a screen reader: a caller's own sentence is the rejection's message. */
const REVERTED = 'Not saved. Put back where it was.';

const PendingContext = createContext<ReadonlySet<string>>(new Set());

/** Whether an item's move is being asked about: for the part that draws the item. */
export function usePending(key: string | undefined): Record<string, string> | undefined {
  const pending = useContext(PendingContext);
  return key !== undefined && pending.has(key) ? { 'data-pending': '', 'aria-busy': 'true' } : undefined;
}

export const PendingProvider = PendingContext.Provider;

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** What a list of keys moved: the one key that, taken out of both, leaves the same order (both, for a swap). */
export function movedKeys(from: readonly string[], to: readonly string[]): string[] {
  if (same(from, to)) return [];
  const without = (list: readonly string[], key: string) => list.filter((each) => each !== key);
  const found = to.filter((key) => same(without(from, key), without(to, key)));
  return found.length > 0 ? found : to.filter((key, at) => from[at] !== key);
}

/** The stretches that are somewhere else, or another size. */
export function movedSpans(from: ReadonlyArray<{ id: string }>, to: ReadonlyArray<{ id: string }>): string[] {
  const before = new Map(from.map((span) => [span.id, JSON.stringify(span)]));
  return to.filter((span) => before.get(span.id) !== JSON.stringify(span)).map((span) => span.id);
}

/** The items that are in another list or another place in their own. */
export function movedLists(from: Record<string, string[]>, to: Record<string, string[]>): string[] {
  const home = (lists: Record<string, string[]>) => {
    const out = new Map<string, string>();
    for (const [list, keys] of Object.entries(lists)) for (const key of keys) out.set(key, list);
    return out;
  };
  const was = home(from);
  const out = new Set<string>();
  for (const [key, list] of home(to)) if (was.get(key) !== list) out.add(key);
  for (const [list, keys] of Object.entries(to))
    if (!same(from[list], keys) && !keys.some((key) => out.has(key))) movedKeys(from[list] ?? [], keys).forEach((key) => out.add(key));
  return [...out];
}

type Batch<Value, Details> = { value: Value; details: Details };

/**
 * The commit's state for one root: what to hand the primitive as its value and change callback, and which items are
 * pending. With no `onCommit` it hands everything back as it was given.
 */
export function useCommit<Value, Details extends Change>({
  value,
  defaultValue,
  onValueChange,
  onCommit,
  commitDelay = 600,
  moved,
}: {
  value: Value | undefined;
  defaultValue: Value | undefined;
  onValueChange: ((value: Value, details: Details) => void) | undefined;
  moved: (from: Value, to: Value) => string[];
} & CommitProps<Value, Details>) {
  const controlled = value !== undefined;
  const [own, setOwn] = useState<Value | undefined>(defaultValue);
  const committed = controlled ? value : own;
  const [drawn, setDrawn] = useState<{ value: Value; settled: boolean; base: Value | undefined } | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const run = useRef({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    batch: null as Batch<Value, Details> | null,
    flight: Promise.resolve(),
    busy: 0,
    /* A refusal makes every move queued behind it moot: the ones still waiting are of an older generation. */
    generation: 0,
    confirmed: committed as Value | undefined,
    shown: committed as Value | undefined,
  });
  const live = useRef({ committed, value, onValueChange, onCommit, commitDelay, moved, controlled });
  live.current = { committed, value, onValueChange, onCommit, commitDelay, moved, controlled };
  // While nothing is being asked about, what the page gives is what is committed.
  if (run.current.busy === 0 && !run.current.batch && !drawn) run.current.confirmed = committed;

  useEffect(
    () => () => {
      clearTimeout(run.current.timer);
      run.current.generation += 1;
    },
    [],
  );
  // The value a controlled page was given has caught up with a move that stood: what is drawn is now the page's.
  useEffect(() => {
    if (drawn?.settled && (value !== drawn.base || same(value, drawn.value))) setDrawn(null);
  }, [value, drawn]);

  const marks = (): void => {
    const r = run.current;
    setPending(new Set(r.shown !== undefined && r.confirmed !== undefined ? live.current.moved(r.confirmed, r.shown) : []));
  };

  const revert = (why?: string): void => {
    const r = run.current;
    r.generation += 1;
    r.busy = 0;
    r.batch = null;
    clearTimeout(r.timer);
    r.shown = r.confirmed;
    setDrawn(null);
    setPending(new Set());
    announce(why ? `${why}. ${REVERTED}` : REVERTED);
  };

  const flush = (): void => {
    const r = run.current;
    clearTimeout(r.timer);
    const batch = r.batch;
    if (!batch) return;
    r.batch = null;
    const generation = r.generation;
    r.busy += 1;
    r.flight = r.flight.then(async () => {
      if (r.generation !== generation) return;
      const from = r.confirmed as Value;
      const movedNow = live.current.moved(from, batch.value);
      let kept = true;
      let why: string | undefined;
      // Moves that cancel each other out (down, then up) leave nothing to ask about.
      if (movedNow.length > 0) {
        try {
          kept = (await live.current.onCommit?.({ value: batch.value, from, moved: movedNow, details: batch.details })) === true;
        } catch (error) {
          kept = false;
          why = error instanceof Error ? error.message : undefined;
        }
      }
      if (r.generation !== generation) return;
      r.busy -= 1;
      if (!kept) return revert(why);
      r.confirmed = batch.value;
      if (!live.current.controlled) setOwn(batch.value);
      live.current.onValueChange?.(batch.value, batch.details);
      if (r.busy === 0 && !r.batch) {
        setPending(new Set());
        if (live.current.controlled) setDrawn({ value: batch.value, settled: true, base: live.current.value });
        else setDrawn(null);
      }
    });
  };

  const changed = (next: Value, details: Details): void => {
    const r = run.current;
    r.batch = { value: next, details };
    r.shown = next;
    setDrawn({ value: next, settled: false, base: undefined });
    marks();
    clearTimeout(r.timer);
    if (details.source === 'keyboard') r.timer = setTimeout(flush, live.current.commitDelay);
    else flush();
  };

  if (!onCommit) return { value, defaultValue, onValueChange, pending: undefined };
  const shown = drawn && !(drawn.settled && same(committed, drawn.value)) ? drawn.value : committed;
  return { value: shown, defaultValue: undefined, onValueChange: changed, pending };
}
