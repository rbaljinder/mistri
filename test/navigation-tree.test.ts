import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheck } from './support/tsc.js';
import { navGroup } from '@mistriwork/mistri/app';
import { parseAppConfig, resolveViews, viewOrder, type AppNavNode } from '../packages/mistri/src/shared/app.js';
import { servedApp } from '../packages/mistri/src/shared/appPayload.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/** The first view a nav names, groups included: these Apps are about nav, so each starts where its nav does. */
const firstLeaf = (nodes: unknown[], seen = new Set<unknown>()): unknown => {
  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    const record = node as { view?: unknown; children?: unknown };
    const leaf =
      typeof node === 'string' ? node : (record?.view ?? (Array.isArray(record?.children) ? firstLeaf(record.children, seen) : undefined));
    if (leaf !== undefined) return leaf;
  }
  return undefined;
};
/* Every table a view names is declared; "missing" is one the schema lacks, carried with its reason. */
const parse = (nav: unknown[], views: Record<string, unknown> = { incidents: { kind: 'list', from: 'incident' } }) =>
  parseAppConfig({ name: 'Navigation test', resources: { incident: {}, missing: {} }, views, home: firstLeaf(nav), nav }, 'navigation.ts');
const schema: DatabaseSchema = {
  label: 'Fixture',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'incident',
      name: 'incident',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, nullable: false },
        { name: 'name', type: 'text', primaryKey: false, nullable: false },
      ],
    },
  ],
};
const dashboard = { kind: 'dashboard', label: 'Overview', sections: [{ kind: 'note', text: 'Overview' }] };

test('structural groups keep destination order, and the authored tree survives parsing and serving', () => {
  const views = {
    home: { kind: 'list', from: 'incident', label: 'Home' },
    incidents: { kind: 'list', from: 'incident', label: 'Incidents', show: ['name'] },
    overview: dashboard,
    missing: { kind: 'list', from: 'missing', label: 'Missing table' },
    'other-queue': { kind: 'list', from: 'incident', label: 'Other queue' },
  };
  const authored = [
    'home',
    {
      id: 'operate',
      label: ' Operate ',
      children: ['incidents', { id: 'responses', label: 'Response', children: ['overview', 'missing'] }],
    },
    { id: 'other', label: 'Operate', children: ['other-queue'] },
  ];
  const before = structuredClone(authored);
  const app = parse(authored, views);
  assert.deepEqual(authored, before, 'Parsing must not modify reusable authored group objects');
  assert.deepEqual(app.nav, [
    { view: 'home' },
    {
      group: 'operate',
      label: 'Operate',
      children: [{ view: 'incidents' }, { group: 'responses', label: 'Response', children: [{ view: 'overview' }, { view: 'missing' }] }],
    },
    { group: 'other', label: 'Operate', children: [{ view: 'other-queue' }] },
  ]);
  assert.deepEqual(
    viewOrder(app).map((key) => app.views[key].label),
    ['Home', 'Incidents', 'Overview', 'Missing table', 'Other queue'],
  );
  const resolved = resolveViews(app, schema);
  assert.equal('sections' in resolved.overview, true);
  assert.ok(resolved.missing.error, 'An invalid destination keeps its place in nav, with its reason');
  assert.deepEqual(servedApp(app, schema).nav[1], {
    group: 'operate',
    label: 'Operate',
    children: [
      { view: 'incidents', label: 'Incidents' },
      {
        group: 'responses',
        label: 'Response',
        children: [
          { view: 'overview', label: 'Overview' },
          { view: 'missing', label: 'Missing table' },
        ],
      },
    ],
  });
});

test('groups validate IDs, labels, nonempty children and exclusive ownership', () => {
  const valid = { id: 'operate', label: 'Operate', children: ['incidents'] };
  for (const value of [undefined, '', 'Bad ID', 'slash/name', 8]) {
    assert.throws(() => parse([{ ...valid, id: value }]), /group "id"/);
  }
  for (const value of [undefined, '', '  ', 8]) {
    assert.throws(() => parse([{ ...valid, label: value }]), /group "label"/);
  }
  for (const value of [undefined, null, [], {}]) {
    assert.throws(() => parse([{ ...valid, children: value }]), /non-empty "children" array/);
  }
  assert.throws(() => parse([{ ...valid, table: 'incident' }]), /"table"/);
  /* Grouping is the tree's alone: a flat `group` on a view is an unknown key. */
  assert.throws(
    () => parse([valid], { incidents: { kind: 'list', from: 'incident', group: 'Other' } }),
    /has no "group"\. "group" belongs inside a page section \(list\)\. It takes: /,
  );
  assert.throws(
    () => parse([{ ...valid, children: ['overview'] }], { overview: { ...dashboard, group: 'Other' } }),
    /has no "group"\. "group" belongs inside a page section \(list\)\. It takes: /,
  );
  assert.throws(() => parse([{ ...valid, children: [{ to: 'incidents', label: 'Incidents', group: 'Other' }] }]), /has no "group"/);
  assert.throws(() => parse([{ to: 'incidents', label: 'Incidents', ancestors: [{ id: 'forged', label: 'Forged' }] }]), /"ancestors"/);
  assert.throws(
    () => parse(['incidents'], { incidents: { kind: 'list', from: 'incident', ancestors: [{ id: 'forged', label: 'Forged' }] } }),
    /"ancestors"/,
  );
});

