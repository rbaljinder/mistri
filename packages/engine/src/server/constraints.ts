/**
 * Turning a refused write into an answer.
 *
 * SQLite says `FOREIGN KEY constraint failed`. That is the whole message: no
 * column, no value, no target — on a table that may have six foreign keys.
 * Postgres names its constraint, so the same mistake is legible on one engine
 * and opaque on another, which is its own problem for anything meant to work
 * the same everywhere.
 *
 * tablewalk knows the graph. It knows `invoice.customer_id` points at
 * `customer.id`, it knows what value the caller sent, and on the failure path
 * it can afford one indexed lookup per candidate to find out which reference
 * has nothing behind it. So the answer becomes "customer_id = 9999 has no
 * matching customer.id", which is the difference between an agent retrying
 * usefully and an agent retrying the same statement.
 *
 * The engine's own words are kept in front. They are accurate, they are what
 * a person will search for, and a paraphrase that dropped them would be
 * throwing away the one part that is certainly true.
 */
import type { Adapter } from '../adapters/adapter.js';
import { findTable, referencesFrom, type DatabaseSchema } from '../shared/schema.js';

/** Every engine's way of saying a foreign key was not satisfied. */
const FOREIGN_KEY = /foreign key|violates foreign key constraint|a foreign key constraint fails/i;

type Values = Record<string, unknown>;

/** Which rule the engine says the write broke, or undefined where its error is
 * not a constraint violation this knows by code. One table for both
 * engines — SQLite's extended result codes and PostgreSQL's SQLSTATEs — so a caller asking "was this permanent?" and one
 * asking "which rule?" can never disagree. Error text is never consulted. */
type WriteFailureKind = 'unique' | 'reference' | 'required' | 'check';
export function writeFailureKind(error: unknown): WriteFailureKind | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  // PRIMARY KEY and UNIQUE; PostgreSQL's unique and exclusion; a duplicate key.
  if (errcode === 1555 || errcode === 2067 || code === '23505' || code === '23P01') return 'unique';
  if (errcode === 787 || code === '23503') return 'reference';
  if (errcode === 1299 || code === '23502') return 'required';
  if (errcode === 275 || code === '23514') return 'check';
  return undefined;
}

/** A name as a column is spelled, and nothing else: whatever is not one is dropped, never shown. */
const COLUMN_NAME = /^[A-Za-z_][\w$]{0,127}$/;

/**
 * The columns a refused write broke a rule on, by name only — never a value —
 * for a form to put the message beside the field. Only an error `writeFailureKind`
 * already recognized by its code is read, and only the part of it each engine
 * fills with names: PostgreSQL's `column`, the `Key (…)=` head of its detail
 * (the values follow the `=`), and the default `<table>_<column>_check` name of
 * a check; SQLite's `NOT NULL`/`UNIQUE constraint failed: t.c` (names only) and a
 * check whose expression starts with its column. `parent`: a delete or update of a row others
 * still point at, where the column is theirs, not this form's. Undefined where
 * the engine said no column (SQLite's `FOREIGN KEY constraint failed`).
 */
export function constraintColumns(error: unknown): { kind: WriteFailureKind; columns: string[]; parent?: true } | undefined {
  const kind = writeFailureKind(error);
  if (!kind) return undefined;
  const e = error as {
    code?: unknown;
    message?: unknown;
    column?: unknown;
    detail?: unknown;
    constraint?: unknown;
    table?: unknown;
  };
  const message = typeof e.message === 'string' ? e.message : '';
  const named = (names: (string | undefined)[], parent?: true) => {
    const columns = names.map((name) => name?.trim() ?? '').filter((name) => COLUMN_NAME.test(name));
    return columns.length && columns.length === names.length
      ? { kind, columns: [...new Set(columns)], ...(parent ? { parent } : {}) }
      : undefined;
  };
  if (typeof e.code === 'string' && e.code.startsWith('23')) {
    if (kind === 'required') return typeof e.column === 'string' ? named([e.column]) : undefined;
    if (kind === 'check') {
      const table = typeof e.table === 'string' ? e.table : '';
      const constraint = typeof e.constraint === 'string' ? e.constraint : '';
      const at = table && constraint.startsWith(`${table}_`) && constraint.endsWith('_check') ? constraint.slice(table.length + 1, -6) : '';
      return at ? named([at]) : undefined;
    }
    const head = typeof e.detail === 'string' ? /^Key \(([^()]*)\)=\(/.exec(e.detail) : null;
    if (!head) return undefined;
    const parent =
      kind === 'reference' && typeof e.detail === 'string' && /is still referenced from table/.test(e.detail) ? true : undefined;
    return named(head[1].split(','), parent);
  }
  /* SQLite: the message after the colon is the schema's own words — table.column, or the check's text. */
  const said = /^(NOT NULL|UNIQUE|CHECK) constraint failed: (.+)$/.exec(message);
  if (!said) return undefined;
  if (said[1] === 'CHECK') return named([/^([A-Za-z_][\w$]*)\s*(?:[<>=!]|\bin\b|\bbetween\b|\bis\b|\blike\b)/i.exec(said[2])?.[1]]);
  const parts = said[2].split(',').map((part) => part.trim());
  return named(parts.map((part) => (part.includes('.') ? part.slice(part.indexOf('.') + 1) : undefined)));
}

/**
 * A value the engine could not read as its column's type — words in a search
 * of a number column, a date that is no date. The caller's to change, so a 400
 * and a sentence, never a 500 that sends them to look at the server. By code
 * only: PostgreSQL's data exceptions for a value's text. SQLite takes any value in any column, so it has none.
 */
export function wrongTypeValue(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code } = error as { code?: unknown };
  return code === '22P02' || code === '22003' || code === '22007' || code === '22008';
}

