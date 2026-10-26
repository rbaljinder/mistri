import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSuiteLinkCatalog,
  resolveSuiteLink,
  suiteLinkProblems,
  unresolvedAppLinks,
  type SuiteLinkApp,
} from '../packages/mistri/src/server/app/suiteLinks.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { appAddressBook, readAppSegments } from '../packages/mistri/src/shared/appAddress.js';
import { appMounts } from '../packages/engine/src/shared/mount.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { BoundAppTarget } from '../packages/engine/src/shared/appLinks.js';

const column = (name: string, primaryKey = false) => ({ name, type: 'text', nullable: false, primaryKey });
const table = (name: string, keys: string[], extra: string[] = []) => ({
  id: name,
  name,
  schema: '',
  isView: false,
  columns: [...keys.map((key) => column(key, true)), ...extra.map((key) => column(key))],
});
const schema: DatabaseSchema = {
  label: 'Suite',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    table('application', ['id'], ['dealer_id', 'secret', 'reference']),
    table('orders', ['id']),
    {
      ...table('line', ['order_id', 'number']),
      columns: [{ ...column('order_id', true), references: { table: 'orders', column: 'id' } }, column('number', true)],
    },
    table('cell', ['x', 'y']),
    table('undeclared', ['id']),
  ],
};
function deployment(id: string, natural = false): SuiteLinkApp {
  const app = parseAppConfig(
    {
      id,
      name: id,
      resources: { application: { hidden: ['secret'] }, orders: {}, line: {}, cell: {} },
      views: {
        applications: { kind: 'list', from: 'application', path: 'work' },
        orders: { kind: 'list', from: 'orders' },
        lines: { kind: 'list', from: 'line' },
        cells: { kind: 'list', from: 'cell' },
      },
      home: 'applications',
      nav: ['applications'],
    },
    id,
  );
  return {
    app,
    pages: [],
    surfaces: [
      {
        realm: 'app',
        schema: structuredClone(schema),
        book: appAddressBook({
          views: app.views,
          order: ['applications', 'orders', 'lines', 'cells'],
          resources: natural ? { application: { address: 'reference' } } : {},
          pages: [],
          tables: schema.tables,
        }),
      },
    ],
  };
}
const mount = appMounts(['lender', 'leads'], { base: '/tools/team', mounts: { lender: '', leads: 'desk' } });
function source(to: unknown, field = 'id'): SuiteLinkApp {
  const input = deployment('leads');
  input.pages = [
    {
      id: 'application',
      name: 'Application',
      base: 'application',
      source: 'config',
      sections: [{ kind: 'note', text: 'Open', action: { label: 'Lender', to: to as BoundAppTarget } }],
    },
  ];
  input.surfaces[0].visibleFields = { application: [field] };
  return input;
}
const record = (resource: string, key: Record<string, string | number>): BoundAppTarget => ({
  app: 'lender',
  kind: 'record',
  resource,
  key,
});

test('canonical suite mount translation, opaque values and target paths', () => {
  const apps = [deployment('lender'), deployment('leads')],
    catalog = createSuiteLinkCatalog(apps, mount);
  assert.equal(resolveSuiteLink(catalog, { app: 'lender', kind: 'home' }), '/tools/team/?app=lender');
  assert.equal(resolveSuiteLink(catalog, { app: 'leads', kind: 'home' }), '/tools/team/desk');
  const root = createSuiteLinkCatalog(apps, appMounts(['lender', 'leads'], { mounts: { lender: '', leads: 'desk' } }));
  assert.equal(resolveSuiteLink(root, { app: 'lender', kind: 'home' }), '/?app=lender');
  assert.equal(resolveSuiteLink(catalog, { app: 'leads', kind: 'view', view: 'applications' }), '/tools/team/desk/work');
  assert.equal(resolveSuiteLink(catalog, record('application', { id: '9007199254740993' })), '/tools/team/work/9007199254740993');
  assert.equal(resolveSuiteLink(catalog, record('application', { id: 'a/b?c#d%é' })), '/tools/team/work/a%2Fb%3Fc%23d%25%C3%A9');
  assert.equal(resolveSuiteLink(catalog, record('application', { id: 'new' })), '/tools/team/work/id=new');
  assert.equal(resolveSuiteLink(catalog, record('line', { order_id: '12', number: '3' })), '/tools/team/orders/12/lines/3');
  const named = resolveSuiteLink(catalog, record('cell', { y: 'a,b=c', x: '1/2' }));
  assert.equal(named, '/tools/team/cells/x=1%2F2,y=a%2Cb%3Dc');
  const parsed = readAppSegments(apps[0].surfaces[0].book, named.slice('/tools/team/'.length).split('/'));
  assert.ok(parsed?.kind === 'record');
  assert.deepEqual(parsed.key, { x: '1/2', y: 'a,b=c' });
  assert.throws(() => resolveSuiteLink(catalog, record('application', { id: '..' })), /normalized/);
  apps[0].surfaces[0].book.views.set('applications', 'changed');
  assert.equal(resolveSuiteLink(catalog, { app: 'lender', kind: 'view', view: 'applications' }), '/tools/team/work');
});

