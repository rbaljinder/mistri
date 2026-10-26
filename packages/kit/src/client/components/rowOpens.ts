/**
 * A list whose rows open another record (a view's `opens`): a join table's list, `ticket_watcher`,
 * opens the ticket each row is about rather than the watcher row, a page with nothing to do on it. Given by the App's
 * list (AppList.tsx) to the two places a grid's row is opened from — the grid and, on a phone, its summaries — so no
 * prop has to be threaded through the rooms between them.
 */
import { createContext, useContext } from 'react';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';

interface RowOpens {
  /** The reference column whose record a row opens. */
  column: string;
  /** The fetched path its record's name is read from, when the list shows it by name. */
  label?: string;
}

export const RowOpensContext = createContext<RowOpens | null>(null);

export const useRowOpens = () => useContext(RowOpensContext);

/**
 * The record a row opens under `opens`: the referenced table, keyed by the row's value. `null` when the row names
 * none — an empty reference opens nothing, rather than the row it was asked not to open.
 */
export function rowOpensTarget(
  table: TableMeta,
  row: Record<string, unknown>,
  opens: RowOpens,
): { table: string; key: Record<string, unknown>; label: string } | null {
  const ref = table.columns.find((column) => column.name === opens.column)?.references;
  const value = row[opens.column];
  if (!ref || value === null || value === undefined || value === '') return null;
  const named = opens.label ? row[opens.label] : undefined;
  return {
    table: ref.table,
    key: { [ref.column]: value },
    label: named == null || named === '' ? String(value) : String(named),
  };
}
