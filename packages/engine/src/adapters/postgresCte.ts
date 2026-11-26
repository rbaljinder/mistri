/**
 * PostgreSQL execution helpers for command aggregates and scoped SQL CTE queries (`WITH ... AS (...)`).
 * Kept beside `postgres.ts` so the main adapter stays within the module size cap.
 */
import type { DatabaseSchema } from '../shared/schema.js';
import { compileAggregate, type AggregateRequest, type AggregateResult } from '../shared/aggregate.js';
import { compileCte, cteTables, type CteRequest, type CteResult } from '../shared/cte.js';
import { POSTGRES_STYLE } from './adapter.js';

interface PgQueryLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface PgCteHost {
  assertTable(table: string, db: PgQueryLike): Promise<{ schema: string; name: string }>;
  getSchema(): Promise<DatabaseSchema>;
  toJsonSafe(row: Record<string, unknown>): Record<string, unknown>;
}

export async function runPostgresAggregate(request: AggregateRequest, db: PgQueryLike, host: PgCteHost): Promise<AggregateResult> {
  const { schema: namespace, name } = await host.assertTable(request.table, db);
  const catalog = await host.getSchema();
  const compiled = compileAggregate(catalog, { ...request, table: `${namespace}.${name}` }, POSTGRES_STYLE);
  const result = await db.query(compiled.text, compiled.params);
  return { rows: result.rows.map(host.toJsonSafe) };
}

export async function runPostgresCte(request: CteRequest, db: PgQueryLike, host: PgCteHost): Promise<CteResult> {
  const renamed = new Map<string, string>();
  for (const table of cteTables(request)) {
    const resolved = await host.assertTable(table, db);
    renamed.set(table, `${resolved.schema}.${resolved.name}`);
  }
  const mapTarget = (target: string, known: ReadonlySet<string>) => (known.has(target) ? target : (renamed.get(target) ?? target));
  const known = new Set<string>();
  const mappedWith = request.with.map((step) => {
    const mapped = {
      ...step,
      from: mapTarget(step.from, known),
      ...(step.joins ? { joins: step.joins.map((j) => ({ ...j, target: mapTarget(j.target, known) })) } : {}),
    };
    known.add(step.name);
    return mapped;
  });
  const mappedQuery = {
    ...request.query,
    from: mapTarget(request.query.from, known),
    ...(request.query.joins ? { joins: request.query.joins.map((j) => ({ ...j, target: mapTarget(j.target, known) })) } : {}),
  };
  const catalog = await host.getSchema();
  const compiled = compileCte(catalog, { with: mappedWith, query: mappedQuery }, POSTGRES_STYLE);
  const result = await db.query(compiled.text, compiled.params);
  return { columns: compiled.columns, rows: result.rows.map(host.toJsonSafe) };
}
