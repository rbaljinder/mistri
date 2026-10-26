/**
 * The table view around the grid: the result's head, the grid, the pager —
 * and, in the workbench, the tab strip above them.
 *
 * The fetch is not here: TableRoom asks, keyed by the question, and hands
 * the answer in. A page, a page size or a header's sort re-asks in place
 * (core.js `refine`), so this stays mounted while the previous answer stays
 * on screen; `at` says which page that answer is, and `busy` that the next
 * is on its way. What this draws is the answer.
 */
import { PresentationSwitch } from './PresentationSwitch.js';
import { createPortal } from 'react-dom';
import { useCrumbSlots } from './crumbSlot.js';
import {
  PAGE_SIZES,
  beginNavigation,
  currentEntry,
  findTable,
  go,
  keyOf,
  pageSize,
  pageView,
  prefersPages,
  refine,
  render,
  setPageSize,
  state,
} from '../core.js';
import { explicitLimit, sortCount, sortDirection } from '../clauses.js';
import { NewRowButton } from './NewRecordButton.js';
import { copyListView } from '../filterbar.js';
import { pagesFor } from '../page.js';
import { sortBy } from '../thmenu.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Dropdown } from './Dropdown.js';
import { stepList, takePageStep } from './pageStep.js';
import { formatApprox, formatNumber } from '../locale.js';
import { ExportControl } from './ExportHold.js';
import { Grid, type GridData } from './Grid.js';
import { trailListFor } from '../recordTrail.js';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { BesideDetail } from './besideDetail.js';
import { editableCells, type CellDraw } from './gridCellModel.js';
import { canEditRow } from '../rowEditing.js';
import { RecordSummaries, tableSaysMore } from './RecordSummaries.js';
import { canUseDatabaseTools } from '../connectionScope.js';
import { shell } from '../shellMode.js';
import { onDemand, useArrived } from './onDemand.js';
import { RowHosts, RowTrailHosts } from './RowHost.js';
import { RowActions } from './RowActions.js';
import { GridSelection } from './GridSelection.js';
import { offeredBulk } from './useBulkSelection.js';
import { GridOrder, type ListOrder } from './useListOrder.js';
import { say } from '../copy/lists/components/TableView.js';
import { Icon } from './Icon.js';

/** A grid draws a selection column only for a reader offered a bulk action — or "Set field…" — on keyed rows. */
function selectableGrid(table: TableMeta, actions: AppAction[], interactive: boolean, editable: readonly string[]): boolean {
  if (!interactive || (!actions.length && !editable.length) || !primaryKey(table).length) return false;
  const offered = offeredBulk(table, actions, interactive, undefined, undefined, editable);
  return offered.bulk.length > 0 || offered.commands.length > 0 || offered.fields.length > 0;
}
import type { AppAction } from '@mistriwork/engine/schema/model.js';
import type { AppListPresentation } from '@mistriwork/engine/shared/listPresentations.js';

/* A cell's editor, fetched the first time a list that edits in place is
   drawn. The list waits for it (TableRoom.tsx, Rows) as it waits for its rows,
   so a click on a cell never opens the row for want of the editor. */
export const GridCellEdit = onDemand(() => import('./GridCellEditor.js'), 'GridCellEdit', { quiet: true });

/** Whether the connection on screen is an API (adapters/http), whose tables get the API tab (ApiOperations.tsx). */
export function isApiConnection(): boolean {
  return (state as { schema?: { dialect?: string } | null }).schema?.dialect === 'http';
}

export interface TableEntry {
  kind: 'table';
  table: string;
  query: string;
  tab?: string;
  exactCount?: boolean;
}

/** What a list's presentation is drawn from (`present`): the list's own props, and the page of rows it holds. */
export interface PresentArgs {
  presentation: AppListPresentation;
  table: TableMeta | undefined;
  data: TableViewProps['data'];
  entry: TableEntry;
  actions: AppAction[] | undefined;
  listLabel: string | undefined;
  referenceLabels: Record<string, string> | undefined;
  interactive: boolean;
  recordNavigation: boolean;
  /** The list these rows are a page of, for a record opened from it to step past the page (recordTrail.ts). */
  list: ReturnType<typeof trailListFor> | undefined;
  /** The record beside this list (a split's detail), marked in it. */
  current: Record<string, unknown> | undefined;
  order: ListOrder | undefined;
  at: PageAt;
}

