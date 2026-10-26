import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePagesConfig, sectionConfig } from '../packages/engine/src/shared/page.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appProblems } from '../packages/mistri/src/server/app/apps.js';
import { factWord } from '../packages/engine/src/shared/appCards.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/**
 * How a page section draws, beyond its kind: a fields section as compact
 * properties or as an accordion the reader opens, and a related list over
 * image files as a gallery. Each is a word on the section it belongs to,
 * refused anywhere else by name.
 */
const page = (section: Record<string, unknown>) =>
  parsePagesConfig({ pages: [{ id: 'vehicle', label: 'Vehicle', base: 'vehicle', sections: [section] }] }, 'pages')[0].sections[0];

test('a fields section has no accordion and no collapsed; its presentations are summary, facts, table and properties', () => {
  assert.equal((page({ kind: 'fields', show: ['price'], presentation: 'summary' }) as { presentation?: string }).presentation, 'summary');
  assert.throws(
    () => page({ kind: 'fields', title: 'Specification', show: ['engine'], presentation: 'accordion' }),
    /a fields presentation is "summary", "facts", "table" or "properties"; the accordion is gone: a group of fields is always open/,
  );
  assert.throws(
    () => page({ kind: 'fields', show: ['features'], collapsed: true }),
    /has "collapsed", which is gone with the accordion: a group of fields is always open/,
  );
  assert.throws(
    () => page({ kind: 'fields', show: ['price'], presentation: 'tabs' }),
    /a fields presentation is "summary", "facts", "table" or "properties"\./,
  );
});

test('card() is a section of its own: titled by its first field, standing in the aside, read into fields', () => {
  const card = page({ kind: 'card', title: 'Sold by', show: ['dealer_id', 'dealer_id.city'] }) as {
    kind: string;
    presentation?: string;
    paths?: string[];
    region?: string;
  };
  assert.deepEqual([card.kind, card.presentation, card.paths, card.region], ['fields', 'card', ['dealer_id', 'dealer_id.city'], 'aside']);
  assert.equal((page({ kind: 'card', show: ['dealer_id'], region: 'main' }) as { region?: string }).region, 'main');
  assert.throws(
    () => page({ kind: 'card', title: 'Sold by' }),
    /a card is titled by its first field and says the rest as facts; name them in "show", the title first/,
  );
  assert.throws(
    () => page({ kind: 'fields', title: 'Sold by', presentation: 'card', show: ['dealer_id'] }),
    /a card is its own section, card\(title, 'dealer_id', \['rating', 'city'\]\), not a fields presentation/,
  );
  assert.throws(() => page({ kind: 'card', show: ['dealer_id'], links: [] }), /has no "links"/);
});

test('a card and a headline round-trip through the file as the sections they are', () => {
  const sections = [
    { kind: 'card', title: 'Sold by', show: ['dealer_id', 'dealer_id.city'] },
    {
      kind: 'headline',
      show: ['price', 'year'],
      was: 'est_price',
      subfigure: 'monthly',
      note: 'Before tax',
    },
  ];
  const pages = parsePagesConfig({ pages: [{ id: 'vehicle', label: 'Vehicle', base: 'vehicle', sections }] }, 'pages');
  const written = pages[0].sections.map(sectionConfig) as Array<Record<string, unknown>>;
  assert.deepEqual(
    written.map((section) => section.kind),
    ['card', 'headline'],
  );
  assert.deepEqual(written[1], { kind: 'headline', show: ['price', 'year'], was: 'est_price', subfigure: 'monthly', note: 'Before tax' });
  const linked = parsePagesConfig(
    {
      pages: [
        {
          id: 'v',
          label: 'V',
          base: 'vehicle',
          sections: [{ kind: 'headline', show: ['price'], links: [{ label: 'Go', to: 'inquire' }] }],
        },
      ],
    },
    'pages',
  );
  assert.equal(((sectionConfig(linked[0].sections[0]) as { links?: unknown[] }).links ?? []).length, 1, 'a headline writes its "links"');
  assert.equal((sectionConfig(linked[0].sections[0]) as { actions?: unknown }).actions, undefined);
  const again = parsePagesConfig({ pages: [{ id: 'vehicle', label: 'Vehicle', base: 'vehicle', sections: written }] }, 'pages');
  assert.deepEqual(again[0].sections, pages[0].sections);
});

