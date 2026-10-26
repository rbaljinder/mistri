/**
 * The smaller rooms, as the content pane reaches them: an app's list page,
 * a dashboard, a record — and the row that has to find out which page it
 * opens as. Each keeps what its vanilla crossing kept: the walk's business
 * (a crumb corrected once a name is known, the address written when a
 * control moves) and the host the component is drawn into.
 */
import { FavoriteStar } from './FavoriteStar.js';
import { useEffect, useRef, useState } from 'react';
import {
  allowMutationExit,
  api,
  beginNavigation,
  captureNavigation,
  currentEntry,
  findTable,
  go,
  humanName,
  keyOf,
  pageFor,
  pageView,
  primaryKey,
  refsTo,
  renderCrumbs,
  state,
  tableView,
} from '../core.js';
import { equalityFilter } from '../resourceRequests.js';
import { openNewRecord } from '../insert.js';
import { squeeze } from '../filterbar.js';
import { dashboardFor } from '../dashboard.js';
import { syncHash } from '../url.js';
import { activeDraft, templateFor } from '../template.js';
import { shell } from '../shellMode.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { pluralOf } from '@mistriwork/engine/shared/appNoun.js';
import { AppList } from './AppList.js';
import { appListFor, appListQuery, newRecordNoun, splitOf, type ListEntry, type ListSpec } from './appListModel.js';
import { onDemand } from './onDemand.js';
import { dashboardSelection, rootSlot, type DashboardDef } from './dashboardModel.js';
import { preloadDashboardParts } from './dashboardParts.js';
import { NewRecordButton, type FormSpec } from './NewRecordButton.js';
import type { RowEntry, Template } from './Record.js';
import type { PageEntry } from './pageModel.js';
import { say } from '../copy/shell/components/Rooms.js';

/* The Workbench's record view; an App's record opens as its page, and never loads it. */
const RecordView = onDemand(() => import('./Record.js'), 'RecordView');

/* ---------- an app's list page ---------- */

interface AppListRoomProps {
  entry: ListEntry;
  spec: ListSpec & { form?: FormSpec; actions?: unknown[] };
  /**
   * Embedded (a rootless page's chooser), the list must not navigate the
   * walk — a tab click there would replace the page entry itself and eject
   * the reader from page view. The host hands in where new questions go;
   * standing alone, they go to the walk as always.
   */
  navigate?: (query: string) => void;
}