/**
 * A presentation drawn in the grid's place. `whole`: it asks its own question
 * (a calendar's month, a tree's every branch) and is the list entire;
 * otherwise it draws this page's rows, under the count and over the pager
 * where it `pages`.
 */
export interface PresentedList {
  whole: boolean;
  element: ReactNode;
  pages: boolean;
}

/** Draws a list's presentation, or null where it cannot be drawn from this answer and the grid stands. */
export type Present = (args: PresentArgs) => PresentedList | null;

export interface TableViewProps {
  /** How the view's rows draw instead of the grid: a checklist, a queue or a board. */
  presentation?: AppListPresentation;
  /** What draws `presentation`: the App's (presentedList.tsx), handed down by its lists. The Workbench passes none, and draws the grid. */
  present?: Present;
  /** The entry's fixed actions, for the presentations that offer them. */
  actions?: AppAction[];
  /** The entry's label: what a queue or board is called to assistive technology. */
  listLabel?: string;
  /** The view's hand-order column, where it keeps one: its rows are put in place by an editor (useListOrder.tsx). */
  order?: string;
  /** An otherwise read-only card list may open a record. */
  recordNavigation?: boolean;
  sizing?: import('@mistriwork/engine/shared/tableSizing.js').TableSizing;
  entry: TableEntry;
  data: GridData & { table: string; rows: Array<Record<string, unknown>>; total?: number; ms: number };
  /** The explorer's own view, or an embedded one (an app list, a page's chooser). */
  chrome: boolean;
  interactive: boolean;
  hide?: string[];
  labels?: Record<string, string>;
  /** A reference column → the fetched path its record's name is read from, drawn in its place by the grid, a queue and cards. */
  referenceLabels?: Record<string, string>;
  /** Column → its total over the whole query, for the grid's footer. */
  totals?: Record<string, unknown>;
  density?: 'comfortable' | 'compact';
  /** A ⋯ menu at the end of each row with the record's own actions. */
  rowActions?: boolean;
  /** The view's `editable`: cells edited in place, and the selection's "Set field…" (GridCellEditor.tsx). */
  editable?: true | string[];
  /** The page's own list: Export goes to the crumb bar, the range to the pager. */
  inCrumbs?: boolean;
  export?: boolean;
  summaries?: boolean;
  /**
   * Drawn inside another room — a dashboard's section. It keeps to its width,
   * leaving out the columns past it rather than scrolling to them, and on a
   * phone says its rows as record summaries, with no Records/Table switch:
   * the switch is the list's own, one click away.
   */
  embedded?: boolean;
  /** The page and page size this answer was asked for; the walk's own when not given. */
  at?: PageAt;
  /** The next answer is on its way; this one stays on screen until it lands. */
  busy?: boolean;
}

export interface PageAt {
  page: number;
  size: number;
}

/** Open this table's page: the configured one if there is one, else the suggested. */
async function openPageFor(tableId: string): Promise<void> {
  const isCurrent = beginNavigation();
  let pageId = `suggested:${tableId}`;
  try {
    const [configured] = await pagesFor(tableId);
    if (configured && !configured.error) pageId = configured.id;
  } catch {
    // No config pages to read is not a reason to refuse the suggested one.
  }
  if (isCurrent()) go(pageView(pageId, tableId), 'push');
}

/** The explorer's tabs over a table: rows, definition, diagram — and the doors beside them. */
export function ViewTabs({ entry }: { entry: TableEntry }) {
  return (
    <div className="tabs" data-scrolls="">
      {/* The tabs are a tablist of their own: the doors beside them are not
          tabs, and a tablist may hold only tabs. It lays out as if absent. */}
      <div className="tabs-list" role="tablist" aria-label={say('tableViews')}>
        {/* An API's definition is its description, so its tables trade Definition
          for API: its documented reads, tried from here (ApiOperations.tsx). */}
        {(isApiConnection()
          ? ([
              ['rows', say('rows')],
              ['api', 'API'],
              ['diagram', say('diagram')],
            ] as const)
          : ([
              ['rows', say('rows')],
              ['ddl', say('definition')],
              ['diagram', say('diagram')],
            ] as const)
        )
          .filter(([id]) => (id !== 'ddl' && id !== 'api') || canUseDatabaseTools())
          .map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={(entry.tab ?? 'rows') === id}
              onClick={() => go({ ...entry, tab: id }, 'replace')}
            >
              {label}
            </button>
          ))}
      </div>
      {/* The way into a page from a table: not a tab of this table, but this
          is where someone looks for it. */}
      <button type="button" className="tab tab-page" title={say('aPageAboutOne')} onClick={() => void openPageFor(entry.table)}>
        {say('page')}
      </button>
      {/* The authoring bridge: this list as a paste-ready App list view. */}
      <button type="button" className="tab tab-copy-entry" title={say('copyThisListAsAnApp')} onClick={() => void copyListView(entry)}>
        {say('copyAppEntry')}
      </button>
    </div>
  );
}

