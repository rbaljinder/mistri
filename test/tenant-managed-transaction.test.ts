import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  Refusal,
  TransactionOutcomeUnknown,
  type DeleteRequest,
  type InsertRequest,
  type QueryRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  runTenantManagedCommandTransaction,
  runTenantManagedTransaction,
} from '../packages/mistri/src/server/tenant/tenantManagedTransaction.js';
import type { CommandAudit, CommandJournal, StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { composeTenantReadScope } from '../packages/mistri/src/server/tenant/tenantReadScope.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';

const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'TEXT',
  nullable: false,
  primaryKey: false,
  ...extra,
});
function ownership() {
  const physicalSchema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'Private',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'db_item',
        name: 'db_item',
        schema: 'main',
        isView: false,
        columns: [
          column('tenant_id', { primaryKey: true }),
          column('id', { primaryKey: true }),
          column('title'),
          column('amount', { type: 'INTEGER' }),
          column('enabled', { type: 'BOOLEAN' }),
          column('optional', { nullable: true }),
        ],
      },
      {
        id: 'db_simple',
        name: 'db_simple',
        schema: 'main',
        isView: false,
        columns: [column('id', { primaryKey: true }), column('tenant_id'), column('title')],
      },
      {
        id: 'db_country',
        name: 'db_country',
        schema: 'main',
        isView: false,
        columns: [column('code', { primaryKey: true }), column('name')],
      },
    ],
  };
  const resources = { item: 'db_item', simple: 'db_simple', country: 'db_country' };
  const schema = mapScopeCatalog(physicalSchema, new Map(Object.entries(resources).map(([id, physical]) => [physical, id])));
  return captureTenantOwnership({
    appId: 'app',
    source: { id: 'business', connection: 'owned-source' },
    physicalSchema,
    schema,
    resources,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      simple: { kind: 'tenant', column: 'tenant_id' },
      country: { kind: 'global', access: 'read-only' },
    },
  });
}
const evidence = (): TenantMembershipEvidence => ({
  appId: 'app',
  source: { id: 'business', connection: 'owned-source' },
  accountId: 'alice',
  tenantId: 'north',
  deployment: 'generation-1',
  membershipId: 'grant-1',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['reviewer'],
  verifiedAt: 100,
  validUntil: 5000,
});
const insert = (): InsertRequest => ({ table: 'item', values: { id: 'one', title: 'Original', amount: 1, enabled: true, optional: null } });
const update = (): UpdateRequest => ({ table: 'item', key: { id: 'one' }, values: { title: 'Updated' }, expected: { title: 'Original' } });
const remove = (): DeleteRequest => ({ table: 'item', key: { id: 'one' } });
const query = (): QueryRequest => ({ table: 'item', columns: ['id'], limit: 20, offset: 0 });
const secret = 'PRIVATE_MANAGED_TRANSACTION_SENTINEL';
const receipt: StoredCommandReceipt = {
  id: 'receipt',
  appId: 'app',
  actorId: 'alice',
  commandId: 'change',
  commandVersion: 1,
  idempotencyKey: 'attempt',
  fingerprint: 'digest',
  resultJson: '{}',
  requestId: 'request',
  completedAt: '2026-09-08T00:00:00.000Z',
};
const audit = { target: 'item', keyJson: '{"id":"one"}', changesJson: '[]' };
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function fake() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const sql = { text: `SELECT ${secret}`, params: [secret] };
  const records: WriteTransaction = {
    async query(input) {
      calls.push({ method: 'query', input });
      return { columns: ['id'], rows: [{ id: 'one' }], ms: 1, sql };
    },
    async count(table, filter) {
      calls.push({ method: 'count', input: { table, filter } });
      return 1;
    },
    async insert(input) {
      calls.push({ method: 'insert', input });
      return { key: { id: 'one', tenant_id: 'north' }, applied: input.values, sql };
    },
    async update(input) {
      calls.push({ method: 'update', input });
      return { affected: 1, applied: input.values, sql };
    },
    async remove(input) {
      calls.push({ method: 'remove', input });
      return { affected: 1, sql };
    },
  };
  const run = <T>(work: (tx: WriteTransaction) => T | Promise<T>) => runTenantManagedTransaction(ownership(), evidence(), records, work);
  return { records, calls, sql, run };
}

