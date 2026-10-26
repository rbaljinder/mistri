import assert from 'node:assert/strict';
import { refusalCause } from '../packages/engine/src/server/evidence.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations, TransactionOutcomeUnknown, type QueryResult } from '../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES as tables, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { BusinessCommandExecutionError, refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { writeFailureKind } from '../packages/engine/src/server/constraints.js';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  defineCommands,
  type BusinessCommandContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { canonicalCommandJson, type CommandRequest } from '../packages/mistri/src/server/commands/commandPayload.js';
import { createTenantCommands } from '../packages/mistri/src/server/tenant/tenantCommands.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { tenantWriterReopen } from '../packages/mistri/src/server/tenant/tenantWriterLifecycle.js';
import { pausedTenantWriters } from '../packages/mistri/src/server/tenant/tenantWriterHealth.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { cookie: string };
type Options = Parameters<typeof createTenantCommands<Request>>[0];
type Service = ReturnType<typeof createTenantCommands<Request>>;
type Input = { reviewerId: string; secondId: string };
type Output = Input & { version: number };
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
function refused(outcome: 'not_applied' | 'unknown', code?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.outcome, outcome);
    if (code) assert.equal(error.code, code);
    assert.equal('cause' in error, false);
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_SENTINEL|db_item|SELECT|tenant_id/);
    return true;
  };
}

async function fixture(
  t: TestContext,
  settings: { target?: 'item' | 'local'; storeId?: string; foreignKey?: boolean; includeParent?: boolean } = {},
) {
  const target = settings.target ?? 'item';
  const owner = {
    appId: 'tenant-commands',
    source: { id: 'business', connection: 'business-db' },
    storeId: settings.storeId ?? 'fixture-store',
  };
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-commands-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path),
    services: Service[] = [],
    sources: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    try {
      await Promise.all(services.map((service) => service.retire()));
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL,
      business_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
      UNIQUE(tenant_id COLLATE BINARY,business_id));
    CREATE TABLE db_local (tenant_id TEXT COLLATE NOCASE NOT NULL, local_id INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL, PRIMARY KEY(tenant_id COLLATE BINARY,local_id));
    CREATE TABLE db_reviewer (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE db_other (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, secret TEXT NOT NULL);
    INSERT INTO db_item VALUES ('north-row','north','same-business',0,'North'),('south-row','south','same-business',0,'South'),
      ('alias-row','North','same-business',0,'Alias');
    INSERT INTO db_local VALUES ('north',1,0,'North local'),('south',1,0,'South local');
    INSERT INTO db_reviewer VALUES ('north-reviewer','north','North reviewer',1),('north-second','north','Second reviewer',1),
      ('north-hidden','north','Hidden reviewer',0),('south-reviewer','south','South reviewer',1),('south-second','south','South second',1);
    INSERT INTO db_other VALUES ('north-other','north','PRIVATE_SENTINEL');`);
  if (settings.foreignKey) db.exec('ALTER TABLE db_item ADD COLUMN parent_id TEXT REFERENCES db_other(id)');
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
    roles: ['manager'],
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
  const resources = { item: 'db_item', local: 'db_local', reviewer: 'db_reviewer', other: 'db_other' };
  const catalog = appResourceCatalog(physicalSchema, resources);
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
      return [table.id, { read: table.id === 'local' ? ['tenant_id', ...ordinary] : ordinary, write: ordinary }];
    }),
  );
  // Resource fields express the narrow owner exception. A command-only role has no
  // generic writes and no authored role-field rule, even for inactive roles.
  // One declaration: the App's reference and the registration take the same field list.
  const assignInput = {
    reviewerId: { label: 'Reviewer', type: 'text' },
    secondId: { label: 'Second reviewer', type: 'text' },
  } as const;
  const assign = { label: 'Assign', command: { id: 'assign', version: 1, target, input: assignInput } };
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Tenant commands',
      sources: { business: { connection: owner.source.connection } },
      resources: Object.fromEntries(
        Object.entries(resources).map(([name, physical]) => [
          name,
          { physical, access: 'write', fields: fields[name], ...(name === target ? { actions: { assign } } : {}) },
        ]),
      ),
      auth: {
        roles: {
          manager: { read: true, commands: ['assign'] },
          viewer: { read: true },
          admin: { read: true, commands: ['assign'] },
        },
      },
      views: { records: { kind: 'list', from: target } },
      home: 'records',
      nav: ['records'],
    },
    'tenant command fixture',
  );
  let time = 1000,
    identity: Identity | null = { id: 'alice', who: 'Alice', role: 'admin' };
  let writerClock: () => number = () => time;
  const control = {
    calls: 0,
    before: undefined as (() => void | Promise<void>) | undefined,
    after: undefined as (() => void | Promise<void>) | undefined,
    handle: undefined as ((context: BusinessCommandContext, input: Input) => Promise<Output>) | undefined,
    seen: undefined as BusinessCommandContext | undefined,
  };
  const registry = defineCommands({
    assign: defineCommand({
      target,
      input: assignInput,
      source: 'business',
      read: [target, 'reviewer', ...(settings.includeParent ? ['other'] : [])],
      write: [target],
      output: {
        parse(value: unknown) {
          const output = value as Output;
          if (
            !output ||
            typeof output.reviewerId !== 'string' ||
            typeof output.secondId !== 'string' ||
            !Number.isSafeInteger(output.version)
          )
            throw new Error('PRIVATE_SENTINEL');
          return { reviewerId: output.reviewerId, secondId: output.secondId, version: output.version };
        },
      },
      async handle(context, input) {
        control.calls++;
        control.seen = context;
        await control.before?.();
        if (control.handle) return control.handle(context, input);
        const version = Number(context.record.version) + 1;
        const { record } = context;
        const key: Record<string, string | number> =
          target === 'local' ? { tenant_id: String(record.tenant_id), local_id: Number(record.local_id) } : { id: String(record.id) };
        await context.tx.update({ table: target, key, expected: { version: version - 1 }, values: { version } });
        await control.after?.();
        return { ...input, version };
      },
    }),
  });
  const rows: RowScope = { item: true, local: true, other: true, reviewer: { groups: [[{ column: 'visible', op: '=', value: 1 }]] } };
  const commands: Options['commands'] = {
    registry,
    resultReferences: {
      assign: (result) => [
        { table: 'reviewer', key: { id: (result as Output).reviewerId } },
        { table: 'reviewer', key: { id: (result as Output).secondId } },
      ],
    },
  };
  const issue = async (overrides: Partial<Options> = {}) => {
    const reader = openSqliteTenantReadSource(path, ownership, owner, () => time);
    sources.push(reader);
    const writer = await openSqliteTenantWriteSource(path, ownership, owner, () => writerClock());
    sources.push(writer);
    const options: Options = {
      app,
      reader,
      writer,
      commands,
      deployment: 'deployment-1',
      roles: ['manager', 'viewer', 'admin'],
      maxLifetimeMs: 5000,
      now: () => time,
      verifySession: (input) => (input.cookie === 'alice' ? identity : null),
      resolveMembershipRows: () => rows,
      resolveRows: () => rows,
      ...overrides,
    };
    const service = createTenantCommands(options);
    services.push(service);
    return service;
  };
  const body = (tenant = 'north', extra: Partial<CommandRequest> = {}): CommandRequest => ({
    command: 'assign',
    commandVersion: 1,
    key: target === 'local' ? { tenant_id: tenant, local_id: 1 } : { id: `${tenant}-row` },
    expectedVersion: 0,
    idempotencyKey: 'tenant-attempt-0001',
    input: { reviewerId: `${tenant}-reviewer`, secondId: `${tenant}-second` },
    ...extra,
  });
  const prepare = (tenant = 'north') => {
    const { command, commandVersion, key } = body(tenant);
    return { command, commandVersion, key };
  };
  const version = (tenant = 'north') =>
    target === 'local'
      ? db.prepare('SELECT version FROM db_local WHERE tenant_id=? COLLATE BINARY AND local_id=1').get(tenant)!.version
      : db.prepare('SELECT version FROM db_item WHERE id=?').get(`${tenant}-row`)!.version;
  const counts = () =>
    [tables.receipt, sqliteAuditRows].map(
      (table) => db.prepare(`SELECT count(*) AS n FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`}`).get()!.n,
    );
  return {
    db,
    owner,
    app,
    commands,
    registry,
    rows,
    issue,
    body,
    prepare,
    version,
    counts,
    control,
    maintenance,
    grant,
    setIdentity: (value: Identity | null) => {
      identity = value;
    },
    setTime: (value: number) => {
      time = value;
    },
    setWriterClock: (value: () => number) => {
      writerClock = value;
    },
    revoke: () => maintenance((admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
  };
}

test('command-only membership prepares, executes and replays with no generic CRUD, journal or owner exposure', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  assert.ok(Object.isFrozen(service));
  assert.deepEqual(Object.keys(service).sort(), ['availability', 'execute', 'prepare', 'retire', 'status']);
  assert.deepEqual(plain(await service.prepare(request, north, f.prepare())), { expectedVersion: 0 });
  assert.deepEqual(plain(await service.status(request, north, f.body())), { status: 'not_found', outcome: 'unknown' });
  assert.equal(f.control.calls, 0);
  assert.deepEqual(f.counts(), [0, 0]);
  const result = await service.execute(request, north, f.body(), { requestId: 'request-001' });
  assert.equal(result.status, 'applied');
  assert.equal(result.replayed, false);
  assert.equal(result.resource, 'item');
  assert.deepEqual(plain(result.key), { id: 'north-row' });
  assert.deepEqual(plain(result.result), { reviewerId: 'north-reviewer', secondId: 'north-second', version: 1 });
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
  assert.equal(f.control.calls, 1);
  assert.deepEqual([...f.control.seen!.actor.roles], ['manager']);
  assert.deepEqual(Object.keys(f.control.seen!.tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
  assert.equal('journal' in f.control.seen!, false);
  assert.equal('tenantId' in f.control.seen!.actor, false);
  assert.doesNotMatch(JSON.stringify(result), /tenant_id|PRIVATE_SENTINEL|db_item|SELECT|undoId/);
  assert.deepEqual(plain(await service.status(request, north, f.body())), { ...plain(result), replayed: true });
  assert.deepEqual(plain(await service.execute(request, north, f.body())), { ...plain(result), replayed: true });
  assert.equal(f.control.calls, 1);
  assert.equal(f.version(), 1);
  await assert.rejects(f.control.seen!.tx.count('item'));
});

test("a tenant command's handler is told its door: the screen's, or the API's or App MCP's when the host says so, never a caller's word", async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  await service.execute(request, north, f.body());
  assert.equal(f.control.seen!.door, 'ui');
  const doors: string[] = [];
  f.control.handle = async (context, input) => {
    doors.push(context.door);
    return { ...input, version: Number(context.record!.version) };
  };
  for (const entry of ['api', 'mcp'] as const)
    await service.execute(request, north, f.body('north', { expectedVersion: 1, idempotencyKey: `tenant-door-${entry}-0001` }), { entry });
  assert.deepEqual(doors, ['api', 'mcp']);
  // A door the tenant host never opens is refused before anything runs.
  await assert.rejects(
    service.execute(request, north, f.body('north', { expectedVersion: 1, idempotencyKey: 'tenant-door-job-0001' }), {
      entry: 'job' as never,
    }),
  );
  assert.deepEqual(doors, ['api', 'mcp']);
});

test('tenant availability does not disclose foreign-owner keys or run writes and refuses cancellation/retirement', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const { command, commandVersion } = f.prepare();
  const checks = [{ command, commandVersion, keys: [f.prepare().key, f.prepare('south').key, { id: 'missing' }] }];
  assert.deepEqual(plain(await service.availability(request, north, { checks })), {
    checks: [{ command, commandVersion, available: [true, false, false] }],
  });
  assert.equal(f.control.calls, 0);
  assert.deepEqual(f.counts(), [0, 0]);
  await assert.rejects(service.availability(request, north, { checks }, { signal: AbortSignal.abort() }));
  await service.retire();
  await assert.rejects(service.availability(request, north, { checks }));
});

