import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_EVENT_TABLES, provisionSqliteCommandEventStore } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import {
  COMMAND_JOURNAL_TABLES,
  createSqliteCommandJournal,
  migrateSqliteCommandJournal,
  type CommandJournal,
  type CommandJournalTenant,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import {
  defineCommand,
  defineCommands,
  getCommandEvents,
  withCommandVersions,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection, projectCommandEvents } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape, type Shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { createTenantCommands } from '../packages/mistri/src/server/tenant/tenantCommands.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { parseTestApp } from './support/commandCatalog.js';

type Output = { version: number };
const selectedEvent = defineEvent('item.updated', shape({ version: int() }));
const body = {
  command: 'updateItem',
  commandVersion: 2,
  key: { id: 'north-row' },
  expectedVersion: 0,
  idempotencyKey: 'event-attempt-0001',
  input: {},
};
const principal = { cookie: 'alice' };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function refusal(outcome: 'unknown' | 'not_applied', code?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.outcome, outcome);
    if (code) assert.equal(error.code, code);
    return true;
  };
}

async function fixture(t: TestContext, events = true, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-event-execution-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  const owner = { appId: 'event-app', storeId: 'event-store', source: { id: 'business', connection: 'business-db' } };
  const services: ReturnType<typeof createTenantCommands<typeof principal>>[] = [];
  t.after(async () => {
    try {
      for (const service of services) await service.retire();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`CREATE TABLE db_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, version INTEGER NOT NULL);
    INSERT INTO db_item VALUES('north-row','north',0),('south-row','south',0)`);
  provisionSqliteTenantStore(path, owner);
  migrateSqliteCommandJournal(path);
  if (provision) provisionSqliteCommandEventStore(path, { appId: owner.appId, storeId: owner.storeId, sourceId: owner.source.id });
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  try {
    const admin = createSqliteTenantAdministration(db, operations, owner);
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      for (const accountId of ['alice', 'bob'])
        await admin.putMembership({
          tenantId,
          accountId,
          membershipId: `${tenantId}-${accountId}`,
          status: 'active',
          roles: ['editor'],
          validUntil: 10000,
          expectedVersion: null,
        });
    }
    await operations.finish();
    db.exec('COMMIT');
  } catch (error) {
    await operations.finish().catch(() => {});
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const resources = { item: 'db_item' },
    catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    resources,
    physicalSchema,
    schema: catalog.schema,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Events',
      sources: { business: { connection: owner.source.connection } },
      resources: {
        item: {
          physical: resources.item,
          access: 'write',
          fields: { read: ['id', 'version'], write: ['id', 'version'] },
          actions: { update: { label: 'Update', command: { id: 'updateItem', version: 2, target: 'item', input: {} } } },
        },
      },
      auth: { roles: { editor: { read: true, commands: ['updateItem'] } } },
      views: { item: { kind: 'list', from: 'item' } },
      home: 'item',
      nav: ['item'],
    },
    'event fixture',
  );
  const control = {
    handles: 0,
    projects: 0,
    outputValid: true,
    resultVisible: true,
    payloadValid: true,
    account: 'alice',
    denyCommitted: false,
    after: undefined as (() => void | Promise<void>) | undefined,
  };
  const declarations = {
    changed: defineEventProjection<Output, Output>(selectedEvent, (output) => {
      control.projects++;
      assert.ok(Object.isFrozen(output));
      return { version: control.payloadValid ? output.version : Infinity };
    }),
  };
  const output: Shape<Output> = {
    parse(value: unknown): Output {
      if (!control.outputValid) throw new Error('invalid');
      return value as Output;
    },
  };
  const command = defineCommand({
    source: 'business',
    target: 'item',
    input: {},
    output,
    ...(events ? { events: declarations } : {}),
    async handle({ db, record }) {
      control.handles++;
      const { version } = await db.item.update(record, { version: Number(record.version) + 1 });
      await control.after?.();
      return { version: Number(version) };
    },
  });
  const issue = async (registered = command) => {
    const reader = openSqliteTenantReadSource(path, ownership, owner, () => 1000);
    const writer = await openSqliteTenantWriteSource(path, ownership, owner, () => 1000);
    const service = createTenantCommands({
      app,
      reader,
      writer,
      deployment: 'event-deployment',
      roles: ['editor'],
      maxLifetimeMs: 5000,
      now: () => 1000,
      verifySession: () =>
        control.denyCommitted && db.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n !== 0
          ? null
          : { id: control.account, who: control.account, role: 'admin' },
      resolveMembershipRows: () => ({ item: true }),
      resolveRows: () => ({ item: true }),
      commands: {
        registry: withCommandVersions(defineCommands({ updateItem: registered }), () => 2),
        resultReferences: { updateItem: () => (control.resultVisible ? [] : [{ table: 'item', key: { id: 'south-row' } }]) },
      },
    });
    services.push(service);
    return service;
  };
  const count = (table: string, where = 'true') => db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`).get()!.n;
  /** The receipts that carry an event batch (the batch is receipt columns, all null when no events were emitted). */
  const batches = () => count(COMMAND_JOURNAL_TABLES.receipt, 'manifest_json IS NOT NULL');
  return {
    db,
    path,
    owner,
    control,
    declarations,
    command,
    issue,
    count,
    batches,
    version: () => db.prepare("SELECT version FROM db_item WHERE id='north-row'").get()!.version,
  };
}

test('genuine tenant execution atomically saves events and restart/replay/status never project again', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const first = await service.execute(principal, ['north'], body, { requestId: 'first-request' });
  assert.equal(f.version(), 1);
  assert.equal(f.control.projects, 1);
  assert.equal(f.control.handles, 1);
  for (const table of [...Object.values(COMMAND_JOURNAL_TABLES).slice(1), COMMAND_EVENT_TABLES.event]) {
    assert.equal(f.count(table), 1);
  }
  assert.equal(f.batches(), 1);
  const rows = f.db.prepare(`SELECT * FROM "${COMMAND_EVENT_TABLES.event}"`).all();
  const stored = JSON.parse(String(rows[0].envelope_json));
  assert.equal(stored.tenantId, 'north');
  assert.equal(stored.actorId, 'alice');
  assert.equal(stored.requestId, 'first-request');
  assert.equal(stored.receiptId, first.receiptId);
  assert.deepEqual(JSON.parse(stored.payloadJson), { version: 1 });
  await service.retire();
  const reopened = await f.issue();
  f.control.payloadValid = false;
  assert.deepEqual(plain(await reopened.execute(principal, ['north'], body)), { ...plain(first), replayed: true });
  assert.deepEqual(plain(await reopened.status(principal, ['north'], body)), { ...plain(first), replayed: true });
  assert.equal(f.control.projects, 1);
  assert.equal(f.control.handles, 1);
  assert.deepEqual(f.db.prepare(`SELECT * FROM "${COMMAND_EVENT_TABLES.event}"`).all(), rows);
});

test('independent tenant connections collapse duplicate execution into the original event batch', async (t) => {
  const f = await fixture(t),
    first = await f.issue(),
    second = await f.issue();
  const replies = await Promise.all([first.execute(principal, ['north'], body), second.execute(principal, ['north'], body)]);
  assert.equal(replies[0].receiptId, replies[1].receiptId);
  assert.deepEqual(replies.map((reply) => reply.replayed).sort(), [false, true]);
  assert.equal(f.control.handles, 1);
  assert.equal(f.control.projects, 1);
  assert.equal(f.count(COMMAND_EVENT_TABLES.event), 1);
});

test('named declarations are captured at defineCommand before the author mutates its original map', async (t) => {
  const f = await fixture(t);
  Reflect.set(
    f.declarations,
    'changed',
    defineEventProjection<Output, Output>(selectedEvent, () => {
      throw new Error('replaced');
    }),
  );
  assert.ok(Object.isFrozen(f.command.events));
  const service = await f.issue();
  await service.execute(principal, ['north'], body);
  assert.equal(f.control.projects, 1);
  assert.equal(f.count(COMMAND_EVENT_TABLES.event), 1);
});

test('postcommit session refusal preserves unknown outcome and the original event IDs for reconciliation', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  f.control.denyCommitted = true;
  await assert.rejects(service.execute(principal, ['north'], body), refusal('unknown'));
  assert.equal(f.version(), 1);
  assert.equal(f.count(COMMAND_JOURNAL_TABLES.receipt), 1);
  const events = f.db.prepare(`SELECT * FROM "${COMMAND_EVENT_TABLES.event}"`).all();
  assert.equal(events.length, 1);
  f.control.denyCommitted = false;
  const status = await service.status(principal, ['north'], body);
  assert.equal(status.status, 'applied');
  if (status.status === 'applied') assert.equal(status.replayed, true);
  assert.deepEqual(f.db.prepare(`SELECT * FROM "${COMMAND_EVENT_TABLES.event}"`).all(), events);
  assert.equal(f.control.projects, 1);
  assert.equal(f.control.handles, 1);
});

for (const denied of ['outputValid', 'resultVisible', 'payloadValid'] as const) {
  test(`${denied} refusal rolls back domain effects, receipt, audit and event batch`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    f.control[denied] = false;
    await assert.rejects(
      service.execute(principal, ['north'], body),
      refusal('not_applied', denied === 'resultVisible' ? 'forbidden' : 'invalid_result'),
    );
    assert.equal(f.version(), 0);
    assert.equal(f.control.projects, denied === 'payloadValid' ? 1 : 0);
    for (const table of [COMMAND_JOURNAL_TABLES.receipt, COMMAND_EVENT_TABLES.event]) {
      assert.equal(f.count(table), 0);
    }
  });
}

test('an emitting lookup attests missing storage even when there is no receipt', async (t) => {
  const f = await fixture(t, true, false),
    service = await f.issue();
  await assert.rejects(service.status(principal, ['north'], body), refusal('unknown'));
  await assert.rejects(service.execute(principal, ['north'], body), refusal('unknown'));
  assert.equal(f.control.handles, 0);
  assert.equal(f.control.projects, 0);
  assert.equal(f.version(), 0);
});

test('non-emitting tenant commands keep their existing unprovisioned storage path', async (t) => {
  const f = await fixture(t, false, false),
    service = await f.issue();
  const first = await service.execute(principal, ['north'], body);
  assert.deepEqual(plain(await service.status(principal, ['north'], body)), { ...plain(first), replayed: true });
  assert.equal(f.control.projects, 0);
  assert.equal(f.version(), 1);
});

test('current result authorization and tenant/actor isolation still fence historical event receipts', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  await service.execute(principal, ['north'], body);
  f.control.resultVisible = false;
  await assert.rejects(service.status(principal, ['north'], body), refusal('unknown', 'forbidden'));
  assert.equal(f.control.projects, 1);
  assert.equal(f.control.handles, 1);
  f.control.resultVisible = true;
  f.control.account = 'bob';
  assert.deepEqual(plain(await service.status(principal, ['north'], body)), { status: 'not_found', outcome: 'unknown' });
  assert.deepEqual(plain(await service.status(principal, ['south'], { ...body, key: { id: 'south-row' } })), {
    status: 'not_found',
    outcome: 'unknown',
  });
  assert.equal(f.control.projects, 1);
  assert.equal(f.count(COMMAND_EVENT_TABLES.event), 1);
});

test('historical events cannot be regenerated after deletion or replayed under a removed declaration', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  await service.execute(principal, ['north'], body);
  const { events: _events, version: _version, ...definition } = f.command;
  const withoutEvents = await f.issue(defineCommand(definition));
  await assert.rejects(withoutEvents.status(principal, ['north'], body), refusal('unknown'));
  f.db.exec(
    `DELETE FROM "${COMMAND_EVENT_TABLES.event}"; UPDATE "${COMMAND_JOURNAL_TABLES.receipt}" SET manifest_json = NULL, event_count = NULL, digest = NULL`,
  );
  await assert.rejects(service.status(principal, ['north'], body), refusal('unknown'));
  await assert.rejects(service.execute(principal, ['north'], body), refusal('unknown'));
  assert.equal(f.control.projects, 1);
  assert.equal(f.control.handles, 1);
  assert.equal(f.version(), 1);
});

test('renaming a declaration without changing command version conflicts with the original fingerprint', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  await service.execute(principal, ['north'], body);
  const { version: _version, ...definition } = f.command;
  const changed = await f.issue(defineCommand({ ...definition, events: { renamed: f.declarations.changed } }));
  await assert.rejects(changed.status(principal, ['north'], body), refusal('unknown', 'idempotency_conflict'));
  assert.equal(f.control.projects, 1);
  assert.equal(f.control.handles, 1);
});

test('structural ordinary/scoped receipt owners cannot enable projections or invoke the handler', async (t) => {
  const f = await fixture(t);
  for (const scoped of [false, true]) {
    let entered = false;
    const binding: BusinessCommandBinding = {
      ...(scoped ? { scoped: true as const } : {}),
      authorize: () => ({
        command: f.command,
        actor: { id: 'alice', appId: f.owner.appId, roles: ['editor'] },
        resource: 'item',
        keyColumns: ['id'],
        catalog: {},
        receiptOwner: { storeId: f.owner.storeId, sourceId: 'business', tenantId: 'north' },
        assertTarget: async () => {},
        assertResult: async () => {},
        transaction: async () => {
          throw new Error('unused');
        },
        commandTransaction: async () => {
          entered = true;
          throw new Error('must not enter');
        },
      }),
    };
    await assert.rejects(
      executeBusinessCommand(binding, { id: 'alice', appId: f.owner.appId, roles: ['editor'] }, body),
      refusal(scoped ? 'unknown' : 'not_applied', 'forbidden'),
    );
    assert.equal(entered, false);
  }
  assert.equal(f.control.handles, 0);
  assert.equal(f.control.projects, 0);
});

test('journal snapshots manifest/batch before queue waits and retained facades refuse', async (t) => {
  const f = await fixture(t),
    operations = new TransactionOperations();
  const tenant: CommandJournalTenant = {
    appId: f.owner.appId,
    storeId: f.owner.storeId,
    sourceId: 'business',
    tenantId: 'north',
    actorId: 'alice',
    membershipId: 'north-alice',
    membershipVersion: '1',
    tenantVersion: '1',
    roles: ['editor'],
    deployment: 'event-deployment',
  };
  const receipt: StoredCommandReceipt = {
    appId: f.owner.appId,
    actorId: 'alice',
    commandId: body.command,
    commandVersion: 2,
    idempotencyKey: body.idempotencyKey,
    id: 'journal-receipt',
    fingerprint: 'fingerprint',
    resultJson: '{"version":1}',
    requestId: 'journal-request',
    completedAt: '2026-09-08T12:00:00.000Z',
  };
  const audit = { target: 'item', keyJson: '{"id":"north-row"}', changesJson: '[]' };
  const captured = getCommandEvents(f.command)!;
  const batch = plain(projectCommandEvents(captured, { version: 1 })),
    expected = plain(captured.expectation);
  let journal!: CommandJournal;
  f.db.exec('BEGIN IMMEDIATE');
  try {
    journal = createSqliteCommandJournal(f.db, operations, tenant);
    const committing = journal.commit(receipt, audit, batch);
    Reflect.set(batch[0], 'payloadJson', '{"version":999}');
    await committing;
    const finding = journal.find(receipt, expected);
    Reflect.set(expected[0], 'version', 999);
    assert.deepEqual(plain(await finding), receipt);
    await operations.finish();
    f.db.exec('COMMIT');
  } catch (error) {
    await operations.finish().catch(() => {});
    if (f.db.isTransaction) f.db.exec('ROLLBACK');
    throw error;
  }
  const stored = f.db.prepare(`SELECT envelope_json FROM "${COMMAND_EVENT_TABLES.event}"`).get()!;
  assert.deepEqual(JSON.parse(JSON.parse(String(stored.envelope_json)).payloadJson), { version: 1 });
  await assert.rejects(journal.find(receipt, captured.expectation));
  await assert.rejects(journal.commit(receipt, audit, projectCommandEvents(captured, { version: 1 })));
});

test('caught batch validation failure poisons the same queue and rolls back earlier effects', async (t) => {
  const f = await fixture(t),
    operations = new TransactionOperations();
  const tenant: CommandJournalTenant = {
    appId: f.owner.appId,
    storeId: f.owner.storeId,
    sourceId: 'business',
    tenantId: 'north',
    actorId: 'alice',
    membershipId: 'north-alice',
    membershipVersion: '1',
    tenantVersion: '1',
    roles: ['editor'],
    deployment: 'event-deployment',
  };
  const receipt: StoredCommandReceipt = {
    appId: f.owner.appId,
    actorId: 'alice',
    commandId: body.command,
    commandVersion: 2,
    idempotencyKey: body.idempotencyKey,
    id: 'bad-batch-receipt',
    fingerprint: 'fingerprint',
    resultJson: '{"version":1}',
    requestId: 'journal-request',
    completedAt: '2026-09-08T12:00:00.000Z',
  };
  f.db.exec('BEGIN IMMEDIATE');
  try {
    const journal = createSqliteCommandJournal(f.db, operations, tenant);
    await operations.run(async () => {
      f.db.exec("UPDATE db_item SET version=1 WHERE id='north-row'");
    });
    await journal.commit(receipt, { target: 'item', keyJson: '{"id":"north-row"}', changesJson: '[]' }, []).catch(() => {});
    await assert.rejects(journal.find(receipt));
    await assert.rejects(operations.finish());
  } finally {
    f.db.exec('ROLLBACK');
  }
  assert.equal(f.version(), 0);
  for (const table of [COMMAND_JOURNAL_TABLES.receipt, COMMAND_EVENT_TABLES.event]) {
    assert.equal(f.count(table), 0);
  }
});

test('a caught event INSERT failure cannot commit effects or its already-inserted receipt/audit', async (t) => {
  const f = await fixture(t),
    operations = new TransactionOperations();
  const tenant: CommandJournalTenant = {
    appId: f.owner.appId,
    storeId: f.owner.storeId,
    sourceId: 'business',
    tenantId: 'north',
    actorId: 'alice',
    membershipId: 'north-alice',
    membershipVersion: '1',
    tenantVersion: '1',
    roles: ['editor'],
    deployment: 'event-deployment',
  };
  const receipt: StoredCommandReceipt = {
    appId: f.owner.appId,
    actorId: 'alice',
    commandId: body.command,
    commandVersion: 2,
    idempotencyKey: body.idempotencyKey,
    id: 'failed-insert-receipt',
    fingerprint: 'fingerprint',
    resultJson: '{"version":1}',
    requestId: 'journal-request',
    completedAt: '2026-09-08T12:00:00.000Z',
  };
  const prepare = f.db.prepare;
  let injected = false;
  f.db.prepare = function (sql) {
    if (sql.startsWith(`INSERT INTO main."${COMMAND_EVENT_TABLES.event}"`)) {
      injected = true;
      assert.equal(f.count(COMMAND_JOURNAL_TABLES.receipt), 1);
      assert.equal(f.batches(), 1);
      throw new Error('event write failed');
    }
    return prepare.call(this, sql);
  };
  f.db.exec('BEGIN IMMEDIATE');
  try {
    const journal = createSqliteCommandJournal(f.db, operations, tenant);
    await operations.run(async () => {
      f.db.exec("UPDATE db_item SET version=1 WHERE id='north-row'");
    });
    await journal
      .commit(
        receipt,
        { target: 'item', keyJson: '{"id":"north-row"}', changesJson: '[]' },
        projectCommandEvents(getCommandEvents(f.command)!, { version: 1 }),
      )
      .catch(() => {});
    await assert.rejects(journal.find(receipt));
    await assert.rejects(operations.finish());
  } finally {
    f.db.prepare = prepare;
    f.db.exec('ROLLBACK');
  }
  assert.equal(injected, true);
  assert.equal(f.version(), 0);
  for (const table of [COMMAND_JOURNAL_TABLES.receipt, COMMAND_EVENT_TABLES.event]) {
    assert.equal(f.count(table), 0);
  }
});

for (const method of ['find', 'commit'] as const)
  test(`final journal guard cannot alter event DDL after ${method}`, async (t) => {
    const f = await fixture(t),
      operations = new TransactionOperations();
    const tenant: CommandJournalTenant = {
      appId: f.owner.appId,
      storeId: f.owner.storeId,
      sourceId: 'business',
      tenantId: 'north',
      actorId: 'alice',
      membershipId: 'north-alice',
      membershipVersion: '1',
      tenantVersion: '1',
      roles: ['editor'],
      deployment: 'event-deployment',
    };
    const receipt: StoredCommandReceipt = {
      appId: f.owner.appId,
      actorId: 'alice',
      commandId: body.command,
      commandVersion: 2,
      idempotencyKey: body.idempotencyKey,
      id: 'guard-receipt',
      fingerprint: 'fingerprint',
      resultJson: '{"version":1}',
      requestId: 'journal-request',
      completedAt: '2026-09-08T12:00:00.000Z',
    };
    let guards = 0;
    const captured = getCommandEvents(f.command)!;
    f.db.exec('BEGIN IMMEDIATE');
    try {
      const journal = createSqliteCommandJournal(f.db, operations, tenant, () => {
        if (++guards === 2) f.db.exec(`ALTER TABLE "${COMMAND_EVENT_TABLES.event}" ADD COLUMN damaged TEXT`);
      });
      await operations.run(async () => {
        f.db.exec("UPDATE db_item SET version=1 WHERE id='north-row'");
      });
      await assert.rejects(
        method === 'find'
          ? journal.find(receipt, captured.expectation)
          : journal.commit(
              receipt,
              { target: 'item', keyJson: '{"id":"north-row"}', changesJson: '[]' },
              projectCommandEvents(captured, { version: 1 }),
            ),
      );
      await assert.rejects(operations.finish());
    } finally {
      f.db.exec('ROLLBACK');
    }
    assert.equal(guards, 2);
    assert.equal(f.version(), 0);
    assert.equal(f.count(COMMAND_JOURNAL_TABLES.receipt), 0);
    assert.equal(f.count(COMMAND_EVENT_TABLES.event), 0);
  });
