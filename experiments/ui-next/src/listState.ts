import type { Sort } from './DataTable';

/* Where a reader stands in a list: the tab, the words searched, the filters chosen, the order and the page. A list
   that keeps this only in memory forgets it the moment the reader opens a row and comes back, which is the most
   common thing a reader of a list does. So a caller may hold it (in the address, usually), and these two functions
   say it as the words an address carries and read it back. */
export type ListState = {
  tab: string | null;
  search: string;
  filters: Record<string, string[]>;
  sort: Sort | null;
  page: number;
  /* The columns shown, by id and in order, when the reader has changed them; absent, the list's own. */
  columns?: string[] | null;
};

/* A filter's values in one word. The comma joins them, as mistri's own addresses do (`make=Toyota,Honda`), so a
   value that holds one says it with a backslash. */
const join = (values: string[]): string => values.map((value) => value.replace(/[\\,]/g, '\\$&')).join(',');
const split = (word: string): string[] =>
  (word.match(/(?:\\.|[^,\\])+/g) ?? []).map((value) => value.replace(/\\(.)/g, '$1')).filter((value) => value !== '');

/* The state as address words. A word left out is the list's own default, so the address of an untouched list is
   bare; `undefined` asks the caller to take that word away. */
export function listStateToWords(state: ListState, filterIds: string[], first?: Partial<ListState>): Record<string, string | undefined> {
  const sort = state.sort ? `${state.sort.descending ? '-' : ''}${state.sort.column}` : undefined;
  const firstSort = first?.sort ? `${first.sort.descending ? '-' : ''}${first.sort.column}` : undefined;
  const words: Record<string, string | undefined> = {
    tab: state.tab && state.tab !== (first?.tab ?? null) ? state.tab : undefined,
    search: state.search.trim() || undefined,
    sort: sort !== firstSort ? sort : undefined,
    page: state.page > 1 ? String(state.page) : undefined,
    cols: state.columns?.length ? join(state.columns) : undefined,
  };
  for (const id of filterIds) words[id] = state.filters[id]?.length ? join(state.filters[id]) : undefined;
  return words;
}

export function listStateFromWords(read: (word: string) => string | undefined, filterIds: string[]): Partial<ListState> {
  const state: Partial<ListState> = {};
  const tab = read('tab');
  if (tab) state.tab = tab;
  const search = read('search');
  if (search) state.search = search;
  const sort = read('sort');
  if (sort) state.sort = sort.startsWith('-') ? { column: sort.slice(1), descending: true } : { column: sort, descending: false };
  const page = Number(read('page'));
  if (Number.isInteger(page) && page > 1) state.page = page;
  const cols = read('cols');
  if (cols) state.columns = split(cols);
  const filters: Record<string, string[]> = {};
  for (const id of filterIds) {
    const word = read(id);
    if (word) filters[id] = split(word);
  }
  if (Object.keys(filters).length) state.filters = filters;
  return state;
}
