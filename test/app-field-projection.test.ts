import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldAccessibleApp, fieldAccessiblePage, readablePage } from '../packages/mistri/src/server/app/appFieldProjection.js';
import {
  resolveResources,
  resolveViews,
  type AppAction,
  type AppDef,
  type AppForm,
  type AppListView,
} from '../packages/mistri/src/shared/app.js';
import { validatePage, type PageDef, type PageSection } from '../packages/engine/src/shared/page.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const col = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'TEXT',
  nullable: true,
  primaryKey: false,
  ...extra,
});
const schema: DatabaseSchema = {
  label: 'Field projection',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'incident',
      name: 'incident',
      schema: '',
      isView: false,
      columns: [
        col('id', { type: 'INTEGER', nullable: false, primaryKey: true, writable: false, identity: 'by-default' }),
        col('name'),
        col('status'),
        col('site_id'),
        col('readonly', { writable: false }),
        col('revision', { type: 'INTEGER', nullable: false, writable: false }),
      ],
    },
    {
      id: 'note',
      name: 'note',
      schema: '',
      isView: false,
      columns: [
        col('id', { type: 'INTEGER', nullable: false, primaryKey: true, writable: false, identity: 'by-default' }),
        col('incident_id'),
        col('site_id'),
        col('name'),
        col('amount', { type: 'NUMERIC' }),
        col('at', { type: 'TIMESTAMP' }),
        col('readonly', { writable: false }),
      ],
    },
    {
      id: 'site',
      name: 'site',
      schema: '',
      isView: false,
      columns: [col('id', { type: 'INTEGER', nullable: false, primaryKey: true }), col('name')],
    },
  ],
  foreignKeys: [
    { name: 'note_incident', from: { table: 'note', columns: ['incident_id'] }, to: { table: 'incident', columns: ['id'] } },
    { name: 'incident_site', from: { table: 'incident', columns: ['site_id'] }, to: { table: 'site', columns: ['id'] } },
    { name: 'note_site', from: { table: 'note', columns: ['site_id'] }, to: { table: 'site', columns: ['id'] } },
  ],
};
const page = (...sections: PageSection[]): PageDef => ({ id: 'record', name: 'Record', base: 'incident', sections });
const list = { kind: 'list' as const, from: 'note', path: 'incident_id' };
const stream = { from: 'note', path: 'incident_id', at: 'at', show: 'name' };
const literal = 'PRIVATE_LITERAL';

test('page validation and projection both reject unavailable shown fields without mutating definitions', () => {
  const definition = page(
    { kind: 'fields', paths: ['hidden_secret'] },
    { ...list, columns: ['hidden_secret'], filter: `hidden_secret = ${literal}` },
  );
  const before = structuredClone(definition);
  assert.match(validatePage(schema, definition).error!, /section 1:.*hidden_secret/);
  assert.equal(fieldAccessiblePage(schema, definition), false);
  assert.deepEqual(definition, before);
});

