/**
 * App-scope command events. An ordinary App, with no tenancy, emits its
 * commands' declared facts through the event source trusted startup code
 * issues for it: in the command's own transaction, with its effects,
 * receipt and audit, under the ordinary empty receipt namespace, naming no
 * tenant. SQLite always; PostgreSQL when `TABLEWALK_TEST_PG` names a
 * disposable database this file resets.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import {
  COMMAND_JOURNAL_TABLES as journal,
  migrateSqliteCommandJournal,
  recoverSqliteCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import {
  COMMAND_EVENT_TABLES as eventTables,
  provisionSqliteCommandEventStore,
} from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import type { CommandEventEnvelope } from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import { EventDeliveryUnavailable } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { assertEventSourceEnvelope } from '../packages/mistri/src/adapters/events/eventSourceIdentity.js';
import { provisionPostgresCommandEventStore } from '../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import { PgConnectionManager, type PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands, issueAppScopeCommandEvents } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  defineCommands,
  getCommandEvents,
  type AnyBusinessCommand,
  type BusinessCommandActor,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { JournalTransactionOptions } from '../packages/engine/src/adapters/storeHost.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const APP = 'loan-desk';
const source = { appId: APP, storeId: 'loan-desk-events', sourceId: 'operations' };
const actor: BusinessCommandActor = { id: 'account-a', appId: APP, roles: ['reviewer'] };
type Output = { loanId: number; reviewer: string; version: number };
const assigned = defineEvent('loan.assigned', shape({ loanId: int(), reviewer: text() }));
const projection = () => defineEventProjection(assigned, (output: Output) => ({ loanId: output.loanId, reviewer: output.reviewer }));
const request = (overrides: Record<string, unknown> = {}) => ({
  command: 'assign',
  commandVersion: 1,
  key: { id: 1 },
  input: { reviewer: 'Ada' },
  expectedVersion: 0,
  idempotencyKey: 'assign-request-0001',
  ...overrides,
});

function command(options: { events?: boolean; source?: string } = {}): AnyBusinessCommand {
  return defineCommand({
    source: options.source ?? 'operations',
    target: 'loan',
    input: { reviewer: { label: 'Reviewer', type: 'text' } },
    output: { parse: (value: unknown) => value as Output },
    ...(options.events === false ? {} : { events: { assigned: projection() } }),
    async handle({ db, record: loan }, input) {
      const { version } = await db.loan.update(loan, { reviewer: input.reviewer });
      return { loanId: Number(loan.id), reviewer: input.reviewer, version: Number(version) };
    },
  });
}

interface Store {
  readonly url: string;
  readonly physical: string;
  provisionEvents(): Promise<void>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<void>;
  /** Makes the event insert inside the command's transaction fail; returns the restore. */
  failEventAppend(): () => void;
}
interface Engine {
  readonly name: string;
  readonly skip: false | string;
  setup(t: TestContext): Promise<Store>;
}

const sqlite: Engine = {
  name: 'sqlite',
  skip: false,
  async setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-events-')),
      path = join(directory, 'loans.db');
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE loans (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, reviewer TEXT NOT NULL); INSERT INTO loans VALUES (1, 0, 'Unassigned')",
    );
    migrateSqliteCommandJournal(path);
    t.after(() => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return {
      url: path,
      physical: 'loans',
      provisionEvents: async () => {
        provisionSqliteCommandEventStore(path, source);
      },
      rows: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
      exec: async (sql) => {
        db.exec(sql);
      },
      failEventAppend() {
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (sql) {
          if (sql.startsWith(`INSERT INTO main."${eventTables.event}"`)) throw new Error('storage unavailable');
          return Reflect.apply(prepare, this, [sql]);
        };
        return () => {
          DatabaseSync.prototype.prepare = prepare;
        };
      },
    };
  },
};

