/**
 * A New form's value taken from a referenced record
 * (`defaults: { labor_charge: { from: 'service_id.price' } }`): read apart
 * from the literals as `derived`, refused where the path does not lead to a
 * column of the same kind, and filled by the server where a create leaves it
 * out. The browser's refresh is NewRecordDress.test.tsx's.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { compileAppDefinitionValidation } from '../packages/mistri/src/server/app/appValidation.js';
import { parseAppConfig, resolveResources, type AppDef } from '../packages/mistri/src/shared/app.js';

const app = (defaults: Record<string, unknown>) =>
  parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      connection: 'shop',
      resources: { work_order: { access: 'write', form: { defaults } }, service: {} },
      views: { orders: { kind: 'list', from: 'work_order' } },
      home: 'orders',
    },
    'shop',
  ) as AppDef;

async function catalog(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-form-derived-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL);
    CREATE TABLE work_order (id INTEGER PRIMARY KEY, summary TEXT NOT NULL, service_id INTEGER REFERENCES service(id),
      labor_charge INTEGER, note TEXT);
    INSERT INTO service VALUES (1, 'Tune-up', 8500), (2, 'Overhaul', 22000);`);
  db.close();
  const adapter = new SqliteAdapter(file, 'shop');
  t.after(() => adapter.close());
  const check = new DatabaseSync(file);
  t.after(() => check.close());
  return { adapter, schema: await adapter.introspect(), check };
}

test('a value from a referenced record is read apart from the literals, and its path is checked', async (t) => {
  const { schema } = await catalog(t);
  const parsed = app({ labor_charge: { from: 'service_id.price' }, note: 'Walk-in' });
  assert.deepEqual(parsed.resources!.work_order.form, { defaults: { note: 'Walk-in' }, derived: { labor_charge: 'service_id.price' } });
  assert.deepEqual(resolveResources(parsed, schema).problems, []);
  const problem = (path: string) => resolveResources(app({ labor_charge: { from: path } }), schema).problems[0] ?? '';
  assert.match(problem('summary.price'), /"summary" is no reference/);
  assert.match(problem('service_id.cost'), /service has no column "cost"/);
  assert.match(problem('service_id.name'), /which is TEXT; "labor_charge" is INTEGER/);
  assert.throws(() => app({ labor_charge: { from: 'price' } }), /\{ from: 'reference.column' \}/);
  assert.throws(() => app({ labor_charge: { from: 'service_id.price', auto: 'now' } }), /nothing beside it/);
  assert.throws(
    () =>
      parseAppConfig(
        {
          id: 'shop',
          name: 'Shop',
          connection: 'shop',
          resources: { work_order: { form: { derived: { labor_charge: 'service_id.price' } } } },
          views: {},
        },
        'shop',
      ),
    /derived.*said in defaults/s,
  );
});

test('a create that leaves the value out takes it from the referenced record; one that says it keeps its own', async (t) => {
  const { adapter, schema, check } = await catalog(t);
  const parsed = app({ labor_charge: { from: 'service_id.price' } });
  const access = {
    readable: new Set(['work_order', 'service']),
    writable: new Set(['work_order']),
    validation: compileAppDefinitionValidation(schema, parsed),
  };
  const insert = (values: Record<string, string | number | null>) =>
    adapter.transaction!((tx) => authorizeTransaction(schema, access, tx).insert({ table: 'work_order', values }));
  await insert({ summary: 'Squeaky brakes', service_id: 2 });
  await insert({ summary: 'Flat', service_id: 1, labor_charge: 1500 });
  await insert({ summary: 'Look over' });
  assert.deepEqual(
    check
      .prepare('SELECT summary, labor_charge FROM work_order ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { summary: 'Squeaky brakes', labor_charge: 22000 },
      { summary: 'Flat', labor_charge: 1500 },
      // No service chosen: the database's default stands.
      { summary: 'Look over', labor_charge: null },
    ],
  );
});