const hiddenSections: Array<[string, PageSection]> = [
  ['fields path', { kind: 'fields', paths: ['hidden_secret'] }],
  ['fields joined path', { kind: 'fields', paths: ['site_id.hidden_secret'] }],
  ['fields hidden hop', { kind: 'fields', paths: ['hidden_id.name'] }],
  ['workflow', { kind: 'fields', workflow: { field: 'hidden_secret', steps: [{ value: literal, label: 'Private' }] } }],
  ['list columns', { ...list, columns: ['hidden_secret'] }],
  ['list joined columns', { ...list, columns: ['site_id.hidden_secret'] }],
  ['list filter', { ...list, filter: `hidden_secret = ${literal}` }],
  ['list joined filter', { ...list, filter: `site_id.hidden_secret = ${literal}` }],
  ['list order', { ...list, orderBy: [{ column: 'hidden_secret', direction: 'asc' }] }],
  ['list joined order', { ...list, orderBy: [{ column: 'site_id.hidden_secret', direction: 'asc' }] }],
  ['list hidden relationship', { ...list, path: 'hidden_id' }],
  ['list hidden about', { ...list, path: 'site_id', of: 'hidden_id' }],
  ['list about still validates child', { ...list, path: 'site_id', of: 'site_id', columns: ['hidden_secret'] }],
  ['related creation show', { ...list, create: { label: 'Add', show: ['hidden_secret'] } }],
  ['related creation readonly', { ...list, create: { label: 'Add', show: ['readonly'] } }],
  ['metric sum', { kind: 'metric', from: 'note', path: 'incident_id', fn: 'sum', column: 'hidden_secret' }],
  ['metric count column', { kind: 'metric', from: 'note', path: 'incident_id', fn: 'count', column: 'hidden_secret' }],
  ['metric filter', { kind: 'metric', from: 'note', path: 'incident_id', fn: 'count', filter: `hidden_secret = ${literal}` }],
  ['breakdown key', { kind: 'breakdown', from: 'note', path: 'incident_id', by: 'hidden_secret' }],
  ['breakdown joined key', { kind: 'breakdown', from: 'note', path: 'incident_id', by: 'site_id.hidden_secret' }],
  ['breakdown filter', { kind: 'breakdown', from: 'note', path: 'incident_id', by: 'name', filter: `hidden_secret = ${literal}` }],
  ['timeline date', { kind: 'timeline', streams: [{ ...stream, at: 'hidden_secret' }] }],
  ['timeline show', { kind: 'timeline', streams: [{ ...stream, show: 'hidden_secret' }] }],
  ['timeline detail', { kind: 'timeline', streams: [{ ...stream, detail: 'site_id.hidden_secret' }] }],
  ['timeline filter', { kind: 'timeline', streams: [{ ...stream, filter: `hidden_secret = ${literal}` }] }],
  ['timeline relationship', { kind: 'timeline', streams: [{ ...stream, path: 'hidden_id' }] }],
];
for (const [name, section] of hiddenSections) {
  test(`page projection refuses ${name}, including hidden and conditional sections`, () => {
    for (const visibility of [{}, { hidden: true }, { when: 'status = never' }]) {
      assert.equal(fieldAccessiblePage(schema, page({ ...section, ...visibility })), false);
    }
  });
}

test('every section kind rejects a forbidden root predicate', () => {
  const sections: PageSection[] = [
    { kind: 'fields' },
    list,
    { kind: 'metric', from: 'note', path: 'incident_id', fn: 'count' },
    { kind: 'breakdown', from: 'note', path: 'incident_id', by: 'name' },
    { kind: 'timeline', streams: [stream] },
  ];
  for (const section of sections)
    assert.equal(fieldAccessiblePage(schema, page({ ...section, when: `hidden_secret = ${literal}` })), false);
});

test('readable sections retain defaults, paths, comparisons, sorting and non-null about planning', () => {
  const definition = page(
    { kind: 'fields' },
    { kind: 'fields', paths: [] },
    { kind: 'fields', paths: ['readonly', 'site_id.name'], workflow: { field: 'status', steps: [{ value: 'open', label: 'Open' }] } },
    list,
    { ...list, columns: [] },
    { ...list, columns: ['name', 'site_id.name'], filter: 'name = PRIVATE_LITERAL', orderBy: [{ column: 'at', direction: 'desc' }] },
    { ...list, path: 'site_id', of: 'site_id', columns: ['name'] },
    { ...list, create: { label: 'Add', show: ['name', 'id'] } },
    { kind: 'metric', from: 'note', path: 'incident_id', fn: 'count', filter: 'name contains hello' },
    { kind: 'metric', from: 'note', path: 'incident_id', fn: 'sum', column: 'amount' },
    { kind: 'breakdown', from: 'note', path: 'site_id', of: 'site_id', by: 'site_id.name', filter: 'name contains hello' },
    { kind: 'timeline', streams: [stream, { ...stream, detail: 'readonly', filter: 'name contains hello' }] },
  );
  const before = structuredClone(definition);
  for (const section of definition.sections) assert.equal(fieldAccessiblePage(schema, page(section)), true, JSON.stringify(section));
  assert.equal(fieldAccessiblePage(schema, definition), true);
  assert.deepEqual(definition, before);
  assert.equal(fieldAccessiblePage(schema, page()), true);
});

test('related creation requires writable parent bindings and preserves schema-derived forms', () => {
  assert.equal(fieldAccessiblePage(schema, page({ ...list, create: { label: 'Add' } })), true);
  const readonlyBinding = structuredClone(schema);
  readonlyBinding.tables[1].columns.find((column) => column.name === 'incident_id')!.writable = false;
  assert.equal(fieldAccessiblePage(readonlyBinding, page({ ...list, create: { label: 'Add', show: ['name'] } })), false);
  const allWritable = structuredClone(schema);
  allWritable.tables[1].columns.find((column) => column.name === 'readonly')!.writable = true;
  assert.equal(fieldAccessiblePage(allWritable, page({ ...list, create: { label: 'Add' } })), true);
});

