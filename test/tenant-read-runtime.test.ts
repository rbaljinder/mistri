import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations, type Filter, type QueryRequest, type ScopedReads } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { TenantContextError, TenantRequestFault } from '../packages/engine/src/server/evidence.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import {
  createTenantReadRuntime,
  tenantReadCounters,
  type TenantReadContext,
  type TenantReadRuntimeOptions,
} from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  TENANT_TABLES,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

interface Request {
  cookie: string;
}
type Options = TenantReadRuntimeOptions<Request>;
type Runtime = ReturnType<typeof createTenantReadRuntime<Request>>;
const request: Request = { cookie: 'alice' };
const binding = { appId: 'tenant-app', source: { id: 'business', connection: 'owned-business' }, storeId: 'runtime-fixture' };
const resources = { item: 'physical_item', restricted: 'physical_restricted', country: 'physical_country' };
const query = (extra: Partial<QueryRequest> = {}): QueryRequest => ({ table: 'item', limit: 20, offset: 0, ...extra });
const view = (): ViewDef => ({ id: 'items', name: 'Items', base: 'item', columns: [{ path: 'id' }, { path: 'name' }] });
const breakdown = (): BreakdownDef => ({ base: 'item', by: [{ path: 'name' }], measures: [{ fn: 'count' }] });
const equal = (column: string, value: number | string): Filter => ({ groups: [[{ column, op: '=', value }]] });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('issuer completion cannot release read output under a clock older than the runtime high-water mark', async (t) => {
  const f = await fixture(t);
  let time = 1000,
    outputReady = false,
    clocksAfterCallback = 0;
  const runtime = f.issue({
    now: () => {
      if (outputReady && ++clocksAfterCallback === 4) return 1400;
      return time;
    },
  });
  await assert.rejects(
    runtime.withContext(request, ['north'], () => {
      time = 1500;
      outputReady = true;
      return 'PRIVATE_SENTINEL';
    }),
    privateFailure,
  );
  assert.equal(clocksAfterCallback, 4);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}

function privateFailure(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal(error.code, 'tenant_context_unavailable');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
}

// Assert outside the sanitized callback: an assertion thrown inside it would
// otherwise look like the expected runtime refusal and mask a successful read.
async function poisoned(runtime: Runtime, run: (data: ScopedReads) => Promise<unknown>) {
  let failure: unknown;
  await assert.rejects(
    runtime.withContext(request, ['north'], async ({ data }) => {
      try {
        await run(data);
      } catch (error) {
        failure = error;
      }
      return 'a caught read failure must not release this';
    }),
    privateFailure,
  );
  privateFailure(failure);
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-read-runtime-'));
  const path = join(directory, 'business.db');
  const writer = new DatabaseSync(path);
  const runtimes: Runtime[] = [];
  let source: Awaited<ReturnType<typeof openSqliteTenantReadSource>> | undefined;
  const adapter = new SqliteAdapter(path, 'Tenant runtime fixture');
  t.after(async () => {
    try {
      await Promise.all(runtimes.map((runtime) => runtime.retire()));
      await source?.close();
    } finally {
      await adapter.close();
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  writer.exec(`CREATE TABLE physical_item (
      id INTEGER PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL, name TEXT, secret TEXT);
    CREATE TABLE physical_restricted (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT);
    CREATE TABLE physical_country (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO physical_item VALUES (1, 'north', 'One', 'secret one'), (2, 'south', 'Two', 'secret two'),
      (3, 'North', 'Case alias', 'secret three'), (4, 'north ', 'Space alias', 'secret four'),
      (5, 'north', 'Five', 'secret five');
    INSERT INTO physical_restricted VALUES (1, 'north', 'Admin only');
    INSERT INTO physical_country VALUES (1, 'Global');`);
  provisionSqliteTenantStore(path, binding);
  const transaction = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    writer.exec('BEGIN');
    try {
      await run(createSqliteTenantAdministration(writer, operations, binding));
      await operations.finish();
      writer.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      writer.exec('ROLLBACK');
      throw error;
    }
  };
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['reviewer'],
    validUntil: 10_000,
    expectedVersion: null,
  };
  await transaction(async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({ ...grant, tenantId, membershipId: `${tenantId}-alice` });
    }
  });
  const physicalSchema = await adapter.introspect();
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      restricted: { kind: 'tenant', column: 'tenant_id' },
      country: { kind: 'global', access: 'read-only' },
    },
  });
  let time = 1000;
  source = await openSqliteTenantReadSource(path, ownership, binding, () => time);
  const app = parseAppConfig(
    {
      id: binding.appId,
      name: 'Tenant fixture',
      auth: {
        roles: { reviewer: { read: ['item', 'country'], write: ['item'], commands: ['edit'] }, administrator: { read: true, write: true } },
      },
      sources: { business: { connection: binding.source.connection } },
      resources: {
        item: { physical: resources.item, access: 'write', fields: { read: ['id', 'name'], write: ['name'] } },
        restricted: { physical: resources.restricted },
        country: { physical: resources.country },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'tenant runtime test',
  );
  let identity: Identity | null = { id: 'alice', who: 'Alice', role: 'administrator' };
  const rows: RowScope = { item: true, restricted: true, country: true };
  const options: Options = {
    app,
    source,
    deployment: 'deployment-1',
    roles: ['reviewer', 'administrator'],
    maxLifetimeMs: 5000,
    verifySession: (input) => (input.cookie === 'alice' ? identity : null),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    now: () => time,
  };
  const issue = (overrides: Partial<Options> = {}) => {
    const runtime = createTenantReadRuntime({ ...options, ...overrides });
    runtimes.push(runtime);
    return runtime;
  };
  return {
    app,
    options,
    issue,
    source,
    writer,
    rows,
    transaction,
    setTime: (value: number) => {
      time = value;
    },
    setIdentity: (value: Identity | null) => {
      identity = value;
    },
    revoke: () => transaction((admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
  };
}

test('tenant runtime exposes only frozen read authority, with membership resource and field ceilings', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  frozen(runtime);
  assert.deepEqual(Reflect.ownKeys(runtime).sort(), ['retire', 'withContext']);
  const result = await runtime.withContext(request, ['north'], async (context) => {
    assert.deepEqual(Reflect.ownKeys(context).sort(), ['data', 'principal', 'schema', 'together']);
    assert.deepEqual(Reflect.ownKeys(context.data).sort(), ['count', 'countBreakdown', 'countView', 'query', 'runBreakdown', 'runView']);
    frozen(context);
    assert.deepEqual([...context.principal.roles], ['reviewer']);
    assert.equal(context.principal.accountId, 'alice');
    assert.equal(context.principal.tenantId, 'north');
    assert.deepEqual(context.schema.tables.map((table) => table.id).sort(), ['country', 'item']);
    assert.deepEqual(
      context.schema.tables.find((table) => table.id === 'item')!.columns.map((column) => column.name),
      ['id', 'name'],
    );
    const { query: read, count, runView, countView, runBreakdown, countBreakdown } = context.data;
    const rows = (await read(query())).rows;
    assert.deepEqual(plain(rows), [
      { id: 1, name: 'One' },
      { id: 5, name: 'Five' },
    ]);
    assert.equal(await count('item'), 2);
    assert.equal(await count('country'), 1);
    assert.equal((await runView(view())).rows.length, 2);
    assert.equal(await countView(view()), 2);
    assert.equal((await runBreakdown(breakdown())).rows.length, 2);
    assert.equal(await countBreakdown(breakdown()), 2);
    return rows;
  });
  frozen(result);
  assert.equal(result.length, 2);
});

test('presentation captures current membership data without granting writes to the read context', async (t) => {
  const f = await fixture(t);
  const offered = {
    resources: { item: { write: ['name'], insertable: false, deletable: false } },
    writable: ['item'],
    grantedCommands: ['edit'],
  };
  let roles: readonly string[] = [],
    inputColumns: string[] = [];
  const runtime = f.issue({
    presentation(principal, schema) {
      roles = principal.roles;
      inputColumns = schema.tables.find((table) => table.id === 'item')!.columns.map((column) => column.name);
      return offered;
    },
  });
  let retained: TenantReadContext | undefined;
  const result = await runtime.withContext(request, ['north'], (context) => {
    retained = context;
    offered.resources.item.write.length = 0;
    return context.capabilities;
  });
  assert.deepEqual([...roles], ['reviewer']);
  assert.deepEqual(inputColumns, ['id', 'name']);
  assert.deepEqual(plain(result!.resources.item.write), ['name']);
  frozen(result);
  assert.equal(
    retained!.schema.tables.every((table) => table.columns.every((column) => column.writable === false)),
    true,
  );
  assert.deepEqual(Object.keys(retained!.data).sort(), ['count', 'countBreakdown', 'countView', 'query', 'runBreakdown', 'runView']);
});

for (const change of ['session', 'membership', 'retire', 'throw', 'non-data'] as const) {
  test(`presentation cannot release metadata after ${change}`, async (t) => {
    const f = await fixture(t);
    let runtime: Runtime;
    let retired: Promise<void> | undefined;
    runtime = f.issue({
      presentation() {
        if (change === 'session') f.setIdentity(null);
        if (change === 'membership') f.writer.prepare(`UPDATE ${TENANT_TABLES.membership} SET status = 'revoked'`).run();
        if (change === 'retire') retired = runtime.retire();
        if (change === 'throw') throw new Error('PRIVATE_PRESENTATION');
        if (change === 'non-data') return { leak() {} } as unknown as ReturnType<NonNullable<Options['presentation']>>;
        return { resources: {}, writable: [], grantedCommands: [] };
      },
    });
    await assert.rejects(
      runtime.withContext(request, ['north'], (context) => context.capabilities),
      privateFailure,
    );
    await retired;
  });
}

for (const [label, run] of [
  ['global login admin cannot read a membership-denied resource', (data: ScopedReads) => data.query(query({ table: 'restricted' }))],
  ['physical aliases cannot bypass logical resources', (data: ScopedReads) => data.count('physical_item')],
  ['private membership catalog is not a resource', (data: ScopedReads) => data.count(TENANT_TABLES.membership)],
  ['field ceiling applies to explicit columns', (data: ScopedReads) => data.query(query({ columns: ['secret'] }))],
  ['field ceiling applies to filters', (data: ScopedReads) => data.count('item', equal('secret', 'secret one'))],
] as const) {
  test(label, async (t) => {
    const f = await fixture(t);
    await poisoned(f.issue(), run);
  });
}

/* A view or breakdown naming a column past the field ceiling is a question this reader's catalog cannot say: that
   read is refused (400), never the tenant's context, so a list whose rail asks a bad question keeps its session. It
   is refused exactly as a column that does not exist is, so the refusal tells nothing of what is hidden. */
for (const [label, ask] of [
  ['views', (data: ScopedReads, path: string) => data.runView({ ...view(), columns: [{ path }] })],
  ['breakdowns', (data: ScopedReads, path: string) => data.runBreakdown({ ...breakdown(), by: [{ path }] })],
] as const) {
  test(`field ceiling applies to ${label}: the read is refused as an unknown column is, and the context stands`, async (t) => {
    const f = await fixture(t);
    const refusals: Array<{ name: string; status: number; code: string; message: string }> = [];
    const answer = await f.issue().withContext(request, ['north'], async ({ data }) => {
      for (const path of ['secret', 'nowhere']) {
        try {
          await ask(data, path);
          assert.fail(`${path} was read`);
        } catch (error) {
          const { name, status, code, message } = error as TenantRequestFault;
          refusals.push({ name, status, code, message });
        }
      }
      return 'still standing';
    });
    assert.equal(answer, 'still standing');
    assert.deepEqual(refusals[0], {
      name: 'TenantRequestFault',
      status: 400,
      code: 'invalid_read',
      message: 'This read cannot be answered.',
    });
    assert.deepEqual(refusals[1], refusals[0]);
  });
}

test('mandatory tenant AND both policies survive a hostile OR and global resources need both policies', async (t) => {
  const f = await fixture(t);
  const runtime = f.issue({
    resolveMembershipRows: () => ({ item: equal('id', 1), country: true }),
    resolveRows: () => ({ item: { groups: [[{ column: 'name', op: '=', value: 'One' }], [{ column: 'id', op: '=', value: 2 }]] } }),
  });
  await runtime.withContext(request, ['north'], async ({ data }) => {
    assert.deepEqual(
      (
        await data.query(query({ filter: { groups: [[{ column: 'id', op: '!=', value: 2 }], [{ column: 'id', op: '=', value: 2 }]] } }))
      ).rows.map((row) => row.id),
      [1],
    );
    assert.equal(await data.count('country'), 0);
  });
});

test('projected reads and metadata never disclose hidden policy columns, bindings or physical SQL names', async (t) => {
  const f = await fixture(t);
  const sentinel = 'private-policy-value-6e7c';
  f.writer.prepare('UPDATE physical_item SET secret = ? WHERE id = 1').run(sentinel);
  const runtime = f.issue({ resolveRows: () => ({ item: equal('secret', sentinel) }) });
  await runtime.withContext(request, ['north'], async ({ data, schema }) => {
    const results = await Promise.all([data.query(query()), data.runView(view()), data.runBreakdown(breakdown())]);
    assert.deepEqual(plain(results[0].rows), [{ id: 1, name: 'One' }]);
    assert.equal(results[1].rows.length, 1);
    assert.equal(results[2].rows.length, 1);
    for (const result of results) assert.deepEqual(plain(result.sql), { text: '', params: [] });
    const exposed = JSON.stringify({ schema, results });
    for (const privateValue of [sentinel, 'secret', 'physical_item', 'tenant_id', '__mistri_']) {
      assert.equal(exposed.includes(privateValue), false, `must not disclose ${privateValue}`);
    }
    assert.ok(schema.tables.every((table) => !Object.hasOwn(table, 'approxRows')));
    assert.equal(await data.count('item'), 1);
    assert.equal(await data.countView(view()), 1);
    assert.equal(await data.countBreakdown(breakdown()), 1);
  });
});

test('retained readers cannot run after release or borrow another tenant context', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  let old!: ScopedReads;
  await runtime.withContext(request, ['north'], (context) => {
    old = context.data;
  });
  await assert.rejects(old.count('item'), privateFailure);
  await runtime.withContext(request, ['south'], async ({ data }) => {
    await assert.rejects(old.count('item'), privateFailure);
    assert.deepEqual(
      (await data.query(query())).rows.map((row) => row.id),
      [2],
    );
  });
});

test('concurrent tenant contexts keep separate principals, scopes and failures', async (t) => {
  const f = await fixture(t),
    runtime = f.issue(),
    started = gate(),
    release = gate();
  const north = runtime.withContext(request, ['north'], async ({ data }) => {
    started.release();
    await release.promise;
    return (await data.query(query())).rows.map((row) => row.id);
  });
  await started.promise;
  await assert.rejects(
    runtime.withContext(request, ['south'], ({ data }) => data.count('restricted')),
    privateFailure,
  );
  release.release();
  assert.deepEqual([...(await north)], [1, 5]);
});

/* A role set's grant is resolved once per runtime and kept (tenantReadRuntime.ts
   readGrant): the person, their tenant and their rows are never part of what is
   kept, so the same roles hand each person their own scope, and other roles are
   never handed the kept one. */
test('a kept role-set grant never carries one person or tenant into another', async (t) => {
  const f = await fixture(t);
  const membership = { status: 'active' as const, validUntil: 10_000, expectedVersion: null };
  await f.transaction(async (admin) => {
    await admin.putMembership({ ...membership, tenantId: 'north', accountId: 'bob', membershipId: 'north-bob', roles: ['reviewer'] });
    await admin.putMembership({
      ...membership,
      tenantId: 'north',
      accountId: 'carol',
      membershipId: 'north-carol',
      roles: ['administrator'],
    });
  });
  // Bob's own rule narrows the items he reads; Alice and Carol read every row of their tenant.
  const bobs: RowScope = { item: { groups: [[{ column: 'name', op: '=', value: 'Five' }]] }, restricted: true, country: true };
  const runtime = f.issue({
    verifySession: (input) => ({ id: input.cookie, who: input.cookie }),
    resolveRows: (principal) => (principal.accountId === 'bob' ? bobs : f.rows),
  });
  const read = async (cookie: string, tenant: string) =>
    plain(
      await runtime.withContext({ cookie }, [tenant], async ({ data, schema, principal }) => ({
        roles: [...principal.roles],
        ids: (await data.query(query())).rows.map((row) => row.id),
        tables: schema.tables.map((table) => table.id).sort(),
      })),
    );
  const before = tenantReadCounters.grants;
  assert.deepEqual(await read('alice', 'north'), { roles: ['reviewer'], ids: [1, 5], tables: ['country', 'item'] });
  assert.deepEqual(await read('bob', 'north'), { roles: ['reviewer'], ids: [5], tables: ['country', 'item'] });
  // Alice again, after Bob: her rows, not his narrower ones the same grant was last handed with.
  assert.deepEqual(await read('alice', 'north'), { roles: ['reviewer'], ids: [1, 5], tables: ['country', 'item'] });
  assert.deepEqual(await read('alice', 'south'), { roles: ['reviewer'], ids: [2], tables: ['country', 'item'] });
  assert.equal(tenantReadCounters.grants - before, 1, 'one role set, resolved once for three people and two tenants');
  // Other roles resolve their own grant: the administrator reads the resource the reviewer may not.
  const carol = await read('carol', 'north');
  assert.deepEqual(carol.roles, ['administrator']);
  assert.deepEqual(carol.tables, ['country', 'item', 'restricted']);
  assert.equal(tenantReadCounters.grants - before, 2);
  assert.deepEqual(await read('bob', 'north'), { roles: ['reviewer'], ids: [5], tables: ['country', 'item'] });
  assert.equal(tenantReadCounters.grants - before, 2);
});

for (const selectors of [[], ['north', 'north'], ['north', 'south'], ['North'], ['north '], ['missing']]) {
  test(`tenant selectors refuse ${JSON.stringify(selectors)} before callback`, async (t) => {
    const f = await fixture(t);
    let called = false;
    await assert.rejects(
      f.issue().withContext(request, selectors, () => {
        called = true;
      }),
      privateFailure,
    );
    assert.equal(called, false);
  });
}

test('selectors and configuration callbacks are captured before verification waits', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  const roles = ['reviewer', 'administrator'];
  const options: { -readonly [K in keyof Options]: Options[K] } = {
    ...f.options,
    roles,
    verifySession: async () => {
      entered.release();
      await release.promise;
      return { id: 'alice', who: 'Alice', role: 'administrator' };
    },
  };
  const runtime = createTenantReadRuntime(options);
  t.after(() => runtime.retire());
  const selectors = ['north'];
  const result = runtime.withContext(request, selectors, async ({ data }) => (await data.query(query())).rows.map((row) => row.id));
  await entered.promise;
  selectors[0] = 'south';
  roles.splice(0);
  options.verifySession = () => null;
  options.resolveRows = () => ({});
  f.app.auth!.roles!.reviewer.read = false;
  release.release();
  assert.deepEqual([...(await result)], [1, 5]);
});

