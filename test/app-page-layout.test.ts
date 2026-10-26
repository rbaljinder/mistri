/**
 * A page's archetype (`page(…, { layout })`, shared/pageLayouts.ts): the word
 * is read and carried, what each layout cannot place is refused by the
 * section with its fix and its code, a mistri.json page, a document and a
 * free-form page are told the word is not theirs, and the default rail is
 * drawn only where the layout keeps an aside of the record's context.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAppPage } from '../packages/mistri/src/shared/appPages.js';
import { parsePagesConfig, validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import { chooseLayout, drawnLayout, showcaseIndex } from '../packages/engine/src/shared/pageLayouts.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { pageFiles, readPageFiles } from '../packages/mistri/src/server/app/appPages.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const schema: DatabaseSchema = {
  label: 'Homes',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'unit',
      name: 'unit',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('name', 'TEXT'),
        column('status', 'TEXT'),
        column('rent', 'NUMERIC'),
        column('beds', 'INTEGER'),
        column('notes', 'TEXT'),
      ],
    },
  ],
};
const scope = { secondary: new Set<string>(), nouns: { unit: 'home' } };
const read = (body: object): PageDef => parseAppPage({ base: 'unit', ...body }, 'unit', 'pages "unit"', scope);
const parse = (body: object): PageDef => validatePage(schema, read(body));
/** The refusal's text and the code `mistri check` files it under. */
function refused(body: object): { code: string; message: string } {
  try {
    read(body);
  } catch (error) {
    const message = (error as Error).message;
    return { code: validationCode(message), message };
  }
  assert.fail('the page was not refused');
}

const header = { kind: 'header', status: 'status', facts: ['beds'] };
const thread = { kind: 'timeline', title: 'Conversation', streams: [{ from: 'unit', whose: 'id', at: 'name', show: 'notes' }] };
const photos = { kind: 'list', title: 'Photos', from: 'unit', whose: 'id', presentation: 'gallery' };
const price = { kind: 'headline', show: ['rent'], region: 'aside' };
const parts = { kind: 'list', title: 'Parts used', from: 'unit', whose: 'id', show: ['name', 'beds'] };

test("the word is carried, and a written 'record' is the record's own skeleton", () => {
  assert.equal(read({ layout: 'article', sections: [{ kind: 'fields', show: ['name'] }] }).layout, 'article');
  const none = read({ sections: [{ kind: 'fields', show: ['name'] }] });
  assert.equal(none.layout, undefined);
  assert.equal(none.defaultAside, true);
  // Written out, the skeleton keeps a page its sections would make a showcase: no data-layout, and its default rail.
  const record = read({ layout: 'record', sections: [photos, price] });
  assert.equal(record.layout, 'record');
  assert.equal(record.layoutWhy, undefined);
  assert.equal(drawnLayout(record), undefined);
  assert.equal(showcaseIndex(record), undefined);
  assert.equal(record.defaultAside, true);
});

test('page-layout: an unknown word is refused with the four', () => {
  const { code, message } = refused({ layout: 'document', sections: [] });
  assert.equal(code, 'page-layout');
  assert.match(
    message,
    /^\[page-layout\] pages "unit" \("Home"\) has "layout": "document"\. A page's layout is 'record' \(the record's own: its lists beside a rail\), 'conversation' \(a thread with its facts beside it\), 'showcase' \(photos with the price beside them\) or 'article' \(one column at a reading measure\); leave it out for the one its sections make\.$/,
  );
});

