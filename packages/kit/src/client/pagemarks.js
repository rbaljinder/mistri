/**
 * Pages you pinned, and pages you were just on.
 *
 * A page is the most expensive thing anyone builds in tablewalk — sections
 * chosen, columns picked, an order decided — and until now the only way back
 * to one was to remember its name and type it into ⌘K. Everything else the
 * tool remembers for you (the trail, the last root of each page, saved
 * filters) it remembers because retyping it is the tax on coming back
 * tomorrow, and this is the same tax on the most expensive thing.
 *
 * Two lists, because they answer two different questions. Pinned is "the
 * pages I work in", stated once. Recent is "where was I", which nobody
 * states — and a recent entry carries the record as well as the page, since
 * being sent back to "choose a customer" is not being sent back to where you
 * were.
 *
 * Per connection, like every other memory here: the same page name means a
 * different thing on staging and on production, and the last customer you
 * looked at on one is not a record on the other.
 */
import { loadJson, saveJson, state } from './core.js';

const PINNED_KEY = 'mistri.pages.pinned.v1';
const VISITS_KEY = 'mistri.pages.visits.v1';

/** How many positions are worth keeping. Enough for a day's work, not a log. */
const VISITS_MAX = 12;

const conn = () => state.activeConnection ?? 'default';
const read = (key) => loadJson(key, {})[conn()] ?? [];

function write(key, value) {
  const all = loadJson(key, {});
  all[conn()] = value;
  saveJson(key, all);
}

/* ---------- pinned ---------- */

/**
 * The pinned pages, each carrying its own name and base table.
 *
 * Stored rather than looked up, because the list of pages this connection
 * *has* does not include the suggested one — the page every table has and
 * nobody built — and pinning "the customer page" is exactly what someone
 * does before they have built anything. A pin that could only name pages
 * from a file would be a pin that silently dropped the commonest case.
 */
export function pinnedPages() {
  return read(PINNED_KEY).filter((p) => p && p.id);
}

export function isPinned(pageId) {
  return pinnedPages().some((p) => p.id === pageId);
}

/** Pin or unpin, and answer what it is now. */
export function togglePinned(page) {
  const pinned = pinnedPages();
  const next = pinned.some((p) => p.id === page.id)
    ? pinned.filter((p) => p.id !== page.id)
    : [...pinned, { id: page.id, name: page.name, base: page.base }];
  write(PINNED_KEY, next);
  return next.some((p) => p.id === page.id);
}

/* ---------- where you were ---------- */

/**
 * Record a position: this page, and the record it was about.
 *
 * Keyed by page *and* record, so opening three customers leaves three
 * entries rather than one that keeps changing — "the last three customers I
 * looked at" is the useful list, and a single slot per page throws away two
 * of them. A page with no root chosen still counts: getting back to the
 * chooser is worth one line.
 */
export function rememberVisit({ pageId, name, base, key, label }) {
  if (!pageId) return;
  /* The same record, however it was reached, is one visit. A row opened
     from a list carried a numeric key and one opened from a link a string
     one, so `{"id":5}` and `{"id":"5"}` sat side by side as two chips; the
     same record read through two pages over one table did the same. Keys
     compare as text, and a record is identified by its table when it has
     one, by its page only when it does not. */
  const stamp = JSON.stringify(normalKey(key));
  const same = (v) => JSON.stringify(normalKey(v.key)) === stamp && (base && v.base ? v.base === base : v.pageId === pageId);
  const visits = read(VISITS_KEY).filter((v) => !same(v));
  visits.unshift({ pageId, name, base, key, label });
  write(VISITS_KEY, visits.slice(0, VISITS_MAX));
}

/** A key with every value spelled as text, so 5 and "5" are one key. */
function normalKey(key) {
  if (!key || typeof key !== 'object') return null;
  return Object.fromEntries(
    Object.keys(key)
      .sort()
      .map((k) => [k, key[k] == null ? null : String(key[k])]),
  );
}

export function recentVisits() {
  return read(VISITS_KEY);
}

/** Forget a page entirely — it was deleted, or renamed out of existence. */
export function forgetPage(pageId) {
  write(
    PINNED_KEY,
    pinnedPages().filter((p) => p.id !== pageId),
  );
  write(
    VISITS_KEY,
    recentVisits().filter((v) => v.pageId !== pageId),
  );
}
