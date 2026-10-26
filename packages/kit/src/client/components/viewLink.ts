/**
 * Where a call to action that names one of the App's views goes, as a link
 * a reader can also open in a new tab. A list or a dashboard the App serves
 * this reader is followed in place, through the walk, and so is a signed-in
 * form, which is a room of its own (`form-<key>`). A public form is not
 * among those — it is served at its own address, outside the App — so its
 * link is that address. A list's link is its key, `/thread/board`, and a
 * dashboard's its own, `/compass/sales-dashboard`: the address bar's once
 * followed (publicAddress.ts).
 */
import type { MouseEvent } from 'react';
import { shell } from '../shellMode.js';
import { go, pageView, state, tableView } from '../core.js';
import { hashFor } from '../deeplink.js';
import { tabSlug } from '@mistriwork/engine/shared/addressParams.js';
import { appListQuery } from './appListModel.js';
import { dashPageId, isListRoom, roomPageId, viewRoom } from './appRooms.js';
import { registerViewOpener } from '../uiBridge.js';
import { shown } from '../addressMount.js';

export interface ViewLink {
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** A walk entry as a link a reader can also open in a new tab: its address, and the walk followed in place. */
function linkTo(entry: Parameters<typeof go>[0], mode: 'push' | 'reset'): ViewLink {
  const connection = state.activeConnection ?? null;
  /* The App's addresses are the shell's answer (shellMode.ts): a link names one of the App's views, so it is drawn
     where the App shell is. */
  const addresses = shell().addresses;
  return {
    // The walk's own form only where the App's book has no word for it (an App not yet loaded).
    href: shown(
      (connection ? addresses?.address(connection, [entry]) : undefined) ??
        hashFor(connection, [entry], { listParams: addresses?.listParams }),
    ),
    onClick: (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      go(entry, mode);
    },
  };
}

/** A list, dashboard or signed-in form this reader is served, by key. `adding` opens a list with its New form over it (`…!new`). */
export function viewLink(key: string, mode: 'push' | 'reset' = 'push', adding = false): ViewLink | undefined {
  const app = shell().app() as Parameters<typeof viewRoom>[0] | null;
  const room = app ? viewRoom(app, key) : undefined;
  if (!room) return undefined;
  const entry = isListRoom(room)
    ? { ...tableView(room.table, appListQuery(room, 0), adding ? 'new' : undefined), view: key }
    : pageView(roomPageId(room) ?? dashPageId(key));
  return linkTo(entry, mode);
}

/**
 * One of the App's lists on a refinement of its rows, as a dashboard group opens it: the list's own parameter where
 * it offers the column as a filter (`?status=approved`), `q=` for what those cannot say. Undefined for a key this
 * reader is served no list under, so a caller never falls back to the table's raw rows.
 */
export function listEntry(key: string, query: string): Parameters<typeof go>[0] | undefined {
  const app = shell().app() as Parameters<typeof viewRoom>[0] | null;
  const room = app ? viewRoom(app, key) : undefined;
  return room && isListRoom(room) && !room.error ? { ...tableView(room.table, query), view: key } : undefined;
}

export function listLink(key: string, query: string): ViewLink | undefined {
  const entry = listEntry(key, query);
  return entry ? linkTo(entry, 'push') : undefined;
}

/** Follow a list or dashboard this reader is served, as its link would; false when the key names none. */
function openView(key: string, options: { tab?: string; search?: string; filters?: Readonly<Record<string, string>> } = {}): boolean {
  const app = shell().app() as Parameters<typeof viewRoom>[0] | null;
  const room = app ? viewRoom(app, key) : undefined;
  if (!room) return false;
  if (!isListRoom(room)) {
    go(pageView(dashPageId(key)));
    return true;
  }
  /* A tab, a search and filters are the words an address says (publicAddress.ts addressQuestion), so a list
     opened here is the list that address opens: the same tab lit, the same boxes filled. */
  const params = new URLSearchParams();
  if (options.tab) params.set('tab', tabSlug(options.tab));
  if (options.search) params.set('search', options.search);
  for (const [column, value] of Object.entries(options.filters ?? {})) params.set(column, value);
  const asked = params.size ? (shell().addresses?.viewEntry(key, params.toString()) as Parameters<typeof go>[0] | null) : null;
  go(asked ?? { ...tableView(room.table, appListQuery(room, 0)), view: key });
  return true;
}
registerViewOpener(openView);

/** A public form's own page: `/{app}/form/{key}`. */
export function formLink(key: string): ViewLink {
  return { href: shown(`/${encodeURIComponent(state.activeConnection ?? '')}/form/${encodeURIComponent(key)}`) };
}
