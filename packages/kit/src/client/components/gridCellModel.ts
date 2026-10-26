/**
 * Which cells of a list are edited in place, and the shape a cell's editor
 * draws through. Apart from the editor (GridCellEditor.tsx), which is
 * loaded the first time a list that edits is drawn: every list asks which
 * of its cells edit, and most answer none.
 */
import type { ReactNode } from 'react';
import { refsFrom } from '../core.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';

/** How a cell draws a value: with no argument, as the grid drew it; with one, another value in the same dress. */
export type CellDraw = (next?: { value: unknown; label?: unknown }) => ReactNode;

/** A column as an editor sees it: the catalog's, with the vocabulary it pins. */
export type EditColumn = ColumnMeta & { allowed?: string[] };

/**
 * The cells of a list a reader may edit in place, each drawn column to the
 * column it writes: the view's `editable` (every shown column, or those
 * named) narrowed to the table's own columns this reader's catalog says are
 * writable — never the key, never one the resource's transitions give to its
 * actions, never a document or bytes. A reference shown by its record's name
 * (`owner_id.name`) is edited as the reference (`owner_id`), with the picker
 * a record form uses, since the name is the other record's. The server
 * refuses the rest anyway; these are the ones worth offering.
 */
export function editableCells(
  table: TableMeta | undefined,
  editable: true | readonly string[] | undefined,
  shown: readonly string[],
): Map<string, string> {
  const cells = new Map<string, string>();
  if (!table || !editable || table.isView) return cells;
  for (const drawn of shown) {
    const hop = drawn.indexOf('.');
    const local = hop < 0 ? drawn : drawn.slice(0, hop);
    const column = table.columns.find((c) => c.name === local);
    // A path edits only through a one-hop reference of one column: anything further is another record's value.
    if (!column || (hop >= 0 && (!column.references || drawn.indexOf('.', hop + 1) >= 0 || !singleReference(table, column)))) continue;
    if (editable !== true && !editable.includes(local)) continue;
    if (
      column.primaryKey ||
      column.writable === false ||
      column.changesBy === 'actions' ||
      /json|blob|bytea|binary/i.test(column.type ?? '')
    )
      continue;
    cells.set(drawn, local);
  }
  return cells;
}

/** The columns a list's cells write, once each, in the order drawn: what "Set field…" offers. */
export function editableColumns(
  table: TableMeta | undefined,
  editable: true | readonly string[] | undefined,
  shown: readonly string[],
): string[] {
  return [...new Set(editableCells(table, editable, shown).values())];
}

/** A reference's only when it is one column: a composite key is not chosen by one picker. */
export function singleReference(table: TableMeta, column: EditColumn): boolean {
  return (
    Boolean(column.references) &&
    !refsFrom(table.id).some((fk: { from: { columns: string[] } }) => fk.from.columns.length > 1 && fk.from.columns.includes(column.name))
  );
}
