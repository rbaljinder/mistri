import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TenantContextError, refusalReasons } from '../packages/engine/src/server/evidence.js';
import {
  captureTenantPages,
  forgetTenantProjections,
  projectTenantMetadata,
  tenantProjectionsBuilt,
  tenantSuggestedPage,
} from '../packages/mistri/src/server/tenant/tenantMetadata.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePageBody, parsePagesConfig, type PageDef, type PageSection } from '../packages/engine/src/shared/page.js';
import { resolvePageEmbeds } from '../packages/mistri/src/shared/appPages.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { TenantCapabilities } from '../packages/mistri/src/server/tenant/tenantCapabilities.js';

const secret = 'PRIVATE_METADATA_SENTINEL';
const col = (name: string, type = 'TEXT'): ColumnMeta => ({
  name,
  type,
  nullable: name !== 'id',
  primaryKey: name === 'id',
  writable: false,
});
function schema(): DatabaseSchema {
  return {
    label: 'Tenant metadata',
    dialect: 'sqlite',
    readAt: '2026-09-08T00:00:00.000Z',
    tables: [
      {
        id: 'item',
        name: 'item',
        schema: '',
        isView: false,
        insertable: false,
        deletable: false,
        columns: [col('id'), col('name'), col('status'), col('amount', 'REAL'), col('at', 'TIMESTAMP')],
      },
      {
        id: 'note',
        name: 'note',
        schema: '',
        isView: false,
        insertable: false,
        deletable: false,
        columns: [col('id'), col('item_id'), col('name'), col('amount', 'REAL'), col('at', 'TIMESTAMP')],
      },
    ],
    foreignKeys: [{ name: 'note.item_id', from: { table: 'note', columns: ['item_id'] }, to: { table: 'item', columns: ['id'] } }],
  };
}
const resources = {
  item: { physical: 'physical_item', owner: 'tenant', access: 'write' },
  note: { physical: 'physical_note', owner: 'tenant' },
} as const;
function app(extra: Record<string, unknown> = {}) {
  return parseAppConfig(
    {
      id: 'tenant-metadata',
      name: 'Tenant metadata',
      sources: { business: { connection: 'PRIVATE_CONNECTION' } },
      resources,
      auth: { rows: 'tenant', roles: { operator: { read: true, write: true } } },
      views: { items: { kind: 'list', from: 'item', show: ['name', 'status'] } },
      home: 'items',
      nav: ['items'],
      ...extra,
    },
    'PRIVATE_APP_FILE',
  );
}
function page(...sections: PageSection[]): PageDef {
  return {
    id: 'item-detail',
    name: 'Item detail',
    base: 'item',
    source: 'config',
    sections: sections.length ? sections : [{ kind: 'fields', paths: ['name'] }],
  };
}
const list = { kind: 'list' as const, from: 'note', path: 'item_id', columns: ['name'] };

test('metadata permits visible alternate-key relationships and about sums without inventing real key values', () => {
  const catalog = schema();
  catalog.tables[0].columns.push(col('code'));
  catalog.foreignKeys[0].to.columns = ['code'];
  const definition = app();
  const pages = captureTenantPages(definition, [
    page(list),
    {
      id: 'note-detail',
      name: 'Note detail',
      base: 'note',
      sections: [{ kind: 'metric', fn: 'sum', from: 'note', path: 'item_id', of: 'item_id', column: 'amount' }],
    },
  ]);
  const result = projectTenantMetadata(definition, pages, catalog);
  assert.deepEqual(
    result.pages.map((page) => page.id),
    ['item-detail', 'note-detail'],
  );
  assert.doesNotMatch(JSON.stringify(result.pages), /"value":0/);
});
test('a projection is built once for everything it reads, and never handed to a reader who reads otherwise', () => {
  forgetTenantProjections();
  const definition = app({
    auth: {
      rows: 'tenant',
      roles: { owner: { read: true, write: true }, clerk: { read: ['item'] } },
    },
    views: {
      items: { kind: 'list', from: 'item', show: ['name', 'status'] },
      notes: { kind: 'list', from: 'note', show: ['name'], roles: ['owner'] },
    },
    nav: ['items', 'notes'],
  });
  const pages = captureTenantPages(definition, [page()]);
  const capabilities = (writable: string[]): TenantCapabilities => ({ resources: {}, writable, grantedCommands: [] });
  const built = tenantProjectionsBuilt();
  /* Each request brings its own catalog object: the same content is the same answer, built once. */
  const owner = projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['owner']);
  const again = projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['owner']);
  assert.equal(again, owner);
  assert.equal(tenantProjectionsBuilt(), built + 1);
  assert.ok(Object.isFrozen(owner.app));
  /* Another role, other grants, another catalog, realm, zone or locale: each its own answer. */
  const clerk = projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['clerk']);
  assert.notEqual(clerk, owner);
  assert.ok(Object.hasOwn(owner.app!.views, 'notes'));
  assert.ok(!Object.hasOwn(clerk.app!.views, 'notes'));
  const readOnly = projectTenantMetadata(definition, pages, schema(), capabilities([]), ['owner']);
  assert.notEqual(readOnly, owner);
  assert.deepEqual(readOnly.app!.writableTables, []);
  assert.deepEqual(owner.app!.writableTables, ['item']);
  const narrower = schema();
  narrower.tables.pop();
  narrower.foreignKeys = [];
  const pruned = projectTenantMetadata(definition, pages, narrower, capabilities(['item']), ['owner']);
  assert.notEqual(pruned, owner);
  assert.ok(!Object.hasOwn(pruned.app!.views, 'notes'));
  for (const other of [
    projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['owner'], 'platform'),
    projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['owner'], 'tenant', 'Asia/Kolkata'),
    projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['owner'], 'tenant', undefined, 'de-DE'),
    projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['owner', 'clerk']),
    projectTenantMetadata(definition, pages, schema(), capabilities(['item']), ['clerk', 'owner']),
  ])
    assert.notEqual(other, owner);
  /* A catalog changed in place after it was read is read again, never taken for the one it was. */
  const mutable = schema();
  const before = projectTenantMetadata(definition, pages, mutable, capabilities(['item']), ['owner']);
  mutable.tables.pop();
  mutable.foreignKeys = [];
  const after = projectTenantMetadata(definition, pages, mutable, capabilities(['item']), ['owner']);
  assert.notEqual(after, before);
  assert.ok(!Object.hasOwn(after.app!.views, 'notes'));
});
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
function safeFailure(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.code, 'tenant_context_unavailable');
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|physical_|hidden_secret/);
  return true;
}
function noPrivate(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|physical_|hidden_secret/);
  const visit = (input: unknown) => {
    if (!input || typeof input !== 'object') return;
    for (const [key, child] of Object.entries(input)) {
      assert.ok(
        ![
          'connection',
          'sources',
          'settings',
          'access',
          'auth',
          'problems',
          'loadError',
          'error',
          'errors',
          'sql',
          'params',
          'form',
          'actions',
          'create',
        ].includes(key),
        `private/presentation key ${key}`,
      );
      visit(child);
    }
  };
  visit(value);
}

