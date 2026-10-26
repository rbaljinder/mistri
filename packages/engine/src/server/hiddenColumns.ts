/**
 * A connection that never hands out some of its columns.
 *
 * `"hidden": { "account": ["password_hash"], "*": ["*_token"] }` in
 * tablewalk.json keeps those columns from everything served over the
 * connection: the Workbench, MCP, and every App on it. It is enforced where
 * `"rows": false` is (shapeonly.ts), by wrapping the adapter before the
 * registry stores it, so a feature added later inherits the boundary instead
 * of having to remember it.
 *
 * The checks are the App grants' own (resourceChecks in columnGrants.ts):
 * the catalog is served without the columns, so a query, a view, a filter or
 * a sort that names one is refused as naming a column that is not there, and
 * a read that names no columns gets the visible ones, never `SELECT *`.
 * Raw SQL is refused outright: a statement cannot be column-redacted
 * honestly. The strongest form of this boundary is still the database's own:
 * a role without SELECT on those columns, which no tablewalk bug can undo.
 */
import { Refusal, type Adapter, type ScopedReads, type WriteTransaction } from '../adapters/adapter.js';
import { CONNECTION_HIDDEN, type DatabaseSchema } from '../shared/schema.js';
import { AppAccessDenied, accessibleSchema, authorizeColumnWrites, resourceChecks, type ColumnGrant } from './columnGrants.js';
import { lendWriteView } from '../adapters/storeHost.js';
import { configFileName } from './product.js';

/** Table (id, bare name or "*") → column names, `*` a wildcard within a name. As written in tablewalk.json. */
export type HiddenColumnRules = Readonly<Record<string, readonly string[]>>;

/** The rules as the config file must spell them, refused with the file's own words otherwise. */
export function parseHiddenColumns(raw: unknown, where: string): HiddenColumnRules {
  const shape = `"hidden" must be an object of table → column names, like { "account": ["password_hash"], "*": ["*_token"] }`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) throw new Error(`${where}: ${shape}.`);
  for (const [table, columns] of Object.entries(raw)) {
    if (
      !table.trim() ||
      !Array.isArray(columns) ||
      !columns.length ||
      columns.some((column) => typeof column !== 'string' || !column.trim() || /^\*+$/.test(column.trim()))
    ) {
      throw new Error(
        `${where}: "hidden" for "${table}" is not a list of column names (a "*" matches within a name, never a whole table). ${shape}.`,
      );
    }
  }
  return raw as HiddenColumnRules;
}