for (const [label, mutate] of [
  [
    'app id',
    (app: AppDef) => {
      app.id = 'another-app';
    },
  ],
  [
    'default source',
    (app: AppDef) => {
      app.sources!.business.default = false;
    },
  ],
  [
    'source connection',
    (app: AppDef) => {
      app.sources!.business.connection = 'other';
    },
  ],
  [
    'canonical connection',
    (app: AppDef) => {
      app.connection = 'other';
    },
  ],
  [
    'second source',
    (app: AppDef) => {
      app.sources!.other = { connection: 'other', default: false };
    },
  ],
  [
    'resource mapping',
    (app: AppDef) => {
      app.resources = { ...app.resources, item: { ...app.resources?.item, source: 'business', physical: 'physical_restricted' } };
    },
  ],
] as const) {
  test(`bad ${label} refuses factory without taking source ownership`, async (t) => {
    const f = await fixture(t),
      app = structuredClone(f.app);
    mutate(app);
    assert.throws(() => createTenantReadRuntime({ ...f.options, app }), privateFailure);
    assert.equal(await f.issue().withContext(request, ['north'], ({ data }) => data.count('item')), 2);
  });
}

test('a structurally identical but unbranded source cannot enter a runtime', async (t) => {
  const f = await fixture(t);
  assert.throws(() => createTenantReadRuntime({ ...f.options, source: { ...f.source } }), privateFailure);
  assert.equal(await f.issue().withContext(request, ['north'], ({ data }) => data.count('item')), 2);
});

