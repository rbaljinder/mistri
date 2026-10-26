/*
 * How a catalog table is written into SQL: schema-qualified and quoted in the
 * dialect's style. Kept apart from rowScope.ts, which decides which relation
 * a scoped read uses.
 */
import type { SqlStyle } from './filter.js';
import { findTable, type DatabaseSchema } from './schema.js';

/** Physical relation rendering, kept separate from scoped relation lookup. */
export function qualifiedTable(schema: DatabaseSchema, tableId: string, style: SqlStyle): string {
  const table = findTable(schema, tableId);
  if (!table) return style.quote(tableId);
  return table.schema ? `${style.quote(table.schema)}.${style.quote(table.name)}` : style.quote(table.name);
}
