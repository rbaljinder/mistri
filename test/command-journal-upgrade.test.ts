/**
 * The command journal's upgrades, version 1 to 2 (the audit-part table: a target's changes past the first 256) and 2
 * to 3 (the link table: the capability links a command mints), as an
 * operator meets it: a database holding the committed version 1 fixture with a receipt in it, `upgradeStores` (what
 * `mistri migrate stores up` calls) taking it forward, the receipt kept, the result the layout a fresh store of this
 * version has, and a start's own attestation accepting it where it refused the old one. A fresh store is at version 3.
 *
 * SQLite always; PostgreSQL when TABLEWALK_TEST_PG names a server where the role may create databases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { liveSkip } from './live.js';
import { openMigrationDb, type MigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { STORES, storeIsCurrent, storeStatuses, upgradeStores } from '../packages/mistri/src/server/storeLayouts.js';
import {
  assertSqliteCommandJournal,
  CommandJournalUnavailable,
  JOURNAL_VERSION,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { assertPostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
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
import { pgClient } from './support/tenantDialects.js';

const layouts = STORES.filter((store) => store.id === 'command-journal');

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
    ? {
        receipt: '"__mistri_command_receipt"',
        part: '"__mistri_command_audit_part"',
        meta: '"__mistri_command_meta"',
        link: '"__mistri_command_link"',
      }
    : { receipt: 'mistri.command_receipt', part: 'mistri.command_audit_part', meta: 'mistri.command_meta', link: 'mistri.command_link' };

/** What a start asks of the journal before it serves it: attested, and nothing changed. */
async function attest(engine: Engine, url: string): Promise<void> {
  if (engine === 'sqlite') {
    const db = new DatabaseSync(url);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      assertSqliteCommandJournal(db);
    } finally {
      db.close();
    }
    return;
  }
  const client = await pgClient(url);
  try {
    await assertPostgresCommandJournal(client as never);
  } finally {
    await client.end();
  }
}

const RECEIPT = {
  id: 'receipt-1',
  idempotency_key: 'attempt-1',
  changes: '["[{\\"field\\":\\"name\\"}]"]',
};
const insertReceipt = (db: MigrationDb, receipt: string, id: string) =>
  db.run(
    `INSERT INTO ${receipt} (id, app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key,
       fingerprint, result_json, request_id, completed_at, membership_id, membership_version, realm_version, roles_json, deployment,
       target, owners_json, keys_json, changes_json)
     VALUES (?, 'lending', '', '', 'tenant', '', 'reviewer', 'assign', 1, ?, 'digest', '{}', 'request-1', '2026-09-07T12:00:00.000Z',
       '', '', '', '[]', '', 'loan', '[""]', '["{\\"id\\":1}"]', ?)`,
    [id, `${RECEIPT.idempotency_key}-${id}`, RECEIPT.changes],
  );

