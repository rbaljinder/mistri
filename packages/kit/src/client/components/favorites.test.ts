/**
 * The Favorites store: one entry per record or view, per connection, with
 * keys kept exactly as the API sent them.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const stored = new Map<string, unknown>();
const state = { activeConnection: 'demo' as string | null };
vi.mock('../core.js', () => ({
  state,
  loadJson: (key: string, fallback: unknown) => structuredClone(stored.has(key) ? stored.get(key) : fallback),
  saveJson: (key: string, value: unknown) => {
    stored.set(key, structuredClone(value));
  },
}));

const { favorites, isFavorite, relabelFavorite, subscribeFavorites, toggleFavorite } = await import('./favorites.js');

const record = { kind: 'record' as const, table: 'lead', key: { id: 127 }, label: 'Margot Fontaine', pageId: 'lead' };

beforeEach(() => {
  stored.clear();
  state.activeConnection = 'demo';
});

describe('favorites', () => {
  test('a star toggles on and off, and says what it is now', () => {
    expect(toggleFavorite(record)).toBe(true);
    expect(isFavorite(record)).toBe(true);
    expect(toggleFavorite(record)).toBe(false);
    expect(favorites()).toEqual([]);
  });

  test('a composite key typed in another column order is the same record', () => {
    toggleFavorite({ ...record, key: { region: 'eu', id: 1 } });
    expect(isFavorite({ ...record, key: { id: 1, region: 'eu' } })).toBe(true);
  });

  test('an id past 2^53 stays the string the API sent', () => {
    toggleFavorite({ ...record, key: { id: '9007199254740993' } });
    expect(favorites()[0]).toMatchObject({ key: { id: '9007199254740993' } });
    expect(isFavorite({ ...record, key: { id: '9007199254740992' } })).toBe(false);
  });

  test('each connection keeps its own list', () => {
    toggleFavorite(record);
    state.activeConnection = 'staging';
    expect(favorites()).toEqual([]);
    state.activeConnection = 'demo';
    expect(favorites()).toHaveLength(1);
  });

  test('a renamed record is listed by its new name, and listeners hear every change', () => {
    const heard = vi.fn();
    const stop = subscribeFavorites(heard);
    toggleFavorite(record);
    relabelFavorite({ ...record, label: 'Margot F.' });
    relabelFavorite({ ...record, label: 'Margot F.' });
    stop();
    expect(favorites()[0].label).toBe('Margot F.');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  test('a view is one entry by key', () => {
    toggleFavorite({ kind: 'view', view: 'pipeline', label: 'Pipeline' });
    expect(isFavorite({ kind: 'view', view: 'pipeline', label: 'Renamed' })).toBe(true);
  });
});
