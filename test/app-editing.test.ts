import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import { appAllowsWrite, parseAppConfig, resolveAppAccess, type AppDef, type AppEditing } from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { appPayload, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { fieldAccessibleApp } from '../packages/mistri/src/server/app/appFieldProjection.js';
import { projectTenantMetadata } from '../packages/mistri/src/server/tenant/tenantMetadata.js';
import type { TenantCapabilities } from '../packages/mistri/src/server/tenant/tenantCapabilities.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';

const view = { kind: 'list', from: 'tasks' };
const parse = (extra: object = {}) =>
  parseAppConfig(
    { name: 'Editing', resources: { tasks: {} }, views: { tasks: view }, home: 'tasks', nav: ['tasks'], ...extra },
    'editing fixture',
  );
const schema: DatabaseSchema = {
  label: 'Editing',
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
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
      ],
    },
  ],
};
const loaded = (app: AppDef): LoadedApp => ({ app, path: 'editing fixture', pages: [], sources: {} });
const ordinary = (app: AppDef) => appPayload(loaded(app), 'connection', undefined, schema).app!;
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test('editing omission stays omitted and supplied save modes normalize into detached settings', () => {
  for (const input of [{}, { ui: {} }, { ui: { editing: undefined } }]) assert.equal(Object.hasOwn(parse(input).ui, 'editing'), false);
  for (const save of ['explicit', 'blur'] as const) {
    const editing: AppEditing = { save };
    const app = parse({ ui: { editing } });
    assert.deepEqual(app.ui.editing, { save });
    assert.notEqual(app.ui.editing, editing);
    editing.save = save === 'blur' ? 'explicit' : 'blur';
    assert.equal(app.ui.editing!.save, save);
    assert.deepEqual(parse({ ui: { editing: app.ui.editing } }).ui.editing, app.ui.editing);
    assert.deepEqual(parse({ ui: { editing: Object.assign(Object.create(null), { save }) } }).ui.editing, { save });
  }
});

test('editing requires a plain object and a present exact save enum, without coercion', () => {
  for (const editing of [
    null,
    false,
    true,
    0,
    1,
    '',
    'blur',
    [],
    ['blur'],
    new Date(),
    new Map(),
    new String('blur'),
    Object.create({ save: 'blur' }),
  ]) {
    assert.throws(() => parse({ ui: { editing } }), /editing fixture: "ui\.editing" must be an object/);
  }
  assert.throws(() => parse({ ui: { editing: {} } }), /editing.save is required/);
  for (const save of [
    undefined,
    null,
    false,
    true,
    0,
    1,
    '',
    'auto',
    'Blur',
    'BLUR',
    ' blur',
    'explicit ',
    [],
    ['blur'],
    {},
    new String('blur'),
    { toString: () => 'blur' },
  ]) {
    assert.throws(() => parse({ ui: { editing: { save } } }), /editing.save is required.*"explicit" or "blur"/);
  }
});

test('editing rejects every unknown nested key, including annotations and non-JSON own keys', () => {
  for (const key of ['mode', 'onBlur', 'debounce', 'writable', 'saveMode', '_comment', '$schema', '__proto__']) {
    assert.throws(() => parse({ ui: { editing: { save: 'blur', [key]: undefined } } }), /editing has no/);
  }
  assert.throws(() => parse({ ui: { editing: { save: 'blur', [Symbol('extra')]: true } } }), /editing has no/);
  assert.throws(() => parse({ ui: { editing: Object.defineProperty({ save: 'blur' }, 'extra', { value: true }) } }), /editing has no/);
  assert.throws(() => parse({ save: 'blur' }), /has no "save"/);
  assert.throws(
    () => parse({ editing: { save: 'blur' } }),
    /has no "editing"\. "editing" belongs inside "ui"\. It takes: id, name, connection, sources, resources, unions, auth, views, pages, features, home, nav, ui, branding, api, track, live, flags, audiences, experiments, analytics, assistant, retention\./,
  );
  for (const extra of [
    { views: { tasks: { ...view, editing: { save: 'blur' } } } },
    { resources: { tasks: { form: { editing: { save: 'blur' } } } } },
    { views: { tasks: { ...view, presentation: { kind: 'checklist', primary: 'title', checked: 'id', editing: { save: 'blur' } } } } },
  ])
    assert.throws(() => parse(extra), /has no "editing"/);
});

