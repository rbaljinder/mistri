import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES as journalTables,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandContext } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createTenantDeployment, type TenantDeploymentOptions } from '../packages/mistri/src/server/tenant/tenantDeployment.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadContext } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource, TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { cookie: string };
type Options = TenantDeploymentOptions<Request>;
type Deployment = ReturnType<typeof createTenantDeployment<Request>>;
type Input = { reviewerId: string };
type Output = Input & { taskId: string; version: number };
const request = { cookie: 'alice' },
  north = ['north'];
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** The target's key, from the row the platform read for the handler. */
const recordKey = (context: BusinessCommandContext) => ({ id: String(context.record!.id) });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function safe(error: unknown) {
  assert.ok(error instanceof Error);
  assert.equal('cause' in error, false);
  assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_SENTINEL|db_item|db_task|SELECT/);
  return true;
}
function writeFailure(outcome: 'not_applied' | 'unknown') {
  return (error: unknown) => {
    safe(error);
    assert.ok(error instanceof TenantWriteFailure);
    assert.equal(error.outcome, outcome);
    return true;
  };
}
function commandFailure(outcome: 'not_applied' | 'unknown', code?: string) {
  return (error: unknown) => {
    safe(error);
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.outcome, outcome);
    if (code) assert.equal(error.code, code);
    return true;
  };
}
function readFailure(error: unknown) {
  safe(error);
  assert.ok(error instanceof TenantContextError);
  return true;
}
function undoId(result: { undoId?: string }): string {
  assert.equal(typeof result.undoId, 'string');
  return result.undoId!;
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-deployment-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path),
    deployments: Deployment[] = [];
  const sources: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    try {
      await Promise.allSettled(deployments.map((value) => value.retire()));
      await Promise.allSettled(sources.map((value) => value.close()));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL,
      business_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(tenant_id COLLATE BINARY,business_id));
    CREATE TABLE db_task (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL,
      business_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
      UNIQUE(tenant_id COLLATE BINARY,business_id));
    CREATE TABLE db_reviewer (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO db_item VALUES ('north-item','north','same-business','North item'),('south-item','south','same-business','South item'),
      ('alias-item','North','same-business','PRIVATE_SENTINEL');
    INSERT INTO db_task VALUES ('north-task','north','same-business',0,'North task'),('south-task','south','same-business',0,'South task');
    INSERT INTO db_reviewer VALUES ('north-reviewer','north','North reviewer'),('south-reviewer','south','South reviewer');`);
  const owner = { appId: 'tenant-deployment', source: { id: 'business', connection: 'business-db' }, storeId: 'deployment-fixture' };
  provisionSqliteTenantStore(path, owner);
  migrateSqliteCommandJournal(path);
  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, owner));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['operator'],
    validUntil: 10000,
    expectedVersion: null,
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      for (const accountId of ['alice', 'bob'])
        await admin.putMembership({ ...grant, tenantId, accountId, membershipId: `${tenantId}-${accountId}` });
    }
  });
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const resources = { item: 'db_item', task: 'db_task', reviewer: 'db_reviewer' },
    catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: Object.fromEntries(Object.keys(resources).map((table) => [table, { kind: 'tenant', column: 'tenant_id' }])),
  });
  const fields = Object.fromEntries(
    catalog.schema.tables.map((table) => {
      const ordinary = table.columns.filter((column) => column.name !== 'tenant_id').map((column) => column.name);
      return [table.id, { read: ordinary, write: ordinary }];
    }),
  );
  // One declaration: the App's reference and the registration take the same field list.
  const advanceInput = { reviewerId: { label: 'Reviewer', type: 'text' } } as const;
  const advance = { label: 'Advance', command: { id: 'advance', version: 1, target: 'task', input: advanceInput } };
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Tenant deployment fixture',
      sources: { business: { connection: owner.source.connection } },
      resources: Object.fromEntries(
        Object.entries(resources).map(([name, physical]) => [
          name,
          { physical, access: 'write', fields: fields[name], ...(name === 'task' ? { actions: { advance } } : {}) },
        ]),
      ),
      auth: {
        roles: {
          operator: { read: true, write: ['item'], commands: ['advance'] },
          viewer: { read: true },
          admin: { read: true, write: ['item'], commands: ['advance'] },
        },
      },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'tenant deployment fixture',
  );
  let time = 1000,
    identity: Identity | null = { id: 'alice', who: 'Alice', role: 'admin' };
  const rows: RowScope = { item: true, task: true, reviewer: true };
  const control = {
    calls: 0,
    seen: undefined as BusinessCommandContext | undefined,
    before: undefined as (() => void | Promise<void>) | undefined,
    after: undefined as (() => void | Promise<void>) | undefined,
    handle: undefined as ((context: BusinessCommandContext, input: Input) => Promise<Output>) | undefined,
  };
  const registry = defineCommands({
    advance: defineCommand({
      target: 'task',
      input: advanceInput,
      source: 'business',
      read: ['task', 'reviewer'],
      write: ['task'],
      output: {
        parse(value: unknown) {
          const output = value as Output;
          if (
            !output ||
            typeof output.taskId !== 'string' ||
            typeof output.reviewerId !== 'string' ||
            !Number.isSafeInteger(output.version)
          )
            throw new Error('PRIVATE_SENTINEL');
          return { taskId: output.taskId, reviewerId: output.reviewerId, version: output.version };
        },
      },
      async handle(context, input) {
        control.calls++;
        control.seen = context;
        await control.before?.();
        if (control.handle) return control.handle(context, input);
        const { version } = await context.db.task.update(context.record, { version: Number(context.record.version) + 1 });
        await control.after?.();
        return { ...input, taskId: String(context.record.id), version: Number(version) };
      },
    }),
  });
  const commands: NonNullable<Options['commands']> = {
    registry,
    resultReferences: {
      advance: (result) => [
        { table: 'task', key: { id: (result as Output).taskId } },
        { table: 'reviewer', key: { id: (result as Output).reviewerId } },
      ],
    },
  };
  // Open exactly one genuine pair. Failed deployment construction must leave it
  // caller-owned; successful construction alone adopts these exact handles.
  const reader = openSqliteTenantReadSource(path, ownership, owner, () => time);
  sources.push(reader);
  const writer = await openSqliteTenantWriteSource(path, ownership, owner, () => time);
  sources.push(writer);
  const options: Options = {
    app,
    reader,
    writer,
    commands,
    deployment: 'deployment-1',
    roles: ['operator', 'viewer', 'admin'],
    maxLifetimeMs: 5000,
    now: () => time,
    verifySession: (value) => (value.cookie === 'alice' ? identity : null),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    authorizeDeletedRecord: () => true,
  };
  const create = (overrides: Partial<Options> = {}) => {
    const deployment = createTenantDeployment<Request>({ ...options, ...overrides });
    deployments.push(deployment);
    return deployment;
  };
  const row = (id = 'north-item') => plain(db.prepare('SELECT * FROM db_item WHERE id=?').get(id) ?? null);
  const version = (tenant = 'north') => db.prepare('SELECT version FROM db_task WHERE id=?').get(`${tenant}-task`)!.version;
  const counts = () =>
    [journalTables.receipt, sqliteAuditRows].map(
      (table) => db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()!.n,
    );
  const body = (tenant = 'north') => ({
    command: 'advance',
    commandVersion: 1,
    key: { id: `${tenant}-task` },
    expectedVersion: 0,
    idempotencyKey: 'deployment-attempt-0001',
    input: { reviewerId: `${tenant}-reviewer` },
  });
  const prepare = (tenant = 'north') => {
    const { command, commandVersion, key } = body(tenant);
    return { command, commandVersion, key };
  };
  return {
    db,
    reader,
    writer,
    app,
    rows,
    commands,
    options,
    create,
    control,
    row,
    version,
    counts,
    body,
    prepare,
    maintenance,
    grant,
    setTime: (value: number) => {
      time = value;
    },
    setIdentity: (value: Identity | null) => {
      identity = value;
    },
  };
}

function closeObserver(t: TestContext) {
  // The paired capabilities own three native handles: the readonly source and
  // the existing SqliteAdapter's inspection/read handle plus its pinned writer.
  const original = DatabaseSync.prototype.close,
    closed = new Set<DatabaseSync>();
  let calls = 0;
  const mocked = t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    calls++;
    closed.add(this);
    return original.call(this);
  });
  return { count: () => calls, distinct: () => closed.size, restore: () => mocked.mock.restore() };
}
const change = (name = 'Edited', tenant = 'north') => ({ table: 'item', key: { id: `${tenant}-item` }, values: { name } });
const insert = (tenant = 'north') => ({
  table: 'item',
  values: { id: `${tenant}-created`, business_id: 'created-business', name: 'Created' },
});

test('flat frozen deployment exposes only existing operations and a six-method read context, never sibling retirement or source handles', async (t) => {
  const f = await fixture(t),
    deployment = f.create();
  let retained: TenantReadContext | undefined;
  assert.ok(Object.isFrozen(deployment));
  assert.deepEqual(Object.keys(deployment).sort(), [
    'availability',
    'availabilityPlatform',
    'branding',
    'execute',
    'executePlatform',
    'importRows',
    'inbox',
    'insert',
    'insertPlatform',
    'intake',
    'platform',
    'prepare',
    'preparePlatform',
    'preview',
    'previewRemove',
    'previewRemovePlatform',
    'publicReads',
    'recordActivity',
    'recordHistory',
    'remove',
    'removePlatform',
    'resumeIntake',
    'retire',
    'status',
    'statusPlatform',
    'submitIntake',
    'undo',
    'update',
    'updatePlatform',
    'withContext',
    'withPlatformContext',
    'withPublicContext',
    'withPublicFlagIntake',
    'withSupportContext',
  ]);
  const result = await deployment.withContext(request, north, async (context) => {
    retained = context;
    return context.data.query({ table: 'item', limit: 10, offset: 0 });
  });
  assert.deepEqual(Object.keys(retained!).sort(), ['capabilities', 'data', 'principal', 'schema', 'together']);
  assert.ok(Object.isFrozen(retained!.capabilities));
  assert.deepEqual(Object.keys(retained!.capabilities!).sort(), ['grantedCommands', 'resources', 'writable']);
  assert.deepEqual(Object.keys(retained!.data).sort(), ['count', 'countBreakdown', 'countView', 'query', 'runBreakdown', 'runView']);
  assert.ok(Object.isFrozen(retained));
  assert.ok(Object.isFrozen(retained!.data));
  assert.deepEqual(plain(result.rows), [{ id: 'north-item', business_id: 'same-business', name: 'North item' }]);
  assert.deepEqual(plain(result.sql), { text: '', params: [] });
  assert.doesNotMatch(JSON.stringify({ result, schema: retained!.schema }), /tenant_id|PRIVATE_SENTINEL|db_item|__mistri_/);
  await assert.rejects(retained!.data.count('item'), readFailure);
  assert.equal((await deployment.execute(request, north, f.body())).status, 'applied');
  assert.deepEqual([...f.control.seen!.actor.roles], ['operator']);
  assert.deepEqual(Object.keys(f.control.seen!.tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
  assert.equal('journal' in f.control.seen!, false);
});

test('mixed creation/update/deletion Undo shares one history while command receipt/replay remains independent', async (t) => {
  const f = await fixture(t),
    deployment = f.create();
  const created = await deployment.insert(request, north, insert()),
    createdId = undoId(created);
  const updatedId = undoId(
    await deployment.update(request, north, { table: 'item', key: { id: 'north-created' }, values: { name: 'Edited' } }),
  );
  assert.deepEqual(plain(await deployment.prepare(request, north, f.prepare())), { expectedVersion: 0 });
  const command = await deployment.execute(request, north, f.body());
  const deletedId = undoId(await deployment.remove(request, north, { table: 'item', key: { id: 'north-created' } }));
  assert.equal(f.row('north-created'), null);
  const preview = await deployment.preview(request, north);
  assert.deepEqual(
    preview.writes.map((value) => value.id),
    [deletedId],
  );
  for (const expectedId of [deletedId, updatedId, createdId]) {
    assert.equal((await deployment.preview(request, north)).next?.id, expectedId);
    assert.equal((await deployment.undo(request, north, { expectedId })).reverted, true);
  }
  assert.equal(f.row('north-created'), null);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
  assert.deepEqual((await deployment.preview(request, north)).writes, []);
  assert.deepEqual(plain(await deployment.status(request, north, f.body())), { ...plain(command), replayed: true });
  assert.equal(f.control.calls, 1);
  assert.doesNotMatch(JSON.stringify({ created, command, preview }), /tenant_id|PRIVATE_SENTINEL|db_item|db_task|SELECT/);
});

test('metadata command availability and execution share the captured registry after caller mutation', async (t) => {
  const f = await fixture(t);
  const registry = { ...f.commands.registry };
  const commands = { ...f.commands, registry };
  const deployment = f.create({ commands });
  delete registry.advance;
  commands.registry = {};
  const capabilities = await deployment.withContext(request, north, (context) => context.capabilities);
  assert.deepEqual(plain(capabilities!.grantedCommands), ['advance']);
  assert.deepEqual(plain(capabilities!.writable), ['item']);
  assert.deepEqual(plain(capabilities!.resources.task.write), []);
  assert.equal((await deployment.execute(request, north, f.body())).status, 'applied');
  assert.equal(f.control.calls, 1);
});

test('generic record methods cannot acquire command-owned task writes through the shared request owner', async (t) => {
  const f = await fixture(t),
    deployment = f.create();
  await assert.rejects(
    deployment.update(request, north, { table: 'task', key: { id: 'north-task' }, values: { version: 1 } }),
    writeFailure('not_applied'),
  );
  await assert.rejects(deployment.remove(request, north, { table: 'task', key: { id: 'north-task' } }), writeFailure('not_applied'));
  await assert.rejects(
    deployment.insert(request, north, { table: 'task', values: { id: 'forged', business_id: 'forged', name: 'Forged' } }),
    writeFailure('not_applied'),
  );
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
  assert.deepEqual((await deployment.preview(request, north)).writes, []);
  await deployment.execute(request, north, f.body());
  assert.equal(f.version(), 1);
});

test('command facade cannot borrow the sibling history generic item grant; caught violation rolls back task effects', async (t) => {
  const f = await fixture(t),
    deployment = f.create();
  let caught = false;
  f.control.handle = async (context, input) => {
    await context.tx.update({ table: 'task', key: recordKey(context), values: { version: 1 } });
    try {
      await context.tx.update(change('Forbidden'));
    } catch {
      caught = true;
    }
    return { ...input, taskId: 'north-task', version: 1 };
  };
  await assert.rejects(deployment.execute(request, north, f.body()), commandFailure('not_applied'));
  assert.equal(caught, true);
  assert.equal(f.version(), 0);
  assert.equal(f.row()!.name, 'North item');
  assert.deepEqual(f.counts(), [0, 0]);
  await deployment.update(request, north, change());
  assert.equal(f.row()!.name, 'Edited');
});

test('one source pair retains two-tenant read/history/receipt isolation and rejects foreign Undo tokens', async (t) => {
  const f = await fixture(t),
    deployment = f.create();
  const northUndo = undoId(await deployment.update(request, north, change('North edit')));
  const southUndo = undoId(await deployment.update(request, ['south'], change('South edit', 'south')));
  assert.notEqual(northUndo, southUndo);
  await assert.rejects(deployment.undo(request, ['south'], { expectedId: northUndo }), writeFailure('not_applied'));
  const a = await deployment.execute(request, north, f.body()),
    b = await deployment.execute(request, ['south'], f.body('south'));
  assert.notEqual(a.receiptId, b.receiptId);
  assert.deepEqual(f.counts(), [2, 2]);
  for (const tenant of ['north', 'south']) {
    const result = await deployment.withContext(request, [tenant], (context) =>
      context.data.query({ table: 'item', limit: 10, offset: 0 }),
    );
    assert.deepEqual(
      result.rows.map((row) => row.id),
      [`${tenant}-item`],
    );
    assert.deepEqual(
      (await deployment.preview(request, [tenant])).writes.map((row) => row.id),
      [tenant === 'north' ? northUndo : southUndo],
    );
  }
});

test('a long read callback can coexist with committed history and commands without closing or rebinding the reader', async (t) => {
  const f = await fixture(t),
    deployment = f.create(),
    entered = gate(),
    release = gate();
  const reading = deployment.withContext(request, north, async (context) => {
    const first = await context.data.count('item');
    entered.release();
    await release.promise;
    const second = await context.data.query({ table: 'item', limit: 10, offset: 0 });
    return { first, second };
  });
  await entered.promise;
  try {
    await deployment.update(request, north, change());
    await deployment.execute(request, north, f.body());
  } finally {
    release.release();
  }
  const result = await reading;
  assert.equal(result.second.rows[0].name, 'Edited');
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
});

test('a paused command transaction permits independent guarded reads but no uncommitted task result is exposed', async (t) => {
  const f = await fixture(t),
    deployment = f.create(),
    entered = gate(),
    release = gate();
  f.control.after = async () => {
    entered.release();
    await release.promise;
  };
  const command = deployment.execute(request, north, f.body());
  await entered.promise;
  try {
    const result = await deployment.withContext(request, north, (context) => context.data.query({ table: 'task', limit: 10, offset: 0 }));
    assert.equal(result.rows[0].version, 0);
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    release.release();
  }
  await command;
  assert.equal(f.version(), 1);
});

test('retirement stops every operation family synchronously and drains a retained read before closing each source once', async (t) => {
  const f = await fixture(t),
    deployment = f.create(),
    entered = gate(),
    release = gate(),
    closes = closeObserver(t);
  let retired = false;
  const reading = assert.rejects(
    deployment.withContext(request, north, async (context) => {
      await context.data.count('item');
      entered.release();
      await release.promise;
      return 'must not release';
    }),
    readFailure,
  );
  await entered.promise;
  const retiring = deployment.retire();
  void retiring.then(() => {
    retired = true;
  });
  try {
    assert.equal(deployment.retire(), retiring);
    assert.equal(retired, false);
    assert.equal(closes.count(), 0);
    await assert.rejects(
      deployment.withContext(request, north, () => 'denied'),
      readFailure,
    );
    await assert.rejects(deployment.update(request, north, change()), writeFailure('not_applied'));
    await assert.rejects(deployment.preview(request, north), writeFailure('not_applied'));
    await assert.rejects(deployment.execute(request, north, f.body()), commandFailure('unknown'));
    await assert.rejects(deployment.status(request, north, f.body()), commandFailure('unknown'));
    assert.equal(closes.count(), 0);
  } finally {
    release.release();
  }
  try {
    await reading;
    await retiring;
    assert.equal(retired, true);
    assert.equal(closes.count(), 3);
    assert.equal(closes.distinct(), 3);
    await deployment.retire();
    assert.equal(closes.count(), 3);
  } finally {
    closes.restore();
  }
});

test('retirement drains concurrent read and command callbacks before either source closes and rolls back the command', async (t) => {
  const f = await fixture(t),
    deployment = f.create(),
    readEntered = gate(),
    readRelease = gate(),
    commandEntered = gate(),
    commandRelease = gate();
  const closes = closeObserver(t);
  let retired = false;
  const reading = assert.rejects(
    deployment.withContext(request, north, async (context) => {
      await context.data.count('item');
      readEntered.release();
      await readRelease.promise;
      return 1;
    }),
    readFailure,
  );
  await readEntered.promise;
  f.control.after = async () => {
    commandEntered.release();
    await commandRelease.promise;
  };
  const command = assert.rejects(deployment.execute(request, north, f.body()), commandFailure('not_applied'));
  await commandEntered.promise;
  const retiring = deployment.retire();
  void retiring.then(() => {
    retired = true;
  });
  try {
    readRelease.release();
    await reading;
    assert.equal(retired, false);
    assert.equal(closes.count(), 0);
  } finally {
    readRelease.release();
    commandRelease.release();
  }
  try {
    await command;
    await retiring;
    assert.equal(closes.count(), 3);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    closes.restore();
  }
});

test('retirement drains a pending deleted-record policy and leaves ordinary item data unchanged', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  const deployment = f.create({
    authorizeDeletedRecord: async () => {
      entered.release();
      await release.promise;
      return true;
    },
  });
  const closes = closeObserver(t);
  const removal = assert.rejects(
    deployment.remove(request, north, { table: 'item', key: { id: 'north-item' } }),
    writeFailure('not_applied'),
  );
  await entered.promise;
  const retiring = deployment.retire();
  try {
    assert.equal(closes.count(), 0);
    await assert.rejects(deployment.execute(request, north, f.body()), commandFailure('unknown'));
  } finally {
    release.release();
  }
  try {
    await removal;
    await retiring;
    assert.equal(f.row()!.name, 'North item');
    assert.equal(closes.count(), 3);
  } finally {
    closes.restore();
  }
});

for (const operation of ['read', 'history', 'command'] as const) {
  test(`retirement reserves ${operation} before its first asynchronous verifier and cannot close sources until verification settles`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      release = gate();
    let verifies = 0;
    const deployment = f.create({
      verifySession: async () => {
        verifies++;
        entered.release();
        await release.promise;
        return { id: 'alice', who: 'Alice' };
      },
    });
    const closes = closeObserver(t);
    const pending =
      operation === 'read'
        ? deployment.withContext(request, north, (context) => context.data.count('item'))
        : operation === 'history'
          ? deployment.update(request, north, change())
          : deployment.execute(request, north, f.body());
    const rejected = assert.rejects(
      pending,
      operation === 'read' ? readFailure : operation === 'history' ? writeFailure('not_applied') : commandFailure('unknown'),
    );
    await entered.promise;
    const retiring = deployment.retire();
    try {
      assert.equal(closes.count(), 0);
      assert.equal(verifies, 1);
    } finally {
      release.release();
    }
    try {
      await rejected;
      await retiring;
      assert.equal(closes.count(), 3);
      assert.equal(f.row()!.name, 'North item');
      assert.equal(f.version(), 0);
    } finally {
      closes.restore();
    }
  });
}

for (const invalid of ['command field rule', 'missing result extractor', 'wrong canonical source'] as const) {
  test(`failed deployment construction for ${invalid} does not adopt or close the caller-owned pair`, async (t) => {
    const f = await fixture(t),
      closes = closeObserver(t),
      app = plain(f.app);
    if (invalid === 'command field rule')
      app.auth!.roles!.operator.fields = { task: { read: ['id', 'business_id', 'version', 'not_a_column'] } };
    if (invalid === 'wrong canonical source') app.connection = 'other-db';
    try {
      assert.throws(
        () => f.create({ app, ...(invalid === 'missing result extractor' ? { commands: { ...f.commands, resultReferences: {} } } : {}) }),
        safe,
      );
      assert.equal(closes.count(), 0);
      assert.equal(f.control.calls, 0);
      const deployment = f.create();
      await deployment.withContext(request, north, (context) => context.data.count('item'));
      await deployment.update(request, north, change());
      await deployment.execute(request, north, f.body());
      assert.equal(f.row()!.name, 'Edited');
      assert.equal(f.version(), 1);
      await deployment.retire();
      assert.equal(closes.count(), 3);
    } finally {
      closes.restore();
    }
  });
}

for (const malformed of [
  'options proxy',
  'app proxy',
  'commands proxy',
  'registry proxy',
  'reference map proxy',
  'app getter',
  'clock getter',
  'resolver getter',
  'reference getter',
] as const) {
  test(`public constructor rejects ${malformed} without invoking traps, providers or handlers`, async (t) => {
    const f = await fixture(t),
      closes = closeObserver(t);
    let traps = 0,
      providers = 0;
    const trap = (): never => {
      traps++;
      throw new Error('PRIVATE_SENTINEL');
    };
    const proxy = <T extends object>(value: T): T =>
      new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const provider = (): never => {
      providers++;
      throw new Error('PRIVATE_SENTINEL');
    };
    let options: Options = {
      ...f.options,
      commands: { ...f.commands },
      verifySession: provider,
      resolveRows: provider,
      resolveMembershipRows: provider,
      authorizeDeletedRecord: provider,
      now: provider,
    };
    if (malformed === 'options proxy') options = proxy(options);
    if (malformed === 'app proxy') options = { ...options, app: proxy(f.app) };
    if (malformed === 'commands proxy') options = { ...options, commands: proxy(f.commands) };
    if (malformed === 'registry proxy') options = { ...options, commands: { ...f.commands, registry: proxy(f.commands.registry) } };
    if (malformed === 'reference map proxy')
      options = { ...options, commands: { ...f.commands, resultReferences: proxy(f.commands.resultReferences) } };
    if (malformed === 'app getter') Object.defineProperty(options, 'app', { enumerable: true, get: trap });
    if (malformed === 'clock getter') Object.defineProperty(options, 'now', { enumerable: true, get: trap });
    if (malformed === 'resolver getter') Object.defineProperty(options, 'resolveRows', { enumerable: true, get: trap });
    if (malformed === 'reference getter')
      options = {
        ...options,
        commands: {
          ...f.commands,
          resultReferences: Object.defineProperty({}, 'advance', { enumerable: true, get: trap }),
        },
      };
    try {
      assert.throws(() => createTenantDeployment(options), writeFailure('not_applied'));
      assert.equal(traps, 0);
      assert.equal(providers, 0);
      assert.equal(f.control.calls, 0);
      assert.equal(closes.count(), 0);
      const deployment = f.create();
      await deployment.withContext(request, north, (context) => context.data.count('item'));
      await deployment.retire();
      assert.equal(closes.count(), 3);
    } finally {
      closes.restore();
    }
  });
}

for (const first of ['read', 'history', 'command'] as const) {
  test(`a ${first} observation advances the shared clock high-water mark for sibling families`, async (t) => {
    const f = await fixture(t),
      deployment = f.create();
    f.setTime(2000);
    if (first === 'read') await deployment.withContext(request, north, (context) => context.data.count('item'));
    if (first === 'history') await deployment.update(request, north, change());
    if (first === 'command') await deployment.execute(request, north, f.body());
    f.setTime(1500);
    if (first === 'read') {
      await assert.rejects(deployment.update(request, north, change()), writeFailure('not_applied'));
      await assert.rejects(deployment.execute(request, north, f.body()), commandFailure('unknown'));
    } else
      await assert.rejects(
        deployment.withContext(request, north, (context) => context.data.count('item')),
        readFailure,
      );
    assert.equal(f.row()!.name, first === 'history' ? 'Edited' : 'North item');
    assert.equal(f.version(), first === 'command' ? 1 : 0);
  });
}

for (const origin of ['verifier', 'row resolver', 'clock'] as const) {
  test(`reentrant retirement from the ${origin} closes all families after the accepted request drains`, async (t) => {
    const f = await fixture(t),
      closes = closeObserver(t);
    let deployment!: Deployment, retirement: Promise<void> | undefined;
    let fired = false,
      closedAtCallback = -1;
    const retire = () => {
      if (fired) return;
      fired = true;
      retirement = deployment.retire();
      closedAtCallback = closes.count();
      assert.equal(deployment.retire(), retirement);
    };
    deployment = f.create({
      ...(origin === 'verifier'
        ? {
            verifySession: () => {
              retire();
              return { id: 'alice', who: 'Alice' };
            },
          }
        : {}),
      ...(origin === 'row resolver'
        ? {
            resolveRows: () => {
              retire();
              return f.rows;
            },
          }
        : {}),
      ...(origin === 'clock'
        ? {
            now: () => {
              retire();
              return 1000;
            },
          }
        : {}),
    });
    try {
      await assert.rejects(
        deployment.withContext(request, north, (context) => context.data.count('item')),
        readFailure,
      );
      assert.equal(fired, true);
      assert.equal(closedAtCallback, 0);
      await retirement;
      await assert.rejects(deployment.update(request, north, change()), writeFailure('not_applied'));
      await assert.rejects(deployment.execute(request, north, f.body()), commandFailure('unknown'));
      assert.equal(closes.count(), 3);
      assert.equal(closes.distinct(), 3);
    } finally {
      closes.restore();
    }
  });
}

for (const operation of ['history update', 'history Undo', 'command'] as const) {
  test(`retirement during ${operation} postcommit verification drains settlement before closing and preserves unknown`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      release = gate();
    let watch = false,
      paused = false;
    const deployment = f.create({
      verifySession: async () => {
        const committed =
          operation === 'command' ? f.version() === 1 : f.row()!.name === (operation === 'history Undo' ? 'North item' : 'Edited');
        if (watch && committed && !paused) {
          paused = true;
          entered.release();
          await release.promise;
        }
        return { id: 'alice', who: 'Alice' };
      },
    });
    let token: string | undefined;
    if (operation === 'history Undo') token = undoId(await deployment.update(request, north, change()));
    watch = true;
    const closes = closeObserver(t);
    let retired = false;
    const pending =
      operation === 'command'
        ? deployment.execute(request, north, f.body())
        : operation === 'history Undo'
          ? deployment.undo(request, north, { expectedId: token! })
          : deployment.update(request, north, change());
    const rejected = assert.rejects(pending, operation === 'command' ? commandFailure('unknown') : writeFailure('unknown'));
    await entered.promise;
    const retiring = deployment.retire();
    void retiring.then(() => {
      retired = true;
    });
    try {
      assert.equal(retired, false);
      assert.equal(closes.count(), 0);
    } finally {
      release.release();
    }
    try {
      await rejected;
      await retiring;
      assert.equal(retired, true);
      assert.equal(closes.count(), 3);
      assert.equal(f.version(), operation === 'command' ? 1 : 0);
      assert.equal(f.row()!.name, operation === 'history update' ? 'Edited' : 'North item');
      assert.deepEqual(f.counts(), operation === 'command' ? [1, 1] : [0, 0]);
    } finally {
      closes.restore();
    }
  });
}

test('reentrant retirement during actual history publication waits for publication/quarantine before source closure', async (t) => {
  const f = await fixture(t),
    deployment = f.create(),
    closes = closeObserver(t);
  const original = Date.prototype.toISOString;
  let publication = false,
    retirement: Promise<void> | undefined,
    closedDuringPublication = -1;
  const mocked = t.mock.method(Date.prototype, 'toISOString', function (this: Date) {
    // Separate-connection visibility proves COMMIT has finished; the remaining
    // work is the history service's publication, outside the request owner.
    if (!publication && f.row()!.name === 'Edited') {
      publication = true;
      retirement = deployment.retire();
      closedDuringPublication = closes.count();
    }
    return original.call(this);
  });
  try {
    await assert.rejects(deployment.update(request, north, change()), writeFailure('unknown'));
    assert.equal(publication, true);
    assert.equal(closedDuringPublication, 0);
    await retirement;
    assert.equal(closes.count(), 3);
    assert.equal(f.row()!.name, 'Edited');
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    mocked.mock.restore();
    closes.restore();
  }
});

test('one source close failure does not skip the other source or change the stable retirement promise', async (t) => {
  const f = await fixture(t),
    deployment = f.create(),
    original = DatabaseSync.prototype.close;
  const handles = new Set<DatabaseSync>();
  let calls = 0;
  const mocked = t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    calls++;
    handles.add(this);
    original.call(this);
    if (calls === 1) throw new Error('PRIVATE_SENTINEL');
  });
  try {
    const retiring = deployment.retire();
    assert.equal(deployment.retire(), retiring);
    await assert.rejects(retiring, writeFailure('unknown'));
    assert.equal(calls, 3);
    assert.equal(handles.size, 3);
    await assert.rejects(deployment.retire(), writeFailure('unknown'));
    assert.equal(calls, 3);
  } finally {
    mocked.mock.restore();
  }
});

test('captured deployment configuration cannot swap grants, clock or result extractors after construction', async (t) => {
  const f = await fixture(t),
    app = plain(f.app),
    resultReferences = { ...f.commands.resultReferences };
  const options = {
    ...f.options,
    app,
    commands: { ...f.commands, resultReferences },
    now: () => 1000,
    resolveRows: (): RowScope => f.rows,
  };
  const deployment = createTenantDeployment(options);
  try {
    app.auth!.roles!.operator.write = false;
    app.auth!.roles!.operator.commands = [];
    options.resolveRows = () => ({});
    options.now = () => 999999;
    resultReferences.advance = () => {
      throw new Error('PRIVATE_SENTINEL');
    };
    await deployment.withContext(request, north, (context) => context.data.count('item'));
    await deployment.update(request, north, change());
    await deployment.execute(request, north, f.body());
    assert.equal(f.row()!.name, 'Edited');
    assert.equal(f.version(), 1);
  } finally {
    await deployment.retire();
  }
});

for (const family of ['history', 'command'] as const) {
  test(`${family} payload and tenant selector are captured before waiting for authentication`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      release = gate();
    let verifies = 0;
    const deployment = f.create({
      verifySession: async () => {
        if (++verifies === 1) {
          entered.release();
          await release.promise;
        }
        return { id: 'alice', who: 'Alice' };
      },
    });
    const selectors = ['north'],
      update = change(),
      command = f.body();
    const pending = family === 'history' ? deployment.update(request, selectors, update) : deployment.execute(request, selectors, command);
    await entered.promise;
    selectors[0] = 'south';
    update.key.id = 'south-item';
    update.values.name = 'Swapped';
    command.key.id = 'south-task';
    command.input.reviewerId = 'south-reviewer';
    release.release();
    await pending;
    assert.equal(f.row()!.name, family === 'history' ? 'Edited' : 'North item');
    assert.equal(f.row('south-item')!.name, 'South item');
    assert.equal(f.version(), family === 'command' ? 1 : 0);
    assert.equal(f.version('south'), 0);
  });
}

test('a command-free generic tenant App retains reads, CRUD and Undo without inventing a registry or command authority', async (t) => {
  const f = await fixture(t),
    app = plain(f.app);
  let verifies = 0;
  // The resources' actions are the public command references: without them the App offers none.
  for (const resource of Object.values(app.resources ?? {})) delete resource.actions;
  for (const role of Object.values(app.auth!.roles!)) delete role.commands;
  const options = {
    ...f.options,
    app,
    verifySession: () => {
      verifies++;
      return { id: 'alice', who: 'Alice' };
    },
  };
  delete options.commands;
  const deployment = createTenantDeployment<Request>(options),
    closes = closeObserver(t);
  try {
    assert.ok(Object.isFrozen(deployment));
    assert.deepEqual(Object.keys(deployment).sort(), [
      'availability',
      'availabilityPlatform',
      'branding',
      'execute',
      'executePlatform',
      'importRows',
      'inbox',
      'insert',
      'insertPlatform',
      'intake',
      'platform',
      'prepare',
      'preparePlatform',
      'preview',
      'previewRemove',
      'previewRemovePlatform',
      'publicReads',
      'recordActivity',
      'recordHistory',
      'remove',
      'removePlatform',
      'resumeIntake',
      'retire',
      'status',
      'statusPlatform',
      'submitIntake',
      'undo',
      'update',
      'updatePlatform',
      'withContext',
      'withPlatformContext',
      'withPublicContext',
      'withPublicFlagIntake',
      'withSupportContext',
    ]);
    const rows = await deployment.withContext(request, north, (context) => context.data.query({ table: 'item', limit: 10, offset: 0 }));
    assert.deepEqual(
      rows.rows.map((row) => row.id),
      ['north-item'],
    );
    await deployment.insert(request, north, insert());
    await deployment.update(request, north, change());
    const removed = await deployment.remove(request, north, { table: 'item', key: { id: 'north-created' } });
    const expectedId = undoId(removed);
    assert.equal((await deployment.preview(request, north)).next?.id, expectedId);
    await deployment.undo(request, north, { expectedId });
    assert.equal(f.row('north-created')!.tenant_id, 'north');
    assert.equal(f.row()!.name, 'Edited');
    const before = verifies;
    await assert.rejects(deployment.prepare(request, north, f.prepare()), commandFailure('not_applied', 'forbidden'));
    await assert.rejects(deployment.execute(request, north, f.body()), commandFailure('unknown', 'forbidden'));
    await assert.rejects(deployment.status(request, north, f.body()), commandFailure('unknown', 'forbidden'));
    assert.equal(verifies, before);
    assert.equal(f.control.calls, 0);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
    await deployment.retire();
    assert.equal(closes.count(), 3);
    assert.equal(closes.distinct(), 3);
  } finally {
    closes.restore();
    await deployment.retire();
  }
});

for (const declaration of ['public reference', 'active-role grant', 'inactive-role grant'] as const) {
  test(`omitted commands with a ${declaration} refuse construction without acquiring sources or running providers`, async (t) => {
    const f = await fixture(t),
      app = plain(f.app),
      closes = closeObserver(t);
    let providers = 0;
    for (const role of Object.values(app.auth!.roles!)) delete role.commands;
    if (declaration !== 'public reference') for (const resource of Object.values(app.resources ?? {})) delete resource.actions;
    if (declaration === 'active-role grant') app.auth!.roles!.operator.commands = ['advance'];
    if (declaration === 'inactive-role grant') app.auth!.roles!.unused = { read: true, write: false, commands: ['advance'] };
    const provider = (): never => {
      providers++;
      throw new Error('PRIVATE_SENTINEL');
    };
    const options = { ...f.options, app, verifySession: provider, resolveRows: provider, resolveMembershipRows: provider };
    delete options.commands;
    try {
      assert.throws(() => createTenantDeployment<Request>(options), writeFailure('not_applied'));
      assert.equal(providers, 0);
      assert.equal(f.control.calls, 0);
      assert.equal(closes.count(), 0);
      const deployment = f.create();
      await deployment.withContext(request, north, (context) => context.data.count('item'));
      await deployment.execute(request, north, f.body());
      assert.equal(f.version(), 1);
      await deployment.retire();
      assert.equal(closes.count(), 3);
    } finally {
      closes.restore();
    }
  });
}
