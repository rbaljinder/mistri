import { Refusal, WriteConflict } from '@mistriwork/engine/adapters/adapter.js';
import { PathError } from '@mistriwork/engine/shared/view.js';
import { AppAccessDenied } from './appAccess.js';
import { AppValidationDenied, ConsumesRefused } from './appValidationDenied.js';
import { constraintColumns, dataException, wrongTypeValue } from '@mistriwork/engine/server/constraints.js';

interface AppError {
  code:
    | 'validation_failed'
    | 'consumes_refused'
    | 'record_conflict'
    | 'required_value'
    | 'duplicate_value'
    | 'reference_conflict'
    | 'constraint_failed'
    | 'data_unavailable'
    | 'write_unconfirmed'
    | 'forbidden';
  message: string;
  /** Safe field references only; never a value, rule message or row image. */
  fields?: readonly { field: string; message: string }[];
  /** The column names a refusal's message quotes, for the App to say in its captions; names only, never values. */
  columns?: readonly string[];
}

/* Its rule is the engine's (constraints.ts): the database browser answers it with the same 400. */
export { wrongTypeValue } from '@mistriwork/engine/server/constraints.js';

/** Driver messages, details and stacks can contain SQL, values and credentials.
 * Only structured engine codes select public text; messages are never scrubbed. The one thing taken from what an
 * engine said is a column's name, from the parts each engine fills with names alone (constraints.ts), never a value. */
export function appError(
  error: unknown,
  operation: 'read' | 'write' = 'read',
  completed = false,
  /** What the App calls a column (columnCaption), for the sentence that names it. */
  caption?: (column: string) => string,
): AppError {
  if (completed) return unconfirmed();
  if (error instanceof AppAccessDenied) return { code: 'forbidden', message: error.message };
  if (error instanceof WriteConflict) return { code: 'record_conflict', message: error.message };
  if (error instanceof Refusal || error instanceof PathError) {
    if (error instanceof AppValidationDenied && operation === 'write' && error.fields.length) {
      return {
        /* A line's `consumes` refusing is the stock, not the value: said with its own code and sentence. */
        code: error instanceof ConsumesRefused ? 'consumes_refused' : 'validation_failed',
        message: error.message,
        fields: error.fields.map((field) => ({
          field,
          message: error.reasons[field] ?? 'This value does not meet the application rules.',
        })),
      };
    }
    return {
      code: 'validation_failed',
      message: error.message,
      ...(error instanceof Refusal && error.columns ? { columns: error.columns } : {}),
    };
  }
  const { code, errcode } = error && typeof error === 'object' ? (error as { code?: unknown; errcode?: unknown }) : {};
  /* A rule the database enforced on a write, with the column it names when the engine names one: said beside that
     field in plain words, and by its caption in the sentence above the form (constraints.ts reads names, never values). */
  const broke = operation === 'write' ? constraintColumns(error) : undefined;
  const fieldsOf = (message: string) => (broke && !broke.parent ? { fields: broke.columns.map((field) => ({ field, message })) } : {});
  const named = broke && !broke.parent ? broke.columns.map((column) => caption?.(column) ?? column).join(' and ') : undefined;
  const said = named && named.charAt(0).toUpperCase() + named.slice(1);
  const within = named && (/^[A-Z][a-z]/.test(named) ? named.charAt(0).toLowerCase() + named.slice(1) : named);
  if (code === '23502' || errcode === 1299) {
    return said
      ? { code: 'required_value', message: `${said} is required. Fill it in and try again.`, ...fieldsOf('This is required.') }
      : { code: 'required_value', message: 'A required value is missing. Complete the required fields and try again.' };
  }
  if (code === '23505' || errcode === 1555 || errcode === 2067) {
    return said
      ? {
          code: 'duplicate_value',
          message: `Another record already has this ${within}. Use a different value and try again.`,
          ...fieldsOf('Another record already has this value.'),
        }
      : { code: 'duplicate_value', message: 'A record with these unique values already exists. Use different values and try again.' };
  }
  if (code === '23503' || errcode === 787) {
    if (broke?.parent)
      return { code: 'reference_conflict', message: 'Other records still point at this one. Change or remove them first, then try again.' };
    return said
      ? {
          code: 'reference_conflict',
          message: `The ${within} chosen is not a record that exists. Choose another and try again.`,
          ...fieldsOf('Choose a record that exists.'),
        }
      : { code: 'reference_conflict', message: 'A related record is missing or still in use. Check the relationships and try again.' };
  }
  if (code === '23514' || code === '23P01' || errcode === 275) {
    return said
      ? {
          code: 'constraint_failed',
          message: `${said} is not an allowed value. Change it and try again.`,
          ...fieldsOf('This value is not allowed.'),
        }
      : { code: 'constraint_failed', message: 'These values do not meet the record requirements. Review them and try again.' };
  }
  if (wrongTypeValue(error))
    return {
      code: 'validation_failed',
      message: 'A value given is not one its column holds: a number column takes a number, a date column a date. Change it and try again.',
    };
  /* Any other value PostgreSQL could not take as given (class 22: text past its length, a NUL, a number out of its
     range): refused for good and the request's to change, never "unconfirmed" — nothing was written. */
  if (operation === 'write' && dataException(error))
    return { code: 'validation_failed', message: 'A value given does not fit its field. Change it and try again.' };
  return operation === 'write' ? unconfirmed() : { code: 'data_unavailable', message: 'The data could not be loaded. Try again shortly.' };
}

/**
 * A refused App write, as appError says it, with the engine's own words on the operator's stderr: the person reads
 * a sentence chosen by code, and the driver's message (which may hold values and SQL) is the operator's alone.
 */
export function appWriteError(error: unknown, completed: boolean, caption?: (column: string) => string): AppError {
  const failure = appError(error, 'write', completed, caption);
  const cause = error instanceof Error ? error.message : String(error);
  console.error(`mistri: an App write was refused (${failure.code})${cause ? `\n  because: ${cause}` : ''}`);
  return failure;
}

function unconfirmed(): AppError {
  return {
    code: 'write_unconfirmed',
    message: 'The change could not be confirmed. Reload to check the current state before trying again.',
  };
}