/* Availability is advice the command asks again when it runs, so it reads in
   one snapshot rather than the writer's transaction (tenantCommandAvailability.ts):
   it answers while a command holds the writer, and a revoked member is refused. */
test('tenant availability answers while a command holds the writer, and refuses a revoked member', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const { command, commandVersion } = f.prepare();
  const checks = [{ command, commandVersion, keys: [f.prepare().key] }];
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.control.before = async () => {
    entered();
    await held;
  };
  const running = service.execute(request, north, f.body());
  await inside;
  assert.deepEqual(plain(await service.availability(request, north, { checks })), {
    checks: [{ command, commandVersion, available: [true] }],
  });
  release();
  assert.equal((await running).status, 'applied');
  // The answer was advice: the command read its target again, and a stale version is refused there, not here.
  await assert.rejects(
    service.execute(request, north, f.body('north', { idempotencyKey: 'tenant-attempt-0002' })),
    (error: { code?: string }) => error.code === 'stale_record',
  );
  await f.revoke();
  await assert.rejects(service.availability(request, north, { checks }));
});

test('same actor/request key in two tenants gives independent receipts and stable namespace-bound fingerprints', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const results = [];
  for (const tenant of ['north', 'south']) {
    const body = f.body(tenant);
    results.push(await service.execute(request, [tenant], body));
    const stored = f.db.prepare(`SELECT fingerprint,tenant_id,store_id,source_id FROM "${tables.receipt}" WHERE tenant_id=?`).get(tenant)!;
    const expected = createHash('sha256')
      .update(
        canonicalCommandJson({
          command: 'assign',
          commandVersion: 1,
          source: 'business',
          target: 'item',
          key: body.key,
          expectedVersion: 0,
          input: body.input,
          resource: 'item',
          receiptOwner: { storeId: f.owner.storeId, sourceId: 'business', tenantId: tenant },
        }),
      )
      .digest('hex');
    assert.equal(stored.fingerprint, expected);
    assert.equal(stored.store_id, f.owner.storeId);
    assert.equal(stored.source_id, 'business');
    assert.equal(f.version(tenant), 1);
  }
  assert.notEqual(results[0].receiptId, results[1].receiptId);
  assert.deepEqual(f.counts(), [2, 2]);
  assert.equal(f.control.calls, 2);
});

