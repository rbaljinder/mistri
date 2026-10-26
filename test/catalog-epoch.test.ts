/*
 * The catalog caches are never wrong (U1). A write transaction reads one
 * epoch — SQLite's schema versions, PostgreSQL's epoch store — and every
 * catalog answer it trusts (the command journal's layout, the row scope's
 * catalog, a table's columns) is kept under it. A warm transaction reads the
 * catalog not at all; and whatever changes underneath — a column added, a
 * trigger attached, the journal tampered with, the store's own trigger
 * disabled — the next transaction sees it, because a moved epoch is a miss.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionPostgresSchemaEpoch } from '../packages/engine/src/adapters/postgresSchemaEpoch.js';
import { EpochCache } from '../packages/engine/src/adapters/epochCache.js';
import { statementsOf } from './support/statements.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
/** A refusal, read through the transaction failure that carries it. */
const refusedWith = (pattern: RegExp) => (error: Error) =>
  pattern.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ''}`);

test('an epoch cache answers only the version it was kept under', async () => {
  const cache = new EpochCache<string>(2);
  assert.equal(cache.get('1', 'k'), undefined);
  cache.set('1', 'k', 'one');
  assert.equal(cache.get('1', 'k'), 'one');
  assert.equal(cache.get('2', 'k'), undefined, 'another version is a miss');
  assert.equal(cache.get(undefined, 'k'), undefined, 'no version read is a miss');
  cache.set(undefined, 'k', 'never');
  assert.equal(cache.get('1', 'k'), 'one', 'nothing is kept without a version');
  assert.equal(await cache.through('2', 'k', async () => 'two'), 'two');
  assert.equal(cache.get('1', 'k'), undefined, 'kept again under the new version, the old one is gone');
  cache.set('2', 'a', 'x');
  cache.set('2', 'b', 'y');
  assert.equal(cache.size, 2, 'bounded');
});

function sqliteFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-catalog-epoch-'));
  const path = join(directory, 'epoch.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO item (id, name) VALUES (1, 'one'), (2, 'two');`);
  migrateSqliteCommandJournal(path);
  return {
    path,
    db,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('SQLite: a warm command transaction reads the catalog not at all, and sees a change made underneath', async () => {
  const f = sqliteFixture();
  const adapter = new SqliteAdapter(f.path);
  try {
    await adapter.introspect();
    const write = (values: Record<string, string | number | boolean | null>) =>
      commandsOf(adapter).commandTransaction((records) => records.update({ table: 'item', key: { id: 1 }, values }));
    await write({ name: 'first' });
    const warm = await statementsOf(() => write({ name: 'warm' }));
    assert.deepEqual(warm.catalog, [], `a warm command asks the catalog nothing:\n${warm.statements.join('\n')}`);
    assert.equal(warm.epoch, 1, 'one statement says the catalog has not moved');

    // A column that is not there is refused, from the cache as from the catalog...
    await assert.rejects(write({ extra: 'x' }), refusedWith(/no column called "extra"/));
    // ...and one added underneath is written by the very next transaction.
    f.db.exec('ALTER TABLE item ADD COLUMN extra TEXT');
    await write({ extra: 'x' });
    assert.equal(f.db.prepare('SELECT extra FROM item WHERE id = 1').get()!.extra, 'x');

    // The journal changed underneath: a trigger on its receipts, then its meta row gone.
    f.db.exec(`CREATE TRIGGER sneaky AFTER INSERT ON "${COMMAND_JOURNAL_TABLES.receipt}" BEGIN SELECT 1; END`);
    await assert.rejects(write({ name: 'refused' }), refusedWith(/journal/i));
    f.db.exec('DROP TRIGGER sneaky');
    await write({ name: 'again' });
    f.db.exec(`DELETE FROM "${COMMAND_JOURNAL_TABLES.meta}"`);
    await assert.rejects(write({ name: 'no meta' }), refusedWith(/journal/i));
    f.db.exec(`INSERT INTO "${COMMAND_JOURNAL_TABLES.meta}" (singleton, version) VALUES (1, 1)`);
    await write({ name: 'restored' });
  } finally {
    await adapter.close();
    f.close();
  }
});

test('SQLite: a row scope kept under the epoch still refuses a table a trigger was attached to since', async () => {
  const f = sqliteFixture();
  const adapter = new SqliteAdapter(f.path);
  try {
    await adapter.introspect();
    const write = (name: string) =>
      adapter.scopeTransaction({ item: true }, (tx) => tx.update({ table: 'item', key: { id: 2 }, values: { name } }));
    await write('scoped');
    const warm = await statementsOf(() => write('warm'));
    assert.deepEqual(warm.catalog, [], `a warm scoped write asks the catalog nothing:\n${warm.statements.join('\n')}`);
    f.db.exec(`CREATE TRIGGER audit_item AFTER UPDATE ON item BEGIN SELECT 1; END`);
    await assert.rejects(write('after trigger'), /not available in the current row scope|read-only in this scope/);
    f.db.exec('DROP TRIGGER audit_item');
    await write('trigger gone');
    assert.equal(f.db.prepare('SELECT name FROM item WHERE id = 2').get()!.name, 'trigger gone');
  } finally {
    await adapter.close();
    f.close();
  }
});

test('SQLite: a reserved store is attested once per epoch, and a store changed underneath is refused at the next read', async () => {
  const f = sqliteFixture();
  const { provisionSqliteInbox } = await import('../packages/mistri/src/adapters/inbox/sqliteInbox.js');
  const { INBOX_TABLES } = await import('../packages/mistri/src/adapters/inbox/inboxTables.js');
  provisionSqliteInbox(f.path);
  const adapter = new SqliteAdapter(f.path);
  try {
    await adapter.introspect();
    const read = () => appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'account-a', limit: 10 });
    assert.deepEqual(await read(), []);
    const warm = await statementsOf(read);
    assert.deepEqual(warm.catalog, [], `a warm inbox read describes nothing:\n${warm.statements.join('\n')}`);
    f.db.exec(`CREATE TRIGGER sneaky AFTER INSERT ON "${INBOX_TABLES.notice}" BEGIN SELECT 1; END`);
    await assert.rejects(read(), /notification store|unavailable/i);
    f.db.exec('DROP TRIGGER sneaky');
    assert.deepEqual(await read(), []);
    f.db.exec(`DELETE FROM "${INBOX_TABLES.meta}"`);
    await assert.rejects(read(), /notification store|unavailable/i);
  } finally {
    await adapter.close();
    f.close();
  }
});