const matcher = (pattern: string) =>
  new RegExp(
    `^${pattern
      .trim()
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );

/** Each table's cut columns under the rules, by table id; a primary key is refused, since every link to a record carries it. */
function hiddenByTable(schema: DatabaseSchema, rules: HiddenColumnRules, name: string): Map<string, Set<string>> {
  const patterns = Object.entries(rules).map(([table, columns]) => ({ table, columns: columns.map(matcher) }));
  const cuts = new Map<string, Set<string>>();
  for (const table of schema.tables) {
    const applying = patterns.filter((rule) => rule.table === '*' || rule.table === table.id || rule.table === table.name);
    const cut = table.columns.filter((column) => applying.some((rule) => rule.columns.some((pattern) => pattern.test(column.name))));
    const key = cut.find((column) => column.primaryKey);
    if (key) {
      throw new Error(
        `"${name}" has "hidden" covering ${table.id}.${key.name}, part of a primary key: every link to a record carries it. ` +
          `Narrow the pattern in your ${configFileName()}.`,
      );
    }
    if (cut.length) cuts.set(table.id, new Set(cut.map((column) => column.name)));
  }
  return cuts;
}

/** Every table read and written as the connection allows, minus the cut columns, as one grant. */
function grantOf(schema: DatabaseSchema, cuts: Map<string, Set<string>>): ColumnGrant {
  const all = new Set(schema.tables.map((table) => table.id));
  return {
    readable: all,
    writable: all,
    fields: new Map(
      [...cuts].map(([id, cut]) => {
        const visible = schema.tables
          .find((table) => table.id === id)!
          .columns.map((column) => column.name)
          .filter((column) => !cut.has(column));
        return [id, { read: new Set(visible), write: new Set(visible) }];
      }),
    ),
  };
}

/** The catalog as served: the columns gone, and every edge, index and list naming one. */
export function withoutHiddenColumns(schema: DatabaseSchema, rules: HiddenColumnRules, name: string): DatabaseSchema {
  const cuts = hiddenByTable(schema, rules, name);
  if (!cuts.size) return schema;
  const pruned = accessibleSchema(schema, grantOf(schema, cuts));
  const keep = (id: string, columns?: string[]) => columns?.filter((column) => !cuts.get(id)?.has(column));
  return {
    ...pruned,
    tables: pruned.tables.map((table) => {
      // accessibleSchema narrows `deletable` where a field map exists; a connection's deletes stay its own to judge.
      const original = schema.tables.find((item) => item.id === table.id)!;
      const { deletable: _deletable, ...rest } = table;
      // Likewise each column's `writable`: the grant says nothing about writes here.
      const columns = table.columns.map((column) => {
        const { writable: _writable, ...said } = column;
        const was = original.columns.find((item) => item.name === column.name)!;
        return was.writable !== undefined ? { ...said, writable: was.writable } : said;
      });
      const cut = cuts.get(table.id);
      return {
        ...rest,
        columns,
        ...(cut ? { [CONNECTION_HIDDEN]: [...cut] } : {}),
        ...(original.deletable !== undefined ? { deletable: original.deletable } : {}),
        ...(table.filterable ? { filterable: keep(table.id, table.filterable) } : {}),
        ...(table.sortable ? { sortable: keep(table.id, table.sortable) } : {}),
      };
    }),
  };
}

/**
 * The same adapter with the rules' columns cut from every answer and refused
 * in every question. Methods are copied, not proxied, so an optional one the
 * adapter lacks stays absent (shapeonly.ts says why).
 */
export function hideColumns(adapter: Adapter, name: string, rules: HiddenColumnRules, introspected: DatabaseSchema): Adapter {
  const refused = (what: string) =>
    new Refusal(
      `"${name}" hides columns ("hidden" in your ${configFileName()}): ${what}. ` +
        'The hidden columns are not in its catalog, so nothing can ask for them.',
    );
  let full = introspected;
  let cuts = hiddenByTable(full, rules, name);
  let checks = resourceChecks(full, grantOf(full, cuts));
  const refresh = (schema: DatabaseSchema) => {
    full = schema;
    cuts = hiddenByTable(full, rules, name);
    checks = resourceChecks(full, grantOf(full, cuts));
  };
  /* A grant's refusal is deliberately opaque to an App's reader; here the
     person asking owns the config, so it says which boundary answered. */
  const checked = <T>(check: () => T): T => {
    try {
      return check();
    } catch (error) {
      if (error instanceof AppAccessDenied) throw refused('this request names a hidden column, or would return one');
      throw error;
    }
  };
  const from = <K extends keyof Adapter>(key: K) => {
    const method = adapter[key];
    return typeof method === 'function' ? (method as (...args: unknown[]) => unknown).bind(adapter) : undefined;
  };
  const authorized = (tx: WriteTransaction): WriteTransaction => {
    const inner = authorizeColumnWrites(full, grantOf(full, cuts), tx);
    const guard =
      <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        try {
          return run(...args).catch((error) => {
            throw error instanceof AppAccessDenied ? refused('this write names a hidden column, or would return or remove one') : error;
          });
        } catch (error) {
          return Promise.reject(
            error instanceof AppAccessDenied ? refused('this write names a hidden column, or would return or remove one') : error,
          );
        }
      };
    return {
      ...(inner.lockRecord ? { lockRecord: guard(inner.lockRecord) } : {}),
      query: guard(inner.query),
      count: guard(inner.count),
      insert: guard(inner.insert),
      update: guard(inner.update),
      remove: guard(inner.remove),
      ...(inner.tell ? { tell: guard(inner.tell) } : {}),
    };
  };
  const reads = (bound: ScopedReads): ScopedReads => ({
    query: (request) => bound.query(checked(() => checks.queryFor(request))),
    count: (table, filter, limit) =>
      bound.count(
        table,
        checked(() => checks.filterFor(table, filter)),
        limit,
      ),
    runView: (view, offset) =>
      bound.runView(
        checked(() => checks.viewFor(view)),
        offset,
      ),
    countView: (view, limit) =>
      bound.countView(
        checked(() => checks.viewFor(view)),
        limit,
      ),
    runBreakdown: (def, offset) =>
      bound.runBreakdown(
        checked(() => checks.breakdownFor(def)),
        offset,
      ),
    countBreakdown: (def, limit) =>
      bound.countBreakdown(
        checked(() => checks.breakdownFor(def)),
        limit,
      ),
  });

  const wrapped: Adapter = Object.create(Object.getPrototypeOf(adapter) as object) as Adapter;
  Object.assign(wrapped, adapter);
  wrapped.close = from('close') as Adapter['close'];
  wrapped.introspect = async () => {
    refresh(await adapter.introspect());
    return withoutHiddenColumns(full, rules, name);
  };
  if (adapter.poolStats) wrapped.poolStats = from('poolStats') as Adapter['poolStats'];
  if (adapter.privileges) wrapped.privileges = from('privileges') as Adapter['privileges'];
  if (adapter.estimateCount) wrapped.estimateCount = from('estimateCount') as Adapter['estimateCount'];
  wrapped.query = async (request) => adapter.query(checked(() => checks.queryFor(request)));
  wrapped.count = async (table, filter, limit) =>
    adapter.count(
      table,
      checked(() => checks.filterFor(table, filter)),
      limit,
    );
  if (adapter.countEach)
    wrapped.countEach = async (items, limit) =>
      adapter.countEach!(
        checked(() => items.map((item) => ({ table: item.table, filter: checks.filterFor(item.table, item.filter) }))),
        limit,
      );
  if (adapter.runView)
    wrapped.runView = async (view, offset) =>
      adapter.runView!(
        checked(() => checks.viewFor(view)),
        offset,
      );
  if (adapter.countView)
    wrapped.countView = async (view, limit) =>
      adapter.countView!(
        checked(() => checks.viewFor(view)),
        limit,
      );
  if (adapter.runBreakdown)
    wrapped.runBreakdown = async (def, offset) =>
      adapter.runBreakdown!(
        checked(() => checks.breakdownFor(def)),
        offset,
      );
  if (adapter.countBreakdown)
    wrapped.countBreakdown = async (def, limit) =>
      adapter.countBreakdown!(
        checked(() => checks.breakdownFor(def)),
        limit,
      );
  if (adapter.scopeReads) wrapped.scopeReads = async (scope) => reads(await adapter.scopeReads!(scope));
  /* Raw SQL can name any column, in any spelling, through any function: no
     honest redaction exists for it. EXPLAIN is refused with it, since a plan
     can be asked to run the statement. */
  if (adapter.runSql)
    wrapped.runSql = async () => {
      throw refused(
        'raw SQL is refused, because a statement can name any column. Remove "hidden" to run SQL here, or connect as a database role without SELECT on those columns',
      );
    };
  if (adapter.explainSql)
    wrapped.explainSql = async () => {
      throw refused('explaining raw SQL is refused with running it');
    };
  // A table's DDL spells out every column, the hidden ones too.
  if (adapter.ddl) wrapped.ddl = async (table) => (cuts.has(table) ? undefined : adapter.ddl!(table));
  /* Profile keeps its numbers for the columns that are served. */
  if (adapter.profile)
    wrapped.profile = async (table, limits) => {
      const result = await adapter.profile!(table, limits);
      const cut = cuts.get(table);
      return cut ? { ...result, columns: result.columns.filter((column) => !cut.has(column.column)) } : result;
    };
  /* Writes are judged by the same grant: a hidden column is never written,
     and an insert's stored row comes back without it. A delete removes every
     column, the hidden ones too, and journals them for Undo, so it is
     refused on a table with hidden columns. */
  if (adapter.insert) wrapped.insert = (request) => authorized(adapter as unknown as WriteTransaction).insert(request);
  if (adapter.update) wrapped.update = (request) => authorized(adapter as unknown as WriteTransaction).update(request);
  if (adapter.remove) wrapped.remove = (request) => authorized(adapter as unknown as WriteTransaction).remove(request);
  if (adapter.transaction) wrapped.transaction = (run) => adapter.transaction!((tx) => run(authorized(tx)));
  if (adapter.scopeTransaction)
    wrapped.scopeTransaction = (scope, run) =>
      adapter.scopeTransaction!(scope, (tx, catalog) => run(authorized(tx), withoutHiddenColumns(catalog, rules, name)));
  /* The command journal runs its work under the same grant and catalog. */
  lendWriteView(wrapped, {
    over: adapter,
    records: (records) => authorized(records),
    catalog: (catalog) => withoutHiddenColumns(catalog, rules, name),
  });
  return wrapped;
}