test('page capture accepts absent/empty catalogs and the exact 256-page bound', () => {
  assert.deepEqual(captureTenantPages(app(), undefined), []);
  assert.deepEqual(captureTenantPages(app(), []), []);
  const input = Array.from({ length: 256 }, (_, index) => ({ ...page(), id: `page-${index}` }));
  const result = captureTenantPages(app(), input);
  assert.equal(result.length, 256);
  assert.equal(result[255].id, 'page-255');
  assert.throws(() => captureTenantPages(app(), [...input, { ...page(), id: 'overflow' }]), safeFailure);
});

test('normalized loader pages preserve IDs/layout and strip the canonical private connection', () => {
  const input = parsePagesConfig(
    {
      pages: [
        {
          id: 'custom-detail',
          label: 'Item detail',
          base: 'item',
          connection: 'PRIVATE_CONNECTION',
          listTabs: false,
          sections: [
            { kind: 'fields', show: ['name'], columns: 2, region: 'aside', presentation: 'summary' },
            { kind: 'list', from: 'note', whose: 'item_id', show: ['name'], sort: 'at desc', limit: 7 },
          ],
        },
      ],
    },
    'PRIVATE_PAGE_FILE',
  );
  const before = structuredClone(input),
    captured = captureTenantPages(app(), input);
  assert.equal(captured[0].id, 'custom-detail');
  assert.equal(captured[0].source, 'config');
  assert.equal(captured[0].listTabs, false);
  assert.equal(captured[0].sections.length, 2);
  assert.equal(captured[0].sections[0].region, 'aside');
  const section = captured[0].sections[1];
  assert.equal(section.kind, 'list');
  if (section.kind === 'list') {
    assert.equal(section.limit, 7);
    assert.equal(section.orderBy?.[0].column, 'at');
  }
  noPrivate(captured);
  assert.deepEqual(input, before);
  assert.notEqual(captured, input);
  assert.notEqual(captured[0].sections, input[0].sections);
  input[0].name = 'changed';
  input[0].sections.length = 0;
  assert.equal(captured[0].name, 'Item detail');
  assert.equal(captured[0].sections.length, 2);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured[0].sections), true);
});

test('a related create that starts from defaults and fills from the record is captured, not refused', () => {
  /* The loader folds the child resource's form defaults into a related
     list's create, so a create saying more than its label reaches every host
     that has one: capture must keep it, through the null-prototype copy. */
  const input = parsePagesConfig(
    {
      pages: [
        {
          id: 'item-detail',
          label: 'Item detail',
          base: 'item',
          sections: [
            {
              kind: 'list',
              from: 'note',
              whose: 'item_id',
              show: ['name'],
              create: { label: 'Add note', show: ['name'], defaults: { amount: 1, name: null }, prefill: { at: 'at' } },
            },
          ],
        },
      ],
    },
    'PAGE_FILE',
  );
  const [captured] = captureTenantPages(app(), input);
  const section = captured.sections[0];
  assert.equal(section.kind, 'list');
  if (section.kind === 'list')
    assert.deepEqual(plain(section.create), {
      label: 'Add note',
      show: ['name'],
      defaults: { amount: 1, name: null },
      prefill: { at: 'at' },
    });
  for (const create of [
    { label: 'Add note', defaults: { amount: [1] } },
    { label: 'Add note', fill: { at: 3 } },
  ]) {
    assert.throws(() => captureTenantPages(app(), [{ ...input[0], sections: [{ ...input[0].sections[0], create }] }]), safeFailure);
  }
});

test('App note actions and headline bindings survive validated tenant capture without granting target resources', () => {
  const to = { app: 'lender', kind: 'record', resource: 'application', key: { id: { column: 'id' } } };
  const body = {
    label: 'Item detail',
    base: 'item',
    connection: 'PRIVATE_CONNECTION',
    sections: [
      { kind: 'note', text: 'Local work', action: { label: 'Items', to: 'items' } },
      { kind: 'note', text: 'Other workspace', action: { label: 'Open in Lender', to } },
      {
        kind: 'headline',
        show: ['name'],
        subfigure: 'amount',
        note: 'Current amount',
        links: [{ label: 'Open in Lender', to }],
      },
    ],
  };
  // The Workbench grammar must continue refusing actions that need an App.
  assert.throws(() => parsePagesConfig({ pages: [body] }, 'Workbench'), /needs an App/);
  const input = [{ ...parsePageBody(body, 'App page', 'item-detail'), realm: 'tenant' as const }];
  const captured = captureTenantPages(app(), input);
  assert.equal(captured[0].realm, 'tenant');
  assert.deepEqual(plain(captured[0].sections), plain(input[0].sections));
  assert.equal(Object.hasOwn(captured[0], 'connection'), false);
  const headline = captured[0].sections[2];
  assert.equal(headline.kind, 'fields');
  if (headline.kind !== 'fields') return;
  assert.equal(Object.isFrozen(headline.actions?.[0]), true);
  const action = headline.actions?.[0];
  assert.ok(action && 'to' in action);
  const target = action.to;
  assert.equal(target?.kind, 'record');
  if (target?.kind === 'record') assert.equal(Object.isFrozen(target.key), true);
  body.sections[1].action!.label = 'Changed';
  assert.equal(captured[0].sections[1].kind === 'note' && captured[0].sections[1].action?.label, 'Open in Lender');
  const result = projectTenantMetadata(app(), captured, schema());
  assert.equal(result.pages.length, 1);
  assert.deepEqual(plain(result.pages[0].sections), plain(captured[0].sections));
  assert.equal(Object.hasOwn(result.app.resources, 'application'), false);
  assert.deepEqual(result.app.writableTables, []);
  assert.deepEqual(result.app.grantedCommands, []);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|physical_/);
  const restricted = schema();
  restricted.tables[0].columns = restricted.tables[0].columns.filter((column) => column.name !== 'status');
  const narrowed = projectTenantMetadata(app(), captured, restricted);
  assert.equal(Object.hasOwn(narrowed.app.views, 'items'), false);
  assert.equal('action' in narrowed.pages[0].sections[0], false, 'local note links follow granted rooms');
  assert.equal(narrowed.pages[0].sections[1].kind === 'note' && narrowed.pages[0].sections[1].action?.label, 'Open in Lender');
});

