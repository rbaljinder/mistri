import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import {
  parseAppConfig,
  resolveAppAccess,
  resolveResources,
  resolveViews,
  type AppListView,
  type ResolvedListView,
} from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const list = { kind: 'checklist', primary: 'title', checked: 'done', lines: ['due'] } as const;
const parse = (view: object = {}, resources: object = {}) =>
  parseAppConfig(
    {
      name: 'Tasks',
      resources: { tasks: {}, ...resources },
      views: { tasks: { kind: 'list', from: 'tasks', presentation: list, ...view } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'checklist fixture',
  );
const schema: DatabaseSchema = {
  label: 'Tasks',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'tasks',
      name: 'tasks',
      schema: '',
      isView: false,
      columns: [
        { name: 'tenant', type: 'TEXT', nullable: false, primaryKey: true },
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'done', type: 'BOOLEAN', nullable: false, primaryKey: false },
        { name: 'due', type: 'DATE', nullable: true, primaryKey: false },
      ],
    },
  ],
};

test('checklist and quickAdd round-trip independently without changing show or curated New form', () => {
  const form = { show: ['title'], defaults: { tenant: 'personal', id: 1, done: false } };
  const app = parse({ quickAdd: true, show: ['title'] }, { tasks: { form } });
  const entry = resolveViews(app, schema).tasks as ResolvedListView;
  assert.equal(entry.error, undefined);
  assert.deepEqual(entry.presentation, list);
  assert.equal(entry.quickAdd, true);
  assert.deepEqual(resolveResources(app, schema).resources.tasks.form, form);
  assert.deepEqual(entry.show, ['title']);
  assert.equal((parse().views.tasks as AppListView).quickAdd, undefined);
  const quickOnly = parse({ presentation: undefined, quickAdd: true });
  assert.equal((quickOnly.views.tasks as AppListView).presentation, undefined);
  assert.equal(resolveViews(quickOnly, schema).tasks.error, undefined);
  const minimal = parse({ presentation: { kind: 'checklist', primary: ' title ', checked: ' done ' } });
  assert.deepEqual((minimal.views.tasks as AppListView).presentation, { kind: 'checklist', primary: 'title', checked: 'done' });
});

test('checklist parser rejects unknown keys, invalid shapes and paths; quickAdd is true or false', () => {
  for (const value of [
    null,
    false,
    'checklist',
    [],
    {},
    { ...list, kind: 'board' },
    { ...list, path: 'tasks' },
    ...['primary', 'checked'].flatMap((key) => [null, 4, '', ' ', 'owner.name'].map((value) => ({ ...list, [key]: value }))),
    ...[null, 4, '', ' ', 'owner.name'].map((value) => ({ ...list, lines: [value] })),
    { ...list, primary: undefined },
    { ...list, checked: undefined },
  ])
    assert.throws(() => parse({ presentation: value }), /checklist fixture.*presentation/);
  for (const quickAdd of [null, 1, 'true', {}, { api: '/new' }]) {
    assert.throws(() => parse({ quickAdd }), /quickAdd.*must be true .* or false/);
  }
  // false says what leaving it out says.
  assert.equal((parse({ quickAdd: false }).views.tasks as AppListView).quickAdd, undefined);
  assert.throws(() => parse({ quickadd: true }), /has no "quickadd"/);
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'Tasks',
          views: { home: { kind: 'dashboard', label: 'Home', sections: [{ kind: 'note', text: 'Hi' }], presentation: list } },
          home: 'home',
          nav: ['home'],
        },
        'fixture',
      ),
    /has no "presentation"/,
  );
});

