import {
  buildWhere,
  clampLimit,
  orderClause,
  clampOffset,
  countStatement,
  lanesStatement,
  withoutLaneRow,
  Refusal,
  type Filter,
  type QueryRequest,
  type QueryResult,
  type ScopedReads,
  type SqlFragment,
  type SqlStyle,
} from '../adapter.js';
import { findTable, type DatabaseSchema, type TableMeta } from '../../shared/schema.js';
import { COUNT_EACH_MAX, countEachRows } from '../../shared/reads.js';
import { isCapturedScopeCatalog } from '../../shared/scopeCatalog.js';
import { ScopedRelations, snapshotRowScope, type RowScope } from '../../shared/rowScope.js';
import { compileView, compileViewCount } from '../../shared/view.js';
import { compileBreakdown, compileBreakdownCount } from '../../shared/breakdown.js';
import { compileAggregate } from '../../shared/aggregate.js';
import { readExactly, summed } from '../../shared/decimals.js';
import { RequestFault } from '../../shared/refusal.js';
import { storedTextOf, storedTextSelect } from './storedText.js';

/** Structured read arguments must not retain mutable values across driver
 * waits. This is deliberately separate from stricter nonempty policy filters:
 * an empty user filter is fine, because it never replaces the bound policy. */
export function snapshotScopedData<T>(input: T): T {
  let nodes = 0;
  let characters = 0;
  let bytes = 0;
  const fail = (): never => {
    throw new Refusal('Invalid structured operation.');
  };
  const copy = (value: unknown, depth = 0): unknown => {
    if (++nodes > 32_768 || depth > 16) return fail();
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > 1_048_576) return fail();
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // A file's bytes: copied, and bounded as the characters are (the largest upload an App may accept).
    if (value instanceof Uint8Array && (Object.getPrototypeOf(value) === Uint8Array.prototype || Buffer.isBuffer(value))) {
      bytes += value.byteLength;
      if (bytes > 26_214_400) return fail();
      return Buffer.from(value);
    }
    if (typeof value !== 'object') return fail();
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 8193) return fail();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isInteger(length) || length > 8192 || keys.length !== length + 1) return fail();
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) return fail();
      characters += key.length;
      if (characters > 1_048_576) return fail();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  };
  return copy(input) as T;
}

/** Dialect-independent policy binding. The driver only executes compiler output
 * on its existing read handle; consumers never receive that execute function.
 * Snapshot the trusted catalog too, so a later refresh cannot change the
 * graph/columns against which this capability was bound — except a catalog
 * `captureScopeCatalog` already detached and deeply froze, which nothing can
 * change: a tenant source binds a reader per operation over one of those, and
 * copying it each time cost milliseconds per read on a wide catalog.
 */
