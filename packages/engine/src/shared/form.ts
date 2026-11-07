import { stateStampColumn, type ColumnMeta, type TableMeta } from './schema.js';

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

/* Stamps of a row's own life, by their names: when it was entered, when it was last touched. */
const STAMP = /^(sys_)?(created|inserted|added|entered|updated|modified|changed|last_updated)(_at|_on|_date|_time)?$/i;
/* A default that hands out the next number: a sequence's, an engine's own counter. */
const NUMBERED = /\bnextval\s*\(|\bauto_?increment\b/i;
/* When a record was entered, by the words people use for it: a ticket's `opened_at`, a note's `created_at`. */
const ENTERED = /^(created|opened|raised|logged|reported|entered|inserted|added)(_at|_on|_date)?$/i;

/** A machine as a New form reads it: its column and its states' stored values. */
interface FormMachine {
  column: string;
  since?: string;
  states: readonly string[];
}

const dated = (column: ColumnMeta) => /date|time/i.test(column.type ?? '') || /_(at|on)$/.test(column.name);
const defaulted = (column: ColumnMeta) => column.default !== undefined || column.hasDefault === true;

/**
 * The columns a New form leaves to the database and the App's machine, where the App's form does not name them: a
 * moment the database stamps (a timestamp with a default, or a creation or upkeep stamp with one), a number a
 * sequence hands out, and a state's own stamp (`completed_at` beside a `completed` state), which the platform
 * writes as the record enters the state (stateStampColumn) — a new record starts in its first one. None of these is
 * the creator's to say, and a form that asked for them asked a person to invent a value the system keeps. Each stays
 * on the record, editable there where it is writable. A day with a default (an invoice's date, today unless said)
 * is the creator's, and stays asked.
 */
export function platformWritten(table: TableMeta, machine?: FormMachine): Set<string> {
  const written = new Set<string>();
  for (const column of table.columns) {
    if (column.primaryKey || column.references) continue;
    if (defaulted(column) && dated(column) && (/time|datetime/i.test(column.type ?? '') || STAMP.test(column.name)))
      written.add(column.name);
    else if (column.default !== undefined && NUMBERED.test(column.default)) written.add(column.name);
  }
  if (machine) {
    if (machine.since) written.add(machine.since);
    for (const state of machine.states) {
      const stamp = stateStampColumn(state, table.columns, machine);
      if (stamp) written.add(stamp.name);
    }
  }
  return written;
}

/**
 * The columns a New form starts at now where nothing else starts them: a required stamp of when the record was
 * entered (`opened_at`, `created_at`) with no default of the database's or the form's. The form still asks it, so a
 * record entered late can say when it really was; it no longer asks a person to type the moment they are in.
 */
export function enteredNow(columns: readonly ColumnMeta[], defaults: Readonly<Record<string, unknown>>): ColumnMeta[] {
  return columns.filter(
    (column) =>
      !column.primaryKey &&
      !column.references &&
      column.nullable === false &&
      !defaulted(column) &&
      !Object.hasOwn(defaults, column.name) &&
      ENTERED.test(column.name) &&
      dated(column),
  );
}
