/**
 * `me` and `now` on a tenant App's writes, over the tenant HTTP host: a related list's upload, an action's `set` and a
 * New form's hidden default are stamped by the server on the tenant engine, `me` being the session account's row of
 * the tenant's own people table (`auth.me` names its account column), never a value the request carries.
 *
 * What is proved here: an upload with `parent` links to the record read on the member's lease and stamps who and when
 * whatever the body says; a body link to another record is refused (400); another tenant's record, a missing one and
 * one outside the member's own rows are no parent (404); nothing is written on a refusal. An action's `me`/`now` and a
 * New form's hidden `me`/`now` are the member's row and the clock.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { VerifiedSessionInstance } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { createTenantHttpServer } from '../packages/mistri/src/server/tenant/tenantHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseTestApp } from './support/commandCatalog.js';

type Answer = { status: number; text: string; body: any };
type Context = { tabId: string; context: string; accountId: string; tenantId: string; revision: number };
const appId = 'desk';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'desk-stamps-store' };
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
const NOTE = '2000-01-01T00:00:00.000Z';

/* Eve and Ada are north's, Sam is south's: each a person row of their own tenant, found by account id. Ada's rows
   leave out north's archived item (the policy below). A New form's `now` fills a column declared a moment
   (formDefaultWord), so filed_at is a DATETIME; a file rule's stamp is judged by its name, so uploaded_at may be TEXT. */
const TABLES = `
  CREATE TABLE person (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL,
    UNIQUE (tenant_id, account_id));
  CREATE TABLE item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
    closed_by TEXT REFERENCES person(id), closed_at TEXT, filed_by TEXT REFERENCES person(id), filed_at DATETIME);
  CREATE TABLE attachment (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES item(id),
    uploaded_by TEXT REFERENCES person(id), uploaded_at TEXT,
    file_name TEXT, content_type TEXT, byte_size INTEGER, data BLOB);
  INSERT INTO person VALUES ('north-eve', 'north', 'eve', 'Eve'), ('north-ada', 'north', 'ada', 'Ada'),
    ('south-sam', 'south', 'sam', 'Sam');
  INSERT INTO item (id, tenant_id, title, state) VALUES ('north-one', 'north', 'North one', 'open'),
    ('north-two', 'north', 'North two', 'open'), ('north-old', 'north', 'North archived', 'archived'),
    ('south-one', 'south', 'South one', 'open');`;

const me = { auto: 'me' };
const now = { auto: 'now' };
const app = parseTestApp(
  {
    id: appId,
    name: 'Desk',
    auth: {
      rows: 'tenant',
      me: { from: 'person', column: 'account_id' },
      roles: { member: { read: true, write: ['item', 'attachment'] } },
    },
    sources: { business: { connection: binding.source.connection } },
    resources: {
      person: { owner: 'tenant' },
      item: {
        owner: 'tenant',
        access: 'write',
        actions: { close: { label: 'Close', set: { state: 'closed', closed_by: me, closed_at: now } } },
        // Who filed it and when are hidden on the New form: the server's, whatever a request says.
        form: { show: ['id', 'title', 'state'], defaults: { filed_by: me, filed_at: now } },
      },
      attachment: {
        owner: 'tenant',
        access: 'write',
        file: {
          content: 'data',
          name: 'file_name',
          type: 'content_type',
          size: 'byte_size',
          stamps: { uploaded_by: 'me', uploaded_at: 'now' },
        },
      },
    },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
    nav: ['items'],
  },
  'tenant upload stamps fixture',
);