test('page projection refuses unavailable roots, invalid plans and stored error text', () => {
  assert.equal(fieldAccessiblePage(schema, { ...page(), base: 'hidden_table' }), false);
  assert.equal(fieldAccessiblePage(schema, { ...page(), error: literal }), false);
  assert.equal(
    fieldAccessiblePage(schema, page({ kind: 'metric', from: 'note', path: 'incident_id', fn: 'sum', column: 'amount', filter: 'name >' })),
    false,
  );
  // A narrowed sum is a plan now (a keyless breakdown), and compiles like one.
  assert.equal(
    fieldAccessiblePage(
      schema,
      page({ kind: 'metric', from: 'note', path: 'incident_id', fn: 'sum', column: 'amount', filter: 'name = hello' }),
    ),
    true,
  );
  assert.equal(fieldAccessiblePage(schema, page({ kind: 'future' } as unknown as PageSection)), false);
});

test('source-qualified pages retain logical identity during section planning', () => {
  const qualified = structuredClone(schema);
  const qualify = (name: string) => `support.${name}`;
  for (const table of qualified.tables) table.id = qualify(table.id);
  for (const fk of qualified.foreignKeys) {
    fk.from.table = qualify(fk.from.table);
    fk.to.table = qualify(fk.to.table);
  }
  const definition: PageDef = { ...page({ ...list, from: 'support.note', columns: ['site_id.name'] }), base: 'support.incident' };
  assert.equal(fieldAccessiblePage(qualified, definition), true);
  definition.sections.push({ kind: 'fields', paths: ['site_id.hidden_secret'] });
  assert.equal(fieldAccessiblePage(qualified, definition), false);
});

test('composite parent keys and related-create bindings are checked in full', () => {
  const composite = structuredClone(schema);
  composite.tables[0].columns.push(col('tenant', { primaryKey: true, nullable: false }));
  composite.tables[1].columns.push(col('tenant'));
  composite.foreignKeys[0].from.columns.push('tenant');
  composite.foreignKeys[0].to.columns.push('tenant');
  const definition = page({ ...list, path: 'note_incident', create: { label: 'Add', show: ['name'] } });
  assert.equal(fieldAccessiblePage(composite, definition), true);
  composite.tables[1].columns.find((column) => column.name === 'tenant')!.writable = false;
  assert.equal(fieldAccessiblePage(composite, definition), false);
});

/** One list over `incident`; the New form and the actions are its resource's. */
/** A projection that still resolves clean: its list draws, and its resource's actions and form run. */
const clean = (projected: AppDef, catalog: Parameters<typeof resolveViews>[1]) => {
  assert.equal(resolveViews(projected, catalog).incidents.error, undefined);
  assert.deepEqual(resolveResources(projected, catalog).problems, []);
};
const app = ({
  form,
  actions,
  ...view
}: Omit<Partial<AppListView>, 'actions'> & { form?: AppForm; actions?: AppAction[] } = {}): AppDef => ({
  id: 'fields',
  name: 'Fields',
  ui: {},
  views: { incidents: { table: 'incident', ...view } },
  nav: [{ view: 'incidents' }],
  home: [{ view: 'incidents' }],
  ...(form || actions ? { resources: { incident: { ...(form ? { form } : {}), ...(actions ? { actions } : {}) } } } : {}),
});

test('record labels retain an authorized path and redact an unavailable one to the false sentinel', () => {
  const definition: AppDef = {
    id: 'labels',
    name: 'Labels',
    ui: {},
    views: { incidents: { table: 'incident' } },
    nav: [{ view: 'incidents' }],
    home: [{ view: 'incidents' }],
    resources: { incident: { recordLabel: 'site_id.name' } },
  };
  assert.equal(fieldAccessibleApp(definition, schema).resources?.incident.recordLabel, 'site_id.name');
  const restricted = structuredClone(schema);
  restricted.tables = restricted.tables.filter((table) => table.id !== 'site');
  restricted.foreignKeys = restricted.foreignKeys.filter((key) => key.to.table !== 'site');
  const projected = fieldAccessibleApp(definition, restricted);
  assert.equal(projected.resources?.incident.recordLabel, false);
  assert.doesNotMatch(JSON.stringify(projected), /site_id\.name/);
  assert.equal(resolveResources(projected, restricted).resources.incident.recordLabel, false);
  assert.deepEqual(definition.resources?.incident.recordLabel, 'site_id.name');
});

