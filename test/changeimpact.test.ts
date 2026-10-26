/**
 * What a change would break, before it is written.
 *
 * The notes are the load-bearing part here, the same way the rules are in
 * lint.test.ts: the structured fields are easy to get right and nobody reads
 * them, and the sentences are what actually reaches the person or the agent
 * about to write a migration. So each case pins the sentence, and several pin
 * the sentence that must *not* appear — advice that fires on things people
 * meant is advice they learn to skim past.
 *
 * The two rules the module claims, both tested here:
 *
 *   - a count without its delete rule is not an answer, so an unreported rule
 *     reads as "unknown" rather than as "no action";
 *   - "we did not look" is not "nothing", so an adapter that does not report
 *     indexes must never produce a claim that a foreign key is unindexed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { changeImpact } from '../packages/tablewalk/src/server/changeimpact.js';
import type { Adapter, Filter } from '../packages/engine/src/adapters/adapter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const base = (over: Partial<DatabaseSchema> = {}): DatabaseSchema => ({
  label: 'test',
  dialect: 'postgres',
  readAt: '2026-08-23T00:00:00.000Z',
  tables: [],
  foreignKeys: [],
  ...over,
});

const table = (name: string, columns: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  ({
    name,
    schema: '',
    id: name,
    isView: false,
    columns: columns.map((c) => ({ nullable: true, primaryKey: false, type: 'text', ...c })) as never,
    ...over,
  }) as never;

/**
 * A stand-in for a database that only knows how to count.
 *
 * `rows` is the table's total; `nulls` is what a filtered count returns, which
 * is only ever asked for one column at a time here. A table missing from
 * `rows` throws, which is how the "a table that cannot be counted must not
 * take the report down with it" path gets exercised.
 */
const counter = (rows: Record<string, number>, nulls: Record<string, number> = {}) =>
  ({
    count: async (tableId: string, filter?: Filter) => {
      if (!(tableId in rows)) throw new Error(`no such table ${tableId}`);
      if (!filter) return rows[tableId];
      const column = filter.groups[0]?.[0]?.column ?? '';
      return nulls[`${tableId}.${column}`] ?? 0;
    },
  }) as unknown as Adapter;

const notesOf = async (schema: DatabaseSchema, adapter: Adapter, tableId: string, column?: string): Promise<string[]> =>
  (await changeImpact(adapter, schema, tableId, column)).notes;

describe('adding NOT NULL to a column', () => {
  const schema = base({
    tables: [
      table('invoice', [
        { name: 'id', primaryKey: true, nullable: false, type: 'integer' },
        { name: 'sold_by', type: 'integer' },
      ]),
    ],
  });

  test('is refused while rows hold null, and says how many', async () => {
    const notes = await notesOf(schema, counter({ invoice: 12006 }, { 'invoice.sold_by': 1000 }), 'invoice', 'sold_by');
    assert.ok(
      notes.some((n) => /1,000 of 12,006 rows hold null, so NOT NULL would be refused/.test(n)),
      notes.join('\n'),
    );
  });

  test('would be accepted when none do — and says the next insert can still break it', async () => {
    const notes = await notesOf(schema, counter({ invoice: 12006 }), 'invoice', 'sold_by');
    assert.ok(
      notes.some((n) => /No row of 12,006 holds null/.test(n)),
      notes.join('\n'),
    );
    assert.ok(
      notes.some((n) => /nothing stops the next insert/.test(n)),
      notes.join('\n'),
    );
  });

  test('is not counted at all on a column that already refuses null', async () => {
    const impact = await changeImpact(counter({ invoice: 12006 }), schema, 'invoice', 'id');
    /* A scan to be told zero is a scan the person waiting did not need. */
    assert.equal(impact.columnFacts?.nulls, undefined);
  });

  test('and is not advised on a primary key, which already refuses it', async () => {
    /* SQLite reports an INTEGER PRIMARY KEY as nullable, so without this guard
       the noise is not hypothetical — it appears on the most-asked-about
       column in the database. */
    const pkNullable = base({
      tables: [table('customer', [{ name: 'id', primaryKey: true, type: 'integer' }])],
    });
    const notes = await notesOf(pkNullable, counter({ customer: 2005 }), 'customer', 'id');
    assert.ok(!notes.some((n) => /NOT NULL/.test(n)), notes.join('\n'));
    assert.ok(
      notes.some((n) => /customer\.id is part of the primary key/.test(n)),
      notes.join('\n'),
    );
  });
});