test('managed records and journal share one captured operation sequence and closed lifetime', async () => {
  const f = fake(),
    calls: string[] = [];
  let retained!: CommandJournal;
  const journal: CommandJournal = {
    async find(input) {
      calls.push(input.idempotencyKey);
      return undefined;
    },
    async commit(input, change) {
      calls.push(input.resultJson, (change as CommandAudit).changesJson);
    },
  };
  const input = { ...receipt },
    change = { ...audit };
  await runTenantManagedCommandTransaction(ownership(), evidence(), f.records, journal, async (records, owned) => {
    retained = owned;
    assert.deepEqual(Object.keys(owned).sort(), ['commit', 'find']);
    assert.ok(Object.isFrozen(owned));
    const pending = owned.commit(input, change);
    input.resultJson = '{"forged":true}';
    change.changesJson = '["forged"]';
    await pending;
    await records.update(update());
    await owned.find(receipt);
  });
  assert.deepEqual(calls, ['{}', '[]', 'attempt']);
  assert.equal(f.calls.length, 1);
  await assert.rejects(retained.find(receipt), TenantContextError);
  await assert.rejects(retained.commit(receipt, audit), TenantContextError);
  assert.equal(calls.length, 3);
});

for (const method of ['find', 'commit'] as const) {
  test(`caught malformed managed journal ${method} poisons records and never evaluates input hooks`, async () => {
    const f = fake();
    let traps = 0,
      journalCalls = 0;
    const journal: CommandJournal = {
      async find() {
        journalCalls++;
        return undefined;
      },
      async commit() {
        journalCalls++;
      },
    };
    const input = {
      ...receipt,
      get fingerprint() {
        traps++;
        return 'forged';
      },
    };
    await assert.rejects(
      runTenantManagedCommandTransaction(ownership(), evidence(), f.records, journal, async (records, owned) => {
        await records.update(update());
        await (method === 'find' ? owned.find(input) : owned.commit(input, audit)).catch(() => {});
        await records.count('item').catch(() => {});
      }),
      TenantContextError,
    );
    assert.equal(traps, 0);
    assert.equal(journalCalls, 0);
    assert.equal(f.calls.length, 1);
  });

  test(`managed journal ${method} descriptor is captured without evaluating getters`, async () => {
    const f = fake();
    let traps = 0;
    const journal: CommandJournal = {
      async find() {
        return undefined;
      },
      async commit() {},
    };
    Object.defineProperty(journal, method, {
      get() {
        traps++;
        return () => {};
      },
    });
    await assert.rejects(
      runTenantManagedCommandTransaction(ownership(), evidence(), f.records, journal, () => {}),
      TenantContextError,
    );
    assert.equal(traps, 0);
    assert.equal(f.calls.length, 0);
  });
}

test('unawaited managed journal failure drains and preserves native uncertainty over callback failure', async () => {
  const f = fake(),
    unknown = new TransactionOutcomeUnknown(new Error('private'));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal: CommandJournal = {
    async find() {
      entered();
      await held;
      throw unknown;
    },
    async commit() {},
  };
  const pending = runTenantManagedCommandTransaction(ownership(), evidence(), f.records, journal, async (_records, owned) => {
    void owned.find(receipt);
    await started;
    throw new Error('callback failed');
  });
  const rejected = assert.rejects(pending, (error) => error === unknown);
  await started;
  release();
  await rejected;
});

