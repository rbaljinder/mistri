/**
 * The store upgrades that add an index to a table that already exists build it with
 * `CREATE INDEX CONCURRENTLY`, outside any transaction, so a large store keeps taking writes during its
 * upgrade (a field report). PostgreSQL only; the steps are PostgreSQL's.
 *
 * A build that was interrupted leaves the index in the catalog marked invalid, which `IF NOT EXISTS` alone would
 * skip forever; the runner drops and rebuilds it. A tenant store's step still takes the server-wide maintenance
 * lock for the rest of the step, and a transaction-mode pooler refuses it as it does every step with a session lock.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { configurePostgresPools } from '../packages/engine/src/adapters/postgresPool.js';
import { MIGRATION_LOCK } from '../packages/mistri/src/adapters/commands/postgresCommandJournalSchema.js';
import { concurrentStatement } from '../packages/mistri/src/adapters/postgresConcurrentIndex.js';
import { STORES, upgradeStores } from '../packages/mistri/src/server/storeLayouts.js';
import { LIVE, applyFixture, fixturePath, scratch } from './support/storeLayouts.js';

const skip = liveSkip('postgres', LIVE);

/** What each store's step builds concurrently, and the version its fixture is at before the step. */
const CASES = [
  { store: 'live-change', from: 1, index: '__mistri_live_change_at' },
  { store: 'command-staging', from: 1, index: 'staged_file_expires' },
  { store: 'tenant-store', from: 2, index: '__mistri_tenant_member_account' },
] as const;

