/**
 * The list nobody arranged (resolveViews in app.ts): what each part a list view leaves out is inferred as, from the
 * catalog and the resource (engine shared/listInference.ts).
 */
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import {
  inferBoard,
  inferListColumns,
  inferListFilters,
  inferListSort,
  inferListSubtitles,
  inferListTabs,
  stateColumn,
  type InferenceResource,
} from '@mistriwork/engine/shared/listInference.js';
import type { AppListView, InferredListPart } from './appModel.js';

/**
 * A grid list's columns, order, tabs and filters where its view declares none, each on its own
 * (shared/listInference.ts), and the board it may be switched to: read from the catalog and the resource, never a
 * row, and never over anything the view says. A list drawn by a presentation draws its own, and is left as written.
 */
export function inferredList(view: AppListView, schema: DatabaseSchema, table: TableMeta, resource: InferenceResource): AppListView {
  /* A list that names its columns has been arranged: its order, tabs and filters were left to the platform's
     defaults on purpose, as every sample App leaves them, and stay so. The list nobody arranged gets each part
     its view leaves out. */
  if (view.presentation || view.show !== undefined) return view;
  const parts: InferredListPart[] = [];
  let next: AppListView = view;
  {
    const show = inferListColumns(schema, table, resource);
    if (show.length) {
      const under = inferListSubtitles(schema, table, resource);
      next = { ...next, show, ...(Object.keys(under).length ? { subtitles: under } : {}) };
      parts.push('show');
    }
  }
  /* A standing query that already names the state is the list's own reading of it: its tabs and order are left. */
  const state = stateColumn(table, resource);
  const pinned = Boolean(state && view.query && new RegExp(`(^|[^\\w.])${state}([^\\w]|$)`).test(view.query));
  if (view.sort === undefined && view.sorts === undefined && view.order === undefined && view.group === undefined && !pinned) {
    const sort = inferListSort(schema, table, resource);
    if (sort) {
      next = { ...next, sort };
      parts.push('sort');
    }
  }
  if (view.tabs === undefined && !pinned) {
    const tabs = inferListTabs(schema, table, resource);
    if (tabs) {
      next = { ...next, tabs };
      parts.push('tabs');
    }
  }
  if (view.filters === undefined && view.filterBar !== 'none') {
    const filters = inferListFilters(schema, table, resource, next.tabs !== undefined && parts.includes('tabs'));
    if (filters.length) {
      next = { ...next, filters };
      parts.push('filters');
    }
  }
  const board = pinned ? undefined : inferBoard(schema, table, resource);
  if (board) next = { ...next, asBoard: board };
  return parts.length ? { ...next, inferred: parts } : next;
}
