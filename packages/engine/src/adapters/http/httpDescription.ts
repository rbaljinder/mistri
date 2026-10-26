/**
 * The description an HTTP connection is browsed through.
 *
 * The OpenAPI import drafts it; the author confirms and corrects it; the
 * adapter reads it — and only it — at runtime. The spec is not read again
 * after the import, so a guess corrected here stays corrected, and a spec
 * that changed shows up as a changed hash rather than as silently different
 * columns. It is data, not code: plain JSON a person, a script or an agent
 * can edit, and never part of an App's source.
 */
import type { ColumnMeta, DatabaseSchema, ForeignKey, TableMeta } from '../../shared/schema.js';
import type { HttpCatalog, HttpColumn, HttpColumnType, HttpFilter, HttpPaging, HttpResource } from './openapi.js';

export const DESCRIPTION_FORMAT = 'mistri.http/1';

export interface HttpDescription {
  format: typeof DESCRIPTION_FORMAT;
  title: string;
  version: string;
  /** What it was drafted from: the spec's file name and sha256, so a changed spec is visible. */
  spec?: { file: string; sha256: string };
  resources: HttpResource[];
}

export function draftDescription(catalog: HttpCatalog, spec?: { file: string; sha256: string }): HttpDescription {
  return {
    format: DESCRIPTION_FORMAT,
    title: catalog.title,
    version: catalog.version,
    ...(spec ? { spec } : {}),
    resources: catalog.resources,
  };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const TYPES = new Set<HttpColumnType>(['string', 'integer', 'bigint', 'number', 'boolean', 'date', 'datetime', 'uuid', 'json']);
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/* Refused rather than coerced, like the connection config beside it: a
   description is edited by hand, and a typo that quietly became a different
   API call is the mistake worth being loud about. */
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'string');
}

function readColumn(raw: unknown, at: string): HttpColumn {
  if (!isObject(raw) || typeof raw.name !== 'string' || !NAME.test(raw.name))
    throw new Error(`${at} needs a "name" (letters, digits, _ and -).`);
  if (typeof raw.type !== 'string' || !TYPES.has(raw.type as HttpColumnType)) {
    throw new Error(`${at} "${raw.name}" has "type": ${JSON.stringify(raw.type)}. Use one of ${[...TYPES].join(', ')}.`);
  }
  for (const flag of ['nullable', 'readOnly'] as const) {
    if (typeof raw[flag] !== 'boolean') throw new Error(`${at} "${raw.name}" needs "${flag}": true or false, without quotes.`);
  }
  if (raw.allowed !== undefined && (!strings(raw.allowed) || !raw.allowed.length))
    throw new Error(`${at} "${raw.name}" has "allowed" that is not a list of strings.`);
  if (raw.comment !== undefined && typeof raw.comment !== 'string')
    throw new Error(`${at} "${raw.name}" has a "comment" that is not text.`);
  if (raw.references !== undefined && (typeof raw.references !== 'string' || !NAME.test(raw.references))) {
    throw new Error(`${at} "${raw.name}" has "references" that is not a resource's name.`);
  }
  return {
    name: raw.name,
    type: raw.type as HttpColumnType,
    nullable: raw.nullable as boolean,
    readOnly: raw.readOnly as boolean,
    ...(raw.allowed ? { allowed: raw.allowed as string[] } : {}),
    ...(raw.references ? { references: raw.references as string } : {}),
    ...(raw.comment ? { comment: raw.comment as string } : {}),
  };
}

function readPaging(raw: unknown, at: string): HttpPaging {
  if (!isObject(raw)) throw new Error(`${at} needs "paging".`);
  const text = (key: string) => {
    if (typeof raw[key] !== 'string' || !raw[key])
      throw new Error(`${at} "paging" (${String(raw.kind)}) needs "${key}", the query parameter's name.`);
    return raw[key] as string;
  };
  switch (raw.kind) {
    case 'none':
      return { kind: 'none' };
    case 'offset':
      return { kind: 'offset', offset: text('offset'), limit: text('limit') };
    case 'page':
      return { kind: 'page', page: text('page'), size: text('size') };
    case 'cursor': {
      const next = text('next');
      if (!next.startsWith('/')) throw new Error(`${at} "paging" "next" is a JSON Pointer into the response, starting with "/".`);
      return { kind: 'cursor', param: text('param'), next, ...(raw.limit === undefined ? {} : { limit: text('limit') }) };
    }
    default:
      throw new Error(`${at} "paging" has "kind": ${JSON.stringify(raw.kind)}. Use none, offset, page or cursor.`);
  }
}

