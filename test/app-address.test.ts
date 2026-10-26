import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appAddressBook,
  naturalKeyProblems,
  readAppSegments,
  recordSegments,
  routeTable,
  type AddressBookInput,
} from '../packages/mistri/src/shared/appAddress.js';
import { tabWord, tabMatches } from '../packages/engine/src/shared/addressParams.js';
import { appForRoles, pagesForRoles } from '../packages/mistri/src/shared/appViewRoles.js';
import { viewOrder } from '../packages/mistri/src/shared/appModel.js';

/**
 * An App's addresses read back into what wrote them: a record under the view
 * that shows its table, a natural key, a slug that only decorates, a
 * composite key under its parent or by name, ids past 2^53 as text.
 */
const col = (name: string, extra: Partial<{ primaryKey: boolean; references: { table: string; column: string } }> = {}) => ({
  name,
  primaryKey: false,
  ...extra,
});
const tables: AddressBookInput['tables'] = [
  { id: 'lead', name: 'lead', columns: [col('id', { primaryKey: true }), col('name')] },
  { id: 'task', name: 'task', columns: [col('id', { primaryKey: true }), col('title')] },
  { id: 'product', name: 'product', columns: [col('id', { primaryKey: true }), col('sku')] },
  { id: 'vehicle', name: 'vehicle', columns: [col('id', { primaryKey: true }), col('title')] },
  { id: 'orders', name: 'orders', columns: [col('id', { primaryKey: true })] },
  {
    id: 'order_line',
    name: 'order_line',
    columns: [col('order_id', { primaryKey: true, references: { table: 'orders', column: 'id' } }), col('line', { primaryKey: true })],
  },
  { id: 'grid', name: 'grid', columns: [col('x', { primaryKey: true }), col('y', { primaryKey: true }), col('v')] },
  { id: 'note', name: 'note', columns: [col('id', { primaryKey: true })] },
];
const input: AddressBookInput = {
  order: ['sales-dashboard', 'leads', 'task-calendar', 'tasks', 'products', 'vehicles', 'orders', 'lines', 'intake'],
  views: {
    'sales-dashboard': { sections: [] },
    leads: { table: 'lead' },
    'task-calendar': { table: 'task', presentation: { kind: 'calendar' } },
    tasks: { table: 'task', path: 'todo' },
    products: { table: 'product' },
    vehicles: { table: 'vehicle' },
    orders: { table: 'orders' },
    lines: { table: 'order_line' },
    intake: { command: {} },
  },
  resources: { task: { view: 'tasks' }, product: { address: 'sku' }, vehicle: { slug: true } },
  pages: [
    { id: 'grid-page', base: 'grid', path: 'cells' },
    { id: 'lead', base: 'lead' },
  ],
  tables,
};
const book = appAddressBook(input);

test('each table has one route: the resource names it, else the first plain list, else its page, else its name', () => {
  assert.deepEqual(book.problems, []);
  assert.equal(book.records.get('lead')!.segment, 'leads');
  assert.equal(book.records.get('task')!.segment, 'todo', 'the resource names tasks, whose path is todo');
  assert.equal(book.records.get('grid')!.segment, 'cells', 'a table no list shows is its page');
  assert.equal(book.records.get('note')!.segment, 'note', 'nothing shows it: its own name');
  assert.equal(book.views.get('sales-dashboard'), 'sales-dashboard');
  assert.equal(book.pages.get('lead'), undefined, 'a list addresses its records; the page needs no route of its own');
  // Without the resource's word, the first plain list (a calendar is a list) in the menu's order.
  const plain = appAddressBook({ ...input, resources: {} });
  assert.equal(plain.records.get('task')!.segment, 'task-calendar');
});