test('page-layout: a mistri.json page, a document and a free-form page are told the word is not theirs', async (t) => {
  assert.throws(
    () => parsePagesConfig({ pages: [{ base: 'unit', layout: 'article' }] }, 'mistri.json'),
    /^Error: \[page-layout\] mistri\.json: page 1 \("Unit"\) has "layout", which is an App page's: a config file's page draws the record's one skeleton\. Remove it\.$/,
  );
  // On the page, or handed to document() with its options, as the builder hands them to the paper.
  for (const body of [{ layout: 'article', document: { label: 'Lease' } }, { document: { label: 'Lease', layout: 'article' } }]) {
    const { code, message } = refused({ ...body, sections: [{ kind: 'fields', show: ['name'] }] });
    assert.equal(code, 'page-layout');
    assert.equal(message, `[page-layout] pages "unit" is a document, and a document has one layout, paper's. Remove "layout".`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-layout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'pages'));
  writeFileSync(
    join(dir, 'pages', 'board.page.tsx'),
    "import { definePage, Empty } from '@mistriwork/mistri/page';\nexport default definePage({ label: 'Board', reads: ['unit'], layout: 'article', component: () => <Empty title=\"x\" /> });\n",
  );
  await assert.rejects(
    readPageFiles(dir, await pageFiles(dir)),
    /\[page-layout\] pages\/board\.page\.tsx: definePage has "layout", which is a record page's \(page\(…, \{ layout \}\)\): a free-form page lays itself out in its component\. Remove it\./,
  );
});

test('conversation: the one timeline, last in main; the headline, cards and history stand beside it unasked', () => {
  const page = parse({
    layout: 'conversation',
    sections: [
      header,
      { kind: 'fields', show: ['beds'] },
      { kind: 'headline', show: ['rent'] },
      thread,
      { ...parts, region: 'aside' },
      { kind: 'card', show: ['id'] },
    ],
  });
  assert.deepEqual(
    page.sections.map((section) => section.region ?? 'main'),
    ['main', 'main', 'aside', 'main', 'aside', 'aside'],
  );
  // The default rail stays: an aside written beside the thread already says the record's context, so none is added.
  assert.equal(page.defaultAside, true);
});