test('checklist projection drops all metadata when any local column is unavailable', () => {
  const catalog = structuredClone(schema);
  catalog.tables[0].columns.push(col('done', { type: 'BOOLEAN' }));
  const list = { kind: 'checklist' as const, primary: 'name', checked: 'done', lines: ['readonly'] };
  for (const patch of [{ primary: 'hidden_secret' }, { checked: 'hidden_secret' }, { lines: ['hidden_secret'] }]) {
    const definition = app({ presentation: { ...list, ...patch } });
    const before = structuredClone(definition);
    const projected = fieldAccessibleApp(definition, catalog);
    assert.deepEqual(Object.keys(projected.views), ['incidents']);
    assert.equal(Object.hasOwn(projected.views.incidents, 'presentation'), false);
    assert.doesNotMatch(JSON.stringify(projected), /hidden_secret/);
    clean(projected, catalog);
    assert.deepEqual(definition, before);
  }
  const definition = app({ presentation: list });
  assert.deepEqual(fieldAccessibleApp(definition, catalog), definition);
  catalog.tables[0].columns.find((column) => column.name === 'done')!.writable = false;
  const before = structuredClone(catalog);
  assert.deepEqual(fieldAccessibleApp(definition, catalog), definition);
  assert.deepEqual(catalog, before, 'readable checklist metadata cannot grant checked-field writes');
  for (const column of catalog.tables[0].columns) column.primaryKey = false;
  assert.equal(Object.hasOwn(fieldAccessibleApp(definition, catalog).views.incidents, 'presentation'), false);
});

test('step-derived selections cannot publish hidden or read-only form fields', () => {
  for (const field of ['hidden_secret', 'readonly']) {
    const definition = app({ quickAdd: true, form: { steps: [{ id: 'details', label: 'Details', fields: [field] }] } });
    const projected = fieldAccessibleApp(definition, schema);
    assert.equal(projected.resources?.incident.form, undefined);
    assert.equal(Object.hasOwn(projected.views.incidents, 'quickAdd'), false);
  }
  const definition = app({ quickAdd: true, form: { steps: [{ id: 'details', label: 'Details', fields: ['name'] }] } });
  assert.deepEqual(fieldAccessibleApp(definition, schema), definition);
});

test('quickAdd projection follows curated form visibility and create affordances without widening writes', () => {
  const definition = app({ quickAdd: true, form: { show: ['name'] } });
  assert.deepEqual(fieldAccessibleApp(definition, schema), definition);
  for (const form of [{ show: ['hidden_secret'] }, { defaults: { readonly: literal } }]) {
    const projected = fieldAccessibleApp(app({ quickAdd: true, form }), schema);
    assert.equal(Object.hasOwn(projected.views.incidents, 'quickAdd'), false);
    assert.doesNotMatch(JSON.stringify(projected), /hidden_secret|PRIVATE_LITERAL/);
  }
  for (const mode of ['insertable', 'readonly', 'view', 'missing']) {
    const catalog = structuredClone(schema);
    if (mode === 'insertable') catalog.tables[0].insertable = false;
    if (mode === 'readonly') for (const column of catalog.tables[0].columns) column.writable = false;
    if (mode === 'view') catalog.tables[0].isView = true;
    if (mode === 'missing') catalog.tables.shift();
    const before = structuredClone(catalog);
    assert.equal(Object.hasOwn(fieldAccessibleApp(definition, catalog).views.incidents, 'quickAdd'), false);
    assert.deepEqual(catalog, before);
  }
});

test('App projection drops entire unsafe actions while preserving the owning list and safe literals', () => {
  const definition = app({
    actions: [
      { id: 'safe', label: 'Safe', set: { name: literal } },
      { id: 'hidden', label: 'Hidden', set: { hidden_secret: literal } },
      { id: 'readonly', label: 'Readonly', set: { readonly: literal } },
      { id: 'mixed', label: 'Mixed', set: { name: 'ok', readonly: literal } },
      { id: 'condition', label: 'Condition', set: { name: 'ok' }, when: `hidden_secret = ${literal}` },
    ],
  });
  const before = structuredClone(definition);
  const projected = fieldAccessibleApp(definition, schema);
  assert.deepEqual(projected.resources?.incident.actions, [{ id: 'safe', label: 'Safe', set: { name: literal } }]);
  clean(projected, schema);
  assert.deepEqual(definition, before);
});

