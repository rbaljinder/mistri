/**
 * Taking the schema out of tablewalk.
 *
 * The text formats are pure functions of the schema, so they can be tested
 * without a browser — which is the point of keeping them out of the control
 * that renders them. The picture cannot be: `standaloneSvg` reads computed
 * styles and `svgToPng` needs a canvas, so both are exercised in the browser
 * suite instead. What is pinned here is everything that decides *what* ends
 * up in the file, which is where the mistakes that matter live.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { selection, toMermaid, toMarkdown, toSchemaJson } from '../packages/kit/src/client/schemaexport.js';

const schema = {
  label: 'erp',
  dialect: 'postgres',
  readAt: '2026-08-22T00:00:00.000Z',
  tables: [
    {
      id: 'app.customer',
      name: 'customer',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, nullable: false },
        { name: 'name', type: 'character varying', nullable: false },
        { name: 'country_id', type: 'integer', nullable: true, references: { table: 'app.country', column: 'id' } },
      ],
    },
    {
      id: 'app.country',
      name: 'country',
      columns: [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }],
    },
    {
      id: 'app.invoice',
      name: 'invoice',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, nullable: false },
        { name: 'customer_id', type: 'integer', nullable: false, references: { table: 'app.customer', column: 'id' } },
      ],
    },
  ],
  foreignKeys: [
    { from: { table: 'app.customer', columns: ['country_id'] }, to: { table: 'app.country', columns: ['id'] }, onDelete: 'set null' },
    { from: { table: 'app.invoice', columns: ['customer_id'] }, to: { table: 'app.customer', columns: ['id'] }, onDelete: 'restrict' },
  ],
} as any;

describe('what gets exported', () => {
  test('everything, when nothing is selected', () => {
    const { tables, keys } = selection(schema, undefined);
    assert.equal(tables.length, 3);
    assert.equal(keys.length, 2);
  });

  test('only the selected tables', () => {
    const { tables } = selection(schema, new Set(['app.customer', 'app.invoice']));
    assert.deepEqual(
      tables.map((t: any) => t.id),
      ['app.customer', 'app.invoice'],
    );
  });

  test('a key with one end outside the selection is left out', () => {
    /* The failure this prevents: an edge drawn to a table that is not in the
       file — a dangling arrow in the diagram, a broken constraint on import. */
    const { keys } = selection(schema, new Set(['app.customer', 'app.invoice']));
    assert.deepEqual(
      keys.map((k: any) => k.from.table),
      ['app.invoice'],
    );
  });

  test('an empty selection means everything, not nothing', () => {
    // `focused` is empty when the filter is cleared, and the diagram then
    // shows the whole schema. The export has to agree with the picture.
    assert.equal(selection(schema, new Set()).tables.length, 3);
  });
});

describe('mermaid', () => {
  const out = toMermaid(schema, undefined);

  test('is an erDiagram with every table', () => {
    assert.match(out, /^%%[^\n]*\nerDiagram\n/);
    for (const id of ['app_customer', 'app_country', 'app_invoice']) {
      assert.match(out, new RegExp(`\\s${id} \\{`));
    }
  });

  test('marks keys', () => {
    assert.match(out, /integer id PK/);
    assert.match(out, /integer country_id FK/);
  });

  test('a column that is both is marked as both', () => {
    const both = toMermaid(
      {
        ...schema,
        tables: [
          { id: 't', name: 't', columns: [{ name: 'id', type: 'int', primaryKey: true, references: { table: 'u', column: 'id' } }] },
        ],
        foreignKeys: [],
      },
      undefined,
    );
    assert.match(both, /int id PK,FK/);
  });

  test('relationships read parent to child', () => {
    assert.match(out, /app_customer \|\|--o\{ app_invoice : "customer_id"/);
  });

  test('says that dots became underscores', () => {
    /* Silently renaming a table in an export is how someone spends an hour
       looking for `app_customer` in their database. */
    assert.match(out, /^%% Names containing a dot/);
  });

  test('says nothing when nothing was renamed', () => {
    const plain = toMermaid({ ...schema, tables: [{ id: 'customer', name: 'customer', columns: [] }], foreignKeys: [] }, undefined);
    assert.equal(plain.startsWith('erDiagram'), true);
  });

  test('a type with a space does not break the syntax', () => {
    // `character varying` is two words; Mermaid takes one per attribute.
    assert.doesNotMatch(out, /character varying name/);
    assert.match(out, /character_varying name/);
  });
});

describe('markdown', () => {
  const out = toMarkdown(schema, undefined);

  test('leads with the database and its size', () => {
    assert.match(out, /^# erp\n/);
    assert.match(out, /3 tables, 2 foreign keys\./);
  });

  test('gives each table a section and a column table', () => {
    assert.match(out, /## app\.customer/);
    assert.match(out, /\| `name` \| character varying \| required \|  \|/);
    assert.match(out, /\| `id` \| integer \| \*\*key\*\*, required \|  \|/);
  });

  test('a reference points somewhere', () => {
    assert.match(out, /→ `app\.country\.id`/);
  });

  test('says what points back, which is the half usually missing', () => {
    assert.match(out, /Referenced by:\n\n- `app\.invoice` via `customer_id` — on delete restrict/);
  });

  test('singulars are singular', () => {
    const one = toMarkdown(schema, new Set(['app.country']));
    assert.match(one, /1 table, 0 foreign keys\./);
  });

  test('a view says it is a view', () => {
    const views = toMarkdown({ ...schema, tables: [{ id: 'v', name: 'v', isView: true, columns: [] }], foreignKeys: [] }, undefined);
    assert.match(views, /## v \*\(view\)\*/);
  });
});

describe('json', () => {
  test('is the schema, and says when it is only part of one', () => {
    const whole = JSON.parse(toSchemaJson(schema, undefined));
    assert.equal(whole.partial, false);
    assert.equal(whole.tables.length, 3);
    assert.equal(whole.dialect, 'postgres');

    const part = JSON.parse(toSchemaJson(schema, new Set(['app.customer'])));
    assert.equal(part.partial, true);
    assert.equal(part.tables.length, 1);
    assert.equal(part.foreignKeys.length, 0);
  });

  test('a selection of everything is not partial', () => {
    const all = JSON.parse(toSchemaJson(schema, new Set(schema.tables.map((t: any) => t.id))));
    assert.equal(all.partial, false);
  });

  test('records when the schema was read as well as when it was exported', () => {
    const out = JSON.parse(toSchemaJson(schema, undefined));
    assert.equal(out.readAt, '2026-08-22T00:00:00.000Z');
    assert.equal(typeof out.exportedAt, 'string');
  });
});