function readResource(raw: unknown, at: string): HttpResource {
  if (!isObject(raw) || typeof raw.name !== 'string' || !NAME.test(raw.name))
    throw new Error(`${at} needs a "name" (letters, digits, _ and -).`);
  const here = `${at} "${raw.name}"`;
  if (typeof raw.list !== 'string' || !raw.list.startsWith('/') || raw.list.includes('{'))
    throw new Error(`${here} needs "list", a path like "/contacts".`);
  if (typeof raw.key !== 'string' || !raw.key) throw new Error(`${here} needs "key", the column its item path names.`);
  if (raw.item !== `${raw.list}/{${raw.key}}`)
    throw new Error(`${here} needs "item": "${raw.list}/{${raw.key}}", the list path and its key.`);
  if (typeof raw.rows !== 'string' || (raw.rows !== '' && !raw.rows.startsWith('/')))
    throw new Error(`${here} has "rows" that is not a JSON Pointer ("" or starting with "/").`);
  if (!Array.isArray(raw.columns) || !raw.columns.length) throw new Error(`${here} needs "columns".`);
  const columns = raw.columns.map((column, index) => readColumn(column, `${here} column ${index + 1}`));
  const names = new Set<string>();
  for (const column of columns) {
    if (names.has(column.name)) throw new Error(`${here} has two columns called "${column.name}".`);
    names.add(column.name);
  }
  const key = columns.find((column) => column.name === raw.key);
  if (!key) throw new Error(`${here} has "key": "${raw.key}", which is not one of its columns.`);
  if (key.nullable || key.type === 'json') throw new Error(`${here}: the key "${raw.key}" must be a value that is never null.`);
  const filters: Record<string, HttpFilter> = {};
  if (raw.filters !== undefined) {
    if (!isObject(raw.filters)) throw new Error(`${here} has "filters" that is not an object of column → parameter.`);
    for (const [name, filter] of Object.entries(raw.filters)) {
      const column = columns.find((each) => each.name === name);
      if (!column || column.type === 'json') throw new Error(`${here} filters "${name}", which is not a column that can be filtered.`);
      if (!isObject(filter) || typeof filter.param !== 'string' || !filter.param)
        throw new Error(`${here} filter "${name}" needs "param".`);
      if (!strings(filter.ops) || !filter.ops.length || filter.ops.some((op) => op !== '=' && op !== 'in') || !filter.ops.includes('=')) {
        throw new Error(`${here} filter "${name}" has "ops" other than ["="] or ["=", "in"].`);
      }
      if (filter.serialization !== undefined && filter.serialization !== 'csv')
        throw new Error(`${here} filter "${name}" has unsupported serialization.`);
      filters[name] = {
        param: filter.param,
        ops: [...new Set(filter.ops)] as HttpFilter['ops'],
        ...(filter.serialization === 'csv' ? { serialization: 'csv' as const } : {}),
      };
    }
  }
  if (raw.search !== undefined && (typeof raw.search !== 'string' || !raw.search))
    throw new Error(`${here} has "search" that is not a parameter name.`);
  let sort: HttpResource['sort'];
  if (raw.sort !== undefined) {
    if (!isObject(raw.sort) || typeof raw.sort.param !== 'string' || !strings(raw.sort.values) || !raw.sort.values.length) {
      throw new Error(`${here} has "sort" without a "param" and its documented "values".`);
    }
    sort = { param: raw.sort.param, values: raw.sort.values };
  }
  if (raw.guesses !== undefined && !strings(raw.guesses)) throw new Error(`${here} has "guesses" that is not a list of notes.`);
  if (raw.comment !== undefined && typeof raw.comment !== 'string') throw new Error(`${here} has a "comment" that is not text.`);
  return {
    name: raw.name,
    list: raw.list,
    item: raw.item as string,
    key: raw.key,
    rows: raw.rows,
    columns,
    filters,
    ...(raw.search ? { search: raw.search as string } : {}),
    ...(sort ? { sort } : {}),
    paging: readPaging(raw.paging, here),
    guesses: (raw.guesses as string[] | undefined) ?? [],
    ...(raw.comment ? { comment: raw.comment as string } : {}),
  };
}

