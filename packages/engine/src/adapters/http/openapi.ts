/**
 * An OpenAPI document read as a catalog of browsable resources.
 *
 * A resource is a collection an API lists (`GET /contacts`) together with the
 * item it reads by key (`GET /contacts/{id}`), when both answer the same kind
 * of row. For each one this says the columns a row carries and what the API
 * can do with a list — filter, search, sort, page — as data, so tablewalk
 * asks the API only what it can answer and refuses the rest by name.
 *
 * Pure: a parsed JSON document in, a catalog out. The spec is pinned locally
 * and read at startup, as a database's catalog is read on connect, so there
 * is no network here, no remote `$ref` and no YAML. Nothing outside the
 * supported subset is guessed at: its operation is skipped with the reason,
 * which `--check-openapi` prints. Paging is the one inference, and every
 * inferred setting is listed under `guesses` for the author to confirm.
 */

/** What a column holds, in the catalog's words. `bigint` stays text, so a value past 2^53 keeps every digit. */
export type HttpColumnType = 'string' | 'integer' | 'bigint' | 'number' | 'boolean' | 'date' | 'datetime' | 'uuid' | 'json';

export interface HttpColumn {
  name: string;
  type: HttpColumnType;
  /** Null or absent in a row: a property the schema does not require may be missing, and missing reads as null. */
  nullable: boolean;
  /** The API says so (`readOnly`), or the value is a nested document, which no editor offers. */
  readOnly: boolean;
  /** An `enum`: the values the API documents, not a promise that nothing else arrives. */
  allowed?: string[];
  /** The resource whose key this column holds; guessed from the name (`carrier_id` → `carriers`), for the author to confirm. */
  references?: string;
  comment?: string;
}

/** A list filter the API takes: one query parameter per column, `=` always, `in` when it takes a list. */
export interface HttpFilter {
  param: string;
  ops: Array<'=' | 'in'>;
  serialization?: 'csv';
}

export type HttpPaging =
  | { kind: 'offset'; offset: string; limit: string }
  | { kind: 'page'; page: string; size: string }
  | { kind: 'cursor'; param: string; next: string; limit?: string }
  | { kind: 'none' };

export interface HttpResource {
  /** The collection's own word (`contacts`), used as the table's name. */
  name: string;
  /** The list and item paths, as the document writes them. */
  list: string;
  item: string;
  /** The column the item's path parameter names. */
  key: string;
  /** JSON Pointer (RFC 6901) to the rows in a list response; '' when the response is the array itself. */
  rows: string;
  columns: HttpColumn[];
  filters: Record<string, HttpFilter>;
  search?: string;
  /** A sort the API takes only by the values it documents. */
  sort?: { param: string; values: string[] };
  paging: HttpPaging;
  /** Settings inferred rather than read, for the author to confirm. */
  guesses: string[];
  comment?: string;
}

/** An operation outside the supported subset, and why. */
export interface HttpSkip {
  operation: string;
  reason: string;
}

export interface HttpCatalog {
  title: string;
  version: string;
  resources: HttpResource[];
  skipped: HttpSkip[];
}

