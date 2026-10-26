import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPresentationColumns, parseAppConfig, resolveViews, type AppListView } from '../packages/mistri/src/shared/app.js';
import { cardsReadable, type AppCardsList } from '../packages/engine/src/shared/appCards.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/**
 * The cards presentation: a list's rows as cards, the fourth card grammar
 * beside the checklist, the queue and the board. Local readable columns,
 * refused by name, and a picture that is either a column of the row or the
 * first file of a related file resource, judged against the catalog.
 */
const photos = { vehicle_photo: { file: { content: 'data', name: 'file_name' } } };
const parse = (presentation: unknown, resources: Record<string, unknown> = photos) =>
  parseAppConfig(
    {
      name: 'Market',
      resources: { vehicle: {}, dealer: {}, ...resources },
      views: { vehicles: { kind: 'list', from: 'vehicle', presentation } },
      home: 'vehicles',
      nav: ['vehicles'],
    },
    'cards fixture',
  );
const cards = (presentation: unknown, resources?: Record<string, unknown>) =>
  (parse(presentation, resources).views.vehicles as AppListView).presentation;
const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const schema: DatabaseSchema = {
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
        column('highlight', 'TEXT'),
        column('photo_url', 'TEXT'),
        column('dealer_id', 'INTEGER'),
      ],
    },
    {
      id: 'vehicle_photo',
      name: 'vehicle_photo',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('vehicle_id', 'INTEGER'),
        column('position', 'INTEGER'),
        column('file_name', 'TEXT'),
        column('data', 'BLOB'),
      ],
    },
    {
      id: 'dealer',
      name: 'dealer',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', { primaryKey: true, nullable: false }), column('name', 'TEXT')],
    },
  ],
  foreignKeys: [
    { from: { table: 'vehicle_photo', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } },
    { from: { table: 'vehicle', columns: ['dealer_id'] }, to: { table: 'dealer', columns: ['id'] } },
  ],
} as DatabaseSchema;
const problem = (presentation: unknown, resources?: Record<string, unknown>) =>
  (resolveViews(parse(presentation, resources), schema).vehicles as { error?: string }).error;

const full = {
  kind: 'cards',
  primary: 'title',
  value: 'price',
  badge: 'highlight',
  properties: ['year', 'price'],
  image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position desc' },
};

test("cards parse to what was written, trimmed, and read the row's own columns", () => {
  // Written as `properties`, kept in the model as the card's `lines`.
  const { properties, ...rest } = full;
  assert.deepEqual(cards({ ...full, primary: ' title ', image: { ...full.image, sort: ' position   desc ' } }), {
    ...rest,
    lines: properties,
    image: { ...full.image, sort: 'position desc' },
  });
  assert.deepEqual(cards({ kind: 'cards', primary: 'title' }), { kind: 'cards', primary: 'title' });
  assert.deepEqual(cards({ kind: 'cards', primary: 'title', image: ' photo_url ' }), {
    kind: 'cards',
    primary: 'title',
    image: 'photo_url',
  });
  assert.deepEqual(cards({ kind: 'cards', primary: 'title', image: 'photo_url', media: 'avatar' }), {
    kind: 'cards',
    primary: 'title',
    image: 'photo_url',
    media: 'avatar',
  });
  // The file resource's columns are its own query's; the row's are the list's.
  // Each once: a column a card says twice is fetched once.
  assert.deepEqual(listPresentationColumns(cards(full)!), ['title', 'price', 'highlight', 'year']);
  assert.deepEqual(listPresentationColumns(cards({ kind: 'cards', primary: 'title', image: 'photo_url' })!), ['title', 'photo_url']);
  assert.equal(problem(full), undefined);
  assert.equal(problem({ kind: 'cards', primary: 'title', value: 'price', image: 'photo_url' }), undefined);
});

test("a card with no title says its record's name, read where the catalog reads it", () => {
  const titled = (resources: Record<string, unknown>, served: DatabaseSchema = schema) =>
    (
      (resolveViews(parse({ kind: 'cards', value: 'price' }, { ...photos, ...resources }), served).vehicles as AppListView)
        .presentation as { primary: string }
    ).primary;
  // As written, the record's name; resolved, the resource's recordLabel column.
  assert.equal(cards({ kind: 'cards' })!.kind === 'cards' && (cards({ kind: 'cards' }) as { primary: string }).primary, '$label');
  assert.equal(titled({ vehicle: { recordLabel: 'highlight' } }), 'highlight');
  // A path through a reference, as the record is named.
  assert.equal(titled({ vehicle: { recordLabel: 'dealer_id.name' } }), 'dealer_id.name');
  // No recordLabel: the column the catalog names the record by.
  assert.equal(titled({}), 'title');
  // A template the catalog computes is read as $label.
  const templated = {
    ...schema,
    tables: schema.tables.map((table) => (table.id === 'vehicle' ? { ...table, labelTemplate: '{year} {title}' } : table)),
  };
  assert.equal(titled({ vehicle: { recordLabel: '{year} {title}' } }, templated), '$label');
  assert.equal(problem({ kind: 'cards', value: 'price' }), undefined);
});

