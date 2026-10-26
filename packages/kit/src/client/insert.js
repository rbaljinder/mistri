/**
 * Adding a row, in a form the schema wrote.
 *
 * Nobody declares a form for this: the columns, their types, what is
 * required and what the database will fill are all in the catalog already.
 * Required is NOT NULL with no default and no auto-assigned key; everything
 * else is optional, and an empty box means "leave it to the database" — its
 * defaults are part of the schema's design and pre-filling them here would
 * turn every default into a value somebody appears to have chosen.
 *
 * Components own field state and feedback. This host owns the connection,
 * request, and navigation for the form's lifetime.
 */
import { ownedBy } from './requestIdentity.js';
import { createElement } from 'react';
import {
  allowMutationExit,
  api,
  columnDisplay,
  columnLabel,
  currentEntry,
  el,
  findTable,
  go,
  humanName,
  openRecord,
  prefersPages,
  rowLabel,
  state,
  toast,
  whenConnectionChanges,
  writeAllowed,
} from './core.js';
// The App through the bridge: appnav.js would pull the page's whole tangle of imports in here (uiBridge.ts).
import { pageBridge } from './uiBridge.js';
import { syncHash } from './url.js';
import { mount, unmount } from './components/mount.js';
import { onDemand } from './components/onDemand.js';
import { InsertRefusal } from './components/useRecordInsert.js';
import { draftSchemaKey } from './recordDrafts.js';
import { shell } from './shellMode.js';
import { countsChanged } from './components/navCounts.js';
import { writeValues } from './resourceRequests.js';
import { captureSessionIdentity, sessionIdentity } from './sessionIdentity.js';
import { say } from './copy/record/insert.js';
import { portalRoot } from './shellHost.js';

/* The form and its field library load when a New is first opened; a reader
   who only reads never fetches them. */
const NewRecordDialog = onDemand(() => import('./components/NewRecord.js'), 'NewRecordDialog', { quiet: true });
const NewRecordDrawer = onDemand(() => import('./components/NewRecord.js'), 'NewRecordDrawer', { quiet: true });

/** Inserts may supply a writable subset even when a complete delete snapshot is unavailable. */
export function canInsert(table, app = false) {
  if ((!app && !state.canWrite) || !table || table.isView || table.insertable === false || !writeAllowed(table.id)) return false;
  return Boolean(state.connections?.find((c) => c.id === state.activeConnection)?.writable);
}

/**
 * The New form as an app shows it: a drawer over the list, addressed by the
 * list's tab slot (`…!new`) so a link can reopen the form (not its unsaved
 * values). A modal hid the list you were on, fought the picker's
 * menu for room, and could not be linked to. The workbench keeps its dialog.
 */
export function openNewRecord(table, form, { reopen = false } = {}) {
  /* The list room drawing an address that says `…!new` again — the App's words
     asked for anew after a language pick or a save (app.js reloadAppInPlace)
     remount it — finds its form already open: that form, half filled, is kept. */
  if (reopen && drawerNow?.table === table.id && drawerNow.connection === state.activeConnection && drawerNow.host.isConnected) {
    /* Drawn again where it stands, so its captions are the App's new words; its draft is the root's state, kept. */
    drawerNow.redraw();
    return;
  }
  if (!allowMutationExit()) return;
  if (!prefersPages()) {
    openInsert(table, form);
    return;
  }
  drawerNow?.close();
  const here = currentEntry();
  const connection = state.activeConnection;
  if (here?.kind === 'table' && here.table === table.id && here.tab !== 'new') {
    here.tab = 'new';
    state.navMode = 'replace';
    syncHash();
  }
  openDrawer(table, form, () => {
    const now = currentEntry();
    if (state.activeConnection === connection && now === here && now?.kind === 'table' && now.table === table.id && now.tab === 'new') {
      now.tab = 'rows';
      state.navMode = 'replace';
      syncHash();
    }
  });
}

/* The frames are components (components/NewRecord.tsx); what stays here is the
   crossing — a host element on the body, taken down when the form is — and
   the navigation the form's outcome drives, which is the page's business. */
let drawerNow = null;

function openDrawer(table, form, onClose, onAdded) {
  drawerNow?.close();
  const host = el('div', { class: 'newpanel-host' });
  portalRoot().append(host);
  const close = hostClose(host, () => {
    if (drawerNow?.host === host) drawerNow = null;
    onClose?.();
  });
  const props = formProps(table, form, host, close, onAdded);
  const redraw = () => mount(host, createElement(NewRecordDrawer, props));
  drawerNow = { host, close, redraw, table: table.id, connection: state.activeConnection };
  redraw();
}

/** Related forms retain their parent's route and existing field draft.
 * A modal supplies a renderer in its own React tree; ordinary pages keep the
 * existing drawer host. Both frames use the same request/authority owner.
 * @param {import('@mistriwork/engine/shared/schema.js').TableMeta} table
 * @param {import('./components/NewRecord.js').FormCuration} form
 * @param {(result: import('./components/NewRecord.js').InsertResult) => void} onAdded
 * @param {{ host: HTMLElement, isCurrent: () => boolean, close: () => void,
 *   render: (props: import('./components/NewRecord.js').NewRecordProps) => void }} [surface]
 */
export function openRelatedRecord(table, form, onAdded, surface) {
  if (!allowMutationExit()) return;
  if (!canInsert(table)) return;
  if (surface) {
    try {
      if (!surface.host.isConnected || surface.isCurrent() !== true) return;
    } catch {
      return;
    }
    surface.render(formProps(table, form, surface.host, surface.close, onAdded, { isCurrent: surface.isCurrent }));
    return;
  }
  openDrawer(table, form, undefined, onAdded);
}