/** The whole document is outside what tablewalk reads; the message names the fix. */
export class OpenApiError extends Error {
  readonly code = 'openapi_unsupported';
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiError';
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/* One operation outside the subset: skipped with this reason, never the whole document's failure. */
class Skip extends Error {}

/* Bounds on what one document may ask of the reader, so a pathological spec
   costs a refusal rather than a hung startup. */
const LIMITS = { paths: 2000, properties: 500, refDepth: 32, allOfDepth: 8 } as const;

/* Parameter names that mean paging, search or sort rather than a column.
   A name the author uses differently is corrected in the description the
   import drafts; the reader only proposes. */
const SEARCH = ['q', 'search', 'query'];
const SORT = ['sort', 'sort_by', 'sortBy', 'order', 'order_by', 'orderBy'];
const PAGING = {
  offset: ['offset', 'skip'],
  limit: ['limit', 'per_page', 'page_size', 'pageSize', 'size'],
  page: ['page', 'page_number', 'pageNumber'],
  cursor: ['cursor', 'after', 'page_token', 'pageToken', 'starting_after', 'next_token'],
  next: ['next_cursor', 'nextCursor', 'next_page_token', 'nextPageToken', 'next', 'cursor'],
};
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const pointer = (name: string) => name.replace(/~/g, '~0').replace(/\//g, '~1');
const typesOf = (schema: Json): string[] =>
  Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];

/** Follows local `$ref`s within this one document; a remote one is a Skip, never a fetch. */
function resolver(document: Json) {
  return function resolve(value: unknown): unknown {
    let current = value;
    for (let depth = 0; isObject(current) && typeof current.$ref === 'string'; depth++) {
      if (depth >= LIMITS.refDepth) throw new Skip(`a $ref chain is longer than ${LIMITS.refDepth} links`);
      const ref = current.$ref;
      if (!ref.startsWith('#/')) throw new Skip(`the remote $ref ${JSON.stringify(ref)} is not read: only one file is read`);
      let target: unknown = document;
      for (const raw of ref.slice(2).split('/')) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        target = isObject(target) && Object.hasOwn(target, key) ? target[key] : undefined;
      }
      if (target === undefined) throw new Skip(`the $ref ${JSON.stringify(ref)} names nothing in the document`);
      current = target;
    }
    return current;
  };
}
type Resolve = ReturnType<typeof resolver>;

interface RowShape {
  properties: Map<string, unknown>;
  required: Set<string>;
}

/* A row's properties, with `allOf` parts merged in order. A row that is one
   of several shapes has no single set of columns, so it is skipped rather
   than flattened into something no response actually is. */
function rowShape(resolve: Resolve, raw: unknown, depth = 0): RowShape {
  if (depth > LIMITS.allOfDepth) throw new Skip(`allOf nests deeper than ${LIMITS.allOfDepth} levels`);
  const schema = resolve(raw);
  if (!isObject(schema)) throw new Skip('the row schema is not an object');
  if (schema.oneOf !== undefined || schema.anyOf !== undefined || schema.discriminator !== undefined) {
    throw new Skip('a row that is one of several shapes (oneOf, anyOf, discriminator) is not read yet');
  }
  const shape: RowShape = { properties: new Map(), required: new Set() };
  const add = (name: string, property: unknown) => {
    const before = shape.properties.get(name);
    if (before !== undefined && JSON.stringify(before) !== JSON.stringify(property)) {
      throw new Skip(`the property "${name}" is declared twice with different schemas`);
    }
    shape.properties.set(name, property);
  };
  const parts = Array.isArray(schema.allOf) ? schema.allOf : [];
  for (const part of parts) {
    const inner = rowShape(resolve, part, depth + 1);
    for (const [name, property] of inner.properties) add(name, property);
    for (const name of inner.required) shape.required.add(name);
  }
  if (isObject(schema.properties)) for (const [name, property] of Object.entries(schema.properties)) add(name, property);
  if (Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === 'string') shape.required.add(name);
  if (!parts.length && !isObject(schema.properties) && !typesOf(schema).includes('object'))
    throw new Skip('the row schema is not an object');
  if (shape.properties.size > LIMITS.properties)
    throw new Skip(`a row has ${shape.properties.size} properties; at most ${LIMITS.properties} are read`);
  return shape;
}