function ResultHead({
  entry,
  data,
  chrome,
  interactive,
  exportOn,
  at,
  headRef,
  inCrumbs = false,
}: {
  entry: TableEntry;
  data: TableViewProps['data'];
  chrome: boolean;
  interactive: boolean;
  exportOn: boolean;
  at: PageAt;
  headRef: RefObject<HTMLDivElement | null>;
  inCrumbs?: boolean;
}) {
  const { tools } = useCrumbSlots();
  /* The page's own list says its count in the crumb bar and its range in the
     pager; Export joins New at the bar's end, and no stats row is drawn. */
  if (inCrumbs && tools) {
    return (
      <div className="result-head-anchor" ref={headRef}>
        {exportOn && createPortal(<ExportControl entry={entry} data={data} />, tools)}
      </div>
    );
  }
  /* An App's list without a crumb bar (shell.breadcrumbs: false) still
     names its count in its own title: "2 rows" and "sorted by id ↓" under
     it were the Workbench's instruments, which stay in the Workbench. */
  if (shell().inApp() && !chrome) {
    const own = findTable(data.table) as TableMeta | undefined;
    return (
      <div className="result-head result-head-app" ref={headRef}>
        {!prefersPages() && own && <NewRowButton table={own} />}
        {exportOn && <ExportControl entry={entry} data={data} />}
      </div>
    );
  }
  const first = at.page * at.size + 1;
  const shown = at.page * at.size + data.rows.length;
  const total = data.total;
  /* The range on screen. "60 of 907" on page three read as sixty rows
     shown, and the last page's bare total read as a table that fits. It is
     the answer's own page: while the next one is fetched, these are still
     the rows in front of the reader. */
  const range = at.page > 0 || (total !== undefined && total > shown) ? `${formatNumber(first)}–${formatNumber(shown)}` : null;
  const table = findTable(data.table) as TableMeta | undefined;
  return (
    <div className="result-head" ref={headRef}>
      {chrome && <h1 className="result-title">{data.table}</h1>}
      {total === undefined ? (
        <span className="stat">
          {range && data.rows.length > 0
            ? say('rowsShown', { range })
            : say('countShown', { rows: say('common.rows2', { count: data.rows.length }) })}
        </span>
      ) : data.exactTotal === false ? (
        /* An estimate says so, and offers the real number: above a threshold
           the count comes from the catalog's statistics, and "~2.4M" is
           honest where "2,400,113" would not be. */
        <button
          type="button"
          className="stat stat-estimate"
          title={say('roughlyFromTheDatabases')}
          onClick={() => go({ ...entry, exactCount: true }, 'replace')}
        >
          {range ? say('rowsRangeOfAbout', { range, total: formatApprox(total) }) : say('aboutTotalRows', { total: formatApprox(total) })}
        </button>
      ) : data.cappedTotal ? (
        /* A filtered total is counted to a bound (10,000 by default), which
           is what keeps a filter over a large table from spending most of
           its time counting. Past it the head says "10,000+" and offers the
           exact number, one click and one full count away. */
        <button
          type="button"
          className="stat stat-estimate"
          title={say('countingStoppedHereClick')}
          onClick={() => go({ ...entry, exactCount: true }, 'replace')}
        >
          {range ? say('rowsRangeOfAtLeast', { range, total: formatNumber(total) }) : say('totalRows', { total: formatNumber(total) })}
        </button>
      ) : (
        <span className="stat">
          {range ? say('rowsRangeOfTotal', { range, total: formatNumber(total) }) : say('common.rows2', { count: total })}
        </span>
      )}
      {/* The query's time is the Workbench's instrument; in an App's list it
          was a number beside the count nobody there asked for. */}
      {!shell().inApp() && <span className="stat">{say('ms', { ms: data.ms })}</span>}
      {/* The default order, named, because the column it sorted by may not
          be on screen. Clicking writes it into the query. */}
      {interactive && data.order?.implicit && data.order.order.length > 0 && (
        <button
          type="button"
          className="stat stat-order"
          title={say('rowsHaveToCome')}
          onClick={() => sortBy(data.order!.order[0].column, data.order!.order[0].direction)}
        >
          {say('sortedBy', { column: data.order.order[0].column })}
          {data.order.order[0].direction === 'desc' ? ' ↓' : ' ↑'}
        </button>
      )}
      {/* Not where the app's list head already offers "New". */}
      {!prefersPages() && table && <NewRowButton table={table} />}
      {exportOn && <ExportControl entry={entry} data={data} />}
    </div>
  );
}