const postgres: Engine = {
  name: 'postgres',
  skip: liveSkip('postgres', LIVE_PG),
  async setup(t) {
    // This run's own database: the drops below take whole event and journal
    // namespaces with them.
    const url = await ownedPostgresDatabase();
    const control = await pgControl(url);
    for (const sql of [
      `DROP TABLE IF EXISTS ${runtimeTable('postgres', eventTables.event)}, ${runtimeTable('postgres', eventTables.meta)} CASCADE`,
      `DROP TABLE IF EXISTS ${runtimeTable('postgres', journal.receipt)}, ${runtimeTable('postgres', journal.meta)} CASCADE`,
      'DROP TABLE IF EXISTS public.loans CASCADE',
      'CREATE TABLE public.loans (id integer PRIMARY KEY, version integer NOT NULL, reviewer text NOT NULL)',
      "INSERT INTO public.loans VALUES (1, 0, 'Unassigned')",
    ])
      await control.query(sql);
    await migratePostgresCommandJournal(url);
    t.after(() => control.end());
    return {
      url: url,
      physical: 'public.loans',
      provisionEvents: async () => {
        await provisionPostgresCommandEventStore(url, source);
      },
      rows: async (sql) => (await control.query(postgresRuntimeSql(sql))).rows,
      exec: async (sql) => {
        await control.query(postgresRuntimeSql(sql));
      },
      failEventAppend() {
        const original = PgConnectionManager.prototype.withWriteClient;
        PgConnectionManager.prototype.withWriteClient = function <T>(
          this: PgConnectionManager,
          run: (client: PgQuery) => Promise<T>,
          destroyAfter?: boolean,
        ) {
          return original.call(
            this,
            (client) =>
              run({
                query: ((text: unknown, values?: unknown[]) =>
                  typeof text === 'string' && text.startsWith(`INSERT INTO ${runtimeTable('postgres', eventTables.event)}`)
                    ? Promise.reject(new Error('storage unavailable'))
                    : (client.query as (text: unknown, values?: unknown[]) => unknown)(text, values)) as PgQuery['query'],
              }),
            destroyAfter,
          ) as Promise<T>;
        };
        return () => {
          PgConnectionManager.prototype.withWriteClient = original;
        };
      },
    };
  },
};

