/**
 * A validation rule and a New form's value from a referenced record read a computed column as they read a stored one
 * (DM5): `must: 'total > 0'` over the record's own `total = labor_charge + parts`, `must: 'service_id.list >= labor_charge'`
 * through a reference to the service's computed `list`, and `defaults: { labor_charge: { from: 'service_id.list' } }`.
 * The figure is worked out from the row as the write's transaction sees it (computedValue.ts), as a list would show it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseAppConfig, resolveResources, resolveValidation } from '../packages/mistri/src/shared/app.js';

const clerk: Identity = { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk' };

test('validation and a form default read computed columns, the record’s own and a referenced record’s', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-validation-derived-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL);
    CREATE TABLE work_order (id INTEGER PRIMARY KEY, summary TEXT NOT NULL, service_id INTEGER REFERENCES service(id),
      labor_charge INTEGER, parts INTEGER NOT NULL DEFAULT 0, due_on DATE);
    INSERT INTO service VALUES (1, 'Tune-up', 8500), (2, 'Overhaul', 22000);`);
  const registry = new Registry();
  registry.add({ id: 'shop-db', name: 'Shop', url: file, writable: true, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'shop-db', default: true } },
      resources: {
        service: { computed: { list: { type: 'number', value: 'price * 2' } } },
        work_order: {
          access: 'write',
          computed: {
            total: { type: 'number', value: 'coalesce(labor_charge, 0) + parts' },
            // A date the clock moves: worked out with the App's today, as a list works it out.
            past: { type: 'boolean', value: 'due_on < today' },
          },
          validation: [
            { must: 'past = false', when: 'due_on is not empty', message: 'Not in the past.' },
            { must: 'total > 0', message: 'Charge something.' },
            { must: 'service_id.list >= labor_charge', message: 'No more than the list price.' },
          ],
          form: { defaults: { labor_charge: { from: 'service_id.list' } } },
        },
      },
      auth: { providers: ['email'], roles: { clerk: { read: true, write: ['work_order'] } } },
      views: { orders: { kind: 'list', from: 'work_order' } },
      home: 'orders',
      nav: ['orders'],
    },
    'shop',
  );
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => clerk },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  const insert = async (values: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}/api/insert`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': clerk.id },
      body: JSON.stringify({ app: 'shop', table: 'work_order', values }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const charge = (id: number) =>
    (db.prepare('SELECT labor_charge FROM work_order WHERE id = ?').get(id) as { labor_charge: number }).labor_charge;
  try {
    // The charge left out is the service's list price, a computed column of the service: 2 × 8500.
    const listed = await insert({ summary: 'Tune-up', service_id: 1 });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.outcome ?? 'applied', 'applied', JSON.stringify(listed.body));
    assert.equal(charge(Number(listed.body.key.id)), 17000);

    // Nothing charged: the record's own total is 0.
    const nothing = await insert({ summary: 'Look-over', service_id: 1, labor_charge: 0, parts: 0 });
    assert.equal(nothing.body.outcome, 'rejected', JSON.stringify(nothing.body));
    assert.deepEqual(nothing.body.errors[0].fields, [{ field: 'total', message: 'Charge something.' }]);

    // Over the referenced service's list price, which no column stores.
    const over = await insert({ summary: 'Tune-up', service_id: 1, labor_charge: 17001 });
    assert.equal(over.body.outcome, 'rejected', JSON.stringify(over.body));
    assert.deepEqual(over.body.errors[0].fields, [{ field: 'service_id', message: 'No more than the list price.' }]);

    const late = await insert({ summary: 'Tune-up', service_id: 1, due_on: '2001-01-01' });
    assert.equal(late.body.outcome, 'rejected', JSON.stringify(late.body));
    assert.deepEqual(late.body.errors[0].fields, [{ field: 'past', message: 'Not in the past.' }]);

    // The form asks the server for the same figure as the reference is chosen, the request formDefaults.ts derivedValue sends.
    const asked = await fetch(`http://${bound.host}:${bound.port}/api/view/run`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-mistri-account': clerk.id },
      body: JSON.stringify({
        app: 'shop',
        view: {
          id: 'derived:service',
          name: 'service',
          base: 'service',
          columns: [{ path: 'list' }],
          filter: { groups: [[{ path: 'id', op: '=', value: '2' }]] },
          limit: 1,
        },
      }),
    });
    const answer = (await asked.json()) as { rows?: Array<{ list: unknown }> };
    assert.equal(asked.status, 200, JSON.stringify(answer));
    assert.equal(Number(answer.rows?.[0]?.list), 44000);

    const within = await insert({ summary: 'Overhaul', service_id: 2, labor_charge: 44000, parts: 300, due_on: '2999-01-01' });
    assert.equal(within.status, 200, JSON.stringify(within.body));
    assert.equal(within.body.outcome ?? 'applied', 'applied', JSON.stringify(within.body));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a computed column worked out of other rows is refused, saying which, in a validation and a form’s value', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-validation-refused-'));
  const file = join(directory, 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE service (id INTEGER PRIMARY KEY, price INTEGER NOT NULL);
    CREATE TABLE work_order (id INTEGER PRIMARY KEY, service_id INTEGER REFERENCES service(id), labor_charge INTEGER, paid INTEGER);
    CREATE TABLE part (id INTEGER PRIMARY KEY, work_order_id INTEGER REFERENCES work_order(id), cost INTEGER);`);
  db.close();
  const adapter = new SqliteAdapter(file, 'shop');
  try {
    const schema = await adapter.introspect();
    const shop = (work_order: object, service: object = {}) =>
      parseAppConfig(
        {
          id: 'shop',
          name: 'Shop',
          connection: 'shop',
          resources: {
            service,
            part: {},
            work_order: {
              access: 'write',
              rollups: { spend: { fn: 'sum', from: 'part', column: 'cost' } },
              computed: { owed: { type: 'number', value: 'spend - paid' }, due: { type: 'number', value: 'owed + 0' } },
              ...work_order,
            },
          },
          views: { orders: { kind: 'list', from: 'work_order' } },
          home: 'orders',
        },
        'shop',
      );
    // Through another computed column, to the rollup it reads.
    assert.match(
      resolveValidation(shop({ validation: [{ must: 'due <= 0', message: 'Settle first.' }] }), schema).warnings[0] ?? '',
      /"due" is computed \("owed \+ 0"\) from the rollup "spend", counted from other tables' rows, which a validation cannot work out of the stored record/,
    );
    assert.deepEqual(resolveValidation(shop({ validation: [{ must: 'labor_charge >= 0', message: 'Positive.' }] }), schema).warnings, []);
    const listed = (value: string) =>
      shop(
        { form: { defaults: { labor_charge: { from: 'service_id.list' } } } },
        { rollups: { jobs: { fn: 'count', from: 'work_order' } }, computed: { list: { type: 'number', value } } },
      );
    assert.deepEqual(resolveResources(listed('price * 2'), schema).problems, []);
    assert.deepEqual(resolveResources(listed('price * jobs'), schema).problems, [
      'resources "work_order": Form: defaults "labor_charge" is from "service_id.list", computed from the rollup "jobs", ' +
        "counted from other tables' rows, which a new record cannot take from the record as stored.",
    ]);
  } finally {
    adapter.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