/**
 * Paging, for a table somebody might actually reach the end of. The size
 * control sits on the left whether or not there is a second page; "Last"
 * and the page box appear only when the total is a real count.
 *
 * The controls say where the reader asked to be (`state.page`), at once;
 * the rows follow when they land. Every move is a refinement (core.js
 * `refine`): the room is re-asked in place rather than started over.
 */
function Pager({ entry, data, at, range = false }: { entry: TableEntry; data: TableViewProps['data']; at: PageAt; range?: boolean }) {
  if (data.total === 0 && state.page === 0) return null;
  const app = shell().inApp();
  // A query that names its own limit defines the whole result.
  if (explicitLimit(entry.query)) return app ? null : <div className="pager" />;
  const size = pageSize();
  const shown = state.page * size + data.rows.length;
  /* An estimated total cannot decide whether there is a next page; a full
     page returned is the honest signal. */
  const full = data.rows.length >= size;
  const total = data.total;
  // A bounded total says "at least", which cannot name the last page either.
  const counted = data.exactTotal !== false && !data.cappedTotal && typeof total === 'number';
  const more = counted ? total > shown : full;
  const lastPage = counted ? Math.max(0, Math.ceil(total / size) - 1) : null;
  /* An App's list that fits one page draws no pager at all: twelve rows
     under "« First ← Previous Page [1] of 1 Next → Last »" was five
     controls that could do nothing. */
  if (app && state.page === 0 && !more) return null;
  /* Next, Previous and Last step from the rows on screen (pageStep.ts), so a
     deep page is read by key and costs what the first does; a number typed
     in the box, and First, are read by offset. */
  const list = stepList((state as { activeConnection?: string }).activeConnection ?? '', entry.table, entry.query, size);
  const goTo = (page: number, how?: 'next' | 'previous' | 'last') => {
    const wanted = Math.max(0, lastPage === null ? page : Math.min(page, lastPage));
    if (wanted === state.page) return;
    /* Only the page the pager is on can be stepped from: while the next one
       is fetched the rows on screen are the last answer's, and a second
       click would step from them to the page already being read. */
    const bounds = at.page === state.page && at.size === size ? data.bounds : undefined;
    if (how === 'last' && counted) takePageStep(list, wanted, { end: true }, total! - wanted * size);
    else if (how === 'next' && bounds) takePageStep(list, wanted, { after: bounds.last });
    else if (how === 'previous' && bounds && wanted > 0) takePageStep(list, wanted, { before: bounds.first });
    else takePageStep(list, wanted);
    refine(() => {
      state.page = wanted;
      render();
    });
  };
  const step = (text: string, label: string, to: number, enabled: boolean, how?: 'next' | 'previous' | 'last') => (
    <button type="button" className="step-button" aria-label={label} disabled={!enabled} onClick={() => goTo(to, how)}>
      {how !== 'next' && how !== 'last' && <Icon name="caret-left" size={16} />}
      <span className="step-label">{text}</span>
      {(how === 'next' || how === 'last') && <Icon name="caret-right" size={16} />}
    </button>
  );
  const sizes = (
    <div className="pager-size">
      <span>{say('rows')}</span>
      <Dropdown
        ariaLabel={say('rowsPerPage')}
        value={String(size)}
        items={(PAGE_SIZES as number[]).map((n) => ({ value: String(n), label: String(n) }))}
        onChange={(n) =>
          refine(() => {
            setPageSize(Number(n));
            render();
          })
        }
      />
    </div>
  );
  const said = data.rows.length > 0 && (
    <span className={`pager-range${app ? ' step-position' : ''}`}>
      {formatNumber(state.page * size + 1)}–{formatNumber(shown)}
      {counted ? say('common.ofTotal', { total: formatNumber(total!) }) : ''}
    </span>
  );
  /* An App's reader pages on: where they are, then Previous and Next. First,
     Last and the page box are the Workbench's, where a table is walked. */
  if (app) {
    return (
      <div className="pager pager-app">
        {/* How many rows a page holds is the operator's instrument, not a buyer's. */}
        {!shell().publicVisitor() && sizes}
        <div className="pager-steps step-control">
          {step(say('previous'), say('previousPage'), state.page - 1, state.page > 0, 'previous')}
          {said}
          {step(say('next'), say('nextPage'), state.page + 1, more, 'next')}
        </div>
      </div>
    );
  }
  return (
    <div className="pager">
      {sizes}
      {range && said}
      <div className="pager-steps pager-workbench step-control">
        {step(say('first'), say('firstPage'), 0, state.page > 0)}
        {step(say('previous'), say('previousPage'), state.page - 1, state.page > 0, 'previous')}
        {counted ? (
          <span className="page-label step-position">
            <span>{say('common.page')}</span>
            <PageBox page={state.page} last={lastPage!} onGo={goTo} />
            <span>{say('ofPages', { count: formatNumber(lastPage! + 1) })}</span>
          </span>
        ) : (
          <span className="page-label step-position">{say('pagePage', { page: formatNumber(state.page + 1) })}</span>
        )}
        {step(say('next'), say('nextPage'), state.page + 1, more, 'next')}
        {counted && step(say('last'), say('lastPage'), lastPage!, state.page < lastPage!, 'last')}
      </div>
    </div>
  );
}

