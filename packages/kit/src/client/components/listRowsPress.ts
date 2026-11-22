/**
 * A press on a menu entry that opens a list begins the list's first reads — its rows, and its tabs' counts — while
 * the button is still down, so they overlap the click and the screen held for them (../navigationHold.ts). A press, or
 * Enter: a pointer passing over the menu asks nothing. It asks through the very queries the room asks on mount
 * (`listRows`, `tabCountsRead`), so the room's mount finds them in flight or just landed (../pressedReads.ts) and asks
 * nothing more; a record's page is begun the same way (../recordPress.ts).
 *
 * Only a plain list: one that is a board, or grouped, reads through a window or a breakdown of its own that this
 * does not know, and is left to ask on mount. Saved views change the counts' question, so the counts wait for the
 * connection's views to be known.
 */
import { hashKey, type QueryClient } from '@tanstack/react-query';
import { queryClient } from './mount.js';
import { listRows } from './TableRoom.js';
import { badgeQuestions, tabCountsRead } from './AppList.js';
import { appListQuery, shownTabs, type ListSpec } from './appListModel.js';
import { savedViewsCached } from './myViews.js';
import { squeeze } from '../filterbar.js';
import { notePressed, PRESS_KEPT_MS, wasPressed } from '../pressedReads.js';

export function prefetchList(spec: ListSpec, client: QueryClient = queryClient): void {
  if (spec.error || spec.presentation || spec.asBoard || spec.group) return;
  const query = appListQuery(spec);
  const { read } = listRows({ kind: 'table', table: spec.table, query }, { page: 0, version: 0, embedded: false });
  const hash = hashKey(read.queryKey);
  if (!wasPressed(hash)) {
    notePressed(hash);
    void client.prefetchQuery({ ...read, staleTime: 0, gcTime: PRESS_KEPT_MS });
  }
  const yours = savedViewsCached(client, spec.id ?? `table:${spec.table}`);
  if (!yours) return;
  const tabs = shownTabs(spec);
  const gridTab = tabs.findIndex((_, i) => squeeze(appListQuery(spec, i)) === squeeze(query));
  const items = [...new Set(badgeQuestions(spec, spec.table, gridTab, yours))].sort();
  if (items.length) void client.prefetchQuery({ ...tabCountsRead(items), staleTime: 60_000 });
}