for (const [label, invalidate] of [
  [
    'revocation',
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.revoke();
    },
  ],
  [
    'expiry',
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.setTime(6000);
    },
  ],
  [
    'account change',
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.setIdentity({ id: 'bob', who: 'Bob', role: 'administrator' });
    },
  ],
  [
    'logout',
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.setIdentity(null);
    },
  ],
  [
    'schema change',
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.writer.exec('ALTER TABLE physical_item ADD COLUMN extra TEXT');
    },
  ],
  [
    'membership roles change',
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.writer
        .prepare(`UPDATE "${TENANT_TABLES.membership}" SET roles_json = ?, version = '2' WHERE id = 'north-alice'`)
        .run('["administrator"]');
    },
  ],
] as const) {
  test(`${label} prevents buffered rows returning after a callback wait`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      release = gate();
    const pending = f.issue().withContext(request, ['north'], async ({ data }) => {
      const result = await data.query(query());
      entered.release();
      await release.promise;
      return result;
    });
    const rejected = assert.rejects(pending, privateFailure);
    await entered.promise;
    await invalidate(f);
    release.release();
    await rejected;
  });
}

test('a clock rollback within an otherwise unexpired invocation refuses buffered release', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.issue().withContext(request, ['north'], async ({ data }) => {
      f.setTime(2000);
      await data.count('item');
      f.setTime(1500);
      return 'no release';
    }),
    privateFailure,
  );
});