test('captured App embeds are resolved again and projected against the current permitted schema', () => {
  const definition = app({
    views: {
      items: { kind: 'list', from: 'item' },
      notes: { kind: 'list', from: 'note', show: ['name'], query: 'amount > 0', sort: 'at desc' },
    },
    nav: ['items', 'notes'],
  });
  const authored = { base: 'item', sections: [{ kind: 'view', view: 'notes', whose: 'item_id' }] };
  assert.throws(() => parsePagesConfig({ pages: [authored] }, 'Workbench'), /has no views/);
  const loaded = resolvePageEmbeds(definition, [parsePageBody(authored, 'App page', 'embedded')], 'App');
  const captured = captureTenantPages(definition, loaded);
  assert.deepEqual(plain(captured[0].sections), plain(loaded[0].sections));
  assert.equal(projectTenantMetadata(definition, captured, schema()).pages.length, 1);
  const restricted = schema();
  restricted.tables[1].columns = restricted.tables[1].columns.filter((column) => column.name !== 'amount');
  const result = projectTenantMetadata(definition, captured, restricted);
  assert.equal(Object.hasOwn(result.app.views, 'notes'), false);
  assert.equal(result.pages.length, 0, 'embedded predicates cannot bypass the current field grant');
});

test('an embedded view outside the current realm is withheld even when its columns are readable', () => {
  const definition = app({
    auth: { rows: 'tenant', tenancy: { platform: { label: 'Platform' } }, roles: { operator: { realm: 'tenant', read: true } } },
    views: {
      items: { kind: 'list', from: 'item', realm: 'tenant' },
      notes: { kind: 'list', from: 'note', realm: 'platform', show: ['name'] },
    },
    nav: ['items', 'notes'],
  });
  const loaded = resolvePageEmbeds(
    definition,
    [parsePageBody({ base: 'item', sections: [{ kind: 'view', view: 'notes', whose: 'item_id' }] }, 'App page', 'embedded')],
    'App',
  );
  const captured = captureTenantPages(definition, loaded);
  const result = projectTenantMetadata(definition, captured, schema());
  assert.equal(Object.hasOwn(result.app.views, 'notes'), false);
  assert.equal(result.pages.length, 0);
});

test("a section the member cannot read is left out of the page, and the page is still the record's", () => {
  const definition = app({
    views: {
      items: { kind: 'list', from: 'item' },
      notes: { kind: 'list', from: 'note', show: ['name'], query: 'amount > 0' },
    },
    nav: ['items', 'notes'],
  });
  const loaded = resolvePageEmbeds(
    definition,
    [
      parsePageBody(
        {
          base: 'item',
          sections: [
            { kind: 'fields', title: 'Item', show: ['name'] },
            { kind: 'view', view: 'notes', whose: 'item_id' },
          ],
        },
        'App page',
        'embedded',
      ),
    ],
    'App',
  );
  const captured = captureTenantPages(definition, loaded);
  assert.deepEqual(
    projectTenantMetadata(definition, captured, schema()).pages[0].sections.map((section) => section.kind),
    ['fields', 'list'],
  );
  const restricted = schema();
  restricted.tables[1].columns = restricted.tables[1].columns.filter((column) => column.name !== 'amount');
  const result = projectTenantMetadata(definition, captured, restricted);
  // The raw record, every column and none of the page, said far more than the one section it lost.
  assert.deepEqual(
    result.pages.map((page) => page.sections.map((section) => section.kind)),
    [['fields']],
  );
});

const embeddedPresentations = [
  {
    kind: 'cards',
    primary: 'name',
    value: 'amount',
    properties: ['item_id.name'],
    media: 'avatar',
    facts: [
      { column: 'amount', after: { one: 'point', many: 'points' } },
      { column: 'at', before: 'Added' },
    ],
  },
  { kind: 'custom', component: { id: 'notes', kind: 'list', module: './widgets/Notes.tsx' }, show: ['name', 'amount'] },
];

