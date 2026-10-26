/**
 * Columns that stay put when a wide table scrolls sideways.
 *
 * A twenty-seven column table is wider than any window, so reading the right
 * of it means scrolling the left of it away — and the left of it is where the
 * key and the name live. Three columns in you are looking at values with
 * nothing to attach them to, and the only way back is to scroll left, read the
 * name, and scroll right again holding it in your head.
 *
 * Pinning is the fix every spreadsheet arrived at, and the reason it belongs
 * here rather than in a preference nobody finds is that tablewalk already knows
 * which columns identify a row: the primary key, and the label column it uses
 * for breadcrumbs. Those are pinned without being asked for, on tables wide
 * enough to need it, and anything else is one click in the column menu.
 *
 * What is pinned lives here; how it is frozen in place is the grid's
 * (components/usePins.ts), which measures the columns after layout.
 */
import { labelColumn, loadJson, primaryKey, saveJson, state } from './core.js';

const KEY = 'mistri.pins.v1';

/**
 * Below this many columns, pinning is a border and a shadow for no gain.
 *
 * The number is about the *window* rather than the table: eight columns of
 * ordinary width fit, and the ones that do not are exactly the tables where
 * losing the key hurts.
 */
const WIDE_ENOUGH = 8;

const connectionKey = () => state.activeConnection ?? 'default';

/* An App list keeps its own pins, apart from its table's: two views over one
   table are two lists a reader arranges separately. The store is the
   browser's, scoped to the signed-in account (captureScopedStorage), so a
   pin is one reader's arrangement and never what another reader sees. */
const storeKey = (table, list) => (list ? `list:${list}` : table.id);

function stored() {
  return loadJson(KEY, {})[connectionKey()] ?? {};
}

/* A pin changed: the grid that reads them draws again (useSyncExternalStore). */
let version = 0;
const listeners = new Set();
export const pinsVersion = () => version;
/** @param {() => void} listener */
export function subscribePins(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The columns pinned for a table: what was chosen, or what identifies a row.
 *
 * The derived default is not written to storage. Storing it would freeze
 * today's guess against a schema that may gain a better label column, and it
 * would make "I have never touched this" indistinguishable from "I chose
 * exactly this".
 *
 * @param {any} table
 * @param {string[]} columns
 * @param {string} [list] An App list's key: its own pins rather than its table's.
 * @returns {string[]}
 */
export function pinnedFor(table, columns, list) {
  if (!table) return [];
  const chosen = stored()[storeKey(table, list)];
  if (chosen) return chosen.filter((c) => columns.includes(c));
  if (columns.length < WIDE_ENOUGH) return [];

  const key = primaryKey(table);
  const label = labelColumn(table);
  const wanted = [...key, ...(label && !key.includes(label) ? [label] : [])];
  return wanted.filter((c) => columns.includes(c));
}

/**
 * @param {any} table
 * @param {string[]} columns
 * @param {string} name
 * @param {string} [list]
 */
export function togglePin(table, columns, name, list) {
  if (!table) return;
  const current = pinnedFor(table, columns, list);
  const next = current.includes(name) ? current.filter((c) => c !== name) : [...current, name];

  /* Kept in column order rather than the order they were pinned in. Pinned
     columns are rendered as a block on the left, and a block whose internal
     order differs from the table's is a second thing to reconcile every time
     you read it. */
  const ordered = columns.filter((c) => next.includes(c));

  const all = loadJson(KEY, {});
  all[connectionKey()] = { ...(all[connectionKey()] ?? {}), [storeKey(table, list)]: ordered };
  saveJson(KEY, all);
  version += 1;
  for (const listener of [...listeners]) listener();
}