test('read arguments detach before a paused verifier and cannot be broadened by mutation', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  let paused = false;
  const runtime = f.issue({
    verifySession: async (input) => {
      if (paused) {
        entered.release();
        await release.promise;
      }
      return f.options.verifySession(input);
    },
  });
  await runtime.withContext(request, ['north'], async ({ data }) => {
    const filter = equal('id', 1),
      input = query({ filter, columns: ['id'] });
    paused = true;
    const reading = data.query(input);
    await entered.promise;
    input.table = 'restricted';
    input.columns!.push('secret');
    filter.groups[0][0].value = 5;
    release.release();
    assert.deepEqual(plain((await reading).rows), [{ id: 1 }]);
  });
});

for (const kind of ['count', 'runView', 'countView', 'runBreakdown', 'countBreakdown'] as const) {
  test(`${kind} snapshots its filter and definition before verifier waits`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      release = gate();
    let paused = false;
    const runtime = f.issue({
      verifySession: async (input) => {
        if (paused) {
          entered.release();
          await release.promise;
        }
        return f.options.verifySession(input);
      },
    });
    await runtime.withContext(request, ['north'], async ({ data }) => {
      const filter = equal('id', 1);
      const pathFilter = { groups: [[{ path: 'id', op: '=' as const, value: 1 }]] };
      const definition: ViewDef = { ...view(), filter: pathFilter };
      const grouped: BreakdownDef = { ...breakdown(), filter: pathFilter };
      paused = true;
      const pending =
        kind === 'count'
          ? data.count('item', filter)
          : kind === 'runView'
            ? data.runView(definition)
            : kind === 'countView'
              ? data.countView(definition)
              : kind === 'runBreakdown'
                ? data.runBreakdown(grouped)
                : data.countBreakdown(grouped);
      await entered.promise;
      filter.groups[0][0].value = 5;
      pathFilter.groups[0][0].value = 5;
      definition.base = grouped.base = 'restricted';
      release.release();
      const result = await pending;
      if (typeof result === 'number') assert.equal(result, 1);
      else {
        assert.equal(result.rows.length, 1);
        assert.ok(JSON.stringify(result.rows).includes('One'));
        assert.equal(JSON.stringify(result.rows).includes('Five'), false);
      }
    });
  });
}

