/**
 * The app manifest, client side: fetched once per connection, read
 * synchronously by whoever draws the shell.
 *
 * App mode is the curated experience: the app's menu, its home, records
 * read through its pages. It has no way into the Workbench: an App serves
 * only its declared resources, and the standalone browser (`mistri <db>`,
 * no App) is the tool for the tables it does not curate.
 *
 * This module loads and registers; `appState.js` holds the data and mode, and
 * appnav.js puts it together with the chrome (appChrome.js) as the App
 * framework's shell. The side list itself stays the kit's
 * (components/Sidebar.tsx), because the App's menu and the tables are one
 * surface drawn from two sources, and splitting the drawing would split the
 * keyboard behaviour with it.
 */
import { setMessageScope } from '@mistriwork/kit/client/messages.js';
import { api, findTable, refsFrom, state } from '@mistriwork/kit/client/core.js';
import { appColumnLabel } from './appLabels.js';
import { activeApp, appLoadError, appSaveMode, inAppMode, setAppCache } from './appState.js';
import { openPeek } from '@mistriwork/kit/client/peekpanel.js';
import { appListFor } from './applist.js';
import { homeRoom, isListRoom, resourceOf } from '@mistriwork/kit/client/components/appRooms.js';
import { appAddress, appStackFrom, listParams, needsNaturalKey, viewEntryFromAddress } from './publicAddress.js';
import { registerIcons } from '@mistriwork/kit/client/components/Icon.js';
import { yesNoRule } from '@mistriwork/kit/client/yesNoRule.js';
import { isFlagColumn } from '@mistriwork/engine/shared/schema.js';
import { connectionGeneration, replaceAppPresentation } from '@mistriwork/kit/client/connectionTransition.js';
import { applyAppTheme, setAppThemeSource } from './appTheme.js';
import { appRequestScope } from '@mistriwork/kit/client/requestIdentity.js';
import { say } from './copy/shell/appNavigation.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { presentList } from './components/presentedList.js';
import { surfaceShell } from './surfaceShell.js';

/**
 * Ask the server which app, if any, this connection is running. Answered
 * from here on by `activeApp()`. A server that cannot say — an old server,
 * a request that failed — is a server with no app: the ordinary sidebar is
 * always a correct fallback, so this never throws past itself.
 */
let loadGeneration = 0;
/** Retire presentation and pending loads before a tenant chooser or session lock. */
export function retireAppNav() {
  ++loadGeneration;
  setAppCache(null);
  replaceAppPresentation();
}
subscribeSessionIdentity(retireAppNav);

export async function loadAppNav() {
  replaceAppPresentation();
  const request = ++loadGeneration;
  const generation = connectionGeneration();
  const connection = state.activeConnection;
  const identity = sessionIdentity();
  const isCurrent = () =>
    request === loadGeneration &&
    generation === connectionGeneration() &&
    connection === state.activeConnection &&
    identity === sessionIdentity() &&
    identity.mode !== 'locked';
  try {
    /** @type {import('../shared/appPayload.js').AppPayload} */
    const res = await api('/api/app');
    if (!isCurrent()) return;
    if (appRequestScope() === true && res.appId !== connection) throw new Error(say('theApplicationResponseBelongs'));
    setAppCache({
      owner: connection ?? '',
      identity,
      app: res.app ?? null,
      loadError: res.loadError,
      loadProblem: res.loadProblem,
      live: res.live === true,
    });
    registerIcons(res.app?.icons);
  } catch {
    if (!isCurrent()) return;
    setAppCache(null);
  }
  await setMessageScope(...messageScope());
  replaceAppPresentation(!!activeApp());
}

/**
 * The chrome's language scope: the App on screen and what the server said
 * about its reader (messages.ts), or the Workbench's own.
 * @returns {[string | undefined, import('@mistriwork/kit/client/messages.js').ServedLanguage | undefined]}
 */
function messageScope() {
  const app = inAppMode() ? activeApp() : undefined;
  return app ? [app.id, { locale: app.ui?.locale, offered: app.ui?.languages }] : [undefined, undefined];
}

