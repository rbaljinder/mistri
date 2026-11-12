/**
 * The default aside (pageAnatomy.ts, withDefaultAside): an App's record page
 * that declares no aside gets the record's remaining readable fields as a
 * property rail titled by its noun, `aside: false` opts out, and nothing
 * remaining draws none.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppPage } from '../packages/mistri/src/shared/appPages.js';
import { validatePage, type PageDef, type PageSection } from '../packages/engine/src/shared/page.js';
import { defaultAsidePaths } from '../packages/engine/src/shared/pageAnatomy.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const schema: DatabaseSchema = {
  label: 'Shop',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'bike',
      name: 'bike',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('name', 'TEXT'),
        column('status', 'TEXT'),
        column('make', 'TEXT'),
        column('model', 'TEXT'),
        column('color', 'TEXT'),
        column('notes', 'TEXT'),
        column('password_hash', 'TEXT'),
      ],
    },
  ],
};

const scope = { secondary: new Set<string>(), nouns: { bike: 'bike' } };
const parse = (body: object): PageDef => validatePage(schema, parseAppPage({ base: 'bike', ...body }, 'bike', 'pages "bike"', scope));
const aside = (page: PageDef): PageSection[] => page.sections.filter((section) => section.region === 'aside');
const paths = (section: PageSection) => (section.kind === 'fields' ? section.paths : undefined);

test('a page with no aside gets the remaining readable fields, titled by the noun, long text last', () => {
  const page = parse({
    sections: [
      { kind: 'header', facts: ['make'], status: 'status' },
      { kind: 'fields', show: ['model'] },
    ],
  });
  const [rail, ...more] = aside(page);
  assert.equal(more.length, 0);
  assert.equal(rail.title, 'Bike');
  assert.deepEqual(paths(rail), ['color', 'notes']);
  assert.equal((rail as { presentation?: string }).presentation, 'properties');
});

test('a page that declares its own aside is left as written', () => {
  const page = parse({
    sections: [
      { kind: 'fields', show: ['make'] },
      { kind: 'fields', title: 'Bike', region: 'aside', show: ['color'] },
    ],
  });
  assert.deepEqual(aside(page).map(paths), [['color']]);
});

test('aside: false opts out', () => {
  const page = parse({ aside: false, sections: [{ kind: 'fields', show: ['make'] }] });
  assert.equal(aside(page).length, 0);
});

test('aside takes only false', () => {
  assert.throws(() => parseAppPage({ base: 'bike', aside: true, sections: [] }, 'bike', 'pages "bike"', scope), /can only be false/);
});

test('nothing remaining draws no aside', () => {
  const page = parse({
    sections: [{ kind: 'fields', show: ['make', 'model', 'color', 'notes', 'status'] }],
  });
  assert.equal(aside(page).length, 0);
});

test('a fields section with no paths is the whole record, so no aside', () => {
  assert.equal(aside(parse({ sections: [{ kind: 'fields' }] })).length, 0);
});

test('a column the reader cannot read is not offered', () => {
  const narrowed: DatabaseSchema = {
    ...schema,
    tables: [{ ...schema.tables[0], columns: schema.tables[0].columns.filter((c) => c.name !== 'color') }],
  };
  const page = validatePage(
    narrowed,
    parseAppPage({ base: 'bike', sections: [{ kind: 'fields', show: ['make'] }] }, 'bike', 'pages "bike"', scope),
  );
  assert.deepEqual(paths(aside(page)[0]), ['status', 'model', 'notes']);
});

test('validating twice adds the aside once', () => {
  const once = parse({ sections: [{ kind: 'fields', show: ['make'] }] });
  assert.equal(aside(validatePage(schema, once)).length, 1);
});

test('check --defaults says what the aside draws, or why none (defaultAsidePaths)', () => {
  const read = (body: object) => defaultAsidePaths(schema, parseAppPage({ base: 'bike', ...body }, 'bike', 'pages "bike"', scope));
  assert.deepEqual(read({ sections: [{ kind: 'fields', show: ['make', 'model', 'status'] }] }), ['color', 'notes']);
  assert.equal(read({ aside: false, sections: [{ kind: 'fields', show: ['make'] }] }), 'none: the page says aside: false');
  assert.equal(
    read({ sections: [{ kind: 'fields', title: 'Bike', region: 'aside', show: ['color'] }] }),
    'none: the page writes its own aside',
  );
  assert.equal(read({ sections: [{ kind: 'fields' }] }), 'none: a fields section with no paths shows the whole record');
  assert.equal(
    read({ sections: [{ kind: 'fields', show: ['make', 'model', 'color', 'notes', 'status'] }] }),
    // The record's long text and a few facts, nothing else, is read as an article, which has no aside.
    "none: the 'article' layout has no default aside",
  );
});