function column(resolve: Resolve, name: string, raw: unknown, required: boolean): HttpColumn {
  const resolved = resolve(raw);
  let property = isObject(resolved) ? resolved : {};
  // Only an exact scalar-or-null union has one column type. Other unions
  // remain documents; annotations outside the union must not erase a constraint.
  if (
    Array.isArray(property.anyOf) &&
    property.anyOf.length === 2 &&
    Object.keys(property).every((key) => ['anyOf', 'description', 'title', 'readOnly'].includes(key))
  ) {
    const arms = property.anyOf.map(resolve);
    const nullIndex = arms.findIndex((arm) => isObject(arm) && arm.type === 'null' && Object.keys(arm).length === 1);
    const scalar = arms[1 - nullIndex];
    if (
      nullIndex !== -1 &&
      isObject(scalar) &&
      typeof scalar.type === 'string' &&
      ['string', 'integer', 'number', 'boolean'].includes(scalar.type) &&
      !['anyOf', 'oneOf', 'allOf', 'properties', 'items'].some((key) => Object.hasOwn(scalar, key))
    ) {
      const { anyOf: _union, ...annotations } = property;
      property = { ...scalar, ...annotations, nullable: true };
    }
  }
  const types = typesOf(property),
    base = types.filter((type) => type !== 'null');
  const allowed =
    Array.isArray(property.enum) && property.enum.length && property.enum.every((value) => typeof value === 'string')
      ? (property.enum as string[])
      : undefined;
  let type: HttpColumnType;
  /* A nested object, an array or a value of several shapes is one document:
     shown whole, never filtered, never edited as a field. */
  if (
    property.oneOf !== undefined ||
    property.anyOf !== undefined ||
    property.allOf !== undefined ||
    isObject(property.properties) ||
    base.length > 1 ||
    base.includes('object') ||
    base.includes('array')
  )
    type = 'json';
  else if (base[0] === 'string' || (!base.length && allowed)) {
    type =
      property.format === 'date' ? 'date' : property.format === 'date-time' ? 'datetime' : property.format === 'uuid' ? 'uuid' : 'string';
  } else if (base[0] === 'integer') type = property.format === 'int64' ? 'bigint' : 'integer';
  else if (base[0] === 'number') type = 'number';
  else if (base[0] === 'boolean') type = 'boolean';
  else type = 'json';
  const comment = typeof property.description === 'string' && property.description ? property.description : undefined;
  return {
    name,
    type,
    nullable: !required || types.includes('null') || property.nullable === true,
    readOnly: property.readOnly === true || type === 'json',
    ...(allowed ? { allowed } : {}),
    ...(comment ? { comment } : {}),
  };
}

interface Parameter {
  name: string;
  in: string;
  schema: Json;
  csv: boolean;
  fields?: unknown;
}

/* Path-level parameters apply to every operation under the path; an
   operation's own parameter of the same name and place replaces one. */
function parameters(resolve: Resolve, pathItem: Json, operation: Json): Parameter[] {
  const byKey = new Map<string, Parameter>();
  for (const list of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const parameter = resolve(raw);
      if (!isObject(parameter) || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue;
      const schema = resolve(parameter.schema);
      byKey.set(`${parameter.in}:${parameter.name}`, {
        name: parameter.name,
        in: parameter.in,
        schema: isObject(schema) ? schema : {},
        csv: parameter.style === 'form' && parameter.explode === false,
        fields: parameter['x-mistri-fields'],
      });
    }
  }
  return [...byKey.values()];
}

/** The JSON schema of an operation's first success response, if it has one. */
function successSchema(resolve: Resolve, operation: Json): unknown {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const code =
    Object.keys(responses)
      .filter((status) => /^2\d\d$/.test(status))
      .sort()[0] ?? (Object.hasOwn(responses, '2XX') ? '2XX' : undefined);
  if (code === undefined) return undefined;
  const response = resolve(responses[code]);
  if (!isObject(response) || !isObject(response.content)) return undefined;
  const media = Object.keys(response.content).find((type) => type === 'application/json' || /^application\/[\w.+-]*\+json$/.test(type));
  const content = media === undefined ? undefined : response.content[media];
  return isObject(content) ? content.schema : undefined;
}

/* Where a list response keeps its rows: the response itself, or the one
   array in an object. Two arrays leave no honest answer, so that is a Skip. */
function listRows(resolve: Resolve, raw: unknown): { rows: string; items: unknown; body?: Json } {
  const schema = resolve(raw);
  if (!isObject(schema)) throw new Skip("the list's success response has no JSON schema");
  if (typesOf(schema).includes('array')) return { rows: '', items: schema.items };
  const properties = isObject(schema.properties) ? schema.properties : {};
  const arrays = Object.entries(properties).filter(([, value]) => {
    const property = resolve(value);
    return isObject(property) && typesOf(property).includes('array');
  });
  if (arrays.length !== 1) {
    throw new Skip(
      arrays.length
        ? `the list response holds ${arrays.length} arrays (${arrays.map(([name]) => name).join(', ')}), so which one is the rows is not clear`
        : 'the list response is neither an array nor an object holding one array of rows',
    );
  }
  const [name, value] = arrays[0];
  return { rows: `/${pointer(name)}`, items: (resolve(value) as Json).items, body: schema };
}

