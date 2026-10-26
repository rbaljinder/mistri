import { TAGS_COLUMN, tagsColumnMeta } from '@mistriwork/engine/shared/tagLists.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { resolvePath } from '@mistriwork/engine/shared/view.js';
import { rollupColumnMeta } from '@mistriwork/engine/shared/rollups.js';
import { computedColumnMeta } from '@mistriwork/engine/shared/computed.js';

type PresentationColumn = ColumnMeta & { sourceName?: string; identifier?: boolean };

/** Dotted projections retain their source type without becoming the base row's key. */
export function presentationColumns(
  schema: DatabaseSchema | undefined,
  table: TableMeta | undefined,
  paths: readonly string[],
): Map<string, PresentationColumn> {
  const columns = new Map<string, PresentationColumn>((table?.columns ?? []).map((column) => [column.name, column]));
  if (!schema || !table) return columns;
  for (const path of paths) {
    /* A rollup of the table itself (rollups.ts) is named without a dot, and
       read-only like every summary: its type is how it dresses. */
    const rollup = !path.includes('.') && table.rollups && Object.hasOwn(table.rollups, path) ? table.rollups[path] : undefined;
    if (rollup && !columns.has(path)) {
      columns.set(path, { ...rollupColumnMeta(path, rollup), identifier: false });
      continue;
    }
    // A computed column of the table, likewise (computed.ts).
    const computed = !path.includes('.') && table.computed && Object.hasOwn(table.computed, path) ? table.computed[path] : undefined;
    if (computed && !columns.has(path)) {
      columns.set(path, { ...computedColumnMeta(path, computed), identifier: false });
      continue;
    }
    // A record's tags (tagLists.ts): chips in a cell, a checklist in a facet.
    if (path === TAGS_COLUMN && table.tags && !columns.has(path)) {
      columns.set(path, { ...tagsColumnMeta(), identifier: false });
      continue;
    }
    if (columns.has(path) || !path.includes('.')) continue;
    try {
      const resolved = resolvePath(schema, table.id, path);
      columns.set(path, {
        ...resolved.column,
        name: path,
        sourceName: resolved.column.name,
        identifier: Boolean(resolved.column.primaryKey || resolved.column.references),
        primaryKey: false,
        nullable: true,
      });
    } catch {
      // An arbitrary result alias is not necessarily a schema path.
    }
  }
  return columns;
}
