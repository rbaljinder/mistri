/** Authored App menus are bounded navigation intent, separate from local rooms. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { typecheck } from './support/tsc.js';
import { appLink } from '../packages/mistri/schema/app.mjs';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { navViewKeys, viewOrder } from '../packages/mistri/src/shared/appModel.js';
import { parseUi } from '../packages/mistri/src/shared/appUi.js';
import { appRealms, appSurfaceForRealm } from '../packages/mistri/src/shared/appTenancy.js';
import { tenantBusinessApp } from '../packages/mistri/src/shared/appAccess.js';
import { servedApp, servedUi, withoutBrokenViews } from '../packages/mistri/src/shared/appPayload.js';
import { appAddressBook } from '../packages/mistri/src/shared/appAddress.js';
import { collectAppLinks, createSuiteLinkCatalog, type SuiteLinkApp } from '../packages/mistri/src/server/app/suiteLinks.js';
import { roomReads } from '../packages/mistri/src/server/http/firstPaintRooms.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const target = { app: 'foreign', kind: 'view', view: 'work' } as const;
const link = { label: 'Foreign work', to: target };
const menu = () => ({ placement: 'navbar', label: 'Workspaces', groups: [{ label: 'Work', links: [link] }] });
const raw = (nav: unknown[] = ['work', link]) => ({
  id: 'local',
  name: 'Local',
  resources: { note: {} },
  views: { work: { kind: 'list', from: 'note' } },
  home: 'work',
  nav,
});
const schema: DatabaseSchema = {
  label: 'Fixture',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    { id: 'note', name: 'note', schema: '', isView: false, columns: [{ name: 'id', type: 'text', primaryKey: true, nullable: false }] },
  ],
};
const parse = (appSwitcher: unknown) => parseUi({ appSwitcher }, 'navigation fixture');
const ajv = new Ajv2020({ strict: false });
for (const name of ['theme', 'page', 'app'])
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8')));
const validate = ajv.getSchema('app.schema.json#/$defs/appSwitcher')!;

test('only authored switchers survive normalization and serving, independently of private branding', () => {
  assert.equal(parseUi(undefined, 'fixture').appSwitcher, undefined);
  assert.equal(servedUi({}).appSwitcher, undefined);
  for (const placement of ['navbar', 'account'])
    for (const choices of [{ apps: 'authorized' }, { apps: ['local', 'foreign'] }, { groups: menu().groups }]) {
      const input = { placement, ...choices },
        before = structuredClone(input);
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      assert.deepEqual(parse(input).appSwitcher, input);
      assert.deepEqual(input, before);
    }
  const normalized = parse({ ...menu(), label: ' Workspaces ' });
  assert.equal(normalized.appSwitcher!.label, 'Workspaces');
  const served = servedUi(normalized);
  assert.notEqual(served.appSwitcher, normalized.appSwitcher);
  assert.notEqual(served.appSwitcher!.groups, normalized.appSwitcher!.groups);
  assert.deepEqual(served.appSwitcher, normalized.appSwitcher);
  const branded = parseUi(
    {
      appSwitcher: menu(),
      theme: {
        kind: 'fromRecord',
        from: 'brand',
        by: 'tenant',
        tenantField: 'tenant_id',
        fallback: { preset: 'sage' },
        fields: { name: 'name' },
      },
    },
    'fixture',
  );
  assert.equal(Object.hasOwn(servedUi(branded), 'branding'), false);
  assert.deepEqual(servedUi(branded).appSwitcher, menu());
});

test('parser and JSON schema refuse malformed, mixed, unbounded and row-bound menu declarations', () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { apps: 'authorized' },
    { placement: 'side', apps: 'authorized' },
    { placement: 'navbar' },
    { ...menu(), apps: 'authorized' },
    { ...menu(), href: '/raw' },
    { placement: 'navbar', apps: [] },
    { placement: 'navbar', apps: ['local', 'local'] },
    { placement: 'navbar', apps: ['../foreign'] },
    { placement: 'navbar', apps: ['foreign\n'] },
    { placement: 'navbar', apps: Array.from({ length: 65 }, (_, i) => `app${i}`) },
    { ...menu(), groups: [] },
    { ...menu(), groups: Array.from({ length: 13 }, (_, i) => ({ label: `Group ${i}`, links: [link] })) },
    ...['', ' ', 'x'.repeat(121), 'bad\0label', '\ud800'].map((label) => ({ ...menu(), label })),
    { ...menu(), groups: [{ label: 'Work', links: [] }] },
    { ...menu(), groups: [{ label: 'Work', href: '/raw', links: [link] }] },
    { ...menu(), groups: [{ label: 'Work', links: Array.from({ length: 33 }, (_, i) => ({ ...link, label: `Link ${i}` })) }] },
  ];
  for (const to of [
    { ...target, href: '/raw' },
    { app: 'foreign', kind: 'record', resource: 'note', key: { id: { column: 'id' } } },
    { ...target, tenant: { kind: 'tenant', id: { column: 'tenant_id' } } },
  ]) {
    invalid.push({ ...menu(), groups: [{ label: 'Work', links: [{ label: 'Open', to }] }] });
    assert.throws(() => parseAppConfig(raw([{ label: 'Open', to }]), 'fixture'));
  }
  for (const extra of ['view', 'href', 'realm', 'unknown']) {
    const entry = { ...link, [extra]: 'wrong' };
    invalid.push({ ...menu(), groups: [{ label: 'Work', links: [entry] }] });
    assert.throws(() => parseAppConfig(raw([entry]), 'fixture'));
  }
  for (const value of invalid) {
    assert.throws(() => parse(value), JSON.stringify(value));
    assert.equal(validate(value), false, JSON.stringify(value));
  }
  // Property uniqueness after normalization is a parser relational check.
  assert.throws(
    () => parse({ ...menu(), groups: [menu().groups[0], { label: ' work ', links: [{ ...link, label: 'Other' }] }] }),
    /repeats/,
  );
  assert.throws(
    () => parse({ ...menu(), groups: [{ label: 'Work', links: [link, { label: ' foreign WORK ', to: { app: 'local', kind: 'home' } }] }] }),
    /repeats/,
  );
  let invoked = false;
  assert.throws(() =>
    parse({
      placement: 'navbar',
      get apps() {
        invoked = true;
        return 'authorized';
      },
    }),
  );
  assert.equal(invoked, false);
  assert.throws(() => parse({ placement: 'account', apps: Array(1) }));
});

test('checked leaves never manufacture local references, reachability, ordering or counts', () => {
  const app = parseAppConfig(
    raw([link, { id: 'group', label: 'Group', children: ['work', { ...link, to: { ...target, app: 'local' } }] }]),
    'fixture',
  );
  assert.deepEqual(navViewKeys(app.nav), ['work']);
  assert.deepEqual(viewOrder(app), ['work']);
  const payload = servedApp(app, schema);
  assert.deepEqual(payload.nav[0], link);
  assert.deepEqual(withoutBrokenViews({ ...payload, views: {} }, []).nav, [
    link,
    { group: 'group', label: 'Group', children: [{ ...link, to: { ...target, app: 'local' } }] },
  ]);
  assert.throws(() => parseAppConfig(raw(['typo', link]), 'fixture'), /does not declare/);
  const orphan = {
    ...raw([link]),
    views: { ...raw().views, orphan: { kind: 'dashboard', label: 'Orphan', sections: [{ kind: 'note', text: 'Orphan' }] } },
  };
  assert.throws(
    () => parseAppConfig({ ...orphan, nav: [{ label: 'Self', to: { app: 'local', kind: 'view', view: 'orphan' } }] }, 'fixture'),
    /referenced by nothing/,
  );
  const onlyTargets = { ...payload, nav: [link], ui: { shell: { counts: true } } };
  assert.deepEqual(
    roomReads({ app: 'local', path: '/local', search: '', payload: onlyTargets, schema, pages: {}, me: {}, visitor: false }).batches,
    [],
  );
  const feature = { id: 'feature', views: { inside: { kind: 'list', from: 'note' } }, nav: [link, 'inside'] };
  const composed = parseAppConfig({ ...raw(), features: [feature], nav: ['work', { feature: 'feature' }] }, 'fixture');
  assert.deepEqual(navViewKeys(composed.nav), ['work', 'inside']);
  assert.deepEqual(composed.nav[1], link);
  assert.throws(
    () => parseAppConfig({ ...raw(), features: [{ ...feature, nav: [link, 'work'] }], nav: [{ feature: 'feature' }] }, 'fixture'),
    /own views/,
  );
});

test('root targets are source-realm neutral; nested links follow their source group, not target intent', () => {
  const definition = parseAppConfig(
    {
      id: 'local',
      name: 'Local',
      sources: { business: { connection: 'business-db' } },
      resources: { note: { owner: 'tenant' }, dealer: { owner: 'platform' } },
      auth: {
        rows: 'tenant',
        tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Platform' } },
        roles: { reader: { realm: 'tenant', read: ['note'], write: false }, manager: { realm: 'platform', read: true, write: false } },
      },
      views: { work: { kind: 'list', from: 'note', realm: 'tenant' }, global: { kind: 'list', from: 'dealer', realm: 'platform' } },
      home: [{ view: 'global', roles: ['manager'] }, { view: 'work' }],
      nav: [
        link,
        {
          id: 'tenant',
          label: 'Tenant',
          realm: 'tenant',
          children: [
            'work',
            { id: 'nested', label: 'Nested', children: [{ label: 'Target platform', to: { ...target, tenant: { kind: 'platform' } } }] },
          ],
        },
        { id: 'platform', label: 'Platform', realm: 'platform', children: ['global', link] },
      ],
    },
    'fixture',
  );
  const tenant = appSurfaceForRealm(definition, [], 'tenant').app;
  const platform = appSurfaceForRealm(definition, [], 'platform').app;
  assert.deepEqual(navViewKeys(tenant.nav), ['work']);
  assert.deepEqual(navViewKeys(platform.nav), ['global']);
  assert.deepEqual(tenant.nav[0], link);
  assert.deepEqual(platform.nav[0], link);
  assert.equal(JSON.stringify(tenant.nav).includes('"group":"platform"'), false);
  assert.equal(JSON.stringify(platform.nav).includes('"group":"tenant"'), false);
  assert.equal(appRealms(definition).view('work'), 'tenant');
  assert.equal(appRealms(definition).view('global'), 'platform');
  const declarations = collectAppLinks({ app: definition, pages: [] });
  assert.deepEqual(
    declarations.map((item) => item.realm),
    ['neutral', 'tenant', 'platform'],
  );
  const business = tenantBusinessApp({
    ...definition,
    sources: { external: { connection: 'other', realm: 'platform', default: false } },
    resources: { ...definition.resources, dealer: { ...definition.resources!.dealer, source: 'external' } },
  });
  assert.deepEqual(navViewKeys(business.nav), ['work']);
  assert.deepEqual(business.nav.at(-1), { group: 'platform', label: 'Platform', realm: 'platform', children: [link] });
  const broken = withoutBrokenViews(servedApp(tenant, { ...schema, tables: [] }), []);
  assert.deepEqual(navViewKeys(broken.nav), []);
  assert.equal(JSON.stringify(broken.nav).includes('"group":"platform"'), false);
});

test('generated target kinds and nesting depths preserve only actual local leaves', () => {
  for (const app of ['local', 'foreign'])
    for (const to of [
      { app, kind: 'home' },
      { app, kind: 'view', view: 'work' },
      { app, kind: 'record', resource: 'note', key: { id: 'opaque/9007199254740993' } },
    ])
      for (let depth = 0; depth <= 8; depth++) {
        let nav: unknown[] = ['work', { label: 'Checked', to }];
        for (let level = 0; level < depth; level++) nav = [{ id: `level-${level}`, label: `Level ${level}`, children: nav }];
        const definition = parseAppConfig(raw(nav), 'generated');
        assert.deepEqual(navViewKeys(definition.nav), ['work']);
        assert.deepEqual(viewOrder(definition), ['work']);
        const declarations = collectAppLinks({ app: definition, pages: [] });
        assert.equal(declarations.length, 1);
        assert.deepEqual(declarations[0].target, to);
        assert.equal(declarations[0].at.split('.children').length - 1, depth);
        const payload = servedApp(definition, schema);
        assert.deepEqual(navViewKeys(withoutBrokenViews(payload, []).nav), ['work']);
      }
});

function deployment(id: string, appSwitcher?: unknown): SuiteLinkApp {
  const app = parseAppConfig({ ...raw(id === 'local' ? [link] : ['work']), id, ui: { appSwitcher } }, 'fixture');
  return {
    app,
    pages: [],
    surfaces: [
      {
        realm: 'app',
        schema,
        book: appAddressBook({ views: app.views, order: ['work'], resources: {}, pages: [], tables: schema.tables }),
      },
    ],
  };
}

test('catalog collects exact nav/menu locations and validates listed deployment IDs without expanding authorized', () => {
  const local = deployment('local', menu()),
    foreign = deployment('foreign'),
    mount = { base: '', apps: { local: 'local', foreign: 'foreign' } };
  const declared = createSuiteLinkCatalog([local, foreign], mount).declarations;
  assert.deepEqual(
    declared.map((item) => item.at),
    ['App "local", nav[0]', 'App "local", ui.appSwitcher.groups[0].links[0]'],
  );
  assert.ok(declared.every((item) => item.realm === 'neutral' && !item.sourceResource));
  const compact = deployment('local', { placement: 'account', apps: ['foreign'] });
  assert.deepEqual(collectAppLinks(compact).at(-1)!.target, { app: 'foreign', kind: 'home' });
  assert.match(collectAppLinks(compact).at(-1)!.at, /ui.appSwitcher.apps\[0\]/);
  assert.throws(
    () => createSuiteLinkCatalog([deployment('local', { placement: 'navbar', apps: ['missing'] }), foreign], mount),
    /ui.appSwitcher.apps\[0\].*Unknown target App "missing"/,
  );
  const invalid = { ...menu(), groups: [{ label: 'Group', links: [{ label: 'Missing', to: { ...target, view: 'missing' } }] }] };
  assert.throws(() => createSuiteLinkCatalog([deployment('local', invalid), foreign], mount), /groups\[0\].links\[0\].*routable/);
  assert.equal(collectAppLinks(deployment('foreign', { placement: 'navbar', apps: 'authorized' })).length, 0);
  const self = deployment('foreign', {
    placement: 'navbar',
    groups: [{ label: 'Self', links: [{ ...link, to: { ...target, app: 'foreign' } }] }],
  });
  assert.doesNotThrow(() => createSuiteLinkCatalog([self], { base: '/tools', apps: { foreign: '' } }));
  assert.equal(appLink(target), target);
});

test('typed helpers preserve static targets, feature/local references and the closed switcher union', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)),
    filename = `${root}test/__navigation_contract__.ts`;
  const source = `import { defineApp, defineFeature, listView, navGroup, appLink, type StaticAppTarget, type AppSwitcher, type AppNavNode } from '../packages/mistri/schema/app.js';
    type Foreign = { id: 'foreign'; resources: { note: {} }; views: { work: { kind: 'list'; table: 'note' } } };
    const to: StaticAppTarget = appLink<Foreign>({ app: 'foreign', kind: 'record', resource: 'note', key: { id: 'opaque' } });
    const grouped: AppSwitcher = { placement: 'navbar', groups: [{ label: 'Work', links: [{ label: 'Open', to }] }] };
    const feature = defineFeature({ id: 'slice', views: { inside: listView('note') }, nav: ['inside', { label: 'Foreign', to }] });
    defineApp({ id: 'local', name: 'Local', resources: { note: {} }, views: { work: listView('note') },
      home: 'work', features: [feature], nav: ['work', navGroup('work', 'Work', [{ label: 'Open', to }, { feature: 'slice' }])], ui: { appSwitcher: grouped } });
    // @ts-expect-error mixed picker/menu
    const mixed: AppSwitcher = { placement: 'account', apps: 'authorized', groups: [] };
    // @ts-expect-error no choices
    const empty: AppSwitcher = { placement: 'navbar' };
    // @ts-expect-error raw href is not menu authority
    const href: AppSwitcher = { placement: 'navbar', groups: [{ label: 'Work', links: [{ label: 'Raw', href: '/raw' }] }] };
    // @ts-expect-error record-bound return is not a static target
    const bound: StaticAppTarget = appLink<Foreign>({ app: 'foreign', kind: 'record', resource: 'note', key: { id: { column: 'id' } } });
    // @ts-expect-error static nav has no source row
    const row: AppNavNode = { label: 'Open', to: { app: 'foreign', kind: 'record', resource: 'note', key: { id: { column: 'id' } } } };
    // @ts-expect-error mixed local and checked leaf
    const both: AppNavNode = { view: 'work', label: 'Work', to };
    // @ts-expect-error unknown target view
    appLink<Foreign>({ app: 'foreign', kind: 'view', view: 'typo' });
    // @ts-expect-error local references remain checked beside foreign ones
    defineApp({ name: 'Bad', resources: { note: {} }, views: { work: listView('note') }, home: 'work', nav: ['typo', { label: 'Foreign', to }] });
    // @ts-expect-error feature references remain local
    defineFeature({ id: 'bad', views: { inside: listView('note') }, nav: ['elsewhere', { label: 'Foreign', to }] });
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
