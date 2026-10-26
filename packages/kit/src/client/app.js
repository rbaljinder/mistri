/**
 * The kit's shell: the walk, the content pane, the address, the menu, the
 * palette and the keys every page shares, and dispatch to a view. It names
 * neither product: a product's main (appShell.js, workbenchShell.js) calls
 * `boot` with its chrome and, for the Workbench, its tools — the kit's shell
 * API, shells.ts.
 *
 * Loaded by a main once who-am-I has said this page is an App or a database
 * to browse, rather than a public page (publicSurface.js) — so a sign-in
 * screen or a public form never downloads it. Its first paint is this chunk
 * and the entry, fetched together (the server names both in the page): the
 * App framework's chrome (appnav.js) rides in the same chunk, and the
 * Workbench's page names the Workbench's chunk beside them.
 *
 * Everything here is wiring. The views live in their own files and reach the
 * shared state through core.js.
 */
import { createElement } from 'react';
import { mount, queryClient, unmount, unmountAll } from './components/mount.js';
import { requireTenantSelection, sessionIdentity, tenantLeaseActive } from './sessionIdentity.js';
import { configureSessionLifecycle, invalidateSession, startSessionMonitoring } from './sessionLifecycle.js';
import { Content, holdHome, homeIsHeld, noticeOnContent, setKnownPages } from './components/Content.js';
import { setListNavigation } from './components/listNavigation.js';
import { viewLink } from './components/viewLink.js';
import { Sidebar, moveSidebar, openSidebarChoice } from './components/Sidebar.js';
import { setSidebarFilter } from './components/sidebarModel.js';
import {
  $,
  allowMutationExit,
  api,
  backTo,
  connectionChanged,
  currentEntry,
  el,
  findTable,
  go,
  invalidateNavigation,
  pageView,
  render,
  setPaintHold,
  state,
  toast,
} from './core.js';
import { afterPaint, beforePaint, installNavigationHold } from './navigationHold.js';
import { setStartupProbe } from './startupHold.js';
import { initWriteMode, prepareEditingExit } from './write.js';
import { bootstrapRequestIdentity, initConnections, refreshConnections, syncConnectionControls } from './connectionList.js';
import { RuntimeMetadataError, UnknownAppError } from './requestIdentity.js';
import { beginConnectionTransition } from './connectionTransition.js';
import { initTour } from './tour.js';
import { canManageConnections, canUseDatabaseTools } from './connectionScope.js';
import { effectiveTheme, themeLabel, toggleTheme } from './theme.js';
import { finishStartup } from './startup.js';
import { allowSync, applyHash, connectionFromHash, readAddress, resolveLabels, syncHash, toHash, whileApplying } from './url.js';
import { initMenu, addMenuItem, setMenuGroup, setMenuMode } from './menu.js';
import { ask } from './prompt.js';
import { onDemand } from './components/onDemand.js';
import { forgetPages, pagesFor, prefetchPages, recordPageId, whenPagesChange } from './page.js';
import { listenForRecordPresses, prefetchRecordPage } from './recordPress.js';
import { installShell, shell } from './shellMode.js';
import { onLanguagePicked, subscribeMessages } from './messages.js';
import { applyDensity } from './density.js';
import { applyTypography } from './typography.js';
import { openPrefs } from './prefs.js';
import { loadTemplates } from './template.js';
import { initPeek } from './peek.js';
import { initPalette, initSidebarToggle, openPalette } from './palette.js';
import { registerSurface } from './surfaces.js';
import { OverflowMenu } from './components/OverflowMenu.js';
/* Imported for its side effect: composerEntry.js attaches the composer's
   entry point, the way history.js does, and loads the composer when a view
   opens. Loading it from a stylesheet's onload worked, but a script that
   runs because a CSS file finished downloading is a dependency nobody would
   guess from reading either file. */
import './composerEntry.js';
import { say } from './copy/shell/app.js';
import { arrivedPlacement, herePath, hereSearch, shown, shownUnplaced } from './addressMount.js';
import { addHostListener, navReplace, navState, onNavigate, setTabTitle, shellBody, shellQuery, shellQueryAll } from './shellHost.js';
/* The product this page runs, installed by its main (`boot`): its chrome,
   and the Workbench's tools where it is the Workbench. */
/** @type {import('./shells.js').ShellChrome} */
let chrome = /** @type {any} */ (null);
/** @type {import('./shells.js').ShellTools | undefined} */
let offeredTools;

/* The tools once started, for the brand pass and the menu's places; null
   before the Workbench's first paint, and always in an App. */
/** @type {import('./shells.js').ShellTools | null} */
let tools = null;
function startTools() {
  if (offeredTools && !tools) {
    tools = offeredTools;
    offeredTools.start(kit);
  }
}

/**
 * What the page says when no connection opened: the Workbench's welcome, with
 * what is listed, where it manages connections; anywhere else the product's
 * own screen — no App by the name asked for, or why it is not served
 * (appUnavailable.js).
 * @param {any[]} listed
 * @param {UnknownAppError} [unknown]
 * @param {string} [unavailable]
 */