async function desk(t: TestContext, engine: Engine, options: { provision?: boolean; registry?: Record<string, AnyBusinessCommand> } = {}) {
  const store = await engine.setup(t);
  if (options.provision !== false) await store.provisionEvents();
  const registry = new Registry();
  t.after(() => registry.closeAll());
  registry.add({ id: 'loans', name: 'Loans', url: store.url, writable: true, source: 'config' });
  const app = parseAppConfig(
    {
      id: APP,
      name: 'Loan desk',
      sources: { operations: { connection: 'loans' } },
      resources: { loan: { physical: store.physical, access: 'write' } },
      auth: { roles: { reviewer: { read: true, commands: Object.keys(options.registry ?? { assign: true }) } } },
      views: { loans: { kind: 'list', from: 'loan' } },
      home: 'loans',
    },
    'app-scope events fixture',
  );
  const resources = await loadAppRuntimeResources(registry, app, 'loans');
  const commands = defineCommands(options.registry ?? { assign: command() });
  const bind = (events?: unknown) =>
    bindBusinessCommands({
      app,
      registry: commands,
      resources,
      writableConnection: () => true,
      ...(events === undefined ? {} : { events: events as ReturnType<typeof issueAppScopeCommandEvents> }),
    });
  const binding = bind(issueAppScopeCommandEvents(source));
  const count = async (table: string, where = 'true') =>
    Number(Object.values((await store.rows(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`))[0])[0]);
  const loan = async () => (await store.rows(`SELECT version, reviewer FROM ${store.physical} WHERE id = 1`))[0];
  return {
    ...store,
    app,
    bind,
    binding,
    count,
    loan,
    execute: (overrides: Record<string, unknown> = {}) => executeBusinessCommand(binding, actor, request(overrides)),
  };
}
const notApplied = (error: unknown) => error instanceof BusinessCommandExecutionError && error.outcome === 'not_applied';

test('private SQLite recovery retains genuine App event manifest and corruption checks', async (t) => {
  const d = await desk(t, sqlite);
  const applied = await d.execute();
  const adapter = new SqliteAdapter(d.url);
  t.after(() => adapter.close());
  const scope = { appId: APP, actorId: actor.id, commandId: 'assign', commandVersion: 1, idempotencyKey: 'assign-request-0001' };
  const manifest = getCommandEvents(command())!.expectation;
  const events = issueAppScopeCommandEvents(source);
  await commandsOf(adapter).commandTransaction(async (_tx, store) => {
    const found = await recoverSqliteCommandReceipt(store, scope, manifest);
    assert.ok(found);
    assert.equal(found.receipt.id, applied.receiptId);
    assert.deepEqual(found.targets, [{ target: 'loan', keyJson: '{"id":1}' }]);
    assert.deepEqual(await store.find(scope, manifest), found.receipt);
  }, events);
  await d.exec('DELETE FROM "' + eventTables.event + '"');
  await assert.rejects(
    commandsOf(adapter).commandTransaction(async (_tx, store) => recoverSqliteCommandReceipt(store, scope, manifest), events),
  );
  await assert.rejects(commandsOf(adapter).commandTransaction(async (_tx, store) => store.find(scope, manifest), events));
});

test('SQLite verified ordinary final refusal rolls back genuine App-scope events, receipt, audit and effects', async (t) => {
  // desk() provisions the native event store and binds the command with the
  // genuine issueAppScopeCommandEvents source used by normal startup tests.
  const d = await desk(t, sqlite);
  let checks = 0,
    sawPendingEvents = false;
  /* The binding's ordinary command transaction, run as a verified one: the
     adapter's journal primitive (lent through its store host) is handed the
     verifier the command owner would install. The events it then sees
     pending prove the binding passed its issued App event source. */
  const journalTransaction = Reflect.get(SqliteAdapter.prototype, 'journalTransaction') as (
    this: SqliteAdapter,
    kept: unknown,
    run: unknown,
    options?: JournalTransactionOptions<unknown>,
  ) => Promise<unknown>;
  t.mock.method(
    SqliteAdapter.prototype as unknown as { journalTransaction: typeof journalTransaction },
    'journalTransaction',
    function (this: SqliteAdapter, kept: unknown, run: unknown, options: JournalTransactionOptions<unknown> = {}) {
      assert.equal(options.scope, undefined, 'the genuine binding runs an ordinary command transaction');
      return journalTransaction.call(this, kept, run, {
        ...options,
        ordinaryVerify: () => {
          if (++checks !== 2) return;
          const writer = Reflect.get(this, 'writeDb') as DatabaseSync;
          for (const table of [journal.receipt, eventTables.event]) {
            assert.equal(writer.prepare('SELECT count(*) AS n FROM "' + table + '"').get()?.n, 1);
          }
          assert.equal(writer.prepare('SELECT count(*) AS n FROM "' + journal.receipt + '" WHERE manifest_json IS NOT NULL').get()?.n, 1);
          sawPendingEvents = true;
          throw new Error('owner retired after event append');
        },
      });
    },
  );
  await assert.rejects(d.execute(), notApplied);
  assert.equal(checks, 2);
  assert.equal(sawPendingEvents, true);
  assert.deepEqual({ ...(await d.loan()) }, { version: 0, reviewer: 'Unassigned' });
  for (const table of [journal.receipt, eventTables.event]) assert.equal(await d.count(table), 0);
  t.mock.restoreAll();
  const applied = await d.execute();
  assert.equal(applied.replayed, false, 'rolled-back receipt must not answer the retry');
  for (const table of [journal.receipt, eventTables.event]) assert.equal(await d.count(table), 1);
  assert.equal(await d.count(journal.receipt, 'manifest_json IS NOT NULL'), 1);
});

for (const engine of [sqlite, postgres])
  describe(`App-scope command events on ${engine.name}`, { skip: engine.skip }, () => {
    test('an App-scope command commits its events with its effects, receipt and audit, under the empty namespace and naming no tenant', async (t) => {
      const d = await desk(t, engine);
      const result = await d.execute();
      assert.equal(result.status, 'applied');
      assert.equal(result.replayed, false);
      assert.deepEqual({ ...(await d.loan()) }, { version: 1, reviewer: 'Ada' });
      const [receipt] = await d.rows(`SELECT id, store_id, source_id, tenant_id FROM "${journal.receipt}"`);
      assert.deepEqual({ ...receipt }, { id: result.receiptId, store_id: '', source_id: '', tenant_id: '' });
      const [audit] = await d.rows(
        `SELECT membership_id, membership_version, realm_version, roles_json, deployment FROM "${journal.receipt}"`,
      );
      assert.deepEqual({ ...audit }, { membership_id: '', membership_version: '', realm_version: '', roles_json: '[]', deployment: '' });
      assert.equal(await d.count(journal.receipt, 'manifest_json IS NOT NULL'), 1);
      const events = await d.rows(`SELECT event_id, envelope_json FROM "${eventTables.event}"`);
      assert.equal(events.length, 1);
      const envelope = JSON.parse(String(events[0].envelope_json)) as CommandEventEnvelope;
      assert.match(envelope.requestId, /^[A-Za-z0-9_-]{1,128}$/);
      assert.deepEqual(envelope, {
        envelopeVersion: 2,
        eventId: events[0].event_id,
        ordinal: 0,
        name: 'loan.assigned',
        version: 1,
        appId: APP,
        storeId: source.storeId,
        sourceId: source.sourceId,
        scope: 'app',
        actorId: actor.id,
        commandId: 'assign',
        commandVersion: 1,
        resource: 'loan',
        key: { id: 1 },
        receiptId: result.receiptId,
        requestId: envelope.requestId,
        occurredAt: envelope.occurredAt,
        correlationId: envelope.requestId,
        causation: { kind: 'command', receiptId: result.receiptId },
        payloadJson: '{"loanId":1,"reviewer":"Ada"}',
      });
      assert.equal(Object.hasOwn(envelope, 'tenantId'), false);
      assert.doesNotThrow(() => assertEventSourceEnvelope(envelope, source));
    });

    test('a replay answers from the receipt and never generates events again', async (t) => {
      const d = await desk(t, engine);
      const first = await d.execute();
      const [event] = await d.rows(`SELECT event_id FROM "${eventTables.event}"`);
      const replay = await d.execute();
      assert.equal(replay.replayed, true);
      assert.equal(replay.receiptId, first.receiptId);
      assert.deepEqual(
        (await d.rows(`SELECT event_id FROM "${eventTables.event}"`)).map((row) => row.event_id),
        [event.event_id],
      );
      assert.equal(await d.count(journal.receipt), 1);
      await assert.rejects(
        d.execute({ input: { reviewer: 'Grace' } }),
        (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'idempotency_conflict',
      );
      assert.equal(await d.count(eventTables.event), 1);
    });

    test('a failed event append rolls back the effects, receipt, audit and batch together', async (t) => {
      const d = await desk(t, engine);
      const restore = d.failEventAppend();
      try {
        await assert.rejects(d.execute(), notApplied);
      } finally {
        restore();
      }
      assert.deepEqual({ ...(await d.loan()) }, { version: 0, reviewer: 'Unassigned' });
      for (const table of [journal.receipt, eventTables.event]) assert.equal(await d.count(table), 0, table);
      assert.equal((await d.execute()).status, 'applied');
      assert.equal(await d.count(eventTables.event), 1);
    });

    test('a missing event store refuses the command before any write', async (t) => {
      const d = await desk(t, engine, { provision: false });
      await assert.rejects(d.execute(), notApplied);
      assert.deepEqual({ ...(await d.loan()) }, { version: 0, reviewer: 'Unassigned' });
      assert.equal(await d.count(journal.receipt), 0);
    });

    test('a command without events on the same binding keeps the plain journal and writes no batch', async (t) => {
      const d = await desk(t, engine, { registry: { assign: command(), note: command({ events: false }) } });
      const result = await executeBusinessCommand(d.binding, actor, request({ command: 'note', idempotencyKey: 'note-request-0001' }));
      assert.equal(result.status, 'applied');
      assert.equal(await d.count(journal.receipt, 'manifest_json IS NOT NULL'), 0);
      assert.equal((await d.execute({ expectedVersion: 1 })).status, 'applied');
      assert.equal(await d.count(journal.receipt, 'manifest_json IS NOT NULL'), 1);
    });

    test('only the event source issued at startup for this App lets a binding emit', async (t) => {
      const d = await desk(t, engine);
      const refused = (error: unknown) => error instanceof BusinessCommandDefinitionError;
      assert.throws(() => d.bind(), refused);
      assert.throws(() => d.bind({ scope: 'app', ...source }), refused);
      assert.throws(() => d.bind(issueAppScopeCommandEvents({ ...source, appId: 'another-app' })), refused);
      assert.throws(() => d.bind(issueAppScopeCommandEvents({ ...source, sourceId: 'elsewhere' })), refused);
    });
  });

test('a command that targets many records still cannot declare events', () => {
  assert.throws(
    () =>
      defineCommand({
        source: 'operations',
        target: 'loan',
        targets: 'many',
        read: ['loan'],
        write: ['loan'],
        input: {},
        output: { parse: (value: unknown) => value as Output },
        events: { assigned: projection() },
        async handle() {
          return { loanId: 1, reviewer: 'x', version: 1 };
        },
      } as never),
    BusinessCommandDefinitionError,
  );
});

test('an App-scope route delivers App-scope facts; a tenant route never takes them', async (t) => {
  const app = eventDeliveryFixture(t, eventDeliveryPolicy(1, 'app'));
  const [event] = await app.seed();
  assert.equal(event.scope, 'app');
  assert.equal(Object.hasOwn(event, 'tenantId'), false);
  const store = app.open();
  assert.deepEqual(await store.discover(), { scanned: 1, scheduled: 1, pressure: false });
  assert.equal((await store.claim(1_000))!.envelope.eventId, event.eventId);
  assert.throws(() => assertEventSourceEnvelope({ ...event, tenantId: 'north' }, app.policy.source), EventDeliveryUnavailable);
  assert.throws(() => assertEventSourceEnvelope({ ...event, scope: 'tenant' }, app.policy.source), EventDeliveryUnavailable);
  const tenant = eventDeliveryFixture(t, eventDeliveryPolicy(1, 'tenant'));
  await tenant.seed('app-receipt', eventDeliveryPolicy(1, 'app').routes[0]);
  const other = tenant.open();
  assert.deepEqual(await other.discover(), { scanned: 1, scheduled: 0, pressure: false });
  assert.equal(await other.claim(1_000), undefined);
});
