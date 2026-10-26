/**
 * The star on a record or a view the App lets a reader keep. It says what
 * pressing it will do, and aria-pressed says what it is now.
 */
import { useSyncExternalStore } from 'react';
import { favoritesVersion, isFavorite, subscribeFavorites, toggleFavorite, type Favorite } from './favorites.js';
import { say } from '../copy/shell/components/FavoriteStar.js';

export function FavoriteStar({ favorite, name }: { favorite: Favorite; name: string }) {
  useSyncExternalStore(subscribeFavorites, favoritesVersion, favoritesVersion);
  const on = isFavorite(favorite);
  const says = on ? say('removeFromFavorites', { name }) : say('addToFavorites', { name });
  return (
    <button
      type="button"
      className={`ghost fav-star${on ? ' is-on' : ''}`}
      aria-pressed={on}
      aria-label={says}
      title={says}
      onClick={() => toggleFavorite(favorite)}
    >
      <span aria-hidden="true">{on ? '★' : '☆'}</span>
    </button>
  );
}