for (const presentation of embeddedPresentations)
  test(`normalized ${presentation.kind} embeds retain validated presentation and scoped visibility`, () => {
    const definition = app({
      auth: { rows: 'tenant', tenancy: { platform: { label: 'Platform' } }, roles: { operator: { realm: 'tenant', read: true } } },
      views: {
        items: { kind: 'list', from: 'item', realm: 'tenant' },
        notes: { kind: 'list', from: 'note', realm: 'tenant', presentation },
        'platform-notes': { kind: 'list', from: 'note', realm: 'platform', presentation },
      },
      nav: ['items', 'notes', 'platform-notes'],
    });
    const loaded = resolvePageEmbeds(
      definition,
      ['notes', 'platform-notes'].map((view) =>
        parsePageBody({ base: 'item', sections: [{ kind: 'view', view, whose: 'item_id' }] }, 'App page', view),
      ),
      'App',
    );
    const before = structuredClone(loaded),
      captured = captureTenantPages(definition, loaded);
    assert.deepEqual(plain(captured), plain(loaded));
    const section = captured[0].sections[0];
    assert.equal(section.kind, 'list');
    if (section.kind !== 'list') return;
    assert.equal(Object.isFrozen(section.presentation), true);
    const result = projectTenantMetadata(definition, captured, schema());
    assert.deepEqual(
      result.pages.map((page) => page.id),
      ['notes'],
      'an object presentation cannot bypass realm visibility',
    );
    assert.deepEqual(plain(result.pages[0].sections), plain(captured[0].sections));
    assert.deepEqual(loaded, before);
    if (presentation.kind === 'cards') {
      assert.deepEqual(
        plain(typeof section.presentation === 'object' && section.presentation.kind === 'cards' && section.presentation.factLabels),
        { amount: { one: 'point', many: 'points' }, at: { one: 'Added', position: 'before' } },
      );
    }
    for (const blocked of ['field', 'resource']) {
      const restricted = schema();
      if (blocked === 'field') restricted.tables[1].columns = restricted.tables[1].columns.filter((column) => column.name !== 'amount');
      else {
        restricted.tables = restricted.tables.filter((table) => table.id !== 'note');
        restricted.foreignKeys = [];
      }
      const denied = projectTenantMetadata(definition, captured, restricted);
      if (blocked === 'resource') assert.equal(Object.hasOwn(denied.app.views, 'notes'), false);
      assert.equal(denied.pages.length, 0);
    }
    const held = plain(captured);
    loaded[0].sections.length = 0;
    assert.deepEqual(plain(captured), held);
  });

test('object presentations use the shared shape parser before an embed can discard their authored spelling', () => {
  const component = { id: 'notes', kind: 'list', module: './widgets/Notes.tsx' };
  const definition = app({
    views: { items: { kind: 'list', from: 'item' }, notes: { kind: 'list', from: 'note' } },
    nav: ['items', 'notes'],
  });
  const malformed = [
    null,
    false,
    [],
    {},
    'arbitrary',
    { kind: 'queue', primary: 'name' },
    { kind: 'cards', primary: 'name', arbitrary: true },
    { kind: 'cards', primary: 3 },
    { kind: 'cards', primary: 'name', properties: ['a.b.c'] },
    { kind: 'cards', primary: 'name', properties: [1] },
    { kind: 'cards', primary: 'name', image: { from: 'file', whose: 1 } },
    { kind: 'cards', primary: 'name', media: 'unknown' },
    { kind: 'cards', primary: 'name', facts: ['amount'], factLabels: { name: { one: 'Wrong fact' } } },
    { kind: 'cards', primary: 'name', facts: ['amount'], factLabels: { amount: { one: 'Point', permission: 'write' } } },
    { kind: 'cards', primary: 'name', facts: ['amount'], factLabels: { amount: { one: 'Point', many: 3 } } },
    { kind: 'cards', primary: 'name', facts: ['amount'], factLabels: { amount: { one: 'Point', position: 'after' } } },
    { kind: 'custom', component, show: [] },
    { kind: 'custom', component, show: ['name'], props: { unknown: true } },
    { kind: 'custom', component: { ...component, kind: 'section' }, show: ['name'] },
    { kind: 'custom', component: { ...component, module: '../outside.tsx' }, show: ['name'] },
    { kind: 'custom', component, show: ['name'], authority: 'write' },
  ];
  for (const presentation of malformed)
    assert.throws(() => captureTenantPages(definition, [{ ...page(), sections: [{ ...list, view: 'notes', presentation }] }]), safeFailure);
  for (const presentation of embeddedPresentations)
    assert.throws(
      () => captureTenantPages(definition, [{ ...page(), sections: [{ kind: 'fields', paths: ['name'], presentation }] }]),
      safeFailure,
    );
  const custom = { kind: 'custom', component, show: ['name'] };
  assert.throws(() => captureTenantPages(definition, [{ ...page(), sections: [{ ...list, presentation: custom }] }]), safeFailure);
});

test('standalone related cards keep their normalized facts while fields keep string presentations', () => {
  const loaded = parsePageBody(
    {
      base: 'item',
      sections: [
        { kind: 'fields', show: ['name'], presentation: 'summary' },
        {
          kind: 'list',
          from: 'note',
          whose: 'item_id',
          presentation: { kind: 'cards', primary: 'name', facts: [{ column: 'amount', after: 'Point' }] },
        },
      ],
    },
    'App page',
    'cards',
  );
  const captured = captureTenantPages(app(), [loaded]);
  assert.deepEqual(plain(captured[0].sections), plain(loaded.sections));
  assert.equal(projectTenantMetadata(app(), captured, schema()).pages.length, 1);
});

test('App capture still rejects malformed actions and undeclared local views through the real parser', () => {
  const to = { app: 'lender', kind: 'record', resource: 'application', key: { id: { column: 'id' } } };
  for (const action of [
    { label: 'Open', to: { ...to, href: '/forged' } },
    { label: 'Open', to: { ...to, key: { id: { column: 3 } } } },
    { label: 'Open', to, href: '/forged' },
    { label: 'Open', to, permission: 'write' },
  ]) {
    for (const section of [
      { kind: 'note', text: 'Continue', action },
      { kind: 'fields', presentation: 'headline', paths: ['name'], actions: [action] },
    ]) {
      assert.throws(() => captureTenantPages(app(), [{ ...page(), sections: [section] }]), safeFailure);
    }
  }
  for (const section of [
    { kind: 'note', text: 'Continue', action: { label: 'Open', to: 'unknown' } },
    { kind: 'note', text: 'Continue', action: null },
    { kind: 'note', text: 'Continue', action: false },
    { kind: 'list', view: 'unknown', from: 'note', path: 'item_id' },
    { kind: 'fields', paths: ['name'], actions: [{ label: 'Open', to }] },
    { kind: 'fields', presentation: 'headline', paths: ['name'], actions: [] },
    { kind: 'fields', presentation: 'headline', paths: ['name'], subfigure: 123 },
    { kind: 'fields', presentation: 'headline', paths: ['name'], note: false },
  ]) {
    assert.throws(() => captureTenantPages(app(), [{ ...page(), sections: [section] }]), safeFailure);
  }
});