test('a property rail is a fields presentation, placed like any other', () => {
  const rail = page({
    kind: 'fields',
    title: 'Properties',
    show: ['status', 'owner_id'],
    presentation: 'properties',
    region: 'aside',
    columns: 1,
  }) as { presentation?: string; region?: string; columns?: number };
  assert.deepEqual([rail.presentation, rail.region, rail.columns], ['properties', 'aside', 1]);
  parseAppConfig(
    { name: 'Market', resources: { vehicle: {} }, views: { vehicles: { kind: 'list', from: 'vehicle' } }, home: 'vehicles' },
    'market',
  );
  parsePagesConfig(
    {
      pages: [
        {
          id: 'vehicle',
          label: 'Vehicle',
          base: 'vehicle',
          sections: [{ kind: 'fields', show: ['status'], presentation: 'properties', region: 'aside' }],
        },
      ],
    },
    'pages',
  );
});

test('a related list may be a gallery; no other list presentation, and no presentation on the other kinds', () => {
  const gallery = page({
    kind: 'list',
    title: 'Photos',
    from: 'vehicle_photo',
    whose: 'vehicle_id',
    show: ['caption'],
    sort: 'position',
    presentation: 'gallery',
  });
  assert.equal((gallery as { presentation?: string }).presentation, 'gallery');
  assert.deepEqual((gallery as { orderBy?: unknown }).orderBy, [{ column: 'position', direction: 'asc' }]);
  assert.equal((page({ kind: 'list', from: 'vehicle_photo', whose: 'vehicle_id' }) as { presentation?: string }).presentation, undefined);
  assert.throws(
    () => page({ kind: 'list', from: 'vehicle_photo', whose: 'vehicle_id', presentation: 'cards' }),
    /a related list's presentation is "gallery"/,
  );
  assert.throws(
    () => page({ kind: 'metric', from: 'vehicle_photo', whose: 'vehicle_id', presentation: 'gallery' }),
    /presentation belongs on fields \(summary, facts, table, properties\) or a related list \(gallery, cards\)/,
  );
  assert.throws(
    () => page({ kind: 'list', from: 'vehicle_photo', whose: 'vehicle_id', workflow: { field: 'status', steps: ['a', 'b'] } }),
    /has no "workflow"/,
  );
});

test('a gallery over a resource whose rows are not files is named at load, with its page and section', () => {
  const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const schema = {
    label: 'Market',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      { id: 'vehicle', name: 'vehicle', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('title', 'TEXT')] },
      {
        id: 'vehicle_photo',
        name: 'vehicle_photo',
        schema: '',
        isView: false,
        columns: [column('id', 'INTEGER', true), column('vehicle_id', 'INTEGER'), column('file_name', 'TEXT'), column('data', 'BLOB')],
      },
      { id: 'note', name: 'note', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('vehicle_id', 'INTEGER')] },
    ],
  } as unknown as DatabaseSchema;
  const app = parseAppConfig(
    {
      name: 'Market',
      resources: { vehicle: {}, note: {}, vehicle_photo: { file: { content: 'data', name: 'file_name' } } },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
    },
    'market',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          id: 'vehicle',
          label: 'Vehicle',
          base: 'vehicle',
          sections: [
            { kind: 'list', title: 'Photos', from: 'vehicle_photo', whose: 'vehicle_id', presentation: 'gallery' },
            { kind: 'list', title: 'Notes', from: 'note', whose: 'vehicle_id', presentation: 'gallery' },
          ],
        },
      ],
    },
    'pages',
  );
  const problems = appProblems({ path: '/apps/market/app.ts', app, pages, sources: {} } as never, schema);
  assert.deepEqual(
    problems.filter((line) => line.includes('gallery')),
    [
      'app.ts: page "Vehicle": section "Notes" draws a gallery over "note", whose rows are not files. Declare "file" on that resource, or drop the presentation.',
    ],
  );
});

