/**
 * A public list's address in words: the question a list asks, said as its
 * view's parameters — a tab, an equality, one of several, a range, a sort —
 * and read back to the same question; anything the view's own filters cannot
 * say kept whole as `q`, and nothing a parameter does not name let in.
 */
import { expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../test/shellBridge.js';

const spec = {
  id: 'vehicles',
  table: 'vehicle',
  label: 'Vehicles',
  query: 'status != sold',
  tabs: [
    { label: 'All' },
    { label: 'Hybrid and electric', query: 'fuel = Hybrid or fuel = Electric' },
    { label: 'SUVs', query: 'body_type = SUV' },
  ],
  filters: ['make', 'model', 'body_type', 'price', 'fuel'],
};
/* Compass's shape: every tab sorts, and the first — the one the view opens on — narrows. */
const leads = {
  id: 'leads',
  table: 'lead',
  label: 'Leads',
  show: ['name', 'status', 'source'],
  filters: ['status', 'source'],
  tabs: [
    { label: 'New', query: 'status = new sort created_on desc' },
    { label: 'Working', query: 'status = working sort created_on desc' },
    { label: 'All', query: 'sort created_on desc' },
  ],
};
/* A split: its list half has its own show and page size once a pick is closed. */
const inbox = {
  id: 'inbox',
  table: 'lead',
  label: 'Inbox',
  show: ['name', 'status'],
  filters: ['status'],
  presentation: { kind: 'split', limit: 25, detail: ['name', 'source'] },
};
const text = (name: string) => ({ name, type: 'TEXT', nullable: false, primaryKey: false });
const vehicle = {
  id: 'vehicle',
  name: 'vehicle',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    text('title'),
    text('make'),
    text('model'),
    text('body_type'),
    text('fuel'),
    { name: 'price', type: 'INTEGER', nullable: false, primaryKey: false },
    { name: 'year', type: 'INTEGER', nullable: false, primaryKey: false },
  ],
};
const lead = {
  id: 'lead',
  name: 'lead',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    text('name'),
    text('status'),
    text('source'),
    text('created_on'),
  ],
};
/* A list whose tabs name segments: served, a tab's query is the segment's name, a word the server writes out (appSegments.ts), and its address word is the name. */
const orders = {
  id: 'orders',
  table: 'work_order',
  label: 'Work orders',
  filters: ['status'],
  tabs: [
    { label: 'All' },
    { label: 'Open', query: 'open', segment: 'open', slug: 'open' },
    { label: 'Late', query: 'overdue sort due_on', segment: 'overdue', slug: 'overdue' },
  ],
};
const workOrder = {
  id: 'work_order',
  name: 'work_order',
  schema: '',
  isView: false,
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, text('status'), text('due_on')],
};
/* A list filtered across its related tables (shared/listFilters.ts): a path up a reference, an opportunity's
   stage, and a segment of the opportunities as a yes. */
const accounts = {
  id: 'accounts',
  table: 'account',
  label: 'Accounts',
  filters: ['rating', 'owner_id.region', 'any opportunity where stage', 'any opportunity where open'],
};
const account = {
  id: 'account',
  name: 'account',
  schema: '',
  isView: false,
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, text('name'), text('rating'), text('owner_id')],
};
const opportunity = {
  id: 'opportunity',
  name: 'opportunity',
  schema: '',
  isView: false,
  segments: { open: 'stage != won' },
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, text('account_id'), text('stage')],
};
const rooms: Record<string, unknown> = {
  accounts,
  orders,
  vehicles: spec,
  leads,
  inbox,
  workspace: { id: 'workspace', kind: 'dashboard', label: 'Workspace', sections: [] },
  application: { id: 'application', kind: 'form', label: 'Application', command: 'apply' },
};
const tables: Record<string, unknown> = { vehicle, lead, work_order: workOrder, account, opportunity };

vi.mock('./appState.js', () => ({ activeApp: () => ({ id: 'forecourt' }) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../kit/src/client/components/appRooms.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../kit/src/client/components/appRooms.js')>()),
  viewRoom: (_app: unknown, key: string) => rooms[key],
  appRooms: () => Object.values(rooms),
  offeredBy: () => ({}),
  resourceOf: () => undefined,
}));
vi.mock('../../../kit/src/client/core.js', () => ({
  findTable: (id: string) => tables[id],
  recordLabel: () => undefined,
  labelPath: () => undefined,
  quote: (value: string) => `"${value.replace(/"/g, '\\"')}"`,
  tableView: (table: string, query: string) => ({ kind: 'table', table, query, tab: 'rows' }),
  pageView: (pageId: string, table: undefined, key: undefined, label: string) => ({ kind: 'page', pageId, table, key, label }),
  state: { schema: { tables: [vehicle, lead, workOrder], foreignKeys: [] } },
}));