test('managed facade exposes exactly five methods, injects owner values/keys, and keeps query diagnostics private', async () => {
  const f = fake();
  Object.defineProperty(f.records, 'lockRecord', {
    get() {
      assert.fail('must not inspect lock authority');
    },
  });
  const result = await f.run(async (tx) => {
    assert.deepEqual(Object.keys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
    assert.equal(Object.isFrozen(tx), true);
    assert.equal('lockRecord' in tx || 'transaction' in tx || 'commit' in tx || 'runSql' in tx, false);
    await tx.insert(insert());
    await tx.update(update());
    await tx.remove(remove());
    await tx.count('country');
    return tx.query(query());
  });
  assert.deepEqual(structuredClone(result.sql), { text: '', params: [] });
  assert.equal(f.sql.text, `SELECT ${secret}`);
  assert.deepEqual(structuredClone(f.calls[0].input), { ...insert(), values: { ...insert().values, tenant_id: 'north' } });
  assert.deepEqual(structuredClone(f.calls[1].input), { ...update(), key: { id: 'one', tenant_id: 'north' } });
  assert.deepEqual(structuredClone(f.calls[2].input), { ...remove(), key: { id: 'one', tenant_id: 'north' } });
});

for (const value of ['north', 'North', 'south', '', null, undefined]) {
  for (const method of ['insert', 'update'] as const)
    test(`${method} rejects caller ownership value ${String(value)} even when caught`, async () => {
      const f = fake();
      await assert.rejects(
        f.run(async (tx) => {
          const request = method === 'insert' ? insert() : update();
          Reflect.set(request.values, 'tenant_id', value);
          await assert.rejects(method === 'insert' ? tx.insert(request) : tx.update(request as UpdateRequest), TenantContextError);
          await assert.rejects(tx.count('item'), TenantContextError);
          return 'cannot succeed';
        }),
        TenantContextError,
      );
      assert.equal(f.calls.length, 0);
    });
}

for (const value of ['North', 'north ', 'south', 1, true, null])
  test(`foreign or nonexact owner key ${JSON.stringify(value)} cannot reach records`, async () => {
    for (const method of ['update', 'remove'] as const) {
      const f = fake();
      await assert.rejects(
        f.run(async (tx) => {
          const request = { ...update(), key: { id: 'one', tenant_id: value } };
          await (method === 'update'
            ? tx.update(request as UpdateRequest)
            : tx.remove({ table: request.table, key: request.key } as DeleteRequest));
        }),
        TenantContextError,
      );
      assert.equal(f.calls.length, 0);
    }
  });

test('matching owner key is accepted only as data; non-PK owner keys remain for complete-key refusal', async () => {
  const f = fake();
  await f.run(async (tx) => {
    await tx.remove({ table: 'item', key: { id: 'one', tenant_id: 'north' } });
    await tx.remove({ table: 'simple', key: { id: 'one', tenant_id: 'north' } });
    await tx.remove({ table: 'simple', key: { id: 'one' } });
  });
  assert.deepEqual(structuredClone(f.calls.map((call) => call.input)), [
    { table: 'item', key: { id: 'one', tenant_id: 'north' } },
    { table: 'simple', key: { id: 'one', tenant_id: 'north' } },
    { table: 'simple', key: { id: 'one' } },
  ]);
});

test('expected map preserves exact owner and all other originals without weakening the engine guard', async () => {
  const f = fake();
  await f.run(async (tx) => {
    await tx.update({ ...update(), expected: { title: 'Original', tenant_id: 'north' } });
  });
  assert.deepEqual(structuredClone((f.calls[0].input as UpdateRequest).expected), { title: 'Original', tenant_id: 'north' });
  for (const value of ['North', 'south', null])
    await assert.rejects(
      f.run(async (tx) => {
        await tx.update({ ...update(), expected: { title: 'Original', tenant_id: value } });
      }),
      TenantContextError,
    );
  assert.equal(f.calls.length, 1);
});

for (const method of ['insert', 'update', 'remove'] as const)
  test(`global resources cannot ${method}`, async () => {
    const f = fake();
    await assert.rejects(
      f.run(async (tx) => {
        if (method === 'insert') await tx.insert({ table: 'country', values: { code: 'us', name: 'USA' } });
        if (method === 'update') await tx.update({ table: 'country', key: { code: 'us' }, values: { name: 'Other' } });
        if (method === 'remove') await tx.remove({ table: 'country', key: { code: 'us' } });
      }),
      TenantContextError,
    );
    assert.equal(f.calls.length, 0);
  });

for (const table of ['db_item', 'business.item', 'owned-source.item', '__mistri_tenant_membership', 'unknown', '__proto__']) {
  test(`unknown/private/physical resource ${table} refuses for every method`, async () => {
    for (const method of ['query', 'count', 'insert', 'update', 'remove'] as const) {
      const f = fake();
      await assert.rejects(
        f.run(async (tx) => {
          if (method === 'query') await tx.query({ ...query(), table });
          if (method === 'count') await tx.count(table);
          if (method === 'insert') await tx.insert({ ...insert(), table });
          if (method === 'update') await tx.update({ ...update(), table });
          if (method === 'remove') await tx.remove({ ...remove(), table });
        }),
        TenantContextError,
      );
      assert.equal(f.calls.length, 0);
    }
  });
}

for (const filter of [
  false,
  '',
  [],
  {},
  { groups: null },
  { groups: [null] },
  { groups: [[{ column: 'title', op: 1, value: 'x' }]] },
  { groups: [[{ column: 'title', op: 'secret', value: 'x' }]] },
  { groups: [[{ column: 'title', op: '=', value: {} }]] },
  { groups: [[{ column: 'title', op: 'in', value: 'x' }]] },
  { groups: [[{ column: 'unknown', op: '=', value: 'x' }]] },
  { groups: [], sql: secret },
]) {
  test(`query and count refuse malformed filters ${JSON.stringify(filter)}`, async () => {
    for (const method of ['query', 'count']) {
      const f = fake();
      await assert.rejects(
        f.run(async (tx) => {
          await assert.rejects(
            method === 'query' ? tx.query({ ...query(), filter } as QueryRequest) : tx.count('item', filter as QueryRequest['filter']),
          );
        }),
      );
      assert.equal(f.calls.length, 0);
    }
  });
}

test('empty/shared valid filters retain their meaning; malformed query fields cannot reach records', async () => {
  const f = fake();
  await f.run(async (tx) => {
    await tx.count('item', { groups: [] });
    await tx.query({ ...query(), filter: { groups: [[{ column: 'title', op: 'in', value: ['a', 'b'] }], []] } });
  });
  for (const patch of [
    { columns: [1] },
    { columns: ['missing'] },
    { orderBy: {} },
    { orderBy: [{ column: 'title', direction: 'sideways' }] },
    { orderBy: [{ column: 'title', direction: 'asc', sql: secret }] },
    { limit: '20' },
    { offset: null },
    { limit: NaN },
    { offset: Infinity },
    { rawSql: secret },
  ]) {
    await assert.rejects(f.run((tx) => tx.query({ ...query(), ...patch } as QueryRequest)));
  }
  assert.equal(f.calls.length, 2);
});

for (const value of [undefined, {}, [], new Date(0), 1n, NaN, Infinity, () => {}]) {
  test(`write scalar maps refuse ${String(value)} without executing records`, async () => {
    const f = fake();
    for (const method of ['insert', 'update'])
      await assert.rejects(
        f.run(async (tx) => {
          const request = method === 'insert' ? insert() : update();
          Reflect.set(request.values, 'title', value);
          await (method === 'insert' ? tx.insert(request) : tx.update(request as UpdateRequest));
        }),
        TenantContextError,
      );
    assert.equal(f.calls.length, 0);
  });
}

for (const method of ['insert', 'update', 'remove'] as const)
  test(`${method} rejects unknown request and map fields`, async () => {
    for (const field of ['request', 'map']) {
      const f = fake();
      await assert.rejects(
        f.run(async (tx) => {
          const request = method === 'insert' ? insert() : method === 'update' ? update() : remove();
          if (field === 'request') Reflect.set(request, 'returning', secret);
          else Reflect.set('values' in request ? request.values : request.key, 'unknown', secret);
          await (method === 'insert'
            ? tx.insert(request as InsertRequest)
            : method === 'update'
              ? tx.update(request as UpdateRequest)
              : tx.remove(request as DeleteRequest));
        }),
        TenantContextError,
      );
      assert.equal(f.calls.length, 0);
    }
  });

for (const method of ['query', 'count', 'insert', 'update', 'remove'] as const) {
  for (const kind of ['proxy', 'getter'] as const)
    test(`${method} ${kind} input cannot execute traps and poisons the caught failure`, async () => {
      const f = fake();
      let executions = 0;
      const fail = (): never => {
        executions++;
        throw new Error(secret);
      };
      await assert.rejects(
        f.run(async (tx) => {
          const original =
            method === 'query'
              ? query()
              : method === 'count'
                ? { groups: [] }
                : method === 'insert'
                  ? insert()
                  : method === 'update'
                    ? update()
                    : remove();
          const value =
            kind === 'proxy'
              ? new Proxy(original, { get: fail, ownKeys: fail, getPrototypeOf: fail, getOwnPropertyDescriptor: fail })
              : Object.defineProperty(original, Object.keys(original)[0], { enumerable: true, get: fail });
          await assert.rejects(
            method === 'query'
              ? tx.query(value as QueryRequest)
              : method === 'count'
                ? tx.count('item', value as QueryRequest['filter'])
                : method === 'insert'
                  ? tx.insert(value as InsertRequest)
                  : method === 'update'
                    ? tx.update(value as UpdateRequest)
                    : tx.remove(value as DeleteRequest),
            TenantContextError,
          );
          await assert.rejects(tx.insert(insert()), TenantContextError);
        }),
        TenantContextError,
      );
      assert.equal(executions, 0);
      assert.equal(f.calls.length, 0);
    });
}

test('ownership/evidence capture refuses mismatched sources, canonical aliases, getters and proxies before callback', async () => {
  const f = fake();
  let calls = 0;
  for (const patch of [
    { appId: 'other' },
    { source: { id: 'business', connection: 'other' } },
    { source: { id: 'other', connection: 'owned-source' } },
    { tenantId: 'North' },
    { tenantId: 'north ' },
  ]) {
    await assert.rejects(
      runTenantManagedTransaction(ownership(), { ...evidence(), ...patch }, f.records, () => {
        calls++;
      }),
      TenantContextError,
    );
  }
  const fail = (): never => {
    calls++;
    throw new Error(secret);
  };
  await assert.rejects(
    runTenantManagedTransaction(new Proxy(ownership(), { get: fail, ownKeys: fail, getPrototypeOf: fail }), evidence(), f.records, fail),
    TenantContextError,
  );
  await assert.rejects(
    runTenantManagedTransaction(
      ownership(),
      Object.defineProperty(evidence(), 'tenantId', { get: fail, enumerable: true }),
      f.records,
      fail,
    ),
    TenantContextError,
  );
  assert.equal(calls, 0);
});

test('captured records methods preserve their receiver and cannot be swapped during the callback', async () => {
  const f = fake(),
    captured = f.records.count;
  f.records.count = async function (...args) {
    assert.equal(this, f.records);
    return Reflect.apply(captured, this, args);
  };
  await f.run(async (tx) => {
    f.records.count = () => assert.fail('replacement must not run');
    await tx.count('item');
  });
  assert.equal(f.calls.length, 1);
  let getters = 0;
  Object.defineProperty(f.records, 'query', {
    get() {
      getters++;
      return captured;
    },
  });
  await assert.rejects(
    f.run(() => assert.fail('invalid method facade')),
    TenantContextError,
  );
  assert.equal(getters, 0);
});

test('input values, keys, filters, ownership and evidence detach before queue waits', async () => {
  const f = fake(),
    pause = gate(),
    entered = gate();
  f.records.count = async () => {
    entered.release();
    await pause.wait;
    return 1;
  };
  const owned = structuredClone(ownership()),
    member = evidence();
  const pending = runTenantManagedTransaction(owned, member, f.records, async (tx) => {
    const first = tx.count('item');
    const request = insert(),
      edit = update(),
      selection = query();
    const next = [tx.insert(request), tx.update(edit), tx.query(selection)];
    request.values.title = 'mutated';
    edit.key.id = 'mutated';
    edit.values.title = 'mutated';
    selection.columns!.push('unknown');
    Reflect.set(owned.resources, 'item', 'another');
    Reflect.set(member, 'tenantId', 'south');
    await first;
    await Promise.all(next);
  });
  await entered.wait;
  pause.release();
  await pending;
  assert.equal((f.calls[0].input as InsertRequest).values.title, 'Original');
  assert.equal((f.calls[0].input as InsertRequest).values.tenant_id, 'north');
  assert.deepEqual(structuredClone((f.calls[1].input as UpdateRequest).key), { id: 'one', tenant_id: 'north' });
  assert.deepEqual((f.calls[2].input as QueryRequest).columns, ['id']);
});

test('unawaited accepted writes drain and callback result is captured before the drain wait', async () => {
  const f = fake(),
    entered = gate(),
    pause = gate();
  const original = f.records.insert;
  f.records.insert = async (request) => {
    entered.release();
    await pause.wait;
    return original(request);
  };
  const output = { nested: { value: 'original' } };
  let finished = false;
  const pending = f
    .run((tx) => {
      void tx.insert(insert());
      return output;
    })
    .then((value) => {
      finished = true;
      return value;
    });
  await entered.wait;
  output.nested.value = 'mutated';
  assert.equal(finished, false);
  pause.release();
  const result = await pending;
  assert.equal(result.nested.value, 'original');
  assert.equal(Object.isFrozen(result.nested), true);
  assert.equal(f.calls.length, 1);
});

test('callback success cannot hide unawaited failure; pending operations do not execute after failure', async () => {
  const f = fake(),
    failure = new Error(secret);
  f.records.insert = async () => {
    throw failure;
  };
  await assert.rejects(
    f.run((tx) => {
      void tx.insert(insert());
      void tx.count('item');
      return 'hidden';
    }),
    (error) => error === failure,
  );
  assert.equal(f.calls.length, 0);
});

test('retained handles and callback-scheduled microtasks cannot submit operations after callback completion', async () => {
  const f = fake();
  let retained!: WriteTransaction, late: Promise<unknown> | undefined;
  await f.run((tx) => {
    retained = tx;
    queueMicrotask(() => {
      late = assert.rejects(tx.insert(insert()), TenantContextError);
    });
    return 'done';
  });
  await late;
  for (const call of [
    () => retained.query(query()),
    () => retained.count('item'),
    () => retained.insert(insert()),
    () => retained.update(update()),
    () => retained.remove(remove()),
  ])
    await assert.rejects(call, TenantContextError);
  assert.equal(f.calls.length, 0);
});

test('callback functions/handles/getters/thenables and over-budget result data cannot escape before commit', async () => {
  const f = fake();
  let executed = 0;
  const thenable = Object.create(null);
  Reflect.set(thenable, 'then', () => {
    executed++;
  });
  for (const output of [
    () => {},
    thenable,
    Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        executed++;
        return secret;
      },
    }),
    { payload: 'x'.repeat(16_777_216) },
  ])
    await assert.rejects(
      f.run(() => output),
      TenantContextError,
    );
  await assert.rejects(
    f.run((tx) => tx),
    TenantContextError,
  );
  assert.equal(executed, 0);
});

