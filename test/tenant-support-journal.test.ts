/** Actual journal dispatch only: no support-session admission or audit-chain claim. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  createSqliteTenantAdministrationJournal,
  provisionSqliteTenantAdministrationJournal,
  ADMINISTRATION_JOURNAL_TABLES,
  type TenantAdministrationJournal,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import {
  createPostgresTenantAdministrationJournal,
  migratePostgresTenantAdministrationJournal,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantEngine } from './support/tenantDialects.js';
import { journal as sample, exit } from './support/supportJournalFixture.js';

const binding = { appId: 'app', source: { id: 'business', connection: 'business' }, storeId: 'store' };
const setup = {
  sqlite: "CREATE TABLE db_item(id integer PRIMARY KEY, value text); INSERT INTO db_item VALUES(1,'original')",
  postgres: "CREATE TABLE public.db_item(id integer PRIMARY KEY, value text); INSERT INTO public.db_item VALUES(1,'original')",
  tables: ['db_item'],
};
const scope = (receipt: ReturnType<typeof sample>['receipt']) => ({
  actorId: receipt.actorId,
  tenantId: receipt.tenantId,
  operation: receipt.operation,
  operationVersion: receipt.operationVersion,
  idempotencyKey: receipt.idempotencyKey,
});

async function transaction<T>(
  engine: TenantEngine,
  work: (journal: TenantAdministrationJournal, operations: TransactionOperations, update: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const client = engine.dialect === 'postgres' ? await engine.session() : null;
  const db = client ? null : engine.sqlite();
  const execute = async (sql: string) => {
    if (client) await client.query(sql);
    else db!.exec(sql);
  };
  await execute(engine.begin);
  const operations = new TransactionOperations();
  try {
    const journal = client
      ? createPostgresTenantAdministrationJournal(client, operations, binding)
      : createSqliteTenantAdministrationJournal(db!, operations, binding);
    const result = await work(journal, operations, () => execute("UPDATE db_item SET value='must rollback' WHERE id=1"));
    await operations.finish();
    await execute('COMMIT');
    return result;
  } catch (error) {
    await operations.finish().catch(() => {});
    await execute('ROLLBACK');
    throw error;
  }
}

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its journal tables reset under it. */
const DATABASE = `support_journal_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: support journal commit/recovery dispatch rejects tampered historical attribution`, { skip }, async () => {
    const engine = await openTenantEngine(dialect, { ...setup, database: DATABASE });
    try {
      await engine.provisionStore(binding);
      if (dialect === 'sqlite') provisionSqliteTenantAdministrationJournal(engine.path, binding);
      else await migratePostgresTenantAdministrationJournal(engine.url, binding);
      for (const change of [undefined, exit()]) {
        const { receipt, audit } = sample(change);
        await transaction(engine, (journal) => journal.commit(receipt, audit));
        const recovered = await transaction(engine, (journal) => journal.read(scope(receipt)));
        assert.deepEqual(JSON.parse(JSON.stringify(recovered)), receipt);
        await engine.exec(`UPDATE "${ADMINISTRATION_JOURNAL_TABLES.receipt}" SET session_id=? WHERE id=?`, ['wrong-login', receipt.id]);
        await assert.rejects(
          transaction(engine, (journal) => journal.read(scope(receipt))),
          TenantContextError,
        );
      }
    } finally {
      await engine.close();
    }
  });

  test(`${dialect}: caught malformed support commit poisons the journal transaction and rolls back prior work`, { skip }, async () => {
    const engine = await openTenantEngine(dialect, { ...setup, database: DATABASE });
    try {
      await engine.provisionStore(binding);
      if (dialect === 'sqlite') provisionSqliteTenantAdministrationJournal(engine.path, binding);
      else await migratePostgresTenantAdministrationJournal(engine.url, binding);
      const { receipt, audit } = sample();
      await assert.rejects(
        transaction(engine, async (journal, operations, update) => {
          await operations.run(update);
          await assert.rejects(journal.commit(receipt, { ...audit, sessionId: 'foreign' }), TenantContextError);
          let later = false;
          await assert.rejects(
            operations.run(async () => {
              later = true;
            }),
          );
          assert.equal(later, false);
        }),
        TenantContextError,
      );
      assert.equal((await engine.get('SELECT value FROM db_item WHERE id=1'))!.value, 'original');
      for (const name of [ADMINISTRATION_JOURNAL_TABLES.receipt]) {
        assert.equal(Number((await engine.get(`SELECT count(*) AS n FROM "${name}"`))!.n), 0);
      }
    } finally {
      await engine.close();
    }
  });
}