const { addressQuestion, listParams, tabSlug, viewEntryFromAddress } = await import('./publicAddress.js');
const { appListQuery, splitListSpec, wholeQuery } = await import('../../../kit/src/client/components/appListModel.js');
const { squeeze } = await import('../../../kit/src/client/filterbar.js');

const said = (question: string) => listParams({ table: 'vehicle', view: 'vehicles', query: wholeQuery(spec as never, question) });

function listEntry(key: string, search: string) {
  const entry = viewEntryFromAddress(key, search);
  if (!entry || !('query' in entry)) throw new Error(`Expected a list at ${key}`);
  return entry;
}

test('named dashboards and signed-in forms resolve to their rooms, never to table queries', () => {
  expect(viewEntryFromAddress('workspace', '')).toMatchObject({ kind: 'page', pageId: 'dash-workspace', label: 'Workspace' });
  expect(viewEntryFromAddress('application', '')).toMatchObject({ kind: 'page', pageId: 'form-application', label: 'Application' });
  expect(viewEntryFromAddress('missing', '')).toBeNull();
});

test('the view as it stands is its key alone', () => {
  expect(listParams({ table: 'vehicle', view: 'vehicles', query: appListQuery(spec as never, 0) })).toBe('');
  // Not one of the App's list views: the caller writes it as ever.
  expect(listParams({ table: 'vehicle', query: 'vehicle' })).toBeUndefined();
});

test('a tab, an equality, one of several, a range and a sort, each in words', () => {
  expect(said('make = Toyota')).toBe('make=Toyota');
  expect(said('body_type = SUV and make = Toyota')).toBe('tab=suvs&make=Toyota');
  expect(said('price <= 15000')).toBe('price=..15000');
  expect(said('price >= 5000 and price <= 15000')).toBe('price=5000..15000');
  expect(said('make = Toyota sort price desc')).toBe('make=Toyota&sort=-price');
  expect(new URLSearchParams(said('make in (Toyota, Honda)')).get('make')).toBe('Toyota,Honda');
});

test('what the filters cannot say is kept whole, never dropped', () => {
  // The reader's `or` after the view's standing condition is the list's own grouped question.
  expect(new URLSearchParams(said('make = Toyota or make = Honda')).get('q')).toBe('(make = Toyota or make = Honda)');
  // `year` is not one of the view's filters.
  expect(new URLSearchParams(said('year = 2020')).get('q')).toBe('year = 2020');
});

test("a rail's range is one between, said as its two ends and read back as one", () => {
  expect(said('price between 5000 and 15000')).toBe('price=5000..15000');
  expect(said('make = Toyota and price between 5000 and 15000 sort price')).toBe('make=Toyota&price=5000..15000&sort=price');
  // Read back, both ends are one `between` again: the one condition the rail's range draws.
  expect(addressQuestion(spec as never, new URLSearchParams('price=5000..15000'))).toBe('price between 5000 and 15000');
  expect(addressQuestion(spec as never, new URLSearchParams('price=..15000'))).toBe('price <= 15000');
  // A between beside another bound on the same column is not a range the address can say.
  expect(new URLSearchParams(said('price between 5000 and 15000 and price >= 7000')).get('q')).toBeTruthy();
});

test('the way back asks the same question, and ignores what it does not name', () => {
  for (const search of ['make=Toyota', 'tab=suvs&make=Toyota&price=..15000&sort=-price', 'price=5000..15000']) {
    const entry = listEntry('vehicles', search);
    expect(entry.view).toBe('vehicles');
    expect(listParams({ table: 'vehicle', view: 'vehicles', query: entry.query })).toBe(search);
  }
  expect(addressQuestion(spec as never, new URLSearchParams('color=Red&make=Mazda'))).toBe('make = "Mazda"');
  expect(addressQuestion(spec as never, new URLSearchParams('q=year%20%3D%202020'))).toBe('year = 2020');
  expect(addressQuestion(spec as never, new URLSearchParams('sort=price;drop'))).toBe('');
  expect(viewEntryFromAddress('nowhere', '')).toBeNull();
  expect(tabSlug('Under $10,000')).toBe('under-10-000');
});

const leadSaid = (question: string) => listParams({ table: 'lead', view: 'leads', query: wholeQuery(leads as never, question) });

test("a view opens on its first tab, so that tab is the key alone, and each tab's own order goes unsaid", () => {
  expect(listParams({ table: 'lead', view: 'leads', query: appListQuery(leads as never, 0) })).toBe('');
  expect(listParams({ table: 'lead', view: 'leads', query: appListQuery(leads as never, 1) })).toBe('tab=working');
  expect(listParams({ table: 'lead', view: 'leads', query: appListQuery(leads as never, 2) })).toBe('tab=all');
  // A box beside a tab keeps the tab's sort: still unsaid.
  expect(leadSaid('status = working and source = web sort created_on desc')).toBe('tab=working&source=web');
  // Another order is the reader's, and said.
  expect(leadSaid('status = working sort name')).toBe('tab=working&sort=name');
  // A sorting tab asked unsorted has no parameter to say so: whole.
  expect(new URLSearchParams(leadSaid('status = working')).get('q')).toBe('status = working');
});