function showUnopened(listed, unknown = undefined, unavailable = undefined) {
  if (unknown || !canManageConnections() || !offeredTools) chrome.unavailable(unknown, unavailable);
  else offeredTools.showWelcome(listed);
}

/* React list surfaces may be mounted outside Content (for example in a record
   dialog), so the shell supplies their one navigation capability at boot. */
setListNavigation(viewLink);

registerSurface('overflowMenu', OverflowMenu);
/* The palette is drawn the first time ⌘K or Search asks for it; it arrives whole (palette.js awaits it). */
registerSurface(
  'palette',
  onDemand(() => import('./components/Palette.js'), 'Palette', { quiet: true }),
);
registerSurface(
  'composer',
  onDemand(() => import('./components/Composer.js'), 'Composer'),
);
/* Authoring dialogs, loaded the first time one opens: most readers never do. */
const ThemeLab = onDemand(() => import('./components/ThemeLab.js'), 'ThemeLab', { quiet: true });
/* ---------- dispatch ---------- */

/**
 * Back to the schema, from anywhere.
 *
 * At module scope because the trail needs it as well as the wordmark — see
 * the root crumb in `breadcrumb`.
 */
function goHome() {
  if (!allowMutationExit()) return;
  invalidateNavigation();
  state.stack = [];
  state.page = 0;
  $('query').value = '';
  render();
}

function showWorkspaceOpening() {
  const status = el('p', { class: 'workspace-opening', role: 'status' });
  $('content').replaceChildren(status);
  // Mount the live region before its words; never retain the previous tenant's content.
  requestAnimationFrame(() => {
    if (status.isConnected) status.textContent = say('openingWorkspace');
  });
}

async function clearSurface(me) {
  chrome.retire?.(me);
  chrome.navigationReady?.(false);
  shellBody().classList.add('tenant-pending');
  $('content').hidden = true;
  beginConnectionTransition();
  invalidateNavigation();
  state.schema = null;
  state.stack = [];
  state.canWrite = false;
  state.page = 0;
  $('query').value = '';
  $('table-filter').value = '';
  unmountAll(shellQuery('.account-host'));
  forgetPages();
  setKnownPages([]);
  // mount.tsx defers root disposal so React can remove its portals itself.
  await Promise.resolve();
  shellQueryAll('.tenant-control-host').forEach((host) => host.remove());
  $('errors').replaceChildren();
  $('errors').hidden = true;
  $('explain').textContent = '';
  $('explain-pane').hidden = true;
  $('toast').replaceChildren();
  $('toast').hidden = true;
  showWorkspaceOpening();
  $('content').hidden = false;
  navReplace(shown(`/${encodeURIComponent(state.activeConnection)}`));
  await chrome.showAccount?.(me, kit);
}

async function rebuildSurface(me) {
  const owner = sessionIdentity(),
    transition = beginConnectionTransition();
  try {
    // The new context's schema, runtime, App and pages together, as at start.
    const appLoaded = chrome.loadNav();
    prefetchPages();
    const [schema] = await Promise.all([api('/api/schema'), refreshConnections()]);
    if (sessionIdentity() !== owner) return;
    state.schema = schema;
    await Promise.all([loadTemplates(), tools?.loadStores(), appLoaded]);
    if (sessionIdentity() !== owner) return;
    unmount($('content'));
    await Promise.resolve();
    if (sessionIdentity() !== owner) return;
    $('content').replaceChildren();
    // A tenant switch goes home on purpose (goHome below), so nothing is held.
    holdHome(false);
    mount($('content'), createElement(Content, { onHome: goHome }));
    shellBody().classList.remove('tenant-pending');
    initMenu();
    applyBrand();
    renderTableList();
    initWriteMode();
    void chrome.loadFilters?.();
    void registerPages();
    connectionChanged();
    goHome();
    chrome.navigationReady?.(true);
    await chrome.showAccount?.(me, kit);
  } finally {
    transition.finish();
  }
}

/* What the shells call back into (shells.ts `KitShell`). */
let businessRetired = false;
/** @type {import('./shells.js').KitShell} */
const kit = {
  goHome,
  showWorkspaceOpening,
  clearSurface,
  rebuildSurface,
  retired: () => businessRetired,
  retire: () => {
    businessRetired = true;
  },
};

/* Which row paint is current, for the one branch that answers asynchronously. */
let rowPaint = 0;

/* ---------- sidebar ---------- */

/**
 * Move focus into the panel beside the list.
 *
 * The first thing worth landing on rather than the first focusable thing:
 * a column header or a row, not the breadcrumb you just came through. If the
 * panel has nothing to focus, the container itself takes it, so the keyboard
 * is at least on the right side of the page.
 */
function focusContent() {
  const content = $('content');
  const target = content.querySelector('tbody tr, .th-sort, .related-item, .field-group-head') ?? content;
  if (target === content) content.tabIndex = -1;
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: 'nearest' });
}