for (const phase of ['before SQL', 'after SQL'] as const) {
  test(`account changes ${phase} prevent the read promise itself releasing rows`, async (t) => {
    const f = await fixture(t);
    let armed = false,
      checks = 0;
    const runtime = f.issue({
      verifySession: (input) => {
        if (armed && ++checks === (phase === 'before SQL' ? 1 : 2)) f.setIdentity({ id: 'bob', who: 'Bob' });
        return f.options.verifySession(input);
      },
    });
    await poisoned(runtime, (data) => {
      armed = true;
      return data.query(query());
    });
  });
}

test('provider accessors and proxies are refused without running their traps', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  let accesses = 0;
  const accessor = query();
  Object.defineProperty(accessor, 'limit', {
    enumerable: true,
    get: () => {
      accesses++;
      return 20;
    },
  });
  const proxy = new Proxy(query(), {
    ownKeys: (target) => {
      accesses++;
      return Reflect.ownKeys(target);
    },
  });
  for (const input of [accessor, proxy]) {
    await poisoned(runtime, (data) => data.query(input));
  }
  assert.equal(accesses, 0);
});

for (const [label, input] of [
  ['NaN', () => query({ limit: NaN })],
  [
    'sparse filter',
    () => {
      const groups: Filter['groups'] = [];
      groups.length = 2;
      return query({ filter: { groups } });
    },
  ],
  ['oversized input', () => query({ columns: Array.from({ length: 65_537 }, () => 'id') })],
] as const) {
  test(`caught malformed ${label} read poisons the whole invocation`, async (t) => {
    const f = await fixture(t);
    await poisoned(f.issue(), (data) => data.query(input()));
  });
}

