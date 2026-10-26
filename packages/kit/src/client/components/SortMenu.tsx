/**
 * A list's Sort menu: the orders the view offers (`sorts`), by name —
 * "Lowest price", "Newest" — beside the filters. The order is the query's
 * own `sort` clause, so the address carries it, a reload keeps it and a
 * saved view remembers it; choosing one replaces the clause, and "Default
 * order" takes it off. A sort the reader typed that matches no choice
 * leaves the menu on none of them rather than pretending it is one.
 */
import { joinQuery, splitQuery } from '../clauses.js';
import { squeeze } from '../filterbar.js';
import { Dropdown } from './Dropdown.js';
import { say } from '../copy/lists/components/SortMenu.js';

interface SortChoice {
  label: string;
  sort: string;
}

/** Which choice the query is sorted by, or -1. */
export function sortChoice(sorts: readonly SortChoice[], query: string): number {
  const current = squeeze(String((splitQuery(query) as { sort?: string }).sort ?? '')).toLowerCase();
  if (!current) return -1;
  const said = (sort: string) =>
    squeeze(`sort ${sort}`)
      .replace(/\s+asc\b/gi, '')
      .replace(/\s*,\s*/g, ', ')
      .toLowerCase();
  return sorts.findIndex((choice) => said(choice.sort) === said(current.replace(/^sort\s+/i, '')));
}

/** The query sorted by `sort`, or with no sort clause when there is none. */
export function withSort(query: string, sort: string | undefined): string {
  const parts = splitQuery(query) as { table: string; filter: string; show?: string; sort?: string; limit?: string };
  if (sort) parts.sort = `sort ${sort}`;
  else delete parts.sort;
  return joinQuery(parts);
}

/**
 * `sort` is the view's own order. Where one of the choices is it, that choice
 * is the default and is named: "Default order" beside "Newest listings" said
 * the same order twice, once in words a buyer does not use.
 */
export function SortMenu({
  sorts,
  query,
  onPick,
  sort,
}: {
  sorts: readonly SortChoice[];
  query: string;
  onPick: (query: string) => void;
  sort?: string;
}) {
  const at = sortChoice(sorts, query);
  const standing = sort ? sortChoice(sorts, say('xSort', { sort })) : -1;
  const unsorted = !(splitQuery(query) as { sort?: string }).sort;
  const items = sorts.map((choice, index) => ({ value: String(index), label: choice.label }));
  return (
    <div className="applist-sort">
      <span className="applist-sort-label" aria-hidden="true">
        {say('sort')}
      </span>
      <Dropdown
        ariaLabel={say('sort')}
        value={at >= 0 ? String(at) : standing >= 0 && unsorted ? String(standing) : ''}
        items={standing >= 0 ? items : [{ value: '', label: say('defaultOrder') }, ...items]}
        onChange={(value: string) =>
          onPick(withSort(query, value === '' || Number(value) === standing ? undefined : sorts[Number(value)]?.sort))
        }
      />
    </div>
  );
}
