/**
 * The reader's settings: one page at `/{app}/settings` (appAddress.ts), claimed after every view and page, so an App
 * that already uses the word keeps it and the account menu still opens the room.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_ROOM } from '../packages/engine/src/shared/servedApp.js';
import { appAddressBook, readAppSegments } from '../packages/mistri/src/shared/appAddress.js';

const views = (names: string[]) => Object.fromEntries(names.map((key) => [key, { table: key, label: key }]));
const input = {
  views: views(['units']),
  order: ['units'],
  resources: {},
  pages: [],
  tables: [{ id: 'units', name: 'units', columns: [] }],
};

test('its address is /settings in every App, one page with nothing under it', () => {
  const book = appAddressBook(input);
  assert.equal(SETTINGS_ROOM, 'settings');
  assert.deepEqual(book.routes.get(SETTINGS_ROOM), { kind: 'settings' });
  assert.deepEqual(readAppSegments(book, [SETTINGS_ROOM]), { kind: 'route', target: { kind: 'settings' } });
  // A section rides the walk, never the address.
  assert.equal(readAppSegments(book, [SETTINGS_ROOM, 'profile']), undefined);
  assert.deepEqual(book.problems, []);
});

test('a view that took the word keeps it, and nothing is said', () => {
  const taken = appAddressBook({ ...input, views: views(['settings']), order: ['settings'] });
  assert.equal(taken.routes.get(SETTINGS_ROOM)?.kind, 'list');
  assert.deepEqual(taken.problems, []);
});