export function AppListRoom({ entry, spec: given, navigate }: AppListRoomProps) {
  /* The view that opened this list, by its key, over the one its table and
     query suggest: a split beside a plain list asks the same question of
     the same rows. A key naming no view falls back to the suggestion. */
  const spec =
    entry.view && given.id !== entry.view ? (appListFor(entry.table, entry.query, entry.view) as AppListRoomProps['spec']) : given;
  const to = navigate ?? ((query: string) => go({ ...tableView(entry.table, query), view: entry.view }, 'replace'));
  /* A bare table reached by link — `/crm/task` — is the list on its first
     tab, the way the sidebar opens it. Rendered as it arrived it was every
     column of the table under raw headers with no tab lit: the workbench's
     grid wearing the app's chrome. Standing alone only; embedded, the host
     decides what question the list is answering. */
  const bare = squeeze(entry.query ?? '') as string;
  const redirect = !navigate && (!bare || bare === entry.table) && Boolean(spec.tabs?.length || spec.show?.length || spec.query);
  useEffect(() => {
    if (!redirect) return;
    /* After this render, not during it: the redirect is a navigation, and a
       navigation repaints the room that is being drawn. */
    queueMicrotask(() => {
      if (currentEntry() === entry) to(appListQuery(spec, 0));
    });
  }, [redirect]); // eslint-disable-line react-hooks/exhaustive-deps
  /* `…!new` in the address: the New drawer, open over this list — a
     half-filled form survives a reload, and a link can open it. */
  useEffect(() => {
    if (navigate || redirect || entry.tab !== 'new') return;
    const table = findTable(entry.table) as TableMeta | undefined;
    if (table) openNewRecord(table, spec.form, { reopen: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (redirect) return null;
  const table = findTable(entry.table) as TableMeta | undefined;
  const noun = newRecordNoun(spec, table?.name ?? entry.table);
  /* An import is the App framework's (ImportButton.tsx), drawn through the shell's slot. */
  const { ImportButton } = shell().slots;
  return (
    <div className="applist-host">
      <AppList
        entry={entry}
        spec={spec}
        navigate={to}
        embedded={Boolean(navigate)}
        newButton={
          <>
            {ImportButton && (
              <ImportButton table={table} view={entry.view ?? spec.id} noun={spec.noun ?? { one: noun, many: pluralOf(noun) }} />
            )}
            <NewRecordButton table={table} label={noun} form={spec.form} />
          </>
        }
      />
    </div>
  );
}

/* ---------- a dashboard ---------- */

export function DashboardRoom({ entry }: { entry: PageEntry }) {
  const dashboard = dashboardFor(entry.pageId) as DashboardDef | null;
  useEffect(() => {
    if (!dashboard || currentEntry() !== entry) return;
    if (entry.label !== dashboard.label) {
      /* A dashboard reached by pasted link painted its crumb before this
         room could say its name, so the trail read "dash-sales-dashboard".
         Same correction the row view makes when its label arrives. */
      entry.label = dashboard.label;
      renderCrumbs();
    }
    /* Painted, so the walk can come back here by name. */
    if (!dashboard.error && currentEntry() === entry) entry.table = undefined;
  }, [dashboard, entry]);
  if (!dashboard) return <p className="note">{say('noDashboardCalledInThisApp', { pageId: entry.pageId })}</p>;
  if (dashboard.error) return <p className="note">{dashboard.error}</p>;
  /* A free-form page is the App framework's room (FreePage.tsx), drawn through the shell's rooms slot. */
  if (dashboard.page) {
    const Page = shell().rooms.Page;
    return Page ? <Page entry={entry} dashboard={dashboard} page={dashboard.page} /> : null;
  }
  return <DashboardBody entry={entry} dashboard={dashboard} />;
}

/**
 * A free-form page (definePage): the dashboard of its one component, which
 * is handed the page's frame — what it declared it reads and runs, its
 * loader, and its place in the address. Its place rides the page entry's
 * root slot as a dashboard's picks do, so `/{app}/pick-walk?list=12` opens
 * where the reader was; a change is a step Back returns from, unless the
 * component says it refines this one.
 */
function DashboardBody({ entry, dashboard }: { entry: PageEntry; dashboard: DashboardDef }) {
  /* The dashboard itself is the App's (Dashboard.tsx, a chunk of its own the App shell names); a
     dashboard entry only exists where an App declared one, so the room never stands without it. */
  const Dashboard = shell().rooms.Dashboard;
  // Its sections' parts, asked beside its chunk rather than after it has drawn (dashboardModel.ts).
  preloadDashboardParts(dashboard);
  /* The reader's window and picks ride the page entry's root slot — a
     windowed, picked dashboard is a place worth sending someone, and its
     address says them as parameters (publicAddress.ts):
     `/compass/sales?period=last-30-days&owner_id=12&stage=proposal`. The window is
     matched slug-to-slug against the offered phrases, the picks by column
     against the offered filters, so a link naming a window or a column this
     dashboard no longer offers just lands on all time, unpicked. */
  const { window: fromLink, picks: pickedFromLink, periods: periodsFromLink } = dashboardSelection(dashboard, entry.rootBody);
  const windowOn = useRef<string | null>(fromLink);
  const picksOn = useRef<Record<string, string>>(pickedFromLink);
  const periodsOn = useRef<Record<string, string>>(periodsFromLink);
  const writeSlot = () => {
    entry.rootBody = rootSlot(windowOn.current, picksOn.current, periodsOn.current, dashboard.window) || undefined;
    /* A refinement of the screen you are on, not a step: replace. */
    (state as unknown as { navMode: string }).navMode = 'replace';
    syncHash();
  };
  return (
    <>
      <div className="applist-head dash-head">
        <h1 className={`applist-title${dashboard.headingHidden ? ' visually-hidden' : ''}`}>{dashboard.heading ?? dashboard.label}</h1>
        {dashboard.favorite && (
          <FavoriteStar favorite={{ kind: 'view', view: dashboard.id, label: dashboard.label }} name={dashboard.label} />
        )}
        {dashboard.description && <p className="note dash-description">{dashboard.description}</p>}
      </div>
      <div>
        {Dashboard && (
          <Dashboard
            dashboard={dashboard}
            window={fromLink}
            picks={pickedFromLink}
            periods={periodsFromLink}
            onWindow={(w) => {
              windowOn.current = w;
              writeSlot();
            }}
            onPick={(p) => {
              picksOn.current = p as Record<string, string>;
              writeSlot();
            }}
            onPeriods={(p) => {
              periodsOn.current = p;
              writeSlot();
            }}
          />
        )}
      </div>
    </>
  );
}

/* ---------- a record ---------- */

/**
 * The record view; the host is the record grid itself, because the
 * stylesheet places the grid as the content pane's own child and its
 * panels as the grid's.
 */
function RecordRoom({ entry }: { entry: RowEntry }) {
  const table = findTable(entry.table) as TableMeta;
  /* Whether anything *can* point here is a fact about the schema, known
     before any request. */
  const canBeReferenced = (refsTo(entry.table) as unknown[]).length > 0;
  /* The in-progress draft wins while the builder is open, so the record on
     screen is the layout being edited rather than the last one saved. */
  const template = (activeDraft(entry.table) ?? templateFor(entry.table)) as Template;
  return (
    <div className={canBeReferenced ? 'record' : 'record record-solo'}>
      <RecordView
        entry={entry}
        table={table}
        template={template}
        onLabel={(label) => {
          /* The walk may have moved on while the row was fetched; a late reply
             must not rename the record the reader is now looking at. */
          if (currentEntry() !== entry) return;
          entry.label = label;
          renderCrumbs();
        }}
        onChooseTab={(fkName) => {
          if (currentEntry() !== entry) return;
          entry.tab = fkName;
          syncHash();
        }}
      />
    </div>
  );
}

/**
 * A row, as the view it was opened from presents it: beside its list when
 * that view is a split, else as below. Which view is the walk's word —
 * `view`, the key of the view the row was chosen from — and without one the
 * table's own list, as before keys existed.
 */
export function RowRoom({ entry }: { entry: RowEntry & { view?: string; address?: string } }) {
  /* A record addressed by its natural key (`/shop/products/SKU-1049`) is
     found by it first: every room below holds a record by its primary key,
     which is what it edits and links by. */
  const table = findTable(entry.table) as TableMeta | undefined;
  const pk = table ? (primaryKey(table) as string[]) : [];
  const keyed =
    !table ||
    (pk.length > 0 && pk.length === Object.keys(entry.key ?? {}).length && pk.every((column) => Object.hasOwn(entry.key ?? {}, column)));
  if (!keyed) return <NaturalKeyRoom entry={entry} table={table!} />;
  return <KeyedRowRoom entry={entry} />;
}

/** The record a natural key names, found by it and walked to by its primary key; "not found" when nothing matches. */
function NaturalKeyRoom({ entry, table }: { entry: RowEntry & { view?: string; address?: string }; table: TableMeta }) {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    void (
      api('/api/query', { table: entry.table, filter: equalityFilter(entry.key), limit: 2, offset: 0 }) as Promise<{
        rows?: Record<string, unknown>[];
      }>
    ).then(
      (result) => {
        if (!live || currentEntry() !== entry) return;
        const rows = result.rows ?? [];
        // One row or none: two would be no key at all, and `mistri check` refuses such an address.
        if (rows.length !== 1) {
          setMissing(true);
          return;
        }
        const natural = Object.values(entry.key)[0];
        go({ ...entry, key: keyOf(table, rows[0]) as Record<string, unknown>, address: String(natural) }, 'replace');
      },
      () => {
        if (live) setMissing(true);
      },
    );
    return () => {
      live = false;
    };
  }, [entry, table]);
  return missing ? (
    <p className="note">
      {say('noIsAddressed', { name: String(humanName(table.name)).toLowerCase(), values: String(Object.values(entry.key)[0]) })}
    </p>
  ) : null;
}

function KeyedRowRoom({ entry }: { entry: RowEntry & { view?: string } }) {
  /* The workbench is the database, not the App: there a row is a record, the
     next step of the walk, never the App's split beside the App's list. The
     App's list was asked regardless of mode, so a table the App presents as a
     split (Thread's comments) turned the explorer into list-and-detail, every
     row click a step of the walk, under the App's heading and New button. */
  const spec = shell().inApp() ? appListFor(entry.table, undefined, entry.view) : undefined;
  /* A split's pick is the App framework's room (SplitRecordRoom.tsx), drawn through the shell's rooms slot. */
  const SplitRecord = shell().rooms.SplitRecord;
  if (spec && splitOf(spec) && SplitRecord) return <SplitRecord entry={entry} spec={spec} />;
  // This is a presentation boundary, not a preference or a lookup fallback.
  // Separate children also discard pending App state on a mode transition.
  return shell().inApp() ? <RowPageRoom entry={entry} /> : <RecordRoom entry={entry} />;
}

/**
 * A row reached by link, while an app is on, opens as the app's page for
 * its table — the same room a click would have opened. The record view
 * stayed the workbench's: raw labels, `As a page →`, a rail of references,
 * on a link pasted from an app that never shows any of it. Asked
 * asynchronously, and answered only while this entry is still the one on
 * the walk.
 */
function RowPageRoom({ entry }: { entry: RowEntry }) {
  const [attempt, retry] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const isCurrent = captureNavigation();
    const ownsRoom = () => live && shell().inApp() && currentEntry() === entry;
    setFailed(false);
    void (pageFor(entry.table) as Promise<string | null>)
      .then((pageId) => {
        if (!ownsRoom()) return;
        // A newer intent may still be waiting while this entry remains visible.
        // Never navigate on its behalf; a retry is a fresh, explicit lookup.
        if (!isCurrent() || !pageId) {
          setFailed(true);
          return;
        }
        /* The record's open tab and its natural key's value ride over to the page. */
        const extra = entry as RowEntry & { address?: string };
        go(
          {
            ...entry,
            ...pageView(pageId, entry.table, entry.key, entry.label),
            ...(entry.tab ? { tab: entry.tab } : {}),
            ...(extra.address !== undefined ? { address: extra.address } : {}),
          },
          'replace',
        );
      })
      .catch(() => {
        if (ownsRoom()) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [attempt, entry]);
  return failed ? (
    <div className="panel-pad">
      <p role="alert" className="note">
        {say('recordPageUnavailable')}
      </p>
      <button
        type="button"
        className="ghost"
        onClick={() => {
          if (currentEntry() !== entry || !allowMutationExit()) return;
          beginNavigation();
          setFailed(false);
          retry((value) => value + 1);
        }}
      >
        {say('retryRecordPage')}
      </button>
    </div>
  ) : (
    <p role="status" className="note">
      {say('common.reading')}
    </p>
  );
}