for (const engine of ENGINES)
  test(
    `${engine}: a version 1 command journal with a receipt upgrades in place to the current version, the receipt kept, and a start accepts it`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async () => {
      const { receipt, part, meta } = names(engine);
      const where = await scratch(engine, 'journal_up'),
        fresh = await scratch(engine, 'journal_fresh');
      try {
        const v1 = fixtureFiles('command-journal', engine).find((file) => file.version === 1)!;
        await applyFixture(engine, where.url, readFileSync(v1.path, 'utf8'));
        await withDb(where.url, async (db) => {
          await insertReceipt(db, receipt, RECEIPT.id);
          const [status] = await storeStatuses(db, layouts);
          assert.equal(status.found, 1);
          assert.deepEqual(status.pending, [1, 2]);
        });
        // A start refuses version 1 and says how to bring it forward; it never upgrades it itself.
        await assert.rejects(attest(engine, where.url), (error: unknown) => {
          assert.ok(error instanceof CommandJournalUnavailable);
          assert.match((error as Error).message, /migrate stores up/);
          return true;
        });

        const done = await withDb(where.url, (db) => upgradeStores(db, where.url, layouts));
        assert.deepEqual(done.failed, []);
        assert.deepEqual(
          done.applied.map((each) => [each.id, each.from, each.to]),
          [
            ['command-journal', 1, 2],
            ['command-journal', 2, 3],
          ],
        );
        await attest(engine, where.url);

        // The same layout a fresh journal has, so the attestation is of one thing either way.
        await PROVISION['command-journal'][engine]!(fresh.url);
        assert.deepEqual(
          withoutBeneath('command-journal', engine, await describeUrl(where.url)),
          withoutBeneath('command-journal', engine, await describeUrl(fresh.url)),
        );

        await withDb(where.url, async (db) => {
          assert.deepEqual(
            (await db.all<{ id: string; changes_json: string }>(`SELECT id, changes_json FROM ${receipt}`)).map((row) => [
              row.id,
              row.changes_json,
            ]),
            [[RECEIPT.id, RECEIPT.changes]],
            'the receipt kept as it was',
          );
          assert.deepEqual(
            (await db.all<{ version: number }>(`SELECT version FROM ${meta}`)).map((row) => Number(row.version)),
            [JOURNAL_VERSION],
          );
          // The new table takes a continuation of that receipt, and only of a receipt there is (SQLite's connection is asked to enforce keys).
          if (engine === 'sqlite') await db.run('PRAGMA foreign_keys = ON');
          await db.run(`INSERT INTO ${part} (receipt_id, target_index, part, changes_json) VALUES (?, 0, 1, '[{"field":"b"}]')`, [
            RECEIPT.id,
          ]);
          await assert.rejects(
            db.run(`INSERT INTO ${part} (receipt_id, target_index, part, changes_json) VALUES ('no-such-receipt', 0, 1, '[]')`),
          );
          await assert.rejects(
            db.run(`INSERT INTO ${part} (receipt_id, target_index, part, changes_json) VALUES (?, 0, 1, '[]')`, [RECEIPT.id]),
          );
          await assert.rejects(
            db.run(`INSERT INTO ${part} (receipt_id, target_index, part, changes_json) VALUES (?, 0, 2, '{}')`, [RECEIPT.id]),
          );
          // Forgotten with its receipt.
          await db.run(`DELETE FROM ${receipt} WHERE id = ?`, [RECEIPT.id]);
          assert.equal((await db.all(`SELECT 1 FROM ${part}`)).length, 0);
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

for (const engine of ENGINES)
  test(
    `${engine}: a version 2 command journal upgrades to version 3, the link table usable, and a start accepts it`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async () => {
      const { receipt, link, meta } = names(engine);
      const where = await scratch(engine, 'journal_v3'),
        fresh = await scratch(engine, 'journal_v3_fresh');
      try {
        const v2 = fixtureFiles('command-journal', engine).find((file) => file.version === 2)!;
        await applyFixture(engine, where.url, readFileSync(v2.path, 'utf8'));
        await withDb(where.url, async (db) => {
          await insertReceipt(db, receipt, RECEIPT.id);
          assert.deepEqual((await storeStatuses(db, layouts))[0].pending, [2]);
        });
        await assert.rejects(attest(engine, where.url), CommandJournalUnavailable);
        const done = await withDb(where.url, (db) => upgradeStores(db, where.url, layouts));
        assert.deepEqual(done.failed, []);
        assert.deepEqual(
          done.applied.map((each) => [each.id, each.from, each.to]),
          [['command-journal', 2, 3]],
        );
        await attest(engine, where.url);
        await PROVISION['command-journal'][engine]!(fresh.url);
        assert.deepEqual(
          withoutBeneath('command-journal', engine, await describeUrl(where.url)),
          withoutBeneath('command-journal', engine, await describeUrl(fresh.url)),
        );
        await withDb(where.url, async (db) => {
          assert.deepEqual(
            (await db.all<{ version: number }>(`SELECT version FROM ${meta}`)).map((row) => Number(row.version)),
            [JOURNAL_VERSION],
          );
          assert.equal((await db.all(`SELECT id FROM ${receipt}`)).length, 1, 'the receipt kept');
          const insert = (id: string, uses: number | null) =>
            db.run(
              `INSERT INTO ${link} (id, app_id, tenant_id, resource, row_key, name, expires_at, uses_left, revoked_at, created_at,
                 created_by, command, receipt, opens, last_opened_at)
               VALUES (?, 'lending', '', 'loan', '{"id":1}', 'status', 2000000000000, ?, NULL, 1700000000000, 'reviewer', 'assign', ?, 0, NULL)`,
              [id, uses, RECEIPT.id],
            );
          await insert('link-1', 1);
          await insert('link-2', null);
          await assert.rejects(insert('link-1', null), 'one row per link id');
          await assert.rejects(insert('link-3', -1), 'uses left are never negative');
          // A link names its minting receipt without a key to it: the receipt is forgotten on its own window.
          await db.run(`DELETE FROM ${receipt} WHERE id = ?`, [RECEIPT.id]);
          assert.equal((await db.all(`SELECT 1 FROM ${link}`)).length, 2);
          assert.ok(storeIsCurrent((await storeStatuses(db, layouts))[0]));
        });
        assert.deepEqual((await withDb(where.url, (db) => upgradeStores(db, where.url, layouts))).applied, []);
      } finally {
        await where.drop();
        await fresh.drop();
      }
    },
  );
