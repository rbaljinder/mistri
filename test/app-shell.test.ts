import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import {
  parseAppConfig,
  resolveViews,
  SHELL_GUTTERS,
  SHELL_WIDTHS,
  SHELL_HEADER_WIDTHS,
  type AppDef,
  type AppListView,
  type AppShell,
  type ResolvedListView,
} from '../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { appPayload, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { fieldAccessibleApp } from '../packages/mistri/src/server/app/appFieldProjection.js';
import { projectTenantMetadata } from '../packages/mistri/src/server/tenant/tenantMetadata.js';

/** Every App names its home; a fragment about the shell that names none gets one list, named as the home. */
const parse = (extra: object = {}) =>
  parseAppConfig(
    {
      name: 'Shell',
      resources: { tasks: {} },
      ...('home' in extra ? {} : { views: { tasks: { kind: 'list', from: 'tasks' } }, home: 'tasks' }),
      ...extra,
    },
    'shell fixture',
  );
const booleans = ['menuSearch', 'breadcrumbs', 'heading', 'counts'] as const;
const shell: AppShell = {
  search: false,
  breadcrumbs: false,
  heading: false,
  width: 'narrow',
  headerWidth: 'content',
  gutter: 'compact',
};
const schema: DatabaseSchema = {
  label: 'Shell',
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
const loaded = (app: AppDef): LoadedApp => ({ app, path: 'shell fixture', pages: [], sources: {} });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test('shell stays optional and captures only supplied settings without defaults', () => {
  for (const input of [{}, { ui: {} }, { ui: { shell: undefined } }]) assert.equal(Object.hasOwn(parse(input).ui, 'shell'), false);
  /* A ui.shell with no setting lowers to no shell. */
  for (const input of [{}, { width: undefined, headerWidth: undefined, gutter: undefined }]) {
    assert.equal(Object.hasOwn(parse({ ui: { shell: input } }).ui, 'shell'), false);
  }
  assert.deepEqual(parse({ ui: { shell: { breadcrumbs: false } } }).ui.shell, { breadcrumbs: false });
  const input = { ...shell };
  const parsed = parse({ ui: { shell: input } });
  assert.deepEqual(parsed.ui.shell, shell);
  assert.notEqual(parsed.ui.shell, input);
  input.search = 'everyone';
  assert.equal(parsed.ui.shell!.search, false);
});

test('shell booleans are strict, including migrated breadcrumbs', () => {
  for (const key of booleans) {
    for (const value of [false, true]) assert.deepEqual(parse({ ui: { shell: { [key]: value } } }).ui.shell, { [key]: value });
    for (const value of [null, 0, 1, '', 'false', {}, [], new Boolean(false)]) {
      assert.throws(() => parse({ ui: { shell: { [key]: value } } }), new RegExp(`shell\\.${key}.*true or false`));
    }
  }
  for (const breadcrumbs of [false, true, undefined]) {
    assert.throws(() => parse({ breadcrumbs }), /has no "breadcrumbs"/);
  }
});

test("the header's search is offered to a signed-out visitor only where the App says so", () => {
  assert.deepEqual(parse({ ui: { shell: { search: 'everyone' } } }).ui.shell, { search: 'everyone' });
  assert.deepEqual(parse({ ui: { shell: { search: 'members' } } }).ui.shell, { search: 'members' });
  assert.throws(() => parse({ ui: { shell: { search: true } } }), /search true is now 'members'/);
  assert.throws(() => parse({ ui: { shell: { search: { signedOut: true } } } }), /is now 'everyone'/);
  for (const value of [{ signedOut: false }, 'signedOut', 'yes', 1, { members: true }]) {
    assert.throws(() => parse({ ui: { shell: { search: value } } }), /shell\.search must be 'members', 'everyone' or false/);
  }
});

test('shell accepts exactly the declared object shape and enum strings', () => {
  for (const value of [null, false, 0, 'wide', [], new Date(), new Map()]) {
    assert.throws(() => parse({ ui: { shell: value } }), /"ui\.shell" must be an object/);
  }
  for (const key of ['filterBar', 'contentWidth', 'gutters', 'unknown', '_comment', '$schema']) {
    assert.throws(() => parse({ ui: { shell: { [key]: false } } }), /shell has no/);
  }
  for (const [key, values] of [
    ['width', SHELL_WIDTHS],
    ['headerWidth', SHELL_HEADER_WIDTHS],
    ['gutter', SHELL_GUTTERS],
  ] as const) {
    for (const value of values) assert.deepEqual(parse({ ui: { shell: { [key]: value } } }).ui.shell, { [key]: value });
    for (const value of [
      null,
      false,
      1,
      '',
      'auto',
      ` ${values[0]}`,
      values[0].toUpperCase(),
      [values[0]],
      new String(values[0]),
      { toString: () => values[0] },
    ]) {
      assert.throws(() => parse({ ui: { shell: { [key]: value } } }), new RegExp(`shell\\.${key}.*must be one of`));
    }
  }
  for (const menu of ['side', 'top']) {
    const app = parse({ ui: { shell: { placement: menu, search: false } } });
    assert.deepEqual(app.ui.shell, { placement: menu, search: false });
  }
  assert.throws(() => parse({ ui: { shell: { placement: false } } }), /shell\.placement must be one of/);
  // One way to have no menu: an App without nav. The switch that said it again is refused by name.
  assert.throws(() => parse({ ui: { shell: { menu: false } } }), /ui\.shell has "menu", which is gone: an App with no "nav" has no menu/);
});

test('sidebar is optional static presentation with a strict identity footer', () => {
  const input = { density: 'comfortable' as const, footer: { title: 'Neil, Chris, and Rae', description: 'Premium' } };
  const parsed = parse({ ui: { shell: { sidebar: input } } });
  assert.deepEqual(parsed.ui.shell?.sidebar, input);
  assert.notEqual(parsed.ui.shell?.sidebar, input);
  assert.notEqual(parsed.ui.shell?.sidebar?.footer, input.footer);
  input.footer.title = 'Changed';
  assert.equal(parsed.ui.shell?.sidebar?.footer?.title, 'Neil, Chris, and Rae');

  for (const value of [null, false, '', []]) {
    assert.throws(() => parse({ ui: { shell: { sidebar: value } } }), /"ui\.shell\.sidebar" must be an object/);
  }
  for (const value of [null, false, 0, '', 'roomy', 'Compact']) {
    assert.throws(() => parse({ ui: { shell: { sidebar: { density: value } } } }), /sidebar\.density must be "compact" or "comfortable"/);
  }
  for (const value of [null, false, '', [], { title: 'Workspace', extra: true }]) {
    assert.throws(() => parse({ ui: { shell: { sidebar: { footer: value } } } }), /sidebar\.footer/);
  }
  for (const value of [undefined, null, '', '   ', 0]) {
    assert.throws(
      () => parse({ ui: { shell: { sidebar: { footer: { title: value } } } } }),
      /sidebar\.footer\.title must be a non-blank string/,
    );
  }
  for (const key of ['spacing', 'workspace', 'unknown']) {
    assert.throws(() => parse({ ui: { shell: { sidebar: { [key]: true } } } }), /sidebar has no/);
  }
});

test('filterBar is a strict optional list preference — a bar, a rail or none — independent of filters and tabs', () => {
  const views = (filterBar?: unknown) => ({ tasks: { kind: 'list', from: 'tasks', filterBar, filters: [], tabs: [{ label: 'All' }] } });
  for (const value of [undefined, 'none', 'bar', 'rail']) {
    const app = parse({ views: views(value), home: 'tasks', nav: ['tasks'] });
    const parsed = app.views.tasks as AppListView;
    const resolved = resolveViews(app, schema).tasks;
    assert.ok('table' in resolved);
    assert.equal(Object.hasOwn(parsed, 'filterBar'), value !== undefined);
    assert.equal(Object.hasOwn(resolved, 'filterBar'), value !== undefined);
    assert.equal(resolved.filterBar, value);
    assert.deepEqual(resolved.filters, []);
    assert.deepEqual(resolved.tabs, [{ label: 'All', query: undefined }]);
    assert.equal(resolved.error, undefined);
  }
  for (const value of [null, 0, 1, '', 'false', 'Rail', 'hidden', {}, [], new Boolean(false)]) {
    assert.throws(() => parse({ views: views(value), home: 'tasks', nav: ['tasks'] }), /filterBar.*'bar', 'rail' .* or 'none'/);
  }
  // The booleans it once took are refused with the word that replaced each.
  assert.throws(
    () => parse({ views: views(true), home: 'tasks', nav: ['tasks'] }),
    /"filterBar" is now one of 'bar', 'rail' or 'none': true is 'bar'/,
  );
  assert.throws(
    () => parse({ views: views(false), home: 'tasks', nav: ['tasks'] }),
    /"filterBar" is now one of 'bar', 'rail' or 'none': false is 'none'/,
  );
  // A split's list is the narrow pane: a rail beside it would leave the rows no room.
  assert.throws(
    () =>
      parse({ views: { tasks: { kind: 'list', from: 'tasks', filterBar: 'rail', split: { limit: 25 } } }, home: 'tasks', nav: ['tasks'] }),
    /filterBar 'rail' and a split presentation/,
  );
  assert.throws(() => parse({ filterBar: 'none' }), /has no "filterBar"/);
  assert.throws(
    () =>
      parse({
        views: { home: { kind: 'dashboard', label: 'Home', sections: [{ kind: 'note', text: 'Hello' }], filterBar: 'none' } },
        home: 'home',
        nav: ['home'],
      }),
    /has no "filterBar"/,
  );
  const grouped = parse({ views: views('none'), nav: [{ id: 'work', label: 'Work', children: ['tasks'] }] });
  assert.equal((resolveViews(grouped, schema).tasks as ResolvedListView).filterBar, 'none');
});

test('advancedFilters is a strict optional list preference, preserved through resolution', () => {
  for (const value of [undefined, false, true]) {
    const app = parse({ views: { tasks: { kind: 'list', from: 'tasks', advancedFilters: value } }, home: 'tasks' });
    assert.equal((app.views.tasks as AppListView).advancedFilters, value);
    assert.equal((resolveViews(app, schema).tasks as ResolvedListView).advancedFilters, value);
  }
  for (const value of [null, 'true', 0, {}, []]) {
    assert.throws(
      () => parse({ views: { tasks: { kind: 'list', from: 'tasks', advancedFilters: value } }, home: 'tasks' }),
      /advancedFilters.*true or false/,
    );
  }
});

test('ordinary and tenant metadata preserve shell and filterBar after field projection', () => {
  const app = parse({
    ui: { shell: { ...shell, placement: 'top' } },
    resources: { tasks: { actions: { hidden: { label: 'Hidden', set: { hidden_secret: 'private' } } } } },
    views: { tasks: { kind: 'list', from: 'tasks', filterBar: 'none', filters: [], tabs: [{ label: 'All' }] } },
    home: 'tasks',
    nav: ['tasks'],
  });
  const before = structuredClone(app);
  const projected = fieldAccessibleApp(app, schema);
  assert.deepEqual(projected.ui.shell, { ...shell, placement: 'top' });
  assert.equal((projected.views.tasks as AppListView).filterBar, 'none');
  assert.deepEqual(projected.resources?.tasks.actions, []);
  const ordinary = appPayload(loaded(projected), 'connection', undefined, schema).app!;
  const tenant = projectTenantMetadata(app, [], schema).app;
  for (const result of [ordinary, tenant]) {
    assert.deepEqual(plain(result.ui.shell), { ...shell, placement: 'top' });
    assert.equal(Object.hasOwn(result, 'breadcrumbs'), false);
    const entry = result.views.tasks;
    assert.ok('table' in entry);
    assert.equal(entry.filterBar, 'none');
    assert.deepEqual(plain(entry.filters), []);
    assert.equal(entry.tabs?.[0].label, 'All');
    assert.doesNotMatch(JSON.stringify(result), /hidden_secret|private/);
  }
  assert.deepEqual(app, before);
  assert.notEqual(ordinary.ui.shell, app.ui.shell);
  assert.notEqual(tenant.ui.shell, app.ui.shell);
  app.ui.shell!.breadcrumbs = true;
  assert.equal(ordinary.ui.shell!.breadcrumbs, false);
  assert.equal(tenant.ui.shell!.breadcrumbs, false);
  ordinary.ui.shell!.search = 'everyone';
  assert.equal(app.ui.shell!.search, false);
  assert.equal(Object.isFrozen(tenant.ui.shell), true);
});

test('the shell names its heading switch as a view does', () => {
  assert.throws(() => parse({ ui: { shell: { title: false } } }), /has "title", which is now "heading"/);
});

test('metadata keeps absent and empty shell settings distinct', () => {
  /* An authored empty ui.shell lowers to none, so the empty shell here is the internal one. */
  const bare = parse();
  for (const app of [
    bare,
    { ...bare, ui: { ...bare.ui, shell: {} } },
    parse({ ui: { shell: { heading: true } } }),
    parse({ ui: { shell: { headerWidth: 'full' } } }),
  ]) {
    for (const result of [appPayload(loaded(app), 'connection', undefined, schema).app!, projectTenantMetadata(app, [], schema).app]) {
      assert.equal(Object.hasOwn(result.ui, 'shell'), Object.hasOwn(app.ui, 'shell'));
      assert.deepEqual(result.ui.shell === undefined ? undefined : plain(result.ui.shell), app.ui.shell);
    }
  }
});

test('JSON schema pins the exact shell shape, enums, and list-only filterBar', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  const definition = json.$defs.ui.properties.shell;
  assert.equal(definition.type, 'object');
  assert.equal(definition.additionalProperties, false);
  // `placement` is where the nav sits, beside the shell's other settings.
  assert.deepEqual(
    Object.keys(definition.properties).sort(),
    [...booleans, 'search', 'placement', 'rail', 'width', 'headerWidth', 'gutter', 'sidebar', 'new'].sort(),
  );
  // `new` (0.8.14): the header's New menu, each line a list's view or a command's form, or a group of
  // them under a heading.
  assert.equal(definition.properties.new.minItems, 1);
  const [line, group] = definition.properties.new.items.oneOf;
  assert.deepEqual(line, { $ref: '#/$defs/shellNewEntry' });
  assert.deepEqual(group.required, ['label', 'children']);
  assert.deepEqual(group.properties.children.items, { $ref: '#/$defs/shellNewEntry' });
  assert.deepEqual(
    json.$defs.shellNewEntry.oneOf.map((variant: { required: string[] }) => variant.required),
    [['view'], ['command']],
  );
  assert.deepEqual(definition.properties.placement.oneOf[0].enum, ['side', 'top']);
  // Or the top bar by role: `{ top: [roles] }`, the roles the App declares.
  assert.deepEqual(definition.properties.placement.oneOf[1].properties.top.items, { $ref: '#/$defs/roleName' });
  for (const key of booleans) assert.equal(definition.properties[key].type, 'boolean');
  // The header's search is a member's unless the App offers it to a signed-out visitor too.
  assert.deepEqual(definition.properties.search.anyOf, [{ enum: ['members', 'everyone'] }, { const: false }]);
  assert.deepEqual(definition.properties.width.enum, [...SHELL_WIDTHS]);
  assert.deepEqual(definition.properties.headerWidth.enum, [...SHELL_HEADER_WIDTHS]);
  assert.deepEqual(definition.properties.gutter.enum, [...SHELL_GUTTERS]);
  assert.deepEqual(definition.properties.sidebar.properties.density.enum, ['compact', 'comfortable']);
  assert.deepEqual(definition.properties.sidebar.properties.footer.required, ['title']);
  assert.equal(definition.properties.sidebar.properties.footer.properties.title.pattern, '.*\\S.*');
  assert.equal(definition.required, undefined);
  assert.equal(definition.properties.menuSearch.default, false);
  assert.equal(definition.properties.rail.default, true);
  assert.equal(json.properties.shell, undefined);
  assert.equal(json.properties.breadcrumbs, undefined);
  assert.equal(json.properties.filterBar, undefined);
  assert.deepEqual(json.$defs.listView.properties.filterBar.enum, ['bar', 'rail', 'none']);
  assert.equal(json.$defs.dashboardView.properties.filterBar, undefined);
});

