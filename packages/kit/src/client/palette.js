/**
 * Cmd+K: go anywhere by typing its name.
 *
 * The sidebar is a fine way to browse eleven tables and a poor way to reach
 * one of sixty-six. Past a screenful, finding a table means scrolling a list
 * you already know the answer in — you know it is called `purchase_order_line`
 * and the interface still makes you look for it.
 *
 * So this is the keyboard route to everything nameable: tables, views, saved
 * filters, and the connections themselves (the Workbench adds what is its
 * own through `addPaletteSource`). One list, ranked, because having
 * to know which *kind* of thing you are looking for before you can search for
 * it defeats the purpose.
 *
 * Matching is subsequence-based rather than substring: `pol` finds
 * `purchase_order_line`, which is how anyone who knows the schema would type
 * it. Exact and prefix matches still win, so typing a full name never ranks
 * it below something that merely contains the same letters.
 */
import { createElement } from 'react';
import { message, subscribeMessages } from './messages.js';
import { $, el, findTable, go, pageView, state, tableView, svgEl } from './core.js';
import { allSavedFilters } from './views.js';
import { historyFor } from './history.js';
import { detailOf, menuItems, menuMode } from './menu.js';
import { mount, unmount } from './components/mount.js';
import { surfaceOf } from './surfaces.js';
import { shell } from './shellMode.js';
import { appListQuery } from './components/appListModel.js';
import { appMenu, appRooms, isListRoom, roomPageId } from './components/appRooms.js';
import { navigationPaths } from './components/navigationTree.js';
import { plural } from './locale.js';
import { say } from './copy/shell/palette.js';
import { addHostListener, portalRoot, shellBody, shellQuery } from './shellHost.js';

/**
 * What a shell adds to the palette beyond the kit's own: places among the
 * tables and queries, and databases after the actions. The Workbench names its
 * saved SQL and its connections (workbench.js); an App names none, since its
 * rooms are the kit's to list.
 * @type {{ places: Array<() => PaletteItem[]>, databases: Array<() => PaletteItem[]> }}
 */
const sources = { places: [], databases: [] };

/** @typedef {{ kind: string, label: string, search: string, detail?: string, run: () => unknown }} PaletteItem */

/** @param {'places' | 'databases'} where @param {() => PaletteItem[]} source */
export function addPaletteSource(where, source) {
  sources[where].push(source);
}

/** Everything the palette can take you to, before filtering. */
export function entries() {
  const items = [];
  const workbench = menuMode() === 'workbench';

  /* The App's rooms under the menu's words and the groups around them, then
     the one nav does not list — the home of an App without nav. */
  const app = workbench ? null : shell().app();
  const menu = app ? navigationPaths(appMenu(app)) : [];
  const rest = app ? appRooms(app).filter((room) => !menu.some(({ entry }) => entry.id === room.id)) : [];
  for (const { entry, groups } of [...menu, ...rest.map((entry) => ({ entry, groups: [] }))]) {
    if (entry.error) continue;
    items.push({
      kind: 'page',
      label: entry.label,
      search: `${entry.label} ${groups.join(' ')}`,
      detail: groups.length ? groups.join(' / ') : undefined,
      run: () =>
        go(
          isListRoom(entry)
            ? { ...tableView(entry.table, appListQuery(entry)), view: entry.id }
            : pageView(/** @type {string} */ (roomPageId(entry)), undefined, undefined, entry.label),
          'reset',
        ),
    });
  }

  for (const table of workbench ? (state.schema?.tables ?? []) : []) {
    items.push({
      kind: table.isView ? 'view' : 'table',
      label: table.name,
      // The id only adds anything when it differs — a qualified name like
      // `app.invoice`. Repeating the name doubles its length for no gain and
      // lets a match run across the join between the two copies.
      search: table.id === table.name ? table.name : `${table.name} ${table.id}`,
      detail: say('common.columns2', { count: table.columns.length }),
      run: () => go(tableView(table.id), 'reset'),
    });
  }

  for (const filter of workbench ? allSavedFilters() : []) {
    // A saved filter is only reachable if its table still is.
    if (!findTable(filter.table)) continue;
    items.push({
      kind: 'filter',
      label: filter.name,
      search: `${filter.name} ${filter.table} ${filter.query}`,
      detail: filter.table,
      run: () => go(tableView(filter.table, filter.query), 'reset'),
    });
  }

  /* Recent queries, alongside everything else.

     A query you ran ten minutes ago is a place you were, in exactly the sense
     a table is — and searching for it by the words you typed is how you would
     look for it anyway. Bounded to the most recent handful so the list stays
     a shortlist rather than becoming a log. */
  for (const entry of workbench ? historyFor().slice(0, 12) : []) {
    const table = entry.q.split(/\s+/)[0];
    if (!findTable(table) && !state.schema?.tables.some((t) => t.name === table)) continue;
    items.push({
      kind: 'recent',
      label: entry.q,
      search: entry.q,
      run: () => go(tableView(findTable(table) ? table : state.schema.tables.find((t) => t.name === table).id, entry.q), 'reset'),
    });
  }

  /* The Workbench's own places, alongside everything else: its saved SQL (workbench.js). */
  for (const source of sources.places) items.push(...source());

  /* The overflow menu's actions, searchable. Registered in one place and
     offered in two, so nothing can be in the menu and missing from here. */
  for (const action of menuItems()) {
    items.push({
      /* A page is a page, not an "action". The registry groups what it holds,
         and the group is the closest thing to a kind that a registered
         command has — a row labelled ACTION beside three labelled TABLE told
         the reader nothing about what they were about to open. */
      kind: action.group === 'Pages' ? 'page' : 'action',
      label: action.label.replace(/…$/, ''),
      search: `${action.label} ${detailOf(action) ?? ''}`.trim(),
      detail: detailOf(action),
      run: () => action.onSelect(),
    });
  }

  /* And its other databases, after the actions: a switch is the furthest a pick can take you. */
  for (const source of sources.databases) items.push(...source());

  return items;
}

