/**
 * The order rows have to arrive in, and leave in.
 *
 * Every foreign key is a statement about time, and this is that statement
 * read back. What matters here is not the sort — a topological sort is a
 * known thing — but what it says about the cases a plain sort drops on the
 * floor: cycles, self-references, and references out of the set it was asked
 * about. Each of those is a real schema and a wrong answer would be silent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { insertOrder } from '../packages/engine/src/shared/order.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const table = (name: string, columns: Array<Record<string, unknown>> = []) =>
  ({
    name,
    schema: '',
    id: name,
    isView: false,
    columns: columns.map((c) => ({ nullable: true, primaryKey: false, type: 'integer', ...c })),
  }) as never;

const fk = (from: string, columns: string[], to: string) => ({
  name: `${from}_${columns.join('_')}`,
  from: { table: from, columns },
  to: { table: to, columns: ['id'] },
});

const chain = (): DatabaseSchema => ({
  label: 'test',
  dialect: 'sqlite',
  readAt: '2026-08-23T00:00:00.000Z',
  tables: [
    table('country', [{ name: 'code', primaryKey: true, type: 'text' }]),
    table('customer', [
      { name: 'id', primaryKey: true },
      { name: 'country_code', type: 'text' },
    ]),
    table('invoice', [
      { name: 'id', primaryKey: true },
      { name: 'customer_id', nullable: false },
    ]),
    table('invoice_line', [
      { name: 'id', primaryKey: true },
      { name: 'invoice_id', nullable: false },
    ]),
  ],
  foreignKeys: [
    fk('customer', ['country_code'], 'country'),
    fk('invoice', ['customer_id'], 'customer'),
    fk('invoice_line', ['invoice_id'], 'invoice'),
  ],
});

describe('a plain chain of references', () => {
  const plan = insertOrder(chain());

  test('inserts parents first and tears down children first', () => {
    assert.deepEqual(plan.insert, ['country', 'customer', 'invoice', 'invoice_line']);
    assert.deepEqual(plan.remove, ['invoice_line', 'invoice', 'customer', 'country']);
  });

  test('says what each table needs, and whether it can wait', () => {
    assert.deepEqual(plan.requires.invoice, [{ table: 'customer', via: ['customer_id'], optional: false }]);
    /* A nullable reference is a requirement you can postpone — insert now,
       update later — which is the only way out of a cycle. */
    assert.deepEqual(plan.requires.customer, [{ table: 'country', via: ['country_code'], optional: true }]);
  });

  test('has no cycles to report, and says that by saying nothing', () => {
    assert.deepEqual(plan.cycles, []);
    assert.deepEqual(plan.selfReferencing, []);
  });
});

describe('the cases a plain sort drops', () => {
  test('a cycle is named rather than broken arbitrarily', () => {
    const schema = chain();
    schema.tables.push(table('a', [{ name: 'id', primaryKey: true }, { name: 'b_id' }]));
    schema.tables.push(table('b', [{ name: 'id', primaryKey: true }, { name: 'a_id' }]));
    schema.foreignKeys.push(fk('a', ['b_id'], 'b'), fk('b', ['a_id'], 'a'));

    const plan = insertOrder(schema);
    assert.deepEqual(plan.cycles, [['a', 'b']]);
    /* And everything orderable is still ordered: one knot must not cost the
       answer for the rest of the schema. */
    assert.deepEqual(plan.insert, ['country', 'customer', 'invoice', 'invoice_line']);
    /* The way through is in `requires`: both edges are nullable, so either
       row can be inserted first and updated after. */
    assert.equal(plan.requires.a?.[0].optional, true);
  });

  test('a table pointing at itself is an order inside it, not a cycle', () => {
    const schema = chain();
    schema.tables.push(table('node', [{ name: 'id', primaryKey: true }, { name: 'parent_id' }]));
    schema.foreignKeys.push(fk('node', ['parent_id'], 'node'));

    const plan = insertOrder(schema);
    assert.deepEqual(plan.selfReferencing, ['node']);
    assert.deepEqual(plan.cycles, []);
    assert.ok(plan.insert.includes('node'), 'and it is still orderable against everything else');
  });

  test('a reference out of the asked-about set is a requirement, not an edge', () => {
    /* Asked about `invoice` alone: it still needs a customer, and saying so
       is the whole point — but `customer` is not in the plan, because the
       caller did not ask for it. */
    const plan = insertOrder(chain(), ['invoice']);
    assert.deepEqual(plan.insert, ['invoice']);
    assert.deepEqual(plan.requires.invoice, [{ table: 'customer', via: ['customer_id'], optional: false }]);
  });

  test('two references to the same table count once as an edge', () => {
    const schema = chain();
    schema.tables.push(table('ticket', [{ name: 'id', primaryKey: true }, { name: 'raised_by' }, { name: 'closed_by' }]));
    schema.tables.push(table('person', [{ name: 'id', primaryKey: true }]));
    schema.foreignKeys.push(fk('ticket', ['raised_by'], 'person'), fk('ticket', ['closed_by'], 'person'));

    const plan = insertOrder(schema);
    assert.ok(plan.insert.indexOf('person') < plan.insert.indexOf('ticket'));
    assert.equal(plan.requires.ticket?.length, 2, 'both are still reported');
  });

  test('the answer does not depend on the order the catalog listed things in', () => {
    const forward = insertOrder(chain());
    const shuffled = chain();
    shuffled.tables.reverse();
    shuffled.foreignKeys.reverse();
    assert.deepEqual(insertOrder(shuffled).insert, forward.insert);
  });
});
