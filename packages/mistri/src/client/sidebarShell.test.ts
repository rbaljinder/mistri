import { afterEach, expect, test } from 'vitest';
import { dockBar, headerInSidebar } from './sidebarShell.js';

/* The page's markup as index.html lays it out, with the hosts appChrome.js adds to the bar. */
function page() {
  document.body.innerHTML = `
    <a class="skip-link" href="#content">Skip to content</a>
    <header class="topbar">
      <button class="brand" id="home-button"><span class="brand-mark"></span><span class="brand-name">Shop</span></button>
      <nav class="topnav" id="topnav" hidden></nav>
      <div class="topbar-actions">
        <button id="search-button" class="tn-search">Search…</button>
        <span id="app-issues-host" class="host-contents"></span>
        <span id="new-menu-host" class="host-contents"><button class="new-menu-trigger">+ New</button></span>
        <span id="assistant-host" class="assistant-host"></span>
        <span id="more-host" class="host-contents"></span>
        <span class="account-host"><button class="account">R</button></span>
      </div>
    </header>
    <div class="explain-pane" id="explain-pane" hidden></div>
    <div class="layout">
      <nav class="sidebar"><ul id="table-list"></ul><div id="sidebar-app-footer"></div><div class="sidebar-footer"></div></nav>
      <main class="content" id="content"></main>
    </div>`;
}

/** Each element's place, by its id or class, in document order. */
const order = (root: Element) => [...root.children].map((child) => child.id || child.className);

afterEach(() => {
  document.body.replaceChildren();
});

test("docked, the header heads the sidebar with the mark and New, and the search and the bar's keys stand in the pane's bar", () => {
  page();
  const header = document.querySelector('header.topbar')!;
  const account = document.querySelector('.account')!;
  dockBar(true);
  const sidebar = document.querySelector('.sidebar')!;
  expect(order(sidebar)).toEqual(['topbar', 'table-list', 'sidebar-app-footer', 'sidebar-footer']);
  // The head: the mark and New beside it; the band over the layout is gone.
  expect(order(header)).toEqual(['home-button', 'topnav', 'new-menu-host']);
  expect(document.querySelector('body > header')).toBeNull();
  // The pane's bar stands over the room: where the reader is, the search, then the bar's keys, the same elements.
  expect(order(document.querySelector('.layout')!)).toEqual(['sidebar', 'pane-bar', 'content']);
  const bar = document.getElementById('pane-bar')!;
  expect(order(bar)).toEqual(['pane-trail', 'search-button', 'topbar-actions']);
  expect(order(bar.lastElementChild!)).toEqual(['app-issues-host', 'assistant-host', 'more-host', 'account-host']);
  expect(bar.contains(account)).toBe(true);
  // Docking again moves nothing.
  const before = document.body.innerHTML;
  dockBar(true);
  expect(document.body.innerHTML).toBe(before);
});

test('undocked, every part goes back where the markup put it', () => {
  page();
  const places = () =>
    [
      document.body,
      document.querySelector('header.topbar')!,
      document.querySelector('.topbar-actions')!,
      document.querySelector('.sidebar')!,
    ].map(order);
  const pristine = places();
  dockBar(true);
  dockBar(false);
  expect(places()).toEqual(pristine);
  expect(document.getElementById('pane-bar')).toBeNull();
  // And it is idempotent off as well.
  dockBar(false);
  expect(places()).toEqual(pristine);
});

test("a New menu made among the bar's keys after docking is moved to the head on the next pass", () => {
  page();
  document.getElementById('new-menu-host')!.remove();
  dockBar(true);
  // appChrome.js makes the host before the assistant's door, which stands in the pane's bar now.
  const made = document.createElement('span');
  made.id = 'new-menu-host';
  document.getElementById('assistant-host')!.before(made);
  dockBar(true);
  expect(made.parentElement).toBe(document.querySelector('.sidebar > header.topbar'));
  expect(order(made.parentElement!).at(-1)).toBe('new-menu-host');
});

test("the pane's bar says where the reader is: the menu's group, then the room it has current", () => {
  page();
  const list = document.getElementById('table-list')!;
  list.innerHTML = `
    <li><button aria-current="false"><span class="nav-label">Today</span></button></li>
    <li class="nav-group"><span role="heading"><button class="nav-group-fold"><span>Leasing</span></button></span></li>
    <li data-nested><button aria-current="true"><span class="nav-label">Rent roll</span></button></li>
    <li data-nested><button aria-current="false"><span class="nav-label">Leases</span></button></li>
    <li><button aria-current="false"><span class="nav-label">Inventory</span></button></li>`;
  dockBar(true);
  const trail = document.querySelector('#pane-bar > .pane-trail')!;
  expect([...trail.children].map((part) => part.textContent)).toEqual(['Leasing', '/', 'Rent roll']);
  // Said to the eye: the menu's current row and the room's heading say it to assistive technology.
  expect(trail).toHaveAttribute('aria-hidden', 'true');
  // A room over no group is its name alone; a room the menu does not hold says nothing.
  list.querySelectorAll('button[aria-current]').forEach((row, at) => row.setAttribute('aria-current', at === 0 ? 'true' : 'false'));
  dockBar(true);
  expect([...trail.children].map((part) => part.textContent)).toEqual(['Today']);
  // A top-level room listed after a group is in no group, on a folded rail too, where no inset says so.
  list.querySelectorAll('button[aria-current]').forEach((row, at) => row.setAttribute('aria-current', at === 3 ? 'true' : 'false'));
  document.body.classList.add('sidebar-hidden');
  dockBar(true);
  expect([...trail.children].map((part) => part.textContent)).toEqual(['Inventory']);
  document.body.classList.remove('sidebar-hidden');
  list.querySelector('[aria-current="true"]')!.setAttribute('aria-current', 'false');
  dockBar(true);
  expect(trail.children).toHaveLength(0);
});

test('the sidebar holds the bar unless the App says the bar, or folds its sidebar away whole', () => {
  expect(headerInSidebar(undefined)).toBe(true);
  expect(headerInSidebar({})).toBe(true);
  expect(headerInSidebar({ rail: true })).toBe(true);
  expect(headerInSidebar({ header: 'sidebar' })).toBe(true);
  expect(headerInSidebar({ header: 'bar' })).toBe(false);
  // Folded whole, the sidebar would take the mark, the search and the account with it: that App keeps the bar.
  expect(headerInSidebar({ rail: false })).toBe(false);
});
