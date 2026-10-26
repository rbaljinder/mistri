/**
 * One host per grid row, so a presentation can decorate a row without
 * replacing the grid.
 *
 * The queue's selection had to be a list of its own because nothing could
 * put a control *into* a grid row from outside the grid: the rows are the
 * grid's, drawn from its own row model, and the only way in was another
 * prop threaded through TableRoom, Rows and TableView into Grid for every
 * new kind of decoration. This is the other way in. The grid gives each
 * row it can identify one element — the leading cell, the column the
 * expander already occupies, so nothing shifts — and publishes them in a
 * store keyed by the row's primary key. A decoration anywhere under the
 * same scope portals into the host for its key, and its state, its
 * queries and its context stay where it was declared.
 *
 * Keys are strings, spelled exactly as `bulkKey` spells them, so a
 * selection made on the grid and a selection made in a queue are the same
 * set. A value is never run through `Number()`: an id past 2^53 arrives as
 * a string and a rounded one would name a different row.
 *
 * A host keeps its identity for as long as its row does. The grid keys its
 * rows by the same string, so a refetch that reorders, adds or drops rows
 * moves the surviving rows' elements instead of redrawing them, and a
 * portal into a surviving row is never unmounted. A row that leaves the
 * result takes its host with it, and the decoration's portal goes too.
 */
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';

type RowHostMap = ReadonlyMap<string, HTMLElement>;

export interface RowHostStore {
  /** The hosts drawn now. The same object until one arrives or leaves. */
  hosts(): RowHostMap;
  subscribe(listener: () => void): () => void;
  /** The grid's side: a stable ref callback for the host of one row. */
  ref(key: string): (element: HTMLElement | null) => (() => void) | undefined;
  /** The header row's leading cell, where what speaks for every row goes (select all). */
  head(): HTMLElement | null;
  /** The grid's side of it: one stable ref callback. Not a key in `hosts()`, which is rows only. */
  headRef(element: HTMLElement | null): (() => void) | undefined;
}

const NONE: RowHostMap = new Map();

/**
 * A row's identity as a string, or null when the row cannot say which row
 * it is: no table, no key, a projection that dropped a key column, or a
 * null in the key (NULL is equal to nothing in SQL, so it identifies
 * nothing here either, and must not collide with the text 'null').
 */
export function rowKeyString(table: TableMeta | undefined, row: Record<string, unknown>): string | null {
  if (!table) return null;
  const columns = primaryKey(table);
  if (!columns.length) return null;
  const parts: Array<[string, string]> = [];
  for (const column of columns) {
    const value = row[column];
    if (value === undefined || value === null) return null;
    parts.push([column, String(value)]);
  }
  return JSON.stringify(parts);
}

