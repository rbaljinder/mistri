import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type QueryRequest, type UpdateRequest } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { accessibleSchema, AppAccessDenied, authorizeResources, type ResourceAccess } from '../packages/mistri/src/server/app/appAccess.js';
import { createAppSourceAdapter, type AppAdapterSource } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';

const fields = (read: string[], write: string[] = []) => ({ read: new Set(read), write: new Set(write) });
const query = (table = 'person', extra: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 20, offset: 0, ...extra });
const view = (base = 'person', extra: Partial<ViewDef> = {}): ViewDef => ({ id: 'fields', name: 'Fields', base, columns: [], ...extra });
const breakdown = (extra: Partial<BreakdownDef> = {}): BreakdownDef => ({ base: 'ticket', by: [], measures: [{ fn: 'count' }], ...extra });
const denied = (run: () => unknown) => assert.rejects(async () => run(), AppAccessDenied);

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-field-access-'));
  const opened: SqliteAdapter[] = [];
  t.after(async () => {
    await Promise.all(opened.map((adapter) => adapter.close()));
    rmSync(dir, { recursive: true, force: true });
  });
  const sources: Record<string, AppAdapterSource> = {};
  for (const source of ['operations', 'inventory']) {
    const file = join(dir, `${source}.db`);
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE physical_person (id INTEGER PRIMARY KEY, name TEXT, secret TEXT DEFAULT 'hidden-default', code TEXT UNIQUE);
      CREATE INDEX secret_index ON physical_person(secret);
      CREATE TABLE physical_ticket (id INTEGER PRIMARY KEY, title TEXT,
        owner_id INTEGER REFERENCES physical_person(id) ON DELETE CASCADE ON UPDATE CASCADE,
        private_owner_id TEXT REFERENCES physical_person(code) ON DELETE SET NULL ON UPDATE CASCADE,
        secret TEXT DEFAULT 'ticket-default');
      CREATE TABLE physical_note (id INTEGER PRIMARY KEY,
        ticket_id INTEGER REFERENCES physical_ticket(id) ON DELETE CASCADE, body TEXT);
      CREATE TABLE physical_pair (id INTEGER PRIMARY KEY, a TEXT, b TEXT, UNIQUE(a, b));
      CREATE TABLE physical_link (id INTEGER PRIMARY KEY, a TEXT, b TEXT,
        FOREIGN KEY(a, b) REFERENCES physical_pair(a, b));
      INSERT INTO physical_person VALUES (1, '${source}', 'personal-secret', 'private-code');
      INSERT INTO physical_ticket VALUES (1, 'Visible ticket', 1, 'private-code', 'ticket-secret');
      INSERT INTO physical_note VALUES (1, 1, 'Visible note');
      INSERT INTO physical_pair VALUES (1, 'left', 'right');
      INSERT INTO physical_link VALUES (1, 'left', 'right');
    `);
    db.close();
    const adapter = new SqliteAdapter(file, source);
    opened.push(adapter);
    sources[source] = {
      adapter,
      schema: await adapter.introspect(),
      writable: true,
      resources: {
        person: 'physical_person',
        ticket: 'physical_ticket',
        note: 'physical_note',
        pair: 'physical_pair',
        link: 'physical_link',
      },
    };
  }
  const runtime = createAppSourceAdapter(sources, 'operations');
  const resources: RuntimeResources = {
    ...runtime,
    connections: ['operations', 'inventory'],
    connectionFor: (name) => runtime.resolve(name).source,
    toPhysical: (name) => runtime.resolve(name).physicalTable,
    toLogical: (name) => runtime.catalogs.get('operations')!.toLogical(name),
    toLogicalAt: (name, owner) => (owner === 'operations' ? '' : `${owner}.`) + runtime.catalogs.get(owner)!.toLogical(name),
    forConnection: (owner) => runtime.forSource(owner),
  };
  const access: ResourceAccess = {
    readable: new Set(runtime.schema.tables.map((table) => table.id)),
    writable: new Set(runtime.schema.tables.map((table) => table.id)),
    fields: new Map([
      ['person', fields(['id', 'name', 'code'], ['name'])],
      ['ticket', fields(['id', 'title', 'owner_id'], ['title', 'owner_id'])],
      ['inventory.person', fields(['id', 'name'], ['name'])],
      ['inventory.ticket', fields(['id', 'title', 'owner_id'], ['title'])],
    ]),
  };
  return { resources, access, raw: runtime.adapter, guarded: (policy = access) => authorizeResources(resources, policy) };
}

test('real catalog prunes hidden fields, indexes and either end of composite relationships, and emits field writability', async (t) => {
  const { resources, access } = await fixture(t);
  const policy = { ...access, fields: new Map(access.fields) };
  policy.fields.set('pair', fields(['id', 'a']));
  const before = structuredClone(resources.schema);
  const schema = accessibleSchema(resources.schema, policy);
  const person = schema.tables.find((table) => table.id === 'person')!;
  assert.deepEqual(
    person.columns.map((column) => [column.name, column.writable]),
    [
      ['id', false],
      ['name', true],
      ['code', false],
    ],
  );
  assert.equal(person.deletable, false);
  assert.equal(schema.tables.find((table) => table.id === 'note')!.deletable, undefined);
  assert.ok(!person.indexed?.includes('secret'));
  assert.ok(schema.foreignKeys.some((fk) => fk.from.table === 'ticket' && fk.from.columns.includes('owner_id')));
  assert.ok(!schema.foreignKeys.some((fk) => fk.from.table === 'ticket' && fk.from.columns.includes('private_owner_id')));
  assert.ok(!schema.foreignKeys.some((fk) => fk.to.table === 'pair'));
  assert.ok(schema.tables.find((table) => table.id === 'link')!.columns.every((column) => !column.references));
  policy.fields.delete('pair');
  policy.fields.set('link', fields(['id', 'a']));
  assert.ok(!accessibleSchema(resources.schema, policy).foreignKeys.some((fk) => fk.from.table === 'link'));
  policy.fields.set('inventory.ticket', fields(['id', 'title', 'owner_id', 'private_owner_id', 'secret']));
  const hiddenTarget = accessibleSchema(resources.schema, policy);
  assert.ok(!hiddenTarget.foreignKeys.some((fk) => fk.from.table === 'inventory.ticket' && fk.from.columns.includes('private_owner_id')));
  assert.equal(
    hiddenTarget.tables.find((table) => table.id === 'inventory.ticket')!.columns.find((column) => column.name === 'private_owner_id')!
      .references,
    undefined,
  );
  const readOnly = accessibleSchema(resources.schema, { ...policy, writable: new Set() });
  assert.ok(readOnly.tables.find((table) => table.id === 'person')!.columns.every((column) => column.writable === false));
  assert.equal(readOnly.tables.find((table) => table.id === 'person')!.deletable, false);
  policy.fields.set('person', fields(['id', 'name', 'code', 'secret'], ['id', 'name', 'code', 'secret']));
  assert.equal(accessibleSchema(resources.schema, policy).tables.find((table) => table.id === 'person')!.deletable, true);
  assert.deepEqual(resources.schema, before);
});

test('text precedence is materialized on the pruned catalog and cannot re-expand defaults in a downstream parser', async (t) => {
  const { resources, access, raw } = await fixture(t);
  const delegated: Array<ViewDef | BreakdownDef> = [];
  // Exercise a downstream adapter that *would* reparse retained text against
  // the full schema, then execute against the real SQLite fixtures.
  const adapter = authorizeResources(
    {
      ...resources,
      adapter: {
        ...raw,
        runView: async (def, offset) => {
          delegated.push(def);
          return raw.runView!(def.text ? textToView(resources.schema, def.text).view! : def, offset);
        },
        countView: async (def) => {
          delegated.push(def);
          return raw.countView!(def.text ? textToView(resources.schema, def.text).view! : def);
        },
        runBreakdown: async (def, offset) => {
          delegated.push(def);
          return raw.runBreakdown!(def.text ? textToBreakdown(resources.schema, def.text).breakdown! : def, offset);
        },
        countBreakdown: async (def) => {
          delegated.push(def);
          return raw.countBreakdown!(def.text ? textToBreakdown(resources.schema, def.text).breakdown! : def);
        },
      },
    },
    access,
  ).adapter;
  const defaults = view('ticket', {
    text: 'person',
    columns: [{ path: 'secret' }],
    filter: { groups: [[{ path: 'secret', op: '=', value: 'stale structure' }]] },
  });
  assert.deepEqual((await adapter.runView!(defaults)).rows, [{ id: 1, name: 'operations', code: 'private-code' }]);
  assert.equal(await adapter.countView!(defaults), 1);
  assert.equal(defaults.text, 'person', 'Authored input is not mutated');
  assert.deepEqual((await adapter.runView!(view('ticket', { text: 'inventory.person' }))).rows, [{ id: 1, name: 'inventory' }]);
  assert.deepEqual((await adapter.runView!(view('person', { text: 'ticket show owner_id.name as owner' }))).rows, [
    { owner: 'operations' },
  ]);
  for (const text of [
    'person show secret',
    'person where secret = personal-secret',
    'person sort secret',
    'ticket show private_owner_id.name',
    'ticket show owner_id.secret',
    'inventory.person show code',
    '',
  ]) {
    const def = view('person', { text, columns: [{ path: 'name' }] });
    await denied(() => adapter.runView!(def));
    await denied(() => adapter.countView!(def));
  }
  const grouped = breakdown({ text: 'inventory.ticket count by owner_id.name', by: [{ path: 'secret' }] });
  assert.deepEqual((await adapter.runBreakdown!(grouped)).rows, [{ 'owner_id.name': 'inventory', count: 1 }]);
  assert.equal(await adapter.countBreakdown!(grouped), 1);
  for (const text of ['person count by secret', 'ticket max owner_id.secret', 'ticket count by private_owner_id.name']) {
    await denied(() => adapter.runBreakdown!(breakdown({ text })));
    await denied(() => adapter.countBreakdown!(breakdown({ text })));
  }
  assert.ok(delegated.every((def) => def.text === undefined));
  assert.deepEqual((delegated[0] as ViewDef).columns, [{ path: 'id' }, { path: 'name' }, { path: 'code' }]);
});

test('default and explicit reads narrow SQL itself, while hidden projection/filter/order/count attempts refuse', async (t) => {
  const { guarded } = await fixture(t);
  const adapter = guarded().adapter;
  for (const columns of [undefined, []]) {
    const result = await adapter.query(query('person', { columns }));
    assert.deepEqual(result.columns, ['id', 'name', 'code']);
    assert.deepEqual(result.rows, [{ id: 1, name: 'operations', code: 'private-code' }]);
    assert.doesNotMatch(result.sql.text, /secret|SELECT \*/);
    assert.doesNotMatch(JSON.stringify(result), /personal-secret/);
  }
  assert.deepEqual((await adapter.query(query('person', { columns: ['name'] }))).rows, [{ name: 'operations' }]);
  for (const column of ['secret', 'missing', 'name, secret', '*']) {
    await denied(() => adapter.query(query('person', { columns: ['name', column] })));
    await denied(() => adapter.query(query('person', { orderBy: [{ column, direction: 'desc' }] })));
    const filter = { groups: [[{ column, op: '=' as const, value: 'personal-secret' }]] };
    await denied(() => adapter.query(query('person', { filter })));
    await denied(() => adapter.count('person', filter));
  }
  assert.equal(await adapter.count('person', { groups: [[{ column: 'name', op: '=', value: 'operations' }]] }), 1);
});

test('structured view defaults narrow and all explicit hidden paths refuse on execution and count', async (t) => {
  const { guarded } = await fixture(t);
  const adapter = guarded().adapter;
  const result = await adapter.runView!(view());
  assert.deepEqual(result.columns, ['id', 'name', 'code']);
  assert.doesNotMatch(JSON.stringify(result), /personal-secret|"column":"secret"/);
  const related = await adapter.runView!(view('ticket', { columns: [{ path: 'owner_id.name' }] }));
  assert.equal(related.rows[0]['owner_id.name'], 'operations');
  for (const def of [
    view('person', { columns: [{ path: 'secret' }] }),
    view('ticket', { columns: [{ path: 'owner_id.secret' }] }),
    view('ticket', { columns: [{ path: 'private_owner_id.name' }] }),
    view('ticket', { filter: { groups: [[{ path: 'owner_id.secret', op: '=', value: 'personal-secret' }]] } }),
    view('ticket', { orderBy: [{ path: 'owner_id.secret', direction: 'asc' }] }),
    view('person', { aggregates: [{ fn: 'sum', via: 'ticket.owner_id', column: 'secret' }] }),
    view('person', { aggregates: [{ fn: 'count', via: 'ticket.owner_id', column: 'secret' }] }),
    view('person', { aggregates: [{ fn: 'count', via: 'ticket.private_owner_id' }] }),
  ]) {
    await assert.rejects(async () => adapter.runView!(def));
    await assert.rejects(async () => adapter.countView!(def));
  }
  const counts = view('person', { aggregates: [{ fn: 'count', via: 'ticket.owner_id', alias: 'tickets' }] });
  assert.equal((await adapter.runView!(counts)).rows[0].tickets, 1);
  assert.equal(await adapter.countView!(counts), 1);
});

test('breakdowns enforce grouping, measures, filtering and hidden join columns for run and count', async (t) => {
  const { guarded } = await fixture(t);
  const adapter = guarded().adapter;
  for (const def of [
    breakdown({ by: [{ path: 'secret' }] }),
    breakdown({ by: [{ path: 'private_owner_id.name' }] }),
    breakdown({ measures: [{ fn: 'count', path: 'owner_id.secret' }] }),
    breakdown({ measures: [{ fn: 'max', path: 'owner_id.secret' }] }),
    breakdown({ filter: { groups: [[{ path: 'secret', op: '=', value: 'ticket-secret' }]] } }),
  ]) {
    await assert.rejects(async () => adapter.runBreakdown!(def));
    await assert.rejects(async () => adapter.countBreakdown!(def));
  }
  const def = breakdown({ by: [{ path: 'owner_id.name' }] });
  assert.deepEqual((await adapter.runBreakdown!(def)).rows, [{ 'owner_id.name': 'operations', count: 1 }]);
  assert.equal(await adapter.countBreakdown!(def), 1);
});

test('restricted profiles refuse before exposing statistics; omitted field entries retain existing columns and resource ceilings', async (t) => {
  const { resources, guarded, access } = await fixture(t);
  const adapter = guarded().adapter;
  await denied(() => adapter.profile!('person'));
  assert.equal(await adapter.count('person'), 1);
  assert.equal((await adapter.profile!('note')).columns.length, 3);
  assert.deepEqual((await adapter.query(query('note'))).rows, [{ id: 1, ticket_id: 1, body: 'Visible note' }]);
  const unrestricted = authorizeResources(resources, { readable: access.readable, writable: access.writable }).adapter;
  assert.equal((await unrestricted.query(query())).rows[0].secret, 'personal-secret');
  const hidden = guarded({ ...access, readable: new Set(['ticket']) }).adapter;
  await denied(() => hidden.query(query()));
  await denied(() => hidden.insert!({ table: 'person', values: { name: 'Denied' } }));
  assert.equal(hidden.estimateCount, undefined, 'SQLite does not offer estimates; preserve capability detection');
});

test('insert payloads redact hidden defaults; values, expected and keys cannot read or write protected fields', async (t) => {
  const { guarded, raw } = await fixture(t);
  const adapter = guarded().adapter;
  const inserted = await adapter.insert!({ table: 'person', values: { name: 'New' } });
  assert.deepEqual(inserted.row, { id: 2, name: 'New', code: null });
  assert.deepEqual(inserted.key, { id: 2 });
  assert.deepEqual(inserted.applied, { name: 'New' });
  assert.doesNotMatch(JSON.stringify(inserted), /hidden-default/);
  assert.equal((await raw.query(query())).rows[1].secret, 'hidden-default');
  for (const column of ['secret', 'code', 'missing']) {
    await denied(() => adapter.insert!({ table: 'person', values: { name: 'Denied', [column]: 'Denied' } }));
    await denied(() => adapter.update!({ table: 'person', key: { id: 1 }, values: { [column]: 'Denied' } }));
  }
  await denied(() => adapter.update!({ table: 'person', key: { id: 1, secret: 'personal-secret' }, values: { name: 'Denied' } }));
  await denied(() =>
    adapter.update!({ table: 'person', key: { id: 1 }, values: { name: 'Denied' }, expected: { secret: 'personal-secret' } }),
  );
  const invalidExpected: Array<NonNullable<UpdateRequest['expected']>> = [
    {},
    { name: 'operations', code: 'private-code' },
    { code: 'private-code' },
  ];
  for (const expected of invalidExpected) {
    await denied(() => adapter.update!({ table: 'person', key: { id: 1 }, values: { name: 'Denied' }, expected }));
  }
  for (const key of [{}, { id: true }, { id: null }]) {
    await denied(() => adapter.update!({ table: 'person', key: key as UpdateRequest['key'], values: { name: 'Denied' } }));
  }
  await assert.rejects(
    async () => adapter.update!({ table: 'person', key: { id: 1, name: 'operations' }, values: { name: 'Denied' } }),
    Refusal,
  );
  const updated = await adapter.update!({ table: 'person', key: { id: 1 }, values: { name: 'Edited' }, expected: { name: 'operations' } });
  assert.deepEqual(updated.applied, { name: 'Edited' });
  assert.doesNotMatch(JSON.stringify(updated), /personal-secret/);
  await denied(() => adapter.remove!({ table: 'person', key: { id: 1 } }));
  assert.equal(await raw.count('person'), 2);
});

test('inherited, accessor, non-enumerable and coercible write inputs refuse without executing getters', async (t) => {
  const { guarded, raw } = await fixture(t);
  const adapter = guarded().adapter;
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'name', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'Denied';
    },
  });
  const records = [
    Object.create({ secret: 'Denied' }),
    accessor,
    Object.defineProperty({ name: 'Denied' }, 'secret', { value: 'Denied' }),
    {
      name: {
        toString() {
          getterCalls++;
          return 'Denied';
        },
      },
    },
    { [Symbol('secret')]: 'Denied', name: 'Denied' },
  ];
  for (const record of records) {
    await denied(() => adapter.insert!({ table: 'person', values: record }));
    await denied(() => adapter.update!({ table: 'person', key: { id: 1 }, values: record }));
    await denied(() => adapter.update!({ table: 'person', key: record, values: { name: 'Denied' } }));
    await denied(() => adapter.update!({ table: 'person', key: { id: 1 }, values: { name: 'Denied' }, expected: record }));
  }
  const request = Object.defineProperty({ key: { id: 1 }, values: { name: 'Denied' } }, 'table', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'person';
    },
  }) as unknown as UpdateRequest;
  await denied(() => adapter.update!(request));
  await denied(() => adapter.query(Object.create(query())));
  for (const extra of [
    {
      columns: Object.defineProperty(['name'], '0', {
        get() {
          getterCalls++;
          return 'secret';
        },
      }),
    },
    {
      filter: {
        groups: [
          [
            Object.defineProperty({ op: '=' }, 'column', {
              enumerable: true,
              get() {
                getterCalls++;
                return 'secret';
              },
            }),
          ],
        ],
      },
    },
    { orderBy: [Object.create({ column: 'secret', direction: 'asc' })] },
  ])
    await denied(() => adapter.query(query('person', extra as Partial<QueryRequest>)));
  assert.equal(getterCalls, 0);
  assert.equal((await raw.query(query())).rows[0].name, 'operations');
});

test('queued write requests execute their authorized snapshot after caller mutation', async (t) => {
  const { guarded, raw } = await fixture(t);
  const adapter = guarded().adapter;
  const request: UpdateRequest = { table: 'person', key: { id: 1 }, values: { name: 'Snapshot' }, expected: { name: 'operations' } };
  const pending = adapter.update!(request);
  request.table = 'inventory.person';
  request.values.secret = 'Forged';
  request.values.name = 'Changed after authorization';
  request.key.id = 999;
  request.expected!.name = 'Forged';
  assert.deepEqual((await pending).applied, { name: 'Snapshot' });
  assert.equal((await raw.query(query())).rows[0].name, 'Snapshot');
  assert.equal((await raw.query(query())).rows[0].secret, 'personal-secret');
  assert.equal((await raw.query(query('inventory.person'))).rows[0].name, 'inventory');
});

test('transaction reads and mutations retain field guards, projected results, read-your-writes and rollback', async (t) => {
  const { guarded, raw } = await fixture(t);
  const adapter = guarded().forConnection('operations');
  await adapter.transaction!(async (tx) => {
    assert.deepEqual((await tx.query(query())).columns, ['id', 'name', 'code']);
    await denied(() => tx.query(query('person', { columns: ['secret'] })));
    await denied(() => tx.count('person', { groups: [[{ column: 'secret', op: '=', value: 'personal-secret' }]] }));
    await denied(() => tx.insert({ table: 'person', values: { secret: 'Denied' } }));
    await denied(() => tx.update({ table: 'person', key: { id: 1 }, values: { secret: 'Denied' } }));
    await denied(() => tx.remove({ table: 'person', key: { id: 1 } }));
    const inserted = await tx.insert({ table: 'person', values: { name: 'Transaction' } });
    assert.doesNotMatch(JSON.stringify(inserted), /hidden-default/);
    assert.equal(await tx.count('person'), 2);
    await tx.update({ table: 'person', key: inserted.key, values: { name: 'Updated transaction' } });
    assert.equal((await tx.query(query())).rows[1].name, 'Updated transaction');
  });
  await assert.rejects(
    adapter.transaction!(async (tx) => {
      await tx.insert({ table: 'person', values: { name: 'Roll back' } });
      await tx.query(query('person', { columns: ['secret'] }));
    }),
    AppAccessDenied,
  );
  assert.equal(await raw.count('person'), 2);
});

test('cascades, referenced unique-key changes and protected before-images cannot bypass dependent field grants', async (t) => {
  const { guarded, access, raw } = await fixture(t);
  const scopes = new Map(access.fields);
  scopes.delete('person');
  const adapter = guarded({ ...access, fields: scopes }).adapter;
  await denied(() => adapter.remove!({ table: 'person', key: { id: 1 } }));
  await denied(() => adapter.update!({ table: 'person', key: { id: 1 }, values: { code: 'Changed code' } }));
  await denied(() => adapter.update!({ table: 'person', key: { id: 1 }, values: { id: 2 } }));
  await adapter.update!({ table: 'person', key: { id: 1 }, values: { name: 'Safe unrelated update' } });
  assert.equal((await raw.query(query('ticket'))).rows[0].private_owner_id, 'private-code');
  scopes.set('ticket', fields(['id', 'title', 'owner_id', 'private_owner_id', 'secret'], ['id', 'title', 'owner_id', 'private_owner_id']));
  await denied(() => guarded({ ...access, fields: scopes }).adapter.remove!({ table: 'ticket', key: { id: 1 } }));
  scopes.delete('ticket');
  await guarded({ ...access, fields: scopes }).adapter.remove!({ table: 'person', key: { id: 1 } });
  assert.equal(await raw.count('person'), 0);
  assert.equal(await raw.count('ticket'), 0);
  assert.equal(await raw.count('note'), 0);
});

test('named resources and source-owned transactions apply distinct scopes without physical or bare-name bypasses', async (t) => {
  const { guarded, raw } = await fixture(t);
  const resources = guarded();
  for (const adapter of [resources.adapter, resources.forConnection('inventory')]) {
    assert.deepEqual((await adapter.query(query('inventory.person'))).rows, [{ id: 1, name: 'inventory' }]);
    await denied(() => adapter.query(query('inventory.person', { columns: ['code'] })));
    await denied(() => adapter.query(query('physical_person')));
    await denied(() => adapter.query(query('inventory.physical_person')));
    await denied(() => adapter.profile!('inventory.person'));
    const def = view('inventory.ticket', { columns: [{ path: 'owner_id.name' }] });
    assert.equal((await adapter.runView!(def)).rows[0]['owner_id.name'], 'inventory');
    assert.equal(await adapter.countView!(def), 1);
    assert.deepEqual((await adapter.runView!(view('inventory.person'))).columns, ['id', 'name']);
    const grouped = breakdown({ base: 'inventory.ticket', by: [{ path: 'owner_id.name' }] });
    assert.deepEqual((await adapter.runBreakdown!(grouped)).rows, [{ 'owner_id.name': 'inventory', count: 1 }]);
    assert.equal(await adapter.countBreakdown!(grouped), 1);
    assert.equal(adapter.runSql, undefined);
    assert.equal(adapter.ddl, undefined);
  }
  await resources.forConnection('inventory').transaction!(async (tx) => {
    const inserted = await tx.insert({ table: 'inventory.person', values: { name: 'Named new' } });
    assert.deepEqual(inserted.row, { id: 2, name: 'Named new' });
    assert.equal(await tx.count('inventory.person'), 2);
    await denied(() => tx.update({ table: 'inventory.ticket', key: { id: 1 }, values: { owner_id: 2 } }));
    await tx.update({ table: 'inventory.person', key: inserted.key, values: { name: 'Named edited' } });
  });
  await assert.rejects(resources.forConnection('inventory').query(query()), /belongs to source/);
  assert.equal(await raw.count('person'), 1);
  assert.equal(await raw.count('inventory.person'), 2);
});