describe('what points at the thing being changed', () => {
  const schema = base({
    tables: [
      table('customer', [{ name: 'id', primaryKey: true, nullable: false, type: 'integer' }], { indexed: ['id'] }),
      table(
        'invoice',
        [
          { name: 'id', primaryKey: true, nullable: false, type: 'integer' },
          { name: 'customer_id', nullable: false, type: 'integer' },
        ],
        { indexed: ['id'] },
      ),
    ],
    foreignKeys: [
      {
        name: 'invoice_customer',
        from: { table: 'invoice', columns: ['customer_id'] },
        to: { table: 'customer', columns: ['id'] },
        onDelete: 'no action',
      },
    ],
  });
  const adapter = counter({ customer: 2005, invoice: 12006 });

  test('names the rule, the table and the number in one sentence', async () => {
    const notes = await notesOf(schema, adapter, 'customer', 'id');
    assert.ok(
      notes.some((n) => /invoice\.customer_id points at customer\.id under `no action`.*12,006 rows in invoice/.test(n)),
      notes.join('\n'),
    );
  });

  test('says when those rows cannot be left pointing at nothing', async () => {
    const notes = await notesOf(schema, adapter, 'customer', 'id');
    assert.ok(
      notes.some((n) => /invoice\.customer_id is NOT NULL/.test(n)),
      notes.join('\n'),
    );
  });

  test('and that an unindexed reference makes every check a scan', async () => {
    const notes = await notesOf(schema, adapter, 'customer', 'id');
    assert.ok(
      notes.some((n) => /No index leads on invoice\.customer_id.*scans 12,006 rows/.test(n)),
      notes.join('\n'),
    );
  });

  test('a cascade says what goes with it rather than that it is refused', async () => {
    const cascading = base({
      ...schema,
      foreignKeys: [{ ...schema.foreignKeys[0], onDelete: 'cascade' }],
    });
    const notes = await notesOf(cascading, adapter, 'customer', 'id');
    assert.ok(
      notes.some((n) => /cascades: removing what it points at takes 12,006 rows/.test(n)),
      notes.join('\n'),
    );
    assert.ok(!notes.some((n) => /refused/.test(n)), notes.join('\n'));
  });

  test('an unreported delete rule is unknown, never "no action"', async () => {
    const unreported = base({
      ...schema,
      foreignKeys: [
        {
          name: 'invoice_customer',
          from: { table: 'invoice', columns: ['customer_id'] },
          to: { table: 'customer', columns: ['id'] },
        },
      ],
    });
    const notes = await notesOf(unreported, adapter, 'customer', 'id');
    assert.ok(
      notes.some((n) => /delete rule was not reported, so what happens.*is unknown rather than nothing/.test(n)),
      notes.join('\n'),
    );
  });

  test('a table that cannot be counted does not take the report down with it', async () => {
    /* `invoice` is absent from the counter, so counting it throws. */
    const impact = await changeImpact(counter({ customer: 2005 }), schema, 'customer', 'id');
    assert.equal(impact.referencedBy[0].rows, undefined);
    assert.ok(
      impact.notes.some((n) => /an unknown number of rows in invoice/.test(n)),
      impact.notes.join('\n'),
    );
  });
});

describe('"we did not look" is not "nothing"', () => {
  test('an adapter that does not report indexes never claims one is missing', async () => {
    /* `indexed` absent on both tables — the honest state on an adapter that
       does not read the catalog's indexes. */
    const schema = base({
      tables: [
        table('customer', [{ name: 'id', primaryKey: true, nullable: false, type: 'integer' }]),
        table('invoice', [{ name: 'customer_id', nullable: false, type: 'integer' }]),
      ],
      foreignKeys: [
        {
          name: 'invoice_customer',
          from: { table: 'invoice', columns: ['customer_id'] },
          to: { table: 'customer', columns: ['id'] },
          onDelete: 'restrict',
        },
      ],
    });
    const impact = await changeImpact(counter({ customer: 1, invoice: 1 }), schema, 'customer', 'id');
    assert.equal(impact.referencedBy[0].indexed, undefined);
    assert.ok(!impact.notes.some((n) => /No index leads on/.test(n)), impact.notes.join('\n'));
  });
});

describe('narrowing to one column', () => {
  const schema = base({
    tables: [
      table(
        'customer',
        [
          { name: 'id', primaryKey: true, nullable: false, type: 'integer' },
          { name: 'email', type: 'text' },
        ],
        { indexed: ['id'] },
      ),
      table('invoice', [{ name: 'customer_id', nullable: false, type: 'integer' }], { indexed: ['customer_id'] }),
    ],
    foreignKeys: [
      {
        name: 'invoice_customer',
        from: { table: 'invoice', columns: ['customer_id'] },
        to: { table: 'customer', columns: ['id'] },
        onDelete: 'restrict',
      },
    ],
  });
  const adapter = counter({ customer: 2005, invoice: 12006 });

  test('drops the references that do not touch it', async () => {
    /* The key points at `customer.id`, so it is beside the point when the
       column being changed is `customer.email`. Listing it anyway is how a
       report becomes something nobody reads to the end of. */
    const impact = await changeImpact(adapter, schema, 'customer', 'email');
    assert.deepEqual(impact.referencedBy, []);
    assert.ok(
      impact.notes.some((n) => /Nothing in this database references customer\.email/.test(n)),
      impact.notes.join('\n'),
    );
  });

  test('and keeps them when it is the column they point at', async () => {
    const impact = await changeImpact(adapter, schema, 'customer', 'id');
    assert.equal(impact.referencedBy.length, 1);
  });

  test('the whole table asks the wider question', async () => {
    const impact = await changeImpact(adapter, schema, 'customer');
    assert.equal(impact.column, undefined);
    assert.equal(impact.columnFacts, undefined);
    assert.equal(impact.referencedBy.length, 1);
  });
});

describe('asking about something that is not there', () => {
  const schema = base({ tables: [table('customer', [{ name: 'id', primaryKey: true }])] });

  test('an unknown table says so', async () => {
    await assert.rejects(() => changeImpact(counter({ customer: 1 }), schema, 'custmoer'), /No table called "custmoer"/);
  });

  test('an unknown column names the ones that exist', async () => {
    await assert.rejects(
      () => changeImpact(counter({ customer: 1 }), schema, 'customer', 'emial'),
      /"emial" is not a column on customer. It has: id\./,
    );
  });
});