test('a record is written under its route and read back to the same key', () => {
  const at = recordSegments(book, 'lead', { key: { id: 127 } });
  assert.deepEqual(at, ['leads', '127']);
  assert.deepEqual(readAppSegments(book, at!), {
    kind: 'record',
    target: { kind: 'list', view: 'leads', table: 'lead' },
    table: 'lead',
    key: { id: '127' },
  });
  assert.deepEqual(recordSegments(book, 'lead', { key: { id: 127 }, tab: 'campaign-history' }), ['leads', '127', 'campaign-history']);
  assert.equal((readAppSegments(book, ['leads', '127', 'campaign-history']) as { tab: string }).tab, 'campaign-history');
  // Past 2^53: text in, text out.
  const big = '9007199254740993';
  assert.deepEqual(recordSegments(book, 'lead', { key: { id: big } }), ['leads', big]);
  assert.deepEqual((readAppSegments(book, ['leads', big]) as { key: object }).key, { id: big });
  // An id that would read as something else is said by name.
  assert.deepEqual(recordSegments(book, 'lead', { key: { id: 'new' } }), ['leads', 'id=new']);
  assert.deepEqual((readAppSegments(book, ['leads', 'id=new']) as { key: object }).key, { id: 'new' });
  assert.deepEqual(readAppSegments(book, ['leads', 'new']), { kind: 'new', target: { kind: 'list', view: 'leads', table: 'lead' } });
  // A value with the separators — or the older forms' marks — in it is escaped, and read back whole.
  for (const odd of ['a/b,c=d', '@x~1', 'wow!', 'a:b']) {
    const said = recordSegments(book, 'lead', { key: { id: odd } })!;
    assert.deepEqual((readAppSegments(book, said) as { key: object }).key, { id: odd }, odd);
  }
  const odd = 'a/b,c=d';
  const said = recordSegments(book, 'lead', { key: { id: odd } })!;
  assert.deepEqual((readAppSegments(book, said) as { key: object }).key, { id: odd });
});

test('a natural key is the address once known, and the primary key by name until then', () => {
  assert.deepEqual(recordSegments(book, 'product', { key: { id: 4 }, natural: 'SKU-1049' }), ['products', 'SKU-1049']);
  assert.deepEqual(recordSegments(book, 'product', { key: { id: 4 } }), ['products', 'id=4']);
  assert.deepEqual(readAppSegments(book, ['products', 'SKU-1049']), {
    kind: 'record',
    target: { kind: 'list', view: 'products', table: 'product' },
    table: 'product',
    key: { sku: 'SKU-1049' },
    natural: { column: 'sku', value: 'SKU-1049' },
  });
  assert.deepEqual((readAppSegments(book, ['products', 'id=4']) as { key: object; natural?: object }).key, { id: '4' });
});

test('a slug decorates a numeric id and any spelling reads the id alone', () => {
  assert.deepEqual(recordSegments(book, 'vehicle', { key: { id: 1 }, slug: '2021-toyota-corolla' }), ['vehicles', '1-2021-toyota-corolla']);
  assert.deepEqual(recordSegments(book, 'vehicle', { key: { id: 1 } }), ['vehicles', '1']);
  for (const spelling of ['1', '1-2021-toyota-corolla', '1-anything-at-all']) {
    const read = readAppSegments(book, ['vehicles', spelling]) as { key: object; slugged?: boolean };
    assert.deepEqual(read.key, { id: '1' }, spelling);
    assert.equal(Boolean(read.slugged), spelling !== '1');
  }
  // No slug where the route takes none.
  assert.deepEqual(recordSegments(book, 'lead', { key: { id: 1 }, slug: 'x' }), ['leads', '1']);
});

test('a composite key is said under its parent where it can be, by name where it cannot', () => {
  assert.deepEqual(recordSegments(book, 'order_line', { key: { order_id: 12, line: 3 } }), ['orders', '12', 'lines', '3']);
  assert.deepEqual(readAppSegments(book, ['orders', '12', 'lines', '3']), {
    kind: 'record',
    target: { kind: 'list', view: 'lines', table: 'order_line' },
    table: 'order_line',
    key: { order_id: '12', line: '3' },
  });
  assert.deepEqual(recordSegments(book, 'grid', { key: { x: 1, y: 'a,b' } }), ['cells', 'x=1,y=a%2Cb']);
  assert.deepEqual((readAppSegments(book, ['cells', 'x=1,y=a%2Cb']) as { key: object }).key, { x: '1', y: 'a,b' });
  assert.equal(readAppSegments(book, ['cells', 'x=1']), undefined, 'half a key is no address');
});

test('what is not an App address is left to the older reading', () => {
  for (const raw of [
    ['lead'],
    ['@lead~127'],
    ['lead%20status%20%3D%20new'],
    ['sales-dashboard', '3'],
    ['intake', 'new'],
    // The walk's own forms under a route: a trail, a list's question, a New form.
    ['leads', '@lead~127', '@sales_rep~12'],
    ['leads', '127!new'],
    ['leads:lead%20status%20%3D%20new'],
  ]) {
    assert.equal(readAppSegments(book, raw), undefined, raw.join('/'));
  }
  assert.deepEqual(readAppSegments(book, ['sales-dashboard']), { kind: 'route', target: { kind: 'dashboard', view: 'sales-dashboard' } });
});

