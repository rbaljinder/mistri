import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as turn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import {
  createTenantContexts,
  TenantContextsBusy,
  TenantLeaseError,
  tenantLeaseFailureCode,
} from '../packages/mistri/src/server/tenant/tenantContexts.js';
import { createTenantDeployment } from '../packages/mistri/src/server/tenant/tenantDeployment.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadContext } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  TENANT_TABLES,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource, TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { cookie: string };
type Manager = ReturnType<typeof createTenantContexts<Request>>;
type Options = Parameters<typeof createTenantContexts<Request>>[0];
type Reply = Awaited<ReturnType<Manager['open']>>;
type Session = { identity: Identity; sessionId: string; expiresAt: number };
const request = { cookie: 'alice' },
  north = ['north'],
  south = ['south'];
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const assertion = (reply: Reply) => ({ tabId: reply.tabId, expectedContext: reply.context, expectedRevision: reply.revision });
const change = (name = 'Edited', tenant = 'north') => ({ table: 'item', key: { id: `${tenant}-item` }, values: { name } });
function gate(t: TestContext) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  return { promise, release };
}
function safe(error: unknown) {
  assert.ok(error instanceof Error);
  assert.equal('cause' in error, false);
  assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_SENTINEL|session-secret|db_item|db_task|SELECT/);
  return true;
}
function controlFailure(error: unknown) {
  safe(error);
  assert.ok(error instanceof TenantContextError);
  return true;
}
function contextsBusy(error: unknown) {
  safe(error);
  assert.ok(error instanceof TenantContextsBusy);
  assert.equal(error.code, 'too_many_contexts');
  return true;
}
function leaseFailure(code: 'tenant_lease_stale' | 'tenant_lease_expired') {
  return (error: unknown) => {
    controlFailure(error);
    assert.ok(error instanceof TenantLeaseError);
    assert.equal(error.code, code);
    assert.equal(tenantLeaseFailureCode(error), code);
    return true;
  };
}
function writeFailure(outcome: 'not_applied' | 'unknown') {
  return (error: unknown) => {
    safe(error);
    assert.ok(error instanceof TenantWriteFailure);
    assert.equal(error.outcome, outcome);
    return true;
  };
}
function commandFailure(outcome: 'not_applied' | 'unknown') {
  return (error: unknown) => {
    safe(error);
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.outcome, outcome);
    return true;
  };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-contexts-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path),
    managers: Manager[] = [];
  const sources: Array<{ close(): Promise<void> }> = [];
  let deployment: ReturnType<typeof createTenantDeployment<Request>> | undefined;
  t.after(async () => {
    try {
      await Promise.allSettled(managers.map((manager) => manager.retire()));
      await deployment?.retire();
      await Promise.allSettled(sources.map((source) => source.close()));
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
    INSERT INTO db_item VALUES ('north-item','north','same','North item'),('south-item','south','same','South item'),
      ('alias-item','North','same','PRIVATE_SENTINEL');
    INSERT INTO db_task VALUES ('north-task','north','same',0,'North task'),('south-task','south','same',0,'South task');`);
  const owner = { appId: 'tenant-contexts', source: { id: 'business', connection: 'business-db' }, storeId: 'contexts-fixture' };
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
  const resources = { item: 'db_item', task: 'db_task' },
    catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' }, task: { kind: 'tenant', column: 'tenant_id' } },
  });
  const fields = Object.fromEntries(
    catalog.schema.tables.map((table) => {
      const ordinary = table.columns.filter((column) => column.name !== 'tenant_id').map((column) => column.name);
      return [table.id, { read: ordinary, write: ordinary }];
    }),
  );
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Tenant contexts fixture',
      auth: {
        roles: { operator: { read: true, write: ['item'], commands: ['advance'] }, viewer: { read: true } },
      },
      sources: { business: { connection: owner.source.connection } },
      resources: {
        item: { physical: resources.item, access: 'write', fields: fields.item },
        task: {
          physical: resources.task,
          access: 'write',
          fields: fields.task,
          actions: {
            advance: {
              label: 'Advance',
              command: {
                id: 'advance',
                version: 1,
                target: 'task',
                input: {},
              },
            },
          },
        },
      },
      views: { task: { kind: 'list', from: 'task' } },
      home: 'task',
      nav: ['task'],
    },
    'tenant contexts fixture',
  );
  let time = 1000;
  const sessions: Record<string, Session | null> = {
    alice: { identity: { id: 'alice', who: 'Alice', role: 'admin' }, sessionId: 'session-secret-alice-1', expiresAt: 20000 },
    bob: { identity: { id: 'bob', who: 'Bob' }, sessionId: 'session-secret-bob-1', expiresAt: 20000 },
  };
  const rows: RowScope = { item: true, task: true };
  const control = {
    proofCalls: 0,
    verifyCalls: 0,
    commandCalls: 0,
    proof: undefined as ((req: Request) => Session | null | Promise<Session | null>) | undefined,
    verify: undefined as ((req: Request) => Identity | null | Promise<Identity | null>) | undefined,
    rows: undefined as ((tenant: string) => void | Promise<void>) | undefined,
    commandAfter: undefined as (() => void | Promise<void>) | undefined,
    deleted: undefined as (() => boolean | Promise<boolean>) | undefined,
    sourceClock: undefined as (() => void) | undefined,
  };
  const registry = defineCommands({
    advance: defineCommand({
      source: 'business',
      target: 'task',
      input: {},
      output: {
        parse(value: unknown) {
          if (
            !value ||
            typeof value !== 'object' ||
            !('taskId' in value) ||
            typeof value.taskId !== 'string' ||
            !('version' in value) ||
            typeof value.version !== 'number'
          )
            throw new Error('PRIVATE_SENTINEL');
          return { taskId: value.taskId, version: value.version };
        },
      },
      async handle({ db, record }) {
        control.commandCalls++;
        const { version } = await db.task.update(record, { version: Number(record.version) + 1 });
        await control.commandAfter?.();
        return { taskId: String(record.id), version: Number(version) };
      },
    }),
  });
  const reader = openSqliteTenantReadSource(path, ownership, owner, () => time);
  sources.push(reader);
  const writer = await openSqliteTenantWriteSource(path, ownership, owner, () => {
    control.sourceClock?.();
    return time;
  });
  sources.push(writer);
  deployment = createTenantDeployment<Request>({
    app,
    reader,
    writer,
    deployment: 'deployment-1',
    roles: ['operator', 'viewer'],
    maxLifetimeMs: 300000,
    now: () => time,
    verifySession: (req) => {
      control.verifyCalls++;
      return control.verify ? control.verify(req) : (sessions[req.cookie]?.identity ?? null);
    },
    resolveMembershipRows: () => rows,
    resolveRows: async (principal) => {
      await control.rows?.(principal.tenantId);
      return rows;
    },
    authorizeDeletedRecord: () => (control.deleted ? control.deleted() : true),
    commands: {
      registry,
      resultReferences: {
        advance: (result) => {
          if (!result || typeof result !== 'object' || !('taskId' in result) || typeof result.taskId !== 'string') throw new Error();
          return [{ table: 'task', key: { id: result.taskId } }];
        },
      },
    },
  });
  const options: Options = {
    deployment,
    now: () => time,
    verifySessionInstance: (req) => {
      control.proofCalls++;
      return control.proof ? control.proof(req) : (sessions[req.cookie] ?? null);
    },
  };
  const create = (overrides: Partial<Options> = {}) => {
    const manager = createTenantContexts<Request>({ ...options, ...overrides });
    managers.push(manager);
    return manager;
  };
  const row = (tenant = 'north') => plain(db.prepare('SELECT * FROM db_item WHERE id=?').get(`${tenant}-item`)!);
  const version = (tenant = 'north') => db.prepare('SELECT version FROM db_task WHERE id=?').get(`${tenant}-task`)!.version;
  const counts = () =>
    [COMMAND_JOURNAL_TABLES.receipt, sqliteAuditRows].map(
      (table) => db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()!.n,
    );
  const body = (tenant = 'north') => ({
    command: 'advance',
    commandVersion: 1,
    key: { id: `${tenant}-task` },
    expectedVersion: 0,
    idempotencyKey: 'context-attempt-0001',
    input: {},
  });
  return {
    db,
    deployment,
    options,
    create,
    sessions,
    control,
    rows,
    row,
    version,
    counts,
    body,
    grant,
    maintenance,
    setTime: (value: number) => {
      time = value;
    },
  };
}

test('open returns frozen server ownership only; wrapped reads hide physical and tenant columns', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    opened = await manager.open(request, north, {});
  assert.ok(Object.isFrozen(manager));
  assert.ok(Object.isFrozen(opened));
  assert.deepEqual(Object.keys(opened).sort(), ['accountId', 'appId', 'context', 'expiresAt', 'revision', 'tabId', 'tenantId']);
  assert.equal(opened.revision, 1);
  assert.equal(opened.accountId, 'alice');
  assert.equal(opened.appId, 'tenant-contexts');
  assert.equal(opened.tenantId, 'north');
  assert.equal(typeof opened.tabId, 'string');
  assert.ok(opened.tabId.length);
  assert.ok(opened.context.length);
  let retained: TenantReadContext | undefined;
  const result = await manager.withContext(request, north, assertion(opened), async (context) => {
    retained = context;
    return context.data.query({ table: 'item', limit: 10, offset: 0 });
  });
  assert.deepEqual(plain(result.context), plain(opened));
  assert.deepEqual(plain(result.value.rows), [{ id: 'north-item', business_id: 'same', name: 'North item' }]);
  assert.deepEqual(plain(result.value.sql), { text: '', params: [] });
  assert.doesNotMatch(
    JSON.stringify({ opened, result, schema: retained!.schema }),
    /session-secret|tenant_id|PRIVATE_SENTINEL|db_item|__mistri_/,
  );
  await assert.rejects(retained!.data.count('item'), controlFailure);
});

test('renew preserves exact ownership, increments a frozen lease, and recovers a lost acknowledgement without extension', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxLifetimeMs: 1000 }),
    a = await manager.open(request, north, {});
  f.setTime(1500);
  const renewed = await manager.renew(request, north, assertion(a));
  assert.deepEqual(plain(renewed), { ...plain(a), revision: 2, expiresAt: 2500 });
  assert.ok(Object.isFrozen(renewed));
  assert.equal(a.revision, 1);
  assert.equal(a.expiresAt, 2000);
  f.setTime(1600);
  const proofs = f.control.proofCalls,
    verifies = f.control.verifyCalls;
  assert.deepEqual(plain(await manager.renew(request, north, assertion(a))), plain(renewed));
  assert.ok(f.control.proofCalls > proofs);
  assert.ok(f.control.verifyCalls > verifies);
  assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(renewed));
  await assert.rejects(
    manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
    leaseFailure('tenant_lease_stale'),
  );
  assert.equal((await manager.withContext(request, north, assertion(renewed), (context) => context.data.count('item'))).value, 1);
  assert.equal(f.control.commandCalls, 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('renew retains only the latest exact receipt; replay cannot regress or extend the current lease', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxLifetimeMs: 1000 }),
    a = await manager.open(request, north, {});
  f.setTime(1200);
  const b = await manager.renew(request, north, assertion(a));
  f.setTime(1400);
  const c = await manager.renew(request, north, assertion(b));
  assert.equal(c.revision, 3);
  assert.equal(c.expiresAt, 2400);
  await assert.rejects(manager.renew(request, north, assertion(a)), leaseFailure('tenant_lease_stale'));
  f.setTime(1500);
  assert.deepEqual(plain(await manager.renew(request, north, assertion(b))), plain(c));
  assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(c));
});

for (const code of ['tenant_lease_stale', 'tenant_lease_expired'] as const) {
  test(`${code} preserves CRUD and command failure families and their conservative outcomes`, async (t) => {
    const f = await fixture(t),
      manager = f.create({ maxLifetimeMs: 1000 }),
      a = await manager.open(request, north, {});
    if (code === 'tenant_lease_stale') await manager.renew(request, north, assertion(a));
    else f.setTime(a.expiresAt);
    await assert.rejects(
      manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
      leaseFailure(code),
    );
    await assert.rejects(manager.update(request, north, assertion(a), change()), (error) => {
      writeFailure('not_applied')(error);
      assert.equal(tenantLeaseFailureCode(error), code);
      return true;
    });
    for (const method of [manager.execute, manager.status]) {
      await assert.rejects(method(request, north, assertion(a), f.body()), (error) => {
        commandFailure('unknown')(error);
        assert.equal(tenantLeaseFailureCode(error), code);
        return true;
      });
    }
    assert.equal(f.row().name, 'North item');
    assert.equal(f.control.commandCalls, 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('lease failure classification ignores untrusted provider code properties and accessors', async (t) => {
  const forged = Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'tenant_lease_stale' });
  assert.equal(tenantLeaseFailureCode(forged), undefined);
  let traps = 0;
  const getter = Object.defineProperty(new Error('PRIVATE_SENTINEL'), 'code', {
    get() {
      traps++;
      return 'tenant_lease_expired';
    },
  });
  assert.equal(tenantLeaseFailureCode(getter), undefined);
  assert.equal(traps, 0);
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  f.control.proof = () => {
    throw forged;
  };
  await assert.rejects(manager.update(request, north, assertion(a), change()), (error) => {
    writeFailure('not_applied')(error);
    assert.equal(tenantLeaseFailureCode(error), undefined);
    return true;
  });
});

for (const bound of ['five minutes', 'shortened native session', 'verification start'] as const) {
  test(`renewal deadline respects ${bound}`, async (t) => {
    const f = await fixture(t);
    f.sessions.alice!.expiresAt = 1000000;
    await f.maintenance(async (admin) => {
      await admin.putMembership({ ...f.grant, validUntil: 1000000, expectedVersion: '1' });
    });
    const manager = f.create(),
      a = await manager.open(request, north, {});
    f.setTime(2000);
    let moved = false;
    if (bound === 'shortened native session') f.sessions.alice!.expiresAt = 5000;
    if (bound === 'verification start')
      f.control.rows = () => {
        if (!moved) {
          moved = true;
          f.setTime(3000);
        }
      };
    const b = await manager.renew(request, north, assertion(a));
    assert.equal(b.expiresAt, bound === 'shortened native session' ? 5000 : 302000);
    assert.equal(b.revision, 2);
    assert.equal(b.context, a.context);
  });
}

for (const instant of [2500, 1100, NaN]) {
  test(`renewal refuses exhausted or invalid verification clock ${String(instant)}`, async (t) => {
    const f = await fixture(t),
      manager = f.create({ maxLifetimeMs: 1000 }),
      a = await manager.open(request, north, {});
    f.setTime(1500);
    let changed = false;
    f.control.rows = () => {
      if (!changed) {
        changed = true;
        f.setTime(instant);
      }
    };
    await assert.rejects(manager.renew(request, north, assertion(a)), controlFailure);
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('an expired current renewal receipt remains replayable metadata during dormancy, never data authority', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxLifetimeMs: 1000 }),
    a = await manager.open(request, north, {});
  f.setTime(1500);
  const b = await manager.renew(request, north, assertion(a));
  f.setTime(b.expiresAt);
  assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), { tabId: a.tabId, status: 'inactive' });
  await assert.rejects(
    manager.withContext(request, north, assertion(b), (context) => context.data.count('item')),
    leaseFailure('tenant_lease_expired'),
  );
  assert.deepEqual(plain(await manager.renew(request, north, assertion(a))), plain(b));
  f.setTime(2600);
  assert.deepEqual(plain(await manager.renew(request, north, assertion(a))), plain(b));
  const resumed = await manager.renew(request, north, assertion(b));
  assert.deepEqual(plain(resumed), { ...plain(b), revision: 3, expiresAt: 3600 });
  assert.equal((await manager.withContext(request, north, assertion(resumed), (context) => context.data.count('item'))).value, 1);
});

for (const operation of ['read', 'write', 'command'] as const) {
  test(
    `a ${operation} captures its original lease before the first auth await and can finish across renewal`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t),
        manager = f.create({ maxLifetimeMs: 1000 }),
        a = await manager.open(request, north, {});
      const entered = gate(t),
        release = gate(t);
      let paused = false;
      f.control.proof = async (req) => {
        if (!paused) {
          paused = true;
          entered.release();
          await release.promise;
        }
        return f.sessions[req.cookie] ?? null;
      };
      const pending =
        operation === 'read'
          ? manager.withContext(request, north, assertion(a), (context) => context.data.count('item'))
          : operation === 'write'
            ? manager.update(request, north, assertion(a), change())
            : manager.execute(request, north, assertion(a), f.body());
      try {
        await entered.promise;
        f.setTime(1500);
        const renewed = await manager.renew(request, north, assertion(a));
        release.release();
        const result = await pending;
        assert.deepEqual(plain(result.context), plain(a));
        assert.equal(f.row().name, operation === 'write' ? 'Edited' : 'North item');
        assert.equal(f.version(), operation === 'command' ? 1 : 0);
        assert.deepEqual(f.counts(), operation === 'command' ? [1, 1] : [0, 0]);
        assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(renewed));
      } finally {
        release.release();
        await Promise.allSettled([pending]);
      }
    },
  );
}

for (const expires of [false, true]) {
  test(
    `a retained real read across renewal ${expires ? 'cannot publish at its admitted deadline' : 'publishes under its admitted revision'}`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t),
        manager = f.create({ maxLifetimeMs: 1000 }),
        a = await manager.open(request, north, {});
      const entered = gate(t),
        release = gate(t);
      const pending = manager.withContext(request, north, assertion(a), async (context) => {
        const result = await context.data.query({ table: 'item', limit: 10, offset: 0 });
        entered.release();
        await release.promise;
        return result;
      });
      const settled = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await entered.promise;
        f.setTime(1500);
        const renewed = await manager.renew(request, north, assertion(a));
        if (expires) f.setTime(a.expiresAt);
        release.release();
        const result = await settled;
        if (expires) {
          assert.ok('error' in result);
          controlFailure(result.error);
        } else {
          assert.ok('value' in result);
          assert.deepEqual(plain(result.value.context), plain(a));
          assert.deepEqual(
            result.value.value.rows.map((row) => row.id),
            ['north-item'],
          );
        }
        assert.equal((await manager.withContext(request, north, assertion(renewed), (context) => context.data.count('item'))).value, 1);
      } finally {
        release.release();
        await settled;
      }
    },
  );
}

for (const expires of [false, true]) {
  test(
    `renewal during a real command and queued write ${expires ? 'cannot prevent original-deadline rollback' : 'does not cancel either admitted operation'}`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t),
        manager = f.create({ maxLifetimeMs: 1000 }),
        a = await manager.open(request, north, {});
      const entered = gate(t),
        release = gate(t);
      f.control.commandAfter = async () => {
        entered.release();
        await release.promise;
      };
      const command = manager.execute(request, north, assertion(a), f.body());
      const commandResult = command.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await entered.promise;
      const write = manager.update(request, north, assertion(a), change());
      const writeResult = write.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await turn();
        f.setTime(1500);
        const b = await manager.renew(request, north, assertion(a));
        f.setTime(1700);
        const c = await manager.renew(request, north, assertion(b));
        if (expires) f.setTime(a.expiresAt);
        release.release();
        const executed = await commandResult,
          written = await writeResult;
        if (expires) {
          assert.ok('error' in executed);
          commandFailure('not_applied')(executed.error);
          assert.ok('error' in written);
          writeFailure('not_applied')(written.error);
        } else {
          assert.ok('value' in executed);
          assert.deepEqual(plain(executed.value.context), plain(a));
          assert.ok('value' in written);
          assert.deepEqual(plain(written.value.context), plain(a));
        }
        assert.equal(f.version(), expires ? 0 : 1);
        assert.equal(f.row().name, expires ? 'North item' : 'Edited');
        assert.deepEqual(f.counts(), expires ? [0, 0] : [1, 1]);
        f.control.commandAfter = undefined;
        if (expires) await manager.execute(request, north, assertion(c), f.body());
        const status = await manager.status(request, north, assertion(c), f.body());
        assert.ok('replayed' in status.value);
        assert.equal(status.value.replayed, true);
        assert.equal(f.version(), 1);
        assert.deepEqual(f.counts(), [1, 1]);
      } finally {
        release.release();
        await Promise.allSettled([command, write]);
      }
    },
  );
}

for (const operation of ['write', 'command'] as const) {
  test(`renewal cannot turn expired postcommit ${operation} publication into success or not_applied`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t),
      manager = f.create({ maxLifetimeMs: 1000 }),
      a = await manager.open(request, north, {});
    const entered = gate(t),
      release = gate(t);
    let paused = false;
    f.control.verify = async (req) => {
      const committed = operation === 'write' ? f.row().name === 'Edited' : f.version() === 1;
      if (committed && !paused) {
        paused = true;
        entered.release();
        await release.promise;
      }
      return f.sessions[req.cookie]?.identity ?? null;
    };
    const pending =
      operation === 'write'
        ? manager.update(request, north, assertion(a), change())
        : manager.execute(request, north, assertion(a), f.body());
    const rejected = assert.rejects(pending, operation === 'write' ? writeFailure('unknown') : commandFailure('unknown'));
    try {
      await entered.promise;
      f.setTime(1500);
      const renewed = await manager.renew(request, north, assertion(a));
      f.setTime(a.expiresAt);
      release.release();
      await rejected;
      assert.equal(f.row().name, operation === 'write' ? 'Edited' : 'North item');
      assert.equal(f.version(), operation === 'command' ? 1 : 0);
      assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(renewed));
    } finally {
      release.release();
      await Promise.allSettled([pending, rejected]);
    }
  });
}

test('concurrent renewal attempts share one CAS receipt and never grant two extensions', { timeout: 10000 }, async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxLifetimeMs: 1000 }),
    a = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t);
  let paused = false;
  f.control.proof = async (req) => {
    if (!paused) {
      paused = true;
      entered.release();
      await release.promise;
    }
    return f.sessions[req.cookie] ?? null;
  };
  f.setTime(1200);
  const pending = manager.renew(request, north, assertion(a));
  try {
    await entered.promise;
    f.setTime(1500);
    const winner = await manager.renew(request, north, assertion(a));
    release.release();
    assert.deepEqual(plain(await pending), plain(winner));
    assert.equal(winner.revision, 2);
    assert.equal(winner.expiresAt, 2500);
    assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(winner));
  } finally {
    release.release();
    await Promise.allSettled([pending]);
  }
});

for (const advances of [1, 2]) {
  test(`renewal paused after window capture cannot overwrite ${advances} winning revision(s)`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t),
      manager = f.create({ maxLifetimeMs: 1000 }),
      a = await manager.open(request, north, {});
    const entered = gate(t),
      release = gate(t);
    let calls = 0;
    f.control.proof = async (req) => {
      // The first proof checks tab ownership; candidate's proof is after the
      // expected window was captured, exercising the publication-side CAS.
      if (++calls === 2) {
        entered.release();
        await release.promise;
      }
      return f.sessions[req.cookie] ?? null;
    };
    f.setTime(1200);
    const pending = manager.renew(request, north, assertion(a));
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await entered.promise;
      let winner = await manager.renew(request, north, assertion(a));
      if (advances === 2) winner = await manager.renew(request, north, assertion(winner));
      release.release();
      const result = await settled;
      if (advances === 1) {
        assert.ok('value' in result);
        assert.deepEqual(plain(result.value), plain(winner));
      } else {
        assert.ok('error' in result);
        assert.ok(leaseFailure('tenant_lease_stale')(result.error));
      }
      assert.equal(winner.revision, advances + 1);
      assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(winner));
    } finally {
      release.release();
      await settled;
    }
  });
}

for (const first of ['renew', 'switch'] as const) {
  test(`a paused ${first} loses revision CAS without damaging the competing winner`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t),
      manager = f.create({ maxLifetimeMs: 1000 }),
      a = await manager.open(request, north, {});
    const entered = gate(t),
      release = gate(t);
    let paused = false;
    f.control.proof = async (req) => {
      if (!paused) {
        paused = true;
        entered.release();
        await release.promise;
      }
      return f.sessions[req.cookie] ?? null;
    };
    const pending = first === 'renew' ? manager.renew(request, north, assertion(a)) : manager.switch(request, south, assertion(a));
    const rejected = assert.rejects(pending, controlFailure);
    try {
      await entered.promise;
      f.setTime(1500);
      const winning = first === 'renew' ? manager.switch(request, south, assertion(a)) : manager.renew(request, north, assertion(a));
      // Switching drains the losing renewal after claiming the generation.
      // Allow that loser to settle before waiting for the switch response.
      if (first === 'renew') {
        await turn();
        release.release();
      }
      const winner = await winning;
      release.release();
      await rejected;
      assert.equal(winner.revision, first === 'renew' ? 1 : 2);
      assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(winner));
      assert.equal(
        (await manager.withContext(request, [winner.tenantId], assertion(winner), (context) => context.data.count('item'))).value,
        1,
      );
    } finally {
      release.release();
      await Promise.allSettled([pending, rejected]);
    }
  });
}

for (const changed of [
  'same account new login',
  'signed out',
  'role addition',
  'role removal',
  'membership version',
  'membership replacement',
  'tenant version',
  'tenant suspension',
  'deployment retirement',
] as const) {
  test(`renewal and its duplicate require fresh exact authority after ${changed}`, async (t) => {
    const f = await fixture(t),
      manager = f.create({ maxLifetimeMs: 1000 }),
      a = await manager.open(request, north, {});
    f.setTime(1200);
    const b = await manager.renew(request, north, assertion(a));
    if (changed === 'same account new login') f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-new' };
    else if (changed === 'signed out') f.sessions.alice = null;
    else if (changed === 'deployment retirement') await f.deployment.retire();
    else
      await f.maintenance(async (admin) => {
        if (changed === 'tenant version' || changed === 'tenant suspension') {
          await admin.putTenant({
            tenantId: 'north',
            status: changed === 'tenant suspension' ? 'suspended' : 'active',
            expectedVersion: '1',
          });
        } else if (changed === 'membership replacement') {
          await admin.putMembership({ ...f.grant, status: 'revoked', expectedVersion: '1' });
          await admin.putMembership({ ...f.grant, membershipId: 'north-alice-new', expectedVersion: null });
        } else
          await admin.putMembership({
            ...f.grant,
            roles: changed === 'role addition' ? ['operator', 'viewer'] : changed === 'role removal' ? ['viewer'] : ['operator'],
            expectedVersion: '1',
          });
      });
    await assert.rejects(manager.renew(request, north, assertion(a)), controlFailure);
    await assert.rejects(manager.renew(request, north, assertion(b)), controlFailure);
    assert.equal(f.row().name, 'North item');
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const maxDormantMs of [undefined, 0, 500, 1800000]) {
  test(`dormancy ${String(maxDormantMs)} retains capacity until its exact bounded deadline, then prunes irreversibly`, async (t) => {
    const f = await fixture(t);
    f.sessions.alice!.expiresAt = 4000000;
    await f.maintenance(async (admin) => {
      await admin.putMembership({ ...f.grant, validUntil: 4000000, expectedVersion: '1' });
    });
    const manager = f.create({ maxContexts: 1, maxLifetimeMs: 1000, ...(maxDormantMs === undefined ? {} : { maxDormantMs }) });
    const a = await manager.open(request, north, {}),
      deadline = a.expiresAt + (maxDormantMs ?? 1800000);
    if (deadline > a.expiresAt) {
      f.setTime(deadline - 1);
      assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), { tabId: a.tabId, status: 'inactive' });
      await assert.rejects(manager.open(request, south, {}), controlFailure);
    }
    f.setTime(deadline);
    const replacement = await manager.open(request, north, {});
    assert.notEqual(replacement.context, a.context);
    await assert.rejects(manager.renew(request, north, assertion(a)), controlFailure);
    assert.equal((await manager.withContext(request, north, assertion(replacement), (context) => context.data.count('item'))).value, 1);
  });
}

for (const changed of ['role addition', 'role removal', 'shortened membership'] as const) {
  test(`renewal rechecks ${changed} even when a faulty store preserves the membership version`, async (t) => {
    const f = await fixture(t);
    if (changed === 'role removal') {
      await f.maintenance(async (admin) => {
        await admin.putMembership({ ...f.grant, roles: ['operator', 'viewer'], expectedVersion: '1' });
      });
    }
    const manager = f.create({ maxLifetimeMs: 1000 }),
      a = await manager.open(request, north, {});
    f.setTime(1200);
    const b = await manager.renew(request, north, assertion(a));
    // Fault injection isolates exact evidence checks from the normal admin
    // revision bump; this deliberately bypasses the administration contract.
    if (changed === 'shortened membership') {
      f.db.prepare(`UPDATE "${TENANT_TABLES.membership}" SET valid_until=? WHERE id=?`).run(2100, 'north-alice');
      await assert.rejects(manager.renew(request, north, assertion(a)), controlFailure);
      const next = await manager.renew(request, north, assertion(b));
      assert.equal(next.expiresAt, 2100);
      assert.equal(next.revision, 3);
    } else {
      f.db
        .prepare(`UPDATE "${TENANT_TABLES.membership}" SET roles_json=? WHERE id=?`)
        .run(JSON.stringify(changed === 'role addition' ? ['operator', 'viewer'] : ['operator']), 'north-alice');
      await assert.rejects(manager.renew(request, north, assertion(a)), controlFailure);
      await assert.rejects(manager.renew(request, north, assertion(b)), controlFailure);
    }
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('dormant continuity is capped by the previously known native expiry even if the session later extends', async (t) => {
  const f = await fixture(t);
  f.sessions.alice!.expiresAt = 3000;
  const manager = f.create({ maxContexts: 1, maxLifetimeMs: 1000 }),
    a = await manager.open(request, north, {});
  f.sessions.alice!.expiresAt = 20000;
  f.setTime(3000);
  await assert.rejects(manager.renew(request, north, assertion(a)), controlFailure);
  assert.notEqual((await manager.open(request, north, {})).context, a.context);
});

for (const value of [-1, 1800001, 0.5, NaN, Infinity]) {
  test(`constructor refuses invalid maxDormantMs ${String(value)}`, async (t) => {
    const f = await fixture(t);
    assert.throws(() => f.create({ maxDormantMs: value }), controlFailure);
  });
}

test('retired, switched-away, and restarted generations cannot resume or replay their renewal receipt', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxLifetimeMs: 1000 }),
    a = await manager.open(request, north, {});
  const b = await manager.renew(request, north, assertion(a));
  const southContext = await manager.switch(request, south, assertion(b));
  const again = await manager.switch(request, north, assertion(southContext));
  assert.equal(again.revision, 1);
  assert.notEqual(again.context, b.context);
  await assert.rejects(manager.renew(request, north, assertion(a)), controlFailure);
  await assert.rejects(manager.renew(request, north, assertion(b)), controlFailure);
  await assert.rejects(f.create().renew(request, north, assertion(again)), controlFailure);
  await manager.retire();
  await assert.rejects(manager.renew(request, north, assertion(again)), controlFailure);
});

for (const revision of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1']) {
  test(`required expectedRevision refuses malformed ${String(revision)} before authentication`, async (t) => {
    const f = await fixture(t),
      manager = f.create(),
      a = await manager.open(request, north, {}),
      before = f.control.proofCalls;
    const expected = { ...assertion(a), expectedRevision: revision };
    for (const method of [manager.renew, manager.switch]) {
      await assert.rejects(Reflect.apply(method, manager, [request, north, expected]), controlFailure);
    }
    await assert.rejects(
      Reflect.apply(manager.withContext, manager, [request, north, expected, () => assert.fail('must not execute')]),
      controlFailure,
    );
    assert.equal(f.control.proofCalls, before);
  });
}

for (const selectors of [[], ['north', 'north'], ['north', 'south'], ['missing'], ['North']]) {
  test(`open refuses missing, repeated or unauthorized selector ${JSON.stringify(selectors)}`, async (t) => {
    const f = await fixture(t),
      manager = f.create();
    await assert.rejects(manager.open(request, selectors, {}), controlFailure);
    assert.equal(f.control.commandCalls, 0);
    assert.deepEqual(f.counts(), [0, 0]);
    assert.equal((await manager.open(request, north, {})).tenantId, 'north');
  });
}

test('switch rotates A to B to A, invalidates old assertions and leaves another tab independent', async (t) => {
  const f = await fixture(t),
    manager = f.create();
  const a = await manager.open(request, north, {}),
    other = await manager.open(request, north, {});
  assert.notEqual(a.tabId, other.tabId);
  assert.notEqual(a.context, other.context);
  const b = await manager.switch(request, south, assertion(a));
  assert.equal(b.revision, 1);
  assert.equal(b.tabId, a.tabId);
  assert.equal(b.tenantId, 'south');
  assert.notEqual(b.context, a.context);
  await assert.rejects(
    manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
    controlFailure,
  );
  await assert.rejects(
    manager.withContext(request, north, assertion(b), (context) => context.data.count('item')),
    controlFailure,
  );
  assert.equal((await manager.withContext(request, north, assertion(other), (context) => context.data.count('item'))).value, 1);
  const again = await manager.switch(request, north, assertion(b));
  assert.equal(again.tabId, a.tabId);
  assert.notEqual(again.context, a.context);
  assert.notEqual(again.context, b.context);
  assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(again));
});

test('racing switches admit exactly one CAS winner and the loser cannot inactivate it', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const settled = await Promise.allSettled([manager.switch(request, south, assertion(a)), manager.switch(request, south, assertion(a))]);
  const winners = settled.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const result of settled) if (result.status === 'rejected') controlFailure(result.reason);
  const winner = winners[0].value;
  assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(winner));
  assert.equal((await manager.withContext(request, south, assertion(winner), (context) => context.data.count('item'))).value, 1);
});

test('discarded successful switch response is recoverable without reopening or repeating the switch', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  await manager.switch(request, south, assertion(a));
  const recovered = await manager.recover(request, { tabId: a.tabId });
  assert.ok('context' in recovered);
  assert.equal(recovered.tenantId, 'south');
  assert.notEqual(recovered.context, a.context);
  await assert.rejects(manager.switch(request, north, assertion(a)), controlFailure);
  assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(recovered));
});

test('recovery cannot advertise a context beyond a shortened verified session lifetime', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  assert.equal(a.expiresAt, 10000);
  f.sessions.alice!.expiresAt = 5000;
  await assert.rejects(manager.recover(request, { tabId: a.tabId }), controlFailure);
  await assert.rejects(
    manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
    controlFailure,
  );
  const fresh = await manager.open(request, north, {});
  assert.equal(fresh.expiresAt, 5000);
  assert.equal((await manager.withContext(request, north, assertion(fresh), (context) => context.data.count('item'))).value, 1);
});

test('recovery refuses a switch claimed during its post-wait session check without reporting stale inactivity', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const recoveryEntered = gate(t),
    recoveryRelease = gate(t),
    claimed = gate(t),
    switchRelease = gate(t);
  let proofs = 0,
    southRows = 0;
  f.control.proof = async (req) => {
    if (++proofs === 2) {
      recoveryEntered.release();
      await recoveryRelease.promise;
    }
    return f.sessions[req.cookie] ?? null;
  };
  f.control.rows = async (tenant) => {
    // Two reads authorize the candidate before CAS; the third starts its
    // post-claim confirmation while the previous generation is inactive.
    if (tenant === 'south' && ++southRows === 3) {
      claimed.release();
      await switchRelease.promise;
    }
  };
  const recovering = manager.recover(request, { tabId: a.tabId }).then(
    (value) => value,
    (error) => error,
  );
  await recoveryEntered.promise;
  const switching = manager.switch(request, south, assertion(a));
  try {
    await claimed.promise;
    recoveryRelease.release();
    controlFailure(await recovering);
    switchRelease.release();
    const b = await switching;
    assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(b));
  } finally {
    recoveryRelease.release();
    switchRelease.release();
    await recovering;
    await switching.catch(() => {});
  }
});

for (const changed of ['other account', 'same account new login', 'signed out'] as const) {
  test(`${changed} cannot recover, switch or use the previous session context`, async (t) => {
    const f = await fixture(t),
      manager = f.create(),
      a = await manager.open(request, north, {});
    if (changed === 'other account') f.sessions.alice = f.sessions.bob;
    if (changed === 'same account new login') f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-2' };
    if (changed === 'signed out') f.sessions.alice = null;
    await assert.rejects(manager.recover(request, { tabId: a.tabId }), controlFailure);
    await assert.rejects(manager.switch(request, south, assertion(a)), controlFailure);
    await assert.rejects(
      manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
      controlFailure,
    );
    await assert.rejects(manager.update(request, north, assertion(a), change()), writeFailure('not_applied'));
    await assert.rejects(manager.execute(request, north, assertion(a), f.body()), commandFailure('unknown'));
    assert.equal(f.row().name, 'North item');
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const bound of ['membership', 'session', 'configured lifetime'] as const) {
  test(`context expires at its initial ${bound} bound and recovery never reopens it`, async (t) => {
    const f = await fixture(t);
    if (bound === 'session') f.sessions.alice!.expiresAt = 2500;
    const manager = f.create(bound === 'configured lifetime' ? { maxLifetimeMs: 500 } : {});
    const a = await manager.open(request, north, {}),
      expected = bound === 'membership' ? 10000 : bound === 'session' ? 2500 : 1500;
    assert.equal(a.expiresAt, expected);
    f.setTime(expected);
    if (bound === 'session') {
      await assert.rejects(manager.recover(request, { tabId: a.tabId }), controlFailure);
      // Renewal of this same session permits control-plane recovery, not an
      // extension or automatic reopening of its already expired context.
      f.sessions.alice!.expiresAt = expected + 1000;
    }
    assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), { tabId: a.tabId, status: 'inactive' });
    await assert.rejects(
      manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
      controlFailure,
    );
    assert.equal(f.row().name, 'North item');
  });
}

test('proof identity must match actual deployment membership principal, not just a supplied session label', async (t) => {
  const f = await fixture(t),
    manager = f.create();
  f.control.proof = () => f.sessions.bob;
  await assert.rejects(manager.open(request, north, {}), controlFailure);
  assert.equal(f.control.commandCalls, 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('all history and command families preserve their existing result inside the captured ownership wrapper', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {}),
    expected = assertion(a);
  const created = await manager.insert(request, north, expected, {
    table: 'item',
    values: { id: 'created', business_id: 'created', name: 'Created' },
  });
  assert.ok(created.value.undoId);
  const updated = await manager.update(request, north, expected, change());
  assert.ok(updated.value.undoId);
  const preview = await manager.preview(request, north, expected);
  assert.equal(preview.value.next?.id, updated.value.undoId);
  const undone = await manager.undo(request, north, expected, { expectedId: updated.value.undoId! });
  assert.equal(undone.value.reverted, true);
  assert.equal(f.row().name, 'North item');
  const removed = await manager.remove(request, north, expected, { table: 'item', key: { id: 'created' } });
  assert.equal(removed.value.result.affected, 1);
  const prepared = await manager.prepare(request, north, expected, { command: 'advance', commandVersion: 1, key: { id: 'north-task' } });
  assert.equal(prepared.value.expectedVersion, 0);
  const executed = await manager.execute(request, north, expected, f.body());
  assert.equal(executed.value.status, 'applied');
  const status = await manager.status(request, north, expected, f.body());
  assert.ok('replayed' in status.value);
  assert.equal(status.value.replayed, true);
  assert.equal(f.control.commandCalls, 1);
  assert.deepEqual(f.counts(), [1, 1]);
  for (const result of [created, updated, preview, undone, removed, prepared, executed, status])
    assert.deepEqual(plain(result.context), plain(a));
});

test('switch and recovery wait for a retained old read; late private values cannot escape into the new context', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t);
  let switched = false,
    recovered = false;
  const reading = assert.rejects(
    manager.withContext(request, north, assertion(a), async (context) => {
      const result = await context.data.query({ table: 'item', limit: 10, offset: 0 });
      entered.release();
      await release.promise;
      return result;
    }),
    controlFailure,
  );
  await entered.promise;
  const switching = manager.switch(request, south, assertion(a));
  void switching.then(
    () => {
      switched = true;
    },
    () => {},
  );
  try {
    await turn();
    assert.equal(switched, false);
    const recovering = manager.recover(request, { tabId: a.tabId });
    void recovering.then(
      () => {
        recovered = true;
      },
      () => {},
    );
    await turn();
    assert.equal(recovered, false);
    await assert.rejects(
      manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
      controlFailure,
    );
    release.release();
    await reading;
    const b = await switching;
    assert.equal(b.tenantId, 'south');
    assert.deepEqual(plain(await recovering), plain(b));
    const result = await manager.withContext(request, south, assertion(b), (context) =>
      context.data.query({ table: 'item', limit: 10, offset: 0 }),
    );
    assert.deepEqual(
      result.value.rows.map((row) => row.id),
      ['south-item'],
    );
  } finally {
    release.release();
    await Promise.allSettled([reading, switching]);
  }
});

test('B membership loss after CAS leaves the tab inactive, never restores A, and does not poison a second tab', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {}),
    other = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t);
  const reading = assert.rejects(
    manager.withContext(request, north, assertion(a), async () => {
      entered.release();
      await release.promise;
      return 'held';
    }),
    controlFailure,
  );
  await entered.promise;
  const switching = assert.rejects(manager.switch(request, south, assertion(a)), controlFailure);
  try {
    await turn();
    await assert.rejects(
      manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
      controlFailure,
    );
    await f.maintenance(async (admin) => {
      await admin.putMembership({ ...f.grant, tenantId: 'south', membershipId: 'south-alice', status: 'revoked', expectedVersion: '1' });
    });
    release.release();
    await reading;
    await switching;
    assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), { tabId: a.tabId, status: 'inactive' });
    await assert.rejects(
      manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
      controlFailure,
    );
    assert.equal((await manager.withContext(request, north, assertion(other), (context) => context.data.count('item'))).value, 1);
  } finally {
    release.release();
    await Promise.allSettled([reading, switching]);
  }
});

test('switch cancels a live command and queued old-context write before commit; receipts and business rows roll back', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {}),
    other = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t);
  let switched = false;
  f.control.commandAfter = async () => {
    entered.release();
    await release.promise;
  };
  const command = assert.rejects(manager.execute(request, north, assertion(a), f.body()), commandFailure('not_applied'));
  await entered.promise;
  const queued = assert.rejects(manager.update(request, north, assertion(a), change()), writeFailure('not_applied'));
  const switching = manager.switch(request, south, assertion(a));
  void switching.then(
    () => {
      switched = true;
    },
    () => {},
  );
  try {
    await turn();
    assert.equal(switched, false);
    assert.equal((await manager.withContext(request, north, assertion(other), (context) => context.data.count('item'))).value, 1);
    release.release();
    await command;
    await queued;
    assert.equal((await switching).tenantId, 'south');
    assert.equal(f.version(), 0);
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
    f.control.commandAfter = undefined;
    await manager.execute(request, north, assertion(other), f.body());
    assert.equal(f.version(), 1);
    assert.deepEqual(f.counts(), [1, 1]);
  } finally {
    release.release();
    await Promise.allSettled([command, queued, switching]);
  }
});

for (const operation of ['update', 'undo', 'command'] as const) {
  test(`switch after committed ${operation} waits for settlement and preserves unknown, never not_applied`, async (t) => {
    const f = await fixture(t),
      manager = f.create(),
      a = await manager.open(request, north, {});
    const entered = gate(t),
      release = gate(t);
    let paused = false,
      switched = false;
    let token: string | undefined;
    if (operation === 'undo') token = (await manager.update(request, north, assertion(a), change())).value.undoId;
    f.control.verify = async (req) => {
      const committed = operation === 'command' ? f.version() === 1 : f.row().name === (operation === 'undo' ? 'North item' : 'Edited');
      if (committed && !paused) {
        paused = true;
        entered.release();
        await release.promise;
      }
      return f.sessions[req.cookie]?.identity ?? null;
    };
    const pending =
      operation === 'command'
        ? manager.execute(request, north, assertion(a), f.body())
        : operation === 'undo'
          ? manager.undo(request, north, assertion(a), { expectedId: token! })
          : manager.update(request, north, assertion(a), change());
    const rejected = assert.rejects(pending, operation === 'command' ? commandFailure('unknown') : writeFailure('unknown'));
    await entered.promise;
    const switching = manager.switch(request, south, assertion(a));
    void switching.then(
      () => {
        switched = true;
      },
      () => {},
    );
    try {
      await turn();
      assert.equal(switched, false);
      release.release();
      await rejected;
      assert.equal((await switching).tenantId, 'south');
      assert.equal(f.row().name, operation === 'update' ? 'Edited' : 'North item');
      assert.equal(f.version(), operation === 'command' ? 1 : 0);
      assert.deepEqual(f.counts(), operation === 'command' ? [1, 1] : [0, 0]);
    } finally {
      release.release();
      await Promise.allSettled([rejected, switching]);
    }
  });
}

test('context retirement during actual postcommit history publication preserves unknown and leaves the deployment open', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const original = Date.prototype.toISOString;
  let publication = false,
    retirement: Promise<void> | undefined;
  const mocked = t.mock.method(Date.prototype, 'toISOString', function (this: Date) {
    if (!publication && f.row().name === 'Edited') {
      publication = true;
      retirement = manager.retire();
    }
    return original.call(this);
  });
  try {
    await assert.rejects(manager.update(request, north, assertion(a), change()), writeFailure('unknown'));
    assert.equal(publication, true);
    await retirement;
    assert.equal(f.row().name, 'Edited');
    assert.equal(await f.deployment.withContext(request, north, (context) => context.data.count('item')), 1);
  } finally {
    mocked.mock.restore();
  }
});

for (const revision of ['roles', 'membership version', 'revoked and reinvited'] as const) {
  test(`a ${revision} change cannot silently upgrade a frozen context to newly issued evidence`, async (t) => {
    const f = await fixture(t),
      manager = f.create(),
      a = await manager.open(request, north, {});
    await f.maintenance(async (admin) => {
      if (revision === 'revoked and reinvited') {
        await admin.putMembership({ ...f.grant, status: 'revoked', expectedVersion: '1' });
        await admin.putMembership({ ...f.grant, membershipId: 'north-alice-new', expectedVersion: null });
      } else await admin.putMembership({ ...f.grant, roles: revision === 'roles' ? ['viewer'] : ['operator'], expectedVersion: '1' });
    });
    await assert.rejects(
      manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
      controlFailure,
    );
    await assert.rejects(manager.update(request, north, assertion(a), change()), writeFailure('not_applied'));
    assert.equal(f.row().name, 'North item');
    const fresh = await manager.open(request, north, {});
    assert.notEqual(fresh.context, a.context);
    assert.equal((await manager.withContext(request, north, assertion(fresh), (context) => context.data.count('item'))).value, 1);
  });
}

test('accepted operation captures assertion, selectors and values before asynchronous session verification', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t);
  let paused = false;
  f.control.proof = async (req) => {
    if (!paused) {
      paused = true;
      entered.release();
      await release.promise;
    }
    return f.sessions[req.cookie] ?? null;
  };
  const expected = assertion(a),
    selectors = ['north'],
    input = change('Captured');
  const updating = manager.update(request, selectors, expected, input);
  try {
    await entered.promise;
    expected.expectedContext = 'forged';
    expected.expectedRevision = 999;
    expected.tabId = 'other';
    selectors[0] = 'south';
    input.values.name = 'Mutated';
    input.key.id = 'south-item';
    release.release();
    const result = await updating;
    assert.deepEqual(plain(result.context), plain(a));
    assert.equal(f.row().name, 'Captured');
    assert.equal(f.row('south').name, 'South item');
  } finally {
    release.release();
    await Promise.allSettled([updating]);
  }
});

test('manager retirement drains an accepted first proof, stops admission, and never retires the genuine deployment', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    entered = gate(t),
    release = gate(t);
  let retired = false;
  f.control.proof = async () => {
    entered.release();
    await release.promise;
    return f.sessions.alice;
  };
  const opening = assert.rejects(manager.open(request, north, {}), controlFailure);
  await entered.promise;
  const retirement = manager.retire();
  void retirement.then(() => {
    retired = true;
  });
  try {
    await turn();
    assert.equal(retired, false);
    await assert.rejects(manager.open(request, south, {}), controlFailure);
    release.release();
    await opening;
    await retirement;
    await f.deployment.update(request, north, change());
    assert.equal(f.row().name, 'Edited');
    assert.equal(await f.deployment.withContext(request, south, (context) => context.data.count('item')), 1);
  } finally {
    release.release();
    await Promise.allSettled([opening, retirement]);
  }
});

test('account admission preserves other accounts capacity and cannot be reset by a new login', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 33 });
  const alice = [];
  for (let i = 0; i < 32; i++) alice.push(await manager.open(request, i % 2 ? south : north));
  // At the account's limit the oldest idle context makes way for the new page.
  const thirtyThird = await manager.open(request, north);
  await assert.rejects(
    manager.withContext(request, north, assertion(alice[0]), (context) => context.data.count('item')),
    controlFailure,
  );
  assert.equal((await manager.withContext(request, south, assertion(alice[1]), (context) => context.data.count('item'))).value, 1);
  assert.equal((await manager.withContext(request, north, assertion(thirtyThird), (context) => context.data.count('item'))).value, 1);
  f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-new' };
  // A new login of the same account shares the limit: it evicts the next oldest, not another account's.
  await manager.open(request, north);
  await assert.rejects(manager.recover(request, { tabId: alice[1].tabId }), controlFailure);
  const bob = await manager.open({ cookie: 'bob' }, north);
  assert.equal((await manager.withContext({ cookie: 'bob' }, north, assertion(bob), (context) => context.data.count('item'))).value, 1);
});

test('account admission counts concurrent verified openings and releases rejected reservations', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 33 }),
    entered = gate(t),
    release = gate(t);
  let arrived = 0;
  f.control.verify = async (req) => {
    if (req.cookie === 'alice') {
      if (++arrived === 32) entered.release();
      await release.promise;
      return null;
    }
    return f.sessions[req.cookie]?.identity ?? null;
  };
  const attempts = Array.from({ length: 32 }, () => assert.rejects(manager.open(request, north), controlFailure));
  try {
    await entered.promise;
    // Thirty-two openings in flight are thirty-two busy contexts: refused, and said so.
    await assert.rejects(manager.open(request, south), contextsBusy);
    const bob = await manager.open({ cookie: 'bob' }, north);
    assert.equal(bob.accountId, 'bob');
  } finally {
    release.release();
    await Promise.all(attempts);
  }
  f.control.verify = undefined;
  for (let i = 0; i < 32; i++) await manager.open(request, north);
  // Bob's context and Alice's 32 fill the deployment's 33: its ceiling evicts nothing.
  await assert.rejects(manager.open(request, north), (error) => controlFailure(error) && !(error instanceof TenantContextsBusy));
});

test('unverified openings do not reserve global context capacity', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 1 }),
    entered = gate(t),
    release = gate(t);
  f.control.proof = async (req) => {
    if (req.cookie === 'signed-out') {
      entered.release();
      await release.promise;
      return null;
    }
    return f.sessions[req.cookie] ?? null;
  };
  const invalid = assert.rejects(manager.open({ cookie: 'signed-out' }, north), controlFailure);
  try {
    await entered.promise;
    assert.equal((await manager.open(request, north)).accountId, 'alice');
  } finally {
    release.release();
    await invalid;
  }
});

test('a dormant context at the account limit makes way for a new page instead of locking the account out', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 33, maxLifetimeMs: 1000, maxDormantMs: 500 });
  const first = await manager.open(request, north);
  for (let i = 1; i < 32; i++) await manager.open(request, north);
  // Inside the dormant window: before G99 every new page was refused here, as a forged session.
  f.setTime(first.expiresAt + 499);
  assert.notEqual((await manager.open(request, north)).tabId, first.tabId);
  await assert.rejects(manager.recover(request, { tabId: first.tabId }), controlFailure);
});

test('at the account limit the oldest idle context is evicted, a released one first, and a busy one never', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 64 }),
    entered = gate(t),
    hold = gate(t);
  const alice: Reply[] = [];
  for (let i = 0; i < 32; i++) alice.push(await manager.open(request, north));
  // The oldest is busy: a read is in flight on it.
  const busy = manager.withContext(request, north, assertion(alice[0]), async (context) => {
    entered.release();
    await hold.promise;
    return context.data.count('item');
  });
  await entered.promise;
  // A released one goes before an older idle one.
  await manager.release(request, assertion(alice[5]));
  await manager.open(request, north);
  await assert.rejects(manager.resume(request, north, { tabId: alice[5].tabId }), controlFailure);
  // Then the oldest idle one, never the busy one.
  await manager.open(request, north);
  await assert.rejects(manager.recover(request, { tabId: alice[1].tabId }), controlFailure);
  hold.release();
  assert.equal((await busy).value, 1);
  assert.equal((await manager.withContext(request, north, assertion(alice[0]), (context) => context.data.count('item'))).value, 1);
});

test('an account whose every context is busy is refused distinctly, and a refused admission evicts nothing', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 64 }),
    hold = gate(t);
  const alice: Reply[] = [];
  for (let i = 0; i < 32; i++) alice.push(await manager.open(request, north));
  let started = 0;
  const allEntered = gate(t);
  const reads = alice.map((reply) =>
    manager.withContext(request, north, assertion(reply), async (context) => {
      if (++started === 32) allEntered.release();
      await hold.promise;
      return context.data.count('item');
    }),
  );
  await allEntered.promise;
  const refusal = await manager.open(request, north).then(
    () => assert.fail('opened past a busy limit'),
    (error: unknown) => error,
  );
  assert.ok(contextsBusy(refusal));
  hold.release();
  await Promise.all(reads);
  // A caller the tenant does not admit lets nothing go, though idle contexts are there to evict.
  f.control.verify = () => null;
  await assert.rejects(manager.open(request, north), controlFailure);
  f.control.verify = undefined;
  for (const reply of alice)
    assert.equal((await manager.withContext(request, north, assertion(reply), (context) => context.data.count('item'))).value, 1);
});

test('a context its page let go frees its slot a moment later, and 32 page loads never exhaust the account', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 33, releaseGraceMs: 100 });
  // A reader who reloads all morning: each page opens a context and lets it go as it leaves.
  for (let i = 0; i < 40; i++) {
    const opened = await manager.open(request, north);
    assert.deepEqual(plain(await manager.release(request, assertion(opened))), { tabId: opened.tabId, status: 'released' });
    f.setTime(1000 + (i + 1) * 100);
  }
  assert.equal((await manager.open(request, north)).accountId, 'alice');
});

test('the same tab resumes the context its last page released, once, for the same tenant, with its session', async (t) => {
  const f = await fixture(t),
    manager = f.create({ releaseGraceMs: 100 }),
    a = await manager.open(request, north);
  // Not released: a context another page holds is never resumed (a duplicated tab opens its own).
  await assert.rejects(manager.resume(request, north, { tabId: a.tabId }), controlFailure);
  await manager.release(request, assertion(a));
  // Another tenant, another account, or the platform realm: refused.
  await assert.rejects(manager.resume(request, south, { tabId: a.tabId }), controlFailure);
  await assert.rejects(manager.resume({ cookie: 'bob' }, north, { tabId: a.tabId }), controlFailure);
  await assert.rejects(manager.resumePlatform(request, { tabId: a.tabId }), controlFailure);
  const resumed = await manager.resume(request, north, { tabId: a.tabId });
  assert.deepEqual(plain(resumed), plain(a));
  assert.equal((await manager.withContext(request, north, assertion(resumed), (context) => context.data.count('item'))).value, 1);
  // Once: a second page restoring the same tab opens its own.
  await assert.rejects(manager.resume(request, north, { tabId: a.tabId }), controlFailure);
  // Resumed, it is kept as a live context is, past the release's grace.
  f.setTime(1000 + 200);
  assert.equal((await manager.withContext(request, north, assertion(resumed), (context) => context.data.count('item'))).value, 1);
});

test('a released context not resumed within its grace is gone, and a release names its own lease', async (t) => {
  const f = await fixture(t),
    manager = f.create({ releaseGraceMs: 100 }),
    a = await manager.open(request, north);
  await assert.rejects(manager.release(request, { ...assertion(a), expectedContext: 'another-context' }), controlFailure);
  await assert.rejects(manager.release({ cookie: 'bob' }, assertion(a)), controlFailure);
  await manager.release(request, assertion(a));
  f.setTime(1000 + 100);
  await assert.rejects(manager.resume(request, north, { tabId: a.tabId }), controlFailure);
  await assert.rejects(
    manager.withContext(request, north, assertion(a), (context) => context.data.count('item')),
    controlFailure,
  );
});

test('retirement drains authenticated opening reservations without publishing a tab', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    entered = gate(t),
    release = gate(t);
  f.control.verify = async (req) => {
    entered.release();
    await release.promise;
    return f.sessions[req.cookie]?.identity ?? null;
  };
  const attempt = assert.rejects(manager.open(request, north), controlFailure);
  await entered.promise;
  let drained = false;
  const retirement = manager.retire().then(() => {
    drained = true;
  });
  try {
    await turn();
    assert.equal(drained, false);
    await assert.rejects(manager.open({ cookie: 'bob' }, north), controlFailure);
  } finally {
    release.release();
    await Promise.all([attempt, retirement]);
  }
});

test('reentrant authentication cannot overbook the global budget', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 1 });
  let nested: Promise<Reply> | undefined;
  f.control.proof = (req) => {
    if (req.cookie === 'alice' && !nested) nested = manager.open({ cookie: 'bob' }, north);
    return f.sessions[req.cookie] ?? null;
  };
  const outer = manager.open(request, north);
  const results = await Promise.allSettled([outer, nested!]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('admission rejects a changed session after reservation and releases its slot', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 1 });
  f.control.verify = (req) => {
    f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-new' };
    return f.sessions[req.cookie]?.identity ?? null;
  };
  await assert.rejects(manager.open(request, north), controlFailure);
  f.control.verify = undefined;
  assert.equal((await manager.open(request, north)).accountId, 'alice');
});

test('maxContexts refuses overflow rather than evicting a live tab', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxContexts: 1 }),
    a = await manager.open(request, north, {});
  await assert.rejects(manager.open(request, south, {}), controlFailure);
  assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(a));
  assert.equal((await manager.withContext(request, north, assertion(a), (context) => context.data.count('item'))).value, 1);
});

for (const malformed of [
  'options proxy',
  'deployment proxy',
  'options getter',
  'provider proxy',
  'fake deployment',
  'zero capacity',
  'excess capacity',
  'zero lifetime',
  'excess lifetime',
] as const) {
  test(`constructor refuses ${malformed} without provider invocation or traps`, async (t) => {
    const f = await fixture(t);
    let traps = 0,
      providers = 0;
    const trap = (): never => {
      traps++;
      throw new Error('PRIVATE_SENTINEL');
    };
    const proxy = <T extends object>(value: T): T =>
      new Proxy(value, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, apply: trap });
    let options: Options = {
      ...f.options,
      verifySessionInstance: () => {
        providers++;
        return f.sessions.alice;
      },
    };
    if (malformed === 'options proxy') options = proxy(options);
    if (malformed === 'deployment proxy') options = { ...options, deployment: proxy(f.deployment) };
    if (malformed === 'options getter') Object.defineProperty(options, 'now', { enumerable: true, get: trap });
    if (malformed === 'provider proxy') options = { ...options, verifySessionInstance: proxy(options.verifySessionInstance) };
    if (malformed === 'fake deployment') options = { ...options, deployment: { ...f.deployment } };
    if (malformed === 'zero capacity') options = { ...options, maxContexts: 0 };
    if (malformed === 'excess capacity') options = { ...options, maxContexts: 1025 };
    if (malformed === 'zero lifetime') options = { ...options, maxLifetimeMs: 0 };
    if (malformed === 'excess lifetime') options = { ...options, maxLifetimeMs: 300001 };
    assert.throws(() => createTenantContexts(options), controlFailure);
    assert.equal(traps, 0);
    assert.equal(providers, 0);
    assert.equal(await f.deployment.withContext(request, north, (context) => context.data.count('item')), 1);
  });
}

for (const malformed of ['assertion proxy', 'assertion getter', 'extra authority', 'numeric token'] as const) {
  test(`malformed ${malformed} refuses before any session provider or business callback`, async (t) => {
    const f = await fixture(t),
      manager = f.create(),
      a = await manager.open(request, north, {});
    let traps = 0,
      callbacks = 0;
    const trap = (): never => {
      traps++;
      throw new Error('PRIVATE_SENTINEL');
    };
    let value: unknown = assertion(a);
    if (malformed === 'assertion proxy')
      value = new Proxy(assertion(a), { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    if (malformed === 'assertion getter') value = Object.defineProperty(assertion(a), 'expectedContext', { enumerable: true, get: trap });
    if (malformed === 'extra authority') value = { ...assertion(a), tenantId: 'south', roles: ['admin'] };
    if (malformed === 'numeric token') value = { tabId: a.tabId, expectedContext: 1 };
    const before = f.control.proofCalls;
    await assert.rejects(
      Reflect.apply(manager.withContext, manager, [
        request,
        north,
        value,
        () => {
          callbacks++;
          return null;
        },
      ]),
      controlFailure,
    );
    assert.equal(traps, 0);
    assert.equal(callbacks, 0);
    assert.equal(f.control.proofCalls, before);
  });
}

test('native command abort still reaches the source through the context wrapper and rolls back after receipt absence', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {}),
    abort = new AbortController();
  const entered = gate(t),
    release = gate(t);
  abort.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
  f.control.commandAfter = async () => {
    entered.release();
    await release.promise;
  };
  const executing = assert.rejects(
    manager.execute(request, north, assertion(a), f.body(), { signal: abort.signal }),
    commandFailure('not_applied'),
  );
  try {
    await entered.promise;
    abort.abort();
    release.release();
    await executing;
    assert.equal(f.control.commandCalls, 1);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
    assert.deepEqual(plain(await manager.recover(request, { tabId: a.tabId })), plain(a));
  } finally {
    release.release();
    await Promise.allSettled([executing]);
  }
});

test('independent source clock expiring the context at final precommit prevents COMMIT and receipt publication', async (t) => {
  const f = await fixture(t),
    manager = f.create({ maxLifetimeMs: 1000 }),
    a = await manager.open(request, north, {});
  const handles: DatabaseSync[] = [];
  let stagedSessions = 0,
    finalClocks = 0,
    commits = 0;
  f.control.verify = (req) => {
    const writer = handles[0];
    if (writer?.isTransaction && writer.prepare(`SELECT count(*) AS n FROM "${COMMAND_JOURNAL_TABLES.receipt}"`).get()!.n === 1)
      stagedSessions++;
    return f.sessions[req.cookie]?.identity ?? null;
  };
  f.control.sourceClock = () => {
    if (stagedSessions === 2 && handles[0]?.isTransaction && ++finalClocks === 3) f.setTime(a.expiresAt);
  };
  const original = DatabaseSync.prototype.exec;
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') handles.push(this);
    if (this === handles[0] && sql === 'COMMIT') commits++;
    return original.call(this, sql);
  });
  try {
    const failure = await manager.execute(request, north, assertion(a), f.body()).then(
      () => undefined,
      (error) => error,
    );
    assert.equal(finalClocks, 3);
    assert.deepEqual({ commits, version: f.version(), counts: f.counts() }, { commits: 0, version: 0, counts: [0, 0] });
    commandFailure('not_applied')(failure);
  } finally {
    mocked.mock.restore();
  }
});

for (const malformed of ['null', 'empty session', 'expired proof', 'nonfinite expiry', 'session getter', 'session proxy'] as const) {
  test(`open refuses ${malformed} session proof without executing accessors or granting a context`, async (t) => {
    const f = await fixture(t);
    let traps = 0;
    const trap = (): never => {
      traps++;
      throw new Error('PRIVATE_SENTINEL');
    };
    let proof: unknown = { ...f.sessions.alice! };
    if (malformed === 'null') proof = null;
    if (malformed === 'empty session') proof = { ...f.sessions.alice!, sessionId: '' };
    if (malformed === 'expired proof') proof = { ...f.sessions.alice!, expiresAt: 1000 };
    if (malformed === 'nonfinite expiry') proof = { ...f.sessions.alice!, expiresAt: Infinity };
    if (malformed === 'session getter')
      proof = Object.defineProperty({ ...f.sessions.alice! }, 'sessionId', { enumerable: true, get: trap });
    if (malformed === 'session proxy')
      proof = new Proxy({ ...f.sessions.alice! }, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    const manager: Manager = Reflect.apply(createTenantContexts, undefined, [{ ...f.options, verifySessionInstance: () => proof }]);
    try {
      await assert.rejects(manager.open(request, north, {}), controlFailure);
      assert.equal(traps, 0);
      assert.equal(f.control.commandCalls, 0);
      assert.deepEqual(f.counts(), [0, 0]);
    } finally {
      await manager.retire();
    }
  });
}

test('same-account new login while a command handler is paused rolls back before COMMIT, not merely at response release', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t);
  f.control.commandAfter = async () => {
    entered.release();
    await release.promise;
  };
  const executing = manager.execute(request, north, assertion(a), f.body()).then(
    () => undefined,
    (error) => error,
  );
  try {
    await entered.promise;
    f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-2' };
    release.release();
    const failure = await executing;
    assert.deepEqual({ version: f.version(), counts: f.counts() }, { version: 0, counts: [0, 0] });
    commandFailure('not_applied')(failure);
    assert.equal(f.control.commandCalls, 1);
    await assert.rejects(manager.recover(request, { tabId: a.tabId }), controlFailure);
  } finally {
    release.release();
    await executing;
  }
});

test('same-account new login while a private read is buffered cannot release old rows', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t);
  const reading = assert.rejects(
    manager.withContext(request, north, assertion(a), async (context) => {
      const rows = await context.data.query({ table: 'item', limit: 10, offset: 0 });
      entered.release();
      await release.promise;
      return rows;
    }),
    controlFailure,
  );
  try {
    await entered.promise;
    f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-2' };
    release.release();
    await reading;
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    release.release();
    await reading;
  }
});

test('same-account new login after confirmed command COMMIT preserves unknown and its durable receipt', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  let changed = false;
  f.control.verify = (req) => {
    if (!changed && f.version() === 1) {
      changed = true;
      f.sessions.alice = { ...f.sessions.alice!, sessionId: 'session-secret-alice-2' };
    }
    return f.sessions[req.cookie]?.identity ?? null;
  };
  await assert.rejects(manager.execute(request, north, assertion(a), f.body()), commandFailure('unknown'));
  assert.equal(changed, true);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
  const fresh = await manager.open(request, north, {});
  const replay = await manager.execute(request, north, assertion(fresh), f.body());
  assert.equal(replay.value.replayed, true);
  assert.equal(f.control.commandCalls, 1);
});

for (const method of ['update', 'insert', 'remove', 'undo', 'preview', 'prepare', 'execute', 'status'] as const) {
  test(`${method} malformed payload is an asynchronous classified refusal without session work or accessor execution`, async (t) => {
    const f = await fixture(t),
      manager = f.create(),
      a = await manager.open(request, north, {});
    let traps = 0;
    const before = f.control.proofCalls;
    const input = Object.defineProperty({}, 'table', {
      enumerable: true,
      get() {
        traps++;
        throw new Error('PRIVATE_SENTINEL');
      },
    });
    const result: Promise<unknown> = Reflect.apply(manager[method], manager, [request, north, assertion(a), input]);
    assert.ok(result instanceof Promise);
    await assert.rejects(
      result,
      method === 'prepare'
        ? commandFailure('not_applied')
        : method === 'execute' || method === 'status'
          ? commandFailure('unknown')
          : writeFailure('not_applied'),
    );
    assert.equal(traps, 0);
    assert.equal(f.control.proofCalls, before);
    assert.equal(f.control.commandCalls, 0);
    assert.equal(f.row().name, 'North item');
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('command options capture the original native abort signal before a paused admission verifier', async (t) => {
  const f = await fixture(t),
    manager = f.create(),
    a = await manager.open(request, north, {});
  const entered = gate(t),
    release = gate(t),
    original = new AbortController(),
    replacement = new AbortController();
  let paused = false;
  f.control.proof = async (req) => {
    if (!paused) {
      paused = true;
      entered.release();
      await release.promise;
    }
    return f.sessions[req.cookie] ?? null;
  };
  const options = { signal: original.signal, requestId: 'context-captured-attempt' };
  const executing = manager.execute(request, north, assertion(a), f.body(), options).then(
    () => undefined,
    (error) => error,
  );
  try {
    await entered.promise;
    options.signal = replacement.signal;
    options.requestId = 'mutated';
    original.abort();
    release.release();
    commandFailure('unknown')(await executing);
    assert.equal(f.control.commandCalls, 0);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  } finally {
    release.release();
    await executing;
  }
});