test('natural-key route accepts target PK and writes its unambiguous named fallback', () => {
  const catalog = createSuiteLinkCatalog([deployment('lender', true), deployment('leads')], mount);
  assert.equal(resolveSuiteLink(catalog, record('application', { id: '123' })), '/tools/team/work/id=123');
  assert.throws(() => resolveSuiteLink(catalog, record('application', { reference: 'REF-123' })), /primary-key columns/);
});

test('validation collects authored links and rejects undeclared/fallback targets and source fields', () => {
  const target = { app: 'lender', kind: 'record', resource: 'application', key: { id: { column: 'id' } } };
  const input = source(target);
  const catalog = createSuiteLinkCatalog([deployment('lender'), input], mount);
  assert.equal(catalog.declarations.length, 1);
  assert.match(unresolvedAppLinks(input)[0], /unresolved without a suite link catalog/);
  for (const [bad, message] of [
    [{ ...target, app: 'missing' }, /Unknown target App/],
    [{ app: 'lender', kind: 'view', view: 'missing' }, /routable/],
    [{ ...target, resource: 'undeclared' }, /does not declare resource/],
    [{ ...target, key: { wrong: '1' } }, /primary-key columns/],
    [{ ...target, key: { id: '1', extra: '2' } }, /primary-key columns/],
    [{ ...target, key: { id: '..' } }, /normalized/],
    [{ ...target, key: { id: { column: 'secret' } } }, /not visible/],
    [{ ...target, key: { id: { column: 'absent' } } }, /not visible/],
  ] as const)
    assert.throws(() => createSuiteLinkCatalog([deployment('lender'), source(bad, 'secret')], mount), message);
  assert.throws(() => resolveSuiteLink(catalog, target as unknown as BoundAppTarget), /record surface/);
  assert.throws(() => resolveSuiteLink(catalog, record('line', { order_id: '1' })), /primary-key columns/);
  assert.throws(() => resolveSuiteLink(catalog, { app: 'lender', kind: 'home', tenant: { kind: 'choose' } }), /Ordinary target/);
  assert.ok(suiteLinkProblems([deployment('lender'), input], { base: '/tools', apps: { lender: '', leads: '' } }).length);
});

test('tenant intent selects only declared target realms, never supplies membership', () => {
  const lender = deployment('lender');
  lender.app.auth = { rows: 'tenant', tenancy: {} } as AppDef['auth'];
  lender.surfaces[0].realm = 'tenant';
  const apps = [lender, deployment('leads')];
  let catalog = createSuiteLinkCatalog(apps, mount);
  assert.equal(
    resolveSuiteLink(catalog, { ...record('application', { id: 'same' }), tenant: { kind: 'tenant', id: 'north / +%' } }),
    '/tools/team/work/same?tenant=north+%2F+%2B%25',
  );
  assert.equal(resolveSuiteLink(catalog, { app: 'lender', kind: 'home', tenant: { kind: 'choose' } }), '/tools/team/?app=lender');
  assert.throws(
    () => resolveSuiteLink(catalog, { app: 'lender', kind: 'home', tenant: { kind: 'platform' } }),
    /declares no platform realm/,
  );
  lender.app.auth!.tenancy!.platform = { label: 'Platform' } as NonNullable<NonNullable<AppDef['auth']>['tenancy']>['platform'];
  lender.surfaces = [...lender.surfaces, { ...structuredClone(lender.surfaces[0]), realm: 'platform' }];
  catalog = createSuiteLinkCatalog(apps, mount);
  assert.equal(
    resolveSuiteLink(catalog, { app: 'lender', kind: 'home', tenant: { kind: 'platform' } }),
    '/tools/team/?app=lender&realm=platform',
  );
});
