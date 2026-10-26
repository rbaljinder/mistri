/**
 * An App list's presentation, drawn in place of the grid: a calendar, a tree,
 * a gantt chart, the author's own list, a split's queue, a checklist, a queue,
 * a board or cards. The App shell hands it to its lists (appnav.js `appShell`,
 * read as `shell().present` by AppList and Dashboard), and TableView draws
 * what it answers; the Workbench's tables pass none and are always the grid.
 *
 * A presentation stands in for the grid only when it can be drawn from the
 * answer: the columns it reads came back (or, for the ones that ask their own
 * question, the table has them). Otherwise this answers null and the list
 * keeps its grid.
 */
import type { ReactNode } from 'react';
import { primaryKey } from '@mistriwork/engine/shared/schema.js';
import type { AppSplitListDetail } from '@mistriwork/engine/shared/listPresentations.js';
import { explicitLimit } from '@mistriwork/kit/client/clauses.js';
import { Checklist, canShowChecklist } from './Checklist.js';
import { QueueList, canShowQueue } from './QueueList.js';
import { canShowBoard, canShowCalendar, canShowGantt, canShowTree } from '@mistriwork/kit/client/components/presentationFit.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { canShowCards } from '@mistriwork/kit/client/components/cardsModel.js';
import { useBulkSelection } from '@mistriwork/kit/client/components/useBulkSelection.js';
import type { PresentArgs, PresentedList } from '@mistriwork/kit/client/components/TableView.js';

/* A board (its drag and its lanes) and a calendar are chunks of their own,
   loaded when a list is first drawn as one. */
const BoardList = onDemand(() => import('./BoardList.js'), 'BoardList');
const CardsList = onDemand(() => import('@mistriwork/kit/client/components/CardsList.js'), 'CardsList');
const CalendarList = onDemand(() => import('./CalendarList.js'), 'CalendarList');
const TreeList = onDemand(() => import('./TreeList.js'), 'TreeList');
const GanttList = onDemand(() => import('./GanttList.js'), 'GanttList');
/* An App's own list presentation, and the page's side of @mistriwork/mistri/ui with it: fetched the first time a list holds one. */
const CustomList = onDemand(() => import('./sdk/CustomList.js'), 'CustomList');

/** A split's chosen rows are a queue's, drawn as the pane's list. */
const splitRowQueue = ({ avatar: _avatar, ...row }: NonNullable<AppSplitListDetail['row']>) => ({ kind: 'queue' as const, ...row });

export function presentList({
  presentation,
  table,
  data,
  entry,
  actions,
  listLabel,
  referenceLabels,
  interactive,
  recordNavigation,
  list,
  current,
  order,
  at,
}: PresentArgs): PresentedList | null {
  /* A calendar asks for its own month, so it stands in for the grid whatever
     page the list is on, and draws no pager of its own. */
  if (presentation.kind === 'calendar' && canShowCalendar(table, presentation)) {
    return {
      whole: true,
      pages: false,
      element: (
        <CalendarList
          table={table}
          spec={presentation}
          entry={entry}
          referenceLabels={referenceLabels}
          interactive={interactive}
          label={listLabel}
        />
      ),
    };
  }
  /* A tree and a gantt chart, like a calendar, ask their own question — the
     whole list, since a page would cut a branch or a span — and draw no pager. */
  if (presentation.kind === 'tree' && canShowTree(table, presentation)) {
    return {
      whole: true,
      pages: false,
      element: (
        <TreeList
          table={table}
          spec={presentation}
          entry={entry}
          referenceLabels={referenceLabels}
          interactive={interactive}
          label={listLabel}
        />
      ),
    };
  }
  if (presentation.kind === 'gantt' && canShowGantt(table, presentation)) {
    return {
      whole: true,
      pages: false,
      element: (
        <GanttList
          table={table}
          spec={presentation}
          entry={entry}
          referenceLabels={referenceLabels}
          interactive={interactive}
          label={listLabel}
        />
      ),
    };
  }
  /* A custom list draws when the answer carries its keys and every column its component reads, as every presentation does. */
  const element: ReactNode =
    presentation.kind === 'custom' &&
    table &&
    primaryKey(table).length &&
    [...presentation.show, ...primaryKey(table)].every((name) => data.columns?.includes(name)) ? (
      <CustomList
        table={table}
        rows={data.rows}
        spec={presentation}
        actions={actions}
        interactive={interactive}
        label={listLabel}
        list={list}
        total={typeof data.total === 'number' && data.exactTotal !== false ? data.total : undefined}
        page={{ index: explicitLimit(entry.query) ? 0 : at.page, size: at.size }}
        useSelection={useBulkSelection}
      />
    ) : presentation.kind === 'split' && presentation.row && canShowQueue(table, data.columns, splitRowQueue(presentation.row)) ? (
      <QueueList
        table={table}
        rows={data.rows}
        spec={splitRowQueue(presentation.row)}
        referenceLabels={referenceLabels}
        interactive={interactive}
        recordNavigation
        label={listLabel}
        list={list}
        pick={{ current, avatar: presentation.row.avatar }}
      />
    ) : presentation.kind === 'checklist' && canShowChecklist(table, data.columns, presentation) ? (
      <Checklist
        table={table}
        rows={data.rows}
        spec={presentation}
        referenceLabels={referenceLabels}
        interactive={interactive}
        list={list}
        order={order}
      />
    ) : presentation.kind === 'queue' && canShowQueue(table, data.columns, presentation) ? (
      <QueueList
        table={table}
        rows={data.rows}
        spec={presentation}
        referenceLabels={referenceLabels}
        actions={actions}
        interactive={interactive}
        recordNavigation={recordNavigation}
        label={listLabel}
        list={list}
        order={order}
      />
    ) : presentation.kind === 'board' && canShowBoard(table, data.columns, presentation) ? (
      <BoardList
        table={table}
        rows={data.rows}
        spec={presentation}
        referenceLabels={referenceLabels}
        actions={actions}
        interactive={interactive}
        label={listLabel}
        query={explicitLimit(entry.query) ? undefined : entry.query}
      />
    ) : presentation.kind === 'cards' && canShowCards(table, data.columns, presentation) ? (
      <CardsList
        table={table}
        rows={data.rows}
        spec={presentation}
        referenceLabels={referenceLabels}
        interactive={interactive}
        recordNavigation={recordNavigation}
        label={listLabel}
        list={list}
        order={order}
      />
    ) : null;
  /* A board reads its lanes whole (BoardList), so it has no page to turn. */
  return element ? { whole: false, element, pages: presentation.kind !== 'board' } : null;
}
