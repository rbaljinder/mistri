/**
 * Favorites as places: which ones this App still offers, and how to go to
 * one. A view the App no longer has, or a resource that stopped starring its
 * records, keeps its entry in storage but is not listed, so turning the
 * option back on brings the reader's list back with it.
 */
import { go, pageView, tableView } from '../core.js';
import { appListQuery } from './appListModel.js';
import { isListRoom, roomPageId, viewRoom } from './appRooms.js';
import { favorites, type Favorite } from './favorites.js';

type App = Parameters<typeof viewRoom>[0];

export function shownFavorites(app: App): Favorite[] {
  return favorites().filter((favorite) => {
    if (favorite.kind === 'record') return app.resources[favorite.table]?.favorite === true;
    const room = viewRoom(app, favorite.view);
    return Boolean(room && 'favorite' in room && room.favorite === true);
  });
}

export function openFavorite(app: App, favorite: Favorite): void {
  if (favorite.kind === 'record') {
    go(pageView(favorite.pageId, favorite.table, favorite.key, favorite.label), 'reset');
    return;
  }
  const room = viewRoom(app, favorite.view);
  if (!room) return;
  if (isListRoom(room)) go({ ...tableView(room.table, appListQuery(room)), view: room.id }, 'reset');
  else go(pageView(roomPageId(room)!, undefined, undefined, room.label), 'reset');
}
