/**
 * The bar beside the sidebar (`ui.shell.header: 'sidebar'`, a side-placed App's default): no band across the window.
 * The sidebar runs the window's full height, its head the bar's mark and New, its foot the workspace;
 * the room is a pane beside it, and the pane's own bar starts with the menu's toggle, says where the reader is (the
 * menu's group, then the room) and holds what is the same in every room at its far end: the search, the bell and
 * the account. The search, the
 * bell and the account stood in the sidebar once, at its head and its foot: the menu was then three things, and
 * the account a row under forty rooms.
 *
 * The bar's parts are moved, not drawn twice: every control in it is mounted once (the account, the New menu, the
 * issues badge, the assistant's door) and is found by its host wherever that host stands, so the same elements
 * dock here and go back to the bar when the shell crosses to a phone's drawer or the top placement. The header
 * keeps its `.topbar` class in the sidebar, so a theme's bar recipe (`recipes.bar`: ruled, dark) dresses the
 * sidebar's head as it dressed the bar.
 */
import { addHostListener, shellById, shellQuery } from '@mistriwork/kit/client/shellHost.js';

/**
 * Whether a side-placed App's shell stands the bar in its sidebar: yes unless the author says `header: 'bar'`, or
 * says `rail: false` and leaves the header unsaid — folded whole, the sidebar would take the mark, the search and the
 * account with it, so that App keeps the bar (an explicit `'sidebar'` beside `rail: false` is refused, appUi.ts).
 * The placement, the phone and the signed-out visitor are the caller's (appChrome.js).
 * @param {{ header?: 'bar' | 'sidebar', rail?: boolean } | undefined} shell
 */
export function headerInSidebar(shell) {
  if (shell?.header !== undefined) return shell.header === 'sidebar';
  return shell?.rail !== false;
}

/**
 * The pane's bar, made once: the first thing in the layout's second column, over the room. Its first part says
 * where the reader is (the menu's group, then the room); the bar's search and keys dock after it.
 */
function paneBar(content) {
  let bar = shellById('pane-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pane-bar';
    bar.className = 'pane-bar';
    const trail = document.createElement('span');
    trail.className = 'pane-trail';
    /* Said to the eye only: the menu's current row and the room's own heading say it to assistive technology. */
    trail.setAttribute('aria-hidden', 'true');
    bar.append(trail);
  }
  if (bar.nextElementSibling !== content) content.before(bar);
  return bar;
}

/* A room the menu has no row for (the reader's settings) says its own name while it stands: `mistri:room-title`. */
let unlisted = '';

/** The menu's group and the room it has current, as the menu draws them: read from it, so the two cannot disagree. */
function sayTrail(sidebar) {
  const trail = shellQuery('#pane-bar > .pane-trail');
  if (!trail) return;
  const current = sidebar.querySelector('#table-list [aria-current="true"]');
  const room = current?.querySelector('.nav-label')?.textContent?.trim() || unlisted;
  let group = '';
  /* A room at the menu's top level stands in no group, though one may be listed above it: its row says whether it
     is nested (Sidebar.tsx, `data-nested`), folded or not, and "Bookings / Inventory" named a group the room was
     never in. */
  const own = current?.closest('li');
  const top = own && !own.hasAttribute('data-nested');
  for (let row = top ? null : own?.previousElementSibling; row; row = row.previousElementSibling) {
    if (!row.classList.contains('nav-group')) continue;
    group = (row.querySelector('.nav-group-fold > span') ?? row.querySelector('[role="heading"]'))?.textContent?.trim() ?? '';
    break;
  }
  /* A group named as its room is ("Orders / Orders") says one place twice: the room alone. */
  if (group.localeCompare(room, undefined, { sensitivity: 'accent' }) === 0) group = '';
  const said = `${group}\u0000${room}`;
  if (trail.dataset.said === said) return;
  trail.dataset.said = said;
  trail.replaceChildren();
  if (!room) return;
  if (group) {
    trail.append(Object.assign(document.createElement('span'), { textContent: group }));
    trail.append(Object.assign(document.createElement('i'), { textContent: '/' }));
  }
  trail.append(Object.assign(document.createElement('b'), { textContent: room }));
}

if (typeof document !== 'undefined') {
  addHostListener(document, 'mistri:room-title', (event) => {
    unlisted = event instanceof CustomEvent && typeof event.detail === 'string' ? event.detail : '';
    const menu = shellQuery('.layout > .sidebar');
    if (menu) sayTrail(menu);
  });
}

/** @type {MutationObserver | undefined} */
let watching;

/**
 * Dock the bar's parts (`on`) or put them back in the bar. Docked, the header heads the sidebar with the mark and New,
 * and the search and the bar's keys (the bell, the account, an authoring badge, the assistant's door) stand in the
 * pane's bar, over the room. Idempotent: the shell calls it on every menu draw and after every brand pass, since the
 * New menu's host is made beside the bar's other keys.
 * @param {boolean} on
 */
export function dockBar(on) {
  const header = shellQuery('header.topbar');
  const sidebar = shellQuery('.layout > .sidebar');
  const actions = shellQuery('.topbar-actions');
  const search = shellById('search-button');
  if (!(header instanceof HTMLElement) || !(sidebar instanceof HTMLElement) || !(actions instanceof HTMLElement)) return;
  const newHost = shellById('new-menu-host');
  const content = shellQuery('.layout > .content');
  if (on && content instanceof HTMLElement) {
    if (header.parentElement !== sidebar) sidebar.prepend(header);
    /* The head: the mark, then New beside it (structure.css lays them out). */
    if (newHost && newHost.parentElement !== header) header.append(newHost);
    const bar = paneBar(content);
    /* The menu's toggle is the bar's first key (the kit's palette.js keeps it there once the bar stands). */
    const toggle = shellQuery('.sidebar-collapse');
    if (toggle && toggle.parentElement !== bar) {
      bar.prepend(toggle);
      document.dispatchEvent(new Event('mistri:pane-bar'));
    }
    if (search && search.parentElement !== bar) bar.append(search);
    if (actions.parentElement !== bar) bar.append(actions);
    if (search && search.nextElementSibling !== actions) actions.before(search);
    sayTrail(sidebar);
    /* The menu redraws its current row on every walk without the shell drawing again: the trail follows it. */
    if (!watching && typeof MutationObserver !== 'undefined') {
      watching = new MutationObserver(() => sayTrail(sidebar));
      watching.observe(sidebar, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current'] });
    }
    return;
  }
  watching?.disconnect();
  watching = undefined;
  if (header.parentElement === sidebar) {
    /* Where the page's markup puts it: after the skip link, before the SQL pane (index.html). */
    const after = shellById('explain-pane');
    if (after?.parentElement) after.before(header);
    else sidebar.closest('.layout')?.before(header);
  }
  if (actions.parentElement !== header) header.append(actions);
  if (search && search.parentElement !== actions) actions.prepend(search);
  /* Where appChrome.js makes it: before the assistant's door, else before the ··· menu's host. */
  if (newHost && newHost.parentElement !== actions) (shellById('assistant-host') ?? shellById('more-host'))?.before(newHost);
  /* The toggle goes back to the menu's foot before the bar goes (palette.js draws it there again). */
  const toggle = shellQuery('#pane-bar > .sidebar-collapse');
  if (toggle) {
    shellQuery('.sidebar-footer')?.append(toggle);
    document.dispatchEvent(new Event('mistri:pane-bar'));
  }
  shellById('pane-bar')?.remove();
}
