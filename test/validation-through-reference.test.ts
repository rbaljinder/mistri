/**
 * A validation reading through one reference (`order_id.status`): a line is
 * judged against the record it names, read in the write's own transaction,
 * refused at the reference with the rule's sentence; the check follows the
 * path through the catalog and says what it cannot, and a parent's computed
 * column is refused as a child's own would be.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { compileAppValidation } from '../packages/mistri/src/server/app/appValidation.js';
import { AppValidationDenied } from '../packages/mistri/src/server/app/appValidationDenied.js';
import { parseAppConfig, resolveValidation } from '../packages/mistri/src/shared/app.js';
import { parseFormRules } from '../packages/mistri/src/shared/formRules.js';

const BENCH = { must: 'order_id.status = bench', message: 'Parts go on an order only while it is on the bench.' };

async function shop(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-through-reference-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE work_order (id INTEGER PRIMARY KEY, status TEXT NOT NULL, labor NUMERIC NOT NULL DEFAULT 0);
    CREATE TABLE work_order_part (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES work_order(id), quantity INTEGER NOT NULL);
    INSERT INTO work_order VALUES (1, 'bench', 0), (2, 'done', 0);`);
  db.close();
  const adapter = new SqliteAdapter(file, 'shop');
  t.after(() => adapter.close());
  return { adapter, schema: await adapter.introspect(), file };
}

test('a line is judged by the order it names, at its reference, as the transaction sees the order', async (t) => {
  const { adapter, schema, file } = await shop(t);
  const validation = compileAppValidation(schema, { work_order_part: [BENCH] });
  const access = { readable: new Set(['work_order', 'work_order_part']), writable: new Set(['work_order', 'work_order_part']), validation };
  const insert = (order: number) =>
    adapter.transaction!((tx) =>
      authorizeTransaction(schema, access, tx).insert({ table: 'work_order_part', values: { order_id: order, quantity: 1 } }),
    );
  await insert(1);
  await assert.rejects(
    () => insert(2),
    (error) =>
      error instanceof AppValidationDenied &&
      error.fields.join() === 'order_id' &&
      error.reasons.order_id === 'Parts go on an order only while it is on the bench.',
  );
  // An order put back on the bench earlier in the same write is read as it now is.
  await adapter.transaction!(async (tx) => {
    const writes = authorizeTransaction(schema, access, tx);
    await writes.update({ table: 'work_order', key: { id: 2 }, values: { status: 'bench' } });
    await writes.insert({ table: 'work_order_part', values: { order_id: 2, quantity: 3 } });
  });
  const check = new DatabaseSync(file);
  t.after(() => check.close());
  assert.deepEqual(
    check
      .prepare('SELECT order_id, quantity FROM work_order_part ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { order_id: 1, quantity: 1 },
      { order_id: 2, quantity: 3 },
    ],
  );
});

test('an empty reference reads empty, so a rule about it says what it holds', async (t) => {
  const { adapter, schema } = await shop(t);
  const validation = compileAppValidation(schema, {
    work_order_part: [{ must: 'quantity <= 2', when: 'order_id.status is not empty', message: 'At most two parts on an order.' }],
  });
  const access = { readable: new Set(['work_order_part']), writable: new Set(['work_order_part']), validation };
  const insert = (values: Record<string, number | null>) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, access, tx).insert({ table: 'work_order_part', values }));
  await insert({ order_id: null, quantity: 9 });
  await assert.rejects(
    () => insert({ order_id: 1, quantity: 9 }),
    (error) => error instanceof AppValidationDenied && error.fields.join() === 'quantity',
  );
});

test('the check follows a path through the catalog, and refuses what it cannot follow', async (t) => {
  const { schema } = await shop(t);
  const app = (rules: unknown[], computed?: Record<string, unknown>) =>
    parseAppConfig(
      {
        name: 'Shop',
        resources: { work_order: computed ? { computed } : {}, work_order_part: { access: 'write', validation: rules } },
        views: { lines: { kind: 'list', from: 'work_order_part' } },
        home: 'lines',
      },
      'app.ts',
    );
  assert.deepEqual(resolveValidation(app([BENCH]), schema).warnings, []);
  assert.deepEqual(resolveValidation(app([{ must: 'order_id.stage = bench', message: 'x' }]), schema).warnings, [
    'validation "work_order_part": Validation reads "order_id.stage": work_order has no column "stage".',
  ]);
  assert.deepEqual(resolveValidation(app([{ must: 'quantity.status = bench', message: 'x' }]), schema).warnings, [
    'validation "work_order_part": Validation reads "quantity.status": "quantity" is no reference, so it names no record to take a value from.',
  ]);
  // A computed column of the record is worked out of what it reads, as stored (validation-derived.test.ts, DM5).
  assert.deepEqual(
    resolveValidation(app([{ must: 'order_id.billable > 0', message: 'x' }], { billable: { value: 'labor * 2', type: 'number' } }), schema)
      .warnings,
    [],
  );
  assert.throws(() => parseFormRules([{ must: 'order_id.customer_id.name = Ann', message: 'x' }]), /goes past one reference/);
  // A form's own condition still reads the record's own columns.
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'Shop',
          resources: { work_order_part: { form: { when: { quantity: 'order_id.status = bench' } } } },
          views: { lines: { kind: 'list', from: 'work_order_part' } },
          home: 'lines',
        },
        'app.ts',
      ),
    /is a path/,
  );
});