const badCatalogs: Array<[string, () => unknown]> = [
  ['null', () => null],
  ['object instead of array', () => ({})],
  [
    'sparse catalog',
    () => {
      const values: unknown[] = [];
      values.length = 2;
      return values;
    },
  ],
  ['non-page element', () => [null]],
  ['duplicate IDs', () => [page(), page()]],
  ['reserved suggested ID', () => [{ ...page(), id: 'suggested:item' }]],
  ['empty ID', () => [{ ...page(), id: '' }]],
  ['whitespace ID', () => [{ ...page(), id: ' item-detail' }]],
  ['control-character ID', () => [{ ...page(), id: 'item\ndetail' }]],
  ['non-string ID', () => [{ ...page(), id: 7 }]],
  ['oversized ID', () => [{ ...page(), id: 'x'.repeat(1025) }]],
  ['wrong connection', () => [{ ...page(), connection: 'OTHER_PRIVATE_CONNECTION' }]],
  ['source name is not a connection alias', () => [{ ...page(), connection: 'business' }]],
  ['browser saved origin', () => [{ ...page(), source: 'saved' }]],
  ['unknown realm', () => [{ ...page(), realm: 'global' }]],
  ['source filename', () => [{ ...page(), source: '/PRIVATE_PAGE_FILE' }]],
  ['stored validation diagnostic', () => [{ ...page(), error: secret }]],
  ['arbitrary provenance', () => [{ ...page(), file: '/PRIVATE_PAGE_FILE' }]],
  ['inherited page fields', () => [Object.create(page())]],
  ['missing sections', () => [{ id: 'p', name: 'P', base: 'item' }]],
  ['object sections', () => [{ ...page(), sections: {} }]],
  [
    'sparse sections',
    () => {
      const sections: unknown[] = [];
      sections.length = 1;
      return [{ ...page(), sections }];
    },
  ],
  ['unknown section kind', () => [{ ...page(), sections: [{ kind: secret }] }]],
  ['excessive sections', () => [{ ...page(), sections: Array.from({ length: 25 }, () => ({ kind: 'fields' })) }]],
  ['invalid list limit', () => [page({ ...list, limit: -1 })]],
  ['invalid layout boolean', () => [{ ...page(), listTabs: 'false' }]],
  ['malformed path element', () => [{ ...page(), sections: [{ kind: 'fields', paths: [123] }] }]],
  ['malformed normalized names', () => [{ ...page(), sections: [{ kind: 'fields', names: 'false' }] }]],
];
for (const [name, input] of badCatalogs)
  test(`page capture safely refuses ${name}`, () => {
    assert.throws(() => captureTenantPages(app(), input()), safeFailure);
  });