export function createScopedReads(
  catalog: DatabaseSchema,
  input: RowScope,
  style: SqlStyle,
  /** Execution formatting only: it never changes the compiled statement or scope. */
  execute: (statement: SqlFragment, hint?: { binary?: true }) => Promise<QueryResult>,
  /** A scoped write's own guards: a condition may compare as a foreign key does (`Condition.equality`). Never an App's reads. */
  references = false,
): ScopedReads {
  const schema = isCapturedScopeCatalog(catalog) ? catalog : structuredClone(catalog);
  const scope = snapshotRowScope(schema, input);
  const tableFor = (id: string) => {
    const table = findTable(schema, id);
    if (!table) throw new Refusal('Unknown resource in scoped read.');
    return table;
  };
  /* Each column's type, so a comparison names the database's own operator for it (SqlStyle.builtin). */
  const typeIn = (table: TableMeta) => (name: string) => table.columns.find((column) => column.name === name)?.type;
  const from = (id: string, filter?: Filter) => {
    const table = tableFor(id);
    const column = (name: string): string => {
      if (!table.columns.some((column) => column.name === name)) throw new RequestFault('Unknown column in scoped read.');
      return style.quote(name);
    };
    const relations = new ScopedRelations(schema, style, scope);
    const relation = relations.table(id);
    const prefix = relations.finish();
    const where = buildWhere(filter, style, prefix.params.length + 1, column, undefined, undefined, undefined, references, typeIn(table));
    return { table, column, relation, prefix, where, params: [...prefix.params, ...where.params] };
  };
  /* A SQLite sum that cannot be exact says so in its cell (decimals.ts); PostgreSQL's numeric always is. */
  const exact = <T extends { rows: readonly Record<string, unknown>[] }>(
    run: () => Promise<T>,
    measures: Parameters<typeof summed>[0],
  ): Promise<T> => (style.dialect === 'sqlite' ? readExactly(run, summed(measures)) : run());
  const counted = async (statement: SqlFragment): Promise<number> => {
    const result = await execute(statement);
    return Number(result.rows[0]?.n ?? 0);
  };
  return Object.freeze({
    async query(input: QueryRequest) {
      const request = snapshotScopedData(input);
      const plan = from(request.table, request.filter);
      const names = request.columns?.length ? request.columns : plan.table.columns.map((column) => column.name);
      const columns = names.map(plan.column);
      // A scoped write's own read: its reference columns' stored text too, as one more column (storedText.ts).
      const texts = request.storedText ? storedTextOf(schema, plan.table) : undefined;
      if (texts) columns.push(`${storedTextSelect(texts.columns, (name) => style.quote(name))} AS ${style.quote(texts.alias)}`);
      const order = orderClause(request.orderBy, plan.table, style, plan.params.length + 1, plan.column);
      const n = plan.params.length + order.params.length;
      const lanes = request.lanes;
      const text = lanes
        ? lanesStatement(
            style,
            {
              prefix: plan.prefix.text,
              columns: columns.join(', '),
              source: `${plan.relation}${plan.where.text}`,
              lane: plan.column(lanes.by),
              order: order.text,
            },
            n,
          )
        : `${plan.prefix.text}SELECT ${columns.join(', ')} FROM ${plan.relation}${plan.where.text}${order.text}` +
          ` LIMIT ${style.placeholder(n + 1)} OFFSET ${style.placeholder(n + 2)}`;
      const result = await execute(
        {
          text,
          params: [
            ...plan.params,
            ...order.params,
            ...(lanes ? [clampLimit(lanes.limit)] : []),
            clampLimit(request.limit),
            clampOffset(request.offset),
          ],
        },
        request.binary ? { binary: true } : undefined,
      );
      return { ...(lanes ? withoutLaneRow(result) : result), columns: [...names] };
    },
    async count(table: string, filter?: Filter, limit?: number) {
      const plan = from(table, snapshotScopedData(filter));
      // One plan either way: a bound wraps the scoped relation, never replaces it.
      return counted({ text: `${plan.prefix.text}${countStatement(`${plan.relation}${plan.where.text}`, limit)}`, params: plan.params });
    },
    /* Several tables' counts, each under its own scope and filter, as one
       statement: the scope's CTEs are defined once, ahead of one bounded
       count per item joined by UNION ALL. Each branch reads the relation
       `count` would, so no item sees a row its own count would not. */
    async countEach(items: readonly { table: string; filter?: Filter }[], limit?: number) {
      const given = snapshotScopedData(items);
      if (!given.length || given.length > COUNT_EACH_MAX) throw new Refusal(`One statement counts 1 to ${COUNT_EACH_MAX} things.`);
      const relations = new ScopedRelations(schema, style, scope);
      const planned = given.map((item) => {
        const table = tableFor(item.table);
        const column = (name: string): string => {
          if (!table.columns.some((column) => column.name === name)) throw new RequestFault('Unknown column in scoped read.');
          return style.quote(name);
        };
        return { relation: relations.table(item.table), column, filter: item.filter, types: typeIn(table) };
      });
      const prefix = relations.finish();
      const params = [...prefix.params];
      const branches = planned.map(({ relation, column, filter, types }, i) => {
        const where = buildWhere(filter, style, params.length + 1, column, undefined, undefined, undefined, false, types);
        params.push(...where.params);
        const counted = countStatement(`${relation}${where.text}`, limit);
        return counted.replace(/^SELECT COUNT\(\*\) AS n/, `SELECT ${i} AS i, COUNT(*) AS n`);
      });
      const result = await execute({ text: `${prefix.text}${branches.join('\nUNION ALL\n')}`, params });
      return countEachRows(result.rows, given.length);
    },
    async runView(view, offset = 0) {
      const compiled = compileView(schema, snapshotScopedData(view), style, offset, scope);
      const result = await execute(compiled);
      return { ...result, columns: compiled.columns.map((column) => column.name), resolved: compiled.columns, joins: compiled.joins };
    },
    async countView(view, limit) {
      return counted(compileViewCount(schema, snapshotScopedData(view), style, scope, limit));
    },
    async runBreakdown(breakdown, offset = 0) {
      const compiled = compileBreakdown(schema, snapshotScopedData(breakdown), style, offset, scope);
      const result = await exact(() => execute(compiled), breakdown.measures);
      return { ...result, columns: compiled.columns.map((column) => column.name), resolved: compiled.columns };
    },
    async countBreakdown(breakdown, limit) {
      return counted(compileBreakdownCount(schema, snapshotScopedData(breakdown), style, scope, limit));
    },
    /* The base table read through the scope's relation, as `count` reads it, and nothing else: an aggregate names
       only its table's own columns (aggregate.ts), so no other table's relation is planned at all. */
    async aggregate(request) {
      const compiled = compileAggregate(schema, snapshotScopedData(request), style, 0, scope);
      return { rows: (await exact(() => execute(compiled), request.measures)).rows };
    },
  } satisfies ScopedReads);
}
