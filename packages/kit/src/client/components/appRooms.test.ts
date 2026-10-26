import { expect, test } from 'vitest';
import {
  appMenu,
  appRooms,
  dashPageId,
  dashViewKey,
  dashboardAt,
  hasRooms,
  homeRoom,
  offeredBy,
  resourceOf,
  viewRoom,
} from './appRooms.js';
import type { AppAction } from '../../../../mistri/src/shared/app.js';
import type { AppPayloadApp } from '../../../../mistri/src/shared/appPayload.js';
import { appNavTargetKey } from '../../../../mistri/src/client/appNavTargets.js';
import { navigationPaths } from './navigationTree.js';

const start: AppAction = { id: 'start', label: 'Start', set: { status: 'doing' } };
const finish: AppAction = { id: 'finish', label: 'Finish', set: { status: 'done' }, bulk: true };
const form = { show: ['name'] };
type Served = Pick<AppPayloadApp, 'views' | 'nav' | 'resources' | 'home'>;
const app = (
  views: Served['views'],
  nav: Served['nav'],
  resources: Served['resources'] = { task: { actions: [start, finish], form } },
): Served => ({ views, nav, resources });

test('external view/resource names do not create rooms or participate in local reachability', () => {
  const to = { app: 'foreign', kind: 'view' as const, view: 'tasks' };
  const served = app({ tasks: { table: 'task', label: 'Tasks' } }, [
    { view: 'tasks', label: 'Local' },
    { label: 'Foreign', to },
  ]);
  const rooms = appRooms(served);
  const hrefs = new Map([[appNavTargetKey(to), '/foreign/tasks']]);
  const tree = appMenu(served, (target) => hrefs.get(appNavTargetKey(target)));
  expect(tree.map((node) => node.kind)).toEqual(['destination', 'target']);
  expect(navigationPaths(tree).map((path) => path.entry.id)).toEqual(['tasks']);
  expect(appRooms(served)).toBe(rooms);
  expect(rooms).toHaveLength(1);
  expect(appMenu(served)).toHaveLength(1);
});

test('rooms follow the menu, depth first, then the view nav does not reference', () => {
  const served = app(
    {
      // Keys an object would sort first, and a home nav does not list.
      '2024': { table: 'task', label: 'Archive' },
      tasks: { table: 'task', label: 'Tasks' },
      board: { label: 'Board', sections: [] },
      home: { table: 'task', label: 'Home' },
    },
    [
      { view: 'board', label: 'Board' },
      {
        group: 'work',
        label: 'Work',
        children: [
          { view: 'tasks', label: 'Tasks' },
          { view: '2024', label: 'Old work' },
        ],
      },
    ],
  );
  expect(appRooms(served).map((room) => room.id)).toEqual(['board', 'tasks', '2024', 'home']);
  expect(appRooms(served)).toBe(appRooms(served));
  expect(hasRooms(served)).toBe(true);
  expect(hasRooms({ views: {} })).toBe(false);
  expect(hasRooms(null)).toBe(false);
});

test("a list offers the resource's New form, and its actions narrowed by a queue's or a board's selector, in the selector's order", () => {
  const served = app(
    {
      all: { table: 'task', label: 'All' },
      queue: { table: 'task', label: 'Queue', presentation: { kind: 'queue', primary: 'name' }, actions: ['finish', 'start'] },
      board: { table: 'task', label: 'Board', presentation: { kind: 'board', by: 'status', primary: 'name' }, actions: [] },
      other: { table: 'note', label: 'Notes' },
    },
    ['all', 'queue', 'board', 'other'].map((view) => ({ view, label: view })),
  );
  const [all, queue, board, other] = appRooms(served);
  expect(all).toMatchObject({ id: 'all', actions: [start, finish], form });
  expect(queue).toMatchObject({ id: 'queue', actions: [finish, start], form });
  expect(board).toMatchObject({ id: 'board', actions: [], form });
  /* The selector is the view's word to its resource; the room offers its answer instead. */
  expect(other).toEqual({ id: 'other', table: 'note', label: 'Notes' });
  expect(offeredBy(undefined, ['Start'])).toEqual({});
  expect(offeredBy({ actions: [start] })).toEqual({ actions: [start] });
});

