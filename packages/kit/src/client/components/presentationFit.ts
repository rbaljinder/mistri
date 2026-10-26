/**
 * Whether a board, a calendar, a tree or a gantt chart can draw a list's answer.
 *
 * The list asks before it draws either, and falls back to the grid when the
 * answer is no. The questions live apart from the two components because
 * each is a chunk of its own (onDemand.tsx): a list decides what it is
 * without loading a board it will not draw.
 */
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppBoardList, AppCalendarList, AppGanttList, AppTreeList } from '@mistriwork/engine/shared/listPresentations.js';
import { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';

/** The answer carries every column the board reads, keys included. */
export function canShowBoard(table: TableMeta | undefined, columns: string[] | undefined, spec: AppBoardList): table is TableMeta {
  return Boolean(
    table && primaryKey(table).length && [...listPresentationColumns(spec), ...primaryKey(table)].every((name) => columns?.includes(name)),
  );
}

/** The month is asked by the calendar itself, so only the table is judged: its dates are its own
    columns, and a label path is judged by the reference it walks from. */
export function canShowCalendar(table: TableMeta | undefined, spec: AppCalendarList): table is TableMeta {
  return Boolean(
    table &&
    primaryKey(table).length &&
    [spec.date, ...(spec.end === undefined ? [] : [spec.end]), spec.primary.split('.')[0]].every((name) =>
      table.columns.some((column) => column.name === name),
    ),
  );
}

const hasColumns = (table: TableMeta, names: string[]) =>
  names.every((name) => table.columns.some((column) => column.name === name.split('.')[0]));

/** A tree asks for itself too; its parent names a record by a single-column key. */
export function canShowTree(table: TableMeta | undefined, spec: AppTreeList): table is TableMeta {
  return Boolean(table && primaryKey(table).length === 1 && hasColumns(table, [spec.parent, spec.primary]));
}

/** A gantt chart asks for itself; its dates are its own columns. */
export function canShowGantt(table: TableMeta | undefined, spec: AppGanttList): table is TableMeta {
  return Boolean(
    table &&
    primaryKey(table).length &&
    hasColumns(table, [spec.start, spec.end, spec.primary, ...(spec.by === undefined ? [] : [spec.by])]),
  );
}
