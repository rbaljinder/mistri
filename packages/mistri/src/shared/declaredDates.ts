/**
 * A TEXT column an App declares a date (`types: { due_on: 'date' }`).
 *
 * A column's kind comes from its declared type (schema.ts, columnKind), and
 * SQLite changes a declared type only by rebuilding the table, so a TEXT
 * column of ISO strings — idiomatic there, since SQLite has no date type —
 * could not be windowed, put on a timeline or a calendar, or offered date
 * presets. The App's catalog says what the database cannot: the column's type
 * reads `TEXT as date`, which every rule keyed on the declared type reads as a
 * date. The comparisons stay what SQLite runs for a DATE column anyway, text
 * against an ISO bound (query.ts, bindDate), and a period bucket is the same
 * `strftime` — carried to the database's compiler, whose own catalog still
 * says TEXT (breakdown.ts, `dateColumns`).
 */
import { columnKind, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { DeclaredDate } from './appModel.js';

/** Whether a column's declared type can be declared a date: text, or none (a SQLite column may have no type). */
const declarableAsDate = (type: string): boolean => ['text', 'other'].includes(columnKind(type)) && !/blob|bytea|binary/i.test(type);

/** The catalog with each declared column typed a date, on SQLite, where its declared type is text. */
export function withDeclaredDates(schema: DatabaseSchema, dates: readonly DeclaredDate[]): DatabaseSchema {
  if (!dates.length || schema.dialect !== 'sqlite') return schema;
  return {
    ...schema,
    tables: schema.tables.map((table) => {
      const mine = dates.filter((date) => date.table === table.id);
      if (!mine.length) return table;
      return {
        ...table,
        columns: table.columns.map((column) => {
          const declared = mine.find((date) => date.column === column.name);
          return declared && declarableAsDate(column.type) ? { ...column, type: `${column.type || 'TEXT'} as ${declared.as}` } : column;
        }),
      };
    }),
  };
}