test("a related list's cards are judged as a list view's: an icon its display rule draws, a title through a reference", () => {
  const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const schema = {
    label: 'Desk',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [{ name: 'fk', from: { table: 'ticket', columns: ['owner_id'] }, to: { table: 'agent', columns: ['id'] } }],
    tables: [
      { id: 'customer', name: 'customer', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('name', 'TEXT')] },
      { id: 'agent', name: 'agent', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('name', 'TEXT')] },
      {
        id: 'ticket',
        name: 'ticket',
        schema: '',
        isView: false,
        columns: [
          column('id', 'INTEGER', true),
          column('customer_id', 'INTEGER'),
          column('owner_id', 'INTEGER'),
          column('subject', 'TEXT'),
          column('channel', 'TEXT'),
          column('priority', 'TEXT'),
        ],
      },
    ],
  } as unknown as DatabaseSchema;
  const app = parseAppConfig(
    {
      name: 'Desk',
      resources: { customer: {}, agent: {}, ticket: { display: { channel: { icons: { email: 'envelope', phone: 'phone' } } } } },
      views: { customers: { kind: 'list', from: 'customer' } },
      home: 'customers',
    },
    'desk',
  );
  const cards = (title: string, extra: Record<string, unknown>) => ({
    kind: 'list',
    title,
    from: 'ticket',
    whose: 'customer_id',
    presentation: { kind: 'cards', primary: 'subject', ...extra },
  });
  const pages = parsePagesConfig(
    {
      pages: [
        {
          id: 'customer',
          label: 'Customer',
          base: 'customer',
          sections: [
            cards('Tickets', { primary: 'owner_id.name', icon: 'channel', media: 'avatar' }),
            cards('By priority', { icon: 'priority' }),
          ],
        },
      ],
    },
    'pages',
  );
  const problems = appProblems({ path: '/apps/desk/app.ts', app, pages, sources: {} } as never, schema);
  assert.deepEqual(
    problems.filter((line) => line.includes('Cards')),
    [
      'app.ts: page "Customer": section "By priority": Cards icon: "priority" has no icons to draw; map its values in the resource\'s display rule (display.priority.icons).',
    ],
  );
});

test("a page's gallery is a stable presentation", () => {
  parseAppConfig(
    { name: 'Market', resources: { vehicle: {} }, views: { vehicles: { kind: 'list', from: 'vehicle' } }, home: 'vehicles' },
    'market',
  );
  parsePagesConfig(
    {
      pages: [
        {
          id: 'vehicle',
          label: 'Vehicle',
          base: 'vehicle',
          sections: [
            { kind: 'list', title: 'Photos', from: 'vehicle_photo', whose: 'vehicle_id', presentation: 'gallery' },
            { kind: 'fields', title: 'Specification', show: ['engine'] },
          ],
        },
      ],
    },
    'pages',
  );
});

test("headline() is a section of its own: the figure first, one or two links of the landing's shape", () => {
  const headline = page({
    kind: 'headline',
    show: ['price', 'year'],
    links: [
      { label: ' Inquire ', to: 'inquire' },
      { label: 'All cars', to: 'vehicles', intent: 'secondary' },
    ],
  }) as { kind: string; presentation?: string; actions?: unknown };
  assert.equal(headline.kind, 'fields');
  assert.equal(headline.presentation, 'headline');
  assert.deepEqual(headline.actions, [
    { label: 'Inquire', view: 'inquire' },
    { label: 'All cars', view: 'vehicles', intent: 'secondary' },
  ]);
  assert.throws(() => page({ kind: 'headline' }), /a headline shows its figure and its facts; name them in "show"/);
  assert.throws(
    () => page({ kind: 'fields', presentation: 'headline', show: ['price'] }),
    /a headline is its own section, headline\('price', \{ was, subfigure, note, links \}\), not a fields presentation/,
  );
  assert.throws(
    () => page({ kind: 'headline', show: ['price'], actions: [{ label: 'Go', to: 'inquire' }] }),
    /has "actions", which is now "links": the calls to action beside the figure/,
  );
  for (const key of ['subfigure', 'was', 'note'] as const) {
    assert.throws(() => page({ kind: 'fields', show: ['price'], [key]: 'x' }), new RegExp(`has "${key}", which belongs on a headline`));
  }
  assert.throws(
    () => page({ kind: 'fields', show: ['price'], actions: [{ label: 'Go', to: 'inquire' }] }),
    /has "actions", which belongs on a headline/,
  );
  assert.throws(() => page({ kind: 'headline', show: ['price'], links: [] }), /"links" must be one or two \{ label, to \}/);
  assert.throws(
    () => page({ kind: 'headline', show: ['price'], links: [{ label: 'Go', to: 'Inquire!' }] }),
    /needs a "to": the key of one of the App's views/,
  );
  assert.throws(
    () => page({ kind: 'headline', show: ['price'], links: [{ label: 'Go', to: 'inquire', href: 'https://x.test' }] }),
    /link 1 has no "href"/,
  );
  assert.throws(
    () => page({ kind: 'headline', show: ['price'], links: [{ label: 'Go', to: 'inquire', intent: 'loud' }] }),
    /Use "primary" or "secondary"/,
  );
  assert.throws(
    () => page({ kind: 'list', from: 'vehicle_photo', whose: 'vehicle_id', actions: [{ label: 'Go', to: 'inquire' }] }),
    // A related list's actions are the record's own verbs by id, not a headline's calls to action.
    /"actions" is one to four of the record's own action ids/,
  );
});