test('public declarations inherit shell and filterBar through TypedAppConfig and list views', () => {
  const filename = new URL('./.app-shell-types.ts', import.meta.url).pathname;
  const source = `import { defineApp, navGroup, type AppConfig, type AppShell, type TypedAppConfig, listView } from '@mistriwork/mistri/app';
    type App = TypedAppConfig<{ tasks: 'id' | 'title' }>;
    const shell: AppShell = {search:'everyone', breadcrumbs:false, heading:true, width:'wide', headerWidth:'content', gutter:'comfortable', sidebar:{density:'comfortable', footer:{title:'Northstar', description:'Premium'}}};
    const ordinary: AppConfig = {name:'Tasks', ui:{logo:'buildings', shell:{...shell, placement:'top'}}, views:{tasks:listView('Tasks', 'tasks', { filterBar:'none', filters:[]})}, home: 'tasks', nav:['tasks']};
    const typed: App = {name:'Tasks', home:'all', ui:{shell:{...shell, placement:'side'}}, views:{all:listView('All', 'tasks', { filterBar:'none'})}, nav:[navGroup('work','Work',['all'])]};
    // A value widened to App does not satisfy defineApp's reference check; a literal does.
    defineApp({name:'Tasks', home:'all', ui:{shell:{...shell, placement:'side'}}, views:{all:listView('All', 'tasks', { filterBar:'none'})}, nav:[navGroup('work','Work',['all'])]} satisfies App);
    defineApp({name:'Empty', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{}}} satisfies App);
    defineApp({name:'Full header', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{headerWidth:'full'}}} satisfies App);
    defineApp({name:'Omitted', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks'} satisfies App);
    defineApp({name:'Rail', views:{tasks:listView('Tasks', 'tasks', { filterBar:'rail'})}, home:'tasks'} satisfies App);
    // @ts-expect-error Root breadcrumbs was replaced.
    const old: AppConfig = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', breadcrumbs:false};
    // @ts-expect-error shell lives under ui, not the root.
    const legacy: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', shell};
    // @ts-expect-error Typed apps inherit strict shell keys.
    const unknown: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{filterBar:false}}};
    // @ts-expect-error Menu visibility is a boolean, separate from placement.
    const menu: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{menu:'top'}}};
    // @ts-expect-error No null shell.
    const nil: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:null}};
    // @ts-expect-error No null shell fields.
    const field: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{breadcrumbs:null}}};
    // @ts-expect-error Width is a closed enum.
    const width: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{width:'auto'}}};
    // @ts-expect-error Header width is a separate closed enum.
    const header: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{headerWidth:'narrow'}}};
    // @ts-expect-error Header width does not coerce booleans.
    const headerBoolean: AppConfig = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{headerWidth:false}}};
    // @ts-expect-error Header width cannot be null.
    const headerNull: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{headerWidth:null}}};
    // @ts-expect-error Gutter is a closed enum.
    const gutter: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{gutter:'wide'}}};
    // @ts-expect-error Sidebar density is a closed enum.
    const sidebarDensity: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{sidebar:{density:'roomy'}}}};
    // @ts-expect-error A sidebar footer always names its static workspace identity.
    const sidebarFooter: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{sidebar:{footer:{description:'Premium'}}}}};
    // @ts-expect-error Sidebar footer has no switching or action settings.
    const sidebarUnknown: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{shell:{sidebar:{footer:{title:'Northstar', action:'switch'}}}}};
    // @ts-expect-error The types take any lowercase word as a logo (check refuses a URL), so they refuse only the rest.
    const logo: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks', ui:{logo:'Buildings'}};
    // @ts-expect-error Filter bar is 'bar', 'rail' or 'none'.
    const filter: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks', { filterBar:false})}, home: 'tasks', nav:['tasks']};
    // @ts-expect-error Labelled list views take the same filterBar values.
    const labelled: App = {name:'Tasks', views:{all:listView('All', 'tasks', { filterBar:null})}, home: 'all', nav:['all']};
    // @ts-expect-error Root filterBar is not a setting.
    const root: App = {name:'Tasks', views:{tasks:listView('Tasks', 'tasks')}, home:'tasks',filterBar:false};
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