test('unsafe form curation is omitted whole, including all defaults, without dropping the list', () => {
  const forms: AppForm[] = [
    { defaults: { hidden_secret: literal, name: 'public' } },
    { defaults: { readonly: literal } },
    { show: ['hidden_secret'], defaults: { name: literal } },
    { show: ['readonly'], defaults: { name: literal } },
  ];
  for (const form of forms) {
    const projected = fieldAccessibleApp(app({ form }), schema);
    assert.equal(Object.hasOwn(projected.resources!.incident, 'form'), false);
    assert.doesNotMatch(JSON.stringify(projected), /hidden_secret|PRIVATE_LITERAL/);
    clean(projected, schema);
  }
});

test('App projection preserves optional form semantics and schema fields without writable flags', () => {
  const forms: Array<AppForm | undefined> = [
    undefined,
    {},
    { show: [] },
    { defaults: {} },
    { show: ['name'], defaults: { name: literal } },
  ];
  for (const form of forms) {
    const definition = app(form === undefined ? {} : { form });
    assert.deepEqual(fieldAccessibleApp(definition, schema), definition);
  }
  const dashboard: AppDef = {
    id: 'dash',
    name: 'Dash',
    ui: {},
    views: { home: { label: 'Home', sections: [{ kind: 'note', text: 'Hello' }] } },
    nav: [{ view: 'home' }],
    home: [{ view: 'home' }],
  };
  assert.deepEqual(fieldAccessibleApp(dashboard, schema), dashboard);
});

test('App projection does not reuse a different role’s write presentation', () => {
  const definition = app({
    form: { show: ['name'], defaults: { name: literal } },
    actions: [{ id: 'set', label: 'Set', set: { name: literal } }],
  });
  const readonly = structuredClone(schema);
  readonly.tables[0].columns.find((column) => column.name === 'name')!.writable = false;
  assert.deepEqual(fieldAccessibleApp(definition, schema), definition);
  const projected = fieldAccessibleApp(definition, readonly);
  assert.deepEqual(projected.resources?.incident.actions, []);
  assert.equal(Object.hasOwn(projected.resources!.incident, 'form'), false);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_LITERAL/);
  assert.deepEqual(fieldAccessibleApp(definition, schema), definition);
});

test('command reference labels and selector predicates are field-checked without treating command inputs as generic writes', () => {
  const command = {
    id: 'assign',
    version: 1,
    target: 'incident',
    input: [{ name: 'site', label: 'Site', type: 'reference' as const, from: 'site', by: 'id', labelColumn: 'name' }],
  };
  const definition = app({ actions: [{ id: 'assign', label: 'Assign', command }] });
  assert.deepEqual(fieldAccessibleApp(definition, schema), definition);
  for (const reference of [
    { ...command, input: [{ ...command.input[0], labelColumn: 'hidden_secret' }] },
    { ...command, input: [{ ...command.input[0], query: `hidden_secret = ${literal}` }] },
  ]) {
    const projected = fieldAccessibleApp(app({ actions: [{ id: 'assign', label: 'Assign', command: reference }] }), schema);
    assert.deepEqual(projected.resources?.incident.actions, []);
    assert.doesNotMatch(JSON.stringify(projected), /hidden_secret|PRIVATE_LITERAL/);
    clean(projected, schema);
  }
});

test('queue badges preserve readable labels and cannot publish hidden local or joined fields', () => {
  for (const badge of ['name', 'site_id.name']) {
    const definition = app({ presentation: { kind: 'queue', primary: 'name', badge } });
    assert.deepEqual(fieldAccessibleApp(definition, schema), definition);
  }
  for (const badge of ['hidden_secret', 'site_id.hidden_secret']) {
    const definition = app({ presentation: { kind: 'queue', primary: 'name', badge } });
    const before = structuredClone(definition);
    const projected = fieldAccessibleApp(definition, schema);
    assert.equal(Object.hasOwn(projected.views.incidents, 'presentation'), false);
    assert.doesNotMatch(JSON.stringify(projected), /hidden_secret/);
    assert.deepEqual(definition, before);
    clean(projected, schema);
  }
});

