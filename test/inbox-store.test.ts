import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { attributeAction, attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { INBOX_TABLES, INBOX_VERSION, InboxUnavailable, noticeKey, type NoticeRule } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { bindNotices } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { provisionSqliteInbox, sqliteInboxReady } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';

/**
 * The notification store on SQLite, beneath every facade: provisioned once
 * and attested, a notice written in the transaction of the write that sends
 * it — gone with it when it rolls back, and failing it when it cannot be
 * written — and read and marked per person.
 */
async function fixture(run: (adapter: SqliteAdapter, db: DatabaseSync, path: string) => Promise<void>, provision = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-inbox-store-'));
  const path = join(dir, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT);
    INSERT INTO person VALUES (1, 'ann@example.test'), (2, 'bob@example.test');
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT, owner_id INTEGER REFERENCES person(id), watcher TEXT, done INTEGER);
    INSERT INTO ticket VALUES (1, 'Printer jam', 'open', 1, 'bob@example.test', 0);`);
  if (provision) provisionSqliteInbox(path);
  const adapter = new SqliteAdapter(path);
  try {
    await run(adapter, db, path);
  } finally {
    await adapter.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const notices = (db: DatabaseSync) =>
  db.prepare(`SELECT * FROM "${INBOX_TABLES.notice}" ORDER BY id`).all() as Array<Record<string, unknown>>;
const owner = { column: 'owner_id', hops: [{ table: 'person', key: 'id', column: 'email' }] };
const rule = (on: NoticeRule['on'], extra: Partial<NoticeRule> = {}): NoticeRule => ({
  app: 'desk',
  on,
  to: [owner],
  title: ['Ticket ', { column: 'title', hops: [] }, ' is ', { column: 'status', hops: [] }],
  open: { resource: 'ticket' },
  uses: ['ticket.title', 'ticket.status'],
  ...extra,
});

test('provisioning is explicit, idempotent and refuses a foreign layout unchanged', async () => {
  await fixture(async (adapter, db, path) => {
    assert.equal(await appStoresOf(adapter).inboxReady(), false);
    assert.deepEqual(provisionSqliteInbox(path), { version: INBOX_VERSION, provisioned: true });
    assert.deepEqual(provisionSqliteInbox(path), { version: INBOX_VERSION, provisioned: false });
    assert.equal(await appStoresOf(adapter).inboxReady(), true);
    // A trigger could rewrite or drop what a write appends.
    db.exec(`CREATE TRIGGER "${INBOX_TABLES.notice}_scrub" AFTER INSERT ON "${INBOX_TABLES.notice}" BEGIN SELECT 1; END`);
    assert.equal(await appStoresOf(adapter).inboxReady(), false);
    assert.throws(() => provisionSqliteInbox(path), InboxUnavailable);
  }, false);
  await fixture(async (_adapter, db, path) => {
    db.exec(`CREATE TABLE "${INBOX_TABLES.meta}" (singleton INTEGER PRIMARY KEY)`);
    assert.throws(() => provisionSqliteInbox(path), InboxUnavailable);
    assert.equal(sqliteInboxReady(db), false);
  }, false);
});

test('a bound change writes its notice in the same transaction, to the person its path names, and a rollback takes it back', async () => {
  await fixture(async (adapter, db) => {
    bindNotices(adapter, new Map([['ticket', [rule({ kind: 'update', columns: ['status'] })]]]));
    await attributeWrites({ actor: 'bob@example.test', name: 'Bob', via: 'app' }, () =>
      adapter.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } }),
    );
    const [notice] = notices(db);
    assert.deepEqual(
      { recipient: notice.recipient, title: notice.title, actor: notice.actor, actor_name: notice.actor_name, key_json: notice.key_json },
      {
        recipient: 'ann@example.test',
        title: 'Ticket Printer jam is closed',
        actor: 'bob@example.test',
        actor_name: 'Bob',
        key_json: '{"id":1}',
      },
    );
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'open' } });
        throw new Error('handler failed');
      }),
      /handler failed/,
    );
    assert.equal(notices(db).length, 1, 'the rolled-back write told nobody');
    // A notice that cannot be written fails the write it belongs to.
    db.exec(`DROP TABLE "${INBOX_TABLES.notice}"`);
    await assert.rejects(adapter.update({ table: 'ticket', key: { id: 1 }, values: { status: 'open' } }));
    assert.equal(db.prepare('SELECT status FROM ticket WHERE id = 1').get()?.status, 'closed', 'no write without its notice');
  });
});

test('the writer is never told, a record told of twice in one write is one notice, and when narrows by the values after it', async () => {
  await fixture(async (adapter, db) => {
    bindNotices(
      adapter,
      new Map([
        [
          'ticket',
          [rule({ kind: 'update' }, { to: [owner, { column: 'watcher', hops: [] }], when: [[{ column: 'done', values: ['true'] }]] })],
        ],
      ]),
    );
    // Not done: no notice, whatever changed.
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { status: 'waiting' } });
    assert.equal(notices(db).length, 0);
    // Done (stored as 1, said as true), changed twice in one write, by the watcher: only the owner hears, once.
    await attributeWrites({ actor: 'Bob@Example.test', via: 'app' }, () =>
      adapter.transaction(async (tx) => {
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { done: 1 } });
        await tx.update({ table: 'ticket', key: { id: 1 }, values: { status: 'closed' } });
      }),
    );
    assert.deepEqual(
      notices(db).map((row) => row.recipient),
      ['ann@example.test'],
    );
  });
});

test('an insert and an action by its label notify; an unbound table and a nobody-to-tell path do not', async () => {
  await fixture(async (adapter, db) => {
    bindNotices(
      adapter,
      new Map([
        [
          'ticket',
          [
            rule({ kind: 'insert' }, { title: ['New: ', { column: 'title', hops: [] }] }),
            rule({ kind: 'action', label: 'Escalate' }, { title: ['Escalated: ', { column: 'title', hops: [] }] }),
          ],
        ],
      ]),
    );
    await adapter.insert({ table: 'ticket', values: { title: 'Scanner', owner_id: 2 } });
    await adapter.insert({ table: 'ticket', values: { title: 'Nobody', owner_id: null } });
    await attributeWrites({ actor: 'cat@example.test', via: 'app' }, () =>
      attributeAction('Escalate', () => adapter.update({ table: 'ticket', key: { id: 1 }, values: { status: 'urgent' } })),
    );
    // Unlabelled, the same change is not the action.
    await adapter.update({ table: 'ticket', key: { id: 1 }, values: { status: 'calm' } });
    await adapter.update({ table: 'person', key: { id: 1 }, values: { email: 'ann@example.org' } });
    assert.deepEqual(
      notices(db).map((row) => [row.recipient, row.title, row.action]),
      [
        ['bob@example.test', 'New: Scanner', ''],
        ['ann@example.test', 'Escalated: Printer jam', 'Escalate'],
      ],
    );
  });
});

test("reads are one person's in one App, newest first by cursor, and marking read never reaches another's", async () => {
  await fixture(async (adapter, db) => {
    bindNotices(adapter, new Map([['ticket', [rule({ kind: 'update' }), rule({ kind: 'update' }, { app: 'other' })]]]));
    for (const status of ['a', 'b', 'c']) await adapter.update({ table: 'ticket', key: { id: 1 }, values: { status } });
    assert.equal(notices(db).length, 6);
    const first = await appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'ann@example.test', limit: 2 });
    assert.deepEqual(
      first.map((row) => row.title),
      ['Ticket Printer jam is c', 'Ticket Printer jam is b'],
    );
    const rest = await appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'ann@example.test', limit: 2, before: first[1].id });
    assert.deepEqual(
      rest.map((row) => row.title),
      ['Ticket Printer jam is a'],
    );
    assert.equal((await appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'bob@example.test', limit: 20 })).length, 0);
    assert.equal(
      await appStoresOf(adapter).markInboxRead({ app: 'desk', recipient: 'bob@example.test', at: 'now', ids: first.map((row) => row.id) }),
      0,
    );
    assert.equal(
      await appStoresOf(adapter).markInboxRead({ app: 'desk', recipient: 'ann@example.test', at: 'now', ids: [first[0].id] }),
      1,
    );
    assert.equal((await appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'ann@example.test', limit: 20, unread: true })).length, 2);
    assert.equal(await appStoresOf(adapter).markInboxRead({ app: 'desk', recipient: 'ann@example.test', at: 'now' }), 2);
    // The other App's notices to the same person are that App's, and still unread.
    assert.equal(
      (await appStoresOf(adapter).readInbox({ app: 'other', recipient: 'ann@example.test', limit: 20, unread: true })).length,
      3,
    );
    assert.equal(noticeKey({ b: 1, a: '2' }), '{"a":"2","b":1}');
  });
});
