/**
 * The table view as a room: the fetch, what it touches, and the components
 * that draw the answer.
 *
 * The request is a Query keyed by everything that changes the answer — the
 * connection, the table, the line, the page and its size — so a reply that
 * outlived its question never paints: the key it was fetched under is no
 * longer the one on screen. The room owns that result. A page, a page size
 * or a header's sort or filter is a refinement (core.js `refine`): the room
 * stays mounted, the key moves, and the previous answer stays on screen
 * until the next lands, so the grid re-renders in place and whatever lives
 * in its rows keeps its state. Nothing is kept between visits (`gcTime: 0`):
 * any other paint starts the room over and re-asks, the way it always was,
 * and a write that repaints the room sees its own effect.
 *
 * With `chrome` the room is the explorer's own — the tabs, the filter
 * boxes, the query bar's text, and the globals a shared result touches:
 * the nested cache, the error banner, the SQL pane, the history. Off, it
 * is a grid embedded in someone else's surface — an app list, a dashboard
 * section, a page's chooser — and touches nothing but its own box.
 */
import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { $, api, columnLabel, findTable, go, pageSize, setExplain, showErrors, state, tableView } from '../core.js';
import { explicitLimit } from '../clauses.js';
import { deriveFilterNames } from '../filterbar.js';
import { recordQuery } from '../history.js';
import { resetNested } from '../nested.js';
import { canUseDatabaseTools } from '../connectionScope.js';
import { shell } from '../shellMode.js';
import { appKeepsRoles } from '../roleLabels.js';
import { arrivedPlacement } from '../addressMount.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { ResourceClientReply, ResourceHttpSuccess } from '@mistriwork/engine/shared/resourceHttp.js';
import { onDemand, useArrived } from './onDemand.js';
import { FilterBar } from './FilterBoxes.js';
import { Delayed, GridSkeleton } from './Skeleton.js';
import { Problem, Refused } from './Notes.js';
import type { GridData } from './Grid.js';
import { GridCellEdit, isApiConnection, TableView, ViewTabs, type PageAt, type TableEntry, type TableViewProps } from './TableView.js';
import { pageStepFor, stepList } from './pageStep.js';
import { ExportHold } from './ExportHold.js';
import { batchedRun } from '../breakdownBatch.js';
import { useListHold } from '../liveState.js';
import { say } from '../copy/lists/components/TableRoom.js';

/* The diagrams are a chunk of their own, loaded when the Diagram tab is first opened. */
/**
 * A list this reader's catalog leaves out. Signed in, the role is the reason.
 * Signed out of an App the public browses, the list may well be a member's:
 * the refusal offers the sign-in, drawn in place so the visitor comes back to
 * this address once signed in (the shell's `signInHere`, publicSurface.js). A visitor on a
 * tenant's public address keeps the top bar's door, which leaves that address
 * behind on purpose (app.js, showAccount).
 */
function NotYours({ thing }: { thing: string }) {
  const app = state.activeConnection;
  const noun = { thing };
  // An App with no roles has none to blame: the list is simply not one this address names.
  if (!shell().publicVisitor()) return <Refused text={say(appKeepsRoles() ? 'notAvailableToYou' : 'notAvailableHere', noun)} />;
  // Signed out, no role is the reason, wherever the door is.
  if (typeof app !== 'string' || arrivedPlacement()) return <Refused text={say('signInToSeeThis', noun)} />;
  return (
    <Refused
      text={say('signInToSeeThis', noun)}
      action={
        <button type="button" className="ghost" onClick={() => shell().signInHere(app)}>
          {say('common.signIn')}
        </button>
      }
    />
  );
}

const NeighbourhoodDiagram = onDemand(() => import('./Diagram.js'), 'NeighbourhoodDiagram');
/* An API's documented reads, tried from here: only a connection to an API has the tab. */
/* The pill over a list that is held (liveState.ts): a part of its own, fetched when the first change is held. */
const LivePill = onDemand(() => import('./LiveNotices.js'), 'LivePill', { quiet: true });
const ApiOperations = onDemand(() => import('./ApiOperations.js'), 'ApiOperations');