function renderTableList(filterText = '') {
  const list = $('table-list');
  const appMode = shell().inApp();
  const filterInput = $('table-filter');
  const filterLabel = appMode ? say('filterMenu') : say('filterTables');
  filterInput.placeholder = `${filterLabel}\u2026`;
  filterInput.setAttribute('aria-label', filterLabel);
  list.closest('nav')?.setAttribute('aria-label', appMode ? say('appMenu') : say('common.tables2'));
  $('topnav').setAttribute('aria-label', say('appMenu'));
  /* The product decides where its menu stands (an App's appChrome.js): the
     side list, a strip under the header, or a phone's drawer. */
  const sideList = chrome.menu();
  /* The list is a component (components/Sidebar.tsx) drawn into the `ul`; the
     filter text and the keyboard's cursor are its store. Drawn again on
     every call rather than left to redraw itself, because the app, the
     mode and the schema are read at draw time and the callers here are
     the places that know they changed. */
  setSidebarFilter(filterText);
  if (!sideList) {
    unmount(list);
    return;
  }
  mount(list, createElement(Sidebar, { host: list }));
}

/**
 * The shell's own words that the page's HTML or a one-time pass wrote: the
 * skip link, the wordmark's title, a visitor's Sign in. Said again whenever
 * the language changes, since a visitor's language arrives with the App's
 * payload — after the shell has drawn — and a reader may pick another.
 */
function sayShellWords() {
  const skip = shellQuery('.skip-link');
  if (skip) skip.textContent = say('skipToContent');
  const app = shell().inApp() ? shell().app() : undefined;
  $('home-button')?.setAttribute('title', app ? say('brandHome', { app: app.name }) : say('backToTheSchema'));
  const signIn = shellQuery('.account-sign-in');
  if (signIn) signIn.textContent = say('common.signIn');
}
subscribeMessages(sayShellWords);

/**
 * The shell answers to the app when one is running: the brand in the top bar
 * and the tab's title carry its name, and hand back to tablewalk when the
 * connection has no app.
 */
function applyBrand() {
  const app = shell().app();
  const inApp = shell().inApp();
  const brand = shellQuery('.brand-name');
  if (brand) brand.textContent = app ? app.name : 'tablewalk';
  sayShellWords();
  setTabTitle(say('common.documentTitle', { title: app ? app.name : state.schema.label }));
  chrome.brand();
  /* The class is the seam the stylesheet hides explorer chrome behind, the
     way `first-run` already does. The app's colours ride the same switch. */
  shellBody().classList.toggle('app-mode', inApp);
  shellBody().classList.toggle('app-bound', !canManageConnections());
  $('sql-toggle').hidden = !canUseDatabaseTools();
  $('search-button').classList.toggle('tn-search', inApp);
  syncConnectionControls();
  setMenuMode(inApp ? 'app' : 'workbench');
  tools?.brand();
  chrome.dress();
  setMenuGroup(
    say('authoring'),
    app ? [] : [{ label: say('themeLab'), category: say('authoring'), onSelect: () => void ask(ThemeLab, {}) }],
  );
  setMenuGroup(say('appSettings'), chrome.settings?.() ?? []);
  /* The reader's own settings — density, list sizes — live in one dialog,
     reachable from here and from ⌘K, and apply the moment they change.
     Density itself is applied on every brand pass so a fresh boot honours
     the stored choice before anyone opens anything. */
  applyDensity();
  applyTypography();
  setMenuGroup(say('viewMenu'), [
    {
      label: () => say('preferences'),
      category: () => say('preferences.title'),
      detail: () => say('appearanceAndListSettings'),
      onSelect: openPrefs,
    },
  ]);
}

/**
 * Every page this connection has, as one command each.
 *
 * Registered rather than given a nav item: a database with one page does not
 * deserve a permanent tab, and one with nine cannot fit them. `addMenuItem`
 * puts each in the overflow menu and in ⌘K from a single registration, which
 * is where someone looks for "the customer page" anyway.
 */
let pagesRegistration = 0;
async function registerPages() {
  const registration = ++pagesRegistration;
  const connection = state.activeConnection;
  const schema = state.schema;
  const isCurrent = () => registration === pagesRegistration && connection === state.activeConnection && schema === state.schema;
  setKnownPages([]);
  setMenuGroup(say('pages'), []);
  try {
    /* `onSelect` and `detail`, which is what the registry reads. It had been
       `run` and `hint` — names nothing on the other side of this call knows —
       so every page in ⌘K and in the overflow menu threw on click and did
       nothing visible. The one command group built from data was the one
       group nobody could use. */
    const pages = await pagesFor();
    if (!isCurrent()) return;
    setKnownPages(pages.filter((p) => !p.error));
    /* The home screen is drawn before this arrives — it is the first paint —
       so it is drawn again once the pages are known. Only there: anywhere
       else the reader is looking at something, and redrawing it under them
       to add a list they cannot see is worse than the wait. */
    if (!currentEntry()) render();
    setMenuGroup(
      say('pages'),
      pages.map((page) => ({
        scope: 'workbench',
        category: say('pages'),
        label: page.name,
        detail: page.error ? page.error : say('one', { base: page.base }),
        onSelect: () => {
          if (!isCurrent()) return;
          if (page.error) {
            toast(page.error, 'error');
            return;
          }
          go(pageView(page.id, page.base), 'reset');
        },
      })),
    );
  } catch {
    /* A connection whose pages cannot be read is a connection with no pages
       in the menu. It is not a reason to stop starting up. */
  }
}

