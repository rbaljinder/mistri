/** Private storage projection; no bearer or executor recovery activation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import type { PgQuery, PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import {
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  CommandTransactionFailure,
  type CommandJournal,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import {
  createPostgresCommandJournal,
  migratePostgresCommandJournal,
  recoverPostgresCommandReceipt,
} from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionPostgresCommandEventStore } from '../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_EVENT_TABLES } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { liveSkip } from './live.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { readPreparedRecord } from '../packages/mistri/src/server/commands/commandPrepare.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { recoverBusinessCommandReceipt } from '../packages/mistri/src/server/commands/businessCommandRecovery.js';
import { shape, bool } from '../packages/mistri/src/server/commands/commandShapes.js';
import { createApiCommandEnvelopeBundle } from '../packages/mistri/src/server/api/apiCommandEnvelope.js';
import { parseTestApi, parseTestApp } from './support/commandCatalog.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const receipt: StoredCommandReceipt = {
  id: 'receipt',
  appId: 'app',
  actorId: 'actor',
  commandId: 'edit',
  commandVersion: 1,
  idempotencyKey: 'attempt',
  fingerprint: 'digest',
  resultJson: '{"ok":true}',
  requestId: 'request',
  completedAt: '2026-09-14T12:00:00.000Z',
};
const audits = [
  { target: 'public.ticket', keyJson: '{"id":2}', changesJson: '[{"secret":"do not expose"}]' },
  { target: 'public.ticket', keyJson: '{"id":1}', changesJson: '[]' },
];

test('native PostgreSQL private ordinary receipt recovery', { skip: liveSkip('postgres', LIVE), timeout: 120000 }, async (t) => {
  const module = 'pg';
  const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
  const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
  const database = `tw_receipt_recovery_${randomUUID().replaceAll('-', '')}`;
  let owned = false,
    db: Client | undefined,
    adapter: PostgresAdapter | undefined;
  try {
    try {
      await control.connect();
    } catch {
      throw new Error('Recovery fixture control connection failed.');
    }
    await control.query(`CREATE DATABASE ${quote(database)}`);
    owned = true;
    const url = new URL(LIVE!);
    url.pathname = `/${database}`;
    db = new pg.default.Client({ connectionString: url.href, statement_timeout: 5000 });
    try {
      await db.connect();
    } catch {
      throw new Error('Recovery fixture connection failed.');
    }
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
    await db.query("CREATE TABLE public.ticket(id integer PRIMARY KEY,value text); INSERT INTO public.ticket VALUES(1,'before')");
    await migratePostgresCommandJournal(url.href);
    adapter = new PostgresAdapter(url.href, 'Owned receipt recovery fixture');
    const source = adapter,
      client = db;
    await commandsOf(source).commandTransaction(async (_tx, journal) => journal.commit(receipt, audits));

    await t.test('same lookup returns frozen ordered keys without audit change images', async () => {
      await commandsOf(source).commandTransaction(async (_tx, journal) => {
        assert.deepEqual(Object.keys(journal).sort(), ['commit', 'find', 'insert', 'kept', 'nextNumber', 'taken']);
        assert.deepEqual(await journal.find(receipt), receipt);
        const recovered = await recoverPostgresCommandReceipt(journal, receipt);
        assert.ok(recovered);
        assert.deepEqual(recovered, { receipt, targets: audits.map(({ target, keyJson }) => ({ target, keyJson })) });
        assert.ok(Object.isFrozen(recovered));
        assert.ok(Object.isFrozen(recovered.receipt));
        assert.ok(Object.isFrozen(recovered.targets));
        assert.ok(recovered.targets.every(Object.isFrozen));
        assert.equal(JSON.stringify(recovered).includes('do not expose'), false);
        for (const change of [
          { appId: 'other' },
          { actorId: 'other' },
          { commandId: 'other' },
          { commandVersion: 2 },
          { idempotencyKey: 'other' },
        ]) {
          assert.equal(await recoverPostgresCommandReceipt(journal, { ...receipt, ...change }), undefined);
        }
      });
    });

    await t.test('copied, proxied, tenant and completed journals cannot recover', async () => {
      let retained: CommandJournal | undefined;
      await commandsOf(source).commandTransaction(async (_tx, journal) => {
        retained = journal;
        for (const candidate of [{ ...journal }, new Proxy(journal, {})]) {
          await assert.rejects(recoverPostgresCommandReceipt(candidate, receipt), CommandJournalUnavailable);
        }
      });
      await assert.rejects(recoverPostgresCommandReceipt(retained!, receipt));
      const tenant = createPostgresCommandJournal(client, new TransactionOperations(), {
        appId: 'app',
        storeId: 'store',
        sourceId: 'source',
        tenantId: 'north',
        actorId: 'actor',
        membershipId: 'member',
        membershipVersion: '1',
        tenantVersion: '1',
        roles: ['reader'],
        deployment: 'deployment',
      });
      await assert.rejects(recoverPostgresCommandReceipt(tenant, receipt), CommandJournalUnavailable);
    });

    await t.test('storage projection preserves raw keys without claiming typed validity', async () => {
      for (const keyJson of ['42', '{"id":"9007199254740993"}', '{ "id": 9007199254740993 }']) {
        await client.query(
          `UPDATE ${runtimeTable('postgres', tables.receipt)} SET keys_json=json_build_array($1::text, keys_json::json ->> 1)::text WHERE id=$2`,
          [keyJson, receipt.id],
        );
        await commandsOf(source).commandTransaction(async (_tx, journal) => {
          assert.deepEqual(await journal.find(receipt), receipt);
          assert.equal((await recoverPostgresCommandReceipt(journal, receipt))?.targets[0].keyJson, keyJson);
        });
      }
      await client.query(
        `UPDATE ${runtimeTable('postgres', tables.receipt)} SET keys_json=json_build_array($1::text, keys_json::json ->> 1)::text WHERE id=$2`,
        [audits[0].keyJson, receipt.id],
      );
    });

    await t.test('caught damaged later target poisons transaction and rolls business work back', async () => {
      // The later target's key is gone: the receipt's arrays no longer line up.
      const intact = (await client.query(`SELECT keys_json FROM ${runtimeTable('postgres', tables.receipt)} WHERE id=$1`, [receipt.id]))
        .rows[0].keys_json;
      await client.query(
        `UPDATE ${runtimeTable('postgres', tables.receipt)} SET keys_json=json_build_array(keys_json::json ->> 0)::text WHERE id=$1`,
        [receipt.id],
      );
      await assert.rejects(
        commandsOf(source).commandTransaction(async (tx, journal) => {
          await tx.update({ table: 'public.ticket', key: { id: 1 }, values: { value: 'changed' } });
          await recoverPostgresCommandReceipt(journal, receipt).catch(() => {});
        }),
        (error) => error instanceof CommandTransactionFailure && error.outcome === 'not_applied',
      );
      assert.equal((await client.query('SELECT value FROM public.ticket')).rows[0].value, 'before');
      await assert.rejects(commandsOf(source).commandTransaction(async (_tx, journal) => journal.find(receipt)));
      await client.query(`UPDATE ${runtimeTable('postgres', tables.receipt)} SET keys_json=$1 WHERE id=$2`, [intact, receipt.id]);
    });

    await t.test('edits after the receipt read cannot replace the recovery facts of its one snapshot', async (sub) => {
      const manager = Reflect.get(source, 'connections') as PgConnectionManager;
      const original = manager.withWriteClient.bind(manager);
      let mutation: string | undefined;
      let changed = false;
      sub.mock.method(manager, 'withWriteClient', <T>(run: (write: PgQuery) => Promise<T>, destroy = false) =>
        original(
          (write) =>
            run({
              query: (async (request: string | { text: string }, params?: unknown[]) => {
                const result = typeof request === 'string' ? await write.query(request, params) : await write.query(request);
                const text = typeof request === 'string' ? request : request.text;
                if (mutation && !changed && text.startsWith('SELECT id, app_id')) {
                  changed = true;
                  // The receipt row (provenance and every target) is now detached in result.
                  // Pause its return while a different native client commits an edit to it.
                  // The command's advisory lock does not lock out direct table edits.
                  await client.query(`UPDATE ${runtimeTable('postgres', tables.receipt)} SET ${mutation} WHERE id=$1`, [receipt.id]);
                }
                return result;
              }) as PgQuery['query'],
            }),
          destroy,
        ),
      );
      for (const edit of [
        "target='public.other_ticket'",
        `keys_json='["{\\"id\\":102}","{\\"id\\":101}"]'`,
        "app_id='other-app', actor_id='other-actor'",
      ]) {
        mutation = edit;
        changed = false;
        // One row is one snapshot: the facts disclosed are the ones validated, whatever the edit.
        let disclosed: unknown;
        const rollback = new Error('roll back');
        try {
          await assert.rejects(
            commandsOf(source).commandTransaction(async (tx, journal) => {
              await tx.update({ table: 'public.ticket', key: { id: 1 }, values: { value: 'changed' } });
              disclosed = (await recoverPostgresCommandReceipt(journal, receipt))?.targets;
              throw rollback;
            }),
            (error) => error instanceof CommandTransactionFailure && error.outcome === 'not_applied',
          );
          assert.equal(changed, true);
          assert.deepEqual(
            disclosed,
            audits.map(({ target, keyJson }) => ({ target, keyJson })),
          );
          assert.equal((await client.query('SELECT value FROM public.ticket')).rows[0].value, 'before');
        } finally {
          mutation = undefined;
          await client.query(
            `UPDATE ${runtimeTable('postgres', tables.receipt)} SET target=$1, app_id=$2, actor_id=$3, keys_json=$4 WHERE id=$5`,
            [audits[0].target, receipt.appId, receipt.actorId, JSON.stringify(audits.map(({ keyJson }) => keyJson)), receipt.id],
          );
          await client.query("UPDATE public.ticket SET value='before' WHERE id=1");
        }
      }
      await commandsOf(source).commandTransaction(async (_tx, journal) => {
        assert.deepEqual(
          (await recoverPostgresCommandReceipt(journal, receipt))?.targets,
          audits.map(({ target, keyJson }) => ({ target, keyJson })),
        );
      });
    });

    await t.test('shared executor receipt recovers through a genuine PostgreSQL App binding', async () => {
      const registry = new Registry();
      try {
        registry.add({ id: 'business', name: 'Owned recovery App', url: url.href, writable: true, source: 'config' });
        const app = parseTestApp(
          {
            id: 'recovery-app',
            name: 'Recovery',
            sources: { business: { connection: 'business' } },
            resources: { ticket: { physical: 'public.ticket', access: 'write' } },
            auth: { roles: { editor: { read: true, commands: ['change'] }, viewer: { read: true } } },
            views: { tickets: { kind: 'list', from: 'ticket' } },
            home: 'tickets',
          },
          'owned recovery App',
        );
        let calls = 0;
        const commands = defineCommands({
          change: defineCommand({
            source: 'business',
            target: 'ticket',
            write: ['ticket'],
            input: {},
            output: {
              parse(value: unknown) {
                return value;
              },
            },
            async handle(context) {
              calls++;
              await context.tx.update({ table: 'ticket', key: { id: 1 }, values: { value: 'executed' } });
              return { ok: true };
            },
          }),
        });
        const resources = await loadAppRuntimeResources(registry, app, 'business');
        const binding = bindBusinessCommands({
          app,
          registry: commands,
          resources,
          writableConnection: (id) => registry.configOf(id)?.writable === true,
        });
        const actor = { id: 'account', appId: app.id, roles: ['editor'] };
        const scope = { command: 'change', commandVersion: 1, idempotencyKey: 'actual_pg_recovery_0001' };
        const authorized = binding.authorize('change', actor);
        const prepared = await authorized.transaction((records) =>
          readPreparedRecord(records, {
            command: authorized.command,
            commandId: 'change',
            actor,
            key: { id: 1 },
            catalog: authorized.catalog,
          }),
        );
        const applied = await executeBusinessCommand(binding, actor, {
          ...scope,
          key: { id: 1 },
          expectedVersion: prepared.expectedVersion,
          input: {},
        });
        // A successful command can delete its target later; receipt recovery
        // authorizes the historical scope, not current row existence.
        await client.query('DELETE FROM public.ticket WHERE id=1');
        const recovered = await recoverBusinessCommandReceipt(binding, actor, scope);
        if (recovered.status !== 'applied') assert.fail('Committed receipt must recover');
        assert.ok(recovered.targets.every((key) => Object.isFrozen(key) && Object.getPrototypeOf(key) === null));
        assert.deepEqual(
          { ...recovered, targets: recovered.targets.map((key) => ({ ...key })) },
          {
            status: 'applied',
            receiptId: applied.receiptId,
            command: 'change',
            commandVersion: 1,
            resource: 'ticket',
            targets: [{ id: 1 }],
            result: { ok: true },
            recovered: true,
          },
        );
        assert.equal(calls, 1);
        assert.deepEqual(await recoverBusinessCommandReceipt(binding, { ...actor, id: 'other' }, scope), {
          status: 'not_found',
          outcome: 'unknown',
        });
      } finally {
        await registry.closeAll();
      }
    });

    for (const many of [false, true])
      await t.test(
        `genuine PostgreSQL ${many ? 'many-target' : 'one-target'} execute and deleted-target recovery validate through the internal envelope bundle`,
        async () => {
          const physical = many ? 'envelope_ticket_many' : 'envelope_ticket';
          await client.query(
            `CREATE TABLE public.${physical}(part text NOT NULL,id integer NOT NULL,version integer NOT NULL,value text,PRIMARY KEY(part,id)); INSERT INTO public.${physical} VALUES('a',1,0,'before')`,
          );
          const registry = new Registry();
          try {
            registry.add({ id: 'business', name: 'Owned envelope App', url: url.href, writable: true, source: 'config' });
            const app = parseTestApp(
              {
                id: many ? 'envelope-many-app' : 'envelope-app',
                name: 'Envelope',
                sources: { business: { connection: 'business' } },
                resources: { entry: { physical: `public.${physical}`, access: 'write' } },
                auth: { roles: { editor: { read: true, commands: ['edit'] } } },
                views: { entries: { kind: 'list', from: 'entry' } },
                home: 'entries',
              },
              'owned envelope App',
            );
            let calls = 0;
            const commands = defineCommands({
              edit: defineCommand({
                source: 'business',
                target: 'entry',
                ...(many ? { targets: 'many' as const } : {}),
                input: {},
                output: shape({ ok: bool() }),
                async handle(context) {
                  calls++;
                  if (!many) await context.tx.update({ table: 'entry', key: { part: 'a', id: 1 }, values: { value: 'executed' } });
                  return { ok: true };
                },
              }),
            });
            const resources = await loadAppRuntimeResources(registry, app, 'business');
            const binding = bindBusinessCommands({
              app,
              registry: commands,
              resources,
              writableConnection: (id) => registry.configOf(id)?.writable === true,
            });
            // Only the private bundle receives future exposure: ordinary App loading remains unchanged.
            const exposed = {
              ...app,
              api: parseTestApi(
                {
                  version: 1,
                  roles: ['editor'],
                  commands: [{ id: 'edit', version: 1, target: 'entry', ...(many ? { targets: 'many' } : {}), input: {} }],
                },
                ['editor'],
              )!,
            };
            const operation = createApiCommandEnvelopeBundle(exposed, resources.schema, commands, {
              connectionFor: (resource) => resources.connectionFor(resource),
              writableConnection: (id) => registry.configOf(id)?.writable === true,
              transactionalConnection: () => true,
            }).operations[0];
            const ajv = new Ajv2020({ strict: true });
            const execute = ajv.compile(operation.schemas.executeResult),
              recover = ajv.compile(operation.schemas.recoveryResult);
            const actor = { id: 'account', appId: app.id, roles: ['editor'] };
            const scope = { command: 'edit', commandVersion: 1, idempotencyKey: 'actual_pg_envelope_0001' };
            const request = { ...scope, key: { part: 'a', id: '1' }, expectedVersion: 0, input: {} };
            operation.validateExecuteRequest(request);
            for (const replayed of [false, true]) {
              const result = await executeBusinessCommand(binding, actor, request);
              assert.equal(result.replayed, replayed);
              assert.equal(execute(result), true, JSON.stringify(execute.errors));
              operation.validateExecuteResult(request, result);
            }
            assert.equal(calls, 1);
            if (many) {
              const { key, expectedVersion, ...common } = request;
              const singleton = { ...common, keys: [key], expectedVersions: [expectedVersion] };
              const replay = await executeBusinessCommand(binding, actor, singleton);
              assert.equal(replay.replayed, true);
              assert.equal(execute(replay), true);
              operation.validateExecuteResult(singleton, replay);
              assert.equal(calls, 1);
              await client.query(`INSERT INTO public.${physical} VALUES('b',2,0,'before'),('c',3,0,'before')`);
              const bulk = {
                ...common,
                idempotencyKey: 'actual_pg_bulk_0001',
                keys: [
                  { part: 'b', id: 2 },
                  { part: 'c', id: '3' },
                ],
                expectedVersions: [0, 0],
              };
              for (const replayed of [false, true]) {
                const applied = await executeBusinessCommand(binding, actor, bulk);
                assert.equal(applied.replayed, replayed);
                assert.equal(execute(applied), true);
                operation.validateExecuteResult(bulk, applied);
              }
              await client.query(`DELETE FROM public.${physical} WHERE part IN ('b','c')`);
              const recoveredBulk = await recoverBusinessCommandReceipt(binding, actor, {
                command: 'edit',
                commandVersion: 1,
                idempotencyKey: bulk.idempotencyKey,
              });
              assert.equal(recoveredBulk.status, 'applied');
              assert.equal(recover(recoveredBulk), true);
              operation.validateRecoveryResult(recoveredBulk);
              assert.equal(calls, 2);
            }
            await client.query(`DELETE FROM public.${physical}`);
            operation.validateRecoveryRequest(scope);
            const recovered = await recoverBusinessCommandReceipt(binding, actor, scope);
            assert.equal(recovered.status, 'applied');
            assert.equal(recover(recovered), true, JSON.stringify(recover.errors));
            operation.validateRecoveryResult(recovered);
            const missing = await recoverBusinessCommandReceipt(binding, actor, { ...scope, idempotencyKey: 'missing_pg_envelope_0001' });
            assert.deepEqual(missing, { status: 'not_found', outcome: 'unknown' });
            assert.equal(recover(missing), true);
            operation.validateRecoveryResult(missing);
            assert.equal(calls, many ? 2 : 1, 'each distinct receipt invokes its handler once; replay and recovery never do');
          } finally {
            await registry.closeAll();
          }
        },
      );

    await t.test('App-scope recovery retains actual event manifest verification', async () => {
      const binding = { appId: 'app', storeId: 'recovery-event-store', sourceId: 'business' };
      await provisionPostgresCommandEventStore(url.href, binding);
      const eventReceipt = { ...receipt, id: 'event-receipt', idempotencyKey: 'event-attempt' };
      const owner = { scope: 'app' as const, ...binding };
      const manifest = [{ name: 'ticket.changed', version: 1 }];
      await commandsOf(source).commandTransaction(async (_tx, journal) => {
        await journal.commit(eventReceipt, audits[0], [{ ...manifest[0], payloadJson: '{"id":2}' }]);
      }, owner);
      await commandsOf(source).commandTransaction(async (_tx, journal) => {
        assert.equal((await recoverPostgresCommandReceipt(journal, eventReceipt, manifest))?.receipt.id, eventReceipt.id);
      }, owner);
      await client.query(`UPDATE ${runtimeTable('postgres', COMMAND_EVENT_TABLES.event)} SET envelope_json='{}' WHERE receipt_id=$1`, [
        eventReceipt.id,
      ]);
      await assert.rejects(
        commandsOf(source).commandTransaction(async (_tx, journal) => {
          await recoverPostgresCommandReceipt(journal, eventReceipt, manifest);
        }, owner),
      );
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