type RunData = ResourceHttpSuccess<'/api/run'>;

interface TableRoomProps {
  empty?: ReactNode;
  presentation?: TableViewProps['presentation'];
  /** What draws `presentation` (TableView.tsx): the App's, which its lists hand down. */
  present?: TableViewProps['present'];
  /** The entry's fixed actions; a queue offers the bulk ones, a board its lane moves. */
  actions?: TableViewProps['actions'];
  /** The entry's label, the accessible name a presentation goes by. */
  listLabel?: string;
  /** The view's hand-order column, where it keeps one. */
  order?: string;
  /** A read-only card may still be a doorway to its record. */
  recordNavigation?: boolean;
  sizing?: TableViewProps['sizing'];
  entry: TableEntry;
  /** The explorer's own view: tabs, boxes, the query bar, the shared globals. Default on. */
  chrome?: boolean;
  /** A gutter on both sides; embedded grids sit in sections that already pad. Defaults to `chrome`. */
  inset?: boolean;
  interactive?: boolean;
  hide?: string[];
  labels?: Record<string, string>;
  /** A reference column → the fetched path its record's name is read from (appListModel's referenceNames). */
  referenceLabels?: Record<string, string>;
  /** Column → its total over the whole query; undefined while it is asked. */
  totals?: Record<string, unknown>;
  density?: 'comfortable' | 'compact';
  /** A ⋯ menu at the end of each row with the record's own actions. */
  rowActions?: boolean;
  /** The view's `editable`: cells edited in place and the selection's "Set field…". */
  editable?: true | string[];
  /** The page's own list: its verbs go to the crumb bar and its range to the pager. */
  inCrumbs?: boolean;
  export?: boolean;
  summaries?: boolean;
  /** Drawn inside another room (a dashboard's section): see TableViewProps.embedded. */
  embedded?: boolean;
  /** Re-asked when this changes — a dashboard's refresh clock. */
  version?: number;
  /** The answer, once it has rows and columns. */
  onResult?: (data: RunData) => void;
}

/** The noun a refused room is: a record when the address names one, a list over a table the reader's catalog has,
    and a page for whatever else (the catalog leaves out what the role cannot see, so its kind is not known). */
const thingOf = (entry: TableEntry, table: TableMeta | undefined): string => {
  const { kind, table: named } = entry as { kind?: string; table?: string };
  return kind === 'row' || (kind === 'page' && named) ? say('thingRecord') : table ? say('thingList') : say('thingPage');
};

const connection = () => (state as { activeConnection?: string }).activeConnection ?? '';

