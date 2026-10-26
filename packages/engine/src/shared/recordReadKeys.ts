/**
 * How a composed record page's answers are matched to the requests they
 * answer (shared/recordReads.ts, client/composedReads.ts): one text per
 * request, and the record's own row answered a part at a time. Imports
 * nothing, so the client's request path carries no more than this.
 */

/** A value as one text, its object keys in order: two requests built alike are one request. */
export function canonicalText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** A read of the record's own row, as `rowBody` builds it: its base, its filter and its columns; otherwise undefined. */
export function rowRead(body: Record<string, unknown>): { base: string; filter: string; columns: string[] } | undefined {
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'count,view' || body.count !== 'none') return undefined;
  const view = body.view as
    | { id?: unknown; name?: unknown; base?: unknown; columns?: unknown; filter?: unknown; limit?: unknown }
    | undefined;
  if (
    !view ||
    typeof view !== 'object' ||
    typeof view.id !== 'string' ||
    !view.id.startsWith('page:') ||
    typeof view.base !== 'string' ||
    view.limit !== 1 ||
    !Array.isArray(view.columns) ||
    Object.keys(view).sort().join(',') !== 'base,columns,filter,id,limit,name'
  )
    return undefined;
  const columns: string[] = [];
  for (const column of view.columns as unknown[]) {
    if (
      !column ||
      typeof column !== 'object' ||
      Object.keys(column).join(',') !== 'path' ||
      typeof (column as { path: unknown }).path !== 'string'
    )
      return undefined;
    columns.push((column as { path: string }).path);
  }
  return { base: view.base, filter: canonicalText(view.filter), columns };
}

interface RowReply {
  view: { columns: Array<{ path: string }> } & Record<string, unknown>;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  resolved?: Array<{ path: string; name?: string }>;
}

/** Exactly what a read of some of the row's columns would have been answered alone: its columns, their descriptions, its values. */
export function rowPart<T extends RowReply>(reply: T, columns: readonly string[]): T {
  const asked = new Set(columns);
  const resolved = reply.resolved?.filter((column) => asked.has(column.path));
  const named = new Set(columns.map((path) => reply.resolved?.find((column) => column.path === path)?.name ?? path));
  return {
    ...reply,
    view: { ...reply.view, columns: reply.view.columns.filter((column) => asked.has(column.path)) },
    columns: reply.columns.filter((name) => named.has(name)),
    rows: reply.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => named.has(name)))),
    ...(resolved ? { resolved } : {}),
  };
}