test('otherwise identical execution in a different stable store namespace changes the fingerprint', async (t) => {
  const a = await fixture(t, { storeId: 'namespace-a' }),
    b = await fixture(t, { storeId: 'namespace-b' });
  await (await a.issue()).execute(request, north, a.body());
  await (await b.issue()).execute(request, north, b.body());
  const hash = (db: DatabaseSync) => db.prepare(`SELECT fingerprint FROM "${tables.receipt}"`).get()!.fingerprint;
  assert.notEqual(hash(a.db), hash(b.db));
});

for (const transition of ['restart', 'deployment', 'membership revision', 'membership ID', 'tenant revision'] as const) {
  test(`${transition} keeps stable receipt replay without another handler effect`, async (t) => {
    const f = await fixture(t);
    let service = await f.issue();
    const first = await service.execute(request, north, f.body());
    if (transition === 'membership revision') await f.maintenance((admin) => admin.putMembership({ ...f.grant, expectedVersion: '1' }));
    if (transition === 'membership ID') {
      await f.revoke();
      await f.maintenance((admin) => admin.putMembership({ ...f.grant, membershipId: 'replacement-grant' }));
    }
    if (transition === 'tenant revision')
      await f.maintenance((admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '1' }));
    if (transition === 'restart' || transition === 'deployment') {
      await service.retire();
      service = await f.issue({ deployment: transition === 'deployment' ? 'deployment-2' : 'deployment-1' });
    }
    assert.deepEqual(plain(await service.execute(request, north, f.body())), { ...plain(first), replayed: true });
    assert.equal(f.control.calls, 1);
    assert.equal(f.version(), 1);
    assert.deepEqual(f.counts(), [1, 1]);
  });
}

test('duplicate concurrent execution checks the owned receipt before a second handler effect', async (t) => {
  const f = await fixture(t),
    service = await f.issue(),
    entered = gate(),
    release = gate();
  f.control.before = async () => {
    entered.release();
    await release.promise;
  };
  const first = service.execute(request, north, f.body());
  await entered.promise;
  const second = service.execute(request, north, f.body());
  release.release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].receiptId, results[1].receiptId);
  assert.deepEqual(
    results.map((result) => result.replayed),
    [false, true],
  );
  assert.equal(f.control.calls, 1);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
});

for (const executed of [true, false]) {
  test(`an uncertain COMMIT that ${executed ? 'landed' : 'did not land'} closes the writer, /readyz fails until it reopens, and the retry never runs twice (G193)`, async (t) => {
    const backoff = { ...tenantWriterReopen };
    Object.assign(tenantWriterReopen, { firstMs: 20, maxMs: 40 });
    t.after(() => Object.assign(tenantWriterReopen, backoff));
    const logged: string[] = [];
    t.mock.method(console, 'error', (line: unknown) => {
      logged.push(String(line));
    });
    const f = await fixture(t),
      service = await f.issue();
    const original = DatabaseSync.prototype.exec;
    let armed = false;
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (armed && sql === 'COMMIT') {
        armed = false;
        if (executed) original.call(this, sql);
        throw new Error('PRIVATE_SENTINEL lost acknowledgment');
      }
      return original.call(this, sql);
    });
    f.control.after = () => {
      armed = true;
    };
    await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
    f.control.after = undefined;
    assert.equal(f.version(), executed ? 1 : 0);
    assert.deepEqual(f.counts(), executed ? [1, 1] : [0, 0]);
    assert.deepEqual(pausedTenantWriters(), ['tenant-commands/business']);
    // Closed: refused before any handler runs, whatever the key (an execute that fails is said as unknown).
    await assert.rejects(
      service.execute(request, north, f.body('north', { idempotencyKey: 'tenant-attempt-0002' })),
      refused('unknown', 'temporarily_unavailable'),
    );
    assert.equal(f.control.calls, 1);
    for (const deadline = Date.now() + 5000; pausedTenantWriters().length && Date.now() < deadline;)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(pausedTenantWriters(), []);
    const lines = logged.filter((line) => line.includes("tenant-commands's tenant writer"));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /closed after a write whose outcome could not be confirmed; .*\/readyz answers 503/);
    assert.match(
      lines[1],
      executed ? /reopened after \d+s; the uncertain command committed\.$/ : /reopened after \d+s; the uncertain command did not commit\.$/,
    );
    // The same key again: the journal answers a landed command, and runs one that did not land exactly once.
    const retried = await service.execute(request, north, f.body());
    assert.equal(retried.replayed, executed);
    assert.equal(f.control.calls, executed ? 1 : 2);
    assert.equal(f.version(), 1);
    assert.deepEqual(f.counts(), [1, 1]);
    const next = await service.execute(request, north, f.body('north', { expectedVersion: 1, idempotencyKey: 'tenant-attempt-0003' }));
    assert.equal(next.status, 'applied');
    assert.equal(f.version(), 2);
  });
}

test('changed input under a committed request key is an unknown-outcome conflict, not a rerun', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  await service.execute(request, north, f.body());
  const changed = f.body('north', { input: { reviewerId: 'north-second', secondId: 'north-reviewer' } });
  for (const run of [service.execute, service.status])
    await assert.rejects(run(request, north, changed), refused('unknown', 'idempotency_conflict'));
  assert.equal(f.control.calls, 1);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
});

