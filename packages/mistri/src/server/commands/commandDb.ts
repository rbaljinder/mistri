/**
 * The typed `db` a command handler reads and writes through: one small handle
 * per table of the command's footprint, over the command's own transaction.
 *
 * It is a view, not a second path. Every call goes through the transaction
 * the executor built — the footprint, the resource and field ceilings, the
 * row or tenant scope, the audit and cancellation — so a table missing from
 * the footprint is refused there even when a handler reaches past the types.
 * What it adds is the handler's everyday arithmetic, once: one row or a
 * `not_found`, the guarded update with its revision bump and its
 * `stale_record`, a where written as an object or in the query language, and
 * rows whose booleans read the same on every engine.
 *
 * The types come from the App's generated `Rows` through `defineSource`: a
 * handle's tables are those local to its source, and a command's `db` holds
 * exactly the tables its footprint names.
 */
import { isWriteConflict, type Condition, type Filter, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { parseQuery, type QueryPerson } from '@mistriwork/engine/shared/query.js';
import {
  columnKind,
  isJsonType,
  type ColumnKind,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
import { refuse } from './commandErrors.js';
import { fileValues } from '../http/fileRows.js';
import type { AppFileRule } from '../../shared/app.js';
import { zonedNow } from '../../shared/appZone.js';
import type { CommandDerived } from './commandWhen.js';
import type { ColumnSaying } from './commandSaying.js';

/** A value a column holds, as the handle writes it. */
export type Value = string | number | boolean | null;
/** A row when the source is untyped: every column a value. */
export type UntypedRow = Readonly<Record<string, Value>>;

/* ---------- the types ---------- */

declare const rowsType: unique symbol;
/** A typed handle on one of the App's sources: `defineSource<Rows>('lending')`. */
export interface CommandSource<Rows = unknown> {
  readonly name: string;
  readonly [rowsType]?: Rows;
}

const sources = new WeakSet<object>();
/**
 * A source the commands on it name, typed by the App's generated `Rows`
 * (mistri-schema.d.ts). A target written qualified (`applicants.applicant`)
 * reads that source's tables; an unqualified one, the App's default source's.
 */
export function defineSource<Rows = unknown>(name: string): CommandSource<Rows> {
  const handle = Object.freeze({ name });
  sources.add(handle);
  return handle as CommandSource<Rows>;
}
/** The source name a definition gives, from a handle or as text; undefined when neither. */
export const sourceName = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : value && typeof value === 'object' && sources.has(value) ? (value as CommandSource).name : undefined;

type Qualified<R, S extends string> = { [K in keyof R as K extends `${S}.${infer L}` ? L : never]: R[K] };
type Unqualified<R> = { [K in keyof R as K extends `${string}.${string}` ? never : K]: R[K] };
/** A source's tables by their local names: the qualifier a target is written with picks the source. */
export type SourceTables<Src, Target extends string> =
  Src extends CommandSource<infer R>
    ? unknown extends R
      ? Record<string, UntypedRow>
      : Target extends `${infer S}.${string}`
        ? Qualified<R, S>
        : Unqualified<R>
    : Record<string, UntypedRow>;
/** A target or table name without its source qualifier. */
export type LocalName<Name extends string> = Name extends `${string}.${infer L}` ? L : Name;
type RowIn<Scope, T> = T extends keyof Scope ? Readonly<Scope[T]> : UntypedRow;

/** Every entry must hold: a value, a list meaning one of them, `null` meaning empty. */
export type Where<Row> = { readonly [C in keyof Row]?: Row[C] | readonly Exclude<Row[C], null | undefined>[] };
/** A where: an object, or the query language (`'status = new and year >= 2018'`). */
type WhereInput<Row> = Where<Row> | string;

/** A query over one table, run when awaited. */
export interface Query<Row> extends PromiseLike<Row[]> {
  orderBy(column: keyof Row & string, direction?: 'asc' | 'desc'): Query<Row>;
  /** At most this many rows. Without it, more than 1,000 is refused rather than cut. */
  limit(count: number): Query<Row>;
  first(): Promise<Row | undefined>;
}
export interface ReadTable<Row> {
  /** The row with this key — a one-column key's value, or `{ column: value }` — or `not_found`. */
  get(key: string | number | Partial<Row>): Promise<Row>;
  /** The one row that matches, or undefined; several is the handler's mistake, not a refusal. */
  find(where: WhereInput<Row>): Promise<Row | undefined>;
  where(where?: WhereInput<Row>): Query<Row>;
  /** The query language with values, each quoted: ``where`make = ${make}` ``. */
  where(template: TemplateStringsArray, ...values: readonly (string | number | boolean)[]): Query<Row>;
  count(where?: WhereInput<Row>): Promise<number>;
}
/**
 * The constants `now`, `today` and `me` from `@mistriwork/mistri/app`, written as an
 * action's `set` writes them (appStamps.ts): the moment or the App's day in the
 * column's own format, the actor's email on a text column, their row on a
 * reference to the people table (`auth.me`).
 */
type WriteConstant = { readonly auto: 'now' | 'today' | 'me' };
/** What a write may give a column: its value, or a constant the server works out as the write runs. */
export type Written<Row> = { readonly [C in keyof Row]?: Row[C] | WriteConstant };

export interface WriteTable<Row> extends ReadTable<Row> {
  /** The row as stored, its key and defaults included. */
  insert(values: Written<Row>): Promise<Row>;
  /** Writes `changes` guarded by the row's values for those columns, bumping its revision: the new row, or `stale_record`. */
  update(row: Row, changes: Written<Row>): Promise<Row>;
  /** Removes the row by its key, or `stale_record` when it is gone. */
  remove(row: Row): Promise<void>;
  /**
   * A file resource's new row (`file: { content, name, type?, size? }`): the
   * bytes, name, type and size go in the columns the resource names, held to
   * an upload's rules — a name of at most 255 characters, the resource's
   * `maxBytes` (a tenant's at most 10 MB) — and `values` are the row's others
   * (the record it belongs to). The audit and history keep the file's name,
   * type and size, never its bytes. Only on a file resource the command writes.
   */
  insertFile(file: { readonly name: string; readonly type?: string; readonly data: Uint8Array }, values?: Written<Row>): Promise<Row>;
}

/** A command's tables: read `R`, written `W`. */
export type CommandTables<Scope, R extends string, W extends string> = {
  readonly [T in R | W]: T extends W ? WriteTable<RowIn<Scope, T>> : ReadTable<RowIn<Scope, T>>;
};
/** One table's row on a source: `RowOf<typeof lending, 'lead'>`. */
export type RowOf<Src, Table extends string> = RowIn<SourceTables<Src, Table>, LocalName<Table>>;
/** Some of a source's tables, read-only — for a helper a handler passes its `db` to. */
export type CommandDb<Src, Tables extends string> = { readonly [T in Tables]: ReadTable<RowOf<Src, T>> };

/* ---------- the catalog ---------- */

/** One footprint table as the handle needs it: its key, each column's kind, and its metadata named locally. */
interface CommandTable {
  readonly name: string;
  readonly key: readonly string[];
  readonly kinds: Readonly<Record<string, ColumnKind>>;
  readonly meta: TableMeta;
  /** The rollups and computed columns a command's `when` may judge it by (commandWhen.ts); its handler reads columns. */
  readonly derived?: CommandDerived;
  /** How the App says this table's columns to a person (commandSaying.ts): a refusal's words, never the handler's `db`. */
  readonly saying?: ColumnSaying;
  /** The App's zone (`ui.timezone`), where the catalog is a command's: the `now` its `when` and its handler's `where`
      are given is the instant a stamp records, and a date phrase reads this zone's wall clock from it, as a list does. */
  readonly zone?: string;
}
/** The footprint's tables by local name. */
export type CommandCatalog = Readonly<Record<string, CommandTable>>;

/** A command's catalog read in the App's zone (`CommandTable.zone`); unchanged where the App names none. */
export function zonedCatalog(catalog: CommandCatalog, zone: string | undefined): CommandCatalog {
  if (!zone) return catalog;
  return Object.freeze(Object.fromEntries(Object.entries(catalog).map(([name, table]) => [name, Object.freeze({ ...table, zone })])));
}

/** The catalog of a footprint, from the logical schema; undefined for a table it does not hold. */
export function commandCatalog(
  schema: DatabaseSchema,
  footprint: readonly string[],
  logical: (local: string) => string,
): CommandCatalog | undefined {
  const tables: Record<string, CommandTable> = {};
  for (const name of footprint) {
    const meta = schema.tables.find((table) => table.id === logical(name));
    if (!meta) return undefined;
    tables[name] = Object.freeze({
      name,
      key: Object.freeze(meta.columns.filter((column) => column.primaryKey).map((column) => column.name)),
      kinds: Object.freeze(Object.fromEntries(meta.columns.map((column) => [column.name, columnKind(column.type)]))),
      meta: Object.freeze({ ...meta, id: name, name, schema: '' }),
    });
  }
  return Object.freeze(tables);
}

/* ---------- wheres ---------- */

const DEFAULT_CAP = 1000;
interface Compiled {
  readonly filter: Filter;
  readonly none: boolean;
  readonly orderBy: { column: string; direction: 'asc' | 'desc' }[];
  readonly limit?: number;
}
const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw);

/* A template's values are always quoted, whatever they look like: the word
   `or` from a form is a value, never the language's `or`. */
function quoted(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  throw new TypeError('A where template takes text, numbers and booleans; for an empty value write "is empty".');
}

/**
 * A where as a filter over one table. Errors are the handler's: they name the table and the problem. `me` is
 * the actor where a command's `when` is judged (commandWhen.ts); a handler's own where is handed none, so `me`
 * there is refused — it writes `actor.email` instead.
 */
export function compileWhere(
  table: CommandTable,
  where: unknown,
  now: Date,
  values: readonly unknown[] = [],
  me?: QueryPerson,
  /** Admit a column on a condition's right (`qty < reorder_at`): only for a `when`, which commandWhen.ts judges once the row is read. */
  options: { columnValues?: boolean } = {},
): Compiled {
  if (where === undefined) return { filter: { groups: [] }, none: false, orderBy: [] };
  if (typeof where === 'string' || isTemplate(where)) {
    const text =
      typeof where === 'string'
        ? where
        : where.reduce((out, part, index) => out + part + (index < values.length ? quoted(values[index]) : ''), '');
    const schema: DatabaseSchema = { label: table.name, dialect: 'sqlite', tables: [table.meta], foreignKeys: [], readAt: '' };
    const { query, errors } = parseQuery(`${table.name} ${text}`, {
      schema,
      now: zonedNow(table.zone, now),
      ...(me ? { me } : {}),
      ...(options.columnValues ? { columnValues: true } : {}),
    });
    if (!query || errors.length)
      throw new Error(`${table.name}: ${errors.map((error) => error.message).join(' ') || 'the where could not be read.'}`);
    if (query.columns.length) throw new Error(`${table.name}: a where names rows, not columns; leave out "show".`);
    return { filter: query.filter, none: false, orderBy: query.orderBy, ...(query.limit === undefined ? {} : { limit: query.limit }) };
  }
  if (!where || typeof where !== 'object' || Array.isArray(where))
    throw new TypeError(`${table.name}: a where is an object or the query language.`);
  const conditions: Condition[] = [];
  let none = false;
  for (const [column, value] of Object.entries(where)) {
    if (!Object.hasOwn(table.kinds, column)) throw new Error(`${table.name}: "${column}" is not one of its columns.`);
    if (value === null) conditions.push({ column, op: 'isNull' });
    else if (Array.isArray(value)) {
      if (!value.length) none = true;
      else conditions.push({ column, op: 'in', value: value.map((item) => scalar(table, column, item)) as Array<string | number> });
    } else if (value !== undefined) conditions.push({ column, op: '=', value: scalar(table, column, value) });
  }
  return { filter: { groups: conditions.length ? [conditions] : [] }, none, orderBy: [] };
}

function scalar(table: CommandTable, column: string, value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError(`${table.name}.${column}: a where compares text, numbers and booleans.`);
}

/** The filter naming one row by its key. */
export const keyFilter = (key: Readonly<Record<string, string | number>>): Filter => ({
  groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))],
});

