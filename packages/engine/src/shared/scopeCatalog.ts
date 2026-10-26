import { Refusal } from './refusal.js';
import type { ColumnMeta, DatabaseSchema, ForeignKey } from './schema.js';

const refuse = (): never => {
  throw new Refusal('The scoped catalog could not be verified. Refresh the catalog and permissions before continuing.');
};
/** The suffix declaredDates.ts gives a SQLite TEXT column the App declares a date. */
const DECLARED_DATE = /\s+as date(time)?$/;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
/* Only this module adds an object after it has been detached, fully checked and
   recursively frozen below. A caller cannot forge a WeakSet membership by
   freezing a lookalike, so accepting one here never skips validation of a
   database description or other boundary input. */
const capturedCatalogs = new WeakSet<object>();
const authorityFingerprints = new WeakMap<object, string>();
/* A catalog derived from a captured one (a grant's pruning, appAccess.ts) and
   deeply frozen here, never by a caller: its capture can be kept by identity,
   because nothing can change what it would capture to. */
const frozenDerived = new WeakSet<object>();
const derivedCaptures = new WeakMap<object, DatabaseSchema>();
/** Test-only: how many catalogs were copied and checked in full. */
export const scopeCatalogCounters = { captured: 0 };

/** Validate descriptors before reading values, including non-authoritative metadata. */
function copyData(input: unknown): unknown {
  let nodes = 0;
  let characters = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 262_144 || depth > 16) return refuse();
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if ((characters += value.length) > 16_777_216) return refuse();
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || ancestors.has(value)) return refuse();
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return refuse();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 65_537) return refuse();
    ancestors.add(value);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        if (!Number.isInteger(length) || length > 65_536 || keys.length !== length + 1) return refuse();
        return Array.from({ length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) return refuse();
          return copy(descriptor.value, depth + 1);
        });
      }
      return Object.fromEntries(
        keys.map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) return refuse();
          if ((characters += key.length) > 16_777_216) return refuse();
          return [key, copy(descriptor.value, depth + 1)];
        }),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  return copy(input);
}

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) refuse();
}
function unique(names: unknown[]): void {
  if (names.some((name) => !identifier(name)) || new Set(names).size !== names.length) refuse();
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const fkOrder = (a: ForeignKey, b: ForeignKey): number => order(a.from.table, b.from.table) || order(a.name, b.name);

/** Whether `schema` is a catalog this module captured: detached, validated
 * and deeply frozen, so nothing can change it after a reader binds to it. */
export function isCapturedScopeCatalog(schema: DatabaseSchema): boolean {
  return !!schema && typeof schema === 'object' && capturedCatalogs.has(schema);
}

/** Deeply freeze a catalog derived from a captured one, and remember that this
 * module froze it: a later capture of it is then made once and kept. */
export function freezeDerivedCatalog(schema: DatabaseSchema): DatabaseSchema {
  freeze(schema);
  frozenDerived.add(schema);
  return schema;
}

/** Detached evidence only: labels, estimates and editing affordances confer no authority. */
export function captureScopeCatalog(schema: DatabaseSchema): DatabaseSchema {
  try {
    if (schema && typeof schema === 'object' && capturedCatalogs.has(schema)) return schema;
    const kept = schema && typeof schema === 'object' ? derivedCaptures.get(schema) : undefined;
    if (kept) return kept;
    scopeCatalogCounters.captured++;
    const data = copyData(schema);
    record(data, ['label', 'dialect', 'readAt', 'tables', 'foreignKeys']);
    if (
      !['sqlite', 'postgres', 'mysql', 'mssql'].includes(data.dialect as string) ||
      typeof data.label !== 'string' ||
      typeof data.readAt !== 'string' ||
      !Array.isArray(data.tables) ||
      !Array.isArray(data.foreignKeys)
    )
      return refuse();
    for (const table of data.tables) {
      record(table, [
        'id',
        'name',
        'schema',
        'isView',
        'columns',
        'approxRows',
        'comment',
        'indexed',
        'unique',
        'uniquePairs',
        'trigram',
        'deletable',
        'insertable',
        'sourceDialect',
      ]);
      if (
        !identifier(table.id) ||
        /* A catalog of several connections says which engine reads each table
           (appSourceCatalog.ts). It is the connection's, so it is carried and
           left out of the fingerprint: one source's own catalog does not say it. */
        (table.sourceDialect !== undefined && !['sqlite', 'postgres', 'mysql', 'mssql', 'http'].includes(table.sourceDialect as string)) ||
        typeof table.name !== 'string' ||
        typeof table.schema !== 'string' ||
        typeof table.isView !== 'boolean' ||
        !Array.isArray(table.columns) ||
        !table.columns.length
      )
        return refuse();
      for (const column of table.columns) {
        /* `flag` (an integer a CHECK pins to 0 and 1) is display evidence like
           `allowed`: it says how to read a value and grants nothing, so it is
           carried and left out of the fingerprint. */
        /* `text` (a varchar's length, a simple CHECK's) is display evidence too: a form checks it as someone types. */
        record(column, [
          'name',
          'type',
          'nullable',
          'primaryKey',
          'default',
          'identity',
          'references',
          'allowed',
          'flag',
          'text',
          'comment',
          'writable',
        ]);
        if (column.text !== undefined) {
          record(column.text, ['min', 'max', 'pattern']);
          const { min, max, pattern } = column.text as { min?: unknown; max?: unknown; pattern?: unknown };
          if (
            [min, max].some((n) => n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1)) ||
            (pattern !== undefined && typeof pattern !== 'string')
          )
            return refuse();
        }
        if (
          !identifier(column.name) ||
          typeof column.type !== 'string' ||
          typeof column.nullable !== 'boolean' ||
          typeof column.primaryKey !== 'boolean' ||
          (column.default !== undefined && typeof column.default !== 'string') ||
          (column.flag !== undefined && column.flag !== true) ||
          (column.identity !== undefined && column.identity !== 'always' && column.identity !== 'by-default')
        )
          return refuse();
        if (column.references !== undefined) {
          record(column.references, ['table', 'column']);
          if (!identifier(column.references.table) || !identifier(column.references.column)) return refuse();
        }
      }
      unique(table.columns.map((column) => column.name));
      // Evidence for an App's natural-key address, never authority: only columns this table has.
      if (
        table.unique !== undefined &&
        (!Array.isArray(table.unique) ||
          table.unique.some(
            (name) => typeof name !== 'string' || !(table.columns as Array<{ name: unknown }>).some((column) => column.name === name),
          ))
      )
        return refuse();
      // The same evidence for a key unique within its tenant: pairs of columns this table has.
      if (
        table.uniquePairs !== undefined &&
        (!Array.isArray(table.uniquePairs) ||
          table.uniquePairs.some(
            (pair) =>
              !Array.isArray(pair) ||
              pair.length !== 2 ||
              pair.some(
                (name) => typeof name !== 'string' || !(table.columns as Array<{ name: unknown }>).some((column) => column.name === name),
              ),
          ))
      )
        return refuse();
      // Index advice, as `unique` is address evidence: only columns this table has.
      if (
        table.trigram !== undefined &&
        (!Array.isArray(table.trigram) ||
          table.trigram.some(
            (name) => typeof name !== 'string' || !(table.columns as Array<{ name: unknown }>).some((column) => column.name === name),
          ))
      )
        return refuse();
    }
    unique(data.tables.map((table) => table.id));
    const captured = data as unknown as DatabaseSchema;
    const columns = new Map(captured.tables.map((table) => [table.id, new Set(table.columns.map((column) => column.name))]));
    const endpoint = (table: string, names: string[]) => {
      if (!columns.has(table) || names.some((name) => !columns.get(table)!.has(name))) refuse();
    };
    const foreignKeys = new Set<string>();
    for (const fk of captured.foreignKeys) {
      record(fk, ['name', 'from', 'to', 'onDelete', 'declared', 'stitched']);
      if (
        !identifier(fk.name) ||
        (fk.onDelete !== undefined && !['cascade', 'set null', 'set default', 'restrict', 'no action'].includes(fk.onDelete))
      )
        return refuse();
      /* An App's declared reference: evidence for a path, never authority, so
         it is carried and left out of the fingerprint (authority below). */
      if (
        (fk.declared !== undefined && fk.declared !== true) ||
        (fk.stitched !== undefined && (fk.stitched !== true || fk.declared !== true)) ||
        (fk.declared && (fk.onDelete !== undefined || fk.from.columns?.length !== 1))
      )
        return refuse();
      for (const side of [fk.from, fk.to]) {
        record(side, ['table', 'columns']);
        if (!identifier(side.table) || !Array.isArray(side.columns) || !side.columns.length) return refuse();
        unique(side.columns);
        endpoint(side.table, side.columns);
      }
      if (fk.from.columns.length !== fk.to.columns.length) return refuse();
      // Constraint names are local to their referencing table, not the whole App.
      const identity = JSON.stringify([fk.from.table, fk.name]);
      if (foreignKeys.has(identity)) return refuse();
      foreignKeys.add(identity);
    }
    for (const table of captured.tables) {
      for (const column of table.columns) {
        if (column.references) endpoint(column.references.table, [column.references.column]);
      }
    }
    const frozen = freeze(captured);
    capturedCatalogs.add(frozen);
    if (frozenDerived.has(schema)) derivedCaptures.set(schema, frozen);
    return frozen;
  } catch {
    return refuse();
  }
}

