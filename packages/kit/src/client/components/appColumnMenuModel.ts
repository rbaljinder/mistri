/**
 * What an App list's column menu offers, before anything is drawn.
 *
 * The Workbench's header menu (ThMenu.tsx) is a power tool: every condition
 * the language has, sampled values, the language itself beside each entry.
 * In an App that was a dozen entries and a scrollbar under a reader who
 * wanted the column sorted or narrowed. So an App's menu has at most five:
 * the two sorts, worded by what the column holds; one Filter… that opens the
 * rail's own control for the column; Clear filter while there is one; and
 * Pin column, last. Pure, so the menu and its tests read one rule.
 */
import { columnKind, type ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { say as sayCopy } from '../copy/columnMenu/components/appColumnMenuModel.js';

export type AppMenuKey = 'asc' | 'desc' | 'filter' | 'clear' | 'pin';
interface AppMenuEntry {
  key: AppMenuKey;
  label: string;
  detail?: string;
}

/**
 * The words the two sorts say, fitted to what the column holds: text reads
 * A → Z, a figure Low → high, a date Oldest first. A flag and a vocabulary
 * name their ends — `No → Yes`, `New → Lost` — in the words the list shows
 * them by: a vocabulary sorts in the order it was declared, a native enum by
 * the engine and one over text through the read's ORDER BY (schema.ts
 * `declaredOrder`), so a pipeline reads as one rather than A → Z.
 */
export function sortWords(
  kind: string,
  meta: (Pick<ColumnMeta, 'type'> & { allowed?: readonly string[] }) | undefined,
  say: (value: string) => string = (value) => value,
): readonly [asc: string, desc: string] {
  const allowed = meta?.allowed;
  if (allowed && allowed.length > 1) {
    const [first, last] = [say(allowed[0]), say(allowed[allowed.length - 1])];
    return [`${first} → ${last}`, `${last} → ${first}`];
  }
  if (kind === 'boolean') {
    const [no, yes] = [say('false'), say('true')];
    return [`${no} → ${yes}`, `${yes} → ${no}`];
  }
  if (kind === 'date') return [sayCopy('oldestFirst'), sayCopy('newestFirst')];
  if (kind === 'number' || (meta && columnKind(meta.type) === 'number')) return [sayCopy('lowHigh'), sayCopy('highLow')];
  return ['A → Z', 'Z → A'];
}

interface EntryInput {
  words: readonly [string, string];
  /** Whether the header may sort this column at all (an index, a small table, an API's `sortable`). */
  sortable: boolean;
  /** The order the list is in on this column now, explicit or the default one. */
  current: 'asc' | 'desc' | null;
  /** Whether the column takes a filter (a real column; over an API, one it documents). */
  filterable: boolean;
  /** Whether the reader's question narrows this column beyond the lit tab. */
  filtered: boolean;
  /** What Clear filter takes off, in the reader's words: "Status is not Done". */
  cleared?: string;
  pinned: boolean;
}

/** The menu, in order. An entry that repeats the current sort is dropped: it would do nothing. */
export function appMenuEntries({ words, sortable, current, filterable, filtered, cleared, pinned }: EntryInput): AppMenuEntry[] {
  const entries: AppMenuEntry[] = [];
  if (sortable && current !== 'asc') entries.push({ key: 'asc', label: words[0] });
  if (sortable && current !== 'desc') entries.push({ key: 'desc', label: words[1] });
  if (filterable) entries.push({ key: 'filter', label: sayCopy('filterMore') });
  if (filterable && filtered) entries.push({ key: 'clear', label: sayCopy('clearFilter'), ...(cleared ? { detail: cleared } : {}) });
  entries.push({ key: 'pin', label: pinned ? sayCopy('unpinColumn') : sayCopy('pinColumn') });
  return entries;
}