test("a headline's call to action that names none of the App's views is named at load", () => {
  const schema = {
    label: 'Market',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'vehicle',
        name: 'vehicle',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'price', type: 'INTEGER', nullable: true, primaryKey: false },
        ],
      },
    ],
  } as unknown as DatabaseSchema;
  const app = parseAppConfig(
    { name: 'Market', resources: { vehicle: {} }, views: { vehicles: { kind: 'list', from: 'vehicle' } }, home: 'vehicles' },
    'market',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          id: 'vehicle',
          label: 'Vehicle',
          base: 'vehicle',
          sections: [
            {
              kind: 'headline',
              show: ['price'],
              links: [
                { label: 'All cars', to: 'vehicles' },
                { label: 'Inquire', to: 'inquire' },
              ],
            },
          ],
        },
      ],
    },
    'pages',
  );
  assert.deepEqual(
    appProblems({ path: '/apps/market/app.ts', app, pages, sources: {} } as never, schema).filter((line) => line.includes('headline')),
    ['app.ts: page "Vehicle": the headline\'s "Inquire" opens "inquire", which is not one of this App\'s views.'],
  );
});

test('a record header that names an action kept out of it (header: false) is named at load', () => {
  const schema = {
    label: 'Market',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'vehicle',
        name: 'vehicle',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'status', type: 'TEXT', nullable: true, primaryKey: false },
        ],
      },
    ],
  } as unknown as DatabaseSchema;
  const app = parseAppConfig(
    {
      name: 'Market',
      resources: {
        vehicle: {
          actions: {
            sell: { label: 'Sell', set: { status: 'sold' }, header: false },
            list: { label: 'List', set: { status: 'listed' } },
          },
        },
      },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
    },
    'market',
  );
  const problems = (primary: string) =>
    appProblems(
      {
        path: '/apps/market/app.ts',
        app,
        sources: {},
        pages: parsePagesConfig(
          { pages: [{ id: 'vehicle', label: 'Vehicle', base: 'vehicle', sections: [{ kind: 'header', primary }] }] },
          'pages',
        ),
      } as never,
      schema,
    ).filter((line) => line.includes('header'));
  assert.deepEqual(problems('list'), []);
  assert.deepEqual(problems('sell'), [
    'app.ts: page "Vehicle": the header\'s primary "sell" says header: false, so the record\'s action bar never draws it. Drop one of the two.',
  ]);
});