/**
 * The columns whose `references` an App's declared edge gave them, and no
 * key of the database: `table\0column`. A declared edge is the App's word,
 * not the database's, so a scoped catalog carries it for the paths through
 * it and the database's own evidence never has it.
 */
function declaredOnly(schema: DatabaseSchema, stitchedOnly = false): Set<string> {
  /* A loop, not flatMap: the overflow preflight's test watches flatMap for
     Cartesian materialization, and this runs before that preflight. */
  const real = new Set<string>();
  for (const fk of schema.foreignKeys) if (!fk.declared) for (const column of fk.from.columns) real.add(`${fk.from.table}\0${column}`);
  return new Set(
    schema.foreignKeys
      .filter((fk) => fk.declared && (!stitchedOnly || fk.stitched))
      .map((fk) => `${fk.from.table}\0${fk.from.columns[0]}`)
      .filter((key) => !real.has(key)),
  );
}

function authority(schema: DatabaseSchema): unknown {
  const declared = declaredOnly(schema);
  return {
    dialect: schema.dialect,
    tables: schema.tables
      .map((table) => ({
        id: table.id,
        isView: table.isView,
        columns: table.columns
          .map((column) => ({
            name: column.name,
            /* A SQLite TEXT column the App declares a date reads `TEXT as date` in the App's catalog
               (declaredDates.ts): the App's word for how to read it, as a declared edge is, and never the
               database's. The database still says TEXT, so the suffix is left out of the fingerprint; without
               this every policy App with a write path and a declared date failed to load. */
            type: schema.dialect === 'sqlite' ? column.type.replace(DECLARED_DATE, '') : column.type,
            nullable: column.nullable,
            primaryKey: column.primaryKey,
            default: column.default,
            identity: column.identity,
            references:
              column.references && !declared.has(`${table.id}\0${column.name}`)
                ? { table: column.references.table, column: column.references.column }
                : undefined,
          }))
          .sort((a, b) => order(a.name, b.name)),
      }))
      .sort((a, b) => order(a.id, b.id)),
    foreignKeys: schema.foreignKeys
      .filter((fk) => !fk.declared)
      .map((fk) => ({
        name: fk.name,
        from: { table: fk.from.table, columns: fk.from.columns },
        to: { table: fk.to.table, columns: fk.to.columns },
        onDelete: fk.onDelete,
      }))
      .sort(fkOrder),
  };
}

