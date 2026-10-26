import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import dealerPolicy from '../test/fixtures/apps/keystone/dealer/policy.ts';
import customerPolicy from '../test/fixtures/apps/keystone/customer/policy.ts';
import { Registry } from '../packages/engine/src/server/connections.js';
import { acquireAppPolicyResources } from '../packages/mistri/src/server/policy/appPolicyResources.js';
import { createPolicyDb } from '../packages/mistri/src/server/policy/policyDb.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-keystone-policy-'));
  const file = join(directory, 'keystone.db');
  const seed = new DatabaseSync(file);
  const registry = new Registry();
  t.after(async () => {
    await registry.closeAll();
    seed.close();
    rmSync(directory, { recursive: true, force: true });
  });
  seed.exec(`
    CREATE TABLE dealer_user(id TEXT PRIMARY KEY, dealer_id TEXT, dealer_account_id TEXT, email TEXT, status TEXT, role TEXT);
    CREATE TABLE dealer(id TEXT PRIMARY KEY, relationship_manager_id INTEGER);
    CREATE TABLE dealer_visit(id INTEGER PRIMARY KEY, dealer_id TEXT, lender_user_id INTEGER);
    CREATE TABLE customer(id INTEGER PRIMARY KEY, account_id TEXT, email TEXT);
    CREATE TABLE loan(id INTEGER PRIMARY KEY, customer_id INTEGER, dealer_id TEXT);
    INSERT INTO dealer VALUES ('liberty', 10), ('scranton', 20), ('other', 90), ('unlinked', 80), ('alone', NULL);
    INSERT INTO dealer_user VALUES
      (1, 'liberty', 'owner', 'carlos@example.com', 'active', 'owner'),
      (2, 'liberty', 'owner', 'old@example.com', 'active', 'sales_manager'),
      (3, 'scranton', 'owner', 'changed@example.com', 'active', 'sales_manager'),
      (4, 'other', 'other-owner', 'carlos@example.com', 'active', 'owner'),
      (5, 'unlinked', NULL, 'carlos@example.com', 'active', 'owner'),
      (6, 'other', 'owner', 'carlos@example.com', 'inactive', 'owner'),
      (7, 'other', 'owner', 'carlos@example.com', 'active', 'salesperson'),
      (8, 'liberty', 'sales-manager', 'andrew@example.com', 'active', 'sales_manager'),
      (9, 'alone', 'alone-owner', 'alone@example.com', 'active', 'owner');
    INSERT INTO dealer_visit VALUES
      (1, 'liberty', 10), (2, 'liberty', 30), (3, 'scranton', 30), (4, 'other', 90), (5, 'unlinked', 80);
    INSERT INTO customer VALUES
      (1, 'borrower', 'sarah@example.com'), (2, 'other-borrower', 'sarah@example.com'),
      (3, NULL, 'sarah@example.com'), (4, 'ambiguous', 'one@example.com'),
      (5, 'ambiguous', 'two@example.com'), (6, 'no-loans', 'none@example.com');
    INSERT INTO loan VALUES
      (1, 1, 'liberty'), (2, 1, 'liberty'), (3, 1, 'scranton'), (4, 2, 'other'), (5, 3, 'unlinked');
  `);
  registry.add({ id: 'keystone', name: 'Keystone', url: file, source: 'config', writable: false });
  const app = parseAppConfig(
    {
      id: 'policy-test',
      name: 'Policy test',
      sources: { lending: { connection: 'keystone', default: true } },
      resources: Object.fromEntries(['dealer_user', 'dealer', 'dealer_visit', 'customer', 'loan'].map((table) => [table, {}])),
      auth: { providers: ['email'], roles: { reader: { read: true, write: false } } },
      views: { dealers: { kind: 'list', from: 'dealer', label: 'Dealers' } },
      home: 'dealers',
      nav: ['dealers'],
    },
    'Keystone policy fixture',
  );
  const acquired = await acquireAppPolicyResources(registry, app);
  t.after(() => acquired.release());
  const context = { db: createPolicyDb(acquired.resources) };
  assert.equal('insert' in context.db.dealer_user, false);
  assert.equal('update' in context.db.customer, false);
  return { context, seed };
}

const manager = (id = 'owner', email = 'carlos@example.com', roles = ['manager']) => ({ id, email, roles, appId: 'dealer' });
const borrower = (id = 'borrower', email = 'sarah@example.com', roles = ['borrower']) => ({ id, email, roles, appId: 'customer' });
const oneOf = (column: string, value: (string | number)[]) => ({ groups: [[{ column, op: 'in', value }]] });
const equal = (column: string, value: string | number) => ({ groups: [[{ column, op: '=', value }]] });
function denied(scope: RowScope, tables: string[]) {
  assert.deepEqual(scope, Object.fromEntries(tables.map((table) => [table, false])));
}
const dealerTables = ['dealer', 'dealer_site', 'dealer_user', 'vehicle', 'vehicle_photo', 'lead', 'dealer_visit', 'lender_user', 'program'];
const customerTables = ['customer', 'loan', 'installment', 'payment', 'autopay', 'payoff_quote', 'loan_document', 'dealer'];