test('a section the reader cannot read is left out of the page, never the page; with nothing left, or no base, there is no page', () => {
  const fields: PageSection = { kind: 'fields', paths: ['name', 'status'] };
  const notes: PageSection = { ...list, columns: ['name'] };
  // A list over a table this reader is not served: the requester's Email list on their own ticket.
  const email: PageSection = { kind: 'list', from: 'hidden_table', path: 'incident_id' };
  const whole = page(fields, notes);
  assert.equal(readablePage(schema, whole), whole, 'a page that reads whole is kept as it is');
  assert.deepEqual(readablePage(schema, page(fields, email, notes))?.sections, [fields, notes]);
  assert.equal(readablePage(schema, page(email)), undefined);
  assert.equal(readablePage(schema, { ...page(fields), base: 'hidden_table' }), undefined);
});

test('a related list whose New the reader may not use stays without it; a headline’s earlier figure the reader may not read is left off', () => {
  const create = { label: 'Add note' };
  const notes: PageSection = { ...list, columns: ['name'], create };
  // The reader reads notes and writes none of them: the shopper on a car's photos.
  const reading: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.id === 'note' ? { ...table, columns: table.columns.map((column) => ({ ...column, writable: false })) } : table,
    ),
  };
  assert.deepEqual(readablePage(schema, page(notes))?.sections, [notes], 'a writer keeps the New');
  assert.deepEqual(readablePage(reading, page(notes))?.sections, [{ ...list, columns: ['name'] }]);
  const headline: PageSection = { kind: 'fields', paths: ['name'], presentation: 'headline', was: 'revision' };
  assert.deepEqual(readablePage(schema, page(headline))?.sections, [headline]);
  const hidden: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.id === 'incident' ? { ...table, columns: table.columns.filter((column) => column.name !== 'revision') } : table,
    ),
  };
  assert.deepEqual(readablePage(hidden, page(headline))?.sections, [{ kind: 'fields', paths: ['name'], presentation: 'headline' }]);
});

/* G49: a role narrowed to some of a table's columns keeps the page's layout. Its header and its properties lose the
   facts it does not read (a requester's ticket without its team and due time), never the whole section, so the
   page keeps its head. A section of nothing but unread fields still goes. */
test('a fields section keeps the fields the reader reads: a narrowed role keeps the header, without its unread facts', () => {
  const narrowed: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.id === 'incident'
        ? { ...table, columns: table.columns.filter((column) => !['status', 'site_id'].includes(column.name)) }
        : table,
    ),
    // A pruned catalog drops the reference with its column.
    foreignKeys: schema.foreignKeys.filter((fk) => fk.name !== 'incident_site'),
  };
  const header: PageSection = { kind: 'fields', presentation: 'header', paths: ['name', 'status', 'site_id.name'] };
  const team: PageSection = { kind: 'fields', title: 'Team', paths: ['status', 'site_id'] };
  const kept = readablePage(narrowed, page(header, team));
  assert.deepEqual(kept?.sections, [{ kind: 'fields', presentation: 'header', paths: ['name'] }]);
  // The reader who reads every field keeps the page as written.
  assert.deepEqual(readablePage(schema, page(header, team))?.sections, [header, team]);
  // A headline keeps its earlier figure while that is read, and its readable fields when one of them is not.
  const headline: PageSection = { kind: 'fields', presentation: 'headline', paths: ['name', 'status'], was: 'revision' };
  assert.deepEqual(readablePage(narrowed, page(headline))?.sections, [{ ...headline, paths: ['name'] }]);
});

test('a list’s suggestions name only columns the reader reads; a filter left with none suggests nothing', () => {
  const definition = app({ filters: ['name', 'status'], suggest: { name: ['name', 'readonly'], status: ['status'] } });
  assert.deepEqual(fieldAccessibleApp(definition, schema).views.incidents, definition.views.incidents);
  const narrow: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.id === 'incident'
        ? { ...table, columns: table.columns.filter((column) => column.name !== 'readonly' && column.name !== 'status') }
        : table,
    ),
  };
  assert.deepEqual((fieldAccessibleApp(definition, narrow).views.incidents as AppListView).suggest, { name: ['name'] });
  const none = fieldAccessibleApp(app({ filters: ['status'], suggest: { status: ['status'] } }), narrow).views.incidents;
  assert.equal(Object.hasOwn(none, 'suggest'), false);
});