test('ordinary and tenant metadata preserve omission or explicit opt-in without changing other projection', () => {
  // access 'read' on every resource: the App writes nothing.
  const resources = {
    tasks: {
      form: { show: ['title'] },
      actions: {
        rename: { label: 'Rename', set: { title: 'Updated' } },
        private: { label: 'Private', set: { hidden_secret: 'private value' } },
      },
    },
  };
  const capabilities: TenantCapabilities = {
    writable: ['tasks'],
    grantedCommands: ['existing-command'],
    resources: { tasks: { write: ['title'], insertable: true, deletable: false } },
  };
  for (const save of [undefined, 'explicit', 'blur'] as const) {
    const app = parse({ resources, ...(save ? { ui: { editing: { save } } } : {}) });
    const before = structuredClone(app);
    const projected = fieldAccessibleApp(app, schema);
    assert.deepEqual(projected.ui.editing, app.ui.editing);
    const baseline = parse({ resources });
    const pairs = [
      [ordinary(projected), ordinary(fieldAccessibleApp(baseline, schema))],
      [projectTenantMetadata(app, [], schema).app, projectTenantMetadata(baseline, [], schema).app],
      [projectTenantMetadata(app, [], schema, capabilities).app, projectTenantMetadata(baseline, [], schema, capabilities).app],
    ] as const;
    for (const [result, withoutSetting] of pairs) {
      assert.equal(Object.hasOwn(result.ui, 'editing'), save !== undefined);
      assert.deepEqual(result.ui.editing === undefined ? undefined : plain(result.ui.editing), save ? { save } : undefined);
      const {
        ui: { editing: _editing, ...ui },
        ...rest
      } = result;
      assert.deepEqual(plain({ ...rest, ui }), plain(withoutSetting));
      assert.doesNotMatch(JSON.stringify(result), /hidden_secret|private value/);
      if (save) assert.notEqual(result.ui.editing, app.ui.editing);
    }
    assert.deepEqual(app, before);
    assert.deepEqual(projectTenantMetadata(app, [], schema).app.writableTables, []);
    assert.deepEqual(projectTenantMetadata(app, [], schema).app.grantedCommands, []);
    assert.deepEqual(plain(projectTenantMetadata(app, [], schema, capabilities).app.writableTables), ['tasks']);
    if (save) {
      const publicApp = pairs[0][0];
      const tenantApp = pairs[1][0];
      assert.equal(Object.isFrozen(tenantApp.ui.editing), true);
      app.ui.editing!.save = save === 'blur' ? 'explicit' : 'blur';
      assert.equal(publicApp.ui.editing!.save, save);
      assert.equal(tenantApp.ui.editing!.save, save);
    }
  }
});

test('editing cannot widen resource or field grants or legacy writable ceilings', () => {
  const granted = {
    resources: { tasks: { access: 'write', fields: { read: ['id', 'title'], write: ['title'] } } },
    auth: { roles: { reader: { read: true }, editor: { read: true, write: true } } },
  };
  for (const save of ['explicit', 'blur'] as const) {
    for (const role of ['reader', 'editor', 'unknown']) {
      const app = parse({ ...granted, ui: { editing: { save } } });
      assert.deepEqual(resolveAppAccess(app, schema, [role]), resolveAppAccess(parse(granted), schema, [role]));
      assert.equal(appAllowsWrite(app, schema, 'tasks', role), role === 'editor');
    }
    // No ceiling, a read ceiling and a write ceiling: writable true, false and ['tasks'].
    for (const resources of [{ tasks: {} }, { tasks: {} }, { tasks: { access: 'write' } }]) {
      const app = parse({ resources, ui: { editing: { save } } });
      assert.deepEqual(resolveAppAccess(app, schema, []), resolveAppAccess(parse({ resources }), schema, []));
      assert.equal(appAllowsWrite(app, schema, 'tasks'), appAllowsWrite(parse({ resources }), schema, 'tasks'));
    }
  }
});