test('callback and provider errors propagate unchanged, with unknown outcome overriding ordinary drain refusal', async () => {
  const f = fake(),
    callback = new Error('callback failed'),
    provider = new Refusal('provider failed');
  await assert.rejects(
    f.run(() => {
      throw callback;
    }),
    (error) => error === callback,
  );
  f.records.count = async () => {
    throw provider;
  };
  await assert.rejects(
    f.run(async (tx) => {
      await tx.count('item');
    }),
    (error) => error === provider,
  );
  const unknown = new TransactionOutcomeUnknown(new Error(secret));
  await assert.rejects(
    f.run(async (tx) => {
      await assert.rejects(tx.count('item'));
      throw unknown;
    }),
    (error) => error === unknown,
  );
});

test('in-flight unknown outcome survives an unrelated callback failure and operation drain', async () => {
  const f = fake(),
    entered = gate(),
    pause = gate(),
    callbackEnded = gate();
  const unknown = new TransactionOutcomeUnknown(new Error(secret));
  f.records.insert = async () => {
    entered.release();
    await pause.wait;
    throw unknown;
  };
  const pending = f.run(async (tx) => {
    void tx.insert(insert());
    await entered.wait;
    callbackEnded.release();
    throw new Refusal('callback refused');
  });
  const rejected = assert.rejects(pending, (error) => error === unknown);
  await callbackEnded.wait;
  pause.release();
  await rejected;
});