/* A sparse list may omit properties that its full item requires, but must
   describe exactly the same property types. Imported nullability remains
   conservative because column() reads the list's required set. */
function sameRow(resolve: Resolve, a: unknown, b: unknown): boolean {
  if (isObject(a) && isObject(b) && typeof a.$ref === 'string' && a.$ref === b.$ref) return true;
  const list = resolve(a),
    item = resolve(b);
  if (JSON.stringify(list) === JSON.stringify(item)) return true;
  const closed = (raw: unknown): { properties: Json; required: string[] } | undefined => {
    if (!isObject(raw) || raw.type !== 'object' || raw.additionalProperties !== false || !isObject(raw.properties)) return;
    const metadata = ['x-mistri-primary-key', 'x-mistri-default-fields', 'x-mistri-projection-validation'];
    if (Object.keys(raw).some((key) => !['type', 'properties', 'required', 'additionalProperties', ...metadata].includes(key))) return;
    const names = Object.keys(raw.properties);
    const members = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.every((name) => typeof name === 'string' && names.includes(name)) &&
      new Set(value).size === value.length;
    if (!members(raw.required)) return;
    const required = raw.required;
    if (metadata.some((key) => Object.hasOwn(raw, key))) {
      const key = raw['x-mistri-primary-key'],
        fields = raw['x-mistri-default-fields'];
      if (
        !members(key) ||
        !key.length ||
        !members(fields) ||
        fields.length !== names.length ||
        key.length !== required.length ||
        key.some((name) => !required.includes(name)) ||
        raw['x-mistri-projection-validation'] !== 'request-codec-requires-exact-selected-fields-plus-complete-key'
      )
        return;
    }
    return { properties: raw.properties, required };
  };
  const left = closed(list),
    right = closed(item);
  return Boolean(
    left &&
    right &&
    JSON.stringify(left.properties) === JSON.stringify(right.properties) &&
    left.required.every((name) => right.required.includes(name)),
  );
}