test("a table's own name over a record reads as the record under its route, which is the address it is said at", () => {
  // product's records are addressed through products, by sku; task's through todo.
  const named = readAppSegments(book, ['product', 'SKU-1049']);
  assert.deepEqual(named, readAppSegments(book, ['products', 'SKU-1049']));
  assert.deepEqual(recordSegments(book, 'product', { key: { id: 4 }, natural: 'SKU-1049' }), ['products', 'SKU-1049']);
  assert.deepEqual(readAppSegments(book, ['task', '7', 'notes']), readAppSegments(book, ['todo', '7', 'notes']));
  assert.deepEqual(readAppSegments(book, ['task', 'new']), readAppSegments(book, ['todo', 'new']));
  // A table nothing else shows is its own route already; one no table is called stays the older reading's.
  assert.deepEqual((readAppSegments(book, ['note', '3']) as { key: object }).key, { id: '3' });
  assert.equal(readAppSegments(book, ['nothing', '3']), undefined);
});

test('collisions, reserved words and a misnamed view are problems', () => {
  const clash = appAddressBook({
    ...input,
    views: { ...input.views, leads: { table: 'lead', path: 'todo' }, tasks: { table: 'task', path: 'todo' } },
    resources: { task: { view: 'nope' } },
    pages: [{ id: 'p', base: 'grid', path: 'new' }],
  });
  assert.equal(clash.problems.length, 3, clash.problems.join('\n'));
  assert.match(clash.problems.join('\n'), /views "tasks": its address "\/todo" is already the list view "leads"'s/);
  assert.match(clash.problems.join('\n'), /pages "p": its address "new" is reserved/);
  assert.match(clash.problems.join('\n'), /resources "task": "view" names "nope"/);
});

test('the route table names every route once', () => {
  const rows = routeTable(book, '/shop');
  const paths = rows.map((row) => row.path);
  for (const expected of [
    '/shop',
    '/shop/leads',
    '/shop/leads/new',
    '/shop/leads/{id}',
    '/shop/todo/{id}',
    '/shop/products/{sku}',
    '/shop/vehicles/{id}[-slug]',
    '/shop/orders/{order_id}/lines/{line}',
    '/shop/cells/x={…},y={…}',
    '/shop/sales-dashboard',
  ]) {
    assert.ok(paths.includes(expected), `${expected} in\n${paths.join('\n')}`);
  }
  // A dashboard offering no window is its route alone: no `?period=` it would not read.
  assert.ok(!paths.some((path) => path.startsWith('/shop/sales-dashboard?')), paths.join('\n'));
});

test('a free-form page is its route, then the place it keeps; a dashboard its route, then each parameter it offers', () => {
  const pages = appAddressBook({
    ...input,
    order: ['pick-walk', 'sales'],
    views: {
      'pick-walk': { sections: [{ kind: 'custom' }], page: { reads: ['orders'], commands: [], params: ['list', 'line'] } } as never,
      sales: { sections: [{ windowKey: 'won-by-stage' }], windows: ['last 30 days'], filters: ['owner_id'] } as never,
    },
  });
  assert.deepEqual(
    routeTable(pages, '/depot').filter((row) => /pick-walk|sales/.test(row.path)),
    [
      { path: '/depot/pick-walk', what: 'the free-form page "pick-walk"' },
      { path: '/depot/pick-walk?list=…&line=…', what: 'the free-form page "pick-walk", at the place it keeps' },
      { path: '/depot/sales', what: 'the dashboard "sales"' },
      { path: '/depot/sales?period=…', what: 'the dashboard "sales", over one of its windows' },
      { path: '/depot/sales?owner_id=…', what: 'the dashboard "sales", picked by "owner_id"' },
      { path: '/depot/sales?period.won-by-stage=…', what: 'the dashboard "sales", the section "won-by-stage"\'s own window' },
    ],
  );
});

test('a tab is said as a word and matched by it', () => {
  assert.equal(tabWord('Campaign history'), 'campaign-history');
  assert.equal(tabWord('tab:Activity'), 'activity');
  assert.equal(tabWord('section:3'), 'section-3');
  assert.ok(tabMatches('tab:Activity', 'activity'));
  assert.ok(tabMatches('Campaign history', 'Campaign history'));
  assert.ok(!tabMatches('Campaign history', undefined));
});

test('a natural key is refused unless the catalog proves it NOT NULL and unique', () => {
  const withSku = (sku: Partial<{ nullable: boolean }>, unique?: string[]): AddressBookInput => ({
    ...input,
    tables: tables.map((table) =>
      table.id !== 'product'
        ? table
        : {
            ...table,
            ...(unique ? { unique } : {}),
            columns: [
              { ...col('id', { primaryKey: true }), nullable: false },
              { ...col('sku'), nullable: false, ...sku },
            ],
          },
    ),
  });
  assert.deepEqual(naturalKeyProblems(appAddressBook(withSku({}, ['sku']))), []);
  const unproven = naturalKeyProblems(appAddressBook(withSku({})));
  assert.equal(unproven.length, 1);
  assert.match(unproven[0], /resources "product": "address" names "sku", which the database does not keep unique/);
  const nullable = naturalKeyProblems(appAddressBook(withSku({ nullable: true }, ['sku'])));
  assert.equal(nullable.length, 1);
  assert.match(nullable[0], /which can be null/);
  // The primary key proves itself.
  const byKey = appAddressBook({
    ...input,
    resources: { product: { address: 'id' } },
    tables: tables.map((table) =>
      table.id !== 'product' ? table : { ...table, columns: table.columns.map((column) => ({ ...column, nullable: false })) },
    ),
  });
  assert.deepEqual(naturalKeyProblems(byKey), []);
});

test('in a tenant App, a natural key unique together with one other column is an address within the tenant', () => {
  const withPair = (uniquePairs?: Array<[string, string]>): AddressBookInput => ({
    ...input,
    tables: tables.map((table) =>
      table.id !== 'product'
        ? table
        : {
            ...table,
            ...(uniquePairs ? { uniquePairs } : {}),
            columns: [
              { ...col('id', { primaryKey: true }), nullable: false },
              { ...col('tenant_id'), nullable: false },
              { ...col('sku'), nullable: false },
            ],
          },
    ),
  });
  const tenantOwned = (table: string) => table === 'product';
  // UNIQUE (tenant_id, sku): each customer has its own SKU 1, and the session's tenant picks which.
  assert.deepEqual(naturalKeyProblems(appAddressBook(withPair([['tenant_id', 'sku']])), tenantOwned), []);
  // Outside a tenant App the pair proves nothing: two rows share the key across the other column.
  assert.match(naturalKeyProblems(appAddressBook(withPair([['tenant_id', 'sku']])))[0], /does not keep unique/);
  // A pair that leaves the key out proves nothing either, and the advice names the tenant's constraint.
  const unproven = naturalKeyProblems(appAddressBook(withPair([['tenant_id', 'id']])), tenantOwned);
  assert.equal(unproven.length, 1);
  assert.match(unproven[0], /UNIQUE \(<tenant column>, sku\)/);
});

test('a list is its route, then its tabs by their words and its filters, each said only where the list offers it', () => {
  const lists = appAddressBook({
    ...input,
    order: ['leads', 'tasks'],
    views: {
      leads: {
        table: 'lead',
        tabs: [{ label: 'Open' }, { label: 'Working on it' }, { label: 'All' }],
        filters: ['source', 'owner_id'],
      } as never,
      tasks: { table: 'task' },
    },
  });
  assert.deepEqual(
    routeTable(lists, '/crm').filter((row) => /^\/crm\/(leads|tasks)(\?|$)/.test(row.path)),
    [
      { path: '/crm/leads', what: 'the list view "leads"' },
      { path: '/crm/leads?tab=…', what: 'the list view "leads", on one of its tabs (working-on-it, all)' },
      { path: '/crm/leads?{filter}=…', what: 'the list view "leads", refined by its filters (source, owner_id)' },
      { path: '/crm/tasks', what: 'the list view "tasks"' },
    ],
  );
});

test('the assistant’s page is a room of its own, a conversation under it; only an App that has one claims the word', () => {
  const paged = appAddressBook({ ...input, assistant: true });
  assert.deepEqual(paged.problems, []);
  assert.deepEqual(readAppSegments(paged, ['assistant']), { kind: 'route', target: { kind: 'assistant' } });
  assert.deepEqual(readAppSegments(paged, ['assistant', 'c0ffee']), { kind: 'conversation', target: { kind: 'assistant' }, id: 'c0ffee' });
  assert.equal(readAppSegments(paged, ['assistant', 'c0ffee', 'more']), undefined);
  // Without the page, "assistant" is nobody's address.
  assert.equal(readAppSegments(book, ['assistant']), undefined);
});

/* Lintel's shape: a resident's own repairs first in the menu, the office's repairs under Maintenance, a technician's
   visits (a standing query) and the board (a query too) beside it, and the repair's page over the table. */
test("a record's address is the first view showing its table among the views that person is served", () => {
  const office = ['leasing', 'manager', 'admin'];
  const lintel = {
    views: {
      'my-requests': { table: 'maintenance_request', roles: ['resident'] },
      'my-repairs': { table: 'maintenance_request', query: 'mine', roles: ['technician'] },
      'repair-board': { table: 'maintenance_request', query: 'outstanding', roles: ['manager', 'admin', 'technician'] },
      repairs: { table: 'maintenance_request', roles: [...office, 'technician'] },
      ledger: { table: 'charge', roles: ['manager', 'admin', 'accountant'] },
    },
    nav: [{ view: 'my-requests' }, { view: 'ledger' }, { view: 'my-repairs' }, { view: 'repair-board' }, { view: 'repairs' }],
  };
  const pages: Array<{ id: string; base: string; roles?: string[] }> = [{ id: 'maintenance_request', base: 'maintenance_request' }];
  const lintelTables: AddressBookInput['tables'] = [
    { id: 'maintenance_request', name: 'maintenance_request', columns: [col('id', { primaryKey: true })] },
    { id: 'charge', name: 'charge', columns: [col('id', { primaryKey: true })] },
  ];
  const bookOf = (roles: string[] | undefined, resources: AddressBookInput['resources'] = {}) => {
    const app = roles ? appForRoles(lintel as never, roles) : (lintel as never);
    return appAddressBook({
      views: (app as typeof lintel).views,
      order: viewOrder(app),
      resources,
      pages: roles ? pagesForRoles(pages, roles, (lintel as { auth?: never }).auth) : pages,
      tables: lintelTables,
      ...(roles ? { projected: true } : {}),
    });
  };
  const at = (roles: string[] | undefined) => recordSegments(bookOf(roles), 'maintenance_request', { key: { id: 12 } });
  // The whole App's book says the menu's first: a link nobody but a resident can follow.
  assert.deepEqual(at(undefined), ['my-requests', '12']);
  assert.deepEqual(at(['resident']), ['my-requests', '12']);
  assert.deepEqual(at(['manager']), ['repairs', '12']);
  // A technician's own visits and the board stand on a question: the plain list is the address.
  assert.deepEqual(at(['technician']), ['repairs', '12']);
  // Served no list over repairs, the accountant reads one by the table's own name, which opens its page.
  assert.deepEqual(at(['accountant']), ['maintenance_request', '12']);

  /* `view:` is a preference for whoever is served it: the office's repairs at /repairs, a resident (not served
     that view) at their own, and nobody's book reports a problem for it. The whole App's still says a misnamed one. */
  const preferred = { maintenance_request: { view: 'repairs' } };
  assert.deepEqual(recordSegments(bookOf(undefined, preferred), 'maintenance_request', { key: { id: 12 } }), ['repairs', '12']);
  assert.deepEqual(recordSegments(bookOf(['resident'], preferred), 'maintenance_request', { key: { id: 12 } }), ['my-requests', '12']);
  for (const roles of [['resident'], ['accountant'], ['technician']]) assert.deepEqual(bookOf(roles, preferred).problems, []);
  assert.match(bookOf(undefined, { maintenance_request: { view: 'nope' } }).problems.join('\n'), /"view" names "nope"/);
  // A view the person is served that is no list over the table is still said, in their book too.
  assert.match(bookOf(['manager'], { maintenance_request: { view: 'ledger' } }).problems.join('\n'), /"view" names "ledger"/);
});

// A field report from the user's own App: a page over a table was `/deal/1270` until a list view over the same
// table took the records to `/deals/1270`, and the old address read as a query and said "not available to your role".
test("a page's id over a record keeps working once a list view takes the table's records", () => {
  const moved = appAddressBook({
    order: ['deals'],
    views: { deals: { table: 'deal_row' } },
    resources: {},
    pages: [{ id: 'deal', base: 'deal_row' }],
    tables: [{ id: 'deal_row', name: 'deal_row', columns: [col('id', { primaryKey: true })] }],
  });
  assert.deepEqual(readAppSegments(moved, ['deal', '1270']), readAppSegments(moved, ['deals', '1270']));
  assert.deepEqual(readAppSegments(moved, ['deal', '1270', 'notes']), readAppSegments(moved, ['deals', '1270', 'notes']));
  assert.notEqual(readAppSegments(moved, ['deals', '1270']), undefined);
  assert.equal(readAppSegments(moved, ['deal']), undefined, 'the name alone stays the older reading');
});