/** A description as written in a file, checked field by field; `where` names the file in every message. */
export function readDescription(raw: unknown, where: string): HttpDescription {
  if (!isObject(raw)) throw new Error(`${where} is not a JSON object.`);
  if (raw.format !== DESCRIPTION_FORMAT) {
    throw new Error(
      `${where} has "format": ${JSON.stringify(raw.format)}; this build reads "${DESCRIPTION_FORMAT}". Draft one with --from-openapi.`,
    );
  }
  if (!Array.isArray(raw.resources) || !raw.resources.length) throw new Error(`${where} describes no "resources".`);
  const resources = raw.resources.map((resource, index) => readResource(resource, `${where}: resource ${index + 1}`));
  const names = new Set<string>();
  for (const resource of resources) {
    if (names.has(resource.name)) throw new Error(`${where} describes two resources called "${resource.name}".`);
    names.add(resource.name);
  }
  // A reference is followed by reading the target's item, so the target has to be here to read.
  for (const resource of resources) {
    for (const column of resource.columns) {
      if (column.references && !names.has(column.references)) {
        throw new Error(
          `${where}: "${resource.name}" column "${column.name}" references "${column.references}", which is not a resource in this description.`,
        );
      }
      if (column.references && column.name === resource.key)
        throw new Error(`${where}: "${resource.name}"'s key "${column.name}" cannot reference another resource.`);
    }
  }
  let spec: HttpDescription['spec'];
  if (raw.spec !== undefined) {
    if (
      !isObject(raw.spec) ||
      typeof raw.spec.file !== 'string' ||
      typeof raw.spec.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(raw.spec.sha256)
    ) {
      throw new Error(`${where} has "spec" without its "file" and a 64-character "sha256".`);
    }
    spec = { file: raw.spec.file, sha256: raw.spec.sha256 };
  }
  return {
    format: DESCRIPTION_FORMAT,
    title: typeof raw.title === 'string' ? raw.title : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    ...(spec ? { spec } : {}),
    resources,
  };
}

/* The catalog words said as the type strings the rest of tablewalk already
   reads — a grid right-aligns `numeric`, a record formats `timestamp`, and a
   `json` value is laid out by its shape — so an API's row is drawn exactly
   as a database's would be. */
const SQL_TYPE: Record<HttpColumnType, string> = {
  string: 'text',
  integer: 'integer',
  bigint: 'bigint',
  number: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamp',
  uuid: 'uuid',
  json: 'json',
};

/** The description as the catalog every App, grant, type export and scaffold already reads. */
export function describedSchema(description: HttpDescription, label: string, readAt = new Date()): DatabaseSchema {
  const keyOf = new Map(description.resources.map((resource) => [resource.name, resource.key]));
  /* A reference is a foreign key to everything that reads the catalog: related
     lists, label paths, the diagram. The adapter answers a path through one by
     reading the target's items (httpAdapter.ts). */
  const foreignKeys: ForeignKey[] = description.resources.flatMap((resource) =>
    resource.columns
      .filter((column) => column.references && keyOf.has(column.references))
      .map((column) => ({
        name: `${resource.name}_${column.name}`,
        from: { table: resource.name, columns: [column.name] },
        to: { table: column.references!, columns: [keyOf.get(column.references!)!] },
      })),
  );
  const tables: TableMeta[] = description.resources.map((resource) => ({
    name: resource.name,
    schema: '',
    id: resource.name,
    isView: false,
    columns: resource.columns.map((column): ColumnMeta => ({
      name: column.name,
      type: SQL_TYPE[column.type],
      nullable: column.nullable,
      primaryKey: column.name === resource.key,
      ...(column.allowed ? { allowed: column.allowed } : {}),
      ...(column.comment ? { comment: column.comment } : {}),
      ...(column.references && keyOf.has(column.references)
        ? { references: { table: column.references, column: keyOf.get(column.references)! } }
        : {}),
    })),
    ...(resource.comment ? { comment: resource.comment } : {}),
    // What the API documents a filter for; the explorer offers boxes for these alone.
    filterable: Object.keys(resource.filters),
    // The columns its documented sort values name ("-shipped_at" sorts by shipped_at), in the spellings the adapter reads.
    sortable: [
      ...new Set((resource.sort?.values ?? []).map((value) => value.replace(/^[-+]/, '').replace(/(?::| |_)(?:asc|desc)$/, ''))),
    ].filter((name) => resource.columns.some((column) => column.name === name)),
    countable: false,
  }));
  return { label, dialect: 'http', tables, foreignKeys, readAt: readAt.toISOString() };
}