function readResource(resolve: Resolve, path: string, pathItem: Json, itemPath: string, itemItem: Json): HttpResource {
  const segment = path.slice(path.lastIndexOf('/') + 1);
  if (!NAME.test(segment)) throw new Skip(`"${segment}" is not a usable resource name`);
  const list = pathItem.get as Json,
    item = itemItem.get as Json;
  const listSchema = successSchema(resolve, list),
    itemSchema = successSchema(resolve, item);
  if (listSchema === undefined) throw new Skip("the list's success response has no JSON schema");
  if (itemSchema === undefined) throw new Skip(`GET ${itemPath} has no JSON success response`);
  const { rows, items, body } = listRows(resolve, listSchema);
  if (!sameRow(resolve, items, itemSchema)) throw new Skip(`GET ${path} and GET ${itemPath} answer different row shapes`);
  const shape = rowShape(resolve, items);
  const key = itemPath.slice(path.length + 2, -1);
  const keyParameter = parameters(resolve, itemItem, item).find((parameter) => parameter.in === 'path' && parameter.name === key);
  if (keyParameter && (typesOf(keyParameter.schema).includes('object') || isObject(keyParameter.schema.properties))) {
    throw new Skip(`the item's path parameter {${key}} is a composite object key, which is not supported`);
  }
  if (!shape.properties.has(key)) throw new Skip(`the item's path parameter {${key}} names no property of the row`);
  const columns = [...shape.properties]
    .map(([name, property]) => column(resolve, name, property, shape.required.has(name)))
    .map((each) => (each.name === key ? { ...each, nullable: false } : each));
  if (columns.find((each) => each.name === key)?.type === 'json') throw new Skip(`the key "${key}" is a document, not a value`);

  const query = parameters(resolve, pathItem, list).filter((parameter) => parameter.in === 'query');
  const byName = new Map(query.map((parameter) => [parameter.name, parameter]));
  const first = (names: readonly string[]) => names.find((name) => byName.has(name));
  const used = new Set<string>();
  const [offset, limit, page, cursor] = [first(PAGING.offset), first(PAGING.limit), first(PAGING.page), first(PAGING.cursor)];
  const next = body && isObject(body.properties) ? PAGING.next.find((name) => Object.hasOwn(body.properties as Json, name)) : undefined;
  let paging: HttpPaging = { kind: 'none' };
  let guess = 'paging: none found — the list is read as one page';
  if (cursor && next) {
    paging = { kind: 'cursor', param: cursor, next: `/${pointer(next)}`, ...(limit ? { limit } : {}) };
    guess = `paging: cursor — sends "${cursor}", reads the next one at /${pointer(next)}${limit ? `, page size "${limit}"` : ''}`;
    used.add(cursor);
    if (limit) used.add(limit);
  } else if (offset && limit) {
    paging = { kind: 'offset', offset, limit };
    guess = `paging: offset — "${offset}" and "${limit}"`;
    used.add(offset);
    used.add(limit);
  } else if (page && limit) {
    paging = { kind: 'page', page, size: limit };
    guess = `paging: page — "${page}" and "${limit}"`;
    used.add(page);
    used.add(limit);
  }
  const search = SEARCH.find((name) => {
    const schema = byName.get(name)?.schema;
    return schema !== undefined && (!typesOf(schema).length || typesOf(schema).includes('string'));
  });
  if (search) used.add(search);
  let sort: HttpResource['sort'];
  for (const name of SORT) {
    const schema = byName.get(name)?.schema;
    if (!schema) continue;
    const values = [schema.enum, isObject(schema.items) ? schema.items.enum : undefined].find(
      (list) => Array.isArray(list) && list.length && list.every((value) => typeof value === 'string'),
    ) as string[] | undefined;
    // Without its documented values a sort parameter's syntax is unknown, so it is not offered.
    if (values) {
      sort = { param: name, values };
      used.add(name);
      break;
    }
    const fields = byName.get(name)?.fields;
    if (
      Array.isArray(fields) &&
      fields.length &&
      fields.every((field) => typeof field === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)) &&
      new Set(fields).size === fields.length
    ) {
      const field = `(?:${fields.map((field) => field.replaceAll('.', '\\.')).join('|')})`;
      if (schema.type === 'string' && schema.pattern === `^-?${field}(?:,-?${field})*$(?![\\s\\S])`) {
        sort = { param: name, values: fields.flatMap((field) => [field, `-${field}`]) };
        used.add(name);
        break;
      }
    }
  }
  const filters: Record<string, HttpFilter> = {};
  for (const parameter of query) {
    if (used.has(parameter.name)) continue;
    const target = columns.find((each) => each.name === parameter.name);
    if (!target || target.type === 'json') continue;
    const array =
      typesOf(parameter.schema).includes('array') ||
      (parameter.csv &&
        Array.isArray(parameter.schema.anyOf) &&
        parameter.schema.anyOf.length === 2 &&
        parameter.schema.anyOf.some((arm) => isObject(arm) && arm.type === 'array') &&
        parameter.schema.anyOf.some((arm) => isObject(arm) && arm.type === 'string'));
    filters[target.name] = {
      param: parameter.name,
      ops: array ? ['=', 'in'] : ['='],
      ...(array && parameter.csv ? { serialization: 'csv' as const } : {}),
    };
  }
  const comment = typeof list.summary === 'string' && list.summary ? list.summary : undefined;
  return {
    name: segment,
    list: path,
    item: itemPath,
    key,
    rows,
    columns,
    filters,
    ...(search ? { search } : {}),
    ...(sort ? { sort } : {}),
    paging,
    guesses: [guess],
    ...(comment ? { comment } : {}),
  };
}

/* Two keys can hold the same value only when they are the same kind of value. */
const KEY_KIND: Partial<Record<HttpColumnType, 'text' | 'number'>> = { string: 'text', uuid: 'text', integer: 'number', bigint: 'number' };

/* A spec has no foreign keys to read. What it has is names: a `carrier_id`
   beside a `carriers` resource keyed by the same kind of value is guessed to
   point at it, and said so under `guesses`, as the paging is — a draft to
   confirm, because a name is a signal and not a promise. */
