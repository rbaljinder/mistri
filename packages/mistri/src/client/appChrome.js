/**
 * The App framework's chrome around the kit's shell: the bar's account,
 * tenant control, issues badge, New menu and assistant; the App's menu as a
 * side list, a top bar or a phone's drawer; a tenant session's chooser and
 * history; and the authoring loop that follows the App's source.
 *
 * The boot is the kit's (app.js) and calls these at its places, with its own
 * steps handed in (shells.ts `KitShell`); appnav.js puts them together with
 * the App's payload as the shell's `appChrome`. Nothing here runs at import:
 * every page names the chrome, and a test that reads one part loads no other.
 */
import { createElement } from 'react';
import { AssistantTrigger } from './components/AssistantTrigger.js';
import { element, mount, queryClient, unmount } from '@mistriwork/kit/client/components/mount.js';
import { captureAccountIdentity, requireTenantSelection, sessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { configureSuiteNavigation } from './suiteNavigation.js';
import { configureAppTargetLinks } from './appTargetLinks.js';
import { tenantMutationState } from './tenantMutationState.js';
import {
  hasAdministrationSession,
  hasUnresolvedAdministration,
  hasInvitationSession,
  hasUnresolvedInvitations,
} from './tenantAccountState.js';
import { invalidateSession } from '@mistriwork/kit/client/sessionLifecycle.js';
import { railed } from '@mistriwork/kit/client/components/sidebarModel.js';
import { AppIssues } from '@mistriwork/kit/client/components/AppIssues.js';
import { MobileNavDrawer } from './components/MobileNavDrawer.js';
import { applyHeaderShell } from './appHeader.js';
import { $, allowMutationExit, el, state } from '@mistriwork/kit/client/core.js';
import { prepareEditingExit } from '@mistriwork/kit/client/write.js';
import { RuntimeMetadataError } from '@mistriwork/kit/client/requestIdentity.js';
import { setAppConfigured } from '@mistriwork/kit/client/connectionScope.js';
import { finishStartup } from '@mistriwork/kit/client/startup.js';
import { lookSheetReady } from '@mistriwork/kit/client/visualTheme.js';
import { settingsEntries } from './appSettings.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { activeApp, appFollowsSaves, appLoadProblem, inAppMode } from './appState.js';
import { applyAppTheme, retireAppTheme, shellPlacement } from './appTheme.js';
import { loadSavedFilters } from './applist.js';
import { headerSearchShown, isPublicVisitor } from './publicVisitor.js';
import { installShell } from '@mistriwork/kit/client/shellMode.js';
import { initHelp } from '@mistriwork/kit/client/help.js';
import { applyBrandLogo } from './appBrand.js';
import { say } from './copy/shell/appChrome.js';
import { herePath, hereSearch, shown, shownUnplaced } from '@mistriwork/kit/client/addressMount.js';
import { toHash } from '@mistriwork/kit/client/url.js';
import {
  addHostListener,
  navReplace,
  onNavigate,
  setTabTitle,
  shellBody,
  shellById,
  shellQuery,
  shellRoot,
} from '@mistriwork/kit/client/shellHost.js';

/* These controls belong only to a signed-in account or an authored top-bar
   layout. Keep their menus and styles with the control that actually draws. */
const AccountControl = onDemand(() => import('./components/AccountControl.js'), 'AccountControl', { quiet: true });
const TopNav = onDemand(() => import('./components/TopNav.js'), 'TopNav', { quiet: true });

/* A tenant App's flows — choosing a tenant, its links, its history, the
   support visit — loaded by boot for a tenant session and for nothing else. */
/** @type {typeof import('./tenantShell.js') | null} */
let tenant = null;

// A context acknowledgement alone is not a ready walk or a switch affordance.
let tenantNavigationReady = false;

/** Once, as the boot starts: the unload guard and the suite's links, for this signed-in account. */
export function startChrome(me) {
  addHostListener(window, 'beforeunload', (event) => {
    if (!tenantMutationState.hasUnresolved() && !hasUnresolvedAdministration() && !hasUnresolvedInvitations()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  const suiteOwner = captureAccountIdentity();
  configureSuiteNavigation(
    me.signedIn === true && me.accountId === suiteOwner.accountId && me.appId === suiteOwner.appId ? me.suite : undefined,
  );
  configureAppTargetLinks(
    me.signedIn === true && me.accountId === suiteOwner.accountId && me.appId === suiteOwner.appId && me.suite
      ? { basePath: me.suite.basePath, appId: me.appId }
      : null,
  );
}

/* Before the lifecycle is configured, so its tenant callbacks are the
   module's own and as synchronous as they always were; only a tenant
   session can call them. */
export async function loadTenancy(me) {
  tenant = me.tenant === true ? await import('./tenantShell.js') : null;
  const tenancy = tenant;
  if (!tenancy) return false;
  installShell({ tenantLinks: { parse: tenancy.parseTenantLink, qualify: tenancy.qualifyTenantLink } });
  tenancy.configureTenantResume((owner) => {
    if (sessionIdentity() !== owner) return;
    // Recheck picker candidates and action conditions, keeping record sources,
    // command expectedVersion, submitted envelopes and input values untouched.
    // Page section conditions share "when" but can unmount dirty fields; only
    // the action key includes the connection and identity epoch at these slots.
    void queryClient.invalidateQueries({
      predicate: (query) =>
        ['picker', 'command-choices'].includes(String(query.queryKey[0])) ||
        (query.queryKey[0] === 'when' && query.queryKey[2] === owner.appId && query.queryKey[3] === owner.epoch),
    });
  });
  return true;
}

/** The session lifecycle's tenant callbacks (sessionLifecycle.ts). */
export function tenantLifecycle(me, kit) {
  const tenancy = tenant;
  return {
    ...(tenancy
      ? {
          onContextCheck: (owner) => tenancy.checkBrowserTenant(owner),
          onTenantSuspend: (owner) => tenancy.suspendBrowserTenant(owner),
        }
      : {}),
    onTenantDenied: (owner) => {
      if (owner !== sessionIdentity() || !(hasAdministrationSession() || hasInvitationSession()) || !me) return;
      // Clear data authority synchronously. The native account root, its modal
      // and frozen administrative attempt survive the business retirement.
      const pending = requireTenantSelection();
      kit.retire();
      void (async () => {
        try {
          await kit.clearSurface(me);
          if (sessionIdentity() !== pending) return;
          // Permanent denial already required reload/reselection. Preserve that
          // boundary, but let independent management finish first. Do not start
          // a competing boot/rebuild while an earlier startup read is settling.
          $('content').replaceChildren(
            el('section', { class: 'tenant-chooser' }, [
              el('h1', { text: say('tenantAccessEnded') }),
              el('p', { text: say('businessDataHasBeen') }),
              el('button', {
                type: 'button',
                class: 'ghost',
                text: say('reloadAndChooseATenant'),
                onclick: () => {
                  if (sessionIdentity() === pending && allowMutationExit()) window.location.reload();
                },
              }),
            ]),
          );
        } catch {
          if (sessionIdentity() === pending) invalidateSession('unavailable', false);
        }
      })();
    },
  };
}

/**
 * Signed in at the staff door — typically a moment after signing in there,
 * since sign-in reloads the page it was on — is the App's root.
 */
export function signedInStart(me, landingAt) {
  if (!(me.signedIn && landingAt?.kind === 'sign-in' && landingAt.app === me.appId)) return null;
  // A reload after sign-in must not let the auth-only `sign-in` segment
  // enter the ordinary data-room parser. Tenant selectors are real route
  // intent, so retain only a selector that passes the tenant link grammar.
  return me.tenant === true && tenant ? tenant.tenantRootLink(me.appId, window.location.search) : `/${encodeURIComponent(me.appId)}`;
}

/** The App's look named by who-am-I, worn before any App payload is loaded: its theme, its name, its mark. */
export function wearLook(me, look) {
  if (!look || typeof look.id !== 'string') return;
  applyAppTheme(true, { id: look.id, ui: { theme: look.theme, customThemes: look.customThemes } });
  const brand = shellQuery('.brand-name');
  if (brand && typeof me.appName === 'string') brand.textContent = me.appName;
  applyBrandLogo(shellQuery('.brand-mark'), look.logo, typeof me.appName === 'string' ? me.appName : undefined, look.icons);
}

/** A tenant session's chooser, before the App's payload, which needs a chosen tenant. */
export async function chooseTenant(me, requestedApp, incomingLocation, kit) {
  const tenancy = tenant;
  if (!me.signedIn || typeof me.appId !== 'string' || me.appId !== requestedApp || !tenancy)
    throw new RuntimeMetadataError(say('tenantApplicationIdentityIsInvalid'));
  state.activeConnection = me.appId;
  setAppConfigured(true);
  shellBody().classList.add('app-mode', 'app-bound', 'tenant-pending');
  const link = tenancy.parseTenantLink(incomingLocation, me.appId);
  onNavigate(() => {
    const owner = sessionIdentity();
    if (!owner.tenantRequired || (tenantNavigationReady && owner.tenant)) return;
    if (!allowMutationExit()) {
      navReplace(shown(incomingLocation));
      return;
    }
    void tenancy.followTenantHistory(
      herePath() + hereSearch() + window.location.hash,
      {
        currentHref: toHash,
        replace: (href) => navReplace(shown(href)),
        apply: () => {},
        canLeave: async () => false,
        invalid: () => {},
        reload: () => window.location.reload(),
      },
      tenantNavigationReady,
    );
  });
  $('content').replaceChildren();
  /* The chooser comes before the App's payload, which needs a chosen
     tenant: it is drawn in the App's own look and under its name, which
     who-am-I carries for it, never the database browser's. */
  wearLook(me, me.look);
  // Audited support: the server offers it, and a password sign-in needs the account's email.
  tenancy.configureTenantSupport(me.tenantSupport === true && typeof me.who === 'string' ? { who: me.who } : undefined);
  /* The address the page opens where it is entered in the link's tenant, or with none named, its one: discovery
     carries the lease and this page's boot with it then (shared/tenantBoot.ts `TENANT_ENTER_PATH`). */
  const linked = link.search ? `${link.pathname}?${link.search}` : link.pathname;
  const linkedQuery = linked.indexOf('?');
  const selection = tenancy.initialTenantSelection(
    $('content'),
    typeof me.appName === 'string' ? me.appName : me.appId,
    link.tenantId ?? undefined,
    typeof me.platformLabel === 'string' ? me.platformLabel : undefined,
    typeof me.tenantLabel === 'string' ? me.tenantLabel : undefined,
    { path: linkedQuery < 0 ? linked : linked.slice(0, linkedQuery), search: linkedQuery < 0 ? '' : linked.slice(linkedQuery) },
  );
  await showAccount(me, kit);
  void lookSheetReady().then(finishStartup);
  const chosen = await selection;
  if (kit.retired() || sessionIdentity().mode === 'locked') return null;
  /* The chosen workspace is revealed whole, as a first page is (startupHold.ts,
     boot.js): its menu, bar and room arrived in parts, and each moved the
     page under the reader's eyes (test/built-client-vitals.mjs). */
  shellRoot().setAttribute('data-starting', '');
  const incoming = link.tenantId && chosen.tenantId !== link.tenantId ? `/${encodeURIComponent(me.appId)}` : linked;
  const tenantIncoming = tenancy.qualifyTenantLink(incoming, me.appId, chosen.tenantId);
  /* The page's first reads in one, on the lease just opened (shared/tenantBoot.ts): the runtime, the App, its
     pages and schema and the room's own reads, which the shell's requests below take as their answers. Asked
     before anything else asks, so none of them goes out on its own. Entered with discovery, they are held already. */
  const query = incoming.indexOf('?');
  const booted = tenancy.enteredWithBoot(chosen)
    ? Promise.resolve()
    : tenancy.loadTenantBoot(query < 0 ? incoming : incoming.slice(0, query), query < 0 ? '' : incoming.slice(query));
  navReplace(shown(tenantIncoming));
  unmount($('content'));
  await Promise.resolve();
  kit.showWorkspaceOpening();
  await booted;
  if (kit.retired() || sessionIdentity().mode === 'locked') return null;
  return { incoming, tenantIncoming };
}

/** Back and Forward in a session that needs a tenant: the tenant's history decides (tenantShell.js). */
export function followTenantHistory(href, handlers) {
  // Only a tenant session requires one, and boot loaded its flows for it.
  if (tenant) void tenant.followTenantHistory(href, handlers);
}

/** The tenant walk is ready (or not), so the account offers its switch. */
export function setTenantNavigationReady(ready) {
  tenantNavigationReady = ready;
}

/** Take down the App's look where a tenant's surface is cleared, leaving the one who-am-I names. */
export function retireLook(me) {
  const look = me.look;
  retireAppTheme(
    look
      ? { id: look.id, name: me.appName ?? look.name ?? me.appId, ui: { theme: look.theme, customThemes: look.customThemes } }
      : undefined,
    Boolean(me.appId),
  );
  if (me.appId) applyBrandLogo(shellQuery('.brand-mark'), look?.logo, me.appName ?? look?.name ?? me.appId, look?.icons);
}

/** Who is signed in, at the end of the toolbar, when a session says. */
export async function showAccount(me, kit) {
  try {
    if (!me.signedIn && me.public === true && typeof me.appId === 'string' && !shellQuery('.account-sign-in')) {
      const link = document.createElement('a');
      link.className = 'ghost account-sign-in';
      // The door is a member's: it leaves the visitor's public address behind.
      link.href = shownUnplaced(`/${encodeURIComponent(me.appId)}/sign-in`);
      link.textContent = say('common.signIn');
      $('more-host')?.parentElement?.append(link);
      return;
    }
    if (!me.signedIn || !me.who) return;
    const navigationApp = activeApp();
    const account = createElement(AccountControl, {
      key: captureAccountIdentity().epoch,
      owner: captureAccountIdentity(),
      who: me.who,
      appSwitcher:
        (!sessionIdentity().tenantRequired || tenantNavigationReady) && activeApp()?.id === me.appId
          ? activeApp()?.ui.appSwitcher
          : undefined,
      appSwitcherLocal:
        navigationApp && state.schema && navigationApp.id === me.appId
          ? { app: navigationApp, schema: state.schema, owner: sessionIdentity() }
          : undefined,
      accountProfile: me.accountProfile === true,
      accountAdministration: me.accountAdministration === true,
      tenantAdministration: me.tenantAdministration === true,
      tenantInvitations: me.tenantInvitations === true,
      // A member's own API tokens, on their tenant's lease: a per-lease answer on the App payload.
      apiTokens: Boolean(sessionIdentity().tenant && tenantNavigationReady && activeApp()?.apiTokens === true),
      inbox: me.inbox === true,
      onInvitationAccepted: () => {
        void tenant?.refreshTenantDiscovery();
      },
    });
    const existing = shellQuery('.account-host');
    if (existing) mount(existing, account);
    else $('more-host')?.parentElement?.append(element('span', account, 'account-host'));
    if (sessionIdentity().tenant && tenantNavigationReady && tenant) {
      shellQuery('.tenant-control-host')?.remove();
      $('more-host')?.parentElement?.append(
        tenant.tenantControl(
          async () => {
            if (!allowMutationExit()) return false;
            return prepareEditingExit();
          },
          () => kit.clearSurface(me),
          () => kit.rebuildSurface(me),
          // Whether this member's roles may read the tenant's support log: a
          // per-lease answer on the App payload, which is loaded by now.
          activeApp()?.supportLog === true,
          // And whether this platform lease may read every tenant's support sessions.
          activeApp()?.supportAudit === true,
        ),
      );
    }
  } catch {
    /* Not a server that signs people in. */
  }
}

/**
 * The app's menu as a top bar: ungrouped entries inline, each group a
 * small disclosure menu — the web-app shell. Items carry the same
 * data-table/data-navq the sidebar rows do, so the current room lights
 * whichever shell is up, and a group lights when a child is the current
 * room.
 */
/* The top bar is a component (components/TopNav.tsx), drawn straight into the
   bar's element; on a phone it is the same menu's drawer trigger. */
function renderTopNav(host, app, mobileDrawer = false) {
  mount(host, mobileDrawer ? createElement(MobileNavDrawer, { app }) : createElement(TopNav, { app, host }));
}

/** Whether the App's menu is a phone's drawer: the boot draws the shell again when this crosses. */
export const compactAppNavigation = window.matchMedia('(max-width: 900px)');

/**
 * The App's menu shell, drawn each time the kit draws its menu. True where
 * the side list is drawn; false where the menu is the top bar or the drawer.
 */
export function appMenuShell() {
  const app = activeApp();
  const appMode = inAppMode();
  /* The top-bar shell: `menu: "top"` moves the app's nav into a strip
     under the header — the web-app shape — and the sidebar leaves the
     room entirely. One body class is the whole switch;
     both renders keep the same data-table/data-navq wiring, so the
     highlight and the modules cannot tell the two shells apart.
     An App without nav has one room, its home, which no menu draws: with
     nothing to draw it wears the top shell — the brand, the search and the
     account stay, the menu goes. */
  const rooms = Boolean(app && Object.keys(app.views).length);
  const noMenu = Boolean(app && rooms && !app.nav.length);
  /* A signed-out visitor of an App that opens pages to the public is shown a storefront, not the staff shell with
     its menu emptied: the brand, the public entries as links and Sign in (docs/design.md, public pages). Shell selection
     only; the look is the App's own. */
  const placement = isPublicVisitor() ? 'top' : shellPlacement(app);
  const mobileDrawer = Boolean(app && rooms && !noMenu && placement !== 'top' && compactAppNavigation.matches);
  const topMode = Boolean(app && rooms && (placement === 'top' || noMenu) && !mobileDrawer);
  shellBody().classList.toggle('app-hide-menu', appMode && noMenu);
  shellBody().classList.toggle('app-hide-search', appMode && !headerSearchShown(app?.ui.shell?.search));
  shellBody().classList.toggle('app-hide-menu-search', appMode && app?.ui.shell?.menuSearch !== true);
  shellBody().classList.toggle('app-custom-gutter', appMode && app?.ui.shell?.gutter !== undefined);
  shellBody().classList.toggle('app-topnav', topMode);
  shellBody().classList.toggle('app-mobile-nav', mobileDrawer);
  /* The icon rail: folding this App's side menu leaves its icons standing
     rather than hiding it (palette.js reads the class for the fold button). */
  shellBody().classList.toggle('app-nav-rail', Boolean(appMode && !topMode && !mobileDrawer && railed()));
  const header = shellQuery('.topbar');
  if (header instanceof HTMLElement) applyHeaderShell(header, $('content'), appMode ? app?.ui.shell : undefined);
  const topnav = $('topnav');
  topnav.hidden = !(topMode || mobileDrawer);
  if (topMode || mobileDrawer) renderTopNav(topnav, app, mobileDrawer);
  else unmount(topnav);
  return !(topMode || mobileDrawer);
}

/**
 * The authoring loop, closed in the browser: every problem the startup
 * log and mistri check name rides /api/app, and the shell shows a quiet
 * count beside the menu whenever there are any. Click for the list —
 * each line names its fix — save the file, and hot reload clears it.
 * Absent entirely for a clean app and for readers: no chrome for a
 * problem nobody has.
 */
function appIssuesBadge() {
  const app = activeApp();
  const problems = inAppMode() ? (app?.problems ?? []) : [];
  let host = shellById('app-issues-host');
  if (!host) {
    /* Beside the menu's host rather than its button: signed in to an App the
       settings gear is not drawn (OverflowMenu.tsx), and the badge stays. */
    const menuHost = shellById('more-host');
    if (!menuHost) return;
    /* A host that takes no room of its own, so the badge is the bar's flex
       item the way it always was. */
    host = el('span', { id: 'app-issues-host', class: 'host-contents' });
    menuHost.before(host);
  }
  mount(host, createElement(AppIssues, { name: app?.name ?? '', problems }));
}

/**
 * The assistant's door, beside the menu's host, where the App payload offers
 * this person one (appProjection.ts strips it otherwise). Its box is held
 * from the moment the bar is drawn, before React has painted the button
 * into it, so nothing in the bar moves when it arrives.
 */
function renderAssistant() {
  const app = inAppMode() ? activeApp() : null;
  let host = shellById('assistant-host');
  if (!app?.assistant) {
    if (host) {
      unmount(host);
      host.remove();
    }
    return;
  }
  if (!host) {
    const menuHost = shellById('more-host');
    if (!menuHost) return;
    host = el('span', { id: 'assistant-host', class: 'assistant-host' });
    host.style.cssText = 'display:inline-flex;min-width:32px';
    menuHost.before(host);
  }
  mount(host, createElement(AssistantTrigger, { key: app.id, app: app.id, record: app.assistant.record === true }));
}

/**
 * The New menu (`ui.shell.new`), beside the menu's host and before the
 * assistant's door, where the App serves this reader any entry. The menu is
 * a chunk of its own (NewMenu.tsx), which draws nothing when none of the
 * entries is one this reader may use: no button that opens an empty menu.
 */
const AppNewMenu = onDemand(() => import('./components/NewMenu.js'), 'AppNewMenu', { quiet: true });
function renderNewMenu() {
  const app = inAppMode() ? activeApp() : null;
  let host = shellById('new-menu-host');
  if (!app?.ui.shell?.new?.length) {
    if (host) {
      unmount(host);
      host.remove();
    }
    return;
  }
  if (!host) {
    const menuHost = shellById('more-host');
    if (!menuHost) return;
    host = el('span', { id: 'new-menu-host', class: 'host-contents' });
    (shellById('assistant-host') ?? menuHost).before(host);
  }
  mount(host, createElement(AppNewMenu, { key: app.id, app }));
}

/**
 * The browser tab names the room, then the App: "Purchase orders · Inventory".
 * One title for every room ("Inventory — tablewalk") left ten tabs of one App
 * indistinguishable, and put the tool's name where the App's reader looks for
 * theirs. Every room has one level-one heading (docs/design.md, Access) — the
 * list's, the record's, the dashboard's — so the room is read off it as it is drawn,
 * rather than each room remembering to say it. The Workbench and the database
 * browser keep their own title; a sign-in, a landing and a public form set
 * theirs and are left alone.
 */
let roomTitleWatched = false;
function syncRoomTitle() {
  const app = activeApp();
  if (!app || !inAppMode() || shellBody().matches('.signed-out, .landing-mode, .public-form-mode')) return;
  /* A record whose name is edited in place heads its page with the editor, a level-one heading named by the record
     (PageHead.tsx), not an h1: read by its name, never by the Edit button's text inside it. */
  const heading = shellQuery('#content :is(h1, [role="heading"][aria-level="1"])');
  const room = (heading?.getAttribute('aria-label') ?? heading?.textContent)?.replace(/\s+/g, ' ').trim();
  setTabTitle(room && room !== app.name ? `${room} · ${app.name}` : app.name);
}
function watchRoomTitle() {
  syncRoomTitle();
  const content = $('content');
  if (roomTitleWatched || !content) return;
  roomTitleWatched = true;
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      syncRoomTitle();
    });
  }).observe(content, { childList: true, subtree: true, characterData: true });
}

