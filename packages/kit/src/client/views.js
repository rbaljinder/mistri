/**
 * Saved filters, as named tabs on a table.
 *
 * A filter you retype every morning is a filter that should have a name. The
 * saved view stores the *query text*, not a compiled filter, for two reasons:
 * it stays readable and editable in the bar, and it keeps working when the
 * schema changes underneath it — a stored filter referencing a dropped column
 * would be a silent empty result, while stored text is at worst a visible
 * error you can fix.
 *
 * Scoped per connection as well as per table, because `orders` on staging and
 * `orders` on production are not the same table and their useful filters are
 * rarely the same either.
 */
import { go, loadJson, saveJson, state, toast } from './core.js';
import { promptFor } from './prompt.js';
import { activeClauses } from './clauses.js';
import { say } from './copy/workbench/views.js';

const KEY = 'mistri.views.v1';

function allViews() {
  return loadJson(KEY, {});
}

function viewsFor(connectionId, tableId) {
  const all = allViews();
  return all[connectionId]?.[tableId] ?? [];
}

function writeViews(connectionId, tableId, list) {
  const all = allViews();
  all[connectionId] = all[connectionId] ?? {};
  all[connectionId][tableId] = list;
  if (!saveJson(KEY, all)) {
    toast(say('common.couldNotSaveThisBrowser'), 'error');
    return false;
  }
  return true;
}

const connectionKey = () => state.activeConnection ?? 'default';

/**
 * Every saved filter for this connection, flattened across tables.
 *
 * The landing page needs them together; the tab strip needs them per table.
 * Both read the same store, so a filter saved on a table is immediately on
 * the front page without anything having to be kept in step.
 */
export function allSavedFilters() {
  const byTable = allViews()[connectionKey()] ?? {};
  return Object.entries(byTable).flatMap(([table, list]) => (list ?? []).map((view) => ({ ...view, table })));
}

/**
 * What the tab strip for a table view needs — `components/SavedViews.tsx`
 * draws it. Null when there is nothing to show and nothing has been saved
 * yet, so an unused feature costs no screen space.
 */
export function savedViewsFor(entry) {
  const conn = connectionKey();
  const views = viewsFor(conn, entry.table);
  const isPlain = entry.query.trim() === entry.table;
  const alreadySaved = views.some((v) => v.query.trim() === entry.query.trim());
  if (!views.length && (isPlain || alreadySaved) && !activeClauses(entry.query).length) return null;
  return {
    views,
    onSave: () => void saveCurrent(conn, entry),
    onRename: (view) => void renameView(conn, entry, view),
    onRemove: (view) => removeView(conn, entry, view),
  };
}

async function saveCurrent(conn, entry) {
  const trimmed = await promptFor({
    title: say('saveThisFilter'),
    label: say('common.name'),
    value: suggestName(entry, entry.table),
    hint: entry.query,
    placeholder: say('eGOpenHigh'),
  });
  if (!trimmed) return;

  const views = viewsFor(conn, entry.table);
  // A repeated name replaces rather than duplicating: two tabs reading
  // "Open" that do different things is worse than losing the older one.
  const without = views.filter((v) => v.name !== trimmed);
  without.push({ id: `${Date.now()}`, name: trimmed, query: entry.query });
  if (writeViews(conn, entry.table, without)) {
    toast(say('savedTrimmed', { trimmed }), 'ok');
    go({ ...entry }, 'replace');
  }
}

async function renameView(conn, entry, view) {
  const trimmed = await promptFor({
    title: say('renameFilter'),
    label: say('common.name'),
    value: view.name,
    hint: view.query,
    confirmLabel: say('common.rename'),
  });
  if (!trimmed) return;
  const views = viewsFor(conn, entry.table).map((v) => (v.id === view.id ? { ...v, name: trimmed } : v));
  if (writeViews(conn, entry.table, views)) go({ ...entry }, 'replace');
}

function removeView(conn, entry, view) {
  const views = viewsFor(conn, entry.table).filter((v) => v.id !== view.id);
  if (writeViews(conn, entry.table, views)) go({ ...entry }, 'replace');
}

/**
 * A first guess at a name.
 *
 * `invoice total > 500 sort total desc` suggests "total > 500" — the part
 * that distinguishes it. Stripping the table name and the trailing clauses
 * leaves what the filter is actually about.
 *
 * When the filter was reached by walking, the trail says more than the filter
 * does: `work_order supersedes_id = 5` means little on its own, while
 * "WO-100005 · supersedes_id = 5" says which row it came from. The row you
 * walked through is the context the filter is really about.
 */
function suggestName(entry, table) {
  const query = entry.query;
  const previousRow = [...state.stack]
    .slice(0, state.stack.indexOf(entry))
    .reverse()
    .find((e) => e.kind === 'row');
  const withoutTable = query.trim().slice(table.length).trim();
  const withoutClauses = withoutTable
    .replace(/\s+(?:sort|order\s+by|limit|show|select)\s+.*$/i, '')
    .replace(/^(?:filter|where)\s+/i, '')
    .trim();
  const filterPart = withoutClauses || withoutTable;
  const candidate = previousRow?.label ? `${previousRow.label} · ${filterPart}` : filterPart;
  return candidate.length > 48 ? `${candidate.slice(0, 47)}…` : candidate;
}
