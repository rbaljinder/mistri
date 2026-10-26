import type { ColumnMeta, TableMeta } from './schema.js';

/** The explicit selection wins; otherwise steps declare the form's fields
 * in order. Groups only arrange fields and do not narrow a schema-derived form. */
export function formShownFields(
  form:
    | {
        show?: readonly string[];
        steps?: readonly { fields: readonly string[] }[];
      }
    | undefined,
): readonly string[] | undefined {
  return form?.show ?? form?.steps?.flatMap((step) => step.fields);
}

/** A single key that can be omitted because the catalog promises a value. */
export function autoKey(table: TableMeta): string | null {
  const pk = table.columns.filter((c) => c.primaryKey);
  return pk.length === 1 && (pk[0].identity || pk[0].default !== undefined || pk[0].hasDefault === true) ? pk[0].name : null;
}

/** Omitting this column cannot rely on a database default or assigned key. */
export function isRequired(column: ColumnMeta, assigned: string | null): boolean {
  return !column.nullable && column.default === undefined && column.hasDefault !== true && !column.identity && column.name !== assigned;
}

/**
 * The columns a new row must be given and `writes` does not write: while any
 * is left, every New form of those fields is refused by the database, so none
 * is offered (accessibleSchema) and `mistri check` says which. Judged on
 * the whole catalog, since a column the writer cannot even read is one it
 * cannot fill either.
 */
export function unformedColumns(table: TableMeta, writes: (column: string) => boolean): string[] {
  const assigned = autoKey(table);
  return table.columns.filter((column) => isRequired(column, assigned) && !writes(column.name)).map((column) => column.name);
}