test('a record header is a kind of its own: a status and facts, drawn in the head, nothing that would place it elsewhere, and one a page', () => {
  const header = page({
    kind: 'header',
    status: 'status',
    facts: ['year', { column: 'owners', after: 'owner' }, 'owner_id.name'],
    destructive: ['Withdraw'],
  });
  assert.deepEqual(header, {
    kind: 'fields',
    presentation: 'header',
    paths: ['year', 'owners', 'owner_id.name'],
    factLabels: { owners: { one: 'owner' } },
    status: 'status',
    destructive: ['Withdraw'],
  });
  assert.throws(() => page({ kind: 'header' }), /a record header says something/);
  // Only the verb to fill is a header too: the default head, its primary named.
  assert.deepEqual(page({ kind: 'header', primary: 'Renew' }), { kind: 'fields', presentation: 'header', paths: [], primary: 'Renew' });
  // Refused in the author's words: a header is placed by the head, and titled by the record's name.
  for (const [key, value] of [
    ['region', 'aside'],
    ['width', 'half'],
    ['title', 'Car'],
    ['tab', 'Details'],
    ['when', 'status = open'],
    ['eyebrow', 'Car'],
  ] as const) {
    assert.throws(
      () => page({ kind: 'header', status: 'status', [key]: value }),
      new RegExp(`has no "${key}"\\. .*It takes: kind, status, facts, primary, destructive, actions\\.`),
      key,
    );
  }
  assert.throws(() => page({ kind: 'header', status: 'account_id.status' }), /"status" that is not one of the record's own columns/);
  assert.throws(() => page({ kind: 'header', facts: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), /"facts" must be one to 6/);
  assert.throws(
    () => page({ kind: 'fields', show: ['price'], status: 'status' }),
    /has no "status"\. "status" belongs inside a record header/,
  );
  assert.throws(
    () => page({ kind: 'fields', presentation: 'header', status: 'status' }),
    /the record's head is a section of its own, header\(/,
  );
  assert.throws(
    () =>
      parsePagesConfig(
        {
          pages: [
            {
              id: 'v',
              base: 'vehicle',
              sections: [
                { kind: 'header', status: 'status' },
                { kind: 'header', facts: ['year'] },
              ],
            },
          ],
        },
        'pages',
      ),
    /two record headers/,
  );
});

test('a header fact may say its word before the value, and a header names the one verb it fills', () => {
  const header = page({
    kind: 'header',
    status: 'status',
    primary: ' Renew ',
    facts: [
      { column: 'born_on', before: 'Born' },
      { column: 'beds', after: 'bed' },
    ],
    destructive: ['End lease'],
  });
  assert.deepEqual(header, {
    kind: 'fields',
    presentation: 'header',
    paths: ['born_on', 'beds'],
    status: 'status',
    primary: 'Renew',
    destructive: ['End lease'],
    factLabels: { born_on: { one: 'Born', position: 'before' }, beds: { one: 'bed' } },
  });
  const refuse = (fact: Record<string, unknown>, said: RegExp) => assert.throws(() => page({ kind: 'header', facts: [fact] }), said);
  refuse({ column: 'born_on', label: 'Born' }, /has "label", which is now "after" \(a word after the value\) or "before"/);
  refuse({ column: 'born_on', before: 'Born', position: 'before' }, /has "position", which is gone/);
  refuse({ column: 'born_on', before: 'Born', after: 'x' }, /has both "before" and "after"/);
  refuse({ column: 'born_on' }, /says no word; write the path alone/);
  refuse({ column: 'born_on', before: '' }, /has a "before" that is not a word of at most 40 characters/);
  refuse({ column: 'steps', after: { one: 'step' } }, /has a "after" that is not a word|"many"|not a word/);
  assert.throws(() => page({ kind: 'header', status: 'status', primary: '' }), /"primary" that is not the id/);
  assert.throws(
    () => page({ kind: 'header', status: 'status', primary: 'endLease', destructive: ['endLease'] }),
    /both "primary" and "destructive"/,
  );
  assert.throws(() => page({ kind: 'fields', show: ['price'], primary: 'Renew' }), /has no "primary"/);
});

test("a fact's word agrees with a count, and only a count; a word the figure already says is left out", () => {
  // A word written once agrees with a bare count: "3 beds", "1 bed".
  assert.equal(factWord({ one: 'bed' }, 3), 'beds');
  assert.equal(factWord({ one: 'bed' }, '1'), 'bed');
  // A figure the display rule dresses is not a count of the word: "$18,400 left to pay", never "left to pays".
  assert.equal(factWord({ one: 'left to pay' }, 18400, { format: 'money' }), 'left to pay');
  assert.equal(factWord({ one: 'a month' }, 242, { format: 'number', unit: '/mo' }), 'a month');
  // The author's own plural agrees with any figure.
  assert.equal(factWord({ one: 'payment left', many: 'payments left' }, 12, { format: 'number' }), 'payments left');
  // The unit is the figure's word: "48,341 mi", never "48,341 mi mis".
  assert.equal(factWord({ one: 'mi' }, 48341, { format: 'number', unit: 'mi' }), undefined);
  // Before the value, a word is a caption and never agrees.
  assert.equal(factWord({ one: 'Floor', position: 'before' }, 3), 'Floor');
});

test('the current card is a kind of its own: one related row a query and a sort choose, with guidance for none', () => {
  const card = page({
    kind: 'current',
    title: 'Current lease',
    from: 'lease',
    whose: 'unit_id',
    query: 'status = active',
    sort: 'starts_on desc',
    show: ['tenant_id', 'rent'],
    empty: { title: 'Vacant', description: 'No active lease.' },
  }) as { kind: string; presentation?: string; limit?: number; orderBy?: unknown };
  assert.deepEqual(
    [card.kind, card.presentation, card.limit, card.orderBy],
    ['list', 'card', 1, [{ column: 'starts_on', direction: 'desc' }]],
  );
  // Refused in the author's words: a current card has no limit, totals or New form, and says what no row means.
  for (const [extra, said] of [
    [{ limit: 3 }, /has no "limit"/],
    [{ totals: ['rent'] }, /has no "totals"/],
    [{ create: 'Add lease' }, /has no "create"/],
    [{ presentation: 'gallery' }, /has no "presentation"/],
    [{ empty: false }, /say what no row means/],
    [{ empty: 'hide' }, /say what no row means/],
    [{ empty: 'collapse' }, /say what no row means/],
  ] as const) {
    assert.throws(() => page({ kind: 'current', from: 'lease', whose: 'unit_id', ...extra }), said);
  }
  assert.throws(() => page({ kind: 'list', from: 'lease', whose: 'unit_id', presentation: 'card' }), /its own section, current\(/);
  parseAppConfig({ name: 'Homes', resources: { unit: {} }, views: { units: { kind: 'list', from: 'unit' } }, home: 'units' }, 'homes');
  parsePagesConfig(
    {
      pages: [
        {
          id: 'unit',
          label: 'Unit',
          base: 'unit',
          sections: [
            { kind: 'header', status: 'status' },
            { kind: 'current', from: 'lease', whose: 'unit_id' },
          ],
        },
      ],
    },
    'pages',
  );
});

test("a related list's row menu names a resource with verbs for it, or it is named at load", () => {
  const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const schema = {
    label: 'Market',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      { id: 'vehicle', name: 'vehicle', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('title', 'TEXT')] },
      {
        id: 'offer',
        name: 'offer',
        schema: '',
        isView: false,
        columns: [column('id', 'INTEGER', true), column('vehicle_id', 'INTEGER'), column('accepted', 'BOOLEAN')],
      },
      { id: 'note', name: 'note', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('vehicle_id', 'INTEGER')] },
    ],
  } as unknown as DatabaseSchema;
  const app = parseAppConfig(
    {
      name: 'Market',
      resources: { vehicle: {}, note: {}, offer: { actions: { accept: { label: 'Accept', set: { accepted: true } } } } },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
    },
    'market',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          id: 'vehicle',
          label: 'Vehicle',
          base: 'vehicle',
          sections: [
            { kind: 'list', title: 'Offers', from: 'offer', whose: 'vehicle_id', rowActions: true },
            { kind: 'list', title: 'Notes', from: 'note', whose: 'vehicle_id', rowActions: true },
          ],
        },
      ],
    },
    'pages',
  );
  const problems = appProblems({ path: '/apps/market/app.ts', app, pages, sources: {} } as never, schema);
  assert.deepEqual(
    problems.filter((line) => line.includes('rowActions')),
    ['app.ts: page "Vehicle": the list of "note" has rowActions, but resources.note declares no action or machine for its rows\' menu.'],
  );
});

