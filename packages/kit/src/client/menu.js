/**
 * The overflow menu, and the registry behind it.
 *
 * The toolbar had six buttons of equal weight — Run, SQL, Recent, Schema,
 * Views, Read only — which is six things with no order of importance between
 * them. Two of them were duplicates of something else (Schema is what the
 * wordmark already does; Recent is what ⌘K now covers), one is a mode rather
 * than an action, and one is the primary action. Flattening all of that into
 * a row of identical outlined rectangles makes the reader read every label
 * every time to find the one they want.
 *
 * So: `Run` stays attached to the field it runs, and secondary commands live
 * behind one button, including the editing preference. The registry exists so a module can add its own item
 * without reaching into the header — the composer adds "Views…" the same way
 * the app adds "Show SQL", and neither needs to know the other exists.
 */
import { createElement } from 'react';
import { $ } from './core.js';
import { mount } from './components/mount.js';
import { surfaceOf } from './surfaces.js';
import { commandsForMode } from './menuScope.js';

/* A label, category or detail may be a function: read when the menu opens, so
   a word registered at boot is said in the language the reader has by then
   (a visitor's arrives with the App's payload, after the shell registers). */
/** @typedef {string | (() => string)} Said */
/** @type {Array<{label: Said, onSelect: () => void, checked?: () => boolean, available?: () => boolean, detail?: Said, group?: string, kind?: string, category?: Said, scope?: import('./menuScope.js').MenuScope}>} */
const items = [];
/** @type {import('./menuScope.js').MenuMode} */
let mode = 'workbench';

export const menuMode = () => mode;

/* Whether a signed-in account's menu is on the bar. In an App it holds the
   reader's settings then, and the settings gear stands down (OverflowMenu). */
let accounts = 0;

/** An account menu arriving (true) or leaving (false). Counted, since a remount overlaps its predecessor. */
export function setAccountMenu(present) {
  accounts = Math.max(0, accounts + (present ? 1 : -1));
  changed();
}

/** In an App with a signed-in reader, the settings live in the account menu. */
export const settingsInAccount = () => mode === 'app' && accounts > 0;

/** Update both menu and command-palette consumers when the workspace changes. */
/** @param {import('./menuScope.js').MenuMode} next */
export function setMenuMode(next) {
  if (mode === next) return;
  mode = next;
  changed();
}

/**
 * Register a menu item. Order of registration is order of appearance.
 *
 * `checked` makes the item a toggle: it is read each time the menu opens, so
 * an item reflects the current state rather than the state at registration.
 */
export function addMenuItem(item) {
  items.push(item);
  changed();
}

/**
 * Replace every item in a group.
 *
 * Registration is a one-time act for the fixed commands, and wrong for the
 * ones that come from data: the pages this connection has change when someone
 * builds one, deletes one, or switches database. Adding them again would
 * leave the old ones beside the new, and a page you deleted still listed in
 * ⌘K is a command that opens nothing.
 *
 * By group rather than by id, because "these are the pages now" is the whole
 * statement — anything previously in the group that is not in the list is
 * gone, which is the part a per-item update cannot say.
 */
/**
 * Who to tell when the registered commands change.
 *
 * The palette snapshots the commands when it opens, and a group registered
 * a beat later — pages arriving from the server on a fresh load — was
 * invisible until it was closed and reopened. Searching for a page you can
 * see in the menu and being told nothing matches is the palette lying.
 */
const watchers = new Set();

/* Counted here, at the change, not by a listener: the menu read a version its
   own subscription bumped, so a change that landed between its render and
   its subscribing — the App's mode, set while the shell mounts — moved
   nothing it compared, and a slow machine kept the Workbench's "···" over
   an App's bar. A snapshot the store owns is one React's re-check sees. */
let version = 0;
function changed() {
  version += 1;
  for (const run of [...watchers]) run();
}

/** How many times the menu has changed: a snapshot for `useSyncExternalStore`. */
export const menuVersion = () => version;

/** Register for command-list changes. Returns the way to stop listening. */
export function whenMenuChanges(run) {
  watchers.add(run);
  return () => watchers.delete(run);
}

/** @param {string} group @param {Array<object>} entries @param {string} [kind] What the palette calls these entries (`page`); `action` when absent. */
export function setMenuGroup(group, entries, kind) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].group === group) items.splice(i, 1);
  }
  items.push(...entries.map((entry) => /** @type {(typeof items)[number]} */ ({ ...entry, group, ...(kind ? { kind } : {}) })));
  changed();
}

/**
 * Everything registered, for anywhere else that wants to offer it.
 *
 * The command palette lists these alongside tables, so an action is reachable
 * by typing its name as well as by opening the menu — registered once, offered
 * twice. Two lists of commands maintained separately is how a menu item ends
 * up missing from search.
 */
export const menuItems = () =>
  commandsForMode(
    items.filter((item) => !item.available || item.available()),
    mode,
  ).map((item) => ({ ...item, label: said(item.label), category: item.category === undefined ? undefined : said(item.category) }));

/** @param {Said} value */
const said = (value) => (typeof value === 'function' ? value() : value);

/** A menu item's detail, which may be a function of the moment. */
export const detailOf = (item) => (typeof item.detail === 'function' ? item.detail() : item.detail);

/**
 * The menu itself is a component (components/OverflowMenu.tsx) over Base
 * UI, drawn into the header where the static button stood; it reads the
 * registry above when it opens.
 */
export function initMenu() {
  const host = $('more-host');
  if (!host) return;
  mount(host, createElement(surfaceOf('overflowMenu')));
}
