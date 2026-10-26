import { expect, test } from 'vitest';
import { navigationContains, navigationNests, navigationPaths, navigationTree, type NavigationNode } from './navigationTree.js';
import type { AppPayloadNavNode } from '../../../../mistri/src/shared/appPayload.js';

interface Entry {
  label: string;
  table: string;
}
const served: Record<string, Entry> = Object.fromEntries(
  ['home', 'overview', 'assigned', 'critical', 'waiting', 'reports', 'directory', 'incidents', 'changes'].map((key) => [
    key,
    { label: key, table: key },
  ]),
);
/* The resolver a menu passes: the served view under the menu's word, or nothing for a view not served. */
const entryOf = (view: string, label: string): Entry | undefined => (Object.hasOwn(served, view) ? { ...served[view], label } : undefined);
const ref = (view: string, label = view[0].toUpperCase() + view.slice(1)): AppPayloadNavNode => ({ view, label });
const group = (id: string, label: string, children: AppPayloadNavNode[]): AppPayloadNavNode => ({ group: id, label, children });
const summary = (nodes: NavigationNode<Entry>[]): unknown[] =>
  nodes.map((node) =>
    node.kind === 'destination' ? node.entry.label : { id: node.id, label: node.label, children: summary(node.children) },
  );

test('same-label groups with distinct IDs remain separate destinations', () => {
  expect(
    summary(navigationTree([group('operations', 'Work', [ref('incidents')]), group('delivery', 'Work', [ref('changes')])], entryOf)),
  ).toEqual([
    { id: 'operations', label: 'Work', children: ['Incidents'] },
    { id: 'delivery', label: 'Work', children: ['Changes'] },
  ]);
});

test('nested groups keep the authored order beside sibling and root destinations', () => {
  const nav = [
    ref('home'),
    group('operations', 'Operate', [
      ref('overview'),
      group('queues', 'Queues', [ref('assigned'), group('escalated', 'Escalated', [ref('critical')]), ref('waiting')]),
      ref('reports'),
    ]),
    ref('directory'),
  ];
  expect(summary(navigationTree(nav, entryOf))).toEqual([
    'Home',
    {
      id: 'operations',
      label: 'Operate',
      children: [
        'Overview',
        {
          id: 'queues',
          label: 'Queues',
          children: ['Assigned', { id: 'escalated', label: 'Escalated', children: ['Critical'] }, 'Waiting'],
        },
        'Reports',
      ],
    },
    'Directory',
  ]);
});

test('a reference to a view that is not served is left out, and so is a group it leaves empty', () => {
  const nav = [
    ref('home'),
    group('gone', 'Gone', [ref('missing'), group('deeper', 'Deeper', [ref('also-missing')])]),
    group('work', 'Work', [ref('missing'), ref('changes')]),
  ];
  const before = structuredClone(nav);
  expect(summary(navigationTree(nav, entryOf))).toEqual(['Home', { id: 'work', label: 'Work', children: ['Changes'] }]);
  expect(nav).toEqual(before);
  expect(navigationTree([], entryOf)).toEqual([]);
});

test("the resolver's entry is the destination: the menu's word, and the object it returned", () => {
  const home = { label: 'Start here', table: 'home' };
  const tree = navigationTree([ref('home', 'Start here')], () => home);
  expect(tree).toEqual([{ kind: 'destination', entry: home }]);
  if (tree[0].kind !== 'destination') throw new Error('Unexpected tree');
  expect(tree[0].entry).toBe(home);
});

test('active destinations activate only their own groups, including repeated group labels', () => {
  const tree = navigationTree(
    [ref('home'), group('operations', 'Work', [group('queues', 'Queues', [ref('assigned')])]), group('delivery', 'Work', [ref('changes')])],
    entryOf,
  );
  const current = (entry: Entry) => entry.table === 'assigned';
  expect(tree.map((node) => navigationContains(node, current))).toEqual([false, true, false]);
  if (tree[1].kind !== 'group') throw new Error('Expected group');
  expect(navigationContains(tree[1].children[0], current)).toBe(true);
  expect(navigationContains(tree[1], (entry) => entry.table === 'missing')).toBe(false);
});

test('a menu nests only when a group holds a group', () => {
  expect(
    navigationNests(
      navigationTree(
        [ref('home'), group('work', 'Work', [ref('changes'), ref('incidents')]), group('more', 'More', [ref('reports')])],
        entryOf,
      ),
    ),
  ).toBe(false);
  expect(navigationNests(navigationTree([ref('home'), ref('changes')], entryOf))).toBe(false);
  expect(navigationNests(navigationTree([group('work', 'Work', [group('queues', 'Queues', [ref('assigned')])])], entryOf))).toBe(true);
  /* A nested group whose views are not served does not nest. */
  expect(
    navigationNests(navigationTree([group('work', 'Work', [ref('changes'), group('queues', 'Queues', [ref('missing')])])], entryOf)),
  ).toBe(false);
});

test('every destination, depth first, with its group labels outermost first', () => {
  const tree = navigationTree(
    [ref('home'), group('operations', 'Operate', [ref('overview'), group('queues', 'Queues', [ref('assigned')])]), ref('directory')],
    entryOf,
  );
  expect(navigationPaths(tree).map(({ entry, groups }) => [entry.table, groups])).toEqual([
    ['home', []],
    ['overview', ['Operate']],
    ['assigned', ['Operate', 'Queues']],
    ['directory', []],
  ]);
});

test('targets prune before groups, and never become local paths or current matches', () => {
  const to = { app: 'elsewhere', kind: 'view' as const, view: 'home' };
  const nav: AppPayloadNavNode[] = [ref('home'), group('foreign', 'Foreign', [group('nested', 'Nested', [{ label: 'Other home', to }])])];
  const unavailable = navigationTree(nav, entryOf, () => undefined);
  expect(unavailable).toHaveLength(1);
  const available = navigationTree(nav, entryOf, () => '/tools/other/home');
  expect(navigationPaths(available).map((path) => path.entry.table)).toEqual(['home']);
  expect(navigationContains(available[1], () => true)).toBe(false);
  expect(navigationNests(available)).toBe(true);
  expect(available[1]).toMatchObject({ kind: 'group', children: [{ children: [{ kind: 'target', href: '/tools/other/home', to }] }] });
});