test(
  'PostgreSQL: the epoch store moves with DDL, a warm transaction reads it alone, and every change underneath is seen',
  { skip: !LIVE, timeout: 120_000 },
  async () => {
    const database = await uuidPostgresDatabase('speed_epoch');
    const control = await pgClient(database.url);
    let adapter: PostgresAdapter | undefined;
    try {
      await control.query(`CREATE TABLE item (id integer PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 0);
      INSERT INTO item (id, name) VALUES (1, 'one'), (2, 'two')`);
      await migratePostgresCommandJournal(database.url);
      assert.deepEqual(await provisionPostgresSchemaEpoch(database.url), { provisioned: true });
      assert.deepEqual(await provisionPostgresSchemaEpoch(database.url), { provisioned: false }, 'provisioning twice changes nothing');
      adapter = new PostgresAdapter(database.url);
      await adapter.introspect();
      const write = (values: Record<string, string | number | boolean | null>) =>
        commandsOf(adapter!).scopeCommandTransaction({ 'public.item': true }, (records) =>
          records.update({ table: 'public.item', key: { id: 1 }, values }),
        );
      await write({ name: 'first' });
      const warm = await statementsOf(() => write({ name: 'warm' }));
      assert.deepEqual(warm.catalog, [], `a warm command asks the catalog nothing:\n${warm.statements.join('\n')}`);
      assert.equal(warm.epoch, 1, 'the epoch rides in the message that begins the transaction');
      assert.match(warm.statements[0], /^BEGIN; LOCK TABLE/, 'with the lock the scope pinned last time');

      // A column added underneath is written by the next transaction.
      await assert.rejects(write({ extra: 'x' }), refusedWith(/no column called "extra"/));
      await control.query('ALTER TABLE item ADD COLUMN extra text');
      await write({ extra: 'x' });
      assert.equal((await control.query('SELECT extra FROM item WHERE id = 1')).rows[0].extra, 'x');

      // A trigger attached underneath makes the table read-only in scope at once.
      await control.query(`CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER noop BEFORE UPDATE ON item FOR EACH ROW EXECUTE FUNCTION noop()`);
      await assert.rejects(write({ name: 'refused' }));
      await control.query('DROP TRIGGER noop ON item');
      await write({ name: 'again' });

      // The journal's meta row is read when an adapter first opens the journal: one that starts after it is gone refuses.
      await control.query(`DELETE FROM ${runtimeTable('postgres', COMMAND_JOURNAL_TABLES.meta)}`);
      await write({ name: 'attested at start' });
      const restarted = new PostgresAdapter(database.url);
      try {
        await assert.rejects(
          commandsOf(restarted).scopeCommandTransaction({ 'public.item': true }, (records) =>
            records.update({ table: 'public.item', key: { id: 1 }, values: { name: 'no meta' } }),
          ),
          refusedWith(/journal/i),
        );
      } finally {
        await restarted.close();
      }
      await control.query(`INSERT INTO ${runtimeTable('postgres', COMMAND_JOURNAL_TABLES.meta)} (singleton, version) VALUES (1, 1)`);
      await write({ name: 'restored' });

      // A reserved store is attested once per adapter, and a change underneath is refused by the next adapter to start.
      const { provisionPostgresInbox } = await import('../packages/mistri/src/adapters/inbox/postgresInbox.js');
      const { INBOX_TABLES } = await import('../packages/mistri/src/adapters/inbox/inboxTables.js');
      await provisionPostgresInbox(database.url);
      const inbox = () => appStoresOf(adapter!).readInbox({ app: 'desk', recipient: 'account-a', limit: 10 });
      assert.deepEqual(await inbox(), []);
      const warmInbox = await statementsOf(inbox);
      assert.deepEqual(warmInbox.catalog, [], `a warm inbox read describes nothing:\n${warmInbox.statements.join('\n')}`);
      const restartedInbox = async () => {
        const restarted = new PostgresAdapter(database.url);
        try {
          return await appStoresOf(restarted).readInbox({ app: 'desk', recipient: 'account-a', limit: 10 });
        } finally {
          await restarted.close();
        }
      };
      await control.query(
        `CREATE TRIGGER sneaky BEFORE INSERT ON ${runtimeTable('postgres', INBOX_TABLES.notice)} FOR EACH ROW EXECUTE FUNCTION noop()`,
      );
      assert.deepEqual(await inbox(), [], 'the adapter that attested goes on');
      await assert.rejects(restartedInbox(), /notification store|unavailable/i);
      await control.query(`DROP TRIGGER sneaky ON ${runtimeTable('postgres', INBOX_TABLES.notice)}`);
      assert.deepEqual(await restartedInbox(), []);
      await control.query(`DELETE FROM ${runtimeTable('postgres', INBOX_TABLES.meta)}`);
      await assert.rejects(restartedInbox(), /notification store|unavailable/i);

      // The store's trigger disabled: no epoch is answered, so nothing is trusted
      // from the cache, and a change made while it is off is still seen.
      await control.query('ALTER EVENT TRIGGER "__mistri_schema_epoch" DISABLE');
      await control.query('CREATE TRIGGER noop BEFORE UPDATE ON item FOR EACH ROW EXECUTE FUNCTION noop()');
      await assert.rejects(write({ name: 'refused while disabled' }));
      const cold = await statementsOf(() => write({ name: 'x' }).catch(() => undefined));
      assert.ok(cold.catalog.length > 0, 'without an epoch the catalog is read, as before');
    } finally {
      await adapter?.close();
      await control.end();
      await database.drop();
    }
  },
);