/**
 * Ask again after a save (appLive.ts), keeping what is on screen: the same
 * request as `loadAppNav`, but the presentation is replaced only once the
 * answer is in, so nothing between is drawn without an App. Resolves to
 * whether the answer was taken; a failed ask leaves the last answer standing,
 * as the server leaves the last good App.
 * @returns {Promise<boolean>}
 */
export async function reloadAppNav() {
  const request = ++loadGeneration;
  const generation = connectionGeneration();
  const connection = state.activeConnection;
  const identity = sessionIdentity();
  const isCurrent = () =>
    request === loadGeneration &&
    generation === connectionGeneration() &&
    connection === state.activeConnection &&
    identity === sessionIdentity() &&
    identity.mode !== 'locked';
  /** @type {import('../shared/appPayload.js').AppPayload} */
  let res;
  try {
    res = await api('/api/app');
  } catch {
    return false;
  }
  if (!isCurrent() || (appRequestScope() === true && res.appId !== connection)) return false;
  setAppCache({
    owner: connection ?? '',
    identity,
    app: res.app ?? null,
    loadError: res.loadError,
    loadProblem: res.loadProblem,
    live: res.live === true,
  });
  registerIcons(res.app?.icons);
  await setMessageScope(...messageScope());
  replaceAppPresentation(!!activeApp());
  return true;
}

/* The app's words over columns: the resource's caption for a column when it
   gives one, the humanized name otherwise — and for a dotted label path with
   no label of its own, the reference it reads through ("account_id.name" →
   "Account"). */
/** @param {string} tableId @param {string} column @param {string} contextPath */
function columnWords(tableId, column, contextPath) {
  const app = activeApp();
  if (!app) return null;
  return appColumnLabel(app.resources, state.schema, tableId, column, contextPath) || null;
}

/* The app's dress for values, same shape as the words.
   Rules arrive on each resource, keyed by resolved table id, so the plain
   lookup is two property reads, run per cell. A dotted label
   path walks its references first: `customer_id.name` shows a customer's
   name, so it wears `customer.name`'s rule — the value belongs to the
   table it was read from, not the table it is shown on. */
/** @param {string} tableId @param {string} column */
function columnDress(tableId, column) {
  const app = activeApp();
  if (!app) return null;
  /* A yes/no column's rule is keyed as its engine stores it, 1 and 0 beside true and false (valueModel.ts). */
  /** @param {string} table @param {string} name */
  const rule = (table, name) => {
    const display = resourceOf(app, table)?.display;
    const found = display && Object.hasOwn(display, name) ? display[name] : null;
    if (!found) return null;
    const column = findTable(table)?.columns.find((/** @type {{ name: string }} */ c) => c.name === name);
    return isFlagColumn(column) ? yesNoRule(found) : found;
  };
  if (!column.includes('.')) return rule(tableId, column);
  const parts = column.split('.');
  let at = tableId;
  for (const seg of parts.slice(0, -1)) {
    const fk = refsFrom(at).find((f) => f.from.columns.length === 1 && f.from.columns[0] === seg);
    if (!fk) return null;
    at = fk.to.table;
  }
  return rule(at, parts[parts.length - 1]);
}

/* Records read through pages while the app curates the walk: that is what
   makes it an app rather than a browser. Decided per click — with no app,
   nothing changes. */
/* Split views own the selected row beside their list. They deliberately
   route to the row surface instead of jumping through a configured page;
   ordinary app lists retain page affinity. Which view is the one the walk
   is on — by its key when it has one — so a split beside a plain list over
   the same table keeps its detail, and the plain list keeps its pages. */
/** @param {string} [tableId] */
function pageAffinity(tableId) {
  if (!inAppMode()) return false;
  if (!tableId) return true;
  return appListFor(tableId, undefined, state.stack?.at(-1)?.view ?? homeView()).presentation?.kind !== 'split';
}