/**
 * @param {*} table
 * @param {{ show?: string[], defaults?: Record<string, unknown> } | undefined} [form]
 *   The app's curation: which columns to ask for — the rest are left to
 *   the database, or filled from `defaults` without being asked — and the
 *   values a box starts with. Absent, the form is the schema's: every column.
 */
export function openInsert(table, form) {
  if (!allowMutationExit()) return;
  const host = el('div', { class: 'insert-host' });
  portalRoot().append(host);
  const close = hostClose(host);
  mount(host, createElement(NewRecordDialog, formProps(table, form, host, close)));
}

/** @param {HTMLElement} host @param {(() => void) | undefined} [onClose] */
function hostClose(host, onClose) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stopWatching();
    unmount(host);
    host.remove();
    onClose?.();
  };
  const stopWatching = whenConnectionChanges(close);
  return close;
}

/** What every frame needs from the page: its words, its schema, its next step.
 * @param {import('@mistriwork/engine/shared/schema.js').TableMeta} table
 * @param {import('./components/NewRecord.js').FormCuration | undefined} form
 * @param {HTMLElement} host A connected element owned by this form instance.
 * @param {() => void} close
 * @param {((result: import('./components/NewRecord.js').InsertResult) => void) | undefined} [onAdded]
 * @param {{ app?: boolean, isCurrent?: () => boolean }} [options]
 * @returns {import('./components/NewRecord.js').NewRecordProps}
 */
export function formProps(table, form, host, close, onAdded, options = {}) {
  const app = options.app ?? prefersPages();
  const schemaKey = draftSchemaKey(table);
  const identity = captureSessionIdentity();
  const connection = state.activeConnection;
  const route = location.href;
  const entry = currentEntry();
  let closed = false;
  const current = () => {
    try {
      return (
        !closed &&
        host.isConnected &&
        identity === sessionIdentity() &&
        identity.mode !== 'locked' &&
        connection === state.activeConnection &&
        route === location.href &&
        entry === currentEntry() &&
        (options.isCurrent === undefined || options.isCurrent() === true)
      );
    } catch {
      return false;
    }
  };
  const finish = () => {
    if (!closed) {
      closed = true;
      close();
    }
  };
  return {
    table,
    form,
    app,
    /* The workbench reads the schema; an app's reader reads a form. */
    label: (column) => {
      if (!app) return column.name;
      return columnLabel(table.id, column.name) ?? humanName(column.name);
    },
    target: (id) => findTable(id),
    /* How the App dresses each column: a vocabulary's words, money's currency. */
    ...(app
      ? {
          display: (column) => columnDisplay(table.id, column.name),
          appName: /** @type {{ name?: string } | null} */ (pageBridge.activeApp())?.name,
        }
      : {}),
    insert: (values, extra) => {
      if (!connection || !current()) throw new InsertRefusal(say('theConnectionOrView'));
      const currentTable = findTable(table.id);
      if (!currentTable || draftSchemaKey(currentTable) !== schemaKey) throw new InsertRefusal(say('theTableDefinitionChangedClose'));
      if (!canInsert(currentTable, app)) throw new InsertRefusal(say('addingRecordsIsNoLonger'));
      let payload;
      try {
        payload = writeValues(values);
      } catch (error) {
        throw new InsertRefusal(error.message);
      }
      /* The record's tags and lines go with it, inserted in its transaction (tagLists.ts, FormLines.tsx). */
      const tags = extra?.tags?.length ? { tags: extra.tags } : {};
      /* Only when there are some: a tenant App's transport sends inert JSON and
         refuses a field that is present but undefined (tenantTransport.ts). */
      const lines = extra?.lines ? { lines: extra.lines } : {};
      return api('/api/insert', { ...ownedBy(connection), table: table.id, values: payload, ...tags, ...lines });
    },
    onCancel: () => {
      if (current() && allowMutationExit()) finish();
    },
    canClose: () => current() && allowMutationExit(),
    onAdded: (result) => {
      if (!current()) return;
      finish();
      // Creation can add an inverse or a non-revertible history barrier. Both
      // must replace the menu's previous editing history before the next Undo.
      void shell().undo.refresh();
      /* A new row changes every count on the connection — the menu's and
         the list tabs'. Asked after the caller's own refresh, so a count
         that caller already started is joined rather than asked twice. */
      if (onAdded) {
        onAdded(result);
        countsChanged(connection);
        return;
      }
      countsChanged(connection);
      const label = result.row ? rowLabel(table, result.row) : Object.values(result.key).join('/');
      /* Undo beside the confirmation, as a field edit has it: this is the
         moment the wrong record is noticed. Undone, the page of a record that
         is gone is no place to stand, so the reader goes back to its list. */
      const created = JSON.stringify(result.key);
      toast(
        say('added', { name: table.name, label }),
        'ok',
        shell().undo.toast(result.undoId, () => {
          countsChanged(connection);
          const now = currentEntry();
          if (now?.table === table.id && JSON.stringify(now.key) === created)
            go({ kind: 'table', table: table.id, query: table.id, tab: 'rows' }, 'reset');
        }),
      );
      /* Straight to the new record: the form's answer is the row the database
         stored — defaults filled, key assigned — and the record page is where
         that answer is legible. */
      void openRecord(table.id, result.key, label);
    },
  };
}
