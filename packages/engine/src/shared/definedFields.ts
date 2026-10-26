/**
 * Fields whose definitions are rows: a record's JSON column holds one value
 * per key, and the keys — their captions, types, choices and whether they
 * are required — are rows of another resource that an administrator edits
 * while the App runs, per tenant where the App is a tenant App:
 *
 *   product:   { defined: { specs: { from: 'attribute', per: 'category_id' } } }
 *   attribute: { access: 'write' }
 *
 * A product is shaped by the attribute rows whose `category_id` is its own
 * and by those whose `category_id` is empty (fields every product has).
 *
 * The definition rows have fixed column names, so there is one way to say
 * one: `key`, `label` and `type` always; `options` (one choice per line),
 * `required`, `help` and `position` where the table has them. A row this
 * module cannot read (a type outside the set, a key that is not an
 * identifier) is left out rather than allowed to break a page: definitions
 * are data, typed by people, at runtime.
 *
 * This module is what the declaration says and what a first page needs to
 * know of it (a path the query language reads, the column served). Reading
 * definition rows and judging values by them is definedValues.ts's, which
 * only the server and the parts loaded on demand import.
 */
import { isJsonType, type ColumnMeta, type TableMeta } from './schema.js';

/** The kinds a definition's `type` may name: the command `field.*` words, with `choices` for many of a list. */
export const DEFINED_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'datetime', 'bool', 'choice', 'choices'] as const;
export type DefinedType = (typeof DEFINED_TYPES)[number];

/** `resources.<r>.defined.<column>`: which rows define the column's fields, and the column that picks them. */
export interface DefinedBinding {
  /** The resource whose rows are the definitions. */
  from: string;
  /** A column both tables have: a record is shaped by the definitions whose value matches its own, and those with none. */
  per?: string;
}

/** One definition row, read. */
export interface DefinedField {
  key: string;
  label: string;
  type: DefinedType;
  /** The choices of a `choice` or `choices` field, in the order written. */
  options: string[];
  required: boolean;
  help?: string;
}

/** The columns every definitions table has, and those it may. */
export const NEEDED = ['key', 'label', 'type'] as const;
export const OPTIONAL = ['options', 'required', 'help', 'position'] as const;
/** A definition's key, and the key a path reads: written into SQL as a literal, so held to an identifier. */
export const DEFINED_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The most definitions read for one record: a form, not a catalog. */
export const DEFINITIONS_MOST = 200;

/** `resources.<r>.defined`, read for its shape. Throws the sentence the author reads. */
export function parseDefined(raw: unknown, at: string): Record<string, DefinedBinding> {
  const shape = `${at} has a "defined" that is not an object of the resource's own JSON column → { from, per? }, like defined: { specs: { from: 'attribute', per: 'category_id' } }.`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) throw new Error(shape);
  const bindings: Record<string, DefinedBinding> = {};
  for (const [column, value] of Object.entries(raw as Record<string, unknown>)) {
    const here = `${at}, defined "${column}"`;
    if (!IDENTIFIER.test(column)) throw new Error(`${here}: defined fields are keyed by the resource's own JSON column, never a path.`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(shape);
    const given = value as Record<string, unknown>;
    const unknown = Object.keys(given).find((key) => key !== 'from' && key !== 'per');
    if (unknown) throw new Error(`${here} has "${unknown}"; it takes from and per.`);
    if (typeof given.from !== 'string' || !given.from.trim())
      throw new Error(`${here}: "from" names the resource whose rows define the fields.`);
    const binding: DefinedBinding = { from: given.from.trim() };
    if (given.per !== undefined) {
      if (typeof given.per !== 'string' || !IDENTIFIER.test(given.per))
        throw new Error(`${here}: "per" names one column both resources have, like per: 'category_id'.`);
      binding.per = given.per;
    }
    bindings[column] = binding;
  }
  return bindings;
}

/** Why a binding cannot run on this catalog, or undefined: a JSON column, a definitions table with its columns, and `per` on both. */
function definedProblem(column: string, binding: DefinedBinding, table: TableMeta, from: TableMeta | undefined): string | undefined {
  const own = table.columns.find((candidate) => candidate.name === column);
  if (!own) return `defined "${column}": "${table.name}" has no column "${column}".`;
  if (!isJsonType(own.type))
    return `defined "${column}" is ${own.type || 'untyped'}; defined fields live in a JSON column (jsonb on PostgreSQL, a column declared JSON on SQLite).`;
  if (!from) return `defined "${column}": "${binding.from}" is not a declared resource on this connection.`;
  const missing = NEEDED.filter((name) => !from.columns.some((candidate) => candidate.name === name));
  if (missing.length)
    return `defined "${column}": "${from.name}" has no ${missing.map((name) => `"${name}"`).join(', ')}; a definition row has key, label and type (and may have options, required, help and position).`;
  if (binding.per) {
    if (!table.columns.some((candidate) => candidate.name === binding.per))
      return `defined "${column}": "${table.name}" has no column "${binding.per}" for per.`;
    if (!from.columns.some((candidate) => candidate.name === binding.per))
      return `defined "${column}": "${from.name}" has no column "${binding.per}" for per.`;
  }
  return undefined;
}

/** The column each binding is on, by resolved table id: what the App serves the browser (`ResolvedResource.defined`). */
export function servedDefined(
  bindings: Readonly<Record<string, DefinedBinding>> | undefined,
  table: TableMeta,
  fromTable: (name: string) => TableMeta | undefined,
): { served: Record<string, DefinedBinding>; problems: string[] } {
  const served: Record<string, DefinedBinding> = {};
  const problems: string[] = [];
  for (const [column, binding] of Object.entries(bindings ?? {})) {
    const from = fromTable(binding.from);
    const problem = definedProblem(column, binding, table, from);
    if (problem) problems.push(problem);
    else served[column] = { from: from!.id, ...(binding.per ? { per: binding.per } : {}) };
  }
  return { served, problems };
}

/** A JSON key a path reads (`specs.capacity`) is no column of its own: its type says so, and the query language reads its values as they are written. */
export const DEFINED_PATH_TYPE = 'defined';

/** The column a JSON key path reads as: of no declared kind, so `2` compares as a number and `"2"` as text (query.ts `coerce`). */
export function definedColumnMeta(key: string): ColumnMeta {
  return { name: key, type: DEFINED_PATH_TYPE, nullable: true, primaryKey: false };
}
