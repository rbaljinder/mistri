/**
 * The column a card's or a queue's said value dresses as: the row's own
 * column, a rollup of the row (rollups.ts), or through one reference the
 * target's column or rollup (`category_id.products`). A path keeps its full
 * name, which is what the answer's row is keyed by and what the App's
 * display rules and captions are written against.
 */
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { rollupColumnMeta } from '@mistriwork/engine/shared/rollups.js';
import { computedColumnMeta } from '@mistriwork/engine/shared/computed.js';
import { findTable, refsFrom } from '../core.js';

const own = (table: TableMeta, name: string): ColumnMeta | undefined =>
  table.columns.find((column) => column.name === name) ??
  (table.rollups && Object.hasOwn(table.rollups, name) ? rollupColumnMeta(name, table.rollups[name]) : undefined) ??
  (table.computed && Object.hasOwn(table.computed, name) ? computedColumnMeta(name, table.computed[name]) : undefined);

export function listColumn(table: TableMeta, name: string | undefined): ColumnMeta | undefined {
  if (!name) return undefined;
  if (!name.includes('.')) return own(table, name);
  const [reference, terminal] = name.split('.');
  const fk = refsFrom(table.id).find((candidate) => candidate.from.columns.length === 1 && candidate.from.columns[0] === reference);
  const target = fk ? (findTable(fk.to.table) as TableMeta | undefined) : undefined;
  const column = target && own(target, terminal);
  return column ? { ...column, name } : undefined;
}

/**
 * What a card or a queue says for `name` in one row: where `name` is a
 * reference the list fetched a name for (appListModel's referenceNames), the
 * record's name, dressed as the column it is read from — `partner_id` said as
 * `partner_id.code` — or, for a computed name (`$label`), as plain text. A
 * reference whose name did not come back is said by its key, as before.
 */
export function namedCell(
  table: TableMeta,
  name: string,
  row: Record<string, unknown>,
  referenceLabels?: Record<string, string>,
): { column: ColumnMeta | undefined; value: unknown } {
  const at = referenceLabels && Object.hasOwn(referenceLabels, name) ? referenceLabels[name] : undefined;
  const named = at === undefined ? undefined : row[at];
  if (at === undefined || named === null || named === undefined || named === '')
    return { column: listColumn(table, name), value: row[name] };
  return { column: listColumn(table, at) ?? { name: at, type: 'text', nullable: true, primaryKey: false }, value: named };
}