let host = null;
let returnFocus = null;
/** @type {Promise<void> | null} */
let opening = null;

/**
 * The surface is `components/Palette.tsx`, a part loaded on demand (app.js);
 * this is its one host on the body. The host waits for the part, so the box
 * is put on the page whole and takes the focus as it lands, the way the
 * connection manager's panel does (connmanager.js).
 */
export function openPalette(prefill = '') {
  if (host || opening) return opening ?? undefined;
  const surface = /** @type {import('react').ComponentType<any> & { ready?: () => Promise<void> }} */ (surfaceOf('palette'));
  const opener = document.activeElement;
  opening = Promise.resolve(surface.ready?.()).then(
    () => {
      opening = null;
      if (host) return;
      show(surface, prefill, opener);
    },
    () => {
      opening = null;
    },
  );
  return opening;
}

function show(surface, prefill, opener) {
  returnFocus = opener;
  host = document.createElement('div');
  host.className = 'palette-host';
  portalRoot().append(host);
  mount(host, createElement(surface, { prefill, onClose: closePalette }));
}

function closePalette() {
  if (!host) return;
  unmount(host);
  host.remove();
  host = null;
  if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

/**
 * Bind Cmd+K / Ctrl+K.
 *
 * Bound on the document with capture so it works from anywhere including the
 * query bar, which is where the hands usually are.
 */
export function initPalette() {
  addHostListener(
    document,
    'keydown',
    (e) => {
      if (e.key !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      openPalette();
    },
    true,
  );
}

/* ---------- the sidebar toggle ---------- */

const SIDEBAR_KEY = 'mistri.sidebar-hidden';

/**
 * Hide the table list.
 *
 * Worth having once the palette exists: with Cmd+K reaching every table by
 * name, the sidebar stops being the only way in and becomes 232 pixels that
 * a wide record could use instead. The state is remembered, because a
 * preference about screen space that resets on reload is not a preference.
 */
export function initSidebarToggle() {
  let desktopHidden = false;
  try {
    desktopHidden = window.localStorage?.getItem(SIDEBAR_KEY) === '1';
  } catch {
    /* Storage is optional. */
  }
  const compact = window.matchMedia('(max-width: 600px)');
  const sidebar = shellQuery('.sidebar');
  let appMode = shellBody().classList.contains('app-mode');
  let compactOpen = false;
  const narrowWorkbench = () => compact.matches && !appMode;

  const remember = (next) => {
    try {
      window.localStorage?.setItem(SIDEBAR_KEY, next ? '1' : '0');
    } catch {
      /* Private browsing. The toggle still works for this session. */
    }
  };

  /* Two buttons, because a control that hides its own container cannot also
     be the way to bring it back. The collapse button lives in the sidebar,
     next to the filter field and directly above the list it hides; the reveal
     button appears at the left edge where the sidebar was, which is where the
     hand goes looking for it. */
  /* Drawn rather than typed, for the same reason the home crumb is: `«` and
     `»` are guillemets, which every platform sets at a different weight and
     several set as punctuation too small to be a target. And they were
     `--ink-subtle` — a mid-grey at half alpha, which is a token for a rule
     between things, not for a control somebody is meant to find. */
  const chevrons = (facing) =>
    svgEl(
      'svg',
      {
        viewBox: '0 0 16 16',
        width: '15',
        height: '15',
        'aria-hidden': 'true',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      facing === 'left'
        ? [svgEl('path', { d: 'M9.5 4L5.5 8l4 4' }), svgEl('path', { d: 'M13 4L9 8l4 4' })]
        : [svgEl('path', { d: 'M6.5 4l4 4-4 4' }), svgEl('path', { d: 'M3 4l4 4-4 4' })],
    );

  const collapse = el(
    'button',
    {
      type: 'button',
      class: 'sidebar-collapse',
      'aria-label': say('hideTheTableList'),
      'aria-controls': 'table-list',
      title: say('hideTheTableListB'),
      /* A toggle: in the icon rail the sidebar stays on screen folded, and this
       button, still in it, is the way back. */
      onclick: () => apply(!shellBody().classList.contains('sidebar-hidden')),
    },
    chevrons('left'),
  );

  const reveal = el(
    'button',
    {
      type: 'button',
      class: 'sidebar-reveal',
      'aria-label': say('showTheTableList'),
      'aria-controls': 'table-list',
      title: say('showTheTableListB'),
      onclick: () => apply(false),
    },
    [chevrons('right'), el('span', { class: 'sidebar-reveal-label' }, [say('common.tables2')])],
  );

  function renderToggle() {
    const next = narrowWorkbench() ? !compactOpen : desktopHidden;
    shellBody().classList.toggle('sidebar-hidden', next);
    const inApp = shellBody().classList.contains('app-mode');
    const wasFocused = document.activeElement === collapse;
    const destination = inApp ? footer : row;
    if (collapse.parentElement !== destination) destination.append(collapse);
    /* The icon rail (an App's `ui.shell.rail`) folds the sidebar instead of
       hiding it, so the collapse button stays in it and, folded, is the way
       back: it takes the reveal's words and direction. */
    const rail = shellBody().classList.contains('app-nav-rail');
    const back = next && rail;
    collapse.setAttribute('aria-label', back ? say('showTheTableList') : say('hideTheTableList'));
    collapse.title = back ? say('showTheTableListB') : say('hideTheTableListB');
    collapse.replaceChildren(
      chevrons(back ? 'right' : 'left'),
      ...(inApp ? [el('span', { class: 'sidebar-collapse-label' }, [message('navigation.collapse')])] : []),
    );
    collapse.setAttribute('aria-expanded', String(!next));
    reveal.setAttribute('aria-expanded', String(!next));
    // Focus follows the control that survives, so the keyboard is never left
    // on a button that has just been hidden. In the rail only the filter
    // field goes; the menu's own buttons stay where they are.
    const survivor = next && !rail ? reveal : collapse;
    if (wasFocused) survivor.focus({ preventScroll: true });
    const active = document.activeElement;
    const lost = active === reveal || (next && sidebar.contains(active) && (!rail || active === filter));
    if (lost && active !== survivor) survivor.focus({ preventScroll: true });
    // The menu shows its entries' names on hover only while folded to the rail.
    document.dispatchEvent(new Event('mistri:sidebar-fold'));
  }

  function apply(next) {
    if (narrowWorkbench()) compactOpen = !next;
    else {
      desktopHidden = next;
      remember(next);
    }
    renderToggle();
  }

  /* Sharing the filter field's row rather than taking one of its own: the
     sidebar's vertical space is the list, and a button on a line by itself
     would cost a table's worth of it. */
  const filter = $('table-filter');
  const row = el('div', { class: 'sidebar-filter-row' });
  filter.replaceWith(row);
  row.append(filter, collapse);
  // Outside the scrolling menu: the App's control remains reachable even
  // when its navigation is taller than the viewport.
  const footer = el('div', { class: 'sidebar-footer' });
  sidebar.append(footer);
  shellQuery('.layout')?.prepend(reveal);

  subscribeMessages(renderToggle);
  renderToggle();
  compact.addEventListener('change', () => {
    compactOpen = false;
    renderToggle();
  });
  // App/Workbench switches reuse the shell. Responsive disclosure state is
  // temporary and must never replace the user's desktop sidebar preference.
  // An App that asks for the rail (app.js sets `app-nav-rail`) changes what
  // the collapse button says while folded, so that switch re-renders it too.
  let railMode = shellBody().classList.contains('app-nav-rail');
  new MutationObserver(() => {
    const next = shellBody().classList.contains('app-mode');
    const nextRail = shellBody().classList.contains('app-nav-rail');
    if (next === appMode && nextRail === railMode) return;
    if (next !== appMode) compactOpen = false;
    appMode = next;
    railMode = nextRail;
    renderToggle();
  }).observe(shellBody(), { attributes: true, attributeFilter: ['class'] });
  sidebar.addEventListener('click', (event) => {
    if (narrowWorkbench() && event.target instanceof Element && event.target.closest('button[data-table]')) apply(true);
  });
  sidebar.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === 'Escape' && narrowWorkbench() && compactOpen && !event.defaultPrevented) {
      if (event.target === filter && filter.value) return;
      event.preventDefault();
      event.stopPropagation();
      apply(true);
    }
  });

  addHostListener(
    document,
    'keydown',
    (e) => {
      if (e.key !== 'b' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      apply(!shellBody().classList.contains('sidebar-hidden'));
    },
    true,
  );
}
