/**
 * The command event store's upgrade, version 1 to 2 (an envelope may hold an effect's post of up to 256 KiB), as an
 * operator meets it: a database holding the committed version 1 fixture with an event in it, `upgradeStores` (what
 * `mistri migrate stores up` calls) taking it forward, the event kept, the result the layout a fresh store has, and an
 * envelope the old bound refused stored after it. SQLite rebuilds the table by copy and rename; PostgreSQL replaces
 * the named CHECK, read back from pg_constraint.
 *
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server where the role may create databases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { STORES, storeIsCurrent, storeStatuses, upgradeStores } from '../packages/mistri/src/server/storeLayouts.js';
import { EFFECT_ENVELOPE_MAX } from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import {
  ENGINES,
  LIVE,
  PROVISION,
  applyFixture,
  describeUrl,
  fixtureFiles,
  scratch,
  withoutBeneath,
  type Engine,
} from './support/storeLayouts.js';

const layouts = STORES.filter((store) => store.id === 'command-events');

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
    ? { receipt: '"__mistri_command_receipt"', event: '"__mistri_event_event"', meta: '"__mistri_event_meta"' }
    : { receipt: 'mistri.command_receipt', event: 'mistri.event_event', meta: 'mistri.event_meta' };

const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const ENVELOPE = '{"name":"effect.crm","payloadJson":"{}"}';
/** An envelope past version 1's 131,072 bytes and within version 2's bound. */
const LARGE = JSON.stringify({ name: 'effect.crm', payloadJson: JSON.stringify({ body: { text: 'x'.repeat(300_000) } }) });

const insertReceipt = (db: MigrationDb, receipt: string, id: string) =>
  db.run(
    `INSERT INTO ${receipt} (id, app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key,
       fingerprint, result_json, request_id, completed_at, membership_id, membership_version, realm_version, roles_json, deployment,
       target, owners_json, keys_json, changes_json)
     VALUES (?, 'layout', '', '', 'tenant', '', 'reviewer', 'assign', 1, ?, 'digest', '{}', 'request-1', '2026-09-07T12:00:00.000Z',
       '', '', '', '[]', '', 'loan', '[""]', '["{\\"id\\":1}"]', '[]')`,
    [id, `attempt-${id}`],
  );
const insertEvent = (db: MigrationDb, event: string, id: string, receiptId: string, envelope: string) =>
  db.run(`INSERT INTO ${event} (event_id, receipt_id, ordinal, envelope_json) VALUES (?, ?, 0, ?)`, [id, receiptId, envelope]);

/** The envelope bound the event table's CHECK states, as the engine keeps it. */
async function envelopeBound(engine: Engine, db: MigrationDb): Promise<string> {
  if (engine === 'sqlite')
    return String((await db.all<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = '__mistri_event_event'`))[0].sql);
  const rows = await db.all<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'mistri.event_event'::regclass AND contype = 'c' AND conname = 'event_event_envelope_json_check'`,
  );
  assert.equal(rows.length, 1, 'the named CHECK, replaced under the same name');
  return rows[0].def;
}

assert.ok(Buffer.byteLength(LARGE) > 131_072 && Buffer.byteLength(LARGE) <= EFFECT_ENVELOPE_MAX);

for (const engine of ENGINES)
  test(
    `${engine}: a version 1 event store with an event upgrades in place to version 2, the event kept, and takes an effect's envelope`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async () => {
      const { receipt, event, meta } = names(engine);
      const where = await scratch(engine, 'events_up'),
        fresh = await scratch(engine, 'events_fresh');
      try {
        const v1 = fixtureFiles('command-events', engine).find((file) => file.version === 1)!;
        await applyFixture(engine, where.url, readFileSync(v1.path, 'utf8'));
        await withDb(where.url, async (db) => {
          await insertReceipt(db, receipt, 'receipt-1');
          await insertReceipt(db, receipt, 'receipt-2');
          await insertEvent(db, event, EVENT_ID, 'receipt-1', ENVELOPE);
          // Version 1 holds an envelope to 131,072 bytes: an effect's 256 KiB body does not fit.
          await assert.rejects(insertEvent(db, event, EVENT_ID.replace(/1$/, '2'), 'receipt-2', LARGE));
          assert.match(await envelopeBound(engine, db), /131072/);
          const [status] = await storeStatuses(db, layouts);
          assert.equal(status.found, 1);
          assert.deepEqual(status.pending, [1]);
        });

        // The journal beneath it is brought forward in the same run; this store's step is the one asserted.
        const done = await withDb(where.url, (db) => upgradeStores(db, where.url));
        assert.deepEqual(done.failed, []);
        assert.deepEqual(
          done.applied.filter((each) => each.id === 'command-events').map((each) => [each.from, each.to]),
          [[1, 2]],
        );

        await PROVISION['command-events'][engine]!(fresh.url);
        assert.deepEqual(
          withoutBeneath('command-events', engine, await describeUrl(where.url)),
          withoutBeneath('command-events', engine, await describeUrl(fresh.url)),
        );

        await withDb(where.url, async (db) => {
          assert.deepEqual(
            (await db.all<{ event_id: string; envelope_json: string }>(`SELECT event_id, envelope_json FROM ${event}`)).map((row) => [
              row.event_id,
              row.envelope_json,
            ]),
            [[EVENT_ID, ENVELOPE]],
            'the event kept as it was',
          );
          assert.deepEqual(
            (await db.all<{ version: number }>(`SELECT version FROM ${meta}`)).map((row) => Number(row.version)),
            [2],
          );
          assert.match(await envelopeBound(engine, db), new RegExp(String(EFFECT_ENVELOPE_MAX)));
          await insertEvent(db, event, EVENT_ID.replace(/1$/, '2'), 'receipt-2', LARGE);
          assert.equal((await db.all(`SELECT 1 FROM ${event}`)).length, 2);
          // The event is still its receipt's: a receipt with events is not forgotten from under them.
          if (engine === 'sqlite') await db.run('PRAGMA foreign_keys = ON');
          await assert.rejects(db.run(`DELETE FROM ${receipt} WHERE id = 'receipt-1'`));
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
