/**
 * A dashboard's list that works as its room does (`embed(view, { interactive:
 * true })`): the view's own search and filters over the rows the section
 * shows, and, for a reader offered one, its selection with the bulk actions
 * its room offers — the same list component the room draws, so nothing here
 * is a second list. What the reader may do is the room's: the actions ride
 * the App as it was served to this reader, and every write is authorized on
 * the server as it is from the room.
 *
 * The section's question — the view's, its tab, the dashboard's window and
 * picks — is the list's standing condition here, never a chip to remove; the
 * reader's search and filters narrow within it, and the question is the
 * section's own state, so it moves nothing else on the dashboard and no
 * address. Loaded the first time a dashboard holds one (onDemand.tsx).
 */
import { useEffect, useMemo, useState } from 'react';
import { AppList } from './AppList.js';
import { appListQuery, type ListSpec } from './appListModel.js';
import type { Section } from './dashboardModel.js';
import { splitClauseTail } from '@mistriwork/engine/shared/query.js';
import './DashboardList.css';

export function InteractiveList({
  section,
  source,
  onTotal,
}: {
  section: Section;
  /** The view's room, as the App was served to this reader. */
  source: ListSpec;
  onTotal: (total: number | undefined) => void;
}) {
  const spec = useMemo<ListSpec>(() => {
    /* The section's conditions stand; its order (a tab's `sort ship_by`) is the list's default order, never a chip. */
    const { head, tail } = splitClauseTail(section.query ?? '');
    const order = /^(?:sort|order\s+by)\s+(.+)$/i.exec(tail)?.[1]?.trim();
    return {
      ...source,
      query: head || undefined,
      /* The section drew one tab; a split's list is its plain grid, as the room's list half is. */
      tabs: undefined,
      presentation: source.presentation?.kind === 'split' ? undefined : source.presentation,
      limit: section.limit ?? 5,
      ...((order ?? section.sort) ? { sort: order ?? section.sort } : {}),
      filterBar: source.filterBar === 'rail' ? 'bar' : source.filterBar,
    };
  }, [source, section.query, section.limit, section.sort]);
  const first = appListQuery(spec);
  const [query, setQuery] = useState(first);
  /* A new window or pick is a new question: the reader's narrowing starts over within it. */
  useEffect(() => setQuery(first), [first]);
  /* The rows are the list's own read, which a write through its actions refreshes as the room's does;
     the dashboard's refresh clock does not re-draw a list a reader may be selecting in. */
  const entry = useMemo(() => ({ table: spec.table, query, view: source.id }), [spec.table, query, source.id]);
  return <AppList entry={entry} spec={spec} navigate={setQuery} inDashboard onTotal={onTotal} />;
}