for (const denial of ['no session', 'global admin only', 'revoked membership', 'hidden target', 'cross-tenant key'] as const) {
  test(`${denial} before authorized receipt absence cannot run or reveal an execute/status outcome`, async (t) => {
    const f = await fixture(t);
    let hide = false;
    const service = await f.issue({ resolveRows: () => ({ ...f.rows, item: !hide }) });
    if (denial === 'no session') f.setIdentity(null);
    if (denial === 'global admin only')
      await f.maintenance((admin) => admin.putMembership({ ...f.grant, roles: ['viewer'], expectedVersion: '1' }));
    if (denial === 'revoked membership') await f.revoke();
    if (denial === 'hidden target') hide = true;
    const body = denial === 'cross-tenant key' ? f.body('north', { key: { id: 'south-row' } }) : f.body();
    for (const run of [service.execute, service.status]) await assert.rejects(run(request, north, body), refused('unknown'));
    assert.equal(f.control.calls, 0);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const dependency of ['target', 'first reference', 'second reference', 'membership grant'] as const) {
  test(`current ${dependency} revocation denies committed replay/status without invoking handler or falling back`, async (t) => {
    const f = await fixture(t);
    let hidden = false;
    const service = await f.issue({ resolveRows: () => ({ ...f.rows, item: !hidden }) });
    await service.execute(request, north, f.body());
    if (dependency === 'target') hidden = true;
    if (dependency === 'first reference') f.db.exec("UPDATE db_reviewer SET visible=0 WHERE id='north-reviewer'");
    if (dependency === 'second reference') f.db.exec("UPDATE db_reviewer SET visible=0 WHERE id='north-second'");
    if (dependency === 'membership grant')
      await f.maintenance((admin) => admin.putMembership({ ...f.grant, roles: ['viewer'], expectedVersion: '1' }));
    for (const run of [service.execute, service.status]) await assert.rejects(run(request, north, f.body()), refused('unknown'));
    assert.equal(f.control.calls, 1);
    assert.equal(f.version(), 1);
    assert.deepEqual(f.counts(), [1, 1]);
  });
}

test('a hidden second fresh result reference rolls back the write and preserves forbidden/not_applied after absence', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  await assert.rejects(
    service.execute(request, north, f.body('north', { input: { reviewerId: 'north-reviewer', secondId: 'north-hidden' } })),
    refused('not_applied', 'forbidden'),
  );
  assert.equal(f.control.calls, 1);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('known business refusal after absence preserves its safe code and rollback outcome', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  f.control.after = () => refuse('reviewer_unavailable');
  await assert.rejects(service.execute(request, north, f.body()), refused('not_applied', 'reviewer_unavailable'));
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('a conflict with a row the tenant cannot see says nothing about it, and still records why', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  /* db_item is UNIQUE(tenant_id COLLATE BINARY, business_id), and the index it
     refused on spans rows outside what this caller may read. The platform
     cannot tell a conflict with the tenant's own row from one with a row kept
     invisible, so under a scoped invocation it names neither: the answer stays
     the value-free one, and the reason is kept where only the owner reads it. */
  f.control.handle = async (context, input) => {
    await context.tx.insert({ table: 'item', values: { id: 'second-north', business_id: 'same-business', version: 0, name: 'Second' } });
    return { ...input, version: 1 };
  };
  await assert.rejects(service.execute(request, north, f.body()), (error: unknown) => {
    refused('not_applied', 'temporarily_unavailable')(error);
    assert.equal(writeFailureKind(refusalCause(error)), 'unique', 'the owner can still say what refused');
    return true;
  });
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE name='Second'").get()!.n, 0);
});

test('a refusal keeps the input it objected to across the tenant boundary', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  // The App author names the field; it used to arrive as undefined, leaving
  // the caller to guess which part of the envelope was rejected.
  f.control.after = () => refuse('invalid_input', 'reviewerId');
  await assert.rejects(service.execute(request, north, f.body()), (error: unknown) => {
    refused('not_applied', 'invalid_input')(error);
    assert.equal((error as BusinessCommandExecutionError).field, 'reviewerId');
    return true;
  });
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('an unrecognized failure still refuses vaguely, but keeps its reason where only the owner can read it', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  // Not a constraint code, so the refusal stays the vague one — and the driver
  // error the boundary used to discard is now readable by a trusted diagnostic.
  f.control.handle = async () => {
    throw Object.assign(new Error('PRIVATE_SENTINEL disk went away'), { code: 'EIO' });
  };
  await assert.rejects(service.execute(request, north, f.body()), (error: unknown) => {
    refused('not_applied', 'temporarily_unavailable')(error);
    assert.match(String((refusalCause(error) as Error).message), /PRIVATE_SENTINEL/);
    return true;
  });
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('prepare reads the version column and refuses version mismatch without reinterpreting it', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  await assert.rejects(
    service.prepare(request, north, { ...f.prepare(), commandVersion: 2 }),
    refused('unknown', 'command_version_mismatch'),
  );
  assert.deepEqual(plain(await service.prepare(request, north, f.prepare())), { expectedVersion: 0 });
  assert.equal(f.control.calls, 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

for (const invalid of [
  'generic manager write',
  'inactive generic write',
  'hidden ordinary field',
  'missing root write',
  'missing result extractor',
] as const) {
  test(`factory refuses ${invalid} without invoking handlers or writing receipts`, async (t) => {
    const f = await fixture(t),
      app = plain(f.app);
    if (invalid === 'generic manager write') app.auth!.roles!.manager.write = ['item'];
    if (invalid === 'inactive generic write') app.auth!.roles!.unused = { read: true, write: ['item'] };
    if (invalid === 'hidden ordinary field') app.resources!.item.fields!.read = ['id', 'business_id', 'version'];
    if (invalid === 'missing root write') delete app.resources!.item.access;
    const commands = invalid === 'missing result extractor' ? { registry: f.registry, resultReferences: {} } : f.commands;
    await assert.rejects(f.issue({ app, commands }), (error) => {
      assert.ok(error instanceof BusinessCommandDefinitionError);
      assert.equal('cause' in error, false);
      assert.doesNotMatch(error.message, /PRIVATE_SENTINEL|db_item/);
      return true;
    });
    assert.equal(f.control.calls, 0);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

/* A column rule on a tenant command's footprint — a role's, active or not,
   or the resource's own write ceiling — narrows generic reads and writes and
   never the handler, which reads its footprint whole as the service it is:
   the leads desk withholds an applicant's SSN from a salesperson and still
   runs its commands. The owner column stays out wherever the member does not
   see it, and nothing withheld reaches the reply. */
for (const rule of ['active role fields', 'inactive role fields', 'nonwritable ordinary field'] as const) {
  test(`${rule} on a tenant command's footprint starts, and the handler reads the row whole`, async (t) => {
    const f = await fixture(t),
      app = plain(f.app);
    if (rule === 'active role fields') app.auth!.roles!.manager.fields = { item: { read: ['id', 'business_id', 'version'] } };
    if (rule === 'inactive role fields')
      app.auth!.roles!.unused = { read: true, write: false, fields: { item: { read: ['id', 'business_id', 'version'] } } };
    if (rule === 'nonwritable ordinary field') app.resources!.item.fields!.write = ['id', 'business_id', 'version'];
    const service = await f.issue({ app });
    const result = await service.execute(request, north, f.body());
    assert.equal(result.status, 'applied');
    assert.equal(f.version(), 1);
    assert.equal(f.control.seen!.record!.name, 'North');
    assert.equal('tenant_id' in f.control.seen!.record!, false);
    assert.doesNotMatch(JSON.stringify(result), /North"|tenant_id/);
  });
}

/* A tenant's numbers are its own: the same sequence and `per` in two
   tenants count separately, so one never learns how many the other took. */
test("a tenant command numbers from its own tenant's sequence", async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const taken: number[] = [];
  f.control.handle = async (context, input) => {
    taken.push(await context.nextNumber('assignment', { per: 'desk', start: 100 }));
    const version = Number(context.record!.version) + 1;
    await context.tx.update({
      table: 'item',
      key: { id: String(context.record!.id) },
      expected: { version: version - 1 },
      values: { version },
    });
    return { ...input, version };
  };
  await service.execute(request, north, f.body());
  await service.execute(request, ['south'], f.body('south'));
  await service.execute(request, north, f.body('north', { expectedVersion: 1, idempotencyKey: 'tenant-attempt-0002' }));
  assert.deepEqual(taken, [100, 100, 101]);
  assert.deepEqual(
    f.db
      .prepare('SELECT tenant_id, value FROM __mistri_sequence_number ORDER BY tenant_id')
      .all()
      .map((row) => ({ ...row })),
    [
      { tenant_id: 'north', value: 101 },
      { tenant_id: 'south', value: 100 },
    ],
  );
});

test('complete composite owner keys work but NOCASE aliases, omitted owner and extra key fields refuse before lookup', async (t) => {
  const f = await fixture(t, { target: 'local' }),
    service = await f.issue();
  const keys: Array<Record<string, string | number>> = [
    { tenant_id: 'North', local_id: 1 },
    { tenant_id: 'north ', local_id: 1 },
    { local_id: 1 },
    { tenant_id: 'south', local_id: 1 },
    { tenant_id: 'north', local_id: 1, version: 0 },
  ];
  for (const key of keys) {
    await assert.rejects(service.prepare(request, north, { ...f.prepare(), key }), refused('not_applied', 'forbidden'));
    for (const run of [service.execute, service.status])
      await assert.rejects(run(request, north, f.body('north', { key })), refused('unknown'));
  }
  assert.equal(f.control.calls, 0);
  assert.deepEqual(f.counts(), [0, 0]);
  assert.deepEqual(plain(await service.prepare(request, north, f.prepare())), { expectedVersion: 0 });
  const applied = await service.execute(request, north, f.body());
  assert.deepEqual(plain(applied.key), { tenant_id: 'north', local_id: 1 });
  assert.equal(f.version(), 1);
  assert.equal(f.version('south'), 0);
});

test('handler projections hide the owner and SQL while tenant, membership and authored policies all constrain a hostile OR', async (t) => {
  const f = await fixture(t);
  const service = await f.issue({
    resolveMembershipRows: () => ({ ...f.rows, item: { groups: [[{ column: 'version', op: '=', value: 0 }]] } }),
    resolveRows: () => ({ ...f.rows, item: { groups: [[{ column: 'name', op: '=', value: 'North' }]] } }),
  });
  let observed: QueryResult | undefined;
  f.control.handle = async (context, input) => {
    observed = await context.tx.query({
      table: 'item',
      limit: 50,
      offset: 0,
      filter: { groups: [[{ column: 'id', op: '!=', value: 'north-row' }], [{ column: 'id', op: '=', value: 'north-row' }]] },
    });
    // Do not change the membership policy's version field in this scenario.
    await context.tx.update({ table: 'item', key: recordKey(context), values: { business_id: 'changed-business' } });
    return { ...input, version: 0 };
  };
  await service.execute(request, north, f.body());
  assert.ok(observed);
  assert.deepEqual(plain(observed.rows), [{ id: 'north-row', business_id: 'same-business', version: 0, name: 'North' }]);
  assert.deepEqual(plain(observed.columns), ['id', 'business_id', 'version', 'name']);
  assert.deepEqual(plain(observed.sql), { text: '', params: [] });
  assert.doesNotMatch(JSON.stringify(observed), /tenant_id|db_item|SELECT|Alias|South/);
  assert.equal(f.db.prepare("SELECT business_id FROM db_item WHERE id='north-row'").get()!.business_id, 'changed-business');
});

for (const violation of [
  'owner write',
  'owner read',
  'outside read footprint',
  'outside write footprint',
  'private table',
  'malformed filter',
] as const) {
  test(`caught handler ${violation} poisons the transaction and rolls back earlier effects`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    let caught = false;
    f.control.handle = async (context, input) => {
      await context.tx.update({ table: 'item', key: recordKey(context), values: { version: 1 } });
      try {
        if (violation === 'owner write')
          await context.tx.update({ table: 'item', key: recordKey(context), values: { tenant_id: 'north' } });
        if (violation === 'owner read') await context.tx.query({ table: 'item', columns: ['tenant_id'], limit: 1, offset: 0 });
        if (violation === 'outside read footprint') await context.tx.count('other');
        if (violation === 'outside write footprint')
          await context.tx.update({ table: 'reviewer', key: { id: 'north-reviewer' }, values: { name: 'changed' } });
        if (violation === 'private table') await context.tx.count(tables.receipt);
        if (violation === 'malformed filter')
          await context.tx.query({ table: 'item', limit: 10, offset: 0, filter: { groups: [{}] } as never });
      } catch {
        caught = true;
      }
      return { ...input, version: 1 };
    };
    await assert.rejects(service.execute(request, north, f.body()), refused('not_applied'));
    assert.equal(caught, true);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('body, selectors and execution options are captured before a verifier wait and cannot retarget the handler', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  let verifying = 0;
  const service = await f.issue({
    verifySession: async () => {
      if (++verifying === 1) {
        entered.release();
        await release.promise;
      }
      return { id: 'alice', who: 'Alice' };
    },
  });
  const body = { ...f.body(), key: { id: 'north-row' } },
    selectors = ['north'],
    abort = new AbortController();
  const options = { requestId: 'captured-request', signal: abort.signal };
  const pending = service.execute(request, selectors, body, options);
  await entered.promise;
  body.key.id = 'south-row';
  (body.input as Input).reviewerId = 'south-reviewer';
  selectors[0] = 'south';
  options.requestId = 'swapped-request';
  options.signal = new AbortController().signal;
  release.release();
  const result = await pending;
  assert.deepEqual(plain(result.key), { id: 'north-row' });
  assert.equal((result.result as Output).reviewerId, 'north-reviewer');
  assert.equal(f.control.seen!.requestId, 'captured-request');
  assert.notEqual(f.control.seen!.signal, abort.signal);
  assert.equal(f.version(), 1);
  assert.equal(f.version('south'), 0);
});

test('factory captures app grants, registry extractors and policy callbacks independently of later configuration mutation', async (t) => {
  const f = await fixture(t),
    app = plain(f.app),
    extractors = { ...f.commands.resultReferences };
  const configuration = {
    app,
    commands: { registry: f.registry, resultReferences: extractors },
    resolveRows: (): RowScope => f.rows,
  } satisfies Partial<Options>;
  const service = await f.issue(configuration);
  app.auth!.roles!.manager.commands = [];
  extractors.assign = () => {
    throw new Error('PRIVATE_SENTINEL');
  };
  configuration.resolveRows = () => ({});
  assert.equal((await service.execute(request, north, f.body())).status, 'applied');
  assert.equal(f.control.calls, 1);
  assert.equal(f.version(), 1);
});

test('pending handler native abort rolls back after known absence without an uncaught AbortSignal TypeError', async (t) => {
  const f = await fixture(t),
    service = await f.issue(),
    entered = gate(),
    release = gate(),
    abort = new AbortController();
  f.control.after = async () => {
    entered.release();
    await release.promise;
  };
  const rejected = assert.rejects(service.execute(request, north, f.body(), { signal: abort.signal }), refused('not_applied', 'cancelled'));
  await entered.promise;
  try {
    assert.doesNotThrow(() => abort.abort());
    assert.equal(f.control.seen!.signal.aborted, true);
  } finally {
    release.release();
  }
  await rejected;
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
  f.control.after = undefined;
  assert.equal((await service.execute(request, north, f.body())).status, 'applied');
});

test('an earlier abort listener stopping propagation cannot suppress command cancellation before COMMIT', async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  let stopped = 0;
  abort.signal.addEventListener('abort', (event) => {
    stopped++;
    event.stopImmediatePropagation();
  });
  const service = await f.issue();
  f.control.after = () => {
    abort.abort();
  };
  await assert.rejects(service.execute(request, north, f.body(), { signal: abort.signal }), refused('not_applied', 'cancelled'));
  assert.equal(stopped, 1);
  assert.equal(abort.signal.aborted, true);
  assert.equal(f.control.seen!.signal.aborted, true);
  assert.equal(f.control.calls, 1);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('own native signal accessors never execute and cannot hide cancellation or replace listener methods', async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  let accessors = 0;
  const trap = (): never => {
    accessors++;
    throw new Error('PRIVATE_SENTINEL');
  };
  Object.defineProperties(abort.signal, {
    aborted: { get: trap },
    addEventListener: { get: trap },
    removeEventListener: { get: trap },
  });
  const service = await f.issue();
  f.control.after = () => {
    abort.abort();
  };
  const failure = await service.execute(request, north, f.body(), { signal: abort.signal }).then(
    () => undefined,
    (error) => error,
  );
  assert.equal(accessors, 0);
  assert.equal(f.control.calls, 1);
  assert.equal(Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(abort.signal), true);
  assert.equal(f.control.seen!.signal.aborted, true);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
  refused('not_applied', 'cancelled')(failure);
});

test('a proxy command registry is rejected before defineCommands without invoking any proxy trap', async (t) => {
  const f = await fixture(t);
  let traps = 0;
  const trap = (): never => {
    traps++;
    throw new Error('PRIVATE_SENTINEL');
  };
  const registry = new Proxy(f.registry, { getPrototypeOf: trap, get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  await assert.rejects(f.issue({ commands: { registry, resultReferences: f.commands.resultReferences } }), (error) => {
    assert.ok(error instanceof BusinessCommandDefinitionError);
    assert.equal('cause' in error, false);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/);
    return true;
  });
  assert.equal(traps, 0);
  assert.equal(f.control.calls, 0);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

for (const stage of ['before admission', 'during verifier'] as const) {
  test(`native abort ${stage} never claims that a prior execution did not apply`, async (t) => {
    const f = await fixture(t),
      abort = new AbortController(),
      entered = gate(),
      release = gate();
    let calls = 0;
    const service = await f.issue({
      verifySession: async () => {
        if (++calls === 1 && stage === 'during verifier') {
          entered.release();
          await release.promise;
        }
        return { id: 'alice', who: 'Alice' };
      },
    });
    if (stage === 'before admission') abort.abort();
    const rejected = assert.rejects(service.execute(request, north, f.body(), { signal: abort.signal }), refused('unknown', 'cancelled'));
    if (stage === 'during verifier') {
      await entered.promise;
      abort.abort();
      release.release();
    }
    await rejected;
    assert.equal(f.control.calls, 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

for (const reason of ['expiry', 'account change', 'clock regression'] as const) {
  test(`${reason} after handler effects prevents commit and buffered result release`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    f.control.after = () => {
      if (reason === 'expiry') f.setTime(6000);
      if (reason === 'clock regression') f.setTime(999);
      if (reason === 'account change') f.setIdentity({ id: 'bob', who: 'Bob' });
    };
    await assert.rejects(service.execute(request, north, f.body()), refused('not_applied'));
    assert.equal(f.control.calls, 1);
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
  });
}

test('retirement immediately closes admission, drains the accepted handler and rolls its effects back', async (t) => {
  const f = await fixture(t),
    service = await f.issue(),
    entered = gate(),
    release = gate();
  let retired = false;
  f.control.after = async () => {
    entered.release();
    await release.promise;
  };
  const rejected = assert.rejects(service.execute(request, north, f.body()), refused('not_applied'));
  await entered.promise;
  const closing = service.retire();
  void closing.then(() => {
    retired = true;
  });
  try {
    assert.equal(service.retire(), closing);
    assert.equal(retired, false);
    await assert.rejects(service.status(request, north, f.body()), refused('unknown'));
    await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
  } finally {
    release.release();
  }
  await rejected;
  await closing;
  assert.equal(retired, true);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('membership revocation winning before writer acquisition denies command before receipt lookup', async (t) => {
  const f = await fixture(t);
  let revoked = false;
  const service = await f.issue({
    resolveRows: async () => {
      if (!revoked) {
        revoked = true;
        await f.revoke();
      }
      return f.rows;
    },
  });
  await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
  assert.equal(revoked, true);
  assert.equal(f.control.calls, 0);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('owned command writer fences second-connection membership revocation until commit', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  let blocked = false;
  f.control.before = async () => {
    try {
      await f.revoke();
    } catch (error) {
      blocked = /locked|busy/.test(String(error));
    }
  };
  await service.execute(request, north, f.body());
  assert.equal(blocked, true);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
  await f.revoke();
  await assert.rejects(service.status(request, north, f.body()), refused('unknown'));
  assert.equal(f.control.calls, 1);
});

for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
  for (const executed of [false, true]) {
    test(`native ${boundary} ${executed ? 'lost acknowledgment' : 'before execution'} stays unknown; fresh source reconciles exact receipt`, async (t) => {
      const f = await fixture(t),
        service = await f.issue(),
        original = DatabaseSync.prototype.exec;
      const writers = new WeakSet<DatabaseSync>();
      let faults = 0;
      const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
        if (sql === 'BEGIN IMMEDIATE') writers.add(this);
        if (writers.has(this) && sql === boundary) {
          faults++;
          if (executed) original.call(this, sql);
          throw new Error('PRIVATE_SENTINEL');
        }
        return original.call(this, sql);
      });
      if (boundary === 'ROLLBACK') f.control.after = () => refuse('ineligible_state');
      try {
        await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
      } finally {
        mocked.mock.restore();
      }
      assert.equal(faults, 1);
      const landed = boundary === 'COMMIT' && executed;
      assert.equal(f.version(), landed ? 1 : 0);
      assert.deepEqual(f.counts(), landed ? [1, 1] : [0, 0]);
      await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
      assert.equal(f.control.calls, 1);
      await service.retire();
      f.control.after = undefined;
      const fresh = await f.issue(),
        result = await fresh.execute(request, north, f.body());
      assert.equal(result.replayed, landed);
      assert.equal(f.control.calls, landed ? 1 : 2);
      assert.equal(f.version(), 1);
      assert.deepEqual(f.counts(), [1, 1]);
    });
  }
}

test('native unknown raised by the handler is not weakened by a confirmed outer rollback', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  f.control.after = () => {
    throw new TransactionOutcomeUnknown(new Error('PRIVATE_SENTINEL'));
  };
  await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
  f.control.after = undefined;
  await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
  assert.equal(f.control.calls, 1);
});

test('postcommit session loss remains unknown and a fresh authenticated retry replays the durable receipt', async (t) => {
  const f = await fixture(t);
  const service = await f.issue({ verifySession: () => (f.version() === 1 ? null : { id: 'alice', who: 'Alice' }) });
  await assert.rejects(service.execute(request, north, f.body()), refused('unknown'));
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
  assert.equal(f.control.calls, 1);
  await service.retire();
  const fresh = await f.issue();
  assert.equal((await fresh.execute(request, north, f.body())).replayed, true);
  assert.equal(f.control.calls, 1);
});

test('postcommit native abort cannot release success or claim rollback; retry reconciles the durable receipt', async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  const service = await f.issue({
    verifySession: () => {
      if (f.version() === 1) abort.abort();
      return { id: 'alice', who: 'Alice' };
    },
  });
  await assert.rejects(service.execute(request, north, f.body(), { signal: abort.signal }), refused('unknown', 'cancelled'));
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
  assert.equal(f.control.calls, 1);
  assert.equal((await service.execute(request, north, f.body())).replayed, true);
  assert.equal(f.control.calls, 1);
});

test('native abort in the final session after executor completion but before COMMIT confirms rollback, not success', async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  let writer: DatabaseSync | undefined,
    stagedChecks = 0,
    commits = 0;
  const service = await f.issue({
    verifySession: () => {
      if (writer?.isTransaction && writer.prepare(`SELECT count(*) AS n FROM "${tables.receipt}"`).get()!.n === 1) {
        // First is the journal operation's postcheck; second is the owner's
        // final session check after the executor has returned its success DTO.
        if (++stagedChecks === 2) abort.abort();
      }
      return { id: 'alice', who: 'Alice' };
    },
  });
  const original = DatabaseSync.prototype.exec;
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    // The only raw handle in this test is diagnostic fault injection; handlers
    // still receive the genuine limited command record facade.
    // oxlint-disable-next-line typescript/no-this-alias
    if (sql === 'BEGIN IMMEDIATE') writer = this;
    if (this === writer && sql === 'COMMIT') commits++;
    return original.call(this, sql);
  });
  try {
    await assert.rejects(service.execute(request, north, f.body(), { signal: abort.signal }), refused('not_applied', 'cancelled'));
  } finally {
    mocked.mock.restore();
  }
  assert.equal(stagedChecks, 2);
  assert.equal(commits, 0);
  assert.equal(f.control.calls, 1);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('a now callback aborting at the final source guard is rechecked after the clock and before COMMIT', async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  const handles: DatabaseSync[] = [];
  let stagedSessions = 0,
    finalClocks = 0,
    commits = 0;
  const service = await f.issue({
    verifySession: () => {
      const writer = handles[0];
      if (writer?.isTransaction && writer.prepare(`SELECT count(*) AS n FROM "${tables.receipt}"`).get()!.n === 1) stagedSessions++;
      return { id: 'alice', who: 'Alice' };
    },
    now: () => {
      if (stagedSessions === 2 && handles[0]?.isTransaction) {
        // After the final session: its postcheck, then the source verifier's
        // entry, membership-snapshot and final live checks. Abort in that last
        // host clock callback, after its entry cancellation check has run.
        if (++finalClocks === 4) abort.abort();
      }
      return 1000;
    },
  });
  const original = DatabaseSync.prototype.exec;
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') handles.push(this);
    if (this === handles[0] && sql === 'COMMIT') commits++;
    return original.call(this, sql);
  });
  let failure: unknown;
  try {
    failure = await service.execute(request, north, f.body(), { signal: abort.signal }).then(
      () => undefined,
      (error) => error,
    );
  } finally {
    mocked.mock.restore();
  }
  assert.equal(finalClocks, 4);
  assert.equal(abort.signal.aborted, true);
  assert.deepEqual({ commits, version: f.version(), counts: f.counts() }, { commits: 0, version: 0, counts: [0, 0] });
  refused('not_applied', 'cancelled')(failure);
});

test('the independent writer-source clock aborting at final precommit is checked before COMMIT, not after durable effects', async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  const handles: DatabaseSync[] = [];
  let stagedSessions = 0,
    finalSourceClocks = 0,
    commits = 0;
  const service = await f.issue({
    verifySession: () => {
      const writer = handles[0];
      if (writer?.isTransaction && writer.prepare(`SELECT count(*) AS n FROM "${tables.receipt}"`).get()!.n === 1) stagedSessions++;
      return { id: 'alice', who: 'Alice' };
    },
  });
  f.setWriterClock(() => {
    // The source has its own clock, distinct from the request owner's clock.
    // Its final verifier calls live at entry, membership snapshot and exit.
    if (stagedSessions === 2 && handles[0]?.isTransaction && ++finalSourceClocks === 3) abort.abort();
    return 1000;
  });
  const original = DatabaseSync.prototype.exec;
  const mocked = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'BEGIN IMMEDIATE') handles.push(this);
    if (this === handles[0] && sql === 'COMMIT') commits++;
    return original.call(this, sql);
  });
  let failure: unknown;
  try {
    failure = await service.execute(request, north, f.body(), { signal: abort.signal }).then(
      () => undefined,
      (error) => error,
    );
  } finally {
    mocked.mock.restore();
  }
  assert.equal(finalSourceClocks, 3);
  assert.equal(abort.signal.aborted, true);
  assert.deepEqual({ commits, version: f.version(), counts: f.counts() }, { commits: 0, version: 0, counts: [0, 0] });
  refused('not_applied', 'cancelled')(failure);
});

test('another current account cannot inspect the first account receipt and uses its own key namespace', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const alice = await service.execute(request, north, f.body());
  f.setIdentity({ id: 'bob', who: 'Bob' });
  assert.deepEqual(plain(await service.status(request, north, f.body())), { status: 'not_found', outcome: 'unknown' });
  const bob = await service.execute(request, north, f.body('north', { expectedVersion: 1 }));
  assert.notEqual(bob.receiptId, alice.receiptId);
  assert.equal(bob.replayed, false);
  assert.equal(f.control.calls, 2);
  assert.equal(f.version(), 2);
  assert.deepEqual(f.counts(), [2, 2]);
});

for (const journal of ['missing', 'version 1'] as const) {
  test(`${journal} journal replacement after capture refuses prepare/execute/status without handler entry or business effect`, async (t) => {
    const f = await fixture(t),
      service = await f.issue();
    if (journal === 'missing') {
      f.db.exec(`DROP TABLE "${tables.receipt}"; DROP TABLE "${tables.meta}";`);
    } else
      f.db
        .exec(`DROP TABLE "${tables.meta}"; CREATE TABLE "${tables.meta}" (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1));
      INSERT INTO "${tables.meta}" VALUES(1,1);`);
    await assert.rejects(service.prepare(request, north, f.prepare()), refused('not_applied'));
    for (const run of [service.execute, service.status]) await assert.rejects(run(request, north, f.body()), refused('unknown'));
    assert.equal(f.control.calls, 0);
    assert.equal(f.version(), 0);
  });
}

for (const operation of ['insert', 'update'] as const) {
  for (const includeParent of [false, true]) {
    test(`command ${operation} ${includeParent ? 'allows its declared' : 'refuses an App-visible but undeclared'} FK parent through the actual scoped writer`, async (t) => {
      const f = await fixture(t, { foreignKey: true, includeParent }),
        service = await f.issue();
      f.control.handle = async (context, input) => {
        if (operation === 'insert') {
          await context.tx.insert({
            table: 'item',
            values: { id: 'child-row', business_id: 'child-business', name: 'Child', version: 0, parent_id: 'north-other' },
          });
          await context.tx.update({ table: 'item', key: recordKey(context), values: { version: 1 } });
        } else await context.tx.update({ table: 'item', key: recordKey(context), values: { version: 1, parent_id: 'north-other' } });
        return { ...input, version: 1 };
      };
      if (includeParent) assert.equal((await service.execute(request, north, f.body())).status, 'applied');
      else await assert.rejects(service.execute(request, north, f.body()), refused('not_applied'));
      assert.equal(f.control.calls, 1);
      assert.equal(f.version(), includeParent ? 1 : 0);
      assert.deepEqual(f.counts(), includeParent ? [1, 1] : [0, 0]);
      const children = f.db.prepare('SELECT id,parent_id FROM db_item WHERE parent_id IS NOT NULL').all();
      assert.deepEqual(
        plain(children),
        includeParent ? [{ id: operation === 'insert' ? 'child-row' : 'north-row', parent_id: 'north-other' }] : [],
      );
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_other WHERE id='north-other'").get()!.n, 1);
    });
  }
}

test('invalid ordinary bodies, selector ambiguity and forged execution options cannot enter a handler or claim no prior effect', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  let hooks = 0;
  const accessor = Object.defineProperty({}, 'input', {
    enumerable: true,
    get() {
      hooks++;
      throw new Error('PRIVATE_SENTINEL');
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        hooks++;
        throw new Error('PRIVATE_SENTINEL');
      },
    },
  );
  for (const body of [
    null,
    {},
    accessor,
    proxy,
    { ...f.body(), tenantId: 'south' },
    f.body('north', { key: { id: NaN } }),
    f.body('north', { input: { reviewerId: 'north-reviewer' } }),
    f.body('north', { idempotencyKey: 'short' }),
  ]) {
    for (const run of [service.execute, service.status])
      await assert.rejects(run(request, north, body), refused('unknown', 'invalid_input'));
  }
  for (const selectors of [[], ['north', 'north'], ['north', 'south'], ['North']]) {
    await assert.rejects(service.execute(request, selectors, f.body()), refused('unknown'));
  }
  const badOptions = [
    { signal: { aborted: false } },
    { requestId: 'bad request' },
    Object.defineProperty({}, 'signal', {
      enumerable: true,
      get() {
        hooks++;
        throw new Error();
      },
    }),
  ];
  for (const options of badOptions)
    await assert.rejects(service.execute(request, north, f.body(), options as never), refused('unknown', 'invalid_input'));
  assert.equal(hooks, 0);
  assert.equal(f.control.calls, 0);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('unawaited accepted writes drain with captured arguments; returned data and retained records cannot mutate a committed result', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  let returned: Output | undefined;
  f.control.handle = async (context, input) => {
    const update = { table: 'item', key: { id: 'north-row' }, values: { version: 1 } };
    void context.tx.update(update);
    update.key.id = 'south-row';
    update.values.version = 9;
    returned = { ...input, version: 1 };
    return returned;
  };
  const applied = await service.execute(request, north, f.body());
  assert.equal(f.version(), 1);
  assert.equal(f.version('south'), 0);
  assert.deepEqual(f.counts(), [1, 1]);
  returned!.reviewerId = 'south-reviewer';
  assert.equal((applied.result as Output).reviewerId, 'north-reviewer');
  assert.ok(Object.isFrozen(applied.result));
  await assert.rejects(f.control.seen!.tx.update({ table: 'item', key: { id: 'north-row' }, values: { version: 8 } }));
  assert.equal(f.version(), 1);
  assert.deepEqual(plain(await service.status(request, north, f.body())), { ...plain(applied), replayed: true });
});

test('caught unawaited malformed work still poisons the command and prevents receipt publication', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  let caught = false;
  f.control.handle = async (context, input) => {
    void context.tx.update({ table: 'item', key: recordKey(context), values: { version: 1 } });
    void context.tx.query({ table: 'item', limit: 10, offset: 0, filter: { groups: [{}] } as never }).catch(() => {
      caught = true;
    });
    return { ...input, version: 1 };
  };
  await assert.rejects(service.execute(request, north, f.body()), refused('not_applied'));
  assert.equal(caught, true);
  assert.equal(f.version(), 0);
  assert.deepEqual(f.counts(), [0, 0]);
});

test('command-declared insert/remove use managed owner injection and projected results without generic CRUD or Undo', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  let inserted: unknown, removed: unknown;
  f.control.handle = async (context, input) => {
    inserted = await context.tx.insert({
      table: 'item',
      values: { id: 'created-command-row', business_id: 'created-business', name: 'Created', version: 0 },
    });
    removed = await context.tx.remove({ table: 'item', key: { id: 'created-command-row' } });
    await context.tx.update({ table: 'item', key: recordKey(context), values: { version: 1 } });
    return { ...input, version: 1 };
  };
  const applied = await service.execute(request, north, f.body());
  assert.doesNotMatch(JSON.stringify({ inserted, removed, applied }), /tenant_id|db_item|SELECT|undoId/);
  assert.deepEqual(plain(removed), { affected: 1, sql: { text: '', params: [] } });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id='created-command-row'").get()!.n, 0);
  assert.equal(f.version(), 1);
  assert.deepEqual(f.counts(), [1, 1]);
});

for (const invalid of [
  'cross-tenant',
  'outside footprint',
  'extra reference field',
  'asynchronous extractor',
  'sparse references',
] as const) {
  test(`${invalid} historical result references refuse both fresh publication and retained receipt disclosure`, async (t) => {
    const f = await fixture(t);
    let corrupted = false;
    const valid = f.commands.resultReferences.assign;
    const extract = (result: unknown) => {
      if (!corrupted) return valid(result);
      if (invalid === 'cross-tenant') return [{ table: 'reviewer', key: { id: 'south-reviewer' } }];
      if (invalid === 'outside footprint') return [{ table: 'other', key: { id: 'north-other' } }];
      if (invalid === 'extra reference field') return [{ table: 'reviewer', key: { id: 'north-reviewer' }, tenantId: 'north' }];
      if (invalid === 'asynchronous extractor') return Promise.resolve(valid(result)) as never;
      return Array(2) as never;
    };
    const service = await f.issue({ commands: { registry: f.registry, resultReferences: { assign: extract } } });
    corrupted = true;
    await assert.rejects(service.execute(request, north, f.body()), refused('not_applied'));
    assert.equal(f.version(), 0);
    assert.deepEqual(f.counts(), [0, 0]);
    corrupted = false;
    await service.execute(request, north, f.body());
    corrupted = true;
    for (const run of [service.execute, service.status]) await assert.rejects(run(request, north, f.body()), refused('unknown'));
    assert.equal(f.control.calls, 2);
    assert.equal(f.version(), 1);
    assert.deepEqual(f.counts(), [1, 1]);
  });
}

test('a row action removes its own target: judged before the removal, gone after it, audited with its owner', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  f.control.handle = async (context, input) => {
    const { affected } = await context.tx.remove({ table: 'item', key: recordKey(context) });
    assert.equal(affected, 1);
    return { ...input, version: 0 };
  };
  const result = await service.execute(request, north, f.body(), { requestId: 'request-remove' });
  assert.equal(result.status, 'applied');
  assert.deepEqual(plain(result.key), { id: 'north-row' });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id='north-row'").get()!.n, 0);
  assert.deepEqual(f.counts(), [1, 1]);
  assert.equal(f.control.calls, 1);
  // Another tenant's row is still judged before anything is removed.
  f.control.handle = async (context, input) => {
    await context.tx.remove({ table: 'item', key: { id: 'south-row' } });
    return { ...input, version: 0 };
  };
  await assert.rejects(
    service.execute(request, north, f.body('north', { key: { id: 'alias-row' }, idempotencyKey: 'tenant-attempt-0002' })),
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM db_item WHERE id='south-row'").get()!.n, 1);
});