export function assertScopeCatalog(expected: DatabaseSchema, actual: DatabaseSchema): void {
  const fingerprint = (schema: DatabaseSchema): string => {
    const captured = captureScopeCatalog(schema);
    const known = authorityFingerprints.get(captured);
    if (known !== undefined) return known;
    const value = JSON.stringify(authority(captured));
    authorityFingerprints.set(captured, value);
    return value;
  };
  if (fingerprint(expected) !== fingerprint(actual)) refuse();
}

/**
 * Where two catalogs part, in words for the operator who deploys the App: the
 * first table or column the App's catalog says otherwise than the database.
 * Startup's own check only (appPolicyDeployment.ts): a request's refusal keeps
 * the fixed sentence, which names nothing the caller was not shown.
 */
export function scopeCatalogDifference(expected: DatabaseSchema, actual: DatabaseSchema): string | undefined {
  type Shape = { tables: Array<{ id: string; isView: boolean; columns: Array<Record<string, unknown> & { name: string }> }> };
  let wanted: Shape, found: Shape;
  try {
    wanted = authority(captureScopeCatalog(expected)) as Shape;
    found = authority(captureScopeCatalog(actual)) as Shape;
  } catch {
    return undefined;
  }
  const say = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value));
  for (const table of wanted.tables) {
    const there = found.tables.find((each) => each.id === table.id);
    if (!there) return `table "${table.id}" is in the App's catalog and not in the database's`;
    for (const column of table.columns) {
      const other = there.columns.find((each) => each.name === column.name);
      if (!other) return `"${table.id}.${column.name}" is in the App's catalog and not in the database's`;
      for (const key of Object.keys(column))
        if (JSON.stringify(column[key]) !== JSON.stringify(other[key]))
          return `"${table.id}.${column.name}" has ${key} ${say(column[key])} in the App's catalog and ${say(other[key])} in the database's`;
    }
    const extra = there.columns.find((column) => !table.columns.some((each) => each.name === column.name));
    if (extra) return `"${table.id}.${extra.name}" is in the database's catalog and not in the App's`;
  }
  const extra = found.tables.find((table) => !wanted.tables.some((each) => each.id === table.id));
  if (extra) return `table "${extra.id}" is in the database's catalog and not in the App's`;
  return JSON.stringify(authority(captureScopeCatalog(expected))) === JSON.stringify(authority(captureScopeCatalog(actual)))
    ? undefined
    : 'their foreign keys differ';
}