test('cards are refused by name: keys, paths, lines and the shape of a picture', () => {
  assert.throws(
    () => cards({ ...full, by: 'status' }),
    /presentation \(a cards\) has no "by"\. It takes: kind, primary, description, value, badge, icon, properties, facts, footer, image, media/,
  );
  // A title, a figure and a picture read one reference away at most.
  assert.throws(() => cards({ kind: 'cards', primary: 'dealer_id.name.first' }), /"primary" must be a local column or a one-hop path/);
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', value: 'dealer_id.name.first' }),
    /"value" must name a column, or a column one reference away/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', image: 'a.b.c' }),
    /"image" must name a column, or a column one reference away/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', image: { about: 'dealer_id.id', from: 'vehicle_photo', whose: 'vehicle_id' } }),
    /"about" must name a local column, not a path/,
  );
  assert.throws(() => cards({ kind: 'cards', primary: 'title', badge: '' }), /"badge" must name a local column/);
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', properties: ['a', 'b', 'c', 'd', 'e'] }),
    /"properties" must be a list of at most 4 local columns/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', image: 7 }),
    /"image" must be a column holding an image address, or \{ from, whose, sort\? \}/,
  );
  assert.throws(() => cards({ kind: 'cards', primary: 'title', media: 'profile' }), /"media" must be "cover", "avatar" or "icon"/);
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', image: { from: 'vehicle_photo', whose: 'vehicle_id', path: 'x' } }),
    /image has no "path"\. "path" belongs on a view\. It takes: about, from, whose, sort/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', image: { whose: 'vehicle_id' } }),
    /"from" must name a resource whose rows are files/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', image: { from: 'vehicle_photo', whose: 'vehicle.id' } }),
    /"whose" must name a local column/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position sideways' } }),
    /"sort" is one column and an optional direction/,
  );
  assert.throws(
    () => cards({ kind: 'kanban', primary: 'title' }),
    /"checklist", "queue", "board", "calendar", "tree", "gantt", "cards", "split" or "custom"/,
  );
});

test('cards are judged against the catalog: text where text is read, and a picture from a real file resource that points back', () => {
  assert.match(problem({ kind: 'cards', primary: 'price' })!, /Cards primary must be a text column/);
  assert.match(problem({ kind: 'cards', primary: 'title', image: 'year' })!, /Cards image must be a text column/);
  assert.match(problem({ kind: 'cards', primary: 'title', value: 'mileage' })!, /Cards value: "mileage" must be a local readable column/);
  assert.match(
    problem({ kind: 'cards', primary: 'title', image: { from: 'dealer', whose: 'id' } })!,
    /"dealer" is not a resource whose rows are files; declare "file" on it/,
  );
  assert.match(
    problem({ kind: 'cards', primary: 'title', image: { from: 'vehicle_photo', whose: 'position' } })!,
    /"vehicle_photo\.position" does not reference "vehicle"/,
  );
  assert.match(
    problem({ kind: 'cards', primary: 'title', image: { from: 'vehicle_photo', whose: 'owner_id' } })!,
    /"vehicle_photo" has no column "owner_id"/,
  );
  assert.match(
    problem({ kind: 'cards', primary: 'title', image: { from: 'vehicle_photo', whose: 'vehicle_id', sort: 'taken_on' } })!,
    /"vehicle_photo" has no column "taken_on" to sort by/,
  );
  assert.match(
    problem({ kind: 'cards', primary: 'title', image: { from: 'lot_photo', whose: 'vehicle_id' } })!,
    /this connection has no table "lot_photo"/,
  );
});

test('a cards list is stable and takes no grid-only keys', () => {
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'Market',
          resources: { vehicle: {} },
          views: { vehicles: { kind: 'list', from: 'vehicle', totals: ['price'], presentation: { kind: 'cards', primary: 'title' } } },
          home: 'vehicles',
        },
        'x',
      ),
    /"totals" and a cards presentation/,
  );
});