async function real(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-managed-'));
  const path = join(directory, 'data.db'),
    db = new DatabaseSync(path);
  const adapter = new SqliteAdapter(path);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE item(tenant_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, PRIMARY KEY(tenant_id,id));
    CREATE TABLE simple(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, title TEXT NOT NULL);
    CREATE TABLE country(code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    INSERT INTO item VALUES ('north','same','North original'),('south','same','South original');
    INSERT INTO simple VALUES ('one','north','Simple original');
    INSERT INTO country VALUES ('us','USA'); BEGIN IMMEDIATE`);
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  const owned = captureTenantOwnership({
    ...ownership(),
    schema,
    physicalSchema: schema,
    resources: { item: 'item', simple: 'simple', country: 'country' },
  });
  const member = evidence(),
    all = { item: true, simple: true, country: true };
  const scope = composeTenantReadScope(owned, member, all, all);
  const run = <T>(work: (tx: WriteTransaction) => T | Promise<T>) =>
    adapter.scopeTransaction(scope, (tx) => runTenantManagedTransaction(owned, member, tx, work));
  return { db, run };
}

test('real scoped SQLite injects composite owner keys and isolates equal tenant-local IDs', async (t) => {
  const f = await real(t);
  await f.run(async (tx) => {
    assert.equal(await tx.count('item'), 1);
    await tx.update({ table: 'item', key: { id: 'same' }, values: { title: 'North updated' }, expected: { title: 'North original' } });
    await tx.insert({ table: 'item', values: { id: 'created', title: 'New north' } });
    assert.equal(await tx.count('item'), 2);
    await tx.remove({ table: 'item', key: { id: 'created' } });
  });
  assert.deepEqual(
    f.db
      .prepare('SELECT * FROM item ORDER BY tenant_id')
      .all()
      .map((row) => ({ ...row })),
    [
      { tenant_id: 'north', id: 'same', title: 'North updated' },
      { tenant_id: 'south', id: 'same', title: 'South original' },
    ],
  );
});

test('real engine still refuses protected PK updates, non-PK owner keys, and extra expected fields', async (t) => {
  const f = await real(t);
  const changes: UpdateRequest[] = [
    { table: 'item', key: { id: 'same' }, values: { id: 'changed' } },
    { table: 'simple', key: { id: 'one', tenant_id: 'north' }, values: { title: 'Changed' } },
    { table: 'item', key: { id: 'same' }, values: { title: 'Changed' }, expected: { title: 'North original', tenant_id: 'north' } },
  ];
  for (const change of changes)
    await assert.rejects(
      f.run(async (tx) => {
        await assert.rejects(tx.update(change));
      }),
    );
  assert.equal(f.db.prepare("SELECT title FROM item WHERE tenant_id='north'").get()?.title, 'North original');
});

test('real earlier writes roll back after caught managed refusal or invalid callback result', async (t) => {
  const f = await real(t);
  for (const failure of ['caught owner change', 'returned handle'])
    await assert.rejects(
      f.run(async (tx) => {
        await tx.update({ table: 'item', key: { id: 'same' }, values: { title: 'Must rollback' } });
        if (failure === 'returned handle') return tx;
        await assert.rejects(tx.update({ table: 'item', key: { id: 'same' }, values: { tenant_id: 'north' } }), TenantContextError);
        return { hidden: 'caught refusal' };
      }),
      TenantContextError,
    );
  assert.equal(f.db.prepare("SELECT title FROM item WHERE tenant_id='north'").get()?.title, 'North original');
});