test('group identities are tree-wide unique and dashboard addresses remain unique across groups', () => {
  assert.throws(
    () =>
      parse([
        { id: 'one', label: 'One', children: [{ id: 'shared', label: 'Shared', children: ['incidents'] }] },
        { id: 'two', label: 'Two', children: [{ id: 'shared', label: 'Another label', children: ['incidents'] }] },
      ]),
    /repeats navigation group id "shared"/,
  );
  assert.throws(
    () =>
      parse(
        [
          { id: 'one', label: 'One', children: ['overview'] },
          { id: 'two', label: 'Two', children: ['overview'] },
        ],
        { overview: dashboard },
      ),
    /names the view "overview" a second time/,
  );
});

test('navigation bounds recursion and refuses cycles with useful errors', () => {
  const chain = (depth: number): unknown =>
    depth ? { id: `group-${depth}`, label: `Group ${depth}`, children: [chain(depth - 1)] } : 'incidents';
  const depth = (nodes: readonly AppNavNode[]): number =>
    Math.max(0, ...nodes.map((node) => ('group' in node ? 1 + depth(node.children) : 0)));
  assert.equal(depth(parse([chain(8)]).nav), 8);
  assert.throws(() => parse([chain(9)]), /maximum navigation group depth of 8/);
  const cyclic: { id: string; label: string; children: unknown[] } = { id: 'cycle', label: 'Cycle', children: [] };
  cyclic.children.push(cyclic);
  assert.throws(() => parse([cyclic]), /navigation cycle/);
});

test('flat groups are refused and helpers return ordinary objects', () => {
  assert.throws(() => parse([{ table: 'incident', group: 'Legacy' }]), /nav entry 1 is not a view id, a \{ label, to \} or a navGroup\./);
  assert.throws(
    () => parse(['incidents'], { incidents: { kind: 'list', from: 'incident', group: 'Legacy' } }),
    /has no "group"\. "group" belongs inside a page section \(list\)\. It takes: /,
  );
  assert.deepEqual(navGroup('operate', 'Operate', ['incidents']), { id: 'operate', label: 'Operate', children: ['incidents'] });
});

test('JSON authoring schema describes groups and forbids legacy ownership inside children', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.properties.nav.items.$ref, '#/$defs/navNode');
  assert.ok(json.$defs.navNode.oneOf.some((entry: { $ref?: string }) => entry.$ref === '#/$defs/navGroup'));
  const group = json.$defs.navGroup;
  assert.deepEqual(group.required, ['id', 'label', 'children']);
  assert.equal(group.additionalProperties, false);
  assert.equal(group.properties.children.minItems, 1);
  assert.equal(group.properties.children.items.$ref, '#/$defs/navNode');
  /* A child is a reference, never a definition that could name a second owner. */
  const reference = json.$defs.navNode.oneOf.find((entry: { type?: string }) => entry.type === 'object');
  assert.equal(reference.additionalProperties, false);
  assert.deepEqual(Object.keys(reference.properties), ['to', 'label', 'color']);
});

test('schema-typed nested groups and helpers retain table checking at every depth', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const filename = join(root, 'test', '.navigation-typecheck.ts');
  const source = [
    'import { navGroup, dashboard, listView, metric, type TypedAppConfig } from "@mistriwork/mistri/app";',
    'type App = TypedAppConfig<{ incident: "id" | "name"; team: "id" | "name" }>;',
    'const overview = dashboard("Overview", [metric("Open", "incident")]);',
    'const nested = navGroup("operate", "Operate", ["overview", navGroup("queues", "Queues", ["queue"])]);',
    'const app: App = { name: "Test", views: { overview, queue: listView("Queue", "incident"), teams: listView("Teams", "team") },',
    '  home: "overview", nav: [nested, { id: "directory", label: "Directory", children: ["teams"] }] };',
    '// @ts-expect-error Misspelled table in a view nested in a group remains an error.',
    'const wrongTable: App = { name: "Test", views: { queue: listView("Queue", "incidnet") }, nav: [navGroup("operate", "Operate", [navGroup("queues", "Queues", ["queue"])])] };',
    '// @ts-expect-error Dashboard helpers retain their table identity.',
    'const wrongDashboard: App = { name: "Test", views: { overview: dashboard("Overview", [metric("Open", "incidnet")]) }, nav: [navGroup("operate", "Operate", ["overview"])] };',
    '// @ts-expect-error A structural child cannot directly declare a second group owner.',
    'const wrongOwnership: App = { name: "Test", nav: [{ id: "operate", label: "Operate", children: [{ to: "queue", label: "Queue", group: "Other" }] }] };',
  ].join('\n');
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
