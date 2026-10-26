/**
 * The rules a resource's `search` block is judged by, on both sides: which
 * catalogs it can run on, and where its index lives.
 *
 * The index holds a copy of the declared fields under the record's key, so
 * the key has to be one column — the engine's document id is one string — and
 * every field has to be a column this catalog has.
 */
import type { AppSearchDef } from './appModel.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';

/** A searched field that follows a reference: `requester.name` is `requester`'s row's `name`. */
export interface SearchPath {
  /** The field as declared, and the document field it is indexed under. */
  field: string;
  doc: string;
  /** The reference column on the searched table, and the table and key it points at (physical ids). */
  via: string;
  table: string;
  key: string;
  column: string;
}

/** The document field a declared field is indexed under: a path's dot would be a nested object to the engine. */
export const searchDocField = (field: string): string => field.replace('.', '__');

/**
 * Each path field of a search over `table`, resolved through its declared
 * reference, or the reason one cannot be. One step: the field names a
 * reference column, then a column of the row it points at — the value is
 * copied into the document and follows that row (appSearchRuntime.ts).
 */
export function searchPaths(search: AppSearchDef, table: TableMeta, tables: readonly TableMeta[]): SearchPath[] | string {
  const paths: SearchPath[] = [];
  for (const field of search.fields) {
    const dot = field.indexOf('.');
    if (dot < 0) continue;
    const via = field.slice(0, dot),
      column = field.slice(dot + 1);
    if (column.includes('.')) return `search: "${field}" follows more than one reference; a searched path takes one step.`;
    const reference = table.columns.find((c) => c.name === via)?.references;
    if (!reference) return `search: "${field}" starts at "${via}", which is not a reference of "${table.name}".`;
    const target = tables.find((t) => t.id === reference.table);
    if (!target) return `search: "${field}" follows "${via}" to "${reference.table}", which this catalog does not have.`;
    if (!target.columns.some((c) => c.name === column)) return `search: "${target.name}" has no column "${column}" (in "${field}").`;
    paths.push({ field, doc: searchDocField(field), via, table: target.id, key: reference.column, column });
  }
  return paths;
}

/** Why this resource's search cannot run on this catalog, or undefined when it can. */
export function appSearchProblem(search: AppSearchDef, table: TableMeta, tables: readonly TableMeta[] = []): string | undefined {
  const keys = primaryKey(table);
  if (keys.length !== 1) {
    return `search needs a single-column primary key, and "${table.name}" has ${keys.length ? `a key of ${keys.length} columns` : 'none'}.`;
  }
  const missing = search.fields.filter((field) => !field.includes('.') && !table.columns.some((column) => column.name === field));
  if (missing.length) return `search: "${table.name}" has no column ${missing.map((field) => `"${field}"`).join(', ')}.`;
  const paths = searchPaths(search, table, tables);
  return typeof paths === 'string' ? paths : undefined;
}

/**
 * The engine's collection for one resource of one App: `<prefix>_<app>_<resource>`,
 * word characters only, so two deployments (or two Apps) can share an engine
 * without sharing an index.
 */
export function searchCollection(prefix: string, appId: string, resource: string): string {
  return [prefix, appId, resource].map((part) => part.replace(/\W+/g, '_')).join('_');
}