/**
 * The page box. It used to be uncontrolled and was reset by the repaint
 * that followed every move; the pager is kept now, so the box follows the
 * page it is on. What is typed stays typed while it names no page yet (an
 * emptied box on the way to another number), and goes on leaving the box.
 */
function PageBox({ page, last, onGo }: { page: number; last: number; onGo: (page: number) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <input
      className="page-input"
      type="number"
      min={1}
      max={last + 1}
      value={typed ?? String(page + 1)}
      aria-label={say('pageNumber')}
      onBlur={() => setTyped(null)}
      onChange={(e) => {
        const text = e.target.value;
        if (text === '') {
          setTyped('');
          return;
        }
        setTyped(null);
        const asked = Number(text);
        if (Number.isFinite(asked)) onGo(Math.round(asked) - 1);
      }}
    />
  );
}

export function TableView({
  entry,
  data,
  chrome,
  interactive,
  hide,
  labels,
  referenceLabels,
  totals,
  density,
  rowActions,
  editable,
  inCrumbs,
  sizing,
  export: exportOn = true,
  summaries = false,
  embedded = false,
  presentation,
  present,
  actions,
  listLabel,
  order,
  recordNavigation = false,
  at: given,
  busy = false,
}: TableViewProps) {
  /* Records or table: how a narrow screen shows the rows, the reader's pick. The page's own list draws the switch at
     the end of its control strip (AppList), beside the tabs; anywhere else, over the rows. */
  const [layout, setLayout] = useState('records');
  const { controls } = useCrumbSlots();
  const presentationSwitch = (element: ReactNode) => (inCrumbs && controls ? createPortal(element, controls) : element);
  const table = findTable(data.table) as TableMeta | undefined;
  /* The cells this reader may edit in place: the view's `editable` over the
     columns drawn, each still asked of the row (canEditRow) when drawn. */
  const shownColumns = (data.columns ?? []).filter((name) => !hide?.includes(name));
  const cells = interactive && !embedded && !presentation ? editableCells(table, editable, shownColumns) : new Map<string, string>();
  /* A dashboard's list that works as its room (embedded, interactive) offers its selection's "Set field…"
     over the same columns, and edits no cell in place: a dashboard is not where a cell is typed into. */
  const editing = [...new Set((interactive && embedded && !presentation ? editableCells(table, editable, shownColumns) : cells).values())];
  const cellsKey = [...cells].join('\n');
  const editorHere = useArrived(GridCellEdit, cells.size > 0);
  /* The shell's marks in empty cells (a suggestion waiting on one); the slot is the shell's for its whole life, so the hook's place is fixed. */
  const adornCell = shell().slots.useCellMarks?.(table, data?.rows ?? []);
  const editCell = useMemo(() => {
    if (!table || !cells.size || !editorHere) return undefined;
    return (row: Record<string, unknown>, drawn: string, draw: CellDraw, drawnLabel?: unknown) => {
      const column = cells.get(drawn);
      const key = keyOf(table, row) as Record<string, unknown> | null;
      const meta = column === undefined ? undefined : table.columns.find((c) => c.name === column);
      // A reference drawn by name is edited only when its key rode along with the row (appListModel's showClause).
      if (!key || !meta || !Object.hasOwn(row, meta.name) || !canEditRow(table, key)) return undefined;
      /* The name the cell already says — its label, or the path it draws by name — so the editor opens on it. */
      const named = drawn !== meta.name ? row[drawn] : drawnLabel;
      return (
        <GridCellEdit
          table={table}
          row={row}
          column={meta}
          recordKey={key}
          draw={draw}
          byName={drawn !== meta.name}
          {...(named === null || named === undefined || named === '' ? {} : { valueLabel: String(named) })}
        />
      );
    };
  }, [table, cellsKey, editorHere]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = given ?? { page: state.page, size: pageSize() as number };
  /* Beside a split's detail pane the grid keeps to its width, as an embedded one does. */
  const beside = useContext(BesideDetail);
  const hasSummaries =
    (summaries || embedded) &&
    table &&
    data.rows.length > 0 &&
    primaryKey(table).length > 0 &&
    primaryKey(table).every((c: string) => data.columns?.includes(c));
  /* Records and Table are a choice only where the table says more than the records do; a list whose records say it all
     has one reading, and two tabs for it are a decision with nothing to decide. */
  const choice =
    hasSummaries &&
    tableSaysMore(
      table,
      (data.columns ?? []).filter((name: string) => !hide?.includes(name)),
      data.rows,
      entry.query,
      referenceLabels,
    );
  const firstRow = explicitLimit(currentEntry()?.query ?? '') ? 0 : at.page * at.size;
  /* A new page is read from its top. When every page was a repaint the room
     emptied while the next one loaded and the pane fell back to the top by
     itself; the room is kept now, so the head is brought back into view on
     purpose, once the new page has landed and only if it had scrolled away.
     Not for a sort: the header under the pointer is where the reader is. */
  const head = useRef<HTMLDivElement>(null);
  const turned = useRef(`${at.page}:${at.size}`);
  useEffect(() => {
    const now = `${at.page}:${at.size}`;
    if (turned.current === now) return;
    turned.current = now;
    head.current?.scrollIntoView({ block: 'nearest' });
  }, [at.page, at.size]);
  /* A presentation stands in for the grid only when the answer carries every
     column it reads; an advanced query that dropped one keeps the grid. */
  /* The list these rows are a page of, for every presentation of it: a
     record opened from the grid, a card, a queue or a checklist steps past
     the page with the same question (recordTrail.ts). A query that names its
     own limit is the whole list, so no page follows this one. */
  const list = explicitLimit(entry.query) ? undefined : trailListFor(entry.query, data);
  /* The record beside this list — a split's detail — marked in it and kept
     in view while J and K step (Rooms.tsx). */
  const top = currentEntry() as { kind?: string; table?: string; key?: Record<string, unknown> } | undefined;
  const current = top?.kind === 'row' && top.table === entry.table ? top.key : undefined;
  /* A view's hand order is live only while the question reads in it — its
     sort is that column, ascending, and nothing else. A header, a tab's own
     sort or the Sort menu reads the rows another way, and the handles go
     until the order is back. */
  const listOrder: ListOrder | undefined = order
    ? {
        column: order,
        active: sortCount(entry.query) === 1 && sortDirection(entry.query, order) === 'asc',
        partial: at.page > 0 || (typeof data.total === 'number' ? data.total > data.rows.length : data.rows.length >= at.size),
      }
    : undefined;
  const presented =
    presentation && present
      ? present({
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
          order: listOrder,
          at,
        })
      : null;
  if (presented?.whole) return presented.element;
  if (presented)
    return (
      <>
        {data.rows.length ? presented.element : <p className="checklist-empty">{say('nothingHereRightNow')}</p>}
        {chrome && data.rows.length > 0 && (
          <p className="checklist-count">
            {typeof data.total === 'number' && data.exactTotal !== false && data.total > data.rows.length
              ? say('shownOfTotal', { shown: data.rows.length, total: `${data.total}${data.cappedTotal ? '+' : ''}` })
              : say('shown', { rowsCount: data.rows.length })}
          </p>
        )}
        {/* An App's cards, queue or checklist page as its grid does: they drew
        the first twenty of fifty-five cars and no way to the rest. A board
        reads its lanes whole (BoardList), so it has no page to turn. */}
        {presented.pages && (chrome ? state.page > 0 || data.rows.length >= pageSize() : shell().inApp()) && (
          <Pager entry={entry} data={data} at={at} />
        )}
      </>
    );
  /* The grid, then what decorates its rows from outside: a checkbox in the
     leading cell for a reader offered bulk actions, a grip there for a view
     kept in hand order, a ⋯ at the end of each row when the view asks for
     row menus. */
  const gridOf = (rows: typeof data.rows) => (
    <Grid
      table={table}
      data={rows === data.rows ? data : { ...data, rows }}
      hide={hide}
      labels={labels}
      referenceLabels={referenceLabels}
      totals={totals}
      density={density}
      sizing={sizing}
      interactive={interactive}
      firstRow={firstRow}
      list={list}
      current={current}
      dropColumns={embedded || beside}
      editCell={editCell}
      {...(adornCell ? { adornCell } : {})}
    />
  );
  const hasOrder = Boolean(listOrder && table);
  const ordered =
    hasOrder && listOrder && table ? (
      <GridOrder table={table} rows={data.rows} order={listOrder} interactive={interactive}>
        {gridOf}
      </GridOrder>
    ) : (
      gridOf(data.rows)
    );
  const selected =
    table && selectableGrid(table, actions ?? [], interactive, editing) ? (
      <RowHosts>
        <GridSelection table={table} rows={data.rows} actions={actions ?? []} interactive={interactive} editable={editing} />
        {ordered}
      </RowHosts>
    ) : !hasOrder ? (
      ordered
    ) : (
      <RowHosts>{ordered}</RowHosts>
    );
  // A row's menu draws what the record's bar draws, so an action kept out of it (`header: false`) is no reason for a ⋯.
  const tableGrid =
    rowActions && (interactive || embedded) && table && actions?.some((action) => action.header !== false) && primaryKey(table).length ? (
      <RowTrailHosts>
        <RowActions table={table} rows={data.rows} actions={actions} onDone={() => render()} />
        {selected}
      </RowTrailHosts>
    ) : (
      selected
    );
  return (
    <>
      <ResultHead
        entry={entry}
        data={data}
        chrome={chrome}
        interactive={interactive}
        exportOn={exportOn}
        at={at}
        headRef={head}
        inCrumbs={inCrumbs}
      />
      <div className={hasSummaries ? `responsive-results show-${embedded || !choice ? 'records' : layout}` : undefined}>
        {hasSummaries && (
          <>
            {!embedded &&
              choice &&
              presentationSwitch(
                <PresentationSwitch
                  layout={layout}
                  onChange={setLayout}
                  label={say('common.listPresentation')}
                  records={say('common.records')}
                  table={say('common.table')}
                />,
              )}
            {/* A reference says its record's name here too, as the grid beside it does. */}
            <RecordSummaries
              table={table}
              data={data}
              columns={(data.columns ?? []).filter((name) => !hide?.includes(name))}
              labels={labels}
              referenceLabels={referenceLabels}
              list={list}
              query={entry.query}
              {...(adornCell ? { adornFact: (row: Record<string, unknown>, column: string) => adornCell(row, column, 'summary') } : {})}
            />
          </>
        )}
        <div className="result-table" aria-busy={busy || undefined}>
          {tableGrid}
        </div>
      </div>
      <Pager entry={entry} data={data} at={at} range={inCrumbs} />
    </>
  );
}