const everything: RowScope = { person: true, item: true, attachment: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId,
  storeId: binding.storeId,
  ownership: {
    person: { kind: 'tenant', column: 'tenant_id' },
    item: { kind: 'tenant', column: 'tenant_id' },
    attachment: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => everything,
  // Ada works only the open items: an archived one is outside her rows, though it is her tenant's.
  resolveRows: (principal) =>
    principal.accountId === 'ada' ? { ...everything, item: { groups: [[{ column: 'state', op: '!=', value: 'archived' }]] } } : everything,
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-upload-stamps-'));
  const path = join(directory, 'business.db'),
    db = new DatabaseSync(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; ${TABLES}`);
  provisionSqliteTenantStore(path, binding);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, operations, binding);
  for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  for (const [tenantId, accountId] of [
    ['north', 'eve'],
    ['north', 'ada'],
    ['south', 'sam'],
  ])
    await admin.putMembership({
      tenantId,
      accountId,
      membershipId: `${tenantId}-${accountId}`,
      status: 'active',
      roles: ['member'],
      validUntil: Date.now() + 3_600_000,
      expectedVersion: null,
    });
  await operations.finish();
  db.exec('COMMIT');
  /** Who the session is, per request: a case switches accounts here. */
  const as = { account: 'eve' };
  const enrollment = await createTenantEnrollment<IncomingMessage>({
    app,
    pages: [],
    policy,
    source: { ...binding.source, existingPath: path },
    deployment: 'desk-stamps-deployment',
    roles: ['member'],
    maxLifetimeMs: 300_000,
    verifySession: async () => ({ id: as.account, who: `${as.account}@example.invalid` }),
  });
  const bound = { host: '127.0.0.1', port: 0 };
  const owner = createTenantHttpServer({
    app,
    enrollment,
    bound,
    verifySessionInstance: (): VerifiedSessionInstance => ({
      identity: { id: as.account, who: `${as.account}@example.invalid` },
      sessionId: `session-${as.account}`,
      expiresAt: Date.now() + 3_600_000,
    }),
  });
  t.after(async () => {
    const stopped = new Promise<void>((resolve) => owner.server.close(() => resolve()));
    owner.server.closeAllConnections();
    await stopped;
    await owner.retire();
    await enrollment.retire();
  });
  owner.server.listen(0, bound.host);
  await once(owner.server, 'listening');
  const address = owner.server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  const select = (path: string, tenant: string) => `${path}?app=${appId}&tenant=${tenant}`;
  /** The account's lease on its tenant. */
  const open = async (account: string, tenant: string): Promise<Context> => {
    as.account = account;
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, reply.text);
    return reply.body as Context;
  };
  const data = (path: string, lease: Context, body: unknown) => {
    as.account = lease.accountId;
    return call(select(path, lease.tenantId), body, {
      'x-mistri-tab': lease.tabId,
      'x-mistri-context': lease.context,
      'x-mistri-lease-revision': String(lease.revision),
      'x-mistri-account': lease.accountId,
    });
  };
  return {
    db,
    open,
    data,
    upload: (lease: Context, id: string, extra: Record<string, unknown>) =>
      data('/api/file/upload', lease, {
        table: 'attachment',
        file: { name: 'front.png', type: 'image/png', data: bytes.toString('base64') },
        ...extra,
        values: { id, ...((extra.values as object) ?? {}) },
      }),
    // As plain objects: SQLite's rows have no prototype, which deepStrictEqual counts.
    files: () =>
      db
        .prepare('SELECT id, tenant_id, item_id, uploaded_by, uploaded_at, file_name FROM attachment ORDER BY rowid')
        .all()
        .map((row) => ({ ...row })),
    item: (id: string) => ({ ...db.prepare('SELECT * FROM item WHERE id = ?').get(id)! }),
  };
}

/* The clock's digits as a zone-less text moment holds them (the App names no zone: UTC). */
const moment = (value: unknown) => {
  assert.equal(typeof value, 'string');
  assert.match(String(value), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  const at = Date.parse(`${String(value).replace(' ', 'T')}Z`);
  assert.ok(Math.abs(Date.now() - at) < 60_000, `${value} is now`);
};

test("a related upload links to the record read on the lease and stamps the member's row and the clock", async (t) => {
  const f = await fixture(t);
  const eve = await f.open('eve', 'north');
  // No body link: the link is the addressed record's; the body's uploader and moment are not the server's.
  const sent = await f.upload(eve, 'file-a', {
    parent: { table: 'item', key: { id: 'north-one' } },
    values: { uploaded_by: 'north-ada', uploaded_at: NOTE },
  });
  assert.equal(sent.status, 200, sent.text);
  // A body link that agrees with the addressed record is fine.
  const agreed = await f.upload(eve, 'file-b', { parent: { table: 'item', key: { id: 'north-two' } }, values: { item_id: 'north-two' } });
  assert.equal(agreed.status, 200, agreed.text);
  const [a, b] = f.files();
  assert.deepEqual(
    [a.id, a.tenant_id, a.item_id, a.uploaded_by, a.file_name],
    ['file-a', 'north', 'north-one', 'north-eve', 'front.png'],
    "the session's person row in north, whatever the body named",
  );
  moment(a.uploaded_at);
  assert.deepEqual([b.item_id, b.uploaded_by], ['north-two', 'north-eve']);
  moment(b.uploaded_at);
  // Ada's upload is stamped with her own row.
  const ada = await f.open('ada', 'north');
  assert.equal((await f.upload(ada, 'file-c', { parent: { table: 'item', key: { id: 'north-one' } } })).status, 200);
  assert.equal(f.files()[2].uploaded_by, 'north-ada');
  // Sam's is south's, stamped with his row there.
  const sam = await f.open('sam', 'south');
  const his = await f.upload(sam, 'file-d', { parent: { table: 'item', key: { id: 'south-one' } }, values: { uploaded_by: 'north-eve' } });
  assert.equal(his.status, 200, his.text);
  assert.deepEqual((({ tenant_id, item_id, uploaded_by }) => ({ tenant_id, item_id, uploaded_by }))(f.files()[3]), {
    tenant_id: 'south',
    item_id: 'south-one',
    uploaded_by: 'south-sam',
  });
});

test('a mismatched link, another tenant’s record, a missing one and one outside the member’s rows are refused, and nothing is written', async (t) => {
  const f = await fixture(t);
  const eve = await f.open('eve', 'north');
  const mismatched = await f.upload(eve, 'bad-link', {
    parent: { table: 'item', key: { id: 'north-one' } },
    values: { item_id: 'north-two' },
  });
  assert.equal(mismatched.status, 400, mismatched.text);
  // South's item is no record on north's lease: not found, its title never said.
  const foreign = await f.upload(eve, 'foreign', { parent: { table: 'item', key: { id: 'south-one' } } });
  assert.equal(foreign.status, 404, foreign.text);
  assert.doesNotMatch(foreign.text, /South one/);
  const missing = await f.upload(eve, 'missing', { parent: { table: 'item', key: { id: 'nowhere' } } });
  assert.equal(missing.status, 404, missing.text);
  // North's archived item is outside Ada's rows, though Eve may attach to it.
  const ada = await f.open('ada', 'north');
  const hidden = await f.upload(ada, 'hidden', { parent: { table: 'item', key: { id: 'north-old' } } });
  assert.ok([403, 404].includes(hidden.status), hidden.text);
  // A body naming another tenant's record in place of the link, with no parent, is refused by the insert's own check.
  const smuggled = await f.upload(eve, 'smuggled', { values: { item_id: 'south-one' } });
  assert.notEqual(smuggled.status, 200, smuggled.text);
  assert.deepEqual(f.files(), []);
  const eves = await f.open('eve', 'north');
  assert.equal((await f.upload(eves, 'archived', { parent: { table: 'item', key: { id: 'north-old' } } })).status, 200);
  assert.deepEqual(
    f.files().map((row) => [row.id, row.item_id, row.uploaded_by]),
    [['archived', 'north-old', 'north-eve']],
  );
});

test("a tenant action's me and now, and a New form's hidden ones, are the member's row and the clock", async (t) => {
  const f = await fixture(t);
  const ada = await f.open('ada', 'north');
  // The action sends its words; the server writes what they mean as the update runs.
  const closed = await f.data('/api/update', ada, {
    table: 'item',
    key: { id: 'north-one' },
    values: { state: 'closed', closed_by: 'me', closed_at: 'now' },
  });
  assert.equal(closed.status, 200, closed.text);
  const one = f.item('north-one');
  assert.deepEqual([one.state, one.closed_by], ['closed', 'north-ada']);
  moment(one.closed_at);
  // A New form's hidden defaults are written over whatever the request says.
  const filed = await f.data('/api/insert', ada, {
    table: 'item',
    values: { id: 'north-new', title: 'Filed by Ada', state: 'open', filed_by: 'north-eve', filed_at: NOTE },
  });
  assert.equal(filed.status, 200, filed.text);
  const created = f.item('north-new');
  assert.deepEqual([created.tenant_id, created.filed_by], ['north', 'north-ada']);
  moment(created.filed_at);
  // In south, Sam's row there.
  const sam = await f.open('sam', 'south');
  assert.equal(
    (
      await f.data('/api/update', sam, {
        table: 'item',
        key: { id: 'south-one' },
        values: { state: 'closed', closed_by: 'me', closed_at: 'now' },
      })
    ).status,
    200,
  );
  assert.equal(f.item('south-one').closed_by, 'south-sam');
  assert.equal(f.item('north-two').closed_by, null, 'nothing else moved');
});