export function createRowHosts(): RowHostStore {
  const live = new Map<string, HTMLElement>();
  const refs = new Map<string, (element: HTMLElement | null) => (() => void) | undefined>();
  const listeners = new Set<() => void>();
  let snapshot: RowHostMap | null = NONE;
  let head: HTMLElement | null = null;
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  const changed = () => {
    snapshot = null;
    tell();
  };
  return {
    hosts: () => (snapshot ??= new Map(live)),
    head: () => head,
    /* The rows' snapshot is left alone: the header arriving is no reason for
       every row's decoration to be handed a new map. */
    headRef(element) {
      if (!element) return undefined;
      if (head !== element) {
        head = element;
        tell();
      }
      return () => {
        if (head !== element) return;
        head = null;
        tell();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ref(key) {
      /* Stable per key: a fresh callback on every render would make React
         detach and re-attach every host on every paint, and every
         decoration would be told about it. */
      let callback = refs.get(key);
      if (!callback) {
        callback = (element) => {
          if (!element) return undefined;
          if (live.get(key) !== element) {
            live.set(key, element);
            changed();
          }
          return () => {
            /* Only this element's own departure: a remounted row may already
               have put its new host under the same key. */
            if (live.get(key) !== element) return;
            live.delete(key);
            refs.delete(key);
            changed();
          };
        };
        refs.set(key, callback);
      }
      return callback;
    },
  };
}

const Scope = createContext<RowHostStore | null>(null);

/**
 * Where a grid publishes its hosts. A grid under a scope registers its rows
 * in it and draws the leading cell on every row; one without draws the cell
 * only when it has something of its own to put there (the expander). A grid
 * hands its own subtree — the rows it opens in place — a null scope, so a
 * nested grid never publishes into its parent's.
 */
export function RowHostScope({ store, children }: { store: RowHostStore | null; children: ReactNode }) {
  return <Scope.Provider value={store}>{children}</Scope.Provider>;
}

/** A scope with its own store, for a presentation that decorates the grid under it. */
export function RowHosts({ children }: { children: ReactNode }) {
  const [store] = useState(createRowHosts);
  return <RowHostScope store={store}>{children}</RowHostScope>;
}

export const useRowHostScope = (): RowHostStore | null => useContext(Scope);

const TrailScope = createContext<RowHostStore | null>(null);

/**
 * The second host a row can have: its trailing cell, at the far end, where a
 * row's own menu sits. The same store and the same keys as the leading host;
 * a grid draws the cell only under a trailing scope, and hands the rows it
 * opens in place a null one, as it does the leading scope.
 */
export function RowTrailScope({ store, children }: { store: RowHostStore | null; children: ReactNode }) {
  return <TrailScope.Provider value={store}>{children}</TrailScope.Provider>;
}

/** A trailing scope with its own store, for a decoration at the end of each row. */
export function RowTrailHosts({ children }: { children: ReactNode }) {
  const [store] = useState(createRowHosts);
  return <RowTrailScope store={store}>{children}</RowTrailScope>;
}

export const useRowTrailScope = (): RowHostStore | null => useContext(TrailScope);

/**
 * The hosts a grid has drawn, re-read whenever one arrives or leaves.
 *
 * Subscribed in a layout effect rather than through useSyncExternalStore,
 * which subscribes after paint: the hosts are attached in the grid's commit,
 * and a decoration that learnt of them a frame later would paint the rows
 * without it first. Grids paint complete (docs/design.md, "data does not
 * dance"), so the decoration lands in the same frame as its row.
 */
export function useRowHosts(store?: RowHostStore | null): RowHostMap {
  const scoped = useRowHostScope();
  const source = store === undefined ? scoped : store;
  const [hosts, setHosts] = useState<RowHostMap>(() => source?.hosts() ?? NONE);
  useLayoutEffect(() => {
    if (!source) {
      setHosts(NONE);
      return undefined;
    }
    const read = () => setHosts(source.hosts());
    read();
    return source.subscribe(read);
  }, [source]);
  return source ? hosts : NONE;
}

/**
 * Children drawn into one row's host, for as long as that row is in the
 * result. Nothing is drawn while the row is not (yet) on screen — a
 * windowed grid draws only the rows in view — and the children arrive when
 * it scrolls in.
 */
export function RowDecoration({ rowKey, store, children }: { rowKey: string; store?: RowHostStore | null; children: ReactNode }) {
  const host = useRowHosts(store).get(rowKey);
  return host ? createPortal(children, host, rowKey) : null;
}

/** The header's leading cell, re-read as it arrives or leaves — in a layout effect, as the rows' hosts are. */
function useRowHead(store?: RowHostStore | null): HTMLElement | null {
  const scoped = useRowHostScope();
  const source = store === undefined ? scoped : store;
  const [head, setHead] = useState<HTMLElement | null>(() => source?.head() ?? null);
  useLayoutEffect(() => {
    if (!source) {
      setHead(null);
      return undefined;
    }
    const read = () => setHead(source.head());
    read();
    return source.subscribe(read);
  }, [source]);
  return source ? head : null;
}

/**
 * Children drawn into the header row's leading cell: the one place a
 * decoration speaks for every row, as the select-all box every table has
 * does, above the rows' own boxes in the same column.
 */
export function RowHeadDecoration({ store, children }: { store?: RowHostStore | null; children: ReactNode }) {
  const head = useRowHead(store);
  return head ? createPortal(children, head, 'head') : null;
}
