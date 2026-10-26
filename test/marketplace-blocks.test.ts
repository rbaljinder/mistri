/**
 * The building blocks a marketplace page needed, parsed and planned: a unit
 * after a figure and a text of items; the orders a list offers; a card's
 * summary line and its label-path lines; a facts line and a sheet; a
 * headline's second figure, small print and the forms its actions start
 * filled; related rows as cards; rows
 * like the record, matched on its own values; and the
 * inputs a public form lets its address fill. Each refusal names its fix.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ANSI_STYLE } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { normaliseView } from '../packages/engine/src/server/resourceReadHttp.js';
import {
  listPresentationColumns,
  parseAppConfig,
  parseAppPages,
  resolveViews,
  type AppFormView,
  type AppListView,
} from '../packages/mistri/src/shared/app.js';
import { sectionConfig, validatePage } from '../packages/engine/src/shared/page.js';
import { listView } from '../packages/engine/src/shared/pagePaths.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { PageDef, PageFields, PageList } from '../packages/engine/src/shared/pageModel.js';
import { compileView } from '../packages/engine/src/shared/view.js';
import { commandForm, page, related } from '../packages/mistri/schema/app.mjs';
import { parseTestApp } from './support/commandCatalog.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const schema = {
  label: 'Market',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'vehicle',
      name: 'vehicle',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('title', 'TEXT'),
        column('price', 'INTEGER'),
        column('year', 'INTEGER'),
        column('mileage', 'INTEGER'),
        column('status', 'TEXT'),
        column('features', 'TEXT'),
        column('est_monthly', 'INTEGER'),
        column('stock_ref', 'TEXT'),
        column('dealer_id', 'INTEGER'),
        column('body_type', 'TEXT'),
      ],
    },
    {
      id: 'dealer',
      name: 'dealer',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', { primaryKey: true, nullable: false }), column('name', 'TEXT'), column('city', 'TEXT')],
    },
  ],
  foreignKeys: [{ from: { table: 'vehicle', columns: ['dealer_id'] }, to: { table: 'dealer', columns: ['id'] } }],
} as DatabaseSchema;

const market = (over: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Market',
      resources: { vehicle: {}, dealer: {} },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
      nav: ['vehicles'],
      ...over,
    },
    'market fixture',
  );

test('a unit follows a number or a money figure, and a text of items is a list; each refused anywhere else', () => {
  const display = (rules: Record<string, unknown>) =>
    market({ resources: { vehicle: { display: rules }, dealer: {} } }).resources!.vehicle.display;
  assert.deepEqual(display({ mileage: { format: 'number', unit: 'mi' } })?.mileage, { format: 'number', unit: 'mi' });
  assert.deepEqual(display({ est_monthly: { format: 'money', currency: 'USD', unit: '/mo' } })?.est_monthly, {
    format: 'money',
    currency: 'USD',
    unit: '/mo',
  });
  assert.deepEqual(display({ features: { format: 'items' } })?.features, { format: 'items' });
  assert.throws(
    () => display({ mileage: { format: 'percent', unit: 'mi' } }),
    /a number says after the figure: format "number", "money", or none on a numeric column/,
  );
  assert.deepEqual(display({ mileage: { unit: 'mi' } })?.mileage, { unit: 'mi' });
  assert.throws(() => display({ mileage: { format: 'number', unit: 'miles per gallon' } }), /at most 12 characters/);
  assert.throws(() => display({ features: { format: 'items', tone: { a: 'good' } } }), /takes no currency, tone, bar, avatar or icons/);
});

test('a list offers its orders by name, in the query bar’s words, the first the one it opens in, judged against the table', () => {
  const sorted = (sort: unknown, extra: Record<string, unknown> = {}) =>
    market({ views: { vehicles: { kind: 'list', from: 'vehicle', sort, ...extra } } });
  const view = sorted([
    { label: ' Lowest price ', sort: ' price  asc ' },
    { label: 'Newest', sort: 'year desc, mileage' },
  ]).views.vehicles as AppListView;
  assert.deepEqual(view.sorts, [
    { label: 'Lowest price', sort: 'price asc' },
    { label: 'Newest', sort: 'year desc, mileage' },
  ]);
  assert.equal(view.sort, 'price asc', 'the first named order is the one the list opens in');
  // One order is a string; a menu is two or more.
  assert.throws(() => sorted([{ label: 'Lowest price', sort: 'price' }]), /not two to eight \{ label, sort \}: one order is a string/);
  assert.throws(
    () =>
      sorted([
        { label: 'Bad', sort: 'price; drop' },
        { label: 'Newest', sort: 'year' },
      ]),
    /written like the query bar/,
  );
  assert.throws(
    () =>
      sorted([
        { label: 'A', sort: 'price' },
        { label: 'A', sort: 'year' },
      ]),
    /one label twice/,
  );
  assert.throws(
    () =>
      sorted(
        [
          { label: 'A', sort: 'price' },
          { label: 'B', sort: 'year' },
        ],
        { board: { by: 'status', primary: 'title' } },
      ),
    /orders its cards itself/,
  );
  // The menu is the one key: `sorts` beside it is not a key of a list.
  assert.throws(
    () => market({ views: { vehicles: { kind: 'list', from: 'vehicle', sorts: [{ label: 'A', sort: 'price' }] } } }),
    /has no "sorts"/,
  );
  const error = (
    resolveViews(
      sorted([
        { label: 'By color', sort: 'color' },
        { label: 'Newest', sort: 'year' },
      ]),
      schema,
    ).vehicles as { error?: string }
  ).error;
  assert.match(error ?? '', /This view's sort "By color"/);
});

test('a card says its facts in one line and may name another record through a label path', () => {
  const cards = (presentation: unknown) => market({ views: { vehicles: { kind: 'list', from: 'vehicle', presentation } } });
  const spec = (
    cards({ kind: 'cards', primary: 'title', value: 'price', facts: ['year', 'mileage'], properties: ['dealer_id.name', 'dealer_id.city'] })
      .views.vehicles as AppListView
  ).presentation!;
  assert.deepEqual(spec, {
    kind: 'cards',
    primary: 'title',
    value: 'price',
    lines: ['dealer_id.name', 'dealer_id.city'],
    facts: ['year', 'mileage'],
  });
  assert.deepEqual(listPresentationColumns(spec), ['title', 'price', 'dealer_id.name', 'dealer_id.city', 'year', 'mileage']);
  const problem = (presentation: unknown) => (resolveViews(cards(presentation), schema).vehicles as { error?: string }).error;
  assert.equal(problem({ kind: 'cards', primary: 'title', properties: ['dealer_id.name'], facts: ['year'] }), undefined);
  assert.match(problem({ kind: 'cards', primary: 'title', properties: ['dealer_id.nope'] }) ?? '', /"dealer" has no column "nope"/);
  assert.match(problem({ kind: 'cards', primary: 'title', facts: ['year.name'] }) ?? '', /"year" in "year.name" is not a reference/);
  assert.throws(() => cards({ kind: 'cards', primary: 'title', facts: [] }), /"facts" must be one to 6/);
  assert.throws(() => cards({ kind: 'cards', primary: 'title', properties: ['dealer_id.name.first'] }), /one-hop label path/);
  // Queues share the same bounded reference labels.
  assert.equal(problem({ kind: 'queue', primary: 'title', lines: ['dealer_id.name'] }), undefined);
  assert.throws(() => cards({ kind: 'queue', primary: 'title', lines: ['dealer_id.name.first'] }), /one-hop label path/);
});

const pages = (sections: unknown[]) =>
  parseAppPages(
    {
      name: 'Market',
      resources: { vehicle: {}, dealer: {} },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
      nav: ['vehicles'],
      pages: { vehicle: page('vehicle', sections) },
    },
    'market fixture',
  );
const sectionsOf = (sections: unknown[]) => pages(sections)[0].sections;

test('a facts line and a sheet; a headline’s second figure, small print and the forms it starts filled', () => {
  const [facts, sheet, headline] = sectionsOf([
    { kind: 'fields', title: 'Key facts', presentation: 'facts', show: ['year', 'mileage'] },
    { kind: 'fields', title: 'History', presentation: 'table', columns: 2, show: ['stock_ref'] },
    {
      kind: 'headline',
      region: 'aside',
      show: ['price'],
      subfigure: 'est_monthly',
      note: ' On stated terms. ',
      links: [{ label: 'Ask', to: 'inquire', prefill: { stock_ref: 'stock_ref' }, defaults: { message: 'A test drive, please.' } }],
    },
  ]) as PageFields[];
  assert.equal(facts.presentation, 'facts');
  assert.equal(sheet.presentation, 'table');
  assert.equal(headline.subfigure, 'est_monthly');
  assert.equal(headline.note, 'On stated terms.');
  assert.deepEqual(headline.actions, [
    { label: 'Ask', view: 'inquire', prefill: { stock_ref: 'stock_ref' }, defaults: { message: 'A test drive, please.' } },
  ]);
  assert.throws(() => sectionsOf([{ kind: 'fields', presentation: 'facts' }]), /a facts line says the values it names/);
  assert.throws(
    () => sectionsOf([{ kind: 'fields', presentation: 'strip', show: ['year'] }]),
    /a fields presentation is "summary", "facts", "table" or "properties"/,
  );
  assert.throws(
    () => sectionsOf([{ kind: 'fields', show: ['price'], subfigure: 'est_monthly' }]),
    /has "subfigure", which belongs on a headline\(figure, \{ subfigure \}\)/,
  );
  assert.throws(() => sectionsOf([{ kind: 'headline', show: ['price'], note: 'x'.repeat(301) }]), /at most 300 characters/);
  assert.throws(
    () =>
      sectionsOf([
        {
          kind: 'headline',
          show: ['price'],
          links: [{ label: 'Ask', to: 'inquire', prefill: { 'stock-ref': 'stock_ref' } }],
        },
      ]),
    /"stock-ref" is not a form input's name/,
  );
  assert.throws(
    () =>
      sectionsOf([
        {
          kind: 'headline',
          show: ['price'],
          links: [{ label: 'Ask', to: 'inquire', defaults: { message: '' } }],
        },
      ]),
    /must be text of at most 500 characters/,
  );
});

test('related rows as cards', () => {
  const cards = { kind: 'cards', primary: 'title', value: 'price', facts: ['year', 'mileage'], properties: ['dealer_id.name'] };
  const [more] = sectionsOf([
    related('More from this dealer', 'vehicle', 'dealer_id', {
      query: 'status != sold',
      limit: 4,
      show: ['title'],
      presentation: cards,
    }),
  ]) as PageList[];
  // Written as `properties`, kept as the card's `lines`.
  const { properties, ...written } = cards;
  assert.deepEqual(more.presentation, { ...written, lines: properties });
  assert.throws(
    () => sectionsOf([related('More', 'vehicle', 'dealer_id', { presentation: { kind: 'grid' } })]),
    /"gallery" or a cards object/,
  );
  assert.throws(() => sectionsOf([related('More', 'vehicle', 'dealer_id', { excludeSelf: true } as never)]), /excludeSelf/);
  // A related list's cards take the list view's keys: a title through a reference, an icon, an avatar.
  const listCards = { kind: 'cards', primary: 'dealer_id.name', icon: 'body_type', media: 'avatar', image: 'photo_url' };
  const [kin] = sectionsOf([related('Kin', 'vehicle', 'dealer_id', { presentation: listCards })]) as PageList[];
  assert.deepEqual(kin.presentation, listCards);
  assert.throws(
    () => sectionsOf([related('Kin', 'vehicle', 'dealer_id', { presentation: { kind: 'cards', primary: 'a.b.c' } })]),
    /"primary" must be a local column or a one-hop path/,
  );
  assert.throws(
    () => sectionsOf([related('Kin', 'vehicle', 'dealer_id', { presentation: { kind: 'cards', primary: 'title', media: 'banner' } })]),
    /"media" must be "cover", "avatar" or "icon"/,
  );

  const def: PageDef = { id: 'dealer', name: 'Dealer', base: 'dealer', source: 'config', sections: [more] };
  const planned = listView(schema, def, more, { id: 3 }, 0);
  assert.equal(planned.error, undefined);
  const conditions = planned.view!.filter!.groups[0];
  assert.equal(
    conditions.some((condition) => condition.path === 'id'),
    false,
    "a related list leaves nothing out; the record's siblings are a matched list",
  );
  assert.ok(conditions.some((condition) => condition.path === 'dealer_id' && condition.op === '=' && condition.value === 3));
  // The cards' own columns are fetched beside what the section shows.
  assert.deepEqual(planned.view!.columns.map((c) => c.path).sort(), ['dealer_id.name', 'mileage', 'price', 'title', 'year']);
});

test('similar rows: the record’s own values, the record left out, the closest price first', () => {
  const cards = { kind: 'cards', primary: 'title', value: 'price', facts: ['year', 'mileage'] };
  const [like] = sectionsOf([
    related(
      'Similar vehicles',
      'vehicle',
      { same: ['body_type'], near: { price: 0.25 } },
      {
        query: 'status != sold',
        limit: 4,
        show: ['title'],
        presentation: cards,
      },
    ),
  ]) as PageList[];
  assert.deepEqual(like.similar, { same: ['body_type'], near: { price: 0.25 } });
  assert.equal(like.path, '');
  // Written back out, it says its match and no `whose`, and reads back the same.
  const written = sectionConfig(like) as Record<string, unknown>;
  assert.deepEqual([written.same, written.near], [like.similar?.same, like.similar?.near]);
  assert.equal('whose' in written, false);
  assert.equal('similar' in written, false);
  assert.deepEqual((sectionsOf([written]) as PageList[])[0].similar, like.similar);
  const def: PageDef = { id: 'vehicle', name: 'Vehicle', base: 'vehicle', source: 'config', sections: [like] };
  assert.equal(validatePage(schema, def).error, undefined);

  const planned = listView(schema, def, like, { id: 49 }, 0, undefined, {}, { body_type: 'SUV', price: 20001 });
  assert.equal(planned.error, undefined);
  const [conditions, ...more] = planned.view!.filter!.groups;
  assert.equal(more.length, 0);
  // ±25% of 20,001 is 15,000.75 to 25,001.25; a whole-number column keeps the whole numbers inside it.
  assert.deepEqual(conditions.slice(0, 4), [
    { path: 'body_type', op: '=', value: 'SUV' },
    { path: 'price', op: '>=', value: 15001 },
    { path: 'price', op: '<=', value: 25001 },
    { path: 'id', op: '!=', value: 49 },
  ]);
  assert.ok(conditions.some((c) => c.path === 'status' && c.op === '!=' && c.value === 'sold'));
  // Closest first, then the key: one order for equal distances.
  assert.deepEqual(planned.view!.orderBy, [
    { path: 'price', direction: 'asc', near: 20001 },
    { path: 'id', direction: 'asc' },
  ]);
  assert.equal(planned.view!.limit, 4);
  assert.deepEqual(planned.view!.columns.map((c) => c.path).sort(), ['mileage', 'price', 'title', 'year']);
  // The section's own sort breaks a tie in closeness before the key does; with no limit, ten.
  const sorted = { ...like, orderBy: [{ column: 'year', direction: 'desc' as const }], limit: undefined };
  const tied = listView(schema, def, sorted, { id: 49 }, 0, undefined, {}, { body_type: 'SUV', price: 20001 }).view!;
  assert.deepEqual(tied.orderBy, [
    { path: 'price', direction: 'asc', near: 20001 },
    { path: 'year', direction: 'desc' },
    { path: 'id', direction: 'asc' },
  ]);
  assert.equal(tied.limit, 10);
  // No `near`: the same body type, in the section's order.
  const plain = listView(
    schema,
    def,
    { ...like, similar: { same: ['body_type'] } },
    { id: 49 },
    0,
    undefined,
    {},
    { body_type: 'SUV' },
  ).view!;
  assert.deepEqual(plain.orderBy, [{ path: 'id', direction: 'asc' }]);

  // A record with nothing to match on shows nothing, never every row.
  for (const values of [
    { body_type: null, price: 20000 },
    { body_type: '', price: 20000 },
    { body_type: '  ', price: 20000 },
    { price: 20000 },
    { body_type: 'SUV', price: null },
    { body_type: 'SUV', price: 'n/a' },
    { body_type: { a: 1 }, price: 20000 },
  ]) {
    assert.deepEqual(listView(schema, def, like, { id: 49 }, 0, undefined, {}, values), { empty: true }, JSON.stringify(values));
  }
  // Values the server did not read are not guessed at.
  assert.match(listView(schema, def, like, { id: 49 }, 0).error ?? '', /not read before planning/);

  // Judged against the schema at startup and when planned, in the same words.
  const on = (section: PageList) => validatePage(schema, { ...def, sections: [section] }).error ?? '';
  // A match may be over another table, whose columns it names: each is a column of that table and of the page's own.
  assert.match(on({ ...like, from: 'dealer' }), /"same" names "body_type", which is not a column on dealer/);
  assert.match(
    listView(schema, def, { ...like, from: 'dealer' }, { id: 49 }, 0, undefined, {}, {}).error ?? '',
    /"same" names "body_type", which is not a column on dealer/,
  );
  assert.match(on({ ...like, similar: { same: ['colour'] } }), /"colour", which is not a column on vehicle/);
  assert.match(
    on({ ...like, similar: { same: ['body_type'], near: { title: 0.2 } } }),
    /keeps "title" near the record's value, so it must be a number column; it is TEXT/,
  );
  assert.match(on({ ...like, columns: ['nope'] }), /nope/);
});

test('a matched list says its match in one shape; everything that means a reference is refused beside it', () => {
  const refused = (section: unknown, pattern: RegExp) => assert.throws(() => sectionsOf([section]), pattern);
  const match = (m: object, opts: object = {}) => related('S', 'vehicle', m, opts);
  refused(match({ same: [] }), /"same" must be one to 4 columns a row shares with the record/);
  refused(match({ same: ['a', 'b', 'c', 'd', 'e'] }), /one to 4/);
  refused(match({ same: ['dealer_id.city'] }), /one to 4 columns/);
  refused(match({ same: ['body_type', 'body_type'] }), /names a column twice/);
  refused(match({ same: ['body_type'], near: { price: 0 } }), /a fraction above 0 and at most 1/);
  refused(match({ same: ['body_type'], near: { price: 1.5 } }), /a fraction above 0 and at most 1/);
  refused(match({ same: ['body_type'], near: { price: '0.2' } }), /a fraction above 0 and at most 1/);
  refused(match({ same: ['body_type'], near: {} }), /one or two columns/);
  refused(match({ same: ['body_type'], near: { price: 0.1, year: 0.1, mileage: 0.1 } }), /one or two columns/);
  refused(match({ same: ['price'], near: { price: 0.2 } }), /both "same" and "near"/);
  refused(match({ same: ['body_type'] }, { like: 'x' }), /like/);
  for (const [key, value] of [
    ['whose', 'dealer_id'],
    ['create', 'Add'],
  ] as const) {
    refused({ ...match({ same: ['body_type'] }), [key]: value }, new RegExp(`"${key}" beside "same"`));
  }
  // The old spellings are named, not read: `similar` as a key, `about` on a list.
  refused({ ...match({ same: ['body_type'] }), about: 'dealer_id' }, /has "about", which a related list no longer takes/);
  refused({ kind: 'list', from: 'vehicle', similar: { same: ['body_type'] } }, /has "similar", which is now the list's own match/);
});

test('closeness is ordered by a checked number, never text, and survives the trip back from the browser', () => {
  const view = {
    id: 'v',
    name: 'v',
    base: 'vehicle',
    columns: [{ path: 'title' }],
    orderBy: [{ path: 'price', direction: 'asc' as const, near: 20000 }],
  };
  assert.match(compileView(schema, view, ANSI_STYLE).text, /ORDER BY ABS\(\S*price\S* - \(20000\)\) ASC/);
  // A negative value is parenthesized, so the minus never meets it as "--".
  assert.match(compileView(schema, { ...view, orderBy: [{ path: 'price', direction: 'asc', near: -5 }] }, ANSI_STYLE).text, /- \(-5\)\)/);
  for (const near of [Number.POSITIVE_INFINITY, Number.NaN, 2 ** 60, '1) --' as unknown as number]) {
    assert.throws(
      () => compileView(schema, { ...view, orderBy: [{ path: 'price', direction: 'asc', near }] }, ANSI_STYLE),
      /"near" on "price" must be a finite number/,
    );
  }
  // /api/view/run reads a posted view through normaliseView: a number is kept, anything else dropped.
  assert.deepEqual(normaliseView(view).orderBy, [{ path: 'price', direction: 'asc', near: 20000 }]);
  assert.deepEqual(normaliseView({ ...view, orderBy: [{ path: 'price', near: '1) --' }] }).orderBy, [{ path: 'price', direction: 'asc' }]);
});

test('a similar list runs as one read: the same body type, inside the window, closest first, the key breaking ties, never the record', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-similar-'));
  const path = join(directory, 'market.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE vehicle(id INTEGER PRIMARY KEY, title TEXT, body_type TEXT, price INTEGER, status TEXT);
    INSERT INTO vehicle VALUES (1, 'This one', 'SUV', 20000, 'listed'), (2, 'Just under', 'SUV', 19500, 'listed'),
      (3, 'A little over', 'SUV', 20600, 'listed'), (4, 'Tied, higher key', 'SUV', 20500, 'listed'), (5, 'Sold', 'SUV', 20100, 'sold'),
      (6, 'A sedan', 'Sedan', 20000, 'listed'), (7, 'Too dear', 'SUV', 25001, 'listed'), (8, 'At the edge', 'SUV', 25000, 'listed'),
      (9, 'No body type', NULL, 20000, 'listed');`);
  const adapter = new SqliteAdapter(path, 'Similar');
  t.after(async () => {
    try {
      await adapter.close();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const live = await adapter.introspect();
  const [like] = sectionsOf([
    related('Similar', 'vehicle', { same: ['body_type'], near: { price: 0.25 } }, { query: 'status != sold', show: ['title'] }),
  ]) as PageList[];
  const def: PageDef = { id: 'vehicle', name: 'Vehicle', base: 'vehicle', source: 'config', sections: [like] };
  assert.equal(validatePage(live, def).error, undefined);
  const planned = listView(live, def, like, { id: 1 }, 0, undefined, {}, { body_type: 'SUV', price: 20000 });
  assert.deepEqual(
    (await adapter.runView(planned.view!)).rows.map((row) => row.title),
    ['Just under', 'Tied, higher key', 'A little over', 'At the edge'],
  );
  // The record with no body type matches nothing rather than everything.
  assert.deepEqual(listView(live, def, like, { id: 9 }, 0, undefined, {}, { body_type: null, price: 20000 }), { empty: true });
});

test('a public form names the inputs its address may start filled; nothing else is', () => {
  const ask = 'ask';
  const contracts = {
    ask: {
      public: true,
      input: {
        stock_ref: { label: 'Stock number', type: 'text' },
        message: { label: 'Message', type: 'textarea', optional: true },
        agree: { label: 'Agree', type: 'boolean', optional: true },
      },
    },
  };
  const form = (prefillable: unknown) =>
    parseTestApp(
      {
        name: 'Market',
        auth: { providers: ['email'], roles: { staff: { read: true, write: false } } },
        resources: { vehicle: {} },
        views: { vehicles: { kind: 'list', from: 'vehicle' }, inquire: commandForm('Ask', ask, { public: true, prefillable }) },
        home: 'vehicles',
        nav: ['vehicles'],
      },
      'form fixture',
      contracts,
    ).views.inquire as AppFormView;
  assert.deepEqual(form(['stock_ref', 'message']).prefillable, ['stock_ref', 'message']);
  assert.throws(() => form([]), /not a list of the command's input names/);
  assert.throws(() => form(['nope']), /"nope" is not one of the command's inputs/);
  assert.throws(() => form(['agree']), /"agree" is a boolean; an address fills a text, number, date or choice/);
  assert.throws(() => form(['stock_ref', 'stock_ref']), /names one input twice/);
  // Hidden inputs filled from the address are not a key: an unknown one is refused with the keys a form takes.
  assert.throws(
    () =>
      parseTestApp(
        {
          name: 'Market',
          auth: { providers: ['email'], roles: { staff: { read: true, write: false } } },
          resources: { vehicle: {} },
          views: {
            vehicles: { kind: 'list', from: 'vehicle' },
            inquire: { ...commandForm('Ask', ask, { public: true }), fromUrl: { stock_ref: 'ref' } },
          },
          home: 'vehicles',
          nav: ['vehicles'],
        },
        'form fixture',
        contracts,
      ),
    /has no "fromUrl"/,
  );
});

test('a headline’s earlier figure: a number column beside the figure, on a headline only', () => {
  const [headline] = sectionsOf([{ kind: 'headline', show: ['price'], was: ' est_monthly ' }]) as PageFields[];
  assert.equal(headline.was, 'est_monthly');
  assert.throws(() => sectionsOf([{ kind: 'fields', show: ['price'], was: 'est_monthly' }]), /has "was", which belongs on a headline/);
  assert.throws(() => sectionsOf([{ kind: 'headline', show: ['price'], was: 'a b' }]), /"was" that is not a field name/);
  const on = (was: string) =>
    validatePage(schema, { id: 'vehicle', name: 'Vehicle', base: 'vehicle', source: 'config', sections: [{ ...headline, was }] }).error;
  assert.equal(on('est_monthly'), undefined);
  assert.match(on('title') ?? '', /"was" is a number or money column beside the figure; "title" is TEXT/);
  assert.match(on('nope') ?? '', /"was" names "nope"/);
});

test('a list’s text filter suggests the values of its own text columns; each refusal names its fix', () => {
  const suggesting = (suggest: unknown, filters: unknown = ['title', 'price']) =>
    market({ views: { vehicles: { kind: 'list', from: 'vehicle', filters, suggest } } });
  const view = suggesting({ title: [' body_type ', 'status', 'body_type'] }).views.vehicles as AppListView;
  assert.deepEqual(view.suggest, { title: ['body_type', 'status'] });
  assert.equal((resolveViews(suggesting({ title: ['body_type'] }), schema).vehicles as { error?: string }).error, undefined);
  assert.throws(() => suggesting({}), /must name a text filter and the columns/);
  assert.throws(() => suggesting({ status: ['status'] }), /"status", which is not one of this list's "filters"/);
  assert.throws(() => suggesting({ title: ['dealer_id.city'] }), /a list of the resource's own column names/);
  assert.throws(() => suggesting({ title: [] }), /a list of the resource's own column names/);
  const error = (suggest: unknown) => (resolveViews(suggesting(suggest), schema).vehicles as { error?: string }).error ?? '';
  assert.match(error({ title: ['year'] }), /"year" \(suggested for "title"\) must be a text column of "vehicle"/);
  assert.match(error({ price: ['title'] }), /suggest: "price" must be a text column/);
  assert.match(error({ title: ['nope'] }), /"nope" \(suggested for "title"\) must be a text column/);
});
