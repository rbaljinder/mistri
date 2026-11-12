/**
 * A visitor's `auth.public.byKey` (shared/appAuthGrants.ts): of what the public grant reads, the resources a
 * visitor opens one record at a time by its key and never lists — a link's page, not a directory.
 *
 * Held here, on the adapter every visitor read goes through (appAccess.ts `authorizeResources`), not on the routes:
 * a route added later reaches these tables through the same few methods, and each of them refuses a byKey table
 * unless it is asked for one row by its whole primary key. A count, a breakdown, a sum, a list, a search and a
 * reference picker over such a table are all refused, whatever route asked; so is any read of another table that
 * reaches one through a reference, a rollup, a tag list or an `any` — that would list its rows by another name.
 * Only the methods named below pass, so an adapter method added later is refused here until it is judged. A
 * visitor's adapter carries no `transaction` or write method at all.
 */
import { ANSI_STYLE, type Adapter, type QueryRequest } from '@mistriwork/engine/adapters/adapter.js';
import { AppAccessDenied, requestData, resourceChecks, type ColumnGrant } from '@mistriwork/engine/server/columnGrants.js';
import { carryServerRequest, isServerRequest } from '@mistriwork/engine/server/serverRequests.js';
import { rollupReads } from '@mistriwork/engine/shared/rollups.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { compileView } from '@mistriwork/engine/shared/view.js';
import type { ViewDef } from '@mistriwork/engine/shared/viewPaths.js';

type KeyCondition = { column?: unknown; path?: unknown; op?: unknown; value?: unknown };

/* The filter is the record's whole key and nothing else: one group, one `=` per key column, each a plain value. */
function isKeyFilter(full: DatabaseSchema, table: string, filter: unknown, field: 'column' | 'path'): boolean {
  const meta = full.tables.find((candidate) => candidate.id === table);
  const key = meta ? primaryKey(meta) : [];
  const groups = (filter as { groups?: unknown } | undefined)?.groups;
  if (!key.length || !Array.isArray(groups) || groups.length !== 1 || !Array.isArray(groups[0])) return false;
  const conditions = groups[0] as KeyCondition[];
  if (conditions.length !== key.length) return false;
  const named = new Set<string>();
  for (const condition of conditions) {
    if (Object.keys(condition).some((name) => name !== field && name !== 'op' && name !== 'value')) return false;
    const column = condition[field];
    if (typeof column !== 'string' || !key.includes(column) || named.has(column) || condition.op !== '=') return false;
    if (typeof condition.value !== 'string' && typeof condition.value !== 'number') return false;
    named.add(column);
  }
  return true;
}

/* One row: a visitor's read says 1. The server's own read of a file's row asks for 2 to tell a key that is not
   unique (http/fileRows.ts); under a whole primary key that is still at most the one row. */
const oneRow = (input: unknown, limit: unknown, offset: unknown) =>
  (limit === 1 || (limit === 2 && isServerRequest(input))) && (offset === undefined || offset === 0);