test(
  'PostgreSQL without the epoch store: the catalog digest of a scoped transaction is its epoch, and a change underneath is still seen',
  { skip: !LIVE, timeout: 120_000 },
  async () => {
    const database = await uuidPostgresDatabase('speed_digest');
    const control = await pgClient(database.url);
    let adapter: PostgresAdapter | undefined;
    try {
      await control.query(`CREATE TABLE item (id integer PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 0);
      INSERT INTO item (id, name) VALUES (1, 'one')`);
      await migratePostgresCommandJournal(database.url);
      adapter = new PostgresAdapter(database.url);
      await adapter.introspect();
      const write = (values: Record<string, string | number | boolean | null>) =>
        commandsOf(adapter!).scopeCommandTransaction({ 'public.item': true }, (records) =>
          records.update({ table: 'public.item', key: { id: 1 }, values }),
        );
      await write({ name: 'first' });
      await write({ name: 'second' });
      const warm = await statementsOf(() => write({ name: 'warm' }));
      // The digest, in the message that begins the transaction, and no other catalog read: no relation probe, no column read, no scope facts.
      assert.equal(warm.catalog.length, 1, `one catalog statement, the digest:\n${warm.statements.join('\n')}`);
      assert.match(warm.catalog[0], /^BEGIN; LOCK TABLE .* AS fingerprint/s);
      await assert.rejects(write({ extra: 'x' }), refusedWith(/no column called "extra"/));
      await control.query('ALTER TABLE item ADD COLUMN extra text');
      await write({ extra: 'x' });
      assert.equal((await control.query('SELECT extra FROM item WHERE id = 1')).rows[0].extra, 'x');
      await control.query(`CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER noop BEFORE UPDATE ON item FOR EACH ROW EXECUTE FUNCTION noop()`);
      await assert.rejects(write({ name: 'refused' }));
    } finally {
      await adapter?.close();
      await control.end();
      await database.drop();
    }
  },
);