/**
 * A key as a request or a handler spells it, made exact: an integer column
 * takes a safe integer or its canonical digits (an id past 2^53 stays its
 * digits and is never rounded into another row); `'01'`, `'1e0'` and `' 1'`
 * name no row. Undefined when the spelling names none.
 */
export function canonicalKey(
  table: Pick<CommandTable, 'key' | 'kinds'>,
  key: Readonly<Record<string, unknown>>,
): Record<string, string | number> | undefined {
  const exact: Record<string, string | number> = {};
  for (const column of table.key) {
    const value = key[column];
    if (table.kinds[column] === 'number') {
      if (typeof value === 'number' && Number.isSafeInteger(value)) exact[column] = value;
      else if (typeof value === 'string' && /^(0|-?[1-9][0-9]{0,39})$/.test(value))
        exact[column] = Number.isSafeInteger(Number(value)) ? Number(value) : value;
      else return undefined;
    } else if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) exact[column] = value;
    else return undefined;
  }
  return exact;
}

/** A row as the handle hands it out: a boolean column reads true or false on every engine; frozen. */
export function normalizeRow(table: CommandTable, row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const copy: Record<string, unknown> = { ...row };
  for (const [column, kind] of Object.entries(table.kinds)) {
    if (kind === 'boolean' && (copy[column] === 0 || copy[column] === 1)) copy[column] = copy[column] === 1;
  }
  /* A JSON column reads as its value on every engine: node-pg parses jsonb,
     SQLite hands back the text. */
  for (const column of table.meta.columns) {
    if (!isJsonType(column.type) || typeof copy[column.name] !== 'string') continue;
    try {
      copy[column.name] = JSON.parse(copy[column.name] as string);
    } catch {
      // Text that is not JSON stays the text it is.
    }
  }
  return Object.freeze(copy);
}