/**
 * The bar's App parts, each brand pass, once the kit has named the tab: the
 * App's mark, the room's title over the tab's, the issues badge, the New menu
 * and the assistant's door.
 */
export function brandChrome() {
  const app = activeApp();
  applyBrandLogo(
    shellQuery('.brand-mark'),
    inAppMode()
      ? (/** @type {import('./appTheme.js').RecordTheme | undefined} */ (app?.ui.theme)?.branding?.mark ?? app?.ui.logo)
      : undefined,
    inAppMode() ? app?.name : undefined,
  );
  watchRoomTitle();
  appIssuesBadge();
  renderNewMenu();
  renderAssistant();
}

/** The App's colours ride the same switch as its chrome (appTheme.js). */
export function dressChrome() {
  applyAppTheme(inAppMode());
}

/* An App's settings records (a company profile): its one row each, opened
   from the reader's settings rather than from a list (appSettings.ts). */
export function appSettingsCommands() {
  return inAppMode() ? settingsEntries(activeApp()) : [];
}

/* Changes other people make (liveSync.ts), in an App a person is signed in to or may read, never in the Workbench:
   a part of its own, fetched here and idle on a server that has it off. */
let liveModule;
function followChanges() {
  if (inAppMode() && !isPublicVisitor()) {
    void import('./liveSync.js').then((live) => {
      liveModule = live;
      live.startLiveSync({ connection: () => state.activeConnection, tenant: tenant !== null });
    });
  } else liveModule?.stopLiveSync();
}

/* Only when the server says it watches the App's source; the module and
   its overlay are a chunk of their own, which no first page fetches. */
export function followSaves(reload) {
  followChanges();
  if (!appFollowsSaves()) return;
  void import('./appLive.js').then(({ followAppSaves }) =>
    followAppSaves({ connection: () => state.activeConnection, reload, problem: appLoadProblem }),
  );
}

export { initHelp, loadSavedFilters };