for (const method of ['query', 'count', 'runView', 'countView', 'runBreakdown', 'countBreakdown'] as const) {
  test(`${method} refuses a malformed string groups filter rather than dropping the caller predicate`, async (t) => {
    const f = await fixture(t);
    await poisoned(f.issue(), (data) => {
      // Deliberately enter below the TS boundary without falsely typing this
      // malformed provider/request data as a valid structured filter.
      const filter = { groups: '' };
      const args =
        method === 'query'
          ? [{ ...query(), filter }]
          : method === 'count'
            ? ['item', filter]
            : method === 'runView' || method === 'countView'
              ? [{ ...view(), filter }]
              : [{ ...breakdown(), filter }];
      return Reflect.apply(data[method], data, args);
    });
  });
}

test('unawaited failed reads are drained and poison callback success without unhandled rejection', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.issue().withContext(request, ['north'], ({ data }) => {
      void data.query(query({ table: 'restricted' }));
      return 'not a success';
    }),
    privateFailure,
  );
});

test('callback completion closes admission but drains accepted unawaited work before release', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  let paused = false,
    data!: ScopedReads,
    completed = false;
  const runtime = f.issue({
    verifySession: async (input) => {
      if (paused) {
        entered.release();
        await release.promise;
      }
      return f.options.verifySession(input);
    },
  });
  const pending = runtime.withContext(request, ['north'], (context) => {
    data = context.data;
    paused = true;
    void data.count('item');
    return 'buffered';
  });
  void pending.then(() => {
    completed = true;
  });
  await entered.promise;
  assert.equal(completed, false);
  await assert.rejects(data.count('item'), privateFailure);
  release.release();
  assert.equal(await pending, 'buffered');
});