export function TableRoom({
  entry,
  chrome = true,
  inset = chrome,
  interactive = true,
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
  version = 0,
  onResult,
  presentation,
  present,
  actions,
  listLabel,
  order,
  recordNavigation = false,
  empty,
}: TableRoomProps) {
  /* A tab this reader cannot have here falls back to Rows: Definition and API
     are the operator's, API only over an API, and an API's definition is its
     description, so it has no Definition tab. */
  const wanted = entry.tab ?? 'rows';
  const overApi = isApiConnection();
  const tab =
    (wanted === 'ddl' || wanted === 'api') && !canUseDatabaseTools()
      ? 'rows'
      : (wanted === 'api' && !overApi) || (wanted === 'ddl' && overApi)
        ? 'rows'
        : wanted;
  /* Only the explorer's own table view owns the query bar. Chrome off means
     an app list or an embedded chooser: their entry is synthetic, and a bar
     showing a query the walk is not on is the bar lying about where you are. */
  useEffect(() => {
    if (!chrome) return;
    const bar = $('query') as HTMLInputElement | null;
    if (bar) bar.value = entry.query;
  }, [chrome, entry.query]);
  return (
    <>
      {chrome && (
        <div className="grid-host">
          <ViewTabs entry={entry} />
        </div>
      )}
      {/* Keyed by the line: the boxes hold what was typed and not yet sent, and
          a header's filter that changed the line under them starts them over,
          as the repaint it used to be did. A page keeps them. */}
      {chrome && tab === 'rows' && <FilterSection key={entry.query} entry={entry} />}
      <div className={inset ? 'grid-inset' : undefined}>
        {tab === 'diagram' ? (
          <div className="panel-pad">
            <div className="diagram">
              <NeighbourhoodDiagram tableId={entry.table} />
            </div>
          </div>
        ) : tab === 'api' ? (
          <ApiOperations table={entry.table} />
        ) : tab === 'ddl' ? (
          <DdlPane table={entry.table} />
        ) : (
          <Rows
            entry={entry}
            chrome={chrome}
            interactive={interactive}
            hide={hide}
            labels={labels}
            referenceLabels={referenceLabels}
            totals={totals}
            density={density}
            rowActions={rowActions}
            editable={editable}
            inCrumbs={inCrumbs}
            sizing={sizing}
            exportOn={exportOn}
            summaries={summaries}
            embedded={embedded}
            version={version}
            onResult={onResult}
            presentation={presentation}
            present={present}
            actions={actions}
            listLabel={listLabel}
            order={order}
            recordNavigation={recordNavigation}
            empty={empty}
          />
        )}
      </div>
    </>
  );
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A refusal in the reader's words. An API's refusal quotes columns as the API
 * names them (`carrier_id`) and lists which (`columns`); an App calls them by
 * its captions ("Carrier"). Only the listed names are swapped, as whole words,
 * and never inside a documented sort value such as `-created_at`. Outside an
 * App there are no captions, and the message stays as it is.
 */
export function inCaptions(error: unknown, table: TableMeta | undefined): string {
  const message = (error as Error).message;
  const columns = (error as { columns?: unknown }).columns;
  if (!table || !Array.isArray(columns)) return message;
  return columns.reduce<string>((text, name) => {
    const caption = typeof name === 'string' ? columnLabel(table.id, name) : null;
    return caption && caption !== name ? text.replace(new RegExp(`(?<![\\w+-])${escaped(name)}(?![\\w:])`, 'g'), () => caption) : text;
  }, message);
}

/**
 * The named filter boxes over a table (components/FilterBoxes.tsx), in a host
 * that takes no room. Standing alone a new question goes to the walk;
 * embedded (a rootless page's chooser) the host says where it goes.
 */
export function FilterSection({ entry, names, navigate }: { entry: TableEntry; names?: string[]; navigate?: (query: string) => void }) {
  const table = findTable(entry.table) as TableMeta | undefined;
  if (!table) return null;
  const chosen = names ?? (deriveFilterNames(table) as string[]);
  if (!chosen.length) return null;
  const to = navigate ?? ((query: string) => go(tableView(entry.table, query, entry.tab), 'replace'));
  return (
    <div className="host-contents">
      <FilterBar table={table} entry={entry} names={chosen} navigate={to} />
    </div>
  );
}

/* The page each answer was asked for, by the answer. While the next page is
   fetched the previous answer is what is on screen, and the head's range and
   the keyboard's row numbers describe the rows that are there. */
const askedFor = new WeakMap<object, PageAt>();

/* A list's total, by the question and not the page: turning a page asks for
   rows only (`count: 'none'`) and says the total the list already has. It
   was recounted on every page turn — the offset is in the rows' key — and
   a filtered total is most of a filtered read's time. The key carries the
   room's version, so a write that could change the total recounts it; page
   one always counts, so going back to the start refreshes it. */
type Totals = Pick<GridData, 'total' | 'exactTotal' | 'cappedTotal'>;
const listTotals = new Map<string, Totals>();
const TOTALS_KEPT = 50;
function keepTotal(key: string, reply: unknown): void {
  if (!reply || typeof reply !== 'object' || !('ms' in reply)) return;
  const { total, exactTotal, cappedTotal } = reply as Totals;
  if (typeof total !== 'number') return;
  listTotals.delete(key);
  if (listTotals.size >= TOTALS_KEPT) listTotals.delete(listTotals.keys().next().value!);
  listTotals.set(key, { total, ...(exactTotal !== undefined ? { exactTotal } : {}), ...(cappedTotal ? { cappedTotal } : {}) });
}

function Rows({
  entry,
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
  exportOn,
  summaries,
  embedded,
  version,
  onResult,
  presentation,
  present,
  actions,
  listLabel,
  order,
  recordNavigation,
  empty,
}: {
  empty?: ReactNode;
  embedded: boolean;
  presentation?: TableViewProps['presentation'];
  present?: TableViewProps['present'];
  actions?: TableViewProps['actions'];
  listLabel?: string;
  order?: string;
  recordNavigation: boolean;
  sizing?: TableViewProps['sizing'];
  entry: TableEntry;
  chrome: boolean;
  interactive: boolean;
  hide?: string[];
  labels?: Record<string, string>;
  referenceLabels?: Record<string, string>;
  totals?: Record<string, unknown>;
  density?: 'comfortable' | 'compact';
  rowActions?: boolean;
  editable?: true | string[];
  inCrumbs?: boolean;
  exportOn: boolean;
  summaries: boolean;
  version: number;
  onResult?: (data: RunData) => void;
}) {
  const table = findTable(entry.table) as TableMeta | undefined;
  /* An explicit `limit` in the query is a deliberate statement and beats the page size. */
  const asked = explicitLimit(entry.query) as number | null;
  const size = pageSize() as number;
  const page = (state as { page: number }).page;
  const source = connection();
  /* A page the pager stepped to is read by key, the end with its own length (pageStep.ts). */
  const step = asked ? undefined : pageStepFor(stepList(source, entry.table, entry.query, size), page);
  const limit = asked ?? step?.limit ?? size;
  const offset = asked ? 0 : page * size;
  const exact = entry.exactCount === true;
  const run = useQuery<ResourceClientReply<'/api/run'>>({
    queryKey: ['run', source, entry.table, entry.query, limit, offset, exact, version, step?.body],
    queryFn: async () => {
      const totalKey = JSON.stringify([source, entry.table, entry.query, exact, version]);
      const known = offset > 0 ? listTotals.get(totalKey) : undefined;
      const asked = { q: entry.query, limit, offset, exactCount: exact, ...(known ? { count: 'none' as const } : {}) };
      /* A table on a dashboard is asked with the dashboard's other sections,
         in one request (breakdownBatch.ts); a room's own list, and a page
         stepped to by key, are asked alone. */
      const answer: ResourceClientReply<'/api/run'> =
        embedded && !step ? await batchedRun<ResourceClientReply<'/api/run'>>(asked) : await api('/api/run', { ...asked, ...step?.body });
      const reply = (
        known && answer && typeof answer === 'object' && 'ms' in answer ? { ...answer, ...known } : answer
      ) as ResourceClientReply<'/api/run'>;
      if (!known) keepTotal(totalKey, reply);
      if (reply && typeof reply === 'object') askedFor.set(reply, { page, size });
      return reply;
    },
    staleTime: 0,
    gcTime: 0,
    /* The previous answer stays while the next is fetched, but only an
       answer about this table from this connection: rows of another table
       under this one's header would be a lie, however brief. */
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === source && previousQuery.queryKey[2] === entry.table ? previous : undefined,
  });
  const data = run.data;
  /* A list its reader is working in is held still when another person's change would redraw it, and says so in a pill
     (liveState.ts); a table on a dashboard or a short related list never is. */
  const held = useListHold(
    embedded || limit <= 5
      ? undefined
      : {
          table: entry.table,
          owns: (key) => key[0] === 'run' && key[1] === source && key[2] === entry.table && key[3] === entry.query,
        },
  );
  /* A list that edits in place waits for its cells' editor beside its rows (TableView.tsx). */
  const edits = Boolean(editable) && interactive && !embedded && !presentation;
  const editorHere = useArrived(GridCellEdit, edits);
  useEffect(() => {
    if (!data) return;
    if (chrome) {
      resetNested();
      showErrors(data.errors ?? []);
      setExplain('explain' in data ? data.explain : undefined);
    }
    if (!('ms' in data)) return;
    /* Recorded here rather than at submit: this is the point where the query
       is known to have compiled and run. Only queries a person typed. */
    if (chrome) recordQuery(entry.query);
    onResult?.(data);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  /* A signed-out visitor asking past what the App opens to the public is asked to sign in (401), whether the table
     is a member's or no table at all: offered in place. */
  if (run.isError && (run.error as { code?: string }).code === 'members_only' && !chrome) return <NotYours thing={thingOf(entry, table)} />;
  /* An App's list that could not be read says so as every place does (Notes.tsx): the warn mark, the sentence and Try
     again on the list's edge. A bare grey line was a dead end only a reload got out of. The Workbench keeps its note
     under the query bar it can fix the question in. */
  if (run.isError)
    return chrome ? (
      <p className="note">{inCaptions(run.error, table)}</p>
    ) : (
      <div className="list-problem">
        <Problem text={inCaptions(run.error, table)} />
      </div>
    );
  /* Shaped like the grid that is about to replace it, and only if the query
     takes long enough to be worth acknowledging. */
  if (!data || (edits && !editorHere))
    return (
      <>
        {inCrumbs && exportOn && !presentation && <ExportHold />}
        <Delayed>
          <div className="host-contents">
            <GridSkeleton columns={Math.max((table?.columns.length ?? 5) - (hide?.length ?? 0), 1)} rows={limit} />
          </div>
        </Delayed>
      </>
    );
  /* An App's list over a table the role cannot read is answered "No table called ..." (the catalog it sees leaves the table out):
     there is no query bar to fix, only a list that is not this reader's. */
  if (!('ms' in data))
    return !chrome && !table ? <NotYours thing={thingOf(entry, table)} /> : <p className="note">{say('fixTheQueryAbove')}</p>;
  /* Not over a question that failed: its error says why there are no rows. */
  if (empty && !run.isPlaceholderData && data.rows.length === 0 && page === 0 && !data.errors?.length) return <>{empty}</>;
  return (
    <>
      {held.held ? <LivePill held={held.held} show={held.show} /> : null}
      <TableView
        entry={entry}
        data={data}
        chrome={chrome}
        interactive={interactive}
        hide={hide}
        labels={labels}
        referenceLabels={referenceLabels}
        totals={totals}
        density={density}
        rowActions={rowActions}
        editable={editable}
        inCrumbs={inCrumbs}
        sizing={sizing}
        export={exportOn}
        summaries={summaries}
        embedded={embedded}
        presentation={presentation}
        present={present}
        actions={actions}
        listLabel={listLabel}
        order={order}
        recordNavigation={recordNavigation}
        at={askedFor.get(data) ?? { page, size }}
        busy={run.isPlaceholderData}
      />
    </>
  );
}

/** The table's definition: the statement the database keeps, or one rebuilt from its catalog. */
function DdlPane({ table }: { table: string }) {
  const ddl = useQuery<{ sql: string; exact: boolean }>({
    queryKey: ['ddl', connection(), table],
    queryFn: () => api(`/api/ddl?table=${encodeURIComponent(table)}`),
  });
  if (ddl.isError) return <p className="note">{(ddl.error as Error).message}</p>;
  if (!ddl.data)
    return (
      <Delayed>
        <div className="host-contents">
          <GridSkeleton columns={2} rows={6} />
        </div>
      </Delayed>
    );
  return (
    <>
      <p className="ddl-note">
        <strong>{ddl.data.exact ? say('storedDefinition') : 'Reconstructed. '}</strong>
        {ddl.data.exact ? say('thisIsTheStatement') : say('rebuiltFromTheCatalog')}
      </p>
      <pre className="ddl">{ddl.data.sql}</pre>
    </>
  );
}