test('a resource is found by its table id alone, never by a name Object.prototype lends', () => {
  const served = app({}, []);
  expect(resourceOf(served, 'task')).toEqual({ actions: [start, finish], form });
  expect(resourceOf(served, 'constructor')).toBeUndefined();
  expect(resourceOf(served, 'toString')).toBeUndefined();
  expect(resourceOf(null, 'task')).toBeUndefined();
  const list = appRooms(app({ c: { table: 'constructor', label: 'C' } }, [{ view: 'c', label: 'C' }]))[0];
  expect(list).toEqual({ id: 'c', table: 'constructor', label: 'C' });
});

test("the menu draws a room under nav's word, while the room keeps its own label", () => {
  const served = app({ tasks: { table: 'task', label: 'Tasks' }, board: { label: 'Board', sections: [] } }, [
    {
      group: 'work',
      label: 'Work',
      children: [
        { view: 'tasks', label: 'My tasks' },
        { view: 'board', label: 'Board' },
      ],
    },
    { view: 'gone', label: 'Gone' },
  ]);
  const [work] = appMenu(served);
  if (work.kind !== 'group') throw new Error('Expected a group');
  const [tasks, board] = work.children.map((node) => (node.kind === 'destination' ? node.entry : undefined));
  expect(tasks).toMatchObject({ id: 'tasks', label: 'My tasks', table: 'task', actions: [start, finish] });
  expect(appRooms(served)[0].label).toBe('Tasks');
  /* The same word is the same room, the object every reader compares. */
  expect(board).toBe(appRooms(served)[1]);
  /* A reference nothing serves draws nothing. */
  expect(appMenu(served)).toHaveLength(1);
  expect(appMenu(served)).toBe(appMenu(served));
});

test('a list view only a dashboard embeds has a room found by its key, and nothing lists it', () => {
  const board = { label: 'Board', sections: [{ kind: 'rows' as const, table: 'task', view: 'recent' }] };
  const recent = { table: 'task', label: 'Recent', query: 'status = done' };
  const served = app({ board, tasks: { table: 'task', label: 'Tasks' }, recent }, [
    { view: 'board', label: 'Board' },
    { view: 'tasks', label: 'Tasks' },
  ]);
  expect(appRooms(served).map((room) => room.id)).toEqual(['board', 'tasks']);
  expect(viewRoom(served, 'recent')).toMatchObject({ id: 'recent', table: 'task', actions: [start, finish], form });
  expect(dashboardAt(served, dashPageId('board'))).toBe(appRooms(served)[0]);
  expect(dashboardAt(served, 'dash-recent')).toBeUndefined();
  expect(dashboardAt(served, 'config-board')).toBeUndefined();
  expect([dashPageId('board'), dashViewKey('dash-board'), dashViewKey('saved:1'), dashViewKey(undefined)]).toEqual([
    'dash-board',
    'board',
    undefined,
    undefined,
  ]);
  /* Without nav the home dashboard is the one room listed; its embed is still only its own. */
  const solo = { ...app({ board, recent }, []), home: 'board' };
  expect(appRooms(solo).map((room) => room.id)).toEqual(['board']);
  /* A list the server served as this visitor's home is listed, embedded or not. */
  expect(appRooms({ ...solo, home: 'recent' }).map((room) => room.id)).toEqual(['board', 'recent']);
});

test('the home room is the one the server served, looked up and never chosen', () => {
  const tasks = { table: 'task', label: 'Tasks' };
  const views = { d: { label: 'D', sections: [] }, tasks };
  const nav = [
    { view: 'd', label: 'D' },
    { view: 'tasks', label: 'Tasks' },
  ];
  expect(homeRoom({ ...app(views, nav), home: 'tasks' })).toMatchObject({ id: 'tasks', table: 'task', actions: [start, finish] });
  expect(homeRoom({ ...app(views, nav), home: 'd' })).toMatchObject({ id: 'd', sections: [] });
  /* A public home — the landing, a public form — is no room; with no home served there is none, and a one-room App is not guessed at. */
  expect(homeRoom({ ...app(views, nav), home: 'welcome' })).toBeUndefined();
  expect(homeRoom(app(views, nav))).toBeUndefined();
  expect(homeRoom(app({ tasks }, []))).toBeUndefined();
});