/* ---------- a save, followed ---------- */

/**
 * The App again after a save (appLive.ts), drawn where the reader stands.
 * The walk is kept, so the address, the open record and the trail are, and
 * the pane keeps its scroll (a paint of the same entry, navigationHold.ts).
 * The room itself is drawn again rather than kept: a record's surface is
 * fenced to the App it opened under (recordSurface.ts), because its grants
 * and actions were that App's, so its unsent edits go with it. A save that
 * changed which App this is, or left none, is a different page: that one is
 * loaded whole.
 */
async function reloadAppInPlace() {
  const before = shell().app();
  if (!(await chrome.reloadNav?.())) return;
  const after = shell().app();
  if (!before || !after || before.id !== after.id) {
    window.location.reload();
    return;
  }
  // The App's pages are its own; the menu is rebuilt from them (whenPagesChange).
  forgetPages();
  void queryClient.invalidateQueries();
  applyBrand();
  renderTableList($('table-filter').value);
  state.navMode = 'replace';
  render();
}

/* Only where the server says it watches the App's source (appChrome.js). */
const followSaves = () => chrome.followSaves?.(reloadAppInPlace);

/* ---------- boot ---------- */

/**
 * Switch connection, then rebuild the trail from the link.
 *
 * The order is the point: the hash is parsed only after the new schema has
 * arrived, because a trail into another database names tables this one does
 * not have and would parse to nothing.
 */
async function switchAndRestore(id, hash) {
  const transition = beginConnectionTransition();
  try {
    const schema = canManageConnections()
      ? (await api('/api/connections/select', { id })).schema
      : await api(`/api/schema?app=${encodeURIComponent(id)}`);
    if (!transition.isCurrent()) return;
    state.schema = schema;
    state.activeConnection = id;
    /* The picker names this tab's connection, not the server's idea of an
       active one. A link into one database with the sidebar naming another is
       the interface disagreeing with itself about where you are — and now
       that every request carries its own connection, the server's active is
       not this tab's answer to anything. */
    void refreshConnections();
    /* Layouts, saved pages, SQL and the app manifest are stored per
       connection, so the new connection's are pulled before anything is
       drawn with them — and before the menu is rebuilt, which reads the
       saved-pages mirror. In parallel: four independent round trips in a
       row was a whole extra beat of sidebar-blank per deep link. */
    await Promise.all([loadTemplates(), tools?.loadStores(), chrome.loadNav()]);
    if (!transition.isCurrent()) return;
    // Un-awaited on purpose: a warm cache, not a gate on first paint.
    void chrome.loadFilters?.();
    // A different database has different pages.
    void registerPages();
    /* Same signal the picker sends, so a deep link into another database
       rebuilds the long-lived surfaces the way a switch does. */
    connectionChanged();
    renderTableList();
    /* A list said in words (`/thread/board?tab=…`) is read against the
       App just loaded, as applyHash reads one on the connection already open. */
    const parsed = readAddress(hash, (t) => findTable(t) ?? state.schema.tables.find((x) => x.name === t));
    holdHome(false);
    whileApplying(() => {
      state.stack = parsed?.stack ?? [];
      state.page = 0;
      state.navMode = 'replace';
      render();
    });
    /* Written explicitly, after the suppressed render. Boot renders once
       before the link is applied and stamps the *previous* connection into
       the address bar; without this the URL keeps claiming a database the
       page is no longer showing, and copying it hands someone the wrong
       link. */
    /* Open the address gate here, not in boot: on a cold deep link into
       another database the boot deliberately left it shut so that no render
       between then and now could stamp the outgoing connection into the bar.
       Now the target is loaded and current, so its address is the right one
       to write. Idempotent for the picker/popstate callers, where it is
       already open. */
    allowSync();
    state.navMode = 'replace';
    syncHash();
    $('db-label').textContent = `${schema.label} · ${schema.dialect}`;
    applyBrand();
    followSaves();
    if (parsed?.stack.length) void resolveLabels(parsed.stack, (t) => findTable(t));
  } catch (err) {
    if (!transition.isCurrent()) return;
    // Finish loading whichever schema remains after a failed overlapping switch.
    await state.onSwitched?.(transition.isCurrent);
    if (!transition.isCurrent()) return;
    connectionChanged();
    /* A dead end otherwise.
    
       A bookmarked link naming a connection that has since been removed used
       to render this message and stop, on a page whose only way forward was
       editing the URL by hand — while the database the session *is* connected
       to sat there, loaded and unreachable. The fallback is made out loud
       instead: say which link failed, then show the connection we do have.
       Silently substituting it would be the other error, and the worse one. */
    const said = el('p', {
      class: 'note',
      text: say('showingInstead', { message: err.message, label: state.schema?.label ?? say('theCurrentDatabase') }),
    });
    if (!state.schema) {
      $('content').replaceChildren(said);
      return;
    }
    state.stack = [];
    state.page = 0;
    holdHome(false);
    allowSync();
    state.navMode = 'replace';
    render();
    syncHash();
    // Above the landing page rather than instead of it: the reason and the
    // way forward want to be on screen together.
    noticeOnContent(said.textContent);
  } finally {
    transition.finish();
  }
}