/**
 * A value PostgreSQL could not take as given — a word where a number goes, a date that is no date, text past its
 * column's length: SQLSTATE class 22, a data exception, which the statement it failed rolled back. Permanent for
 * this input, like a constraint, and never the database failing to answer. By the server's code only (a pg error
 * carries its `severity`); SQLite takes any value in any column, so it has none.
 */
export function dataException(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof severity === 'string' && typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code);
}

/** Only recognized constraint codes and data exceptions acknowledge rejection; error text is not proof. */
export function writeFailureOutcome(error: unknown): 'rejected' | 'unknown' {
  return writeFailureKind(error) || dataException(error) ? 'rejected' : 'unknown';
}

/**
 * The status a write the database refused for good is answered with, by what it refused: a row already there or
 * one that is not there conflicts with what is stored (409, as a command's `duplicate_record` and `ineligible_state`
 * are); a value missing, outside a check or not of its column's type is the request's to change (422). Undefined for
 * anything else, which is not a refusal this recognizes. A rejected write is never a 2xx: a client that reads only
 * the status must not take it for a save, and one that reads the body finds the same envelope at either.
 */
export function writeRefusalStatus(error: unknown): 409 | 422 | undefined {
  const kind = writeFailureKind(error);
  if (kind === 'unique' || kind === 'reference') return 409;
  return kind || dataException(error) ? 422 : undefined;
}

export const insertFailureOutcome = writeFailureOutcome;

/**
 * The referenced row that is missing, if the message says one is.
 *
 * Returns the original message unchanged when this is not a foreign-key
 * failure, when the write named no reference column, or when every reference
 * it did name turns out to be satisfied — that last case matters, because a
 * concurrent delete or a deferred constraint can produce a failure this
 * cannot explain, and inventing an explanation for it would be worse than
 * the bare message.
 */
export async function explainWriteFailure(
  adapter: Adapter,
  schema: DatabaseSchema,
  tableId: string,
  values: Values,
  message: string,
): Promise<string> {
  if (!FOREIGN_KEY.test(message)) return message;
  const table = findTable(schema, tableId);
  if (!table) return message;

  for (const fk of referencesFrom(schema, tableId)) {
    const sent = fk.from.columns.map((c) => values[c]);
    /* Only references this write actually set. A column left out is the
       database's own default or null, and either way not what the caller
       typed — pointing at it would send them to the wrong line. */
    if (sent.some((v) => v === undefined || v === null)) continue;

    const target = findTable(schema, fk.to.table);
    if (!target) continue;

    let exists: boolean;
    try {
      const found = await adapter.query({
        table: fk.to.table,
        columns: fk.to.columns,
        filter: {
          groups: [
            fk.to.columns.map((column, i) => ({
              column,
              op: '=' as const,
              value: sent[i] as string | number,
            })),
          ],
        },
        limit: 1,
        offset: 0,
      });
      exists = found.rows.length > 0;
    } catch {
      /* A lookup that itself fails proves nothing about the write. */
      continue;
    }
    if (exists) continue;

    const pairs = fk.from.columns.map((c, i) => `${c} = ${format(sent[i])}`).join(', ');
    const targetName = fk.to.columns.map((c) => `${target.name}.${c}`).join(', ');
    return `${message} — ${pairs} has no matching ${targetName}. ` + `Insert that ${target.name} first, or point at one that exists.`;
  }

  return message;
}

function format(value: unknown): string {
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : `"${String(value)}"`;
}
