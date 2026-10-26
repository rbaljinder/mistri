/**
 * The reader's zone, where `ui.timezone: { column }` names one:
 * a customer in Chicago reads its windows on Chicago's clock. It is the first
 * row of that column the reader may read, under their own grants and row
 * policy — a tenant's settings row, an account's — and only a zone this
 * runtime knows. Read once per request by whatever builds the request's reader
 * (http/source.ts, tenant/tenantReadRuntime.ts); everything after takes it
 * from there through `appZone` (shared/appUi.ts), so no reader's zone outlives
 * the request it was read for. Nothing readable leaves the App's own zone.
 */
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef, AppUi } from '../../shared/appModel.js';
import { readerZone, zoneColumn } from '../../shared/appUi.js';
import { columnKind, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

export async function readZone(
  ui: AppUi | undefined,
  /** The reader's own catalog: a column it does not serve is not asked for, since a refused read would fail the request. */
  schema: DatabaseSchema,
  query: (request: QueryRequest) => Promise<QueryResult>,
): Promise<string | undefined> {
  const named = zoneColumn(ui);
  if (!named) return undefined;
  const table = tableNamed(schema, named.resource);
  if (!table?.columns.some((column) => column.name === named.column)) return undefined;
  const { rows } = await query({ table: table.id, columns: [named.column], limit: 1, offset: 0 });
  return readerZone(rows[0]?.[named.column]);
}

/** Startup's check of the column against the whole catalog: a declared resource's text column. */
export function zoneColumnProblem(app: AppDef, schema: DatabaseSchema): string | undefined {
  const named = zoneColumn(app.ui);
  if (!named) return undefined;
  const where = `"ui.timezone" reads "${named.resource}.${named.column}"`;
  if (!Object.hasOwn(app.resources ?? {}, named.resource)) return `${where}, and "${named.resource}" is not one of the App's resources.`;
  const column = tableNamed(schema, named.resource)?.columns.find((column) => column.name === named.column);
  if (!column) return `${where}, and "${named.resource}" has no column "${named.column}".`;
  if (columnKind(column.type) !== 'text') return `${where}, which is ${column.type}; a zone is text like "America/Chicago".`;
  return undefined;
}