/** Project exact known identities without dropping a relationship across the boundary. */
export function mapScopeCatalog(actual: DatabaseSchema, ids: ReadonlyMap<string, string>): DatabaseSchema {
  try {
    const whole = captureScopeCatalog(actual);
    /* A stitched reference joins two connections, and a scoped catalog is
       one connection's: it is left out here, never followed by a statement. */
    const stitched = declaredOnly(whole, true);
    const captured: DatabaseSchema = !stitched.size
      ? whole
      : {
          ...whole,
          tables: whole.tables.map((table) => ({
            ...table,
            columns: table.columns.map((column) => {
              if (!stitched.has(`${table.id}\0${column.name}`)) return column;
              const { references: _elsewhere, ...kept } = column;
              return kept;
            }),
          })),
          foreignKeys: whole.foreignKeys.filter((fk) => !fk.stitched),
        };
    const mapped = new Map<string, string>(Map.prototype.entries.call(ids));
    unique([...mapped.keys()]);
    unique([...mapped.values()]);
    const known = new Set(captured.tables.map((table) => table.id));
    if ([...mapped.keys()].some((id) => !known.has(id))) return refuse();
    const checkEdge = (from: string, to: string) => {
      if (mapped.has(from) !== mapped.has(to)) refuse();
    };
    for (const table of captured.tables)
      for (const column of table.columns) {
        if (column.references) checkEdge(table.id, column.references.table);
      }
    for (const fk of captured.foreignKeys) checkEdge(fk.from.table, fk.to.table);
    return captureScopeCatalog({
      ...captured,
      tables: captured.tables
        .filter((table) => mapped.has(table.id))
        .map((table) => ({
          ...table,
          id: mapped.get(table.id)!,
          columns: table.columns.map((column): ColumnMeta => ({
            ...column,
            ...(column.references ? { references: { ...column.references, table: mapped.get(column.references.table)! } } : {}),
          })),
        })),
      foreignKeys: captured.foreignKeys
        .filter((fk) => mapped.has(fk.from.table))
        .map((fk) => ({
          ...fk,
          from: { ...fk.from, table: mapped.get(fk.from.table)! },
          to: { ...fk.to, table: mapped.get(fk.to.table)! },
        })),
    });
  } catch {
    return refuse();
  }
}
