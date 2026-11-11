/** The App API's event feed (`…/$events`) and the read audit (`audit: { reads: true }`): a page of events says which
 * records they are about, so a page holding events about an audited resource is a read of those records and is written
 * before the page leaves. Through the real CLI over SQLite, as app-api-writes-events.test.ts. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { provisionSqliteApiTokenStore } from '../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js';
import { issueSqliteApiCommandToken } from '../packages/mistri/src/server/auth/sqliteApiTokenMaintenance.js';
import { captureAuthStoreExclusion } from '../packages/mistri/src/server/auth/authStoreSeparation.js';
import { readSqliteReadAudit } from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import { SESSION_SECRET, serveApi } from './appApiCli.js';
import { SHOP_TABLES, writeShopApp } from './appApiShop.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { shape, int } from '../packages/mistri/src/server/commands/commandShapes.js';
import { apiOwnerFixture, bodyOf, commandOwner, readOwner } from './support/apiOwnerFixture.js';

const storeId = '6c2e1d63-8d2f-4d66-8f1b-5b4f4f1d3e23';

/** The shop, its `ticket` auditing its reads and its `vault` not, with the auditor's tokens (all events; the vault's only). */
async function shop(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tw-api-feed-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db'),
    authPath = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(SHOP_TABLES);
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(business);
  await provisionStores({ sqlite: business }, { app: { id: 'shop', source: 'business' } });
  await provisionStores({ sqlite: business }, { only: ['read-audit'] });
  const { appDir, config, commands } = writeShopApp(directory, { business, authStore: authPath, audited: ['ticket'] });
  const loaded = await loadApp(appDir);
  writeFileSync(join(appDir, 'authority.lock'), loaded.authority!.report);
  const saved = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = SESSION_SECRET;
  try {
    (await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] })).close();
  } finally {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  }
  const accounts = new DatabaseSync(authPath);
  try {
    accounts
      .prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,1,?,?,?,0)')
      .run('auditor', 'auditor', 'auditor@example.test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'auditor');
  } finally {
    accounts.close();
  }
  const exclusions = [captureAuthStoreExclusion(business)];
  provisionSqliteApiTokenStore(authPath, { appId: 'shop', storeId, exclusions });
  const registry = new Registry();
  registry.add({ id: 'data', name: 'data', url: business, writable: true, source: 'config' });
  const tokens: Record<string, string> = {};
  try {
    const resources = await loadAppRuntimeResources(registry, loaded.app, 'data');
    const evidence = { connectionFor: resources.connectionFor, writableConnection: () => true, transactionalConnection: () => true };
    const declared = await loadBusinessCommands(commands);
    const issue = (operations?: readonly string[]) =>
      issueSqliteApiCommandToken(
        authPath,
        loaded.app,
        resources.schema,
        declared,
        evidence,
        {
          storeId,
          exclusions,
          subjectId: 'auditor',
          actorId: 'auditor',
          roles: ['auditor'],
          label: 'auditor',
          expiresAt: Date.now() + 600000,
          ...(operations ? { operations } : {}),
        },
        Date.now(),
      ).token;
    tokens.auditor = issue();
    tokens.vaultOnly = issue(['event:vault.flagged']);
  } finally {
    await registry.closeAll();
  }
  const audited = () => {
    const check = new DatabaseSync(business, { readOnly: true });
    try {
      return readSqliteReadAudit(check, { app: 'shop', limit: 100 }).filter((row) => row.query === '"$events"');
    } finally {
      check.close();
    }
  };
  return { config, appDir, commands, tokens, business, audited };
}

const json = { 'content-type': 'application/json' };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** The auditor's three commands, which put events in the feed: two renames of ticket 1 and a flag of vault 1. */
async function emit(base: string, token: string) {
  const run = async (path: string, key: string, body: object) => {
    const prepared = await fetch(`${base}/${path}/prepare`, { headers: auth(token) });
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const response = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { ...auth(token), ...json, 'if-match': prepared.headers.get('etag')!, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
  };
  await run('ticket/1/commands/rename/v1', 'rename-attempt-00000001', { name: 'Uno' });
  await run('vault/1/commands/flag/v1', 'flag-attempt-000000001', {});
  await run('ticket/1/commands/rename/v1', 'rename-attempt-00000002', { name: 'Eins' });
}

test(
  'a feed page with events about an audited resource writes one row for it before it leaves; events about an unaudited one write none',
  { timeout: 120000 },
  async (t) => {
    const f = await shop(t);
    const s = await serveApi(t, f, 'shop');
    await s.started;
    await emit(s.base, f.tokens.auditor);

    // Only the vault's events: nothing audited is in the page, so nothing is written.
    const vault = await fetch(`${s.base}/$events`, { headers: auth(f.tokens.vaultOnly) });
    assert.equal(vault.status, 200);
    assert.deepEqual(
      ((await vault.json()) as { items: Array<{ resource: string }> }).items.map((item) => item.resource),
      ['vault'],
    );
    assert.deepEqual(f.audited(), []);

    // Every event: ticket's two (about one record) and the vault's one. One row, for the ticket, once.
    const all = await fetch(`${s.base}/$events`, { headers: auth(f.tokens.auditor) });
    assert.equal(all.status, 200);
    assert.equal(((await all.json()) as { items: unknown[] }).items.length, 3);
    const rows = f.audited();
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0].resource, 'ticket');
    assert.equal(rows[0].route, 'api');
    assert.match(rows[0].actor, /^api-token:/);
    assert.equal(rows[0].count, 1, 'a record is read once however many of its events the page holds');
    assert.deepEqual(JSON.parse(rows[0].ids!), ['1']);
    assert.equal(rows[0].record, undefined);
    assert.ok(!JSON.stringify(rows[0]).includes('Uno'), 'no payload value is stored');
    s.child.kill('SIGTERM');
    assert.equal(await s.closed, 0);
  },
);

