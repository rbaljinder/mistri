/**
 * The per-column filter menu of the grid, and the sort it rewrites.
 *
 * Its own module: the grid is a component now, and this menu is the one
 * piece of it that stays a transient vanilla surface — appended to the
 * body, driven by the keyboard, gone on Escape — the way the palette and
 * the topbar's ··· menu are.
 */
import { createElement } from 'react';
import { api, currentEntry, findTable, go, looksLikeDateColumn, quote, refine, state, tableView } from './core.js';
import { addSort, nextSort } from './clauses.js';
import { mount, unmount } from './components/mount.js';
import { FilterMenu } from './components/ThMenu.js';
import { portalRoot, shellQueryAll } from './shellHost.js';

let host = null;

function closeMenu() {
  if (!host) return;
  unmount(host);
  host.remove();
  host = null;
}

/**
 * Open the header menu for a column — `components/ThMenu.tsx`. What stays here is
 * the sampling: values come from the *unfiltered* table, not the visible
 * page, because once you have filtered to status = scheduled the page offers
 * exactly the filter you already applied.
 */
export async function openFilterMenu(anchor, meta, name, rows, plan) {
  closeMenu();
  const entryNow = currentEntry();
  let sample = rows;
  if (entryNow && entryNow.kind === 'table' && entryNow.query.trim() !== entryNow.table) {
    try {
      const unfiltered = await api('/api/run', { q: `${entryNow.table} show ${name}`, limit: 400, count: 'none' });
      if (unfiltered.rows?.length) sample = unfiltered.rows;
    } catch {
      // Sampling is a nicety; the rest of the menu still works without it.
    }
  }
  /* The header this menu belongs to may be gone: the sample takes a round
     trip, and navigating during it leaves the anchor detached. */
  if (!anchor.isConnected) return;

  const table = findTable(currentEntry()?.table ?? '');
  const columns = [...shellQueryAll('.table-wrap thead th')].map((th) => th.querySelector('.th-sort')?.firstChild?.textContent ?? '');
  host = document.createElement('div');
  host.className = 'host-contents';
  portalRoot().append(host);
  mount(
    host,
    createElement(FilterMenu, {
      anchor,
      name,
      kind: plan.kind,
      metaType: meta?.type,
      dateish: dateish(meta, name),
      rows: sample,
      table,
      columns,
      entry: entryNow && entryNow.kind === 'table' ? entryNow : null,
      onClose: closeMenu,
    }),
  );
}

/**
 * The date test from core.js, applied to the name the *result set* used.
 *
 * A joined column arrives under its path — `customer_id.opened_on` — and the
 * column meta beside it still calls itself `opened_on`, so the name has to be
 * passed in rather than read off the meta.
 *
 * The copy that used to be written out here had lost `timestamp`, `datetime`
 * and `deleted` from the name pattern, so the filter menu offered `=` on an
 * `event_timestamp TEXT` column and hid the relative-date phrases that are
 * the only sensible thing to say about a date.
 */
const dateish = (meta, name) => Boolean(meta) && looksLikeDateColumn({ type: meta.type, name });

/**
 * `append` adds a level to the sort instead of replacing it — shift-click,
 * which is the gesture every grid uses for exactly this.
 */
export function sortBy(column, direction, append = false) {
  const entry = state.stack[state.stack.length - 1];
  if (!entry || entry.kind !== 'table') return;
  /* `nextSort` must keep receiving `undefined` when no direction was named:
     an explicit direction means "write down what is already happening" and
     deliberately skips the ascending → descending cycle. Defaulting it here
     cost the header its second click. `addSort` has no cycle to skip, so it
     takes a direction. */
  /* A refinement: the same table room re-asks in place (core.js `refine`),
     so the header that was clicked, the rows' decorations and the focus stay. */
  refine(() =>
    go(
      tableView(entry.table, append ? addSort(entry.query, column, direction ?? 'asc') : nextSort(entry.query, column, direction)),
      'replace',
    ),
  );
}