for (const placement of ['catalog', 'page', 'section'] as const) {
  test(`page capture rejects a ${placement} proxy without executing any trap`, () => {
    let traps = 0;
    const trap = () => {
      traps++;
      throw new Error(secret);
    };
    const target = placement === 'catalog' ? [page()] : placement === 'page' ? page() : { kind: 'fields' };
    const proxy = new Proxy(target, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const input = placement === 'catalog' ? proxy : placement === 'page' ? [proxy] : [{ ...page(), sections: [proxy] }];
    assert.throws(() => captureTenantPages(app(), input), safeFailure);
    assert.equal(traps, 0);
  });
  test(`page capture rejects a ${placement} accessor without executing it`, () => {
    let getters = 0;
    const input = [page()];
    const target = placement === 'catalog' ? input : placement === 'page' ? input[0] : input[0].sections[0];
    Object.defineProperty(target, placement === 'catalog' ? '0' : placement === 'page' ? 'name' : 'when', {
      enumerable: true,
      configurable: true,
      get() {
        getters++;
        throw new Error(secret);
      },
    });
    assert.throws(() => captureTenantPages(app(), input), safeFailure);
    assert.equal(getters, 0);
  });
}

test('read-only metadata preserves safe App display while omitting all write/auth/source presentation', () => {
  const definition = app({
    ui: { locale: 'en-GB', timezone: 'UTC', currency: 'GBP', shell: { placement: 'top' } },
    resources: {
      ...resources,
      item: {
        ...resources.item,
        display: { amount: { format: 'money', currency: 'GBP' }, hidden_secret: { tone: { [secret]: 'bad' } } },
        form: { show: ['name'], defaults: { name: secret } },
        actions: { change: { label: secret, set: { name: secret } } },
      },
    },
    views: {
      items: { kind: 'list', from: 'item', show: ['name'] },
      home: { kind: 'dashboard', label: 'Home', sections: [{ kind: 'metric', title: 'Items', from: 'item', measure: 'count' }] },
    },
    nav: ['items', 'home'],
    home: 'home',
  });
  const catalog = schema(),
    captured = captureTenantPages(definition, [page()]);
  const before = structuredClone({ definition, catalog, captured });
  const projected = projectTenantMetadata(definition, captured, catalog);
  noPrivate(projected);
  assert.equal(projected.app.id, definition.id);
  // Home cards are a dashboard's metric sections, published as a nav entry.
  assert.equal(Object.keys(projected.app.views).length, 2);
  assert.equal(projected.app.home, 'home');
  assert.deepEqual(plain(projected.app.writableTables), []);
  assert.equal(projected.app.ui.export, false);
  assert.deepEqual(plain(projected.app.grantedCommands), []);
  assert.equal(projected.app.ui.locale, 'en-GB');
  assert.equal(projected.app.ui.currency, 'GBP');
  assert.deepEqual(plain(projected.app.resources.item.display), { amount: { format: 'money', currency: 'GBP' } });
  assert.equal(Object.hasOwn(projected.app.resources.item, 'form'), false);
  assert.equal(Object.hasOwn(projected.app.resources.item, 'actions'), false, 'a membership that may run none is offered none');
  assert.deepEqual(plain({ definition, catalog, captured }), plain(before));
});

test('a record page names its roles and path in a tenant App: offered to those roles only, and absent to the rest', () => {
  /* G56: capture admitted only the loader's older page keys, so any `roles`
     or `path` on a page failed check and startup with the bare context error. */
  const definition = app({
    auth: { rows: 'tenant', roles: { operator: { read: true, write: true }, requester: { read: true } } },
  });
  const desk: PageDef = { ...page(), id: 'item-desk', roles: ['operator'] };
  const own: PageDef = { ...page(), id: 'item-own', name: 'My item', path: 'my-item', roles: ['requester'] };
  const captured = captureTenantPages(definition, [desk, own]);
  assert.deepEqual(plain(captured.map((each) => [each.id, each.path, each.roles])), [
    ['item-desk', null, ['operator']],
    ['item-own', 'my-item', ['requester']],
  ]);
  const catalog = schema();
  const offered = (roles: string[]) => projectTenantMetadata(definition, captured, catalog, undefined, roles).pages.map((each) => each.id);
  assert.deepEqual(offered(['operator']), ['item-desk']);
  assert.deepEqual(offered(['requester']), ['item-own']);
  assert.deepEqual(offered(['operator', 'requester']), ['item-desk', 'item-own']);
  assert.deepEqual(offered([]), []);
  // A role the App does not declare, or a key a page never takes, is refused by name.
  const reason = (input: unknown) => {
    try {
      captureTenantPages(definition, [input]);
    } catch (error) {
      safeFailure(error);
      return refusalReasons(error).join(' / ');
    }
    assert.fail('the page was captured');
  };
  assert.match(reason({ ...own, roles: ['nobody'] }), /pages "item-own" has "roles" naming "nobody", which auth\.roles does not declare/);
  assert.match(reason({ ...own, path: 'Not A Path' }), /pages "item-own": "path" must be one address segment/);
  assert.match(reason({ ...own, colour: 'red' }), /pages "item-own" has "colour", which a tenant App's page does not take/);
});

test('membership capability projection retains authorized forms and set actions but no read-only field edits', () => {
  const catalog = schema();
  catalog.tables[0].columns.find((column) => column.name === 'id')!.identity = 'by-default';
  catalog.tables[0].columns.find((column) => column.name === 'name')!.writable = true;
  catalog.tables[0].insertable = true;
  const capabilities: TenantCapabilities = {
    resources: { item: { write: ['name'], insertable: true, deletable: false } },
    writable: ['item'],
    grantedCommands: [],
  };
  const definition = app({
    resources: {
      ...resources,
      item: {
        ...resources.item,
        form: { show: ['name'] },
        actions: {
          rename: { label: 'Rename', set: { name: 'Updated' } },
          forbiddenStatus: { label: 'Forbidden status', set: { status: 'closed' } },
        },
      },
    },
    views: { items: { kind: 'list', from: 'item' } },
  });
  const result = projectTenantMetadata(definition, [], catalog, capabilities);
  const resource = result.app.resources.item;
  assert.deepEqual(resource.form?.show, ['name']);
  assert.deepEqual(
    resource.actions?.map((action) => action.label),
    ['Rename'],
  );
  assert.deepEqual(result.app.writableTables, ['item']);
  const readOnly = projectTenantMetadata(definition, [], catalog);
  assert.doesNotMatch(JSON.stringify(readOnly), /"actions"|"form"/);
});

const hiddenNav: Array<[string, Record<string, unknown>]> = [
  ['table', { kind: 'list', from: 'hidden_secret' }],
  ['shown column', { kind: 'list', from: 'item', show: ['hidden_secret'] }],
  ['base predicate', { kind: 'list', from: 'item', query: `hidden_secret = ${secret}` }],
  ['quick filter', { kind: 'list', from: 'item', filters: ['hidden_secret'] }],
];
for (const [name, entry] of hiddenNav)
  test(`metadata drops nav with hidden ${name}, without diagnostic leakage`, () => {
    // A resource reads by default: it is hidden here because the one role does not read it.
    const definition = app({
      resources: { ...resources, hidden_secret: { owner: 'tenant' } },
      auth: { rows: 'tenant', roles: { operator: { read: ['item', 'note'], write: ['item'] } } },
      views: { safe: { kind: 'list', from: 'note', label: 'Safe' }, hidden: entry },
      home: 'safe',
      nav: ['safe', 'hidden'],
    });
    const result = projectTenantMetadata(definition, [], schema());
    noPrivate(result);
    assert.deepEqual(plain(result.app.nav), [{ view: 'safe', label: 'Safe' }]);
    assert.deepEqual(Object.keys(result.app.views), ['safe']);
  });

// A tab's conditions are its segment's, so a segment naming what the reader may not read is served no segment and no tab:
// the list stays, with the tabs that read.
test('metadata serves a list without the tab whose segment names a hidden column, without diagnostic leakage', () => {
  const definition = app({
    resources: {
      ...resources,
      item: { ...resources.item, segments: { private: `hidden_secret = ${secret}` } },
      hidden_secret: { owner: 'tenant' },
    },
    auth: { rows: 'tenant', roles: { operator: { read: ['item', 'note'], write: ['item'] } } },
    views: { safe: { kind: 'list', from: 'item', label: 'Safe', tabs: [{ label: 'All' }, 'private'] } },
    home: 'safe',
    nav: ['safe'],
  });
  const result = projectTenantMetadata(definition, [], schema());
  noPrivate(result);
  assert.deepEqual(
    (result.app.views.safe as { tabs?: Array<{ label: string }> }).tabs?.map((tab) => tab.label),
    ['All'],
  );
});

for (const field of ['query', 'compare', 'measure'] as const) {
  // Home cards are a home dashboard's metric sections: one hidden card withholds that dashboard.
  test(`metadata withholds a home dashboard with a hidden ${field}`, () => {
    const bad = field === 'measure' ? 'sum hidden_secret' : `hidden_secret = ${secret}`;
    const definition = app({
      views: {
        safe: { kind: 'list', from: 'item', label: 'Safe' },
        home: {
          kind: 'dashboard',
          label: 'Home',
          sections: [
            { kind: 'metric', title: 'Safe', from: 'item', measure: 'count' },
            { kind: 'metric', title: 'Unsafe', from: 'item', measure: 'count', [field]: bad },
          ],
        },
      },
      nav: ['safe', 'home'],
      home: 'home',
    });
    const result = projectTenantMetadata(definition, [], schema());
    noPrivate(result);
    assert.deepEqual(plain(result.app.nav), [{ view: 'safe', label: 'Safe' }]);
    assert.deepEqual(Object.keys(result.app.views), ['safe']);
  });
  test(`metadata does not publish a dashboard's hidden ${field}`, () => {
    const bad = field === 'measure' ? 'sum hidden_secret' : `hidden_secret = ${secret}`;
    const definition = app({
      views: {
        safe: { kind: 'list', from: 'item', label: 'Safe' },
        'private-dashboard': {
          kind: 'dashboard',
          label: 'Private dashboard',
          sections: [{ kind: 'metric', from: 'item', measure: 'count', [field]: bad }],
        },
      },
      home: 'safe',
      nav: ['safe', 'private-dashboard'],
    });
    const result = projectTenantMetadata(definition, [], schema());
    noPrivate(result);
    assert.deepEqual(plain(result.app.nav), [{ view: 'safe', label: 'Safe' }]);
    assert.deepEqual(Object.keys(result.app.views), ['safe']);
  });
}

const hiddenSections: Array<[string, PageSection]> = [
  ['fields', { kind: 'fields', paths: ['hidden_secret'] }],
  [
    'workflow',
    {
      kind: 'fields',
      workflow: {
        field: 'hidden_secret',
        steps: [
          { value: secret, label: 'Private' },
          { value: 'done', label: 'Done' },
        ],
      },
    },
  ],
  ['conditional visibility', { kind: 'fields', paths: ['name'], when: `hidden_secret = ${secret}` }],
  ['list columns', { ...list, columns: ['hidden_secret'] }],
  ['list predicate', { ...list, filter: `hidden_secret = ${secret}` }],
  ['list sort', { ...list, orderBy: [{ column: 'hidden_secret', direction: 'asc' }] }],
  ['list relationship', { ...list, path: 'hidden_secret' }],
  ['metric column', { kind: 'metric', from: 'note', path: 'item_id', fn: 'sum', column: 'hidden_secret' }],
  ['breakdown key', { kind: 'breakdown', from: 'note', path: 'item_id', by: 'hidden_secret' }],
  ['timeline detail', { kind: 'timeline', streams: [{ from: 'note', path: 'item_id', at: 'at', show: 'name', detail: 'hidden_secret' }] }],
];
for (const [name, section] of hiddenSections)
  test(`page projection omits hidden ${name} even in inactive sections`, () => {
    const definition = app();
    for (const visibility of [{}, { hidden: true }, { when: 'status = never' }]) {
      // Do not overwrite the forbidden when in the conditional-visibility case.
      const unsafe = page({ ...section, ...visibility, ...(section.when ? { when: section.when } : {}) });
      const input = captureTenantPages(definition, [unsafe, { ...page(), id: 'safe' }]);
      const result = projectTenantMetadata(definition, input, schema());
      noPrivate(result);
      assert.deepEqual(
        result.pages.map((value) => value.id),
        ['safe'],
      );
    }
  });

test('a machine-derived ordered workflow strip survives capture, steps and all', () => {
  // Machine projection attaches the resolved strip before tenant capture.
  const input = captureTenantPages(app(), [
    page({
      kind: 'fields',
      paths: ['name'],
      workflow: {
        field: 'status',
        steps: [
          { value: 'new', label: 'New' },
          { value: 'done', label: 'Finished' },
        ],
        ordered: true,
      },
    }),
  ]);
  assert.equal(input.length, 1);
  const workflow = (plain(input[0].sections[0]) as { workflow?: unknown }).workflow;
  assert.deepEqual(workflow, {
    field: 'status',
    ordered: true,
    steps: [
      { value: 'new', label: 'New' },
      { value: 'done', label: 'Finished' },
    ],
  });
});

test('a timeline survives capture as the loader writes it, its author included', () => {
  /* The loader writes every stream with a `by` key, set or not, and capture
     refused the key, so a tenant App with any timeline could not start. */
  const input = parsePagesConfig(
    {
      pages: [
        {
          id: 'item-detail',
          label: 'Item detail',
          base: 'item',
          sections: [
            {
              kind: 'timeline',
              title: 'Activity',
              streams: [
                { from: 'note', whose: 'item_id', at: 'at', show: 'name' },
                { from: 'note', whose: 'item_id', at: 'at', show: 'name', author: 'name' },
              ],
            },
          ],
        },
      ],
    },
    'PAGE_FILE',
  );
  const [captured] = captureTenantPages(app(), input);
  const section = plain(captured.sections[0]) as { kind: string; streams: Array<{ by?: string }> };
  assert.equal(section.kind, 'timeline');
  assert.deepEqual(
    section.streams.map((stream) => stream.by),
    [undefined, 'name'],
  );
});

test("a timeline stream's about survives capture and projection, and a key a stream does not take is named", () => {
  /* A stream's `about` (0.8.8) was refused by capture, opaquely, so a tenant
     App with one did not start. Its rows are planned on the
     tenant's scoped adapter like a list's `about`. */
  const input = parsePagesConfig(
    {
      pages: [
        {
          id: 'note-detail',
          label: 'Note detail',
          base: 'note',
          sections: [
            {
              kind: 'timeline',
              title: 'Activity',
              streams: [{ from: 'note', whose: 'item_id', at: 'at', show: 'name', about: 'item_id' }],
            },
          ],
        },
      ],
    },
    'PAGE_FILE',
  );
  const definition = app();
  const [captured] = captureTenantPages(definition, input);
  const section = plain(captured.sections[0]) as { streams: Array<{ of?: string }> };
  assert.deepEqual(
    section.streams.map((stream) => stream.of),
    ['item_id'],
  );
  const result = projectTenantMetadata(definition, [captured], schema());
  assert.equal(result.pages.length, 1);
  const unknown = {
    ...input[0],
    sections: [{ kind: 'timeline', streams: [{ from: 'note', path: 'item_id', at: 'at', show: 'name', with: 'x' }] }],
  };
  assert.throws(
    () => captureTenantPages(definition, [unknown]),
    (error: unknown) => (refusalReasons(error) as string[]).some((reason) => /stream has "with"/.test(reason)),
  );
});

test('read-only page projection strips related creation without losing the readable page', () => {
  const definition = app(),
    input = captureTenantPages(definition, [page({ ...list, create: { label: secret, show: ['hidden_secret'] } })]);
  const before = plain(input),
    result = projectTenantMetadata(definition, input, schema());
  assert.equal(result.pages.length, 1);
  noPrivate(result);
  assert.deepEqual(plain(result.pages[0].sections[0]), plain(list));
  assert.deepEqual(plain(input), before);
  assert.equal('create' in input[0].sections[0], true);
});

test('related empty links follow the tenant final room set without losing guidance', () => {
  const definition = app({
    views: {
      items: { kind: 'list', from: 'item', show: ['name'] },
      amounts: { kind: 'list', from: 'item', show: ['amount'] },
    },
    nav: ['items', 'amounts'],
  });
  const empty = { title: 'No notes yet', action: { label: 'Review amounts', view: 'amounts' } };
  const input = captureTenantPages(definition, [page({ ...list, empty })]);
  const full = projectTenantMetadata(definition, input, schema());
  assert.deepEqual(full.pages[0].sections[0].kind === 'list' && plain(full.pages[0].sections[0].empty), empty);
  const restricted = schema();
  restricted.tables[0].columns = restricted.tables[0].columns.filter((column) => column.name !== 'amount');
  const result = projectTenantMetadata(definition, input, restricted);
  assert.equal(Object.hasOwn(result.app.views, 'amounts'), false);
  assert.deepEqual(result.pages[0].sections[0].kind === 'list' && plain(result.pages[0].sections[0].empty), { title: empty.title });
  assert.deepEqual(input[0].sections[0].kind === 'list' && plain(input[0].sections[0].empty), empty);
});

test('metadata snapshots stay detached across caller edits and differently authorized schemas', () => {
  const definition = app(),
    input = [page()],
    catalog = schema();
  const before = structuredClone({ definition, input, catalog });
  const first = projectTenantMetadata(definition, input, catalog),
    held = plain(first);
  assert.deepEqual({ definition, input, catalog }, before);
  definition.name = 'Changed';
  input[0].name = 'Changed';
  catalog.tables[0].columns[1].name = 'Changed';
  assert.deepEqual(plain(first), held);
  const restricted = schema();
  restricted.tables = restricted.tables.filter((table) => table.id !== 'item');
  restricted.foreignKeys = [];
  const second = projectTenantMetadata(app(), [page()], restricted);
  assert.equal(second.app.nav.length, 0);
  assert.equal(second.pages.length, 0);
  assert.deepEqual(plain(first), held);
  assert.equal(Object.isFrozen(first), true);
});

for (const blocked of ['none', 'resource', 'binding', 'shown field', 'hidden field'] as const) {
  test(`related creation preserves the readable list with ${blocked} blocked`, () => {
    const definition = app(),
      catalog = schema();
    const note = catalog.tables.find((table) => table.id === 'note')!;
    note.columns.find((column) => column.name === 'id')!.identity = 'by-default';
    note.insertable = blocked !== 'resource';
    note.columns = note.columns.map((column) => ({
      ...column,
      writable: !(blocked === 'binding' && column.name === 'item_id') && !(blocked === 'shown field' && column.name === 'name'),
    }));
    const show = [blocked === 'hidden field' ? 'hidden_secret' : 'name'];
    const input = captureTenantPages(definition, [page({ ...list, create: { label: 'Add note', show } })]);
    const capabilities: TenantCapabilities = {
      resources: {
        note: {
          write: note.columns.filter((column) => column.writable).map((column) => column.name),
          insertable: note.insertable,
          deletable: false,
        },
      },
      writable: ['note'],
      grantedCommands: [],
    };
    const result = projectTenantMetadata(definition, input, catalog, capabilities);
    assert.equal(result.pages.length, 1);
    const section = result.pages[0].sections[0];
    assert.equal(section.kind, 'list');
    assert.equal('create' in section, blocked === 'none');
    if (section.kind === 'list' && blocked === 'none') assert.deepEqual(plain(section.create), { label: 'Add note', show: ['name'] });
    assert.doesNotMatch(JSON.stringify(result), /hidden_secret/);
    assert.equal('create' in input[0].sections[0], true);
  });
}

test('unknown configured pages disappear without publishing their validation diagnostics', () => {
  const definition = app(),
    pages = captureTenantPages(definition, [
      { ...page(), base: 'hidden_secret' },
      { ...page(), id: 'safe' },
    ]);
  const result = projectTenantMetadata(definition, pages, schema());
  assert.deepEqual(
    result.pages.map((value) => value.id),
    ['safe'],
  );
  noPrivate(result);
});

test('suggested pages retain logical relationships, config independence and readonly presentation', () => {
  const catalog = schema(),
    before = structuredClone(catalog),
    result = tenantSuggestedPage(catalog, 'item');
  assert.equal(result.id, 'suggested:item');
  assert.equal(result.source, 'suggested');
  assert.equal(result.base, 'item');
  assert.ok(result.sections.some((section) => section.kind === 'list' && section.from === 'note'));
  noPrivate(result);
  assert.deepEqual(catalog, before);
  assert.equal(Object.isFrozen(result.sections), true);
  const held = plain(result);
  catalog.tables[1].columns.length = 0;
  assert.deepEqual(plain(result), held);
});

for (const table of ['hidden_secret', 'physical_item', '', ' item', 'item\n']) {
  test(`suggested page safely refuses ${JSON.stringify(table)}`, () => {
    assert.throws(() => tenantSuggestedPage(schema(), table), safeFailure);
  });
}
test('suggested page refuses a root without a primary key', () => {
  const catalog = schema();
  catalog.tables[0].columns.forEach((column) => {
    column.primaryKey = false;
  });
  assert.throws(() => tenantSuggestedPage(catalog, 'item'), safeFailure);
});