test('a feed page whose row cannot be written answers 503 and carries no event', { timeout: 120000 }, async (t) => {
  const f = await shop(t);
  const s = await serveApi(t, f, 'shop');
  await s.started;
  await emit(s.base, f.tokens.auditor);
  /* The store gone, as a lost table would leave it: the audited events are refused, with none of them in the body.
     (A store that is wrong refuses the whole App's reads, so what refuses only this write is held in readAudit's
     own test: a sink that fails makes the page ReadAuditFailed, which this owner answers as it answers every audited read.) */
  const db = new DatabaseSync(f.business);
  db.exec('DROP TABLE "__mistri_read_audit_row"');
  db.close();
  const refused = await fetch(`${s.base}/$events`, { headers: auth(f.tokens.auditor) });
  const text = await refused.text();
  assert.equal(refused.status, 503, text);
  assert.ok(!text.includes('ticket') && !text.includes('Uno') && !text.includes('renamed'), 'no audited data in the body');
  s.child.kill('SIGTERM');
  assert.equal(await s.closed, 0);
});

test("a feed page's row goes to the database that holds the audited resource, not to the feed's lane", { timeout: 120000 }, async (t) => {
  // The feed's lane is the first exposed operation's connection (`ledger`); the audited, event-emitting resource is on `stock`.
  const restocked = defineEvent('item.restocked', shape({ id: int() }));
  const f = await apiOwnerFixture(t, {
    engine: 'sqlite',
    app: (store) => ({
      id: 'twobooks',
      name: 'Two books',
      sources: { ledger: { connection: 'ledger', default: true }, stock: { connection: 'stock' } },
      resources: { customer: {}, 'stock.item': { access: 'write', audit: { reads: true } } },
      views: { customers: { kind: 'list', from: 'customer', sort: 'id asc' } },
      home: 'customers',
      auth: { store, roles: { clerk: { read: true, commands: ['restock'] } } },
      api: {
        version: 1,
        roles: ['clerk'],
        resources: {
          customer: { fields: ['id', 'name'], sorts: ['id'] },
          'stock.item': { fields: ['id', 'sku', 'qty'], sorts: ['id'] },
        },
        commands: [{ id: 'restock', version: 1, target: 'stock.item', input: {} }],
        events: ['item.restocked'],
      },
    }),
    connections: {
      ledger: {
        sql: "CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO customer VALUES (1,'Acme');",
        writable: true,
        journal: true,
      },
      stock: {
        sql: "CREATE TABLE item(id INTEGER PRIMARY KEY, sku TEXT NOT NULL, qty INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0); INSERT INTO item(id,sku,qty) VALUES (1,'LNT-01',5);",
        writable: true,
        events: { sourceId: 'stock' },
        // Only the audited resource's database holds a read audit store; `ledger` has none.
        readAudit: true,
      },
    },
    commands: defineCommands({
      restock: defineCommand({
        source: 'stock',
        target: 'item',
        input: {},
        output: shape({ id: int() }),
        events: { restocked: defineEventProjection(restocked, (output: { id: number }) => ({ id: output.id })) },
        async handle(context) {
          const id = Number(context.record.id);
          await context.tx.update({ table: 'item', key: { id }, values: { qty: Number(context.record.qty) + 10, version: 1 } });
          return { id };
        },
      }),
    }),
    events: { sourceId: 'stock' },
    accounts: { clerk: 'clerk' },
  });
  const clerk = await f.issue('clerk', ['clerk']);
  const owner = await commandOwner(f, 'sqlite', 'number');
  const applied = await owner.execute(clerk, {
    command: 'restock',
    commandVersion: 1,
    key: { id: 1 },
    input: {},
    idempotencyKey: 'feed-audit-attempt-0001',
    expectedVersion: 0,
  });
  assert.equal((applied as { status: number }).status, 200, bodyOf(applied));

  const reads = await readOwner(f, 'sqlite', 'number');
  const page = await reads.events(clerk, '');
  assert.equal((page as { status: number }).status, 200, JSON.stringify(page));
  assert.deepEqual(
    (JSON.parse(bodyOf(page)) as { items: Array<{ resource: string }> }).items.map((item) => item.resource),
    ['stock.item'],
  );

  const rowsOf = (url: string) => {
    const db = new DatabaseSync(url, { readOnly: true });
    try {
      return readSqliteReadAudit(db, { app: 'twobooks', limit: 100 });
    } finally {
      db.close();
    }
  };
  const all = rowsOf(f.urls.stock);
  // The restock above read its target under the command (route `command`), in this same database; the feed page's own line is the one `api`.
  assert.deepEqual(
    all.filter((row) => row.route !== 'api').map((row) => row.route),
    ['command'],
    JSON.stringify(all),
  );
  const rows = all.filter((row) => row.route === 'api');
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.match(rows[0].actor, /^api-token:/);
  assert.equal(rows[0].query, '"$events"');
  assert.throws(() => rowsOf(f.urls.ledger), 'the feed lane has no read audit store, and no row was written there');
});