test('JSON schema has an optional strict editing block with required save and no materialized default', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  const editing = json.$defs.ui.properties.editing;
  assert.equal(json.properties.editing, undefined);
  assert.equal((json.$defs.ui.required ?? []).includes('editing'), false);
  assert.equal(editing.type, 'object');
  assert.equal(editing.additionalProperties, false);
  assert.deepEqual(editing.required, ['save']);
  assert.deepEqual(Object.keys(editing.properties), ['save']);
  assert.equal(editing.properties.save.type, 'string');
  assert.deepEqual(editing.properties.save.enum, ['explicit', 'blur']);
  assert.doesNotMatch(JSON.stringify(editing), /"default":/);
  assert.equal(json.$defs.listView.properties.editing, undefined);
  assert.equal(json.$defs.dashboardView.properties.editing, undefined);
});

test('public DSL and generated checked App types accept only the ui.editing contract', () => {
  // Virtual files exercise actual package resolution and generated declarations
  // without touching shared fixtures or watching an authored App directory.
  const filename = new URL('./.app-editing-types.ts', import.meta.url).pathname;
  const generated = new URL('./.app-editing-schema.d.ts', import.meta.url).pathname;
  const source = `import { defineApp, type AppConfig, type AppEditing, type TypedAppConfig, listView } from '@mistriwork/mistri/app';
    import type { App } from './.app-editing-schema.js';
    const editing: AppEditing = {save:'blur'};
    const ordinary: AppConfig = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing}};
    const typed: TypedAppConfig<{tasks:'id'|'title'}> = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:'explicit'}}};
    // A value widened to AppConfig does not satisfy defineApp's reference check; literals do.
    defineApp({name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing}} satisfies AppConfig);
    defineApp({name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:'explicit'}}} satisfies TypedAppConfig<{tasks:'id'|'title'}>);
    defineApp({name:'Tasks', ui:{editing}, views:{tasks:listView('Tasks', 'tasks', { show:['title']})}, home: 'tasks', nav:['tasks']} satisfies App);
    defineApp({name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:'explicit'}}} satisfies App);
    defineApp({name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks'} satisfies App);
    // @ts-expect-error Save is required whenever editing is supplied.
    const empty: AppConfig = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{}}};
    // @ts-expect-error Required save cannot be undefined.
    const missing: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:undefined}}};
    // @ts-expect-error No null block.
    const nil: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:null}};
    // @ts-expect-error No boolean block.
    const flag: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:true}};
    // @ts-expect-error No array block.
    const array: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:[]}};
    // @ts-expect-error No null save.
    const nullSave: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:null}}};
    // @ts-expect-error No coercion.
    const booleanSave: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:true}}};
    // @ts-expect-error Save is a closed enum.
    const mode: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:'auto'}}};
    // @ts-expect-error Unknown nested settings are refused.
    const nested: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:'blur', debounce:100}}};
    // @ts-expect-error Annotations are not nested editing keys.
    const annotation: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{editing:{save:'blur', _comment:'no'}}};
    // @ts-expect-error editing is not a root key.
    const root: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', editing};
    // @ts-expect-error Lists cannot override the active App policy.
    const list: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { editing:{save:'blur'}})}, home: 'tasks', nav:['tasks']};
    // @ts-expect-error New forms do not own this setting.
    const form: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', resources:{tasks:{form:{editing:{save:'blur'}}}}};
    // @ts-expect-error Generated config still checks real resource names.
    const resource: App = {name:'Tasks', ui:{editing}, views:{missing:listView('Missing', 'missing')}, home: 'missing', nav:['missing']};
  `;
  const files = new Map([
    [filename, source],
    [generated, typesForSchema(schema, 'Editing')],
  ]);
  assert.equal(typecheck(filename, { files: Object.fromEntries(files) }), '');
});
