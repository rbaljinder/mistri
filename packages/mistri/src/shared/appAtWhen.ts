/**
 * A resource timer's `when` (appAt.ts) as the sweep runs it: the query
 * language over the record's own stored columns, read into a filter a
 * statement binds. A sweep reads due rows across every tenant in one
 * statement of its own, so a `when` names no reference path, rollup or
 * computed column, and no column on its right-hand side: each would be a
 * join or an identifier the sweep's statement does not have. The check
 * (`mistri check`) reads it the same way, so what starts is what runs.
 */
import type { Filter } from '@mistriwork/engine/shared/filter.js';
import { parseQuery, saidAt } from '@mistriwork/engine/shared/query.js';
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';

export function atWhenFilter(
  schema: DatabaseSchema,
  table: TableMeta,
  when: string,
  now?: Date,
): { filter: Filter; problem?: undefined } | { filter?: undefined; problem: string } {
  const text = `${table.id} ${when}`;
  const parsed = parseQuery(text, { schema, ...(now ? { now } : {}), columnValues: false });
  if (parsed.errors.length || !parsed.query) return { problem: saidAt(parsed.errors[0] ?? { message: 'It does not parse.' }, when) };
  const query = parsed.query;
  if (query.columns.length || query.orderBy.length || query.limit !== undefined)
    return { problem: `"${when}" says more than conditions: a timer's when is a condition alone, with no show, sort or limit.` };
  const stored = new Set(table.columns.map((column) => column.name));
  for (const condition of query.filter.groups.flat()) {
    if (condition.other !== undefined || !stored.has(condition.column))
      return { problem: `"${when}" reads "${condition.column}"; a timer's when reads the record's own stored columns.` };
  }
  return { filter: query.filter };
}