/**
 * The rest of boot, from who-am-I's answer, for the product whose main
 * asked it (shells.ts `ShellProduct`): that main drew whatever its product
 * shows before the shell (an App's public pages, its sign-in).
 * @param {Record<string, any>} me
 * @param {unknown} landingAt where the address landed (publicRoutes.js `landingRoute`), which the App's chrome reads
 * @param {import('./shells.js').ShellProduct} installed
 */
export async function boot(me, landingAt, installed) {
  chrome = installed.chrome;
  offeredTools = installed.tools;
  /* The shell's answers to the kit (shellMode.ts), named before anything
     asks: the product's (an App's words, openers and tenant, appnav.js; the
     Workbench's glance), and the walk's page resolver and read-ahead. The
     Workbench's tools name their own Undo when they start (workbench.js). */
  installShell({
    ...chrome.answers,
    resolvePage: recordPageId,
    prefetchRecord: prefetchRecordPage,
  });
  chrome.start?.(me);
  await chrome.loadTenancy?.(me);
  configureSessionLifecycle({
    onReload: () => window.location.reload(),
    ...chrome.lifecycle?.(me, kit),
    onLock: (reason) => {
      chrome.retire?.(me);
      beginConnectionTransition();
      invalidateNavigation();
      state.schema = null;
      state.stack = [];
      state.canWrite = false;
      state.activeConnection = null;
      state.connections = [];
      unmountAll();
      shellBody().classList.add('session-locked', 'signed-out');
      const titles = {
        expired: say('sessionExpired'),
        'signed-out': say('signedOut'),
        'account-changed': say('accountChanged'),
        'other-tab': say('accountChanged'),
        unavailable: say('sessionUnavailable'),
      };
      const reload = el('button', { type: 'button', text: say('common.reload'), onclick: () => window.location.reload() });
      const lock = el(
        'section',
        { id: 'session-lock', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'session-lock-title' },
        [el('h1', { id: 'session-lock-title', text: titles[reason] }), el('p', { text: say('reloadToVerifyYourSession') }), reload],
      );
      for (const child of shellBody().children) child.setAttribute('inert', '');
      shellBody().append(lock);
      // React must remove its portals before their DOM parents disappear.
      queueMicrotask(() => {
        for (const child of [...shellBody().children]) if (child !== lock) child.remove();
      });
      finishStartup();
      reload.focus();
    },
  });
  addHostListener(
    document,
    'keydown',
    (event) => {
      if (sessionIdentity().mode === 'locked') event.stopImmediatePropagation();
      else if (sessionIdentity().tenant && !tenantLeaseActive()) event.stopImmediatePropagation();
      else if (
        sessionIdentity().tenantRequired &&
        !sessionIdentity().tenant &&
        !(event.target instanceof Element && event.target.closest('.tenant-chooser, .account-host, [role="dialog"], [role="menu"]'))
      )
        event.stopImmediatePropagation();
    },
    true,
  );
  /* Captured before anything can render. The first paint calls syncHash and
     would otherwise overwrite the incoming link with the empty state — the
     deep link would be destroyed a few milliseconds before being read. */
  /* The path: the app routes by path, and a fragment is not an address. */
  /* Read in the inside form (addressMount.js): the App's id first, whatever
     the bar says of its mount and the base path. */
  let incoming = herePath();
  let incomingLocation = herePath() + hereSearch() + window.location.hash;
  let tenantIncoming;

  const requestedApp = connectionFromHash(incoming);
  if (me.signedIn) startSessionMonitoring();
  const signedInStart = chrome.signedInStart?.(me, landingAt) ?? null;
  if (signedInStart) {
    incoming = signedInStart;
    incomingLocation = incoming;
    navReplace(shown(incoming));
  }
  if (me.tenant === true) {
    /* The tenant chooser comes first, in the App's look (appChrome.js). */
    const chosen = (await chrome.chooseTenant?.(me, requestedApp, incomingLocation, kit)) ?? null;
    if (!chosen) return;
    ({ incoming, tenantIncoming } = chosen);
  }
  try {
    await bootstrapRequestIdentity(connectionFromHash(incoming));
    if (businessRetired) return;
    if (me.signedIn && state.activeConnection !== me.appId) {
      invalidateSession('account-changed');
      return;
    }
  } catch (err) {
    if (businessRetired || sessionIdentity().mode === 'locked') return;
    if (err.status === 401 && err.signIn) return;
    if (err instanceof RuntimeMetadataError) throw err;
    /* A tenant's public address that names no tenant: one 404, which says
       nothing of any tenant, and a sentence that blames no database. */
    if (err.status === 404 && !me.signedIn && arrivedPlacement()) {
      // In the App's own look and under its name, as the tenant chooser is: never the database browser's.
      chrome.wearLook?.(me, me.look ?? me.signIn?.look);
      chrome.noWorkspace?.(
        typeof me.appName === 'string' ? me.appName : me.appId,
        shownUnplaced(`/${encodeURIComponent(me.appId)}/sign-in`),
      );
      return;
    }
    // Offline metadata cannot authorize the database browser's setup wizard.
    /* A server that is up and says why it is not serving the App — reloading
       it, or waiting for a restart — is not a database it could not reach. */
    showUnopened(
      [],
      err instanceof UnknownAppError ? err : undefined,
      err.status === 503 && typeof err.message === 'string' && err.message ? err.message : undefined,
    );
    return;
  }
  /* The schema, the App and its pages depend on the connection the runtime
     just named, not on each other: asked together, rather than each after the
     last answer. The App's load never throws; the pages are adopted by the
     page cache when it is first asked (page.js). */
  const appLoaded = chrome.loadNav();
  prefetchPages();
  try {
    state.schema = await api('/api/schema');
    if (businessRetired) {
      state.schema = null;
      return;
    }
  } catch (err) {
    if (businessRetired || sessionIdentity().mode === 'locked') return;
    /* A 409 here means there is no connection to read a schema *from*, which
       is a screen rather than an error — and its message, "No connection is
       open.", is true, unhelpful, and the last thing a first-time reader
       should meet.
    
       Asked this way round rather than by checking the connection list first,
       which is what this did: that put a second request in front of every
       ordinary load to answer a question only the empty case ever asks. The
       failure already carries the answer. */
    if (err.status === 401 && err.signIn) return;
    if (err.status === 409) {
      /* Unconditionally, and with whatever is listed. A 409 here means no
         connection is *open* — which covers both an empty server and one
         whose only connection failed to open. The second used to fall
         through to "Could not read the schema: No connection is open.",
         a true sentence with nothing to click. */
      showUnopened((await offeredTools?.listConnections()) ?? []);
      return;
    }
    $('content').replaceChildren(el('p', { class: 'note', text: say('couldNotReadTheSchema', { message: err.message }) }));
    return;
  }
  const content = $('content');
  /* The ··· menu's button, before anything looks for it — the app-issues
     badge sits beside it. Its commands register below and are read when it
     opens. */
  initMenu();
  $('db-label').textContent = `${state.schema.label} · ${state.schema.dialect}`;
  await appLoaded;
  if (businessRetired || sessionIdentity().mode === 'locked') return;
  /* The Workbench's tools are started before it paints. */
  startTools();
  /* The content pane is one component tree from here on, driven by the
     walk (components/Content.tsx): every render() is a paint of it. Mounted only
     once the schema is known, because the landing reads it — and once the App
     is, as rebuildTenantSurface mounts it. A first paint that had not yet heard
     of the App drew the Workbench's landing behind the startup veil, and so
     fetched the schema diagram's chunk for a reader who would never see it. */
  content.replaceChildren();
  /* Held before the tree mounts: from here to applying the address, every
     await is a chance for React to commit an empty walk as home (Content.tsx
     holdHome). A bare `/{app}` is held too, and drawn by the same paint. */
  holdHome(Boolean(connectionFromHash(incoming)));
  /* A paint that starts the room over keeps the screen it leaves until the
     new room is complete (navigationHold.ts). The walk's top entry says
     whether it is a step to a new place, which starts at the top. */
  const reads = {
    busy: () => queryClient.isFetching() > 0,
    watch: (changed) => queryClient.getQueryCache().subscribe(changed),
  };
  installNavigationHold(content, reads);
  /* And the first page is revealed complete the same way (startupHold.ts). */
  setStartupProbe(reads);
  /* An App's list keeps its room through a refinement now, as the Workbench's
     table does (Content.tsx), so only a room started over is held. */
  setPaintHold({
    before: (roomChanged) => beforePaint(roomChanged, currentEntry(), state.stack.length),
    after: () => afterPaint(currentEntry(), state.stack.length),
  });
  /* A press on a record begins reading its page, so the hold is short (recordCompose.ts). */
  listenForRecordPresses();
  mount(content, createElement(Content, { onHome: goHome }));
  shellBody().classList.remove('tenant-pending');
  applyBrand();
  void chrome.showAccount?.(me, kit);
  renderTableList();
  initWriteMode();
  tools?.menu('editing');
  initPalette();
  initPeek();
  /* Registered here rather than on a connection switch, which is where it
     used to be — so on an ordinary boot nothing was listening, and a page
     built in the builder did not appear in the menu or in ⌘K until the tab
     was reloaded. The one place that runs on every start is this one. */
  whenPagesChange(() => void registerPages());
  initSidebarToggle();
  // Only remount navigation on a breakpoint crossing; record editors keep their owner.
  chrome.compactNavigation?.addEventListener('change', () => {
    if (!businessRetired && sessionIdentity().mode !== 'locked') renderTableList($('table-filter').value);
  });
  // The theme bench moved the menu (themeBench.ts): the shell is drawn again around the same room.
  chrome.whenMenuMoves?.(() => {
    if (!businessRetired && sessionIdentity().mode !== 'locked') renderTableList($('table-filter').value);
  });
  /* The SQL pane and the Workbench's Undo, whose menu names the last edit at once; an App has neither. */
  tools?.menu('sql');
  /* Connections first, then the per-connection stores, then the first
     render. The stores are keyed by connection id, and loading them before
     `initConnections` has named one filed everything under a connection
     called nothing — templates got away with it because every browser that
     saved one also mirrored it locally under the right key; the pages file
     restore was the first reader with no local copy to fall back on. */
  await initConnections(async (isCurrent = () => true) => {
    /* The picker's switch is a full arrival in another database: its
       per-connection stores, its app (or none), its dress. Without this
       the previous connection's app-mode chrome and theme survived the
       switch — a database with no app wearing another app's clothes. */
    await Promise.all([loadTemplates(), tools?.loadStores(), chrome.loadNav()]);
    if (!isCurrent() || businessRetired || sessionIdentity().mode === 'locked') return;
    void chrome.loadFilters?.();
    void registerPages();
    applyBrand();
    renderTableList($('table-filter').value);
    followSaves();
  });
  if (businessRetired) return;
  await Promise.all([loadTemplates(), tools?.loadStores()]);
  if (businessRetired || sessionIdentity().mode === 'locked') return;
  // Un-awaited on purpose: a warm cache, not a gate on first paint.
  void chrome.loadFilters?.();
  /* After the saved-pages mirror is filled, or the menu and ⌘K are built
     from an empty list and a page restored from the file is invisible until
     something else rebuilds them. */
  void registerPages();

  /* A link present on load wins over the default view: someone arriving from
     a pasted link should land where the link points, not on the schema.

     The empty state is painted only when there is no link to honour. It used
     to be painted unconditionally, first, which meant a deep link spent a
     moment showing the *active* connection's landing page — and that paint
     wrote its own address into the bar over the link that had not been read
     yet. `allowSync` keeps the bar shut until this is done either way. */
  const linked = Boolean(connectionFromHash(incoming));
  if (!linked) render();

  let restoring;
  /* With its search: a public list's address says its question there. */
  const restored = applyHash(tenantIncoming ?? incoming + hereSearch(), {
    findTableById: (id) => findTable(id) ?? state.schema.tables.find((t) => t.name === id),
    selectConnection: (connection, path) => {
      restoring = switchAndRestore(connection, path);
      return restoring;
    },
  });
  /* `'switching'` means applyHash handed off to an async connection switch.
     That switch owns *both* the render and opening the address gate
     (`switchAndRestore` calls `allowSync`), so the boot does neither here.
     Opening the gate now would let any render that lands mid-switch — a
     pages-change rebuild is the one that bit — write the OUTGOING connection
     into the bar for a frame, which is the cold-tab `/demo` leak. */
  if (restored !== 'switching') {
    holdHome(false);
    allowSync();
    if (restored || linked) render();
  }
  if (restoring) await restoring;
  if (businessRetired || sessionIdentity().mode === 'locked') return;
  /* A switch another one overtook never applied this address; whatever it
     led to is where the reader is, so the hold ends with boot regardless. */
  if (restoring && homeIsHeld()) {
    holdHome(false);
    render();
  }

  /* Last, and after the first render: every stop measures an element that has
     to exist, and the menu item it registers should sit below the ones the
     features added rather than above them. */
  initTour();
  followSaves();
  /* A reader's language pick, where the server says the App's words: asked again in their words, where they stand. */
  onLanguagePicked(() => void reloadAppInPlace());

  /* The skip link lands on the pane itself, not a row in it: Tab goes on
     from the top of the room. Its fragment is not followed, because a
     fragment navigation fires `popstate` below. */
  shellQuery('.skip-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    const content = $('content');
    content.tabIndex = -1;
    content.focus({ preventScroll: true });
    content.scrollIntoView?.({ block: 'start' });
  });

  /* `popstate`, because the address is written with pushState and a path:
     Back and Forward fire this, and a hash listener would never hear them
     again. */
  onNavigate(() => {
    if (businessRetired || sessionIdentity().mode === 'locked') return;
    if (!allowMutationExit()) {
      navReplace(shown(toHash()));
      return;
    }
    if (sessionIdentity().tenantRequired) {
      chrome.followHistory?.(herePath() + hereSearch() + window.location.hash, {
        currentHref: toHash,
        replace: (href) => navReplace(shown(href)),
        /* The walk rides in history state (url.js); the address is the one thing on screen. */
        apply: (href) => {
          const trail = navState()?.trail;
          applyHash(typeof trail === 'string' ? trail : href, {
            findTableById: (id) => findTable(id),
            selectConnection: switchAndRestore,
            walk: typeof trail === 'string',
          });
        },
        canLeave: async () => {
          if (!allowMutationExit()) return false;
          return prepareEditingExit();
        },
        reload: () => window.location.reload(),
        invalid: () => {
          toast(say('thisTenantLinkIsInvalid'), 'error');
        },
      });
      return;
    }
    /* An App's address is the one thing on screen; the walk that reached it
       rides in history state (url.js), so Back returns to the list and its
       crumbs, not to a page that forgot where it came from. */
    const trail = navState()?.trail;
    applyHash(typeof trail === 'string' ? trail : herePath() + hereSearch(), {
      findTableById: (id) => findTable(id) ?? state.schema.tables.find((t) => t.name === id),
      selectConnection: switchAndRestore,
      walk: typeof trail === 'string',
    });
  });
  chrome.navigationReady?.(true);
  void chrome.showAccount?.(me, kit);

  const filterInput = $('table-filter');
  filterInput.addEventListener('input', () => renderTableList(filterInput.value));

  /* Filtering to one table and then having to reach for the mouse is the
     kind of small friction that makes a tool feel unfinished. Typing narrows,
     arrows choose, Enter opens — and with a single match, Enter alone is
     enough. */
  /* Bound on the whole sidebar rather than on the filter field.

     Arrows only worked while the field had focus, so clicking a table and
     then pressing Down scrolled the page instead of moving to the next
     table — the list looked keyboard-navigable and was not, which is worse
     than not offering it. */
  shellQuery('.sidebar').addEventListener('keydown', (e) => {
    if (!(e instanceof KeyboardEvent) || e.defaultPrevented) return;
    const list = $('table-list');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSidebar(1, list, filterInput);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSidebar(-1, list, filterInput);
    } else if (e.key === 'ArrowRight' && e.target !== filterInput) {
      /* Rightwards is where the table you highlighted is. The list chooses
         what to show; the panel is where you then work, and reaching it
         should not mean going back to the mouse. */
      e.preventDefault();
      focusContent();
    } else if (e.key === 'Enter' && e.target === filterInput) {
      e.preventDefault();
      // No explicit highlight means "the obvious one": the only match, or
      // the first of several. Enter commits: a push, so the table you chose
      // is a place you can come back to, unlike the ones you skimmed past.
      if (openSidebarChoice()) {
        if (!shell().inApp() && window.matchMedia('(max-width: 600px)').matches) {
          const collapse = shellQuery('.sidebar-collapse');
          if (collapse instanceof HTMLButtonElement) collapse.click();
        }
        filterInput.blur();
      }
    } else if (e.key === 'Escape' && e.target === filterInput) {
      if (filterInput.value) {
        // First Escape clears the filter, a second leaves the field. Clearing
        // and blurring together loses the list you were about to pick from.
        e.preventDefault();
        e.stopPropagation();
        filterInput.value = '';
        renderTableList('');
      } else {
        filterInput.blur();
      }
    }
  });

  /* The schema diagram is reachable at any time, not only from the empty
     state — it is how you re-orient after walking somewhere unfamiliar. */

  $('search-button').addEventListener('click', () => openPalette());
  // The wordmark is the one thing every web app makes a home link, and not
  // doing it is a small surprise on every page.
  $('home-button').addEventListener('click', goHome);

  tools?.menu('schema');
  /* App mode is a commitment: once launched, the app is the product and
     the explorer waits behind one deliberate gesture — this menu item and
     the w key, not a standing rung of chrome. The label reads by mode. */
  /* Registers its own menu item, so it lands between Schema and Connections —
     next to the other "what is this database" answer rather than at the end. */
  chrome.initHelp();
  tools?.menu('undo');
  addMenuItem({
    /* System is an explicit preference; this shortcut always flips the visible mode. */
    label: () => say('darkMode'),
    category: () => say('preferences.title'),
    checked: () => effectiveTheme() === 'dark',
    detail: () => themeLabel(),
    onSelect: () => {
      toggleTheme();
      render();
    },
  });
  tools?.menu('tools');

  addHostListener(document, 'keydown', (e) => {
    /* The query bar's own keys (Escape, `/`, `t`) are the Workbench's (workbench.js). */
    const active = document.activeElement;
    const typing = /input|textarea/i.test(active?.tagName ?? '') || active?.getAttribute?.('contenteditable') === 'true';
    /* And not while something is open over the page.
    
       These are single-key shortcuts on the document, so they fired through
       any surface that did not stop them: Backspace with the focus on a
       dialog's button walked the trail *behind* the modal, which then closed
       onto a different record than the one it was opened from. A dialog is
       modal by definition; the page under it is not taking keys. */
    const covered = Boolean(active?.closest?.('[role="dialog"], dialog[open], .pb, .help-panel, .palette, .conn-manager'));
    if (covered) return;

    // Backspace-as-back is a habit from file browsers, but only when the
    // caret is not in a text field.
    if (!typing && (e.key === 'Backspace' || (e.key === '[' && e.metaKey)) && state.stack.length > 1) {
      e.preventDefault();
      backTo(state.stack.length - 2);
    }
    if (e.key === 'h' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      goHome();
    }
  });
}
