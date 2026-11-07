/**
 * A row policy's `db.<table>.where` asks `any`/`no` over the tables the App declares (policyDb.ts): the same handle a
 * command's `db` is, over the App's own adapters, reading across every principal. A policy that must look a person up
 * through the rows that point at theirs decides on the answer: one case allowed, one refused.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { acquireAppPolicyResources } from '../packages/mistri/src/server/policy/appPolicyResources.js';
import { createPolicyDb } from '../packages/mistri/src/server/policy/policyDb.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

async function fixture(t: TestContext, resources: string[] = ['customer', 'loan']) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-any-policy-'));
  const file = join(directory, 'lending.db');
  const seed = new DatabaseSync(file);
  const registry = new Registry();
  t.after(async () => {
    await registry.closeAll();
    seed.close();
    rmSync(directory, { recursive: true, force: true });
  });
  seed.exec(`
    CREATE TABLE customer(id INTEGER PRIMARY KEY, account_id TEXT, email TEXT);
    CREATE TABLE loan(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customer(id), dealer_id TEXT);
    CREATE TABLE secret(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customer(id), note TEXT);
    INSERT INTO customer VALUES (1, 'borrower', 'a@example.com'), (2, 'other', 'b@example.com'), (3, 'no-loans', 'c@example.com');
    INSERT INTO loan VALUES (1, 1, 'liberty'), (2, 1, 'scranton'), (3, 2, 'other');
    INSERT INTO secret VALUES (1, 3, 'x');
  `);
  registry.add({ id: 'lending', name: 'Lending', url: file, source: 'config', writable: false });
  const app = parseAppConfig(
    {
      id: 'policy-any',
      name: 'Policy any',
      sources: { lending: { connection: 'lending', default: true } },
      resources: Object.fromEntries(resources.map((table) => [table, {}])),
      auth: { providers: ['email'], roles: { reader: { read: true, write: false } } },
      views: { customers: { kind: 'list', from: 'customer', label: 'Customers' } },
      home: 'customers',
      nav: ['customers'],
    },
    'Policy any fixture',
  );
  const acquired = await acquireAppPolicyResources(registry, app);
  t.after(() => acquired.release());
  return { db: createPolicyDb(acquired.resources) };
}

/** A policy as an App writes one: the person's loans are theirs only if they have one with the dealer they work for. */
async function policy(db: Awaited<ReturnType<typeof fixture>>['db'], account: string, dealer: string): Promise<RowScope> {
  const customer = await db.customer.where({ account_id: account }).first();
  if (!customer) return { loan: false };
  const dealt = await db.customer.count(`id = ${customer.id} and any loan where dealer_id = "${dealer}"`);
  return dealt ? { loan: { groups: [[{ column: 'customer_id', op: '=', value: customer.id as number }]] } } : { loan: false };
}

test('a policy decides on an any over the declared resources: one allowed, one refused', async (t) => {
  const { db } = await fixture(t);
  assert.deepEqual(await policy(db, 'borrower', 'liberty'), { loan: { groups: [[{ column: 'customer_id', op: '=', value: 1 }]] } });
  assert.deepEqual(await policy(db, 'borrower', 'nowhere'), { loan: false });
  assert.deepEqual(await policy(db, 'other', 'liberty'), { loan: false });
  // `no` is the same rows asked the other way.
  assert.deepEqual(
    (await db.customer.where('no loan')).map((row) => row.id),
    [3],
  );
  assert.deepEqual(
    (await db.customer.where('any loan where dealer_id = "other"')).map((row) => row.id),
    [2],
  );
});

test("a policy's any is bounded by the tables its db reads, as its handles are", async (t) => {
  const { db } = await fixture(t, ['customer']);
  // The policy's db reads the connection's tables (policyDb.ts), so a table of the database is a child it may ask about.
  assert.deepEqual(
    (await db.customer.where('any secret')).map((row) => row.id),
    [3],
  );
  assert.deepEqual(
    (await db.customer.where('no secret')).map((row) => row.id),
    [1, 2],
  );
  // A table it does not read is no child, whatever the database holds.
  await assert.rejects(
    async () => db.customer.where('any ghost'),
    /"any ghost" asks about ghost, which is not among the tables this handle reads \(customer, loan, secret\)/,
  );
});

test("a policy's reference path is still refused", async (t) => {
  const { db } = await fixture(t);
  await assert.rejects(async () => db.loan.where('customer_id.email = "a@example.com"'), /path|not a column/);
  await assert.rejects(async () => db.customer.where('any loan where customer_id.email = "a@example.com"'), /path|only/);
});