test('a fact can say a word after its value, made plural by rule or written out, and is fetched like any fact', async () => {
  const { factWord } = await import('../packages/engine/src/shared/appCards.js');
  const worded = cards({
    kind: 'cards',
    primary: 'title',
    facts: ['year', { column: 'price', after: 'point' }, { column: 'highlight', after: { one: 'person', many: 'people' } }],
  });
  assert.deepEqual(worded, {
    kind: 'cards',
    primary: 'title',
    facts: ['year', 'price', 'highlight'],
    factLabels: { price: { one: 'point' }, highlight: { one: 'person', many: 'people' } },
  });
  assert.deepEqual(listPresentationColumns(worded!), ['title', 'year', 'price', 'highlight']);
  assert.equal(problem({ kind: 'cards', primary: 'title', facts: [{ column: 'price', after: 'point' }] }), undefined);
  assert.match(
    problem({ kind: 'cards', primary: 'title', facts: [{ column: 'mileage', after: 'mile' }] }) ?? '',
    /"mileage" must be a readable column/,
  );
  const owner = { one: 'owner', many: 'owners' };
  assert.deepEqual(
    [1, '1', 3, 0, '2', 'a few'].map((value) => factWord(owner, value)),
    ['owner', 'owner', 'owners', 'owners', 'owners', 'owner'],
  );
  /* A word written once agrees with a count by the shared rule, whichever way it was written, and a phrase
     agrees by its plural word, never by an "s" on its last one ("0 tickets loggeds"). */
  const said = (one: string) => [0, 1, 3].map((value) => factWord({ one }, value));
  assert.deepEqual(said('bed'), ['beds', 'bed', 'beds']);
  assert.deepEqual(said('beds'), ['beds', 'bed', 'beds']);
  assert.deepEqual(said('box'), ['boxes', 'box', 'boxes']);
  assert.deepEqual(said('tickets logged'), ['tickets logged', 'ticket logged', 'tickets logged']);
  assert.deepEqual(said('open tickets'), ['open tickets', 'open ticket', 'open tickets']);
  assert.deepEqual(said('left to pay'), ['left to pay', 'left to pay', 'left to pay']);
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', facts: [{ column: 'price', after: '' }] }),
    /has an? "after" that is not a word/,
  );
  assert.throws(() => cards({ kind: 'cards', primary: 'title', facts: [{ column: 'price', after: 'x', unit: 'y' }] }), /no "unit"/);
  assert.throws(() => cards({ kind: 'cards', primary: 'title', facts: [7] }), /"facts" must be one to 6 columns/);
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', facts: ['price', { column: 'price', after: 'point' }] }),
    /names a column twice/,
  );
});

test("a card's icon is a column whose display rule maps its values to icons, and is fetched with the row", () => {
  const marked = { ...photos, vehicle: { display: { highlight: { icons: { 'One owner': 'star' } } } } };
  assert.equal(problem({ kind: 'cards', primary: 'title', icon: 'highlight' }, marked), undefined);
  assert.ok(listPresentationColumns(cards({ kind: 'cards', primary: 'title', icon: 'highlight' }, marked)!).includes('highlight'));
  assert.match(
    problem({ kind: 'cards', primary: 'title', icon: 'highlight' })!,
    /Cards icon: "highlight" has no icons to draw.*display\.highlight\.icons/,
  );
  assert.match(problem({ kind: 'cards', primary: 'title', icon: 'fuel' }, marked)!, /Cards icon: "fuel" must be a local readable column/);
  assert.throws(() => cards({ kind: 'cards', primary: 'title', icon: 'dealer_id.name' }), /icon/);
});

test('an icon tile leads the card from its icon column, and a foot says values along its last line', () => {
  const marked = { ...photos, vehicle: { display: { highlight: { icons: { 'One owner': 'star' } } } } };
  const tiled = cards(
    { kind: 'cards', primary: 'title', icon: 'highlight', media: 'icon', facts: ['year'], footer: ['price', 'fuel'] },
    marked,
  );
  assert.deepEqual(tiled, {
    kind: 'cards',
    primary: 'title',
    icon: 'highlight',
    media: 'icon',
    facts: ['year'],
    footer: ['price', 'fuel'],
  });
  assert.equal(problem({ kind: 'cards', primary: 'title', icon: 'highlight', media: 'icon', footer: ['price'] }, marked), undefined);
  assert.ok(listPresentationColumns(tiled!).includes('price'));
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', media: 'icon' }),
    /"media: 'icon'" leads the card with its "icon" column's mark/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', icon: 'highlight', media: 'icon', image: 'photo_url' }),
    /a card has one lead/,
  );
  assert.throws(
    () => cards({ kind: 'cards', primary: 'title', facts: ['price'], footer: ['price'] }),
    /"price" is in "facts" and in "footer"/,
  );
  assert.throws(() => cards({ kind: 'cards', primary: 'title', footer: ['a', 'b', 'c', 'd', 'e'] }), /footer/);
});