/* At the App's root the walk is empty and the home list is drawn without an
   entry (Content.tsx), so nothing said which view a pick came from: a split
   inbox served as the home answered as the plain list over its table and
   opened the full record. An empty walk is the home, so the home's key
   stands in. */
function homeView() {
  if (state.stack?.length) return undefined;
  const app = activeApp();
  const home = app ? homeRoom(app) : undefined;
  return home && isListRoom(home) ? home.id : undefined;
}

/** @param {string} tableId */
function writeScope(tableId) {
  const app = inAppMode() ? activeApp() : null;
  if (!app || app.writableTables === undefined) return true;
  return app.writableTables !== false && app.writableTables.includes(tableId);
}

function figures() {
  const app = inAppMode() ? activeApp() : null;
  return app ? { locale: app.ui.locale, currency: app.ui.currency, timezone: app.ui.timezone, clockZone: app.ui.clockZone } : null;
}

/* How a record opens is the view's word: `open: "drawer"` sends the click
   to the drawer — a glance, not a step of the walk. Decided per click by
   the view the walk is actually on (modules included), so two views
   over one table may open two different ways. */
/** @param {string} tableId @param {any} key @param {string} label @param {any} [records] @param {any} [list] */
function openRecord(tableId, key, label, records, list) {
  if (!inAppMode()) return false;
  /* The top of the walk may be the split's own selected row, whose query is
     no clue; the view it was opened from (`view`) still is. */
  const here = state.stack?.at(-1);
  const home = homeView();
  const entry = appListFor(tableId, here?.query, here?.view ?? home);
  if (entry?.presentation?.kind === 'split') {
    /* A pick at the root stands the split's own list under the row, as its
       address does (`/desk/inbox/7`), so the pick opens beside the list
       with the view's keys rather than as the whole record. */
    const under = home && !state.stack.length ? viewEntryFromAddress(home, '') : null;
    return under ? { under } : 'row';
  }
  if (entry?.open !== 'drawer' && entry?.open !== 'modal') return false;
  // A modal must not mount a second draft editor over a routed record. Follow
  // references from that editor as full pages; collections retain modal opening.
  if (entry.open === 'modal' && (here?.kind === 'row' || (here?.kind === 'page' && here.key))) return false;
  openPeek(tableId, key, label, entry.open, records, list);
  return true;
}

/**
 * The App shell's answers to the kit (shellMode.ts), installed by the shell
 * at boot (app.js). Each asks whether an App is on screen, so the same
 * answers serve the Workbench this one shell also draws: with no App,
 * nothing changes.
 * @type {Partial<import('@mistriwork/kit/client/shellMode.js').ShellMode>}
 */
export const appShell = {
  ...surfaceShell,
  app: activeApp,
  inApp: inAppMode,
  loadError: appLoadError,
  saveMode: appSaveMode,
  recordLabel: (tableId) => activeApp()?.resources?.[tableId]?.recordLabel,
  label: columnWords,
  display: columnDress,
  emptyWord: () => (inAppMode() ? '—' : 'null'),
  format: figures,
  writeScope,
  pageAffinity,
  openRecord,
  /* Space on a row glances at its record whatever the App's `open` word says:
     a glance is read-only and leaves the list where it is (peekpanel.js). */
  peekRecord: (tableId, key, label, records, list) =>
    openPeek(tableId, key, label, 'drawer', /** @type {any} */ (records), /** @type {any} */ (list)),
  addresses: { address: appAddress, stackFrom: appStackFrom, listParams, viewEntry: viewEntryFromAddress, needsNaturalKey },
  present: presentList,
  /* The sign-in a public visitor is offered where a list is a member's (TableRoom.tsx), drawn in place: the public
     surface's part, loaded the first time it is asked for. */
  signInHere: (appId) => void import('./publicSurface.js').then((surface) => surface.signInHere(appId)),
};

/* The app's colours live in appTheme.js, which a page drawn before any App
   is loaded — a sign-in, a public form — wears too; its default dress is
   the active App's, answered from here. */
setAppThemeSource(activeApp);
export { applyAppTheme };