test('no tab reads back as the first, and a tab reads back as the tab exactly, so it lights', () => {
  for (const index of [0, 1, 2]) {
    const address = listParams({ table: 'lead', view: 'leads', query: appListQuery(leads as never, index) })!;
    expect(squeeze(listEntry('leads', address).query)).toBe(squeeze(appListQuery(leads as never, index)));
  }
  for (const search of ['tab=working&source=web', 'tab=working&sort=name', 'tab=all&status=lost&sort=-name', 'source=web']) {
    const entry = listEntry('leads', search);
    expect(listParams({ table: 'lead', view: 'leads', query: entry.query })).toBe(search);
  }
  // A tab the view no longer has is the view as it opens.
  expect(squeeze(listEntry('leads', 'tab=gone').query)).toBe(squeeze(appListQuery(leads as never, 0)));
});

test("a split's list half says its question in the same words as the view", () => {
  const half = splitListSpec(inbox as never);
  expect(listParams({ table: 'lead', view: 'inbox', query: appListQuery(inbox as never) })).toBe('');
  expect(listParams({ table: 'lead', view: 'inbox', query: appListQuery(half) })).toBe('');
  expect(listParams({ table: 'lead', view: 'inbox', query: wholeQuery(half, 'status = new') })).toBe('status=new');
  // A show of the reader's own is theirs, and kept whole.
  expect(new URLSearchParams(listParams({ table: 'lead', view: 'inbox', query: 'lead status = new show name' })).get('q')).toBe(
    'status = new show name',
  );
});

test("the name column's box is `search=`, one phrase, and reads back as the same condition", () => {
  const search = leadSaid('status = new and name contains "stone" sort created_on desc');
  expect(search).toBe('search=stone');
  expect(addressQuestion(leads as never, new URLSearchParams('search=stone'))).toMatch(/^status = new and name contains "stone"/);
  // Another column's `contains` is no box's word: the question whole.
  expect(new URLSearchParams(leadSaid('status = new and source contains "web" sort created_on desc')).get('q')).toContain(
    'source contains "web"',
  );
});

test("a drill takes the tab's own order, so a question the view did not sort is still said in its words", () => {
  const drilled = { table: 'lead', view: 'leads', query: 'lead status = working' };
  expect(new URLSearchParams(listParams(drilled)).has('q')).toBe(true);
  expect(listParams(drilled, { adoptOrder: true })).toBe('tab=working');
});

test('a metric with no query drills to every row the list shows: its All tab, never its first', () => {
  const drilled = { table: 'lead', view: 'leads', query: 'lead' };
  expect(listParams(drilled, { adoptOrder: true })).toBe('tab=all');
  expect(squeeze(listEntry('leads', 'tab=all').query)).toBe(squeeze(appListQuery(leads as never, 2)));
});

test('a tab that names a segment is addressed by its name, and read back to the same question', () => {
  const ordersSaid = (question: string) =>
    listParams({ table: 'work_order', view: 'orders', query: wholeQuery(orders as never, question) });
  expect(listParams({ table: 'work_order', view: 'orders', query: appListQuery(orders as never, 2) })).toBe('tab=overdue');
  expect(ordersSaid('overdue and status = waiting sort due_on')).toBe('tab=overdue&status=waiting');
  for (const search of ['tab=overdue', 'tab=overdue&status=waiting', 'tab=open']) {
    const entry = listEntry('orders', search);
    expect(entry.view).toBe('orders');
    expect(listParams({ table: 'work_order', view: 'orders', query: entry.query })).toBe(search);
  }
});

test('a filter across a related table is said by its own word, and read back to the same question', () => {
  const asked = (question: string) => listParams({ table: 'account', view: 'accounts', query: wholeQuery(accounts as never, question) });
  const params = 'any opportunity where stage in (negotiation, won) and owner_id.region = West and any opportunity where open';
  const search = asked(params)!;
  expect(new URLSearchParams(search).get('has.opportunity.stage')).toBe('negotiation,won');
  expect(new URLSearchParams(search).get('owner_id.region')).toBe('West');
  expect(new URLSearchParams(search).get('has.opportunity.open')).toBe('yes');
  expect(squeeze(addressQuestion(accounts as never, new URLSearchParams(search)))).toBe(
    'owner_id.region = "West" and any opportunity where stage in ("negotiation", "won") and any opportunity where open',
  );
  // A segment's word takes yes alone: any other value asks nothing.
  expect(addressQuestion(accounts as never, new URLSearchParams('has.opportunity.open=no'))).toBe('');
  // The rows' condition is a value like any other: one is an equality.
  expect(addressQuestion(accounts as never, new URLSearchParams('has.opportunity.stage=won'))).toBe('any opportunity where stage = "won"');
});
