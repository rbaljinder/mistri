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

test('docked, the header heads the sidebar and the bar keys stand at its foot, over the identity and Collapse', () => {
  page();
  const header = document.querySelector('header.topbar')!;
  const account = document.querySelector('.account')!;
  dockBar(true);
  const sidebar = document.querySelector('.sidebar')!;
  expect(order(sidebar)).toEqual(['topbar', 'table-list', 'sidebar-account', 'sidebar-app-footer', 'sidebar-footer']);
  // The head: the mark, New beside it, the search under them; the band over the layout is gone.
  expect(order(header)).toEqual(['home-button', 'topnav', 'new-menu-host', 'search-button']);
  expect(document.querySelector('body > header')).toBeNull();
  // The foot: the bar's remaining keys, the same elements, the account among them.
  const foot = document.getElementById('sidebar-account')!;
  expect(order(foot.firstElementChild!)).toEqual(['app-issues-host', 'assistant-host', 'more-host', 'account-host']);
  expect(foot.contains(account)).toBe(true);
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
  expect(document.getElementById('sidebar-account')).toBeNull();
  // And it is idempotent off as well.
  dockBar(false);
  expect(places()).toEqual(pristine);
});

test('a New menu made in the foot after docking is moved to the head on the next pass', () => {
  page();
  document.getElementById('new-menu-host')!.remove();
  dockBar(true);
  // appChrome.js makes the host before the assistant's door, which stands in the foot now.
  const made = document.createElement('span');
  made.id = 'new-menu-host';
  document.getElementById('assistant-host')!.before(made);
  dockBar(true);
  expect(made.parentElement).toBe(document.querySelector('.sidebar > header.topbar'));
  expect(order(made.parentElement!).slice(-2)).toEqual(['new-menu-host', 'search-button']);
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