/* ---------- the handle ---------- */

type Reader = Pick<WriteTransaction, 'query' | 'count'>;
interface CommandDbOptions {
  readonly tx: Reader | WriteTransaction;
  readonly catalog: CommandCatalog;
  readonly read: readonly string[];
  /** Tables with insert, update and remove. Empty for a read-only handle. */
  readonly write: readonly string[];
  /** The revision column `update` bumps on any table that has it. */
  readonly versionField?: string;
  /** A conflict on this table's row names the row's key. */
  readonly target?: string;
  readonly now: () => Date;
  /** The file resources among `write`, by local name: their rows take bytes through `insertFile`. */
  readonly files?: ReadonlyMap<string, AppFileRule>;
  /** Puts a new file's bytes in its resource's bucket before the row is written, and gives the row's values naming
      the object (files/fileStorage.ts); the caller deletes the object if the transaction rolls back. */
  /** Work to start once the command has committed (a public picture's pre-made copies); never run on a rollback. */
  readonly afterCommit?: (run: () => void) => void;
  readonly placeFile?: (rule: AppFileRule, values: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** What a constant (`now`, `today`, `me`) writes to a column; absent, a constant is refused. */
  readonly constant?: (table: CommandTable, column: ColumnMeta, word: WriteConstant['auto']) => Promise<Value>;
}

const isConstant = (value: unknown): value is WriteConstant =>
  !!value &&
  typeof value === 'object' &&
  Object.keys(value).length === 1 &&
  ['now', 'today', 'me'].includes((value as { auto?: unknown }).auto as string);

/* Each constant replaced by what it means now, in its column's format; the rest as given. */
async function withConstants(
  table: CommandTable,
  values: Record<string, unknown>,
  options: CommandDbOptions,
): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> | undefined;
  for (const [column, value] of Object.entries(values)) {
    if (!isConstant(value)) continue;
    const meta = table.meta.columns.find((candidate) => candidate.name === column);
    if (!meta) throw new Error(`${table.name}: "${column}" is not one of its columns.`);
    if (!options.constant) throw new Error(`${table.name}: "${column}" is ${value.auto}, which this handle cannot write.`);
    out ??= { ...values };
    out[column] = await options.constant(table, meta, value.auto);
  }
  return out ?? values;
}