function guessReferences(resources: HttpResource[]): void {
  for (const resource of resources) {
    for (const column of resource.columns) {
      const stem = /^(.+)_id$/.exec(column.name)?.[1];
      if (!stem || column.name === resource.key) continue;
      const names = [stem, `${stem}s`, `${stem}es`, stem.replace(/y$/, 'ies')];
      const target = resources.find((each) => names.includes(each.name));
      const key = target?.columns.find((each) => each.name === target.key);
      if (!target || !key || !KEY_KIND[key.type] || KEY_KIND[key.type] !== KEY_KIND[column.type]) continue;
      column.references = target.name;
      resource.guesses.push(`references: ${column.name} → ${target.name}, by its name`);
    }
  }
}

/**
 * Reads a parsed OpenAPI 3.0 or 3.1 document. Throws `OpenApiError` only for
 * a document tablewalk cannot read at all; everything else becomes either a
 * resource or a skipped operation with its reason.
 */
export function readOpenApi(document: unknown): HttpCatalog {
  if (!isObject(document)) throw new OpenApiError('An OpenAPI document is a JSON object.');
  if (typeof document.swagger === 'string') {
    throw new OpenApiError(
      `This is a Swagger ${document.swagger} document. Only OpenAPI 3.0 and 3.1 are read; convert it first (swagger2openapi, or your framework's exporter).`,
    );
  }
  if (typeof document.openapi !== 'string' || !/^3\.[01]\.\d+$/.test(document.openapi)) {
    throw new OpenApiError(`Only OpenAPI 3.0 and 3.1 are read; this document says ${JSON.stringify(document.openapi ?? null)}.`);
  }
  if (!isObject(document.paths)) throw new OpenApiError('The document has no "paths" object.');
  const paths = document.paths;
  const keys = Object.keys(paths).sort();
  if (keys.length > LIMITS.paths) throw new OpenApiError(`The document has ${keys.length} paths; at most  are read.`);
  const resolve = resolver(document);
  const withGet = (path: string): Json | undefined => {
    try {
      const pathItem = resolve(paths[path]);
      return isObject(pathItem) && isObject(pathItem.get) ? pathItem : undefined;
    } catch {
      return undefined;
    }
  };

  const resources: HttpResource[] = [];
  const skipped: HttpSkip[] = [];
  const claimed = new Set<string>();
  const names = new Set<string>();
  for (const path of keys) {
    if (path.includes('{')) continue;
    const pathItem = withGet(path);
    if (!pathItem) continue;
    try {
      const itemPath = keys.find(
        (candidate) => candidate.startsWith(`${path}/{`) && /^\{[^{}/]+\}$/.test(candidate.slice(path.length + 1)) && withGet(candidate),
      );
      if (!itemPath) throw new Skip(`no item operation (GET ${path}/{id}) reads one row by its key`);
      claimed.add(itemPath);
      const resource = readResource(resolve, path, pathItem, itemPath, withGet(itemPath)!);
      if (names.has(resource.name)) throw new Skip(`another collection is already called "${resource.name}"`);
      names.add(resource.name);
      resources.push(resource);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ operation: `GET ${path}`, reason: error.message });
    }
  }
  for (const path of keys) {
    if (!path.includes('{') || claimed.has(path) || !withGet(path)) continue;
    const reason = /\{[^}]+\}\//.test(path)
      ? 'nested collections (a list under an item) are not read yet'
      : (path.match(/\{[^}]+\}/g) ?? []).length > 1
        ? 'an item addressed by more than one path parameter is not read yet'
        : `no list operation (GET ${path.slice(0, path.lastIndexOf('/'))}) lists these rows`;
    skipped.push({ operation: `GET ${path}`, reason });
  }
  guessReferences(resources);
  const info = isObject(document.info) ? document.info : {};
  return {
    title: typeof info.title === 'string' && info.title ? info.title : 'API',
    version: typeof info.version === 'string' ? info.version : '',
    resources: resources.sort((a, b) => a.name.localeCompare(b.name)),
    skipped: skipped.sort((a, b) => a.operation.localeCompare(b.operation)),
  };
}
