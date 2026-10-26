import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { Refusal, TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  assertSqliteCommandJournal,
  captureCommandJournalMember,
  captureCommandJournalPlatform,
  captureCommandJournalTenant,
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  createSqliteCommandJournal,
  type CommandAudit,
  type CommandJournal,
  type CommandJournalPlatform,
  type CommandJournalTenant,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import {
  assertPostgresCommandJournal,
  createPostgresCommandJournal,
} from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { CommandEventBatch, CommandEventManifest } from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';
import { runtimeName, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

/* Journal v4: a receipt's realm joins its namespace, and each audit row names
   the tenant owning its target. The platform realm's receipts have no tenant;
   its audit owners are the ones the server read from the rows it changed.
   The journal is proved on SQLite and, when TABLEWALK_TEST_PG names a server,
   on PostgreSQL (support/tenantDialects.ts); the validation is one module, and
   this shows each engine's layout and replay reach it. */

const platform: CommandJournalPlatform = {
  realm: 'platform',
  appId: 'lending',
  storeId: 'store',
  sourceId: 'business',
  actorId: 'lee',
  membershipId: 'platform-lee',
  membershipVersion: '1',
  platformVersion: '3',
  roles: ['manager'],
  deployment: 'deployment',
};
const tenant: CommandJournalTenant = {
  appId: 'lending',
  storeId: 'store',
  sourceId: 'business',
  tenantId: 'north',
  actorId: 'lee',
  membershipId: 'north-lee',
  membershipVersion: '1',
  tenantVersion: '2',
  roles: ['staff'],
  deployment: 'deployment',
};
const receipt = (id = 'receipt', idempotencyKey = 'same-key'): StoredCommandReceipt => ({
  id,
  appId: 'lending',
  actorId: 'lee',
  commandId: 'approve',
  commandVersion: 1,
  idempotencyKey,
  fingerprint: 'fingerprint',
  resultJson: '{"done":true}',
  requestId: 'request',
  completedAt: '2026-09-12T12:00:00.000Z',
});
const audit = (owner?: string, id = 'n1', target = 'lead'): CommandAudit => ({
  target,
  keyJson: JSON.stringify({ id }),
  changesJson: '[{"field":"status","value":"approved"}]',
  ...(owner === undefined ? {} : { owner }),
});
type Owner = CommandJournalTenant | CommandJournalPlatform | undefined;

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its journal tables reset under it. */
const DATABASE = `platform_journal_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: [],
    sqlite: 'PRAGMA foreign_keys=ON',
    postgres: 'SELECT 1',
    database: DATABASE,
  });
  t.after(() => engine.close());
  assert.deepEqual(await engine.migrateCommandJournal(), { version: 1, migrated: true });
  const postgres = dialect === 'postgres';
  // PostgreSQL's journal runs on its writer's leased client: here, one plain connection of its own.
  const connection = postgres ? await engine.session() : undefined;
  const sqlite = postgres ? undefined : engine.sqlite();
  const run = async <T>(owner: Owner, work: (journal: CommandJournal) => Promise<T>): Promise<T> => {
    const operations = new TransactionOperations();
    if (connection) await connection.query('BEGIN');
    else sqlite!.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(
        connection ? createPostgresCommandJournal(connection, operations, owner) : createSqliteCommandJournal(sqlite!, operations, owner),
      );
      await operations.finish();
      if (connection) await connection.query('COMMIT');
      else sqlite!.exec('COMMIT');
      return result;
    } catch (error) {
      await operations.finish().catch(() => {});
      if (connection) await connection.query('ROLLBACK').catch(() => {});
      else if (sqlite!.isTransaction) sqlite!.exec('ROLLBACK');
      throw error;
    }
  };
  const rows = () =>
    engine.all(`SELECT receipt_id, ordinal, realm, tenant_id, owner_tenant_id, realm_version, membership_id
    FROM ${auditRows(dialect)} a ORDER BY receipt_id, ordinal`);
  /* An outside edit that breaks the journal's own CHECKs. SQLite can suspend
     them for one statement; PostgreSQL cannot, so there the tamper first drops
     the table's CHECK constraints, as someone with DDL rights could. Replay
     reads the rows, not the layout, so what refuses is the row's validation. */
  const tamper = async (table: string, sql: string) => {
    if (sqlite) {
      sqlite.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
      sqlite.exec(sql);
      sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF');
      return;
    }
    await engine.exec(`DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = '${runtimeTable('postgres', table).replaceAll("'", "''")}'::regclass
      LOOP EXECUTE format('ALTER TABLE mistri.%I DROP CONSTRAINT %I', '${runtimeName('postgres', table)}', c.conname); END LOOP; END $$`);
    await engine.exec(sql);
  };
  const assertLayout = async () => {
    if (connection) await assertPostgresCommandJournal(connection);
    else assertSqliteCommandJournal(sqlite!);
  };
  const count = async () => Number((await engine.get(`SELECT CAST(count(*) AS INTEGER) AS n FROM "${tables.receipt}"`))!.n);
  return { engine, run, rows, tamper, assertLayout, count };
}

test('platform provenance is its own shape: exact, frozen, and never accepted where a tenant is expected', () => {
  const captured = captureCommandJournalMember(structuredClone(platform));
  assert.deepEqual(captured, platform);
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.roles));
  assert.deepEqual(captureCommandJournalMember(structuredClone(tenant)), tenant);
  assert.throws(() => captureCommandJournalTenant(platform as unknown as CommandJournalTenant), Refusal);
  for (const forged of [
    { ...platform, tenantId: 'north' },
    { ...platform, platformVersion: '0' },
    { ...platform, realm: 'tenant' },
    { ...tenant, realm: 'platform' },
  ])
    assert.throws(() => captureCommandJournalPlatform(forged as unknown as CommandJournalPlatform), Refusal);
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`the journal and the platform realm on ${dialect}`, { skip }, () => {
    test('v4 is the only layout: a second migration is a no-op, and a journal at another version refuses unchanged', async (t) => {
      const f = await fixture(t, dialect);
      assert.deepEqual(await f.engine.migrateCommandJournal(), { version: 1, migrated: false });
      await f.assertLayout();
      await f.tamper(tables.meta, `UPDATE "${tables.meta}" SET version = 3`);
      await assert.rejects(f.assertLayout(), CommandJournalUnavailable);
      await assert.rejects(f.engine.migrateCommandJournal(), CommandJournalUnavailable);
      assert.equal(Number((await f.engine.get(`SELECT version FROM "${tables.meta}"`))!.version), 3);
    });

    test('the platform realm is its own receipt namespace: one command, actor and key never replays across realms', async (t) => {
      const f = await fixture(t, dialect);
      await f.run(platform, (journal) => journal.commit(receipt('platform'), [audit('north'), audit('south', 's1')]));
      assert.equal(await f.run(tenant, (journal) => journal.find(receipt())), undefined);
      assert.equal(await f.run(undefined, (journal) => journal.find(receipt())), undefined);
      await f.run(tenant, (journal) => journal.commit(receipt('tenant'), audit()));
      await f.run(undefined, (journal) => journal.commit(receipt('ordinary'), audit()));
      assert.equal(await f.count(), 3);
      assert.deepEqual(await f.run(platform, (journal) => journal.find(receipt())), receipt('platform'));
      assert.deepEqual(await f.run(tenant, (journal) => journal.find(receipt())), receipt('tenant'));
      // A later platform revision or grant replays the original receipt; the row keeps its own provenance.
      assert.deepEqual(
        await f.run({ ...platform, platformVersion: '9', membershipVersion: '4' }, (journal) => journal.find(receipt())),
        receipt('platform'),
      );
      assert.deepEqual(await f.engine.all(`SELECT id, realm, tenant_id FROM "${tables.receipt}" ORDER BY id`), [
        { id: 'ordinary', realm: 'tenant', tenant_id: '' },
        { id: 'platform', realm: 'platform', tenant_id: '' },
        { id: 'tenant', realm: 'tenant', tenant_id: 'north' },
      ]);
    });

    test("platform audit rows record each target's owner as read from its row; a tenant's realm records only itself", async (t) => {
      const f = await fixture(t, dialect);
      await f.run(platform, (journal) => journal.commit(receipt('platform-leads'), [audit('north'), audit('south', 's1')]));
      await f.run(platform, (journal) => journal.commit(receipt('platform-dealer', 'other-key'), audit('', 'north', 'dealer')));
      await f.run(tenant, (journal) => journal.commit(receipt('tenant'), audit()));
      const row = (
        receiptId: string,
        ordinal: number,
        realm: string,
        tenantId: string,
        owner: string,
        version: string,
        membership: string,
      ) => ({
        receipt_id: receiptId,
        ordinal,
        realm,
        tenant_id: tenantId,
        owner_tenant_id: owner,
        realm_version: version,
        membership_id: membership,
      });
      assert.deepEqual(await f.rows(), [
        row('platform-dealer', 0, 'platform', '', '', '3', 'platform-lee'),
        row('platform-leads', 0, 'platform', '', 'north', '3', 'platform-lee'),
        row('platform-leads', 1, 'platform', '', 'south', '3', 'platform-lee'),
        row('tenant', 0, 'tenant', 'north', 'north', '2', 'north-lee'),
      ]);
      // The platform realm never leaves an owner to be guessed, and no realm records a tenant it does not own.
      for (const [owner, entry] of [
        [platform, audit()],
        [platform, audit('North')],
        [platform, audit('@platform')],
        [tenant, audit('south')],
        [undefined, audit('north')],
      ] as const) {
        await assert.rejects(
          f.run(owner, (journal) => journal.commit(receipt('refused', 'refused-key'), entry)),
          Refusal,
        );
      }
      assert.equal(await f.count(), 3);
    });

    // A receipt is one row: its realm, tenant and provenance are the receipt's own columns, so what is left to
    // tamper with is the row's targets and the provenance it validates as history.
    const receiptTable = dialect === 'postgres' ? `public."${tables.receipt}"` : `"${tables.receipt}"`;
    const list = (...parts: string[]) =>
      dialect === 'postgres' ? `json_build_array(${parts.join(', ')})::text` : `json_array(${parts.join(', ')})`;
    const firstOwner = dialect === 'postgres' ? 'owners_json::json ->> 0' : "json_extract(owners_json, '$[0]')";
    for (const [label, sql, owner] of [
      [
        'a platform owner that names no tenant',
        `UPDATE ${receiptTable} SET owners_json = ${list(firstOwner, "'North Motors'")} WHERE id = 'platform'`,
        platform,
      ],
      ['a platform row whose roles are no list', `UPDATE ${receiptTable} SET roles_json = '{}' WHERE id = 'platform'`, platform],
      ['a platform version erased', `UPDATE ${receiptTable} SET realm_version = '' WHERE id = 'platform'`, platform],
      ['a platform row with a key short of its targets', `UPDATE ${receiptTable} SET keys_json = '[]' WHERE id = 'platform'`, platform],
      ['a tenant row owned by another tenant', `UPDATE ${receiptTable} SET owners_json = ${list("'south'")} WHERE id = 'tenant'`, tenant],
      ['a tenant receipt whose roles are no list', `UPDATE ${receiptTable} SET roles_json = '{}' WHERE id = 'tenant'`, tenant],
    ] as const)
      test(`replay refuses ${label}`, async (t) => {
        const f = await fixture(t, dialect);
        await f.run(platform, (journal) => journal.commit(receipt('platform'), [audit('north'), audit('south', 's1')]));
        await f.run(tenant, (journal) => journal.commit(receipt('tenant'), audit()));
        await f.tamper(tables.receipt, sql);
        await assert.rejects(
          f.run(owner, (journal) => journal.find(receipt())),
          Refusal,
        );
      });

    test('the platform realm writes no event batch and expects none', async (t) => {
      const f = await fixture(t, dialect);
      await assert.rejects(
        f.run(platform, (journal) => journal.commit(receipt(), audit('north'), {} as CommandEventBatch)),
        CommandJournalUnavailable,
      );
      await assert.rejects(
        f.run(platform, (journal) => journal.find(receipt(), {} as CommandEventManifest)),
        CommandJournalUnavailable,
      );
      assert.equal(await f.count(), 0);
    });
  });
