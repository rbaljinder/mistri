/** Private ordinary verifier; owned native fixture, no bearer activation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery, PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { CommandTransactionFailure, COMMAND_JOURNAL_TABLES as tables } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { postgresAuditRows } from './support/commandTargets.js';
import type { CommandJournal, StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionPostgresCommandEventStore } from '../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import { COMMAND_EVENT_TABLES as eventTables } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { liveSkip } from './live.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const receipt: StoredCommandReceipt = {
  id: 'verified-receipt',
  appId: 'app',
  actorId: 'account',
  commandId: 'edit',
  commandVersion: 1,
  idempotencyKey: 'verified-attempt',
  fingerprint: 'digest',
  resultJson: '{"ok":true}',
  requestId: 'verified-request',
  completedAt: '2026-09-14T12:00:00.000Z',
};
const audit = { target: 'public.ticket', keyJson: '{"id":1}', changesJson: '[]' };
const update = { table: 'public.ticket', key: { id: 1 }, values: { name: 'Changed' } };
const failure = (outcome: 'unknown' | 'not_applied', cause?: unknown) => (error: unknown) => {
  assert.ok(error instanceof CommandTransactionFailure);
  assert.equal(error.outcome, outcome);
  if (cause) assert.equal(error.cause, cause);
  return true;
};

test('native PostgreSQL verified ordinary command transaction', { skip: liveSkip('postgres', LIVE), timeout: 120000 }, async (t) => {
  const module = 'pg';
  const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
  const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
  const database = `tw_verified_command_${randomUUID().replaceAll('-', '')}`;
  let owned = false,
    db: Client | undefined,
    adapter: PostgresAdapter | undefined;
  try {
    try {
      await control.connect();
    } catch {
      throw new Error('Verified-command fixture control connection failed.');
    }
    await control.query(`CREATE DATABASE ${quote(database)}`);
    owned = true;
    const url = new URL(LIVE!);
    url.pathname = `/${database}`;
    db = new pg.default.Client({ connectionString: url.href, statement_timeout: 5000 });
    try {
      await db.connect();
    } catch {
      throw new Error('Verified-command fixture connection failed.');
    }
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    await db.query("CREATE TABLE public.ticket(id integer PRIMARY KEY,name text NOT NULL); INSERT INTO public.ticket VALUES(1,'Original')");
    await migratePostgresCommandJournal(url.href);
    adapter = new PostgresAdapter(url.href, 'Owned verified command fixture');
    const client = db,
      source = adapter;
    const reset = async () => {
      await client.query(`DELETE FROM ${runtimeTable('postgres', tables.receipt)}; UPDATE public.ticket SET name='Original'`);
    };
    const unchanged = async () => {
      assert.equal((await client.query('SELECT name FROM public.ticket')).rows[0].name, 'Original');
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${runtimeTable('postgres', tables.receipt)}`)).rows[0].n), 0);
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${postgresAuditRows} a`)).rows[0].n), 0);
    };

    await t.test('entry and final verification surround drained work; replay namespace is unchanged', async () => {
      const order: string[] = [];
      let records: WriteTransaction | undefined, journal: CommandJournal | undefined;
      await commandsOf(source).verifiedCommandTransaction(
        async () => {
          order.push('verify');
        },
        async (tx, store) => {
          records = tx;
          journal = store;
          order.push('handler');
          void tx.update(update);
          void store.commit(receipt, audit);
          order.push('returned');
        },
      );
      assert.deepEqual(order, ['verify', 'handler', 'returned', 'verify']);
      await commandsOf(source).commandTransaction(async (_tx, store) => assert.deepEqual(await store.find(receipt), receipt));
      const namespace = (
        await client.query(`SELECT store_id,source_id,tenant_id,actor_id FROM ${runtimeTable('postgres', tables.receipt)}`)
      ).rows[0];
      assert.deepEqual(namespace, { store_id: '', source_id: '', tenant_id: '', actor_id: 'account' });
      await assert.rejects(records!.update(update));
      await assert.rejects(journal!.find(receipt));
      await reset();
    });

    await t.test('entry and final native refusal roll back all ordinary effects', async () => {
      for (const phase of [1, 2]) {
        let checks = 0,
          called = false;
        const cause = new Error('owner no longer eligible');
        await assert.rejects(
          commandsOf(source).verifiedCommandTransaction(
            async () => {
              if (++checks === phase) throw cause;
            },
            async (tx, store) => {
              called = true;
              await tx.update(update);
              await store.commit(receipt, audit);
            },
          ),
          failure('not_applied', cause),
        );
        assert.equal(called, phase === 2);
        await unchanged();
      }
    });

    await t.test('nonvoid verifier and rejected queued operation refuse without final disclosure', async () => {
      let called = false;
      await assert.rejects(
        commandsOf(source).verifiedCommandTransaction(
          async () => true,
          async () => {
            called = true;
          },
        ),
        failure('not_applied'),
      );
      assert.equal(called, false);
      let checks = 0;
      await assert.rejects(
        commandsOf(source).verifiedCommandTransaction(
          async () => {
            checks++;
          },
          async (tx, store) => {
            await tx.update(update);
            await store.commit(receipt, audit);
            void tx.insert({ table: 'public.ticket', values: { id: 1, name: 'Duplicate' } });
          },
        ),
        failure('not_applied'),
      );
      assert.equal(checks, 1);
      await unchanged();
    });

    await t.test('two native clients retain the ordinary per-scope execute-once lock', async () => {
      const second = new PostgresAdapter(url.href, 'Second owned writer');
      let executed = 0;
      const run = (writer: PostgresAdapter) =>
        commandsOf(writer).verifiedCommandTransaction(
          async () => {},
          async (tx, store) => {
            if (await store.find(receipt)) return;
            executed++;
            await tx.update(update);
            await store.commit(receipt, audit);
          },
        );
      try {
        await Promise.all([run(source), run(second)]);
        assert.equal(executed, 1);
      } finally {
        await second.close();
      }
      await reset();
    });

    await t.test('final verifier sees separately committed owner changes and rolls back declared events', async () => {
      await client.query(
        'CREATE TABLE public.authority_fixture(id integer PRIMARY KEY, eligible boolean NOT NULL); INSERT INTO public.authority_fixture VALUES(1,true)',
      );
      const binding = { appId: 'app', storeId: 'verified-event-store', sourceId: 'business' };
      await provisionPostgresCommandEventStore(url.href, binding);
      let checks = 0;
      await assert.rejects(
        commandsOf(source).verifiedCommandTransaction(
          async () => {
            checks++;
            // Native independently committed observation, not a fabricated bearer
            // capability or a test of cross-database atomic revocation.
            if (!(await client.query('SELECT eligible FROM public.authority_fixture')).rows[0].eligible) throw new Error('owner changed');
          },
          async (tx, store) => {
            await tx.update(update);
            await store.commit(receipt, audit, [{ name: 'ticket.changed', version: 1, payloadJson: '{"id":1}' }]);
            await client.query('UPDATE public.authority_fixture SET eligible=false');
          },
          { scope: 'app', ...binding },
        ),
        failure('not_applied'),
      );
      assert.equal(checks, 2);
      await unchanged();
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${runtimeTable('postgres', eventTables.event)}`)).rows[0].n), 0);
      assert.equal(
        Number(
          (await client.query(`SELECT count(*) AS n FROM ${runtimeTable('postgres', tables.receipt)} WHERE manifest_json IS NOT NULL`))
            .rows[0].n,
        ),
        0,
      );
    });

    await t.test('failed rollback acknowledgement keeps verified refusal outcome unknown', async (sub) => {
      const manager = Reflect.get(source, 'connections') as PgConnectionManager;
      const original = manager.withWriteClient.bind(manager);
      const cause = new Error('entry authority refused');
      sub.mock.method(manager, 'withWriteClient', <T>(run: (write: PgQuery) => Promise<T>, destroy = false) =>
        original(
          (write) =>
            run({
              query: (async (request: string | { text: string }, params?: unknown[]) => {
                const result = typeof request === 'string' ? await write.query(request, params) : await write.query(request);
                if (request === 'ROLLBACK') throw new Error('lost rollback acknowledgement');
                return result;
              }) as PgQuery['query'],
            }),
          destroy,
        ),
      );
      await assert.rejects(
        commandsOf(source).verifiedCommandTransaction(
          async () => {
            throw cause;
          },
          async () => {
            assert.fail('Entry refusal must not execute handler');
          },
        ),
        failure('unknown', cause),
      );
      await unchanged();
    });

    await t.test('lost COMMIT acknowledgement remains unknown with a durable receipt', async (sub) => {
      const manager = Reflect.get(source, 'connections') as PgConnectionManager;
      const original = manager.withWriteClient.bind(manager);
      const cause = new Error('lost commit acknowledgement');
      const sequence: string[] = [];
      sub.mock.method(manager, 'withWriteClient', <T>(run: (write: PgQuery) => Promise<T>, destroy = false) =>
        original(
          (write) =>
            run({
              query: (async (request: string | { text: string }, params?: unknown[]) => {
                sequence.push(typeof request === 'string' ? request : request.text);
                const result = typeof request === 'string' ? await write.query(request, params) : await write.query(request);
                if (request === 'COMMIT') throw cause;
                return result;
              }) as PgQuery['query'],
            }),
          destroy,
        ),
      );
      await assert.rejects(
        commandsOf(source).verifiedCommandTransaction(
          async () => {
            sequence.push('verify');
          },
          async (tx, store) => {
            await tx.update(update);
            await store.commit(receipt, audit);
          },
        ),
        failure('unknown', cause),
      );
      assert.equal(sequence[sequence.lastIndexOf('verify') + 1], 'COMMIT');
      assert.equal((await client.query('SELECT name FROM public.ticket')).rows[0].name, 'Changed');
      assert.equal(Number((await client.query(`SELECT count(*) AS n FROM ${runtimeTable('postgres', tables.receipt)}`)).rows[0].n), 1);
    });
  } finally {
    await adapter?.close();
    await db?.end().catch(() => {});
    if (owned) {
      await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await control.query(`DROP DATABASE ${quote(database)}`);
    }
    await control.end().catch(() => {});
  }
});
