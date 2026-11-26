/**
 * Declarative CTE-backed derived resource reads (shared/appDerived.ts): intercepts
 * `query`, `count`, `runView`, `countView`, `runBreakdown`, and `countBreakdown` for any
 * virtual table carrying `table.derived`, composing the declared CTE steps as leading CTEs
 * (`WITH ... "_derived" AS (...) SELECT ... FROM "_derived" ...`) and executing them in ONE
 * parameterized SQL statement via `adapter.cte`.
 *
 * Because every query runs through the reader's own `adapter.cte`, every base table referenced
 * inside the CTE automatically receives the reader's tenant isolation, row policy, column
 * grants, and hidden-column rules.
 */
import type { Adapter, BreakdownResult, CteRequest, QueryRequest, ViewResult } from '@mistriwork/engine/adapters/adapter.js';
import type { BreakdownDef } from '@mistriwork/engine/shared/breakdown.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import type { QueryResult } from '@mistriwork/engine/shared/reads.js';
import { findTable, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { PathError, type ViewCondition, type ViewDef, type ViewFilter } from '@mistriwork/engine/shared/viewPaths.js';

const DERIVED_CTE = '_derived';

function derivedOf(schema: DatabaseSchema, table: string): TableMeta | undefined {
  const found = findTable(schema, table);
  return found?.derived ? found : undefined;
}

function refuse(name: string, path: string, why: string): never {
  throw new PathError(`"${name}" is a derived query: ${why}`, path, path, 0);
}

function checkColumn(table: TableMeta, col: string): string {
  if (col.includes('.') || !table.columns.some((c) => c.name === col)) {
    refuse(table.id, col, `it reads its own columns, and "${col}" is not one of them.`);
  }
  return col;
}

function viewFilterToFilter(table: TableMeta, filter: ViewFilter | undefined): Filter | undefined {
  if (!filter?.groups?.length) return undefined;
  const groups: Condition[][] = filter.groups.map((group) =>
    group.map((cond: ViewCondition): Condition => {
      const column = checkColumn(table, cond.path);
      if (cond.other !== undefined) {
        return { column, op: cond.op as Condition['op'], other: checkColumn(table, cond.other) };
      }
      return {
        column,
        op: cond.op as Condition['op'],
        ...(cond.value !== undefined ? { value: cond.value as Condition['value'] } : {}),
      };
    }),
  );
  return { groups };
}

function wrapDerived(table: TableMeta, outer: CteRequest['query']): CteRequest {
  const base = table.derived!.request;
  return {
    with: [...base.with, { name: DERIVED_CTE, ...base.query }],
    query: outer,
  };
}

/**
 * Wraps `adapter` so reads of any `table.derived` virtual resource execute via `adapter.cte`.
 * When `schema` has no derived tables, returns `adapter` unchanged.
 */
export function derivedReads(adapter: Adapter, schema: DatabaseSchema): Adapter {
  if (!schema.tables.some((table) => table.derived)) return adapter;
  const delegate: Record<string, unknown> = {};
  for (let o: object | null = adapter; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'constructor' || key in delegate) continue;
      const value = (adapter as unknown as Record<string, unknown>)[key];
      delegate[key] = typeof value === 'function' ? value.bind(adapter) : value;
    }
  }
  const base = delegate as unknown as Adapter;

  const requireCte = (name: string) => {
    if (typeof base.cte !== 'function') {
      refuse(name, name, 'its database adapter does not support SQL CTE queries.');
    }
    return base.cte!;
  };

  const query = async (request: QueryRequest): Promise<QueryResult> => {
    const table = derivedOf(schema, request.table);
    if (!table) return base.query(request);
    const runCte = requireCte(table.id);
    const cols = request.columns?.length ? request.columns.map((c) => checkColumn(table, c)) : table.columns.map((c) => c.name);
    const orderBy = request.orderBy?.map((o) => ({ column: checkColumn(table, o.column), direction: o.direction }));
    const started = performance.now();
    const res = await runCte(
      wrapDerived(table, {
        from: DERIVED_CTE,
        select: cols.map((c) => ({ column: c, alias: c })),
        ...(request.filter?.groups.length ? { filter: request.filter } : {}),
        ...(orderBy?.length ? { orderBy } : {}),
        limit: request.limit,
        offset: request.offset,
      }),
    );
    return {
      columns: [...res.columns],
      rows: res.rows,
      ms: Math.round(performance.now() - started),
      sql: { text: `-- ${table.id}: derived CTE query`, params: [] },
    };
  };

  const count = async (name: string, filter?: Filter, limit?: number): Promise<number> => {
    const table = derivedOf(schema, name);
    if (!table) return base.count(name, filter, limit);
    const runCte = requireCte(table.id);
    const res = await runCte(
      wrapDerived(table, {
        from: DERIVED_CTE,
        ...(filter?.groups.length ? { filter } : {}),
        measures: [{ name: 'n', fn: 'count' }],
        limit: 1,
      }),
    );
    const total = Number(res.rows[0]?.n ?? 0);
    return limit === undefined ? total : Math.min(total, limit);
  };

  const runView = async (view: ViewDef, offset = 0): Promise<ViewResult> => {
    const table = derivedOf(schema, view.base);
    if (!table) return base.runView!(view, offset);
    const runCte = requireCte(table.id);
    if (view.aggregates?.length) {
      refuse(table.id, view.aggregates[0]!.alias ?? 'aggregate', 'it reads its own columns, not summaries.');
    }
    const cols = view.columns.map((c) => ({
      path: checkColumn(table, c.path),
      alias: c.alias ?? c.path,
    }));
    const orderBy = (view.orderBy ?? []).map((o) => {
      if (o.alias || o.near !== undefined) refuse(table.id, o.path, 'it is ordered by its own columns.');
      return { column: checkColumn(table, o.path), direction: o.direction };
    });
    const filter = viewFilterToFilter(table, view.filter);
    const limit = view.limit ?? 100;
    const started = performance.now();
    const res = await runCte(
      wrapDerived(table, {
        from: DERIVED_CTE,
        select: cols.map((c) => ({ column: c.path, alias: c.alias })),
        ...(filter ? { filter } : {}),
        ...(orderBy.length ? { orderBy } : {}),
        limit,
        offset,
      }),
    );
    const colMeta = new Map(table.columns.map((c) => [c.name, c]));
    return {
      columns: cols.map((c) => c.alias),
      resolved: cols.map((c) => {
        const meta = colMeta.get(c.path);
        return {
          path: c.path,
          name: c.alias,
          table: table.id,
          column: meta?.name ?? c.path,
          hops: 0,
          type: meta?.type ?? 'TEXT',
          nullable: meta?.nullable ?? true,
          primaryKey: meta?.primaryKey ?? false,
        };
      }),
      joins: [],
      rows: res.rows,
      ms: Math.round(performance.now() - started),
      sql: { text: `-- ${table.id}: derived CTE view`, params: [] },
    };
  };

  const countView = async (view: ViewDef, limit?: number): Promise<number> => {
    const table = derivedOf(schema, view.base);
    if (!table) return base.countView!(view, limit);
    const filter = viewFilterToFilter(table, view.filter);
    return count(table.id, filter, limit);
  };

  const runBreakdown = async (def: BreakdownDef, offset = 0): Promise<BreakdownResult> => {
    const table = derivedOf(schema, def.base);
    if (!table) return base.runBreakdown!(def, offset);
    const runCte = requireCte(table.id);
    const filter = viewFilterToFilter(table, def.filter);
    const by = (def.by ?? []).map((k) => ({
      column: checkColumn(table, k.path),
      name: k.alias ?? k.path,
      ...(k.bucket ? { bucket: k.bucket } : {}),
    }));
    const measures = def.measures.map((m, i) => {
      if (m.fn !== 'count' && m.fn !== 'sum' && m.fn !== 'avg' && m.fn !== 'min' && m.fn !== 'max') {
        refuse(table.id, m.path ?? m.fn, `measure "${m.fn}" is not supported on a derived query.`);
      }
      return {
        name: m.alias ?? (m.path ? `${m.fn}_${m.path}` : `${m.fn}_${i}`),
        fn: m.fn,
        ...(m.path ? { column: checkColumn(table, m.path) } : {}),
      };
    });
    const orderBy = (def.orderBy ?? []).map((o) => ({
      column: o.name,
      direction: o.direction,
    }));
    const started = performance.now();
    const res = await runCte(
      wrapDerived(table, {
        from: DERIVED_CTE,
        ...(filter ? { filter } : {}),
        ...(by.length ? { by } : {}),
        measures,
        ...(orderBy.length ? { orderBy } : {}),
        limit: def.limit ?? 100,
        offset,
      }),
    );
    const colMeta = new Map(table.columns.map((c) => [c.name, c]));
    return {
      columns: [...res.columns],
      resolved: [
        ...by.map((k) => ({
          name: k.name,
          kind: 'key' as const,
          path: k.column,
          type: k.bucket ? (k.bucket === 'weekday' ? 'INTEGER' : 'TEXT') : (colMeta.get(k.column)?.type ?? 'TEXT'),
          ...(k.bucket ? { bucket: k.bucket } : {}),
        })),
        ...measures.map((m) => ({
          name: m.name,
          kind: 'measure' as const,
          fn: m.fn,
          ...(m.column ? { path: m.column } : {}),
          type: m.fn === 'count' ? 'INTEGER' : ((m.column ? colMeta.get(m.column)?.type : undefined) ?? 'NUMERIC'),
        })),
      ],
      rows: res.rows,
      ms: Math.round(performance.now() - started),
      sql: { text: `-- ${table.id}: derived CTE breakdown`, params: [] },
    };
  };

  const countBreakdown = async (def: BreakdownDef, limit?: number): Promise<number> => {
    const table = derivedOf(schema, def.base);
    if (!table) return base.countBreakdown!(def, limit);
    const res = await runBreakdown({ ...def, limit: limit ?? 1000 }, 0);
    return res.rows.length;
  };

  return {
    ...base,
    query,
    count,
    ...(base.runView ? { runView } : {}),
    ...(base.countView ? { countView } : {}),
    ...(base.runBreakdown ? { runBreakdown } : {}),
    ...(base.countBreakdown ? { countBreakdown } : {}),
  };
}
