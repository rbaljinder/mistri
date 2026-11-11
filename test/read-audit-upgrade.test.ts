/**
 * The read audit's first upgrade, version 1 to 2 (the `command` route and the command's id), as an operator meets
 * it: a database holding the committed v1 fixture with rows in its log, `upgradeStores` (what `mistri migrate stores
 * up` calls) taking it forward, every row kept with its id, the result the layout a fresh version 2 store has, and
 * a start's own check accepting it where it refused version 1.
 *
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server where the role may create databases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { STORES, storeIsCurrent, storeStatuses, upgradeStores } from '../packages/mistri/src/server/storeLayouts.js';
import { ENGINES, LIVE, PROVISION, applyFixture, describeUrl, fixtureFiles, scratch, type Engine } from './support/storeLayouts.js';

const layouts = STORES.filter((store) => store.id === 'read-audit');

async function withDb<T>(url: string, work: (db: MigrationDb) => Promise<T>): Promise<T> {
  const db = await openMigrationDb(url, [], false);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

const names = (engine: Engine) =>
  engine === 'sqlite'
    ? { log: '"__mistri_read_audit_row"', meta: '"__mistri_read_audit_meta"' }
    : { log: 'mistri.read_audit_row', meta: 'mistri.read_audit_meta' };

/** What a start asks of the store before it serves it: provisioning attests and changes nothing where the layout stands. */
async function attest(engine: Engine, url: string) {
  if (engine === 'sqlite')
    return (await import('../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js')).provisionSqliteReadAudit(url);
  return (await import('../packages/mistri/src/adapters/readAudit/postgresReadAudit.js')).provisionPostgresReadAudit(url);
}

const SEEDED = [
  ['2026-01-01T00:00:00.000Z', 'page', '7', null, null, null],
  ['2026-01-01T00:00:01.000Z', 'api', null, '{"where":[]}', 2, '["7","8"]'],
  ['2026-01-01T00:00:02.000Z', 'related', null, '{"where":[]}', 0, '[]'],
] as const;

for (const engine of ENGINES)
  test(
    `${engine}: a version 1 read audit with rows upgrades in place to version 2, every row kept, and a start accepts it`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async () => {
      const { log, meta } = names(engine);
      const where = await scratch(engine, 'audit_up'),
        fresh = await scratch(engine, 'audit_fresh');
      try {
        const v1 = fixtureFiles('read-audit', engine).find((file) => file.version === 1)!;
        await applyFixture(engine, where.url, readFileSync(v1.path, 'utf8'));
        await withDb(where.url, async (db) => {
          for (const [at, route, record, query, count, ids] of SEEDED)
            await db.run(
              `INSERT INTO ${log} (at, app, tenant, actor, resource, route, record_key, query_json, row_count, ids_json)
               VALUES (?, 'ledger', '', 'a1', 'patients', ?, ?, ?, ?, ?)`,
              [at, route, record, query, count, ids],
            );
          const [status] = await storeStatuses(db, layouts);
          assert.equal(status.found, 1);
          assert.deepEqual(status.pending, [1]);
        });
        // A start refuses version 1 and says how to bring it forward; it never upgrades it itself.
        await assert.rejects(attest(engine, where.url), /migrate stores up/);

        const done = await withDb(where.url, (db) => upgradeStores(db, where.url, layouts));
        assert.deepEqual(done.failed, []);
        assert.deepEqual(
          done.applied.map((each) => [each.id, each.from, each.to]),
          [['read-audit', 1, 2]],
        );
        assert.deepEqual(await attest(engine, where.url), { version: 2, provisioned: false });

        // The same layout a fresh version 2 store has, so the attestation is of one thing either way.
        await PROVISION['read-audit'][engine]!(fresh.url);
        assert.deepEqual(await describeUrl(where.url), await describeUrl(fresh.url));

        await withDb(where.url, async (db) => {
          const rows = await db.all<Record<string, unknown>>(
            `SELECT id, route, record_key, row_count, ids_json, command FROM ${log} ORDER BY id`,
          );
          assert.deepEqual(
            rows.map((row) => [
              Number(row.id),
              row.route,
              row.record_key,
              row.row_count === null ? null : Number(row.row_count),
              row.ids_json,
              row.command,
            ]),
            SEEDED.map(([, route, record, , count, ids], index) => [index + 1, route, record, count, ids, null]),
            'every row kept, with its id',
          );
          assert.deepEqual(
            (await db.all<{ version: number }>(`SELECT version FROM ${meta}`)).map((row) => Number(row.version)),
            [2],
          );
          // Version 2 takes a command's read, and pairs the route with the command's id both ways.
          await db.run(
            `INSERT INTO ${log} (at, app, tenant, actor, resource, route, record_key, command) VALUES (?, 'ledger', '', 'a1', 'patients', 'command', '7', 'patients.discharge')`,
            ['2026-01-02T00:00:00.000Z'],
          );
          for (const [route, command] of [
            ['command', null],
            ['page', 'patients.discharge'],
          ] as const)
            await assert.rejects(
              db.run(
                `INSERT INTO ${log} (at, app, tenant, actor, resource, route, record_key, command) VALUES (?, 'ledger', '', 'a1', 'patients', ?, '7', ?)`,
                ['2026-01-02T00:00:00.000Z', route, command],
              ),
            );
          // Still append-only after the rebuild.
          if (engine === 'sqlite') await assert.rejects(db.run(`DELETE FROM ${log}`), /append-only/);
          else await db.run(`DELETE FROM ${log}`);
          assert.equal((await db.all(`SELECT id FROM ${log}`)).length, SEEDED.length + 1);
          assert.ok(storeIsCurrent((await storeStatuses(db, layouts))[0]));
        });
        // And a second run has nothing left to do.
        assert.deepEqual((await withDb(where.url, (db) => upgradeStores(db, where.url, layouts))).applied, []);
      } finally {
        await where.drop();
        await fresh.drop();
      }
    },
  );