test('dealer owner reads only linked active management seats and their Keystone people, deduplicated', async (t) => {
  const { context } = await fixture(t);
  const own = oneOf('dealer_id', ['liberty', 'scranton']);
  assert.deepEqual(await dealerPolicy.resolveRows(manager(), context), {
    dealer: oneOf('id', ['liberty', 'scranton']),
    dealer_site: own,
    dealer_user: own,
    vehicle: own,
    vehicle_photo: own,
    lead: own,
    dealer_visit: own,
    lender_user: oneOf('id', [10, 20, 30]),
    program: true,
  });
  // Account linkage survives an email change; a verified email never selects more seats.
  assert.deepEqual(
    await dealerPolicy.resolveRows(manager('owner', 'changed@example.com'), context),
    await dealerPolicy.resolveRows(manager(), context),
  );
  const other = await dealerPolicy.resolveRows(manager('other-owner'), context);
  assert.deepEqual(other.dealer, oneOf('id', ['other']));
  assert.deepEqual(other.lender_user, oneOf('id', [90]));
});

test('dealer sales manager is eligible; a dealership without Keystone people grants no lender rows', async (t) => {
  const { context } = await fixture(t);
  const sales = await dealerPolicy.resolveRows(manager('sales-manager'), context);
  assert.deepEqual(sales.dealer, oneOf('id', ['liberty']));
  assert.deepEqual(sales.lender_user, oneOf('id', [10, 30]));
  const alone = await dealerPolicy.resolveRows(manager('alone-owner'), context);
  assert.deepEqual(alone.dealer, oneOf('id', ['alone']));
  assert.equal(alone.lender_user, false);
});

test('matching dealer email, case-changed account id, inactive seats and non-management seats grant nothing', async (t) => {
  const { context, seed } = await fixture(t);
  for (const id of ['unlinked-account', 'OWNER']) {
    denied(await dealerPolicy.resolveRows(manager(id), context), dealerTables);
  }
  seed.exec("UPDATE dealer_user SET status = 'inactive' WHERE dealer_account_id = 'owner' AND role IN ('owner', 'sales_manager')");
  denied(await dealerPolicy.resolveRows(manager(), context), dealerTables);
});

test('customer borrower reads only their linked customer, loan rows and distinct selling dealers', async (t) => {
  const { context } = await fixture(t);
  const own = equal('customer_id', 1);
  assert.deepEqual(await customerPolicy.resolveRows(borrower(), context), {
    customer: equal('id', 1),
    loan: own,
    installment: own,
    payment: own,
    autopay: own,
    payoff_quote: own,
    loan_document: own,
    dealer: { groups: [[{ column: 'id', op: '=', value: 'liberty' }], [{ column: 'id', op: '=', value: 'scranton' }]] },
  });
  assert.deepEqual(
    await customerPolicy.resolveRows(borrower('borrower', 'changed@example.com'), context),
    await customerPolicy.resolveRows(borrower(), context),
  );
  const other = await customerPolicy.resolveRows(borrower('other-borrower'), context);
  assert.deepEqual(other.customer, equal('id', 2));
  assert.deepEqual(other.dealer, equal('id', 'other'));
  const noLoans = await customerPolicy.resolveRows(borrower('no-loans'), context);
  assert.deepEqual(noLoans.customer, equal('id', 6));
  assert.equal(noLoans.dealer, false);
});

test('customer email matches, case-changed account ids and ambiguous bindings grant nothing', async (t) => {
  const { context } = await fixture(t);
  for (const id of ['unlinked-account', 'BORROWER', 'ambiguous']) {
    denied(await customerPolicy.resolveRows(borrower(id), context), customerTables);
  }
});

test('linked owners and borrowers still need their App role, including support and servicing staff', async (t) => {
  const { context } = await fixture(t);
  for (const roles of [[], ['support'], ['servicing'], ['admin']]) {
    denied(await dealerPolicy.resolveRows(manager('owner', 'carlos@example.com', roles), context), dealerTables);
    denied(await customerPolicy.resolveRows(borrower('borrower', 'sarah@example.com', roles), context), customerTables);
  }
});

