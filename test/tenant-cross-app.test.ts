import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { startTenantProof, type TenantProofFixture } from '../e2e/support/tenantProofServer.js';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import type { TenantProofKind } from './support/tenantProofModel.js';

type ObjectValue = Record<string, unknown>;
type Reply = { status: number; headers: Headers; body: ObjectValue };
type Context = { appId: string; accountId: string; tenantId: string; tabId: string; context: string; revision: number; expiresAt: number };
type Role = keyof TenantProofFixture['accounts'];
const ownerNames = ['app', 'account', 'tenant', 'tab', 'context', 'lease-revision'];
const assertion = (c: Context) => ({ tabId: c.tabId, expectedContext: c.context, expectedRevision: c.revision });
const filter = (column: string, value: string) => ({ groups: [[{ column, op: '=', value }]] });

function object(value: unknown): ObjectValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function objects(value: unknown): ObjectValue[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}
function noPrivate(reply: Reply) {
  assert.ok(
    !/tenant_id|physical_|__mistri_|approxRows|"(?:sql|params|stack|sessionId|password|token)"/.test(JSON.stringify(reply.body)),
    'response disclosed managed ownership or private implementation data',
  );
}
function unowned(reply: Reply) {
  for (const name of ownerNames) assert.ok(reply.headers.get(`x-mistri-${name}`) === null, `refusal attested ${name}`);
}
function denied(reply: Reply) {
  assert.ok(reply.status >= 400 || (Array.isArray(reply.body.errors) && reply.body.errors.length > 0), 'request must be refused');
  noPrivate(reply);
  unowned(reply);
  for (const key of ['rows', 'result', 'receiptId', 'references', 'plans'])
    assert.equal(key in reply.body, false, `refusal disclosed ${key}`);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
function owned(reply: Reply, c: Context) {
  assert.equal(reply.status, 200);
  assert.ok(reply.body.errors === undefined || (Array.isArray(reply.body.errors) && reply.body.errors.length === 0));
  const values = [c.appId, c.accountId, c.tenantId, c.tabId, c.context, String(c.revision)];
  ownerNames.forEach((name, i) => {
    // Boolean assertions keep opaque context and native session values out of logs.
    assert.ok(reply.headers.get(`x-mistri-${name}`) === values[i], `incorrect ${name} ownership`);
  });
  assert.equal(reply.headers.get('cache-control'), 'no-store');
}
function rows(reply: Reply) {
  assert.equal(reply.status, 200);
  return objects(reply.body.rows);
}

async function fixture(t: TestContext, kind: TenantProofKind) {
  const f = await startTenantProof(kind);
  t.after(() => f.stop());
  return f;
}
async function login(f: TenantProofFixture, role: Role = 'member') {
  const account = f.accounts[role];
  const response = await fetch(`${f.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: f.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, 'native sign-in failed');
  const authenticated = object(await response.json());
  assert.ok(object(authenticated.user).id === account.id, 'native sign-in returned another account');
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie.length > 0, 'native sign-in must issue session cookies');
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const reply = await fetch(f.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: f.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: reply.status, headers: reply.headers, body: object(await reply.json()) };
  };
  const select = (path: string, tenant: string) => `${path}?app=${f.appId}&tenant=${tenant}`;
  const headers = (c: Context) => ({
    'x-mistri-account': c.accountId,
    'x-mistri-tab': c.tabId,
    'x-mistri-context': c.context,
    'x-mistri-lease-revision': String(c.revision),
  });
  const bootstrap = async () => {
    const reply = await call(`/api/tenant/bootstrap?app=${f.appId}`);
    assert.equal(reply.status, 200);
    noPrivate(reply);
    for (const name of ['tenant', 'tab', 'context', 'lease-revision']) assert.ok(reply.headers.get(`x-mistri-${name}`) === null);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    return reply.body;
  };
  const open = async (tenant = 'northstar') => {
    const reply = await call(select('/api/tenant/context/open', tenant), {});
    assert.equal(reply.status, 200, 'context open failed');
    for (const name of ['appId', 'accountId', 'tenantId', 'tabId', 'context']) assert.equal(typeof reply.body[name], 'string');
    const c = reply.body as Context;
    assert.equal(c.appId, f.appId);
    assert.equal(c.accountId, account.id);
    assert.equal(c.tenantId, tenant);
    assert.equal(c.revision, 1);
    assert.ok(c.expiresAt > Date.now());
    owned(reply, c);
    return c;
  };
  const data = async (path: string, c: Context, body?: unknown) => {
    const reply = await call(select(path, c.tenantId), body, headers(c));
    noPrivate(reply);
    if (reply.status < 400 && (reply.body.errors === undefined || (Array.isArray(reply.body.errors) && reply.body.errors.length === 0)))
      owned(reply, c);
    else denied(reply);
    return reply;
  };
  return { call, select, headers, bootstrap, open, data };
}

// Only the child fixture writes stores. These snapshots independently witness
// rejected writes, atomic command effects and durable receipt partitioning.
function evidence(f: TenantProofFixture) {
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const read = (table: string, order = 'id') =>
      db
        .prepare(`SELECT * FROM ${table.startsWith('(') ? `${table} a` : `"${table}"`} ORDER BY "${order}"`)
        .all()
        .map((row) => ({ ...row }));
    return {
      units: read(`physical_${f.model.unit}`),
      work: read(`physical_${f.model.work}`),
      targets: read(`physical_${f.model.target}`),
      events: read(`physical_${f.model.event}`),
      receipts: read(COMMAND_JOURNAL_TABLES.receipt),
      audits: read(sqliteAuditRows, 'receipt_id'),
    };
  } finally {
    db.close();
  }
}
function command(f: TenantProofFixture, target: string = f.rows.north.target, idempotencyKey = 'cross-app-same-actor-attempt-0001') {
  return {
    command: f.model.command,
    commandVersion: 1,
    key: { id: target },
    expectedVersion: 0,
    idempotencyKey,
    input: { body: 'A scoped update.' },
  };
}
function applied(reply: Reply, target: string) {
  assert.equal(reply.body.status, 'applied');
  const result = object(reply.body.result);
  assert.deepEqual(Object.keys(result).sort(), ['eventId', 'message', 'targetId', 'version']);
  assert.equal(result.targetId, target);
  assert.equal(result.version, 1);
  assert.equal(result.message, 'Update recorded.');
  assert.equal(typeof result.eventId, 'string');
  assert.match(result.eventId as string, /^[0-9a-f]{32}$/);
  return result;
}

for (const kind of ['ignition', 'thread'] as const) {
  test(`${kind}: native contexts isolate equal business IDs, joins, counts, aggregates and picker choices`, async (t) => {
    const f = await fixture(t, kind),
      m = f.model,
      member = await login(f),
      manager = await login(f, 'manager');
    assert.deepEqual(await member.bootstrap(), {
      status: 'ready',
      appId: f.appId,
      accountId: f.accounts.member.id,
      memberships: [{ tenantId: 'northstar' }, { tenantId: 'riverview' }],
    });
    const north = await member.open(),
      south = await member.open('riverview'),
      managed = await manager.open();
    assert.ok(north.tabId !== south.tabId && north.context !== south.context, 'independent contexts require distinct owners');
    const relationships = objects((await member.data('/api/schema', north)).body.foreignKeys);
    const reverseView = (base: string, child: string) => {
      const relation = relationships.find((fk) => object(fk.from).table === child && object(fk.to).table === base);
      assert.ok(relation);
      assert.equal(typeof relation.name, 'string');
      return { base, columns: ['id'], aggregates: [{ fn: 'count', via: relation.name, alias: 'relatedCount' }] };
    };
    for (const [c, prefix, expected] of [
      [north, 'Northstar', f.rows.north],
      [south, 'Riverview', f.rows.south],
    ] as const) {
      for (const [table, id, businessId] of [
        [m.unit, expected.unit, 'UNIT-001'],
        [m.work, expected.work, 'WORK-001'],
        [m.target, expected.target, 'TARGET-001'],
      ] as const) {
        const found = rows(await member.data('/api/query', c, { table, filter: filter('business_id', businessId) }));
        assert.equal(found.length, 1);
        assert.equal(found[0].id, id);
        assert.equal(found[0].business_id, businessId);
        assert.ok(String(found[0].name).startsWith(prefix));
        const count = await member.data('/api/count', c, { table, exactCount: false });
        assert.equal(count.body.count, 1);
        assert.equal(count.body.exact, true);
      }
      const joined = rows(
        await member.data('/api/view/run', c, {
          view: { base: m.target, columns: ['id', `${m.unitForeignKey}.name`, `${m.workForeignKey}.name`] },
        }),
      );
      assert.deepEqual(joined, [
        { id: expected.target, [`${m.unitForeignKey}.name`]: `${prefix} main unit`, [`${m.workForeignKey}.name`]: `${prefix} work` },
      ]);
      const aggregate = rows(await member.data('/api/breakdown', c, { text: `${m.work} count by status` }));
      assert.equal(aggregate.length, 1);
      assert.ok(Object.values(aggregate[0]).includes('open'));
      assert.ok(Object.values(aggregate[0]).includes(1), 'aggregate must count only one visible work record');
      // Exercise the reverse-join compiler with the actual public FK names,
      // separately from base-table breakdowns and reference-count metadata.
      for (const [base, child, id] of [
        [m.unit, m.work, expected.unit],
        [m.work, m.target, expected.work],
        [m.target, m.event, expected.target],
      ] as const) {
        assert.deepEqual(rows(await member.data('/api/view/run', c, { view: reverseView(base, child) })), [{ id, relatedCount: 1 }]);
      }
      for (const hidden of c === north ? [f.rows.north.otherUnit, f.rows.south.unit] : [f.rows.north.unit, f.rows.north.otherUnit]) {
        assert.deepEqual(
          rows(
            await member.data('/api/view/run', c, {
              view: { ...reverseView(m.unit, m.work), filter: { groups: [[{ path: 'id', op: '=', value: hidden }]] } },
            }),
          ),
          [],
          'guessed unowned roots must disclose no reverse counts',
        );
      }
      // The native parent picker uses this same scoped query contract.
      assert.deepEqual(rows(await member.data('/api/query', c, { table: m.unit, columns: ['id', 'name'] })), [
        { id: expected.unit, name: `${prefix} main unit` },
      ]);
      const events = rows(await member.data('/api/query', c, { table: m.event }));
      assert.equal(events.length, 1);
      assert.equal(events[0].body, `${prefix} seed`);
    }
    for (const [table, ids] of [
      [m.unit, [f.rows.north.unit, f.rows.north.otherUnit]],
      [m.work, [f.rows.north.work, f.rows.north.otherWork]],
      [m.target, [f.rows.north.target, f.rows.north.otherTarget]],
    ] as const) {
      assert.deepEqual(
        rows(await manager.data('/api/query', managed, { table }))
          .map((row) => row.id)
          .sort(),
        [...ids].sort(),
      );
      assert.equal((await manager.data('/api/count', managed, { table })).body.count, 2);
    }
    assert.deepEqual(
      rows(await manager.data('/api/view/run', managed, { view: reverseView(m.unit, m.work) })).sort((a, b) =>
        String(a.id).localeCompare(String(b.id)),
      ),
      [f.rows.north.unit, f.rows.north.otherUnit].sort().map((id) => ({ id, relatedCount: 1 })),
    );
    const managerSouth = await manager.open('riverview');
    assert.deepEqual(
      rows(await manager.data('/api/query', managerSouth, { table: m.unit })).map((row) => row.id),
      [f.rows.south.unit],
    );
    for (const hidden of [f.rows.north.otherWork, f.rows.south.work]) {
      assert.deepEqual(rows(await member.data('/api/query', north, { table: m.work, filter: filter('id', hidden) })), []);
      assert.equal((await member.data('/api/count', north, { table: m.work, filter: filter('id', hidden) })).body.count, 0);
    }
    assert.deepEqual(
      rows(await member.data('/api/query', north, { table: m.work })).map((row) => row.id),
      [f.rows.north.work],
    );
  });

  test(`${kind}: public schema, related plans and references hide managed ownership and inaccessible roots`, async (t) => {
    const f = await fixture(t, kind),
      m = f.model,
      client = await login(f),
      c = await client.open();
    const schema = (await client.data('/api/schema', c)).body;
    assert.deepEqual(
      objects(schema.tables)
        .map((table) => table.id)
        .sort(),
      [m.unit, m.work, m.target, m.event].sort(),
    );
    for (const table of objects(schema.tables)) assert.ok(objects(table.columns).some((column) => column.name === 'id'));
    const app = object((await client.data('/api/app', c)).body.app);
    assert.deepEqual(app.writableTables, [m.work]);
    assert.deepEqual(app.grantedCommands, [m.command]);
    assert.equal(object(object(app.resources)[m.target]).actions instanceof Array, true);
    await client.data('/api/runtime', c);
    const pages = objects((await client.data('/api/pages', c)).body.pages);
    assert.deepEqual(pages.map((page) => page.id).sort(), [m.unit, m.work, m.target, m.event].sort());
    for (const [table, key, child, name] of [
      [m.unit, f.rows.north.unit, m.work, 'Northstar work'],
      [m.work, f.rows.north.work, m.target, 'Northstar target'],
      [m.target, f.rows.north.target, m.event, 'Seed update'],
    ] as const) {
      const planned = await client.data('/api/pages/plan', c, { page: table, key: { id: key } });
      const list = objects(planned.body.plans).find((plan) => plan.kind === 'list');
      assert.ok(list);
      assert.equal(object(list.view).base, child);
      assert.deepEqual(
        rows(await client.data('/api/view/run', c, { view: list.view })).map((row) => row.name),
        [name],
      );
      const refs = objects((await client.data('/api/references', c, { table, key: { id: key } })).body.references);
      assert.ok(refs.some((ref) => ref.table === child && ref.count === 1));
      assert.ok(refs.every((ref) => ref.count === 1));
    }
    for (const [table, ids] of [
      [m.unit, [f.rows.north.otherUnit, f.rows.south.unit]],
      [m.work, [f.rows.north.otherWork, f.rows.south.work]],
      [m.target, [f.rows.north.otherTarget, f.rows.south.target]],
    ] as const) {
      for (const id of ids) {
        denied(await client.data('/api/pages/plan', c, { page: table, key: { id } }));
        denied(await client.data('/api/references', c, { table, key: { id } }));
      }
    }
    for (const table of [m.unit, m.work, m.target, m.event]) {
      denied(await client.data('/api/query', c, { table, columns: ['tenant_id'] }));
      denied(await client.data('/api/query', c, { table, filter: filter('tenant_id', 'riverview') }));
    }
    denied(await client.data('/api/view/run', c, { view: { base: m.work, columns: [`${m.unitForeignKey}.tenant_id`] } }));
  });

  test(`${kind}: work creation/update inject ownership; cross-tenant/hidden parents and managed-field forgeries roll back`, async (t) => {
    const f = await fixture(t, kind),
      m = f.model,
      client = await login(f),
      c = await client.open();
    const initial = evidence(f);
    for (const parent of [f.rows.north.otherUnit, f.rows.south.unit]) {
      denied(
        await client.data('/api/insert', c, {
          table: m.work,
          values: {
            business_id: 'FORGED-PARENT',
            name: 'Must not persist',
            [m.unitForeignKey]: parent,
          },
        }),
      );
      denied(
        await client.data('/api/update', c, {
          table: m.work,
          key: { id: f.rows.north.work },
          values: { name: 'Must not persist', [m.unitForeignKey]: parent },
        }),
      );
      assert.deepEqual(evidence(f), initial);
    }
    for (const owner of ['northstar', 'riverview']) {
      denied(
        await client.data('/api/insert', c, {
          table: m.work,
          values: {
            business_id: 'FORGED-OWNER',
            name: 'Must not persist',
            [m.unitForeignKey]: f.rows.north.unit,
            tenant_id: owner,
          },
        }),
      );
      denied(await client.data('/api/update', c, { table: m.work, key: { id: f.rows.north.work }, values: { tenant_id: owner } }));
      assert.deepEqual(evidence(f), initial);
    }
    for (const id of [f.rows.north.otherWork, f.rows.south.work]) {
      denied(await client.data('/api/update', c, { table: m.work, key: { id }, values: { name: 'Must not persist' } }));
      denied(await client.data('/api/delete', c, { table: m.work, key: { id }, confirm: true }));
      assert.deepEqual(evidence(f), initial);
    }
    for (const [table, id] of [
      [m.target, f.rows.north.target],
      [m.event, 'northstar-event'],
    ] as const) {
      denied(await client.data('/api/update', c, { table, key: { id }, values: { name: 'Generic command bypass' } }));
      denied(await client.data('/api/delete', c, { table, key: { id }, confirm: true }));
    }
    denied(
      await client.data('/api/insert', c, {
        table: m.target,
        values: {
          id: 'generic-target',
          business_id: 'GENERIC-TARGET',
          name: 'Generic command bypass',
          [m.unitForeignKey]: f.rows.north.unit,
          [m.workForeignKey]: f.rows.north.work,
          status: 'open',
          version: 0,
        },
      }),
    );
    denied(
      await client.data('/api/insert', c, {
        table: m.event,
        values: {
          name: 'Generic command bypass',
          [m.unitForeignKey]: f.rows.north.unit,
          [m.targetForeignKey]: f.rows.north.target,
          body: 'Must not persist',
          created_at: '2026-09-08T00:00:00.000Z',
        },
      }),
    );
    assert.deepEqual(evidence(f), initial);
    const inserted = await client.data('/api/insert', c, {
      table: m.work,
      values: {
        business_id: 'CRUD-001',
        name: 'Created through HTTP',
        [m.unitForeignKey]: f.rows.north.unit,
      },
    });
    assert.equal(inserted.status, 200);
    const created = evidence(f).work.find((row) => row.business_id === 'CRUD-001');
    assert.ok(created);
    assert.equal(created.tenant_id, 'northstar');
    assert.equal(created.status, 'open');
    const key = { id: created.id };
    assert.deepEqual(inserted.body.key, key);
    assert.deepEqual(inserted.body.applied, {
      business_id: 'CRUD-001',
      name: 'Created through HTTP',
      [m.unitForeignKey]: f.rows.north.unit,
    });
    const updated = await client.data('/api/update', c, {
      table: m.work,
      key,
      expected: { name: 'Created through HTTP' },
      values: { name: 'Edited through HTTP' },
    });
    assert.equal(updated.body.affected, 1);
    assert.deepEqual(updated.body.applied, { name: 'Edited through HTTP' });
    assert.equal(
      rows(await client.data('/api/query', c, { table: m.work, filter: filter('id', String(created.id)) }))[0].name,
      'Edited through HTTP',
    );
    const after = evidence(f);
    assert.deepEqual(
      after.work.find((row) => row.id === created.id),
      { ...created, name: 'Edited through HTTP' },
    );
    assert.deepEqual({ ...after, work: after.work.filter((row) => row.id !== created.id) }, initial);
  });

  test(`${kind}: parent-table deletion is deliberately unavailable even for authorized work without dependents`, async (t) => {
    const f = await fixture(t, kind),
      m = f.model,
      client = await login(f),
      c = await client.open();
    // Observe the structural Delete boundary independently of create-response
    // projection, which has its own proof above. Inbound FKs disable Delete
    // before row counts, even though ordinary insert/update remain permitted.
    const inserted = await client.call(
      client.select('/api/insert', c.tenantId),
      {
        table: m.work,
        values: {
          business_id: 'DELETE-001',
          name: 'Disposable work',
          [m.unitForeignKey]: f.rows.north.unit,
        },
      },
      client.headers(c),
    );
    owned(inserted, c);
    const before = evidence(f),
      created = before.work.find((row) => row.business_id === 'DELETE-001');
    assert.ok(created);
    assert.deepEqual(inserted.body.key, { id: created.id });
    assert.equal(created.tenant_id, c.tenantId);
    assert.equal(
      before.targets.some((row) => row[m.workForeignKey] === created.id),
      false,
    );
    const schema = objects((await client.data('/api/schema', c)).body.tables),
      work = schema.find((table) => table.id === m.work);
    assert.ok(work);
    assert.equal(work.insertable, true);
    assert.equal(work.deletable, false);
    assert.equal(objects(work.columns).find((column) => column.name === 'name')?.writable, true);
    for (const confirm of [false, true]) {
      const removed = await client.data('/api/delete', c, { table: m.work, key: { id: created.id }, confirm });
      denied(removed);
      assert.equal(removed.body.deleted, false);
      assert.deepEqual(evidence(f), before);
    }
  });

  test(`${kind}: viewer membership reads one unit but grants neither CRUD nor commands`, async (t) => {
    const f = await fixture(t, kind),
      m = f.model,
      client = await login(f, 'viewer');
    assert.deepEqual((await client.bootstrap()).memberships, [{ tenantId: 'northstar' }]);
    const c = await client.open(),
      before = evidence(f);
    assert.deepEqual(
      rows(await client.data('/api/query', c, { table: m.work })).map((row) => row.id),
      [f.rows.north.work],
    );
    const app = object((await client.data('/api/app', c)).body.app);
    assert.deepEqual(app.writableTables, []);
    assert.deepEqual(app.grantedCommands, []);
    denied(await client.call(client.select('/api/tenant/context/open', 'riverview'), {}));
    for (const [path, body] of [
      ['/api/insert', { table: m.work, values: { business_id: 'VIEWER', name: 'Denied', [m.unitForeignKey]: f.rows.north.unit } }],
      ['/api/update', { table: m.work, key: { id: f.rows.north.work }, values: { name: 'Denied' } }],
      ['/api/delete', { table: m.work, key: { id: f.rows.north.work }, confirm: true }],
      ['/api/commands/prepare', { command: m.command, commandVersion: 1, key: { id: f.rows.north.target } }],
      ['/api/commands/execute', command(f)],
      ['/api/commands/status', command(f)],
    ] as const)
      denied(await client.data(path, c, body));
    assert.deepEqual(evidence(f), before);
  });

  test(`${kind}: same actor/key in two tenants commits two-resource commands and independent durable receipts exactly once`, async (t) => {
    const f = await fixture(t, kind),
      m = f.model,
      client = await login(f),
      north = await client.open(),
      south = await client.open('riverview');
    const initial = evidence(f);
    for (const target of [f.rows.north.otherTarget, f.rows.south.target]) {
      denied(await client.data('/api/commands/prepare', north, { command: m.command, commandVersion: 1, key: { id: target } }));
      denied(await client.data('/api/commands/execute', north, command(f, target)));
    }
    denied(await client.data('/api/commands/execute', north, { ...command(f), expectedVersion: 1 }));
    denied(await client.data('/api/commands/execute', north, { ...command(f), input: { body: '   ' } }));
    assert.deepEqual(evidence(f), initial);
    const receipts: unknown[] = [];
    for (const [c, target] of [
      [north, f.rows.north.target],
      [south, f.rows.south.target],
    ] as const) {
      const prepared = await client.data('/api/commands/prepare', c, { command: m.command, commandVersion: 1, key: { id: target } });
      assert.equal(prepared.body.expectedVersion, 0);
      const input = command(f, target),
        first = await client.data('/api/commands/execute', c, input),
        result = applied(first, target);
      assert.equal(first.body.replayed, false);
      receipts.push(first.body.receiptId);
      const after = evidence(f),
        changed = after.targets.find((row) => row.id === target);
      assert.ok(changed);
      assert.equal(changed.version, 1);
      assert.equal(changed.status, 'done');
      const event = after.events.find((row) => row.id === result.eventId);
      assert.ok(event);
      assert.equal(event.tenant_id, c.tenantId);
      assert.equal(event[m.targetForeignKey], target);
      assert.equal(event[m.unitForeignKey], `${c.tenantId}-main`);
      assert.equal(event.body, input.input.body);
      for (const path of ['/api/commands/execute', '/api/commands/status']) {
        const replay = await client.data(path, c, input);
        applied(replay, target);
        assert.equal(replay.body.replayed, true);
        assert.equal(replay.body.receiptId, first.body.receiptId);
        assert.deepEqual(replay.body.result, result);
        assert.deepEqual(evidence(f), after);
      }
      denied(await client.data('/api/commands/execute', c, { ...input, input: { body: 'Conflicting payload' } }));
      denied(
        await client.data('/api/commands/execute', c, { ...input, expectedVersion: 1, idempotencyKey: 'closed-target-fresh-attempt-0001' }),
      );
      assert.deepEqual(evidence(f), after);
    }
    assert.ok(receipts.every((id) => typeof id === 'string'));
    assert.notEqual(receipts[0], receipts[1]);
    const after = evidence(f);
    assert.equal(after.events.length, initial.events.length + 2);
    assert.equal(after.receipts.length, 2);
    assert.equal(after.audits.length, 2);
    assert.deepEqual(after.work, initial.work);
    assert.deepEqual(after.units, initial.units);
    assert.deepEqual(
      after.targets.find((row) => row.id === f.rows.north.otherTarget),
      initial.targets.find((row) => row.id === f.rows.north.otherTarget),
    );
    assert.deepEqual(
      after.receipts.map((row) => [row.tenant_id, row.actor_id, row.idempotency_key]).sort(),
      ['northstar', 'riverview'].map((tenant) => [tenant, f.accounts.member.id, command(f).idempotencyKey]),
    );
    for (const audit of after.audits) {
      assert.equal(audit.membership_version, '1');
      assert.equal(audit.actor_id, f.accounts.member.id);
      assert.ok(after.receipts.some((receipt) => receipt.id === audit.receipt_id && receipt.tenant_id === audit.tenant_id));
    }
  });

  test(`${kind}: membership version/location shift denies old renewal and prior results under a fresh unauthorized scope`, async (t) => {
    const f = await fixture(t, kind),
      m = f.model,
      client = await login(f),
      old = await client.open(),
      input = command(f);
    applied(await client.data('/api/commands/execute', old, input), f.rows.north.target);
    const committed = evidence(f);
    await f.shift(f.accounts.member.id, 'northstar');
    denied(await client.data('/api/query', old, { table: m.work }));
    denied(await client.data('/api/commands/status', old, input));
    denied(await client.call(client.select('/api/tenant/context/renew', 'northstar'), assertion(old)));
    const fresh = await client.open();
    assert.deepEqual(
      rows(await client.data('/api/query', fresh, { table: m.work })).map((row) => row.id),
      [f.rows.north.otherWork],
    );
    assert.deepEqual(
      rows(await client.data('/api/query', fresh, { table: m.event })).map((row) => row.id),
      ['northstar-other-event'],
    );
    for (const path of ['/api/commands/status', '/api/commands/execute']) denied(await client.data(path, fresh, input));
    denied(await client.data('/api/references', fresh, { table: m.target, key: input.key }));
    assert.deepEqual(evidence(f), committed);
  });

  test(`${kind}: revoked membership cannot renew, reopen or recover an already committed command result`, async (t) => {
    const f = await fixture(t, kind),
      client = await login(f),
      north = await client.open(),
      south = await client.open('riverview'),
      input = command(f);
    applied(await client.data('/api/commands/execute', north, input), f.rows.north.target);
    const committed = evidence(f);
    await f.revoke(f.accounts.member.id, 'northstar');
    for (const path of ['/api/commands/status', '/api/commands/execute']) denied(await client.data(path, north, input));
    denied(await client.call(client.select('/api/tenant/context/renew', 'northstar'), assertion(north)));
    denied(await client.call(client.select('/api/tenant/context/open', 'northstar'), {}));
    assert.deepEqual((await client.bootstrap()).memberships, [{ tenantId: 'riverview' }]);
    assert.deepEqual(
      rows(await client.data('/api/query', south, { table: f.model.target })).map((row) => row.id),
      [f.rows.south.target],
    );
    denied(await client.data('/api/commands/status', south, input));
    assert.deepEqual(evidence(f), committed);
  });
}

test('genuine Ignition and Thread hosts refuse cross-App context claims even with a valid receiving-host login', async (t) => {
  const ignition = await fixture(t, 'ignition'),
    thread = await fixture(t, 'thread');
  const a = await login(ignition),
    b = await login(thread),
    ca = await a.open(),
    cb = await b.open();
  for (const [source, destination, destinationFixture] of [
    [ca, b, thread],
    [cb, a, ignition],
  ] as const) {
    // Replacing the public App/account claims cannot mint the receiving host's
    // private context; authentication itself remains genuinely valid there.
    const forged = { ...source, appId: destinationFixture.appId, accountId: destinationFixture.accounts.member.id };
    denied(await destination.data('/api/query', forged, { table: destinationFixture.model.work }));
    denied(
      await destination.call(
        `/api/query?app=${source.appId}&tenant=northstar`,
        { table: destinationFixture.model.work },
        destination.headers(forged),
      ),
    );
  }
  assert.deepEqual(
    rows(await a.data('/api/query', ca, { table: ignition.model.work })).map((row) => row.id),
    [ignition.rows.north.work],
  );
  assert.deepEqual(
    rows(await b.data('/api/query', cb, { table: thread.model.work })).map((row) => row.id),
    [thread.rows.north.work],
  );
});
