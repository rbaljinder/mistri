/**
 * The second line that tells two records of one name apart, wherever a
 * reference is chosen or shown: a picker's choices, its chips, a record's
 * aside cards. Two customers called "Ana Silva" are one choice too many until
 * one reads "ana@north.example" under it.
 *
 * The rule is the list inference's sub-line, carried on: the subtitle the
 * App's display rule gives the name column wins, then a code the record is
 * quoted by (its number, SKU, reference — unique by the catalog), then the
 * identifying fields a reference has and a list row does not need: an email,
 * the parent it belongs to by name, the day it was made.
 */
import { CODE } from './listInference.js';
import { columnKind, findTable, labelColumn, primaryKey, type ColumnMeta, type DatabaseSchema, type TableMeta } from './schema.js';

const EMAIL = /(^|_)e?mail(_address)?$/i;
const MADE = /^(created|opened|started|joined|hired|registered)(_at|_on|_date)?$|^(date_)?(created|opened)$/i;

export interface Subline {
  /** The column, or a path through one reference (`account_id.name`), the second line reads. */
  path: string;
  /** The App said it (a display `subtitle`): drawn under every choice, not only where two names collide. */
  declared: boolean;
}

const text = (column: ColumnMeta) => columnKind(column.type) === 'text';

/** Whether a reference points at a table whose records have a name of their own, and which column says it. */
function parentName(schema: DatabaseSchema, column: ColumnMeta): string | undefined {
  const target = column.references ? findTable(schema, column.references.table) : undefined;
  const named = target && labelColumn(target);
  return target && named && !primaryKey(target).includes(named) ? named : undefined;
}

/**
 * The second line for a table's records, named by `label` (the column the reference is said by). Undefined where
 * nothing tells them apart better than their key, which the caller already has.
 */
export function referenceSubline(
  schema: DatabaseSchema | undefined,
  table: TableMeta,
  label: string | undefined,
  display?: Readonly<Record<string, { subtitle?: unknown } | null | undefined>>,
): Subline | undefined {
  const own = (name: string) => table.columns.find((column) => column.name === name);
  const subtitle = label ? display?.[label]?.subtitle : undefined;
  if (typeof subtitle === 'string' && subtitle !== label && own(subtitle)) return { path: subtitle, declared: true };
  const plain = table.columns.filter((column) => column.name !== label && !column.primaryKey && !column.references);
  const code = plain.find((column) => text(column) && CODE.test(column.name) && (table.unique ?? []).includes(column.name));
  if (code) return { path: code.name, declared: false };
  const email = plain.find((column) => text(column) && EMAIL.test(column.name));
  if (email) return { path: email.name, declared: false };
  const parent = schema
    ? table.columns.find((column) => column.name !== label && column.references && !column.nullable && parentName(schema, column))
    : undefined;
  if (parent) return { path: `${parent.name}.${parentName(schema!, parent)}`, declared: false };
  const made = plain.find((column) => columnKind(column.type) === 'date' && MADE.test(column.name));
  return made ? { path: made.name, declared: false } : undefined;
}

/** A second line's value as read: a timestamp is said by its day, an empty value is no line. */
export function sublineText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const said = String(value);
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:/.test(said) ? said.slice(0, 10) : said;
}

/** The names shown more than once among some choices: where a second line is drawn when the App did not ask for it. */
export function collidingNames(labels: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const label of labels) (seen.has(label) ? twice : seen).add(label);
  return twice;
}
