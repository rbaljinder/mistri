/**
 * An employee portal's three pieces: a top bar drawn for the roles an App
 * names (`ui.shell.placement: { top: [...] }`), a dashboard's find box over
 * several resources (`find()`), and a card's description. Each is judged at
 * load, and the first two are said for a principal where the App is served.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAppConfig, resolveViews } from '../packages/mistri/src/shared/app.js';
import type { AppDashboardView } from '../packages/mistri/src/shared/appModel.js';
import { appForRoles, topBarFor } from '../packages/mistri/src/shared/appViewRoles.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { typecheck } from './support/tsc.js';

const col = (name: string, type = 'TEXT', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const table = (id: string, ...names: string[]): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: [col('id', 'INTEGER', true), ...names.map((name) => col(name))],
});
const schema: DatabaseSchema = {
  tables: [table('article', 'title', 'topic'), table('catalog_item', 'name', 'summary'), table('ticket', 'subject')],
  foreignKeys: [],
} as unknown as DatabaseSchema;

const portal = (extra: Record<string, any> = {}) => ({
  name: 'Portal',
  connection: 'db',
  resources: { article: {}, catalog_item: {}, ticket: {} },
  auth: { roles: { employee: { read: true }, agent: { read: true }, admin: { read: true } } },
  ui: { shell: { placement: { top: ['employee'] } } },
  home: 'home',
  views: {
    home: {
      kind: 'dashboard',
      label: 'Home',
      sections: [
        { kind: 'find', title: 'Find anything', resources: ['article', 'catalog_item'], placeholder: 'Search help and the catalog' },
      ],
    },
    articles: { kind: 'list', label: 'Help', from: 'article' },
    catalog: {
      kind: 'list',
      label: 'Catalog',
      from: 'catalog_item',
      presentation: { kind: 'cards', primary: 'name', description: 'summary' },
    },
    queue: { kind: 'list', label: 'Queue', from: 'ticket', roles: ['agent'] },
  },
  ...extra,
});
const load = (extra: Record<string, any> = {}) => parseAppConfig(portal(extra), 'portal');
const refused = (extra: Record<string, any>, pattern: RegExp) => assert.throws(() => load(extra), pattern);

describe('a top bar by role', () => {
  test('a person whose every role is listed gets the top bar; one holding another role, or none, the sidebar', () => {
    const app = load();
    assert.equal(appForRoles(app, ['employee']).ui?.shell?.placement, 'top');
    assert.equal(appForRoles(app, ['agent']).ui?.shell?.placement, 'side');
    assert.equal(
      appForRoles(app, ['employee', 'agent']).ui?.shell?.placement,
      'side',
      'an employee who is an agent too works in the sidebar',
    );
    assert.equal(appForRoles(app, []).ui?.shell?.placement, 'side', 'a signed-out visitor holds no role');
    // The menu is still what the person may open: the employee's has no queue.
    assert.deepEqual(Object.keys(appForRoles(app, ['employee']).views).sort(), ['articles', 'catalog', 'home']);
    assert.equal(appForRoles(app, ['employee']), appForRoles(app, ['employee']), 'one served App per role set');
    assert.equal(topBarFor({ top: ['employee', 'admin'] }, ['admin', 'employee']), true);
  });

  test('an App that says one placement for everyone is served it unchanged', () => {
    const app = load({
      ui: { shell: { placement: 'top' } },
      home: 'articles',
      views: { articles: { kind: 'list', label: 'Help', from: 'article' } },
    });
    assert.equal(appForRoles(app, ['agent']), app);
  });

  test('what cannot be drawn is refused at load', () => {
    refused(
      { ui: { shell: { placement: { top: ['visitor'] } } } },
      /ui\.shell\.placement has "top" naming "visitor", which auth\.roles does not declare/,
    );
    refused({ ui: { shell: { placement: { top: [] } } } }, /ui\.shell\.placement has an empty "top"/);
    refused({ ui: { shell: { placement: { side: ['agent'] } } } }, /ui\.shell\.placement/);
    refused({ ui: { shell: { placement: { top: 'employee' } } } }, /ui\.shell\.placement\.top must be a list/);
  });
});

describe('a find box', () => {
  test('is served the tables of the resources it names that this catalog holds', () => {
    const home = resolveViews(load(), schema).home as AppDashboardView;
    assert.deepEqual(home.sections[0], {
      kind: 'find',
      title: 'Find anything',
      searched: ['article', 'catalog_item'],
      placeholder: 'Search help and the catalog',
    });
    const narrowed = { ...schema, tables: schema.tables.filter((each) => each.id !== 'article') } as DatabaseSchema;
    assert.deepEqual(
      (resolveViews(load(), narrowed).home as AppDashboardView).sections[0].searched,
      ['catalog_item'],
      'a resource this reader cannot read is not searched',
    );
  });

  test('names declared resources, one to six', () => {
    const home = (sections: unknown[]) => ({ views: { home: { kind: 'dashboard', label: 'Home', sections } } });
    refused(home([{ kind: 'find', resources: [] }]), /is a find and needs "resources": one to 6 resource names/);
    refused(home([{ kind: 'find', resources: 'article' }]), /is a find and needs "resources"/);
    refused(home([{ kind: 'find', resources: ['invoice'] }]), /invoice/);
    refused(home([{ kind: 'find', resources: ['article'], from: 'article' }]), /"from"/);
  });
});

describe("a card's description", () => {
  test("is a local text column of the card's table", () => {
    const cards = (description: unknown) => ({
      views: {
        catalog: { kind: 'list', label: 'Catalog', from: 'catalog_item', presentation: { kind: 'cards', primary: 'name', description } },
      },
      home: 'catalog',
    });
    assert.equal((load().views.catalog as { presentation?: { description?: string } }).presentation?.description, 'summary');
    refused(cards('owner.name'), /"description" must name a local column, not a path/);
    const listed = resolveViews(load(cards('nowhere')), schema).catalog as { error?: string; errors?: string[] };
    assert.match(String(listed.error ?? listed.errors), /Cards description: "nowhere" must be a local readable column/);
  });
});

test("the DSL types a top bar's roles and a find box's resources against the App's own", () => {
  const filename = join(dirname(fileURLToPath(import.meta.url)), '.app-portal-typecheck.ts');
  /* Each App on its lines, a directive above the line its mistake is reported at. */
  const app = (name: string, role: string, resource: string, expect: { role?: string; resource?: string } = {}) => [
    `export const ${name} = defineApp({ name: "x", resources: { article: {} }, auth: { roles: { employee: { read: true } } }, home: "h",`,
    ...(expect.role ? [`  // @ts-expect-error ${expect.role}`] : []),
    `  ui: { shell: { placement: { top: ["${role}"] } } },`,
    ...(expect.resource ? [`  // @ts-expect-error ${expect.resource}`] : []),
    `  views: { a: listView("A", "article"), h: dashboard("H", [find("F", ["${resource}"])]) }, nav: ["h"] });`,
  ];
  const source = [
    'import { dashboard, defineApp, find, listView } from "@mistriwork/mistri/app";',
    ...app('fine', 'employee', 'article'),
    ...app('role', 'visitor', 'article', { role: 'The top bar names a role the App declares.' }),
    ...app('resource', 'employee', 'articel', { resource: 'A find box names a resource the App declares.' }),
  ].join('\n');
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
