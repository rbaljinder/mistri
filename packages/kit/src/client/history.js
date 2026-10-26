/**
 * Query history: the last 50 queries that ran, per connection.
 *
 * Two things shape this file.
 *
 * The first is that history is a convenience, never a dependency. Every
 * `localStorage` call is wrapped, because the API throws rather than returning
 * null in three ordinary situations — Safari's private mode, a browser set to
 * block site data, and a full quota — and a database browser that fails to
 * paint because it could not remember what you typed is worse than one that
 * never offered to. When storage refuses, the list falls back to memory and
 * works until the tab is closed.
 *
 * The second is that history is per connection. The stored value is keyed by
 * `state.activeConnection`, so switching from staging to production does not
 * offer you queries against tables the new database may not even have.
 */
import { createElement } from 'react';
import { $, el, loadJson, saveJson, state, toast } from './core.js';
import { mount } from './components/mount.js';
import { HistoryPanel } from './components/History.js';
import { say } from './copy/workbench/history.js';
import { addHostListener } from './shellHost.js';

const KEY = 'mistri.history.v1';

/* Enough to cover a session's worth of exploration, small enough that the
   whole record stays well inside a quota even with long queries. */
const MAX_ENTRIES = 50;

/** The whole record: `{ [connectionId]: [{ q, at }] }`. Never throws. */
function readAll() {
  const parsed = loadJson(KEY, {});
  // Anything could be under this key — an older shape, or another tool's.
  // Refusing to trust it is cheaper than defending every read site.
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/* The in-memory mirror, and the reason a failed write is not a failed feature:
   the dropdown reads from here, so history keeps working for the session even
   when nothing can be persisted. */
const cache = new Map();

const scope = () => state.activeConnection ?? 'default';

/** The history for the connection in use, newest first. */
export function historyFor(connection = scope()) {
  if (!cache.has(connection)) {
    const stored = readAll()[connection];
    cache.set(connection, Array.isArray(stored) ? stored.filter((e) => e && typeof e.q === 'string') : []);
  }
  return cache.get(connection);
}

/**
 * Remember a query that ran.
 *
 * Re-running something moves it to the top instead of adding a second copy:
 * the list is meant to answer "what have I been looking at", and twelve
 * identical rows of `customer` push the query you actually want off the end.
 */
export function recordQuery(text) {
  const q = String(text ?? '').trim();
  if (!q) return;
  const connection = scope();
  const kept = historyFor(connection).filter((entry) => entry.q !== q);
  kept.unshift({ q, at: Date.now() });
  kept.length = Math.min(kept.length, MAX_ENTRIES);
  cache.set(connection, kept);

  const all = readAll();
  all[connection] = kept;
  // Best effort: saveJson swallows a full or unavailable localStorage, and
  // the in-memory copy above keeps the list working for the session either way.
  saveJson(KEY, all);
  cursor = -1;
  draft = null;
  if (panel && !panel.hidden) fillPanel();
}

function clearHistory() {
  const connection = scope();
  cache.set(connection, []);
  const all = readAll();
  delete all[connection];
  saveJson(KEY, all);
  fillPanel();
  toast(say('queryHistoryCleared'));
}

/* ---------- the control ---------- */

let panel = null;
let toggle = null;
let installed = false;

/* Where in the list the ↑/↓ walk currently is: -1 means "on what you typed",
   and `draft` holds that text so walking back down returns it rather than
   leaving the last history entry in the box. */
let cursor = -1;
let draft = null;

function fillPanel() {
  mount(panel, createElement(HistoryPanel, { entries: historyFor(), onRun: runEntry, onClear: clearHistory }));
}

function runEntry(q) {
  const input = $('query');
  input.value = q;
  setOpen(false);
  cursor = -1;
  draft = null;
  /* `requestSubmit` rather than `submit`: it fires the form's submit event, so
     the one handler in app.js decides what a query means. `submit()` would
     skip it and reload the page. */
  $('querybar').requestSubmit();
}

function setOpen(open) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) fillPanel();
}

/** Step through the list in the input itself, without opening the panel. */
function step(direction) {
  const entries = historyFor();
  if (!entries.length) return;
  const input = $('query');
  if (cursor === -1) draft = input.value;
  const next = Math.min(Math.max(cursor + direction, -1), entries.length - 1);
  cursor = next;
  input.value = next === -1 ? (draft ?? '') : entries[next].q;
  // Caret to the end, or the browser leaves it where it was and the next
  // keystroke lands in the middle of the recalled query.
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * Attached on import rather than from a boot function.
 *
 * app.js wires the chrome, and this feature deliberately adds no line to it:
 * importing the module is enough to get the control, which keeps the query bar
 * working the same whether or not history is compiled in.
 */
function initHistory() {
  if (installed) return;
  const bar = $('querybar');
  const input = $('query');
  if (!bar || !input) return;
  installed = true;

  /* No button in the header any more.

     Recent queries are reached two better ways: Ctrl/Cmd+↑ in the query bar,
     which is where your hands already are, and ⌘K, which searches them
     alongside everything else. A permanent button for a list you open once a
     session was the most expensive way to offer it. */
  toggle = el('button', { type: 'button', class: 'ghost history-toggle', hidden: true });
  panel = el('div', { class: 'history-panel', hidden: true });
  bar.append(panel);

  input.addEventListener('keydown', (e) => {
    // Ctrl/Cmd rather than a bare arrow: the query bar is a text field, and
    // stealing plain ↑/↓ would break moving the caret in a long query.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape' && !panel.hidden) {
      e.stopPropagation();
      setOpen(false);
    }
  });

  // Typing means you have left the recalled entry and are writing your own.
  input.addEventListener('input', () => {
    cursor = -1;
    draft = null;
  });

  /* Closed by a click anywhere else, which is what a menu is expected to do —
     on pointerdown so it happens before the click lands on whatever is behind. */
  addHostListener(document, 'pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== toggle) setOpen(false);
  });
}

if (document.readyState === 'loading') {
  addHostListener(document, 'DOMContentLoaded', initHistory, { once: true });
} else {
  initHistory();
}
