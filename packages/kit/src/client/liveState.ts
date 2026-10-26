/**
 * What live sync tells the components, and what they tell it.
 *
 * The stream, the rules and the screens that draw a notice are a part of
 * their own (liveSync.ts, loaded when an App is shown); a list, a record and
 * a grid need only this, which is small: a row that another person changed
 * (`useChangedRows`), a list that is held while its reader works in it
 * (`useListHold`), a record that changed under an open draft, and the last
 * time a record changed. Nothing here fetches.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { canonicalText } from '@mistriwork/engine/shared/recordReadKeys.js';

/** A key as text. A number and its string are one key: an id past 2^53 is a string on the wire, and a number in a query's key. */
export const liveKeyText = (key: Readonly<Record<string, unknown>>): string =>
  canonicalText(Object.fromEntries(Object.entries(key).map(([column, value]) => [column, value == null ? null : String(value)])));

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/* ---------- whether the page follows changes at all ---------- */

const active = store(false);
/* The App's tables that stay out of live sync (a resource's `live: false`), as `hello` names them: never followed. */
const off = store<ReadonlySet<string>>(new Set());
export const setLiveActive = (on: boolean): void => active.set(on);
/** Whether the page follows changes now, outside React (a query's refetch interval asks it), and, given a table, its. */
export const liveFollowing = (table?: string): boolean => active.get() && !(table !== undefined && off.get().has(table));
export const setLiveOff = (tables: readonly string[]): void => off.set(new Set(tables));
/** Whether the page follows changes, and, given a table, whether it follows that table's. */
export const useLiveActive = (table?: string): boolean => {
  const on = useSyncExternalStore(active.subscribe, active.get, active.get);
  const kept = useSyncExternalStore(off.subscribe, off.get, off.get);
  return on && !(table !== undefined && kept.has(table));
};

/* ---------- rows another person changed ---------- */

/** A change just announced: per table, the keys (as text) it named, or every key. */
interface Pulse {
  readonly id: number;
  readonly at: number;
  readonly tables: ReadonlyMap<string, ReadonlySet<string> | 'many'>;
}
/** How long after a change an answer still counts as its answer: a refetch waits for the rate limit (liveInvalidate.ts) and the network. */
const PULSE_LIFE = 8_000;
let pulse: Pulse | undefined;
export const announcePulse = (next: Pulse): void => {
  pulse = next;
};

const NONE: ReadonlyMap<unknown, 1 | 2> = new Map();

/**
 * The rows of an answer that differ from the answer before it, while a change to their table has just been announced:
 * each row to which of two alternating tints it wears, so a row changed twice in a row restarts its fade. Judged once
 * for each answer (by identity) against the answer before it. The first answer a list has tints nothing, and neither
 * does a row no change named (a page turned to, a sort), since only the keys a change named can. A list that draws a
 * new array of the same rows (a board gathers its lanes on each render) keeps the tint that change gave them, so the
 * fade is not cut short by a render that changed nothing.
 */
export function useChangedRows<R extends object>(
  table: string | undefined,
  rows: readonly R[] | undefined,
  keyOf: (row: R) => Readonly<Record<string, unknown>> | null | undefined,
): ReadonlyMap<R, 1 | 2> {
  const memo = useRef<
    { rows: unknown; changed: ReadonlyMap<R, 1 | 2>; seen: ReadonlyMap<string, string>; tinted: ReadonlyMap<string, number> } | undefined
  >(undefined);
  if (!rows || !table) return NONE as ReadonlyMap<R, 1 | 2>;
  if (memo.current?.rows === rows) return memo.current.changed;
  const seen = new Map<string, string>();
  const changed = new Map<R, 1 | 2>();
  /* Each tinted key, by the change that tinted it. */
  const tinted = new Map<string, number>();
  const fresh = pulse && Date.now() - pulse.at < PULSE_LIFE ? pulse : undefined;
  const named = fresh?.tables.get(table);
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const text = liveKeyText(key);
    const signature = JSON.stringify(row);
    seen.set(text, signature);
    const before = memo.current?.seen.get(text);
    const differs = named && memo.current && (named === 'many' || named.has(text)) && before !== signature;
    const kept = fresh && before === signature && memo.current?.tinted.get(text) === fresh.id;
    if (differs || kept) {
      changed.set(row, (fresh!.id % 2 ? 1 : 2) as 1 | 2);
      tinted.set(text, fresh!.id);
    }
  }
  memo.current = { rows, changed: changed.size ? changed : (NONE as ReadonlyMap<R, 1 | 2>), seen, tinted };
  return memo.current.changed;
}

/* ---------- a list that holds still while its reader works in it ---------- */

/**
 * A list on screen that live sync may hold: what it reads, and the changes it has been told of and not shown. The
 * engagement rules (liveEngagement.ts) decide whether it is held; the invalidation (liveInvalidate.ts) asks.
 */
export interface Hold {
  readonly table: string;
  owns(queryKey: readonly unknown[]): boolean;
  /** Queries to ask again when the list is shown, by hash. */
  readonly queries: Set<string>;
  /** Distinct keys changed since the hold began; 'many' once any change named none. */
  keys: Set<string> | 'many';
  count(): number | 'many';
}
const holds = new Set<Hold>();
/** The lists holding changes the reader has not been shown. */
export const heldHolds = (): Hold[] => [...holds].filter((hold) => hold.queries.size > 0);
export const holdFor = (queryKey: readonly unknown[]): Hold | undefined => [...holds].find((hold) => hold.owns(queryKey));