test('checklist catalog validation requires local text title, declared boolean and readable detail', () => {
  for (const [key, value] of [
    ['primary', 'missing'],
    ['checked', 'missing'],
    ['lines', ['missing']],
    ['primary', 'id'],
    ['checked', 'title'],
  ]) {
    assert.match(resolveViews(parse({ presentation: { ...list, [key as string]: value } }), schema).tasks.error!, /Checklist/);
  }
  for (const type of ['BOOLEAN', 'BOOL', 'boolean']) {
    const catalog = structuredClone(schema);
    catalog.tables[0].columns[3].type = type;
    assert.equal(resolveViews(parse(), catalog).tasks.error, undefined);
  }
  const integerFlag = structuredClone(schema);
  integerFlag.tables[0].columns[3].type = 'INTEGER';
  assert.match(resolveViews(parse(), integerFlag).tasks.error!, /boolean.*SQLite/);
  const noKey = structuredClone(schema);
  for (const column of noKey.tables[0].columns) column.primaryKey = false;
  assert.match(resolveViews(parse(), noKey).tasks.error!, /complete readable primary key/);
  const qualified = structuredClone(schema);
  qualified.tables[0].id = 'personal.tasks';
  assert.equal(resolveViews(parse({}, { tasks: { physical: 'personal.tasks' } }), qualified).tasks.error, undefined);
});

test('checklists and quickAdd never grant writes, and field access retains every composite key column', () => {
  const app = parseAppConfig(
    {
      name: 'Tasks',
      auth: { roles: { reader: { read: true } } },
      resources: { tasks: { fields: { read: ['tenant', 'id', 'title', 'done', 'due'] } } },
      views: { tasks: { kind: 'list', from: 'tasks', presentation: list, quickAdd: true } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'fixture',
  );
  const access = resolveAppAccess(app, schema, ['reader']);
  assert.deepEqual(access.writable, new Set());
  assert.deepEqual(access.fields?.get('tasks')?.write, new Set());
  for (const key of ['tenant', 'id']) {
    const narrowed = structuredClone(app);
    narrowed.resources!.tasks.fields!.read = narrowed.resources!.tasks.fields!.read.filter((name) => name !== key);
    assert.throws(() => resolveAppAccess(narrowed, schema, ['reader']), /complete primary key readable/);
  }
});

test('JSON schema pins checklist keys, local columns and a boolean quickAdd', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.$defs.listView.properties.quickAdd.type, 'boolean');
  // The checklist is the first of the list presentations; the queue, board and split follow it.
  const list = json.$defs.presentation.oneOf[0];
  assert.equal(list.additionalProperties, false);
  assert.deepEqual(list.required, ['kind', 'primary', 'checked']);
  assert.deepEqual(Object.keys(list.properties), ['kind', 'primary', 'checked', 'lines']);
  assert.equal(list.properties.kind.const, 'checklist');
  assert.equal(list.properties.lines.maxItems, 1);
  for (const key of ['primary', 'checked', 'lines']) {
    const pattern = new RegExp((key === 'lines' ? list.properties[key].items : list.properties[key]).pattern);
    assert.equal(pattern.test('task title'), true);
    for (const value of ['', ' ', 'owner.name', '.name', 'name.']) assert.equal(pattern.test(value), false);
  }
});

test('public TypedAppConfig checks local checklist keys on the view, grouped in nav or not', () => {
  const filename = new URL('./.app-checklist-types.ts', import.meta.url).pathname;
  const source = `import { defineApp, navGroup, type TypedAppConfig, checklist, listView } from '@mistriwork/mistri/app';
    type App = TypedAppConfig<{tasks: 'id'|'title'|'done'|'due'; people: 'id'|'name'|'active'}>;
    const list = checklist('title', 'done', { lines: ['due']});
    const valid = defineApp({name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { presentation: list, quickAdd:true})}, home: 'tasks', nav:['tasks']} satisfies App);
    const inferred: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { presentation:checklist('title', 'done')})}, home: 'tasks'};
    const nested: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { presentation: list})}, home: 'tasks', nav:[navGroup('work', 'Work', ['tasks'])]};
    // @ts-expect-error Checklist columns belong to the owning resource.
    const wrongTable: App = {name:'Tasks', views:{people:listView('People', 'people', { presentation: list})}};
    // @ts-expect-error Primary cannot be a missing column.
    const wrongTitle: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { presentation:{...list, primary:'name'}})}};
    // @ts-expect-error Checked cannot be a missing column.
    const wrongChecked: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { presentation:{...list, checked:'active'}})}};
    // @ts-expect-error A line cannot be a relationship path.
    const path: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { presentation:{...list, lines:['owner.name']}})}};
    // @ts-expect-error Quick-add is true or false.
    const spelled: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { quickAdd:'yes'})}};
    const disabled: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { quickAdd:false})}, home: 'tasks'};
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