/** The `db` of one command run: a frozen object of table handles, exactly the footprint's. */
export function createCommandDb(options: CommandDbOptions): Readonly<Record<string, ReadTable<UntypedRow> | WriteTable<UntypedRow>>> {
  const handles: Record<string, ReadTable<UntypedRow> | WriteTable<UntypedRow>> = {};
  for (const name of new Set([...options.read, ...options.write])) {
    const table = options.catalog[name];
    if (!table) throw new Error(`The command's catalog has no table "${name}".`);
    handles[name] = tableHandle(table, options.write.includes(name), options);
  }
  return Object.freeze(handles);
}

function tableHandle(table: CommandTable, writable: boolean, options: CommandDbOptions): ReadTable<UntypedRow> | WriteTable<UntypedRow> {
  const { tx, now } = options;
  const name = table.name;
  const rows = async (compiled: Compiled, limit: number, orderBy = compiled.orderBy): Promise<UntypedRow[]> => {
    if (compiled.none) return [];
    const result = await tx.query({ table: name, filter: compiled.filter, limit, offset: 0, ...(orderBy.length ? { orderBy } : {}) });
    return result.rows.map((row) => normalizeRow(table, row) as UntypedRow);
  };
  const keyOf = (row: unknown): Record<string, string | number> => {
    const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const key = table.key.length ? canonicalKey(table, record) : undefined;
    if (!key) throw new Error(`${name}: the row carries no key; pass a row read through db.${name}.`);
    return key;
  };
  const stale = (key: Record<string, string | number>) => refuse('stale_record', name === options.target ? { key } : undefined);
  const read: ReadTable<UntypedRow> = {
    async get(key) {
      const given =
        key !== null && typeof key === 'object'
          ? (key as Record<string, unknown>)
          : table.key.length === 1
            ? { [table.key[0]]: key }
            : undefined;
      if (!given || Object.keys(given).length !== table.key.length || table.key.some((column) => !Object.hasOwn(given, column))) {
        throw new Error(`${name}: get takes the key (${table.key.join(', ')}); find takes any other columns.`);
      }
      const exact = canonicalKey(table, given);
      if (!exact) return refuse('not_found');
      const found = await rows({ filter: keyFilter(exact), none: false, orderBy: [] }, 2);
      if (found.length > 1) throw new Error(`${name}: its key names ${found.length} rows.`);
      return found[0] ?? refuse('not_found');
    },
    async find(where) {
      const found = await rows(compileWhere(table, where, now()), 2);
      if (found.length > 1) throw new Error(`${name}: find matched several rows; narrow the where, or use where().`);
      return found[0];
    },
    where(where?: unknown, ...values: readonly unknown[]): Query<UntypedRow> {
      const order: { column: string; direction: 'asc' | 'desc' }[] = [];
      let cap: number | undefined;
      const run = async (limit?: number): Promise<UntypedRow[]> => {
        const compiled = compileWhere(table, where, now(), values);
        const bound = limit ?? cap ?? compiled.limit;
        const found = await rows(compiled, bound ?? DEFAULT_CAP + 1, [...compiled.orderBy, ...order]);
        if (bound === undefined && found.length > DEFAULT_CAP) {
          throw new Error(`${name}: more than ${DEFAULT_CAP} rows match; say how many with .limit(n).`);
        }
        return found;
      };
      const query: Query<UntypedRow> = {
        orderBy(column, direction = 'asc') {
          if (!Object.hasOwn(table.kinds, column)) throw new Error(`${name}: "${column}" is not one of its columns.`);
          order.push({ column, direction: direction === 'desc' ? 'desc' : 'asc' });
          return query;
        },
        limit(count) {
          if (!Number.isSafeInteger(count) || count < 1) throw new RangeError(`${name}: a limit is a positive whole number.`);
          cap = count;
          return query;
        },
        first: async () => (await run(1))[0],
        // Awaiting the query runs it: `await db.vehicle.where(...).limit(5)` reads once, after the chain is written.
        // eslint-disable-next-line unicorn/no-thenable -- the lazy thenable is the query's whole interface.
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return query;
    },
    async count(where) {
      const compiled = compileWhere(table, where, now());
      return compiled.none ? 0 : tx.count(name, compiled.filter);
    },
  };
  if (!writable) return Object.freeze(read);
  const writer = tx as WriteTransaction;
  const insert = async (given: Record<string, unknown>) => {
    const values = await withConstants(table, given, options);
    const result = await writer.insert({ table: name, values: values as Record<string, Value> });
    return normalizeRow(table, result.row ?? { ...result.applied, ...result.key }) as UntypedRow;
  };
  return Object.freeze({
    ...read,
    insert,
    async insertFile(file, values = {}) {
      const rule = options.files?.get(name);
      if (!rule) throw new Error(`${name}: insertFile writes a file resource, and ${name} declares no "file".`);
      const data = file?.data as unknown;
      if (!(data instanceof Uint8Array)) throw new TypeError(`${name}: insertFile takes the file's bytes as a Uint8Array (or a Buffer).`);
      const made = fileValues(rule, { name: file.name, type: file.type, bytes: data }, values);
      if ('error' in made) throw new Error(`${name}: ${made.error}`);
      // The pre-made copies of a public picture start when the command has committed (businessCommandExecution.ts).
      if (made.stored) options.afterCommit?.(made.stored);
      if (rule.storage !== 'bucket') return insert(made.values);
      if (!options.placeFile) throw new Error(`${name}: its files are kept in a bucket, which this command cannot write to.`);
      return insert(await options.placeFile(rule, made.values));
    },
    async update(row, changes) {
      const key = keyOf(row);
      const values = { ...(await withConstants(table, changes as Record<string, unknown>, options)) } as Record<string, Value>;
      for (const column of Object.keys(values)) {
        if (!Object.hasOwn(table.kinds, column)) throw new Error(`${name}: "${column}" is not one of its columns.`);
      }
      if (!Object.keys(values).length) return row;
      const revision = options.versionField;
      if (revision && Object.hasOwn(table.kinds, revision) && !Object.hasOwn(values, revision)) {
        const current = (row as Record<string, unknown>)[revision];
        if (typeof current === 'number' && Number.isSafeInteger(current) && current < Number.MAX_SAFE_INTEGER)
          values[revision] = current + 1;
      }
      /* The guard: exactly the changed columns, each at the value this row was
         read with — but a JSON column, which no engine compares and which is
         written whole (appAccess.ts). */
      const expected: Record<string, Value> = {};
      for (const column of Object.keys(values)) {
        if (!Object.hasOwn(row, column)) throw new Error(`${name}: update needs the row as read; it has no "${column}".`);
        if (table.meta.columns.some((meta) => meta.name === column && isJsonType(meta.type))) continue;
        expected[column] = ((row as Record<string, unknown>)[column] ?? null) as Value;
      }
      let result: Awaited<ReturnType<WriteTransaction['update']>>;
      try {
        result = await writer.update({ table: name, key, expected, values });
      } catch (error) {
        if (isWriteConflict(error)) return stale(key);
        throw error;
      }
      if (result.affected !== 1) return stale(key);
      return normalizeRow(table, { ...row, ...values, ...result.applied }) as UntypedRow;
    },
    async remove(row) {
      const key = keyOf(row);
      const result = await writer.remove({ table: name, key });
      if (result.affected !== 1) stale(key);
    },
  } satisfies WriteTable<UntypedRow>);
}