/** Whether the reader is working in a list now (set by liveEngagement.ts). */
let engaged: () => boolean = () => false;
export const setEngagement = (test: () => boolean): void => {
  engaged = test;
};
export const isEngaged = (): boolean => engaged();

/** Asked ones the hold has kept, to show them (set by liveInvalidate.ts). */
let release: (hold: Hold) => void = () => {};
export const setHoldRelease = (fn: (hold: Hold) => void): void => {
  release = fn;
};
const releaseHold = (hold: Hold): void => release(hold);

const holdSignals = store(0);
export const heldChanged = (): void => holdSignals.set(holdSignals.get() + 1);
export const clearHold = (hold: Hold): void => {
  hold.queries.clear();
  hold.keys = new Set();
  heldChanged();
};

/**
 * Register a list as one live sync may hold, while it is on screen and the page follows changes. Returns the number of
 * changes it holds (0 when none), and a way to show them.
 */
export function useListHold(spec: { table: string; owns: (queryKey: readonly unknown[]) => boolean } | undefined): {
  held: number | 'many';
  show(): void;
} {
  const on = useLiveActive(spec?.table);
  const owns = useRef(spec?.owns);
  owns.current = spec?.owns;
  const table = spec?.table;
  const hold = useMemo<Hold | undefined>(
    () =>
      on && table
        ? {
            table,
            queries: new Set(),
            keys: new Set(),
            owns: (queryKey) => owns.current?.(queryKey) ?? false,
            count() {
              return this.keys === 'many' ? 'many' : this.keys.size;
            },
          }
        : undefined,
    [on, table],
  );
  useEffect(() => {
    if (!hold) return;
    holds.add(hold);
    return () => void holds.delete(hold);
  }, [hold]);
  useSyncExternalStore(holdSignals.subscribe, holdSignals.get, holdSignals.get);
  return { held: hold?.count() ?? 0, show: () => hold && releaseHold(hold) };
}

/* ---------- a record that changed under an open draft ---------- */

interface EditNotice {
  readonly table: string;
  readonly key: string;
  readonly kind: 'update' | 'delete';
  /** The reader's own write, in another tab. */
  readonly self: boolean;
  /** When it was said: each change is its own, and who made it is asked again for each (LiveNotices.tsx). */
  readonly at: number;
}
const notices = store<ReadonlyMap<string, EditNotice>>(new Map());
const noticeId = (table: string, key: string) => `${table}|${key}`;
export function raiseEditNotice(raised: Omit<EditNotice, 'at'> & { at?: number }): void {
  const notice: EditNotice = { ...raised, at: raised.at ?? Date.now() };
  const next = new Map(notices.get());
  const id = noticeId(notice.table, notice.key);
  // A delete is the last word on a record.
  if (next.get(id)?.kind === 'delete' && notice.kind !== 'delete') return;
  next.set(id, notice);
  notices.set(next);
}
export function dismissEditNotice(table: string, key: string): void {
  const next = new Map(notices.get());
  if (next.delete(noticeId(table, key))) notices.set(next);
}
/** Whether the record's own draft is open over this record (set by liveInvalidate.ts, which reads write.js). */
let drafted: (table: string, key: string) => boolean = () => false;
export const setDraftedTest = (test: (table: string, key: string) => boolean): void => {
  drafted = test;
};
/** A form that raised a notice closes: the notice goes with it, unless the record's draft still owns it. */
export function releaseEditNotice(table: string, key: string): void {
  if (!drafted(table, key)) dismissEditNotice(table, key);
}
export const useEditNotice = (table: string, key: string): EditNotice | undefined => {
  const read = () => notices.get().get(noticeId(table, key));
  return useSyncExternalStore(notices.subscribe, read, read);
};

/* ---------- when a record last changed ---------- */

interface RecentChange {
  readonly at: number;
  readonly self: boolean;
}
const recents = store<ReadonlyMap<string, RecentChange>>(new Map());
const RECENTS_MOST = 500;
export function noteRecentChanges(table: string, keys: Iterable<string>, self: boolean, at = Date.now()): void {
  const next = new Map(recents.get());
  for (const key of keys) {
    next.delete(noticeId(table, key));
    next.set(noticeId(table, key), { at, self });
  }
  while (next.size > RECENTS_MOST) next.delete(next.keys().next().value!);
  recents.set(next);
}
/* Read by the record's own id, so a page re-draws for a change to its record and not for every change. */
export const useRecentChange = (table: string, key: string): RecentChange | undefined => {
  const read = () => recents.get().get(noticeId(table, key));
  return useSyncExternalStore(recents.subscribe, read, read);
};

/** Forget everything, as the page does when its session or connection changes. */
export function resetLiveState(): void {
  pulse = undefined;
  off.set(new Set());
  holds.clear();
  notices.set(new Map());
  recents.set(new Map());
}

/* ---------- forms that hold something typed ---------- */

/** A form with input a change must not overwrite, other than the record draft (write.js): a command form on a record. */
export interface Editing {
  readonly table: string;
  readonly key: Readonly<Record<string, unknown>>;
}
/* Each open form's own reading of what it holds: nothing while it is untouched (its starting values may still follow
   the record), the records it acts on once something is typed. */
const editing = new Set<() => Editing | readonly Editing[] | undefined>();
export const editingRecords = (): Editing[] => [...editing].flatMap((read) => read() ?? []);
/**
 * Register a form holding typed input: while `read` names a record, a change to it is not read over the form (its
 * record, its fields, its prepared starting values) and raises the notice instead (liveInvalidate.ts). Returns the
 * way to let go, which the form calls when it closes.
 */
export function registerEditing(read: () => Editing | readonly Editing[] | undefined): () => void {
  editing.add(read);
  return () => void editing.delete(read);
}
