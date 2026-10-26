/**
 * The records and views a reader starred, where the App offers a star.
 *
 * Opt-in by the App — `favorite: true` on a resource (its records) or on a
 * view — because a star on everything is chrome nobody asked for. Kept in
 * this browser and per connection, like pins and recents (pagemarks.js):
 * the same record name means a different thing on staging and production.
 * Under a verified session the storage is the account's own (core.js
 * loadJson), so a shared browser does not show one person's stars to the
 * next; following an account across browsers would need the server.
 */
import { loadJson, saveJson, state } from '../core.js';

export type Favorite =
  | { kind: 'view'; view: string; label: string }
  | { kind: 'record'; table: string; key: Record<string, unknown>; label: string; pageId: string };

const KEY = 'mistri.favorites.v1';
/** Enough to be a working set, not a second menu. */
const MAX = 50;
const listeners = new Set<() => void>();
let version = 0;

const conn = () => state.activeConnection ?? 'default';

/** A view by key; a record by table and exact key, its columns in one order
 * so the same key typed two ways is one favorite. Values stay as the API
 * sent them — an id past 2^53 is a string and must not become a number. */
export function favoriteId(favorite: Favorite): string {
  if (favorite.kind === 'view') return `view:${favorite.view}`;
  const key = Object.keys(favorite.key)
    .sort()
    .map((column) => [column, favorite.key[column]]);
  return `record:${favorite.table}:${JSON.stringify(key)}`;
}

const valid = (item: unknown): item is Favorite => {
  if (!item || typeof item !== 'object') return false;
  const f = item as Record<string, unknown>;
  if (typeof f.label !== 'string') return false;
  if (f.kind === 'view') return typeof f.view === 'string';
  return (
    f.kind === 'record' &&
    typeof f.table === 'string' &&
    typeof f.pageId === 'string' &&
    Boolean(f.key) &&
    typeof f.key === 'object' &&
    !Array.isArray(f.key)
  );
};

export function favorites(): Favorite[] {
  const all = loadJson(KEY, {}) as Record<string, unknown>;
  const list = all[conn()];
  return Array.isArray(list) ? list.filter(valid) : [];
}

function write(list: Favorite[]) {
  const all = loadJson(KEY, {}) as Record<string, unknown>;
  all[conn()] = list.slice(-MAX);
  saveJson(KEY, all);
  version++;
  for (const listener of listeners) listener();
}

export function isFavorite(favorite: Favorite): boolean {
  const id = favoriteId(favorite);
  return favorites().some((item) => favoriteId(item) === id);
}

/** Star or unstar, and answer what it is now. */
export function toggleFavorite(favorite: Favorite): boolean {
  const id = favoriteId(favorite);
  const list = favorites();
  const on = list.some((item) => favoriteId(item) === id);
  write(on ? list.filter((item) => favoriteId(item) !== id) : [...list, favorite]);
  return !on;
}

/** A starred record renamed since: the list says what it is called now. */
export function relabelFavorite(favorite: Favorite): void {
  const id = favoriteId(favorite);
  const list = favorites();
  const at = list.findIndex((item) => favoriteId(item) === id);
  if (at < 0 || list[at].label === favorite.label) return;
  list[at] = { ...list[at], label: favorite.label };
  write(list);
}

export function subscribeFavorites(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const favoritesVersion = () => version;