test("a related list's actions are the record's own verbs, each one its head may draw", () => {
  const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const schema = {
    label: 'market',
    dialect: 'sqlite',
    foreignKeys: [{ name: 'vehicle_id', from: { table: 'offer', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } }],
    tables: [
      { id: 'vehicle', name: 'vehicle', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('listed', 'BOOLEAN')] },
      { id: 'offer', name: 'offer', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('vehicle_id', 'INTEGER')] },
    ],
  } as unknown as DatabaseSchema;
  const app = parseAppConfig(
    {
      name: 'Market',
      resources: {
        vehicle: {
          actions: {
            list: { label: 'List it', set: { listed: true } },
            hidden: { label: 'Hidden', set: { listed: false }, header: false },
          },
        },
        offer: {},
      },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
    },
    'market',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          id: 'vehicle',
          label: 'Vehicle',
          base: 'vehicle',
          sections: [{ kind: 'list', title: 'Offers', from: 'offer', whose: 'vehicle_id', actions: ['list', 'hidden', 'sell'] }],
        },
      ],
    },
    'pages',
  );
  const problems = appProblems({ path: '/apps/market/app.ts', app, pages, sources: {} } as never, schema);
  assert.deepEqual(
    problems.filter((line) => line.includes('has actions')),
    [
      'app.ts: page "Vehicle": the list of "offer" has actions "hidden", which says header: false, so no action bar draws it. Drop one of the two.',
      'app.ts: page "Vehicle": the list of "offer" has actions "sell", which is not an action of "vehicle". Its actions: "list", "hidden".',
    ],
  );
});