test('policies use each supplied App connection regardless of the process database environment', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  second.seed.exec('UPDATE dealer_user SET dealer_account_id = NULL; UPDATE customer SET account_id = NULL;');
  const original = process.env.KEYSTONE_DATABASE_URL;
  t.after(() => {
    if (original === undefined) delete process.env.KEYSTONE_DATABASE_URL;
    else process.env.KEYSTONE_DATABASE_URL = original;
  });
  for (const url of [undefined, 'postgres://invalid:invalid@127.0.0.1:1/not-the-app']) {
    if (url === undefined) delete process.env.KEYSTONE_DATABASE_URL;
    else process.env.KEYSTONE_DATABASE_URL = url;
    assert.deepEqual((await dealerPolicy.resolveRows(manager(), first.context)).dealer, oneOf('id', ['liberty', 'scranton']));
    assert.deepEqual((await customerPolicy.resolveRows(borrower(), first.context)).customer, equal('id', 1));
    denied(await dealerPolicy.resolveRows(manager(), second.context), dealerTables);
    denied(await customerPolicy.resolveRows(borrower(), second.context), customerTables);
  }
});

test('dealer pagination exhausts seats, dealerships and visits, including associations after row 1000', async (t) => {
  const { context, seed } = await fixture(t);
  seed.exec(`
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1001)
    INSERT INTO dealer SELECT printf('paged-%04d', x), CASE WHEN x = 1001 THEN 71 ELSE 10 END FROM n;
    INSERT INTO dealer_user
      SELECT 'seat-' || id, id, 'paged-owner', 'paged@example.com', 'active', 'owner' FROM dealer WHERE id LIKE 'paged-%';
    INSERT INTO dealer_user VALUES ('zz-duplicate', 'paged-1001', 'paged-owner', 'paged@example.com', 'active', 'sales_manager');
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1001)
    INSERT INTO dealer_visit SELECT 100 + x, 'paged-0001', CASE WHEN x = 1001 THEN 72 ELSE 10 END FROM n;
    INSERT INTO dealer_visit VALUES (2000, 'paged-0001', 72), (2001, 'other', 99);
  `);
  const dealers = Array.from({ length: 1001 }, (_, index) => `paged-${String(index + 1).padStart(4, '0')}`);
  const scope = await dealerPolicy.resolveRows(manager('paged-owner'), context);
  assert.deepEqual(scope.dealer, oneOf('id', dealers));
  assert.deepEqual(scope.dealer_user, oneOf('dealer_id', dealers));
  assert.deepEqual(scope.dealer_visit, oneOf('dealer_id', dealers));
  assert.deepEqual(scope.lender_user, oneOf('id', [10, 71, 72]));
});

test('customer pagination includes selling dealers found only after loan 1000 and deduplicates across pages', async (t) => {
  const { context, seed } = await fixture(t);
  seed.exec(`
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1001)
    INSERT INTO loan SELECT 100 + x, 1, CASE WHEN x = 1001 THEN 'late-dealer' ELSE 'liberty' END FROM n;
    INSERT INTO loan VALUES (2000, 1, 'late-dealer'), (2001, 2, 'other');
  `);
  const scope = await customerPolicy.resolveRows(borrower(), context);
  assert.deepEqual(scope.customer, equal('id', 1));
  assert.deepEqual(scope.loan, equal('customer_id', 1));
  assert.deepEqual(scope.dealer, {
    groups: ['liberty', 'scranton', 'late-dealer'].map((id) => [{ column: 'id', op: '=', value: id }]),
  });
});

test('dealer pagination treats quoted account, dealer and cursor IDs as literal values', async (t) => {
  const { context, seed } = await fixture(t);
  const account = 'owner"\\ or status = "inactive';
  const dealer = 'dealer"\\, other';
  seed.prepare('INSERT INTO dealer VALUES (?, 41)').run(dealer);
  const insert = seed.prepare('INSERT INTO dealer_user VALUES (?, ?, ?, ?, ?, ?)');
  seed.exec('BEGIN');
  for (let index = 0; index < 1001; index++) {
    insert.run(`seat"\\-${String(index).padStart(4, '0')}`, dealer, account, 'quoted@example.com', 'active', 'owner');
  }
  seed.exec('COMMIT');
  seed.prepare('INSERT INTO dealer_visit VALUES (100, ?, 42)').run(dealer);
  const scope = await dealerPolicy.resolveRows(manager(account), context);
  assert.deepEqual(scope.dealer, oneOf('id', [dealer]));
  assert.deepEqual(scope.lender_user, oneOf('id', [41, 42]));
});

test('malformed text pagination keys refuse rather than returning a partial scope or looping', async (t) => {
  const { context, seed } = await fixture(t);
  seed.exec("INSERT INTO dealer_user VALUES (NULL, 'liberty', 'owner', 'carlos@example.com', 'active', 'owner')");
  await assert.rejects(async () => dealerPolicy.resolveRows(manager(), context), /invalid or repeated primary key/);
});