/* A saved car: a row that only points at the car, drawn as the car — its title, its price and its photo read through
   the reference, one hop. */
const savedSchema: DatabaseSchema = {
  ...schema,
  tables: [
    ...schema.tables,
    {
      id: 'saved',
      name: 'saved',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', { primaryKey: true, nullable: false }), column('vehicle_id', 'INTEGER'), column('note', 'TEXT')],
    },
  ],
  foreignKeys: [...schema.foreignKeys, { from: { table: 'saved', columns: ['vehicle_id'] }, to: { table: 'vehicle', columns: ['id'] } }],
} as DatabaseSchema;
const parseSaved = (presentation: unknown) =>
  parseAppConfig(
    {
      name: 'Market',
      resources: { vehicle: {}, dealer: {}, saved: {}, ...photos },
      views: { saved: { kind: 'list', from: 'saved', presentation } },
      home: 'saved',
      nav: ['saved'],
    },
    'saved cards fixture',
  );
const savedProblem = (presentation: unknown, catalog = savedSchema) =>
  (resolveViews(parseSaved(presentation), catalog).saved as { error?: string }).error;
const throughCar = {
  kind: 'cards',
  primary: 'vehicle_id.title',
  value: 'vehicle_id.price',
  facts: ['vehicle_id.year'],
  image: { about: 'vehicle_id', from: 'vehicle_photo', whose: 'vehicle_id', sort: 'position' },
};

test('cards through a reference: the title, the figure and the picture of the record a row points at, judged against the catalog', () => {
  const spec = (parseSaved(throughCar).views.saved as AppListView).presentation!;
  assert.deepEqual(spec, throughCar);
  assert.deepEqual(listPresentationColumns(spec), ['vehicle_id.title', 'vehicle_id.price', 'vehicle_id.year', 'vehicle_id']);
  assert.equal(savedProblem(throughCar), undefined);
  assert.equal(savedProblem({ kind: 'cards', primary: 'vehicle_id.title', image: 'vehicle_id.photo_url' }), undefined);
  assert.match(savedProblem({ ...throughCar, value: 'vehicle_id.nope' })!, /"vehicle" has no column "nope"/);
  assert.match(savedProblem({ ...throughCar, primary: 'note.title' })!, /"note" in "note.title" is not a reference of "saved"/);
  assert.match(
    savedProblem({ kind: 'cards', primary: 'note', image: 'vehicle_id.year' })!,
    /Cards image must be a text column; "vehicle_id.year" is not/,
  );
  assert.match(
    savedProblem({ ...throughCar, image: { ...throughCar.image, about: 'note' } })!,
    /"about" names "note", which is not a reference of "saved"/,
  );
  assert.match(
    savedProblem({ ...throughCar, image: { ...throughCar.image, about: 'nope' } })!,
    /"about" names "nope", which is not a readable column of "saved"/,
  );
  // Without `about`, the photos must point at the row itself, and these point at the car.
  assert.match(
    savedProblem({ ...throughCar, image: { from: 'vehicle_photo', whose: 'vehicle_id' } })!,
    /"vehicle_photo\.vehicle_id" does not reference "saved"/,
  );
});

test('a part of a card read through a reference the reader may not read is left off, and the card stands without it', () => {
  const saved = savedSchema.tables.find((table) => table.id === 'saved')!;
  const list = throughCar as AppCardsList;
  assert.equal(cardsReadable(list, saved, savedSchema), list, 'a reader who reads it all keeps the card as written');
  // This reader reads the car without its price.
  const noPrice = {
    ...savedSchema,
    tables: savedSchema.tables.map((table) =>
      table.id === 'vehicle' ? { ...table, columns: table.columns.filter((c) => c.name !== 'price') } : table,
    ),
  } as DatabaseSchema;
  const { value: _value, ...withoutPrice } = list;
  assert.deepEqual(cardsReadable(list, saved, noPrice), withoutPrice);
  // And this one is not served the photos at all: the card keeps its words.
  const noPhotos = { ...savedSchema, tables: savedSchema.tables.filter((table) => table.id !== 'vehicle_photo') } as DatabaseSchema;
  const { image: _image, ...withoutPhoto } = list;
  assert.deepEqual(cardsReadable(list, saved, noPhotos), withoutPhoto);
});