test('layout-conversation: what a thread cannot stand beside is refused by the section', () => {
  const cases: Array<[object[], RegExp]> = [
    [
      [header],
      /^\[layout-conversation\] pages "unit" is a conversation with no timeline\. A conversation is its one timeline, last in main: put the rest in region: 'aside', and add timeline\('Conversation', \[stream\(…\)\]\) to the main column, or leave out "layout"\.$/,
    ],
    [[thread, thread], /is a conversation with 2 timelines\. A conversation is its one timeline: say every stream in one timeline/],
    [[{ ...thread, region: 'aside' }], /section 1 puts the conversation's timeline in the aside/],
    [
      [thread, parts],
      /^\[layout-conversation\] pages "unit", section 2 is a related list "Parts used" in the main column\. A conversation is its one timeline, last in main: put the rest in region: 'aside': related\('Parts used', …, \{ region: 'aside' \}\)\.$/,
    ],
    [[{ kind: 'metric', title: 'Open', from: 'unit', whose: 'id' }, thread], /section 1 is a metric "Open" in the main column/],
    [
      [{ kind: 'fields', show: ['beds'], tab: 'One' }, { kind: 'fields', show: ['rent'], tab: 'Two' }, thread],
      /section 1 names the tab "One" in the main column\. A thread is not one tab among others/,
    ],
    [
      [thread, { kind: 'fields', show: ['beds'] }],
      /^\[layout-conversation\] pages "unit", section 2 \(a fields\) stands after the timeline in the main column\. .*, or above the timeline, so the composer ends the thread\.$/,
    ],
  ];
  for (const [sections, said] of cases) {
    const { code, message } = refused({ layout: 'conversation', sections });
    assert.equal(code, 'layout-conversation', message);
    assert.match(message, said);
  }
});

test('showcase: the photos lead, the panel 1 to 3 aside sections, and no default rail', () => {
  const page = parse({ layout: 'showcase', sections: [header, photos, price, { kind: 'fields', show: ['beds'] }] });
  assert.equal(showcaseIndex(page), 1);
  assert.equal(page.defaultAside, undefined);
  assert.deepEqual(
    page.sections.filter((section) => section.region === 'aside').map((section) => section.kind === 'fields' && section.presentation),
    ['headline'],
  );
  assert.equal(showcaseIndex({ ...page, layout: undefined }), undefined);
});

test('layout-showcase: a showcase opens with its photos and has its panel', () => {
  const fix =
    "A showcase opens with its photos: related\\('Photos', …, \\{ presentation: 'gallery' \\}\\) first, its price headline in the aside";
  const cases: Array<[object, RegExp]> = [
    [
      { sections: [header, { kind: 'fields', show: ['beds'] }, photos, price] },
      new RegExp(`^\\[layout-showcase\\] pages "unit", section 2 is a fields, first in the main column\\. ${fix}\\.$`),
    ],
    [
      { sections: [photos] },
      new RegExp(
        `^\\[layout-showcase\\] pages "unit" is a showcase with nothing in the aside\\. ${fix}: headline\\('…', \\{ region: 'aside' \\}\\)\\.$`,
      ),
    ],
    [
      { sections: [photos, price, price, price, price] },
      /has 4 sections in the aside, and a showcase's panel holds 1 to 3 beside the photos: move the rest into the main column/,
    ],
    [
      { sections: [photos, { ...price, tab: 'Rent' }, { ...price, tab: 'Fees' }] },
      /section 2 names the tab "Rent" in the aside\. A showcase's panel stands beside the photos whole: leave out "tab"\./,
    ],
    [
      { aside: false, sections: [photos, price] },
      /^\[layout-showcase\] pages "unit" is a showcase that says aside: false\. A showcase is its panel beside the photos: leave out "layout" instead\.$/,
    ],
  ];
  for (const [body, said] of cases) {
    const { code, message } = refused({ layout: 'showcase', ...body });
    assert.equal(code, 'layout-showcase', message);
    assert.match(message, said);
  }
});

test('a written "listing" is refused with its new word, "showcase"', () => {
  const { code, message } = refused({ layout: 'listing', sections: [photos, price] });
  assert.equal(code, 'page-layout', message);
  assert.match(message, /has "layout": "listing", which is now "showcase"/);
});

test('article: one column, no default rail; an aside, aside: false and a third are refused', () => {
  const page = parse({ layout: 'article', sections: [{ kind: 'fields', show: ['name', 'beds'], width: 'half' }] });
  assert.equal(page.defaultAside, undefined);
  assert.equal(page.sections.filter((section) => section.region === 'aside').length, 0);
  const cases: Array<[object, RegExp]> = [
    [
      {
        sections: [
          { kind: 'fields', show: ['name'] },
          { kind: 'card', title: 'Home', show: ['id'] },
        ],
      },
      /^\[layout-article\] pages "unit", section 2 \(a card "Home"\) stands in the aside\. An article has no aside: move card\('Home', …\) into the column with region: 'main', or leave out "layout"\.$/,
    ],
    [
      { aside: false, sections: [] },
      /^\[layout-article\] pages "unit" is an article that says aside: false\. An article has no aside already: remove "aside"\.$/,
    ],
    [
      { sections: [{ kind: 'fields', show: ['name'], width: 'third' }] },
      /^\[layout-article\] pages "unit", section 1 has width: 'third'\. An article is one column at a reading measure, where a third is too narrow for a value: use 'half' or leave "width" out\.$/,
    ],
  ];
  for (const [body, said] of cases) {
    const { code, message } = refused({ layout: 'article', ...body });
    assert.equal(code, 'layout-article', message);
    assert.match(message, said);
  }
});

/* A page that names no layout is drawn in the one its sections make (chooseLayout): chosen as the App is read. */
const words = { kind: 'fields', show: ['notes'] };
const facts = { kind: 'fields', show: ['name', 'beds', 'rent'] };

test('chosen: a gallery first is a showcase, said why, with no default rail', () => {
  const page = read({ sections: [header, photos, price, facts] });
  assert.equal(page.layout, 'showcase');
  assert.equal(page.layoutWhy, 'it opens with the gallery "Photos", with a panel beside it');
  assert.equal(showcaseIndex(page), 1);
  assert.equal(page.defaultAside, undefined);
  // Photos lead the page they open, whatever else it holds: a thread under them stays one section of a showcase.
  assert.equal(read({ sections: [photos, price, thread] }).layout, 'showcase');
});

test('chosen: a timeline that ends the main column with no list in it is a conversation, its headline beside it', () => {
  const page = read({ sections: [header, { kind: 'headline', show: ['rent'] }, facts, thread, { ...parts, region: 'aside' }] });
  assert.equal(page.layout, 'conversation');
  assert.equal(page.layoutWhy, 'its main column ends with the timeline "Conversation", and no list stands in it');
  assert.deepEqual(
    page.sections.map((section) => section.region ?? 'main'),
    ['main', 'aside', 'main', 'main', 'aside'],
  );
});

test("chosen: the record's long text with its facts and nothing else is an article, with no default rail", () => {
  const page = read({ sections: [header, facts, words, { kind: 'note', text: 'Read before a viewing.' }] });
  assert.equal(page.layout, 'article');
  assert.equal(page.layoutWhy, `it is the record's words, "notes", with 3 facts and nothing else`);
  assert.equal(page.defaultAside, undefined);
});

test("chosen: what a layout would refuse, or does not lead with its section, is the record's own, said why", () => {
  const cases: Array<[object[], RegExp]> = [
    // A gallery with more beside it than a panel holds.
    [
      [photos, price, price, price, price],
      /^it opens with a gallery, but a showcase would refuse it: the page has 4 sections in the aside/,
    ],
    // Photos below the facts are a list of photos on a record.
    [[facts, photos, price], /^it opens with no gallery; it has no timeline; it holds more than fields and notes$/],
    // A list after the thread: the timeline is one section among others.
    [[thread, parts], /it has a timeline, but a conversation would refuse it: the page, section 2 is a related list "Parts used"/],
    [
      [{ ...facts, tab: 'One' }, { kind: 'fields', show: ['beds'], tab: 'Two' }, thread],
      /a conversation would refuse it: the page, section 1 names the tab "One"/,
    ],
    // Words beside a list, a card or a figure are a record with a note on it.
    [[facts, words, parts], /it holds more than fields and notes$/],
    [[words, { kind: 'card', show: ['id'] }], /it holds more than fields and notes$/],
    [[words, { kind: 'headline', show: ['rent'] }], /it holds more than fields and notes$/],
    // Facts alone, another record's words, or more facts than a rail holds.
    [[facts], /it names no long text, a description or a body$/],
    [[{ kind: 'fields', show: ['name', 'id.notes'] }], /it names no long text/],
    [[{ kind: 'header', facts: ['notes'] }, facts], /it names no long text/],
    [
      [words, { kind: 'fields', show: Array.from({ length: 13 }, (_, i) => `f${i}`) }],
      /it has 13 facts beside its words, more than a rail's 12$/,
    ],
    [
      [{ ...words, width: 'third' }, facts],
      /it is the record's words, but an article would refuse it: the page, section 1 has width: 'third'/,
    ],
  ];
  for (const [sections, said] of cases) {
    const page = read({ sections });
    assert.equal(page.layout, undefined, JSON.stringify(sections));
    assert.equal(page.layoutWhy, undefined);
    const chosen = chooseLayout(page);
    assert.equal(chosen.layout, 'record');
    assert.match(chosen.why, said);
  }
  // aside: false keeps the page as written: neither a showcase's panel nor an article's column says it.
  assert.equal(read({ aside: false, sections: [photos, price] }).layout, undefined);
  assert.equal(read({ aside: false, sections: [facts, words] }).layout, undefined);
});

test('chosen: never a document, never over a written word, and the same every time it is read', () => {
  assert.equal(read({ document: { label: 'Lease' }, sections: [facts, words] }).layout, undefined);
  const written = read({ layout: 'article', sections: [photos, { ...facts, region: 'main' }] });
  assert.equal(written.layout, 'article');
  assert.equal(written.layoutWhy, undefined);
  const body = { sections: [header, photos, price, facts] };
  assert.deepEqual(read(body), read(body));
  // A chosen page validates as a written one does: the reader's schema moves nothing, so a record never reshapes.
  assert.equal(parse(body).layout, 'showcase');
  assert.equal(parse({ sections: [facts, words] }).sections.length, 2);
});