/** The adapter a visitor reads byKey tables through: every read of one is a single record by its key, or refused. */
export function byKeyAdapter(underlying: Adapter, full: DatabaseSchema, access: ColumnGrant, byKey: ReadonlySet<string>): Adapter {
  /* What may be listed: the grant without its byKey tables, so the checks that guard every read (columnGrants.ts)
     refuse a byKey table wherever a listing read names it — as a base, a hop, a rollup's or tag list's rows, an
     `any`. And per byKey table, the grant without the others: the record's own references read as they would. */
  const without = (kept?: string) =>
    resourceChecks(full, {
      ...access,
      readable: new Set([...access.readable].filter((table) => !byKey.has(table) || table === kept)),
    });
  const listing = without();
  const record = new Map<string, ReturnType<typeof resourceChecks>>();
  const recordChecks = (table: string) => {
    let checks = record.get(table);
    if (!checks) record.set(table, (checks = without(table)));
    return checks;
  };
  const refuseByKey = (table: string) => {
    if (byKey.has(table)) throw new AppAccessDenied();
  };
  /* A byKey record's own rollups, aggregates and tag lists read other rows; rows of its own table among them
     would say something of records the visitor holds no key to. */
  const assertNoSelfRows = (view: ViewDef) => {
    for (const aggregate of view.aggregates ?? []) {
      const reference = full.foreignKeys.find((fk) => fk.name === aggregate.via);
      if (!reference || byKey.has(reference.from.table)) throw new AppAccessDenied();
    }
    for (const rollup of Object.values(view.computed ?? {})) for (const { table } of rollupReads(rollup)) refuseByKey(table);
    for (const tags of Object.values(view.tagged ?? {})) {
      refuseByKey(tags.through);
      refuseByKey(tags.to);
    }
  };
  const queryFor = (input: QueryRequest): QueryRequest => {
    const request = carryServerRequest(input, requestData(input));
    if (!byKey.has(request.table)) {
      listing.queryFor(request);
      return request;
    }
    if (request.lanes !== undefined || !oneRow(input, request.limit, request.offset)) throw new AppAccessDenied();
    if (!isKeyFilter(full, request.table, request.filter, 'column')) throw new AppAccessDenied();
    recordChecks(request.table).queryFor(request);
    return request;
  };
  const viewFor = (input: ViewDef, offset?: number): ViewDef => {
    const view = carryServerRequest(input, requestData(input));
    if (!byKey.has(view.base)) {
      listing.viewFor(view);
      return view;
    }
    /* Written as text, a view is parsed against a catalog before anything here could see its filter. */
    if (view.text !== undefined || view.lanes !== undefined || view.limit !== 1 || (offset ?? 0) !== 0) throw new AppAccessDenied();
    if (!isKeyFilter(full, view.base, view.filter, 'path')) throw new AppAccessDenied();
    assertNoSelfRows(view);
    const checks = recordChecks(view.base);
    const checked = checks.viewFor(view);
    /* The record's own table is readable under its checks, so a path that loops back to it (a self reference's
       `parent_id.make`, or out through a neighbor and back) would read a row the visitor holds no key to. A hop
       onto a byKey table, this one included, is a join the compiled view shows. */
    if (compileView(checks.schema, checked, ANSI_STYLE).joins.some((join) => byKey.has(join.table))) throw new AppAccessDenied();
    return view;
  };
  const guarded: Adapter = {
    dialect: underlying.dialect,
    introspect: () => underlying.introspect(),
    close: () => underlying.close(),
    query: (request) => underlying.query(queryFor(request)),
    count: (table, filter, limit) => {
      refuseByKey(table);
      listing.filterFor(table, filter);
      return underlying.count(table, filter, limit);
    },
  };
  if (underlying.countEach)
    guarded.countEach = (items, limit) => {
      for (const item of requestData(items)) {
        refuseByKey(item.table);
        listing.filterFor(item.table, item.filter);
      }
      return underlying.countEach!(items, limit);
    };
  if (underlying.estimateCount)
    guarded.estimateCount = (table) => {
      refuseByKey(table);
      return underlying.estimateCount!(table);
    };
  if (underlying.profile)
    guarded.profile = (table, limits) => {
      refuseByKey(table);
      return underlying.profile!(table, limits);
    };
  if (underlying.runView) guarded.runView = (view, offset) => underlying.runView!(viewFor(view, offset), offset);
  /* A count of a view is a count of its base's rows: a byKey base is refused before its key is looked at. */
  if (underlying.countView)
    guarded.countView = (input, limit) => {
      const view = carryServerRequest(input, requestData(input));
      refuseByKey(view.base);
      listing.viewFor(view);
      return underlying.countView!(view, limit);
    };
  if (underlying.runBreakdown)
    guarded.runBreakdown = (input, offset) => {
      const def = carryServerRequest(input, requestData(input));
      listing.breakdownFor(def);
      return underlying.runBreakdown!(def, offset);
    };
  if (underlying.countBreakdown)
    guarded.countBreakdown = (input, limit) => {
      const def = carryServerRequest(input, requestData(input));
      listing.breakdownFor(def);
      return underlying.countBreakdown!(def, limit);
    };
  if (underlying.aggregate)
    guarded.aggregate = (input) => {
      const request = carryServerRequest(input, requestData(input));
      listing.aggregateFor(request);
      return underlying.aggregate!(request);
    };
  /* No write and no transaction. The public grant is read-only, and a transaction's `query` and `count` are only
     grant-checked (appAccess.ts), so passing it through would read a byKey table past every refusal above. Left
     off, fail closed: a method a caller needs here is judged and fenced like the others, not inherited. */
  return guarded;
}
