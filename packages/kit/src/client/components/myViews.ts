/**
 * A reader's saved views of an App list: the tab, filters and sort they keep
 * coming back to, under a name.
 *
 * A view is the list's question as text (the visible question, plumbing
 * out), not a compiled filter, for the reasons the explorer's saved filters
 * give (views.js): it reads back in Advanced, and a view naming a dropped
 * column is a visible error rather than a silently empty list. Opening one
 * is navigating to its text, so its address is the ordinary list URL and a
 * link to it reproduces it anywhere.
 *
 * Kept by the server, in its saved-filters store (`/api/filters`), one list
 * per list view. Whose list it is, the server says (`store`): in an App
 * without sign-in one list the App shares, "Saved views"; in a signed-in App
 * each account's own, "My views", owned by the verified session and never by
 * anything this client sends; and none where rows are scoped by a policy or
 * a tenant, or for a visitor who is not signed in, who cannot save. The
 * cache is one Query per connection, cleared whenever the session identity
 * changes (applist.js), so one reader's views never paint for the next.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, state } from '../core.js';
import { shell } from '../shellMode.js';
import { say } from '../copy/lists/components/myViews.js';

export interface SavedView {
  name: string;
  query: string;
}
/** Whose views a list keeps: the App's shared list, the account's own, or none to save into. */
type ViewStore = 'shared' | 'account' | 'none';
interface Saved {
  filters: Record<string, SavedView[]>;
  store: ViewStore;
}

/** The cache of a connection's saved views: the key the list reads and the warm-up fills. */
export const savedViewsKey = (): unknown[] => ['filters', state.activeConnection ?? ''];

const valid = (item: unknown): item is SavedView =>
  Boolean(item) && typeof (item as SavedView).name === 'string' && typeof (item as SavedView).query === 'string';

/* Anything but the two stores the server names is no store: a reply that
   does not say whose list this is must not be offered a Save. A signed-out
   visitor (`auth.public`) is asked nothing: there is no account to keep views
   for, and the read's 401 would draw the sign-in screen over the browsing. */
export async function fetchSavedViews(): Promise<Saved> {
  if (shell().publicVisitor()) return { filters: {}, store: 'none' };
  const data = (await api('/api/filters')) as { filters?: Record<string, SavedView[]>; store?: unknown };
  const store = data.store === 'shared' || data.store === 'account' ? data.store : 'none';
  return { filters: data.filters ?? {}, store };
}

const listOf = (saved: Saved | undefined, list: string): SavedView[] => {
  const views = saved?.filters[list];
  return Array.isArray(views) ? views.filter(valid) : [];
};

/** One list's views, and whose they are — undefined until known, and when the server will not say. */
export function useSavedViews(list: string): { views: SavedView[]; store: ViewStore | undefined } {
  const saved = useQuery({ queryKey: savedViewsKey(), queryFn: fetchSavedViews, staleTime: Infinity });
  return { views: listOf(saved.data, list), store: saved.data?.store };
}

/**
 * Change one list's views. The store is a whole list per list view, and a
 * write built on a stale cache silently deleted whatever another tab or
 * browser had saved since — so every write changes the server's *current*
 * list: a fresh read, the change, the whole list back. The cache is trusted
 * only after the server agreed; a failure is thrown, to be said out loud.
 */
export async function writeSavedViews(client: QueryClient, list: string, change: (views: SavedView[]) => SavedView[]): Promise<void> {
  let saved: Saved;
  try {
    saved = await fetchSavedViews();
  } catch (err) {
    throw new Error(say('couldNotReadTheSaved', { message: (err as Error).message }));
  }
  if (saved.store === 'none') throw new Error(say('viewsCannotBeSaved'));
  const views = change(listOf(saved, list));
  await api('/api/filters/save', { list, filters: views.length ? views : null });
  const filters = { ...saved.filters };
  if (views.length) filters[list] = views;
  else delete filters[list];
  client.setQueryData(savedViewsKey(), { ...saved, filters });
}

/** A question kept under a name. A repeated name replaces the older view:
    two called "Mine" that ask different things is worse than losing one. */
export const withView = (views: SavedView[], name: string, query: string): SavedView[] => [
  ...views.filter((v) => v.name !== name.trim()),
  { name: name.trim(), query },
];

/** A view renamed in its place; a name another view already has is taken over, by the same rule. */
export const renamedView = (views: SavedView[], from: string, to: string): SavedView[] =>
  views.filter((v) => v.name === from || v.name !== to.trim()).map((v) => (v.name === from ? { ...v, name: to.trim() } : v));

export const withoutView = (views: SavedView[], name: string): SavedView[] => views.filter((v) => v.name !== name);