test('a callback failure still drains an accepted paused sibling', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  let paused = false,
    completed = false;
  const runtime = f.issue({
    verifySession: async (input) => {
      if (paused) {
        entered.release();
        await release.promise;
      }
      return f.options.verifySession(input);
    },
  });
  const pending = runtime.withContext(request, ['north'], ({ data }) => {
    paused = true;
    void data.count('item');
    throw new Error('private provider detail');
  });
  const rejected = assert.rejects(pending, privateFailure).then(() => {
    completed = true;
  });
  await entered.promise;
  assert.equal(completed, false);
  release.release();
  await rejected;
});

test('retirement stops admission synchronously and drains authentication before closing the genuine source', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate();
  const runtime = f.issue({
    verifySession: async (input) => {
      entered.release();
      await release.promise;
      return f.options.verifySession(input);
    },
  });
  let callback = false,
    closed = false;
  const pending = runtime.withContext(request, ['north'], () => {
    callback = true;
  });
  const rejected = assert.rejects(pending, privateFailure);
  await entered.promise;
  const retirement = runtime.retire();
  assert.equal(runtime.retire(), retirement);
  void retirement.then(() => {
    closed = true;
  });
  await assert.rejects(
    runtime.withContext(request, ['north'], () => {}),
    privateFailure,
  );
  assert.equal(closed, false);
  release.release();
  await rejected;
  await retirement;
  assert.equal(callback, false);
  assert.equal(closed, true);
});