async function withDb<T>(url: string, work: (db: MigrationDb) => Promise<T>): Promise<T> {
  const db = await openMigrationDb(url, [], false);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

const state = (db: MigrationDb, name: string) =>
  db.all<{ valid: boolean }>(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ?`, [
    name,
  ]);

/** A database at the store's `from` fixture, with the step's index absent: what an older deploy left. */
async function olderDatabase(store: string, from: number, index: string, label: string) {
  const where = await scratch('postgres', label);
  await applyFixture('postgres', where.url, readFileSync(fixturePath(store, 'postgres', from), 'utf8'));
  await withDb(where.url, async (db) => {
    await db.run(`DROP INDEX IF EXISTS mistri."${index}"`);
  });
  return where;
}

/** Records what the runner sends, and whether a transaction was open when each statement ran. */
function recording(db: MigrationDb) {
  const log: Array<{ sql: string; params?: unknown[]; open: boolean }> = [];
  let open = false;
  const wrapped: MigrationDb = Object.create(db, {
    run: {
      value: async (sql: string, params?: unknown[]) => {
        log.push({ sql, params, open });
        if (sql.startsWith('BEGIN')) open = true;
        if (/^(COMMIT|ROLLBACK)/.test(sql)) open = false;
        return db.run(sql, params);
      },
    },
  });
  return { wrapped, log };
}

for (const { store, from, index } of CASES) {
  test(`postgres: ${store} builds its index concurrently outside a transaction, then bumps the version in one`, { skip }, async () => {
    const where = await olderDatabase(store, from, index, `ci_${store}`);
    try {
      await withDb(where.url, async (db) => {
        const { wrapped, log } = recording(db);
        const layout = STORES.filter((each) => each.id === store);
        const result = await upgradeStores(wrapped, where.url, layout);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(
          result.applied.map((each) => each.from),
          [from],
        );
        const build = log.findIndex((entry) => entry.sql.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS'));
        assert.ok(build >= 0, 'the index is built concurrently');
        assert.equal(log[build].open, false, 'with no transaction open: a concurrent build refuses one');
        assert.ok(!log.some((entry) => /^CREATE INDEX (?!CONCURRENTLY)/.test(entry.sql)), 'no plain CREATE INDEX holds the table lock');
        const begin = log.findIndex((entry, at) => at > build && entry.sql === 'BEGIN');
        const bump = log.findIndex((entry) => /^UPDATE .* SET version/.test(entry.sql));
        assert.ok(begin > build && bump > begin, 'the version moves in a transaction that starts after the build');
        assert.deepEqual(await state(db, index), [{ valid: true }]);
      });
    } finally {
      await where.drop();
    }
  });
}

test(
  'postgres: a build interrupted before it finished leaves an invalid index, and the next run drops and rebuilds it',
  { skip },
  async () => {
    const { store, from, index } = CASES[0];
    const where = await olderDatabase(store, from, index, 'ci_invalid');
    try {
      await withDb(where.url, async (db) => {
        const layout = STORES.filter((each) => each.id === store);
        // What a cancelled `CREATE INDEX CONCURRENTLY` leaves: the index is in the catalog and marked invalid.
        const { indexes } = layout[0].upgrades.postgres![from];
        const [built] = await indexes!();
        await db.run(built.create);
        await db.run(
          `UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = (SELECT c.oid FROM pg_class c WHERE c.relname = ? AND c.relnamespace = 'mistri'::regnamespace)`,
          [index],
        );
        assert.deepEqual(await state(db, index), [{ valid: false }]);
        // `IF NOT EXISTS` alone would see the name and build nothing.
        await db.run(concurrentStatement(built));
        assert.deepEqual(await state(db, index), [{ valid: false }], 'the plain statement leaves it broken');

        const result = await upgradeStores(db, where.url, layout);
        assert.deepEqual(result.failed, []);
        assert.equal(result.applied.length, 1);
        assert.deepEqual(await state(db, index), [{ valid: true }], 'rebuilt and valid');
      });
    } finally {
      await where.drop();
    }
  },
);

test('postgres: a concurrent build that really fails leaves an invalid index, and a rerun repairs it', { skip }, async () => {
  const { store, from, index } = CASES[0];
  const where = await olderDatabase(store, from, index, 'ci_real');
  try {
    await withDb(where.url, async (db) => {
      const layout = STORES.filter((each) => each.id === store);
      const [built] = await layout[0].upgrades.postgres![from].indexes!();
      for (const key of [1, 1]) await db.run(`INSERT INTO ${built.table} (at, actor, entries) VALUES (?, 'someone', '[]'::jsonb)`, [key]);
      // A unique build over duplicate data fails after the catalog entry exists: the state an interrupted build leaves.
      await assert.rejects(db.run(`CREATE UNIQUE INDEX CONCURRENTLY "${index}" ON ${built.table} (at)`), /could not create unique index/);
      assert.deepEqual(await state(db, index), [{ valid: false }]);
      assert.deepEqual((await upgradeStores(db, where.url, layout)).failed, []);
      assert.deepEqual(await state(db, index), [{ valid: true }]);
    });
  } finally {
    await where.drop();
  }
});

test('postgres: rerunning an upgrade that already finished builds nothing and changes nothing', { skip }, async () => {
  const { store, from, index } = CASES[1];
  const where = await olderDatabase(store, from, index, 'ci_again');
  try {
    await withDb(where.url, async (db) => {
      const layout = STORES.filter((each) => each.id === store);
      assert.equal((await upgradeStores(db, where.url, layout)).applied.length, 1);
      const oid = await db.all(`SELECT indexrelid FROM pg_index WHERE indexrelid = to_regclass('mistri."${index}"')`);
      const { wrapped, log } = recording(db);
      const again = await upgradeStores(wrapped, where.url, layout);
      assert.deepEqual([again.applied, again.failed], [[], []]);
      assert.ok(!log.some((entry) => /CREATE INDEX/.test(entry.sql)));
      assert.deepEqual(await db.all(`SELECT indexrelid FROM pg_index WHERE indexrelid = to_regclass('mistri."${index}"')`), oid);
    });
  } finally {
    await where.drop();
  }
});

test('postgres: a tenant store step takes the maintenance lock for its transactional rest, after the store lock', { skip }, async () => {
  const { store, from, index } = CASES[2];
  const where = await olderDatabase(store, from, index, 'ci_tenant');
  try {
    await withDb(where.url, async (db) => {
      const { wrapped, log } = recording(db);
      const result = await upgradeStores(
        wrapped,
        where.url,
        STORES.filter((each) => each.id === store),
      );
      assert.deepEqual(result.failed, []);
      const build = log.findIndex((entry) => entry.sql.includes('CREATE INDEX CONCURRENTLY'));
      const locks = log.map((entry, at) => ({ entry, at })).filter(({ entry }) => entry.sql.includes('pg_advisory_xact_lock'));
      assert.equal(locks.length, 2, 'the store lock, then the maintenance lock');
      assert.ok(
        locks.every(({ at }) => at > build && log[at].open),
        'both inside the short transaction that follows the build',
      );
      assert.deepEqual(locks[1].entry.params, [MIGRATION_LOCK]);
    });
  } finally {
    await where.drop();
  }
});

test(
  'postgres: behind a transaction-mode pooler the step is refused with the session-lock error, and nothing is built',
  { skip },
  async () => {
    const { store, from, index } = CASES[0];
    const where = await olderDatabase(store, from, index, 'ci_pooler');
    try {
      await withDb(where.url, async (db) => {
        configurePostgresPools({ pooler: 'transaction' });
        try {
          const result = await upgradeStores(
            db,
            where.url,
            STORES.filter((each) => each.id === store),
          );
          assert.equal(result.applied.length, 0);
          assert.match(result.failed[0].message, /session lock, which a transaction-mode pooler does not keep/);
        } finally {
          configurePostgresPools({ pooler: 'session' });
        }
        assert.deepEqual(await state(db, index), []);
      });
    } finally {
      await where.drop();
    }
  },
);
