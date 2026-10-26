import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { say } from './copy/record/recordEditValidation.js';

/** Transient editor state, never values sent to the server. In particular,
 * reference search text is not a selected foreign key. */
export interface RecordEditControlState {
  readonly unresolvedReference?: boolean;
  readonly invalidInput?: boolean;
}

/** Preflight for a complete staged update, not a New-form omission check.
 * Untouched fields are not required again; database defaults cannot replace a
 * cleared existing value. This is feedback, not authorization or SQL validation.
 * The caller owns the current schema/draft and sends none of a rejected snapshot. */
export function validateRecordEdits(
  table: TableMeta,
  values: Readonly<Record<string, unknown>>,
  controls: Readonly<Record<string, RecordEditControlState>> = {},
): Readonly<Record<string, string>> {
  const errors: Record<string, string> = Object.create(null);
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const names = new Set([
    ...Object.keys(values),
    ...Object.keys(controls).filter((name) => controls[name].unresolvedReference || controls[name].invalidInput),
  ]);
  // Catalog order supplies deterministic first-error focus, not edit order.
  for (const name of [...columns.keys(), ...[...names].filter((name) => !columns.has(name))]) {
    if (!names.has(name)) continue;
    const column = columns.get(name);
    const control = Object.hasOwn(controls, name) ? controls[name] : undefined;
    /* A row-defined field (`specs.capacity`) is judged by the server against
       its definition; here only its box can be unreadable. */
    if (!column && columns.get(name.split('.')[0])?.writable !== false && columns.has(name.split('.')[0]) && !table.isView) {
      if (control?.invalidInput) errors[name] = say('common.enterAValidValue');
      continue;
    }
    if (!column || column.writable === false || table.isView) {
      errors[name] = say('thisFieldIsNoLonger');
    } else if (control?.unresolvedReference) {
      errors[name] = say('common.chooseARecordOrClear');
    } else if (control?.invalidInput) {
      errors[name] = say('common.enterAValidValue');
    } else if (Object.hasOwn(values, name)) {
      const value = values[name];
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        (typeof value !== 'number' || !Number.isFinite(value))
      ) {
        errors[name] = say('common.enterAValidValue');
      } else if ((value === null || value === '') && !column.nullable) {
        errors[name] = say('common.required');
      } else if (value !== null && column.allowed !== undefined && !column.allowed.includes(String(value))) {
        errors[name] = say('chooseOneOfTheAvailable');
      }
    }
  }
  return Object.freeze(errors);
}
