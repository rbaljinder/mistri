/**
 * The Directory: offered where a reader's menu holds more than a dozen places (appPayload.ts), at `/{app}/all-pages`
 * (appAddress.ts) unless the App already uses the word, and never for a menu of twelve or fewer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECTORY_AT, DIRECTORY_ROOM, navPlaces, type AppPayloadNavNode } from '../packages/engine/src/shared/servedApp.js';
import { withoutBrokenViews } from '../packages/mistri/src/shared/appPayload.js';
import { appAddressBook, readAppSegments } from '../packages/mistri/src/shared/appAddress.js';

const keys = (count: number) => Array.from({ length: count }, (_, at) => `room${at}`);
const views = (names: string[]) => Object.fromEntries(names.map((key) => [key, { table: key, label: key }]));
const nav = (names: string[]): AppPayloadNavNode[] => [
  { view: names[0]!, label: names[0]! },
  { group: 'more', label: 'More', children: names.slice(1).map((view) => ({ view, label: view })) },
  { label: 'Help', to: { app: 'help', kind: 'home' } as never },
];

test('a menu’s places are its views and its links, not the headings over them', () => {
  assert.equal(DIRECTORY_AT, 12);
  assert.equal(navPlaces(nav(keys(11))), 12);
  assert.equal(navPlaces([]), 0);
});

test('the Directory is offered on the menu this reader is served, past a dozen places', () => {
  const thirteen = keys(12);
  const app = { views: views(thirteen), nav: nav(thirteen), directory: { icon: 'list' as const } };
  assert.deepEqual(withoutBrokenViews(app, []).directory, { icon: 'list' });
  // A reader who cannot draw two of the rooms is served eleven of them and the link: twelve places, no Directory.
  const fewer = { ...app, views: { ...app.views, room1: { ...app.views.room1!, error: 'x' }, room2: { ...app.views.room2!, error: 'x' } } };
  assert.equal(withoutBrokenViews(fewer, []).directory, undefined);
  // An App that never had one is not given one here.
  const { directory: _, ...plain } = app;
  assert.equal('directory' in withoutBrokenViews(plain, []), false);
});

test('its address is /all-pages, claimed after every view, and only where offered', () => {
  const input = {
    views: views(['units']),
    order: ['units'],
    resources: {},
    pages: [],
    tables: [{ id: 'units', name: 'units', columns: [] }],
  };
  const offered = appAddressBook({ ...input, directory: true });
  assert.deepEqual(offered.routes.get(DIRECTORY_ROOM), { kind: 'directory' });
  assert.deepEqual(readAppSegments(offered, [DIRECTORY_ROOM]), { kind: 'route', target: { kind: 'directory' } });
  assert.equal(readAppSegments(offered, [DIRECTORY_ROOM, '3']), undefined);
  assert.equal(appAddressBook(input).routes.has(DIRECTORY_ROOM), false);
  // A view that took the word keeps it, and nothing is said: the room is still reached from its link.
  const taken = appAddressBook({ ...input, views: views(['all-pages']), order: ['all-pages'], directory: true });
  assert.equal(taken.routes.get(DIRECTORY_ROOM)?.kind, 'list');
  assert.deepEqual(taken.problems, []);
});
