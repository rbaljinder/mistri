/**
 * A view's answer as a component reads it: each row keyed by the paths it
 * asked for, in the words it wrote them (`customer_id.name`), whatever name
 * the server's result gave the column. Shared by the declared reads of a
 * custom section and the SDK's hooks, so both hand a component one shape.
 */
import type { UiRow } from './context.js';
import { resolvePath } from '@mistriwork/engine/shared/viewPaths.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

/** Where a read's paths start, so a column's declared type can be found for each. */
interface RowsBase {
  schema: DatabaseSchema | null | undefined;
  base: string;
}

interface ViewAnswer {
  view?: unknown;
  columns?: string[];
  rows?: UiRow[];
  errors?: Array<{ message: string }>;
}

/* The server hands a Postgres timestamp as the text the database stores
   (postgresDates.ts, on purpose: the grid shows what is stored), so
   `2026-10-12 19:16:00-04` reaches a component, and `Date.parse` reads that,
   and the `+00` of UTC, as NaN. A component computes with its times, so it is
   handed ISO 8601 with a full offset. Only the strict shape of a database's
   timestamp text is touched, and only in a column declared a timestamp: a
   string that merely looks like one is the author's. A timestamp without a
   zone stays without one; an offset is never invented. */
const TIMESTAMP_TEXT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function isoTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = TIMESTAMP_TEXT.exec(value.trim());
  if (!match) return value;
  const [, day, time, zone] = match;
  let offset = '';
  if (zone === 'Z') offset = 'Z';
  else if (zone) {
    const digits = zone.slice(1).replace(':', '');
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`;
  }
  return `${day}T${time.length === 5 ? `${time}:00` : time}${offset}`;
}

const isTimestampColumn = (type: string) => /timestamp|datetime/i.test(type ?? '');

function timestampPaths(paths: readonly string[], typed: RowsBase | undefined): Set<string> {
  const found = new Set<string>();
  if (!typed?.schema) return found;
  for (const path of paths) {
    try {
      const resolved = resolvePath(typed.schema, typed.base, path);
      if (!resolved.rollup && !resolved.computed && !resolved.tags && !resolved.jsonKey && isTimestampColumn(resolved.column.type))
        found.add(path);
    } catch {
      /* A path the schema cannot resolve is the server's to refuse; it is read as it came. */
    }
  }
  return found;
}

export function rowsByPath(paths: readonly string[], got: ViewAnswer, fallback: string, typed?: RowsBase): UiRow[] {
  if (!got || !('view' in got) || !Array.isArray(got.rows)) throw new Error(got?.errors?.[0]?.message ?? fallback);
  const columns = got.columns ?? [...paths];
  /* Each value by its path's own column, not by where the path stands in the
     asking list: a record page reads its row once for every section, in the
     order the first one named the columns, and hands each section its own
     columns of that one answer (composedReads.ts). Zipped by position, a
     section that named shared columns in another order read one column's
     value under another's name. The answer's view says which path each of its
     columns is. */
  const answered = (got.view as { columns?: Array<{ path?: unknown }> } | null | undefined)?.columns;
  const nameOf = new Map<string, string>();
  if (Array.isArray(answered))
    answered.forEach((column, i) => {
      if (typeof column?.path === 'string' && columns[i] !== undefined && !nameOf.has(column.path)) nameOf.set(column.path, columns[i]);
    });
  const stamps = timestampPaths(paths, typed);
  return got.rows.map((row) =>
    Object.fromEntries(
      paths.map((path, i) => {
        const value = row[nameOf.get(path) ?? columns[i] ?? path];
        return [path, stamps.has(path) ? isoTimestamp(value) : value];
      }),
    ),
  );
}