for (const resolver of ['resolveMembershipRows', 'resolveRows'] as const) {
  test(`retirement drains a pending ${resolver} before completing`, async (t) => {
    const f = await fixture(t),
      entered = gate(),
      release = gate();
    const runtime = f.issue({
      [resolver]: async () => {
        entered.release();
        await release.promise;
        return f.rows;
      },
    });
    let called = false,
      completed = false;
    const pending = runtime.withContext(request, ['north'], () => {
      called = true;
    });
    const rejected = assert.rejects(pending, privateFailure);
    await entered.promise;
    const retirement = runtime.retire();
    void retirement.then(() => {
      completed = true;
    });
    await assert.rejects(
      runtime.withContext(request, ['south'], () => {}),
      privateFailure,
    );
    assert.equal(completed, false);
    release.release();
    await rejected;
    await retirement;
    assert.equal(called, false);
  });
}

for (const phase of ['verify', 'membership rows', 'authored rows', 'clock'] as const) {
  test(`reentrant retirement from ${phase} drains its accepted request without releasing data`, async (t) => {
    const f = await fixture(t);
    let runtime!: Runtime,
      retirement: Promise<void> | undefined,
      called = false;
    const retire = () => {
      retirement ??= runtime.retire();
    };
    runtime = f.issue({
      verifySession: (input) => {
        if (phase === 'verify') retire();
        return f.options.verifySession(input);
      },
      resolveMembershipRows: () => {
        if (phase === 'membership rows') retire();
        return f.rows;
      },
      resolveRows: () => {
        if (phase === 'authored rows') retire();
        return f.rows;
      },
      now: () => {
        if (phase === 'clock') retire();
        return 1000;
      },
    });
    await assert.rejects(
      runtime.withContext(request, ['north'], () => {
        called = true;
      }),
      privateFailure,
    );
    assert.ok(retirement);
    await retirement;
    assert.equal(called, false);
  });
}

test('retirement drains a paused callback and refuses its already buffered rows', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate(),
    runtime = f.issue();
  let closed = false,
    retained!: TenantReadContext;
  const pending = runtime.withContext(request, ['north'], async (context) => {
    retained = context;
    const result = await context.data.query(query());
    entered.release();
    await release.promise;
    return result;
  });
  const rejected = assert.rejects(pending, privateFailure);
  await entered.promise;
  const retirement = runtime.retire();
  void retirement.then(() => {
    closed = true;
  });
  await assert.rejects(retained.data.count('item'), privateFailure);
  assert.equal(closed, false);
  release.release();
  await rejected;
  await retirement;
});

test('callback results are detached bounded data, never retained capabilities or provider objects', async (t) => {
  const f = await fixture(t),
    runtime = f.issue();
  const result = { nested: { ok: true } };
  const pending = runtime.withContext(request, ['north'], () => {
    queueMicrotask(() => {
      result.nested.ok = false;
    });
    return result;
  });
  assert.deepEqual(plain(await pending), { nested: { ok: true } });
  await assert.rejects(
    runtime.withContext(request, ['north'], (context) => context.data),
    privateFailure,
  );
  await assert.rejects(
    runtime.withContext(request, ['north'], () => new Error('private data')),
    privateFailure,
  );
  await assert.rejects(
    runtime.withContext(request, ['north'], () => ({ invalid: Infinity })),
    privateFailure,
  );
});
