/**
 * Tenant record history and Undo, as a dialect matrix: SQLite always,
 * PostgreSQL live-gated by TABLEWALK_TEST_PG (support/tenantDialects.ts),
 * with the read and write sources of each engine. `name` folds case on both
 * engines (NOCASE, or a nondeterministic ICU collation) so an outside edit SQL
 * would call equal still cannot pass for the stored image.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import type { DeleteRequest, InsertRequest } from '../packages/engine/src/adapters/adapter.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import type { TenantDeletedRecordPolicy, TenantHistoryImage } from '../packages/mistri/src/server/tenant/tenantInverseImages.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { createTenantRecordHistory } from '../packages/mistri/src/server/tenant/tenantRecordHistory.js';
import type { TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import type { TenantWriteRuntimeOptions } from '../packages/mistri/src/server/tenant/tenantWriteRuntime.js';
import { TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import {
  CASE_INSENSITIVE,
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  TENANT_DIALECTS,
  type TenantDialect,
} from './support/tenantDialects.js';

type Request = { cookie: string };
type Options = TenantWriteRuntimeOptions<Request>;
type Service = ReturnType<typeof createTenantRecordHistory<Request>>;
const request = { cookie: 'session' },
  north = ['north'];
const binding = { appId: 'record-app', source: { id: 'business', connection: 'record-db' }, storeId: 'record-history-fixture' };
const names = {
  item: 'db_item',
  hidden: 'db_hidden',
  fixed: 'db_fixed',
  local: 'db_local',
  parent: 'db_parent',
  child: 'db_child',
  country: 'db_country',
};
const insert = (id = 'created', name = 'Created'): InsertRequest => ({ table: 'item', values: { id, business_id: id, name } });
const remove = (id = 'existing', table = 'item'): DeleteRequest => ({ table, key: { id } });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function token(result: { undoId?: string }): string {
  assert.equal(typeof result.undoId, 'string');
  assert.match(result.undoId!, /^[0-9a-f-]{36}$/);
  return result.undoId!;
}
function safe(outcome: 'not_applied' | 'unknown') {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TenantWriteFailure);
    assert.equal(error.outcome, outcome);
    assert.equal(error.code, 'tenant_write_unavailable');
    assert.equal(error.message, 'The tenant write could not be completed.');
    assert.equal('cause' in error, false);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_SENTINEL|db_item/);
    return true;
  };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const SCHEMA = {
  tables: ['db_child', 'db_parent', 'db_item', 'db_hidden', 'db_fixed', 'db_local', 'db_country'],
  sqlite: `PRAGMA foreign_keys=ON;
    CREATE TABLE db_item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT COLLATE NOCASE NOT NULL,
      business_id TEXT NOT NULL, name TEXT COLLATE NOCASE NOT NULL, note TEXT DEFAULT NULL,
      UNIQUE(tenant_id COLLATE BINARY,business_id));
    CREATE TABLE db_hidden (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
      secret TEXT DEFAULT 'PRIVATE_SENTINEL');
    CREATE TABLE db_fixed (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
      fixed TEXT DEFAULT 'Fixed');
    CREATE TABLE db_local (tenant_id TEXT COLLATE NOCASE NOT NULL, local_id INTEGER NOT NULL, name TEXT,
      PRIMARY KEY(tenant_id COLLATE BINARY,local_id));
    CREATE TABLE db_parent (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_child (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL,
      parent_id TEXT NOT NULL REFERENCES db_parent(id), name TEXT NOT NULL);
    CREATE TABLE db_country (code TEXT PRIMARY KEY NOT NULL, name TEXT);`,
  postgres: `
    CREATE TABLE public.db_item (id text PRIMARY KEY, tenant_id text NOT NULL,
      business_id text NOT NULL, name text COLLATE ${CASE_INSENSITIVE} NOT NULL, note text DEFAULT NULL,
      UNIQUE (tenant_id, business_id));
    CREATE TABLE public.db_hidden (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL,
      secret text DEFAULT 'PRIVATE_SENTINEL');
    CREATE TABLE public.db_fixed (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL,
      fixed text DEFAULT 'Fixed');
    CREATE TABLE public.db_local (tenant_id text NOT NULL, local_id integer NOT NULL, name text,
      PRIMARY KEY (tenant_id, local_id));
    CREATE TABLE public.db_parent (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.db_child (id text PRIMARY KEY, tenant_id text NOT NULL,
      parent_id text NOT NULL REFERENCES public.db_parent(id), name text NOT NULL);
    CREATE TABLE public.db_country (code text PRIMARY KEY, name text);`,
};
const ROWS = `
    INSERT INTO db_item VALUES ('existing','north','same-business','Original',NULL),
      ('other','north','other','Other',''),('south-row','south','same-business','South',NULL),
      ('alias-row','North','same-business','Alias',NULL);
    INSERT INTO db_hidden (id,tenant_id,name) VALUES ('hidden-row','north','Hidden');
    INSERT INTO db_fixed (id,tenant_id,name) VALUES ('fixed-row','north','Fixed row');
    INSERT INTO db_local VALUES ('north',1,'North local'),('south',1,'South local');
    INSERT INTO db_parent VALUES ('north-parent','north','North parent'),('south-parent','south','South parent');
    INSERT INTO db_child VALUES ('child-row','north','north-parent','Child');
    INSERT INTO db_country VALUES ('us','Global');`;

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `record_history_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const services: Service[] = [],
    sources: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    try {
      await Promise.all(services.map((service) => service.retire()));
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(binding);
  const maintenance = (run: (admin: TenantStoreAdministration) => Promise<void>) => engine.maintenance(binding, run);
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['editor'],
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
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(Object.entries(names).map(([logical, name]) => [logical, engine.id(name)]));
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: Object.fromEntries(
      Object.keys(resources).map((table) => [
        table,
        table === 'country' ? { kind: 'global', access: 'read-only' } : { kind: 'tenant', column: 'tenant_id' },
      ]),
    ),
  });
  const fields = Object.fromEntries(
    catalog.schema.tables.map((table) => {
      const ordinary = table.columns.filter((column) => column.name !== 'tenant_id').map((column) => column.name);
      return [table.id, { read: table.id === 'local' ? ['tenant_id', ...ordinary] : ordinary, write: ordinary }];
    }),
  );
  fields.hidden = { read: ['id', 'name'], write: ['id', 'name'] };
  fields.fixed = { read: ['id', 'name', 'fixed'], write: ['id', 'name'] };
  const app = parseAppConfig(
    {
      id: binding.appId,
      name: 'Record history fixture',
      sources: { business: { connection: binding.source.connection } },
      resources: Object.fromEntries(
        Object.entries(resources).map(([name, physical]) => [
          name,
          // A text rule, so a record the App's rules refuse is one this fixture can write.
          { physical, access: 'write', fields: fields[name], ...(name === 'item' ? { text: { name: { pattern: '^[^!]*$' } } } : {}) },
        ]),
      ),
      auth: { roles: { editor: { read: true, write: true }, viewer: { read: true }, admin: { read: true, write: true } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
    },
    'record history test',
  );
  let time = 1000,
    identity: Identity | null = { id: 'alice', who: 'Alice', role: 'admin' };
  const rows: RowScope = Object.fromEntries(Object.keys(resources).map((table) => [table, true]));
  const issue = async (overrides: Partial<Options> = {}) => {
    const reader = await engine.openRead(ownership, binding, () => time);
    sources.push(reader);
    const writer = await engine.openWrite(ownership, binding, () => time);
    sources.push(writer);
    const service = createTenantRecordHistory<Request>({
      app,
      reader,
      writer,
      deployment: 'deployment-1',
      roles: ['editor', 'viewer', 'admin'],
      maxLifetimeMs: 5000,
      now: () => time,
      verifySession: (input) => (input.cookie === 'session' ? identity : null),
      resolveMembershipRows: () => rows,
      resolveRows: () => rows,
      authorizeDeletedRecord: () => true,
      ...overrides,
    });
    services.push(service);
    return service;
  };
  return {
    engine,
    dialect,
    app,
    rows,
    issue,
    maintenance,
    grant,
    row: async (id = 'existing', table = 'db_item') => plain((await engine.get(`SELECT * FROM ${table} WHERE id=?`, [id])) ?? null),
    setIdentity: (value: Identity | null) => {
      identity = value;
    },
    setTime: (value: number) => {
      time = value;
    },
  };
}

type Operation = 'insert' | 'remove' | 'undo creation' | 'undo deletion';
async function prepare(service: Service, operation: Operation): Promise<() => Promise<unknown>> {
  if (operation === 'insert') return () => service.insert(request, north, insert());
  if (operation === 'remove') return () => service.remove(request, north, remove());
  const id = token(
    operation === 'undo creation' ? await service.insert(request, north, insert()) : await service.remove(request, north, remove()),
  );
  return () => service.undo(request, north, { expectedId: id });
}
const subject = (operation: Operation) => (operation === 'insert' || operation === 'undo creation' ? 'created' : 'existing');
const existsAfter = (operation: Operation) => operation === 'insert' || operation === 'undo deletion';

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`tenant record history on ${dialect}`, { skip }, () => {
    test('one opaque stack interleaves create, update and delete with exact reverse order and managed owner restoration', async (t) => {
      const f = await fixture(t, dialect),
        service = await f.issue();
      assert.ok(Object.isFrozen(service));
      assert.deepEqual(Object.keys(service).sort(), [
        'importRows',
        'insert',
        'preview',
        'previewRemove',
        'remove',
        'retire',
        'undo',
        'update',
      ]);
      const created = await service.insert(request, north, insert()),
        createId = token(created);
      assert.deepEqual(plain(created.result.key), { id: 'created' });
      assert.equal(created.result.row?.tenant_id, undefined);
      assert.deepEqual(plain(created.result.sql), { text: '', params: [] });
      const updateId = token(await service.update(request, north, { table: 'item', key: { id: 'created' }, values: { name: 'Edited' } }));
      const deleted = await service.remove(request, north, remove('created')),
        deleteId = token(deleted);
      assert.deepEqual(plain(deleted.result), { affected: 1 });
      assert.equal(await f.row('created'), null);
      const preview = await service.preview(request, north);
      assert.equal(preview.next?.id, deleteId);
      assert.doesNotMatch(JSON.stringify(preview), /tenant_id|db_item|PRIVATE_SENTINEL|business_id|Edited|before|after/);
      await assert.rejects(service.undo(request, north, { expectedId: createId }), safe('not_applied'));
      assert.equal((await service.undo(request, north, { expectedId: deleteId })).outcome, 'applied');
      assert.equal((await f.row('created'))!.tenant_id, 'north');
      assert.equal((await f.row('created'))!.name, 'Edited');
      assert.equal((await service.preview(request, north)).next?.id, updateId);
      await service.undo(request, north, { expectedId: updateId });
      assert.equal((await f.row('created'))!.name, 'Created');
      assert.equal((await service.preview(request, north)).next?.id, createId);
      await service.undo(request, north, { expectedId: createId });
      assert.equal(await f.row('created'), null);
      assert.deepEqual(plain(await service.preview(request, north)), { writes: [] });
      assert.equal((await f.row('south-row'))!.name, 'South');
      assert.equal((await f.row('alias-row'))!.name, 'Alias');
    });

    test('native async deleted policy gets detached full private owner image, not a client projection or mutation handle', async (t) => {
      const f = await fixture(t, dialect);
      const seen: TenantHistoryImage[] = [];
      const service = await f.issue({
        authorizeDeletedRecord: async (principal, image) => {
          seen.push(image);
          return principal.tenantId === 'north' && image.row.tenant_id === 'north';
        },
      });
      const deleted = await service.remove(request, north, remove());
      assert.ok(seen.length > 0);
      for (const image of seen) {
        assert.deepEqual(Object.keys(image).sort(), ['key', 'row', 'table']);
        assert.ok(Object.isFrozen(image));
        assert.ok(Object.isFrozen(image.row));
        assert.equal(image.table, 'item');
        assert.equal(image.row.tenant_id, 'north');
        assert.equal(image.row.name, 'Original');
        assert.equal(Reflect.set(image.row, 'name', 'Forged'), false);
      }
      await service.undo(request, north, { expectedId: token(deleted) });
      assert.equal((await f.row())!.name, 'Original');
    });

    for (const mode of ['no policy', 'false policy', 'hidden normal field', 'nonwritable normal field', 'inbound foreign key'] as const) {
      test(`${mode}: ordinary projected creation succeeds with a value-free barrier while deletion is denied`, async (t) => {
        const f = await fixture(t, dialect),
          service = await f.issue(
            mode === 'no policy'
              ? { authorizeDeletedRecord: undefined }
              : mode === 'false policy'
                ? { authorizeDeletedRecord: () => false }
                : {},
          );
        const older = token(await service.update(request, north, { table: 'item', key: { id: 'existing' }, values: { name: 'Older' } }));
        const table =
          mode === 'hidden normal field'
            ? 'hidden'
            : mode === 'nonwritable normal field'
              ? 'fixed'
              : mode === 'inbound foreign key'
                ? 'parent'
                : 'item';
        const created = await service.insert(
          request,
          north,
          table === 'item' ? insert() : { table, values: { id: 'created', name: 'Created' } },
        );
        assert.equal(created.undoId, undefined);
        assert.equal(created.result.row?.name, 'Created');
        assert.equal(created.result.row?.tenant_id, undefined);
        assert.equal(created.result.row?.secret, undefined);
        assert.equal((await f.row('created', names[table]))!.tenant_id, 'north');
        const preview = await service.preview(request, north);
        assert.equal(preview.next, undefined);
        assert.equal(preview.writes[0].blocksUndo, true);
        assert.equal(preview.writes[0].kind, 'insert');
        assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_SENTINEL|tenant_id|db_|Created/);
        await assert.rejects(service.undo(request, north, { expectedId: older }), safe('not_applied'));
        await assert.rejects(service.remove(request, north, remove('created', table)), safe('not_applied'));
        assert.equal((await f.row('created', names[table]))!.name, 'Created');
      });
    }

    for (const kind of ['insert', 'delete'] as const) {
      test(`${kind} historical policy revocation blocks disclosure and inverse; missing row is no substitute for permission`, async (t) => {
        const f = await fixture(t, dialect);
        let allowed = true;
        const service = await f.issue({ authorizeDeletedRecord: () => allowed });
        const result = kind === 'insert' ? await service.insert(request, north, insert()) : await service.remove(request, north, remove());
        const id = token(result);
        allowed = false;
        assert.deepEqual(plain(await service.preview(request, north)), { writes: [] });
        await assert.rejects(service.undo(request, north, { expectedId: id }), safe('not_applied'));
        assert.equal(Boolean(await f.row(kind === 'insert' ? 'created' : 'existing')), kind === 'insert');
        allowed = true;
        assert.equal((await service.preview(request, north)).next?.id, id);
        await service.undo(request, north, { expectedId: id });
      });
    }

    test('a newer deleted image denied by policy blocks an otherwise visible older update', async (t) => {
      const f = await fixture(t, dialect);
      let denied = false;
      const service = await f.issue({ authorizeDeletedRecord: (_principal, image) => !denied || image.key.id !== 'other' });
      const older = token(await service.update(request, north, { table: 'item', key: { id: 'existing' }, values: { name: 'Older' } }));
      const deleted = token(await service.remove(request, north, remove('other')));
      denied = true;
      assert.deepEqual(plain(await service.preview(request, north)), { writes: [] });
      for (const expectedId of [older, deleted]) await assert.rejects(service.undo(request, north, { expectedId }), safe('not_applied'));
      assert.equal(await f.row('other'), null);
      assert.equal((await f.row())!.name, 'Older');
    });

    for (const foreign of ['tenant', 'account', 'membership version', 'membership role'] as const) {
      test(`deleted history cannot be replayed under another ${foreign}`, async (t) => {
        const f = await fixture(t, dialect),
          service = await f.issue();
        const id = token(await service.remove(request, north, remove()));
        if (foreign === 'account') f.setIdentity({ id: 'bob', who: 'Bob', role: 'admin' });
        if (foreign === 'membership version' || foreign === 'membership role')
          await f.maintenance((admin) =>
            admin.putMembership({ ...f.grant, roles: foreign === 'membership role' ? ['viewer'] : ['editor'], expectedVersion: '1' }),
          );
        const selectors = foreign === 'tenant' ? ['south'] : north;
        assert.deepEqual(plain(await service.preview(request, selectors)), { writes: [] });
        await assert.rejects(service.undo(request, selectors, { expectedId: id }), safe('not_applied'));
        assert.equal(await f.row(), null);
        assert.equal((await f.row('south-row'))!.name, 'South');
      });
    }

    test('both tenants can have mixed history without foreign tokens aliasing their own newest deletion', async (t) => {
      const f = await fixture(t, dialect),
        service = await f.issue();
      const n = token(await service.remove(request, north, remove()));
      const s = token(await service.remove(request, ['south'], remove('south-row')));
      assert.notEqual(n, s);
      await assert.rejects(service.undo(request, north, { expectedId: s }), safe('not_applied'));
      await assert.rejects(service.undo(request, ['south'], { expectedId: n }), safe('not_applied'));
      await service.undo(request, north, { expectedId: n });
      assert.equal((await f.row())!.tenant_id, 'north');
      assert.equal(await f.row('south-row'), null);
      await service.undo(request, ['south'], { expectedId: s });
      assert.equal((await f.row('south-row'))!.tenant_id, 'south');
    });

    for (const [column, value] of [
      ['name', 'CREATED'],
      ['note', ''],
    ] as const) {
      test(`creation Undo compares full stored ${column}, rejecting a collation/null-equivalent outside edit`, async (t) => {
        const f = await fixture(t, dialect),
          service = await f.issue();
        const id = token(await service.insert(request, north, insert()));
        await f.engine.exec(`UPDATE db_item SET ${column}=? WHERE id='created'`, [value]);
        await assert.rejects(service.undo(request, north, { expectedId: id }), safe('not_applied'));
        assert.equal((await f.row('created'))![column], value);
        assert.equal((await service.preview(request, north)).next?.id, id, 'failed inverse keeps the canonical history');
        await f.engine.exec(`UPDATE db_item SET ${column}=? WHERE id='created'`, [column === 'name' ? 'Created' : null]);
        await service.undo(request, north, { expectedId: id });
        assert.equal(await f.row('created'), null);
      });
    }

    for (const owner of ['north', 'south'] as const) {
      test(`restore never replaces an occupied opaque key, including a ${owner} row invisible to the deleted image`, async (t) => {
        const f = await fixture(t, dialect),
          service = await f.issue();
        const id = token(await service.remove(request, north, remove()));
        await f.engine.exec('INSERT INTO db_item (id,tenant_id,business_id,name) VALUES (?,?,?,?)', [
          'existing',
          owner,
          'replacement-business',
          'Replacement',
        ]);
        await assert.rejects(service.undo(request, north, { expectedId: id }), safe('not_applied'));
        assert.equal((await f.row())!.name, 'Replacement');
        assert.equal((await f.row())!.tenant_id, owner);
        await f.engine.exec("DELETE FROM db_item WHERE id='existing'");
        await service.undo(request, north, { expectedId: id });
        assert.equal((await f.row())!.name, 'Original');
        assert.equal((await f.row())!.tenant_id, 'north');
      });
    }

    test('restore refuses a different row occupying the historical tenant-local unique business key', async (t) => {
      const f = await fixture(t, dialect),
        service = await f.issue();
      const id = token(await service.remove(request, north, remove()));
      await f.engine.exec("INSERT INTO db_item VALUES ('replacement','north','same-business','Replacement',NULL)");
      await assert.rejects(service.undo(request, north, { expectedId: id }), safe('not_applied'));
      assert.equal(await f.row(), null);
      assert.equal((await f.row('replacement'))!.name, 'Replacement');
      await f.engine.exec("DELETE FROM db_item WHERE id='replacement'");
      await service.undo(request, north, { expectedId: id });
      assert.equal((await f.row())!.business_id, 'same-business');
    });

    for (const parent of ['missing', 'cross-tenant', 'policy hidden'] as const) {
      test(`deleted child restore rechecks its ${parent} parent under current tenant and row policy`, async (t) => {
        const f = await fixture(t, dialect);
        let hidden = false;
        const service = await f.issue({ resolveRows: () => ({ ...f.rows, parent: !hidden }) });
        const id = token(await service.remove(request, north, remove('child-row', 'child')));
        if (parent === 'missing') await f.engine.exec("DELETE FROM db_parent WHERE id='north-parent'");
        if (parent === 'cross-tenant') await f.engine.exec("UPDATE db_parent SET tenant_id='south' WHERE id='north-parent'");
        if (parent === 'policy hidden') hidden = true;
        await assert.rejects(service.undo(request, north, { expectedId: id }), safe('not_applied'));
        assert.equal(await f.row('child-row', 'db_child'), null);
        if (parent === 'missing') await f.engine.exec("INSERT INTO db_parent VALUES ('north-parent','north','North parent')");
        if (parent === 'cross-tenant') await f.engine.exec("UPDATE db_parent SET tenant_id='north' WHERE id='north-parent'");
        hidden = false;
        await service.undo(request, north, { expectedId: id });
        assert.equal((await f.row('child-row', 'db_child'))!.parent_id, 'north-parent');
      });
    }

    test('complete readable composite owner keys restore through managed injection, not ordinary owner write permission', async (t) => {
      const f = await fixture(t, dialect),
        service = await f.issue();
      const id = token(await service.remove(request, north, { table: 'local', key: { tenant_id: 'north', local_id: 1 } }));
      await service.undo(request, north, { expectedId: id });
      assert.deepEqual(plain(await f.engine.all('SELECT * FROM db_local ORDER BY tenant_id')), [
        { tenant_id: 'north', local_id: 1, name: 'North local' },
        { tenant_id: 'south', local_id: 1, name: 'South local' },
      ]);
      await assert.rejects(
        service.remove(request, north, { table: 'local', key: { tenant_id: 'North', local_id: 1 } }),
        safe('not_applied'),
      );
    });

    test('forged owner/restore images, cross-tenant keys and unscoped resources never acquire inverse authority', async (t) => {
      const f = await fixture(t, dialect),
        service = await f.issue();
      for (const input of [
        { ...insert(), values: { ...insert().values, tenant_id: 'north' } },
        { ...insert(), row: { tenant_id: 'north' } },
        { table: 'country', values: { code: 'ca', name: 'Canada' } },
      ]) {
        await assert.rejects(service.insert(request, north, input as InsertRequest), safe('not_applied'));
      }
      for (const input of [
        remove('south-row'),
        remove('alias-row'),
        { ...remove(), row: { name: 'Forged' } },
        { ...remove(), expected: { name: 'Original' } },
        { table: 'country', key: { code: 'us' } },
        { table: '__mistri_tenant_membership', key: { id: 'north-alice' } },
      ]) {
        await assert.rejects(service.remove(request, north, input as DeleteRequest), safe('not_applied'));
      }
      assert.equal((await f.row())!.name, 'Original');
      assert.equal(await f.row('created'), null);
      assert.deepEqual(plain(await service.preview(request, north)), { writes: [] });
    });

    for (const result of ['true', 1, null, {}]) {
      test(`deleted policy result ${JSON.stringify(result)} is not a strict boolean and rolls back accepted create/delete`, async (t) => {
        const f = await fixture(t, dialect);
        const service = await f.issue({ authorizeDeletedRecord: (() => result) as unknown as TenantDeletedRecordPolicy });
        await assert.rejects(service.insert(request, north, insert()), safe('not_applied'));
        await assert.rejects(service.remove(request, north, remove()), safe('not_applied'));
        assert.equal(await f.row('created'), null);
        assert.equal((await f.row())!.name, 'Original');
        assert.deepEqual(plain(await service.preview(request, north)), { writes: [] });
      });
    }

    test('custom policy thenables are not assimilated and cannot leave a partial creation', async (t) => {
      const f = await fixture(t, dialect);
      let calls = 0;
      const thenable = Object.create(null);
      Reflect.set(thenable, 'then', () => {
        calls++;
      });
      const service = await f.issue({ authorizeDeletedRecord: () => thenable });
      await assert.rejects(service.insert(request, north, insert()), safe('not_applied'));
      assert.equal(calls, 0);
      assert.equal(await f.row('created'), null);
    });

    test('native async policy rejection after creation rolls back the row and reports only a safe refusal', async (t) => {
      const f = await fixture(t, dialect),
        service = await f.issue({
          authorizeDeletedRecord: async () => {
            throw new Error('PRIVATE_SENTINEL');
          },
        });
      await assert.rejects(service.insert(request, north, insert()), safe('not_applied'));
      assert.equal(await f.row('created'), null);
      assert.deepEqual(plain(await service.preview(request, north)), { writes: [] });
    });

    test("the App's rules refusing the record say its fields, by name and fixed sentence only", async (t) => {
      const f = await fixture(t, dialect),
        service = await f.issue();
      await assert.rejects(service.insert(request, north, insert('created', 'PRIVATE_SENTINEL!')), (error) => {
        assert.ok(error instanceof TenantWriteFailure);
        assert.equal(error.outcome, 'not_applied');
        assert.deepEqual(plain(error.fields), [{ field: 'name', message: 'This value does not meet the application rules.' }]);
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_SENTINEL/);
        return true;
      });
      assert.equal(await f.row('created'), null);
    });

    for (const operation of ['remove', 'restore'] as const) {
      test(`policy changes at ${operation} post-effect check roll back and retain canonical history`, async (t) => {
        const f = await fixture(t, dialect);
        let armed = false,
          calls = 0;
        const service = await f.issue({ authorizeDeletedRecord: () => !armed || ++calls < (operation === 'remove' ? 2 : 3) });
        let id: string | undefined;
        if (operation === 'restore') id = token(await service.remove(request, north, remove()));
        armed = true;
        await assert.rejects(
          operation === 'remove' ? service.remove(request, north, remove()) : service.undo(request, north, { expectedId: id! }),
          safe('not_applied'),
        );
        assert.equal(calls, operation === 'remove' ? 2 : 3);
        assert.equal(Boolean(await f.row()), operation === 'remove');
        armed = false;
        if (operation === 'restore') {
          assert.equal((await service.preview(request, north)).next?.id, id);
          await service.undo(request, north, { expectedId: id! });
          assert.equal((await f.row())!.name, 'Original');
        } else assert.deepEqual(plain(await service.preview(request, north)), { writes: [] });
      });
    }

    test('pending native policy captures deletion input and full image; session change before release rolls back', async (t) => {
      const f = await fixture(t, dialect),
        entered = gate(),
        released = gate();
      let observed: TenantHistoryImage | undefined;
      const service = await f.issue({
        authorizeDeletedRecord: async (_principal, image) => {
          observed = image;
          entered.release();
          await released.promise;
          return true;
        },
      });
      const input = remove(),
        selectors = ['north'];
      const running = assert.rejects(service.remove(request, selectors, input), safe('not_applied'));
      await entered.promise;
      input.key.id = 'south-row';
      selectors[0] = 'south';
      f.setIdentity({ id: 'bob', who: 'Bob' });
      assert.equal(observed!.row.tenant_id, 'north');
      assert.equal(observed!.key.id, 'existing');
      assert.equal(Reflect.set(observed!.row, 'name', 'Forged'), false);
      released.release();
      await running;
      assert.equal((await f.row())!.name, 'Original');
      assert.equal((await f.row('south-row'))!.name, 'South');
    });

    for (const operation of ['insert', 'remove', 'undo creation', 'undo deletion'] as const) {
      for (const executed of [false, true]) {
        test(`${operation} COMMIT ${executed ? 'lost acknowledgment' : 'before execution'} never becomes not_applied or retries an inverse`, async (t) => {
          const f = await fixture(t, dialect),
            service = await f.issue(),
            run = await prepare(service, operation);
          const fault = f.engine.intercept(t, {
            match: (statement) => statement.writer && statement.sql === 'COMMIT',
            fault: executed ? 'after' : 'before',
          });
          try {
            await assert.rejects(run(), safe('unknown'));
          } finally {
            fault.restore();
          }
          assert.equal(fault.calls, 1);
          assert.equal(Boolean(await f.row(subject(operation))), executed ? existsAfter(operation) : !existsAfter(operation));
          await assert.rejects(service.insert(request, north, insert('never-retry')), safe('not_applied'));
          assert.equal(await f.row('never-retry'), null);
        });
      }
    }

    for (const executed of [false, true]) {
      test(`restore conflict plus ROLLBACK ${executed ? 'lost acknowledgment' : 'before execution'} stays unknown without replacing an occupied row`, async (t) => {
        const f = await fixture(t, dialect),
          service = await f.issue(),
          run = await prepare(service, 'undo deletion');
        await f.engine.exec("INSERT INTO db_item VALUES ('existing','south','replacement','Replacement',NULL)");
        const fault = f.engine.intercept(t, {
          match: (statement) => statement.writer && statement.sql === 'ROLLBACK',
          fault: executed ? 'after' : 'before',
        });
        try {
          await assert.rejects(run(), safe('unknown'));
        } finally {
          fault.restore();
        }
        assert.equal(fault.calls, 1);
        assert.equal((await f.row())!.name, 'Replacement');
        assert.equal((await f.row())!.tenant_id, 'south');
      });
    }

    for (const operation of ['insert', 'remove', 'undo creation', 'undo deletion'] as const) {
      test(`${operation} loses session after confirmed commit: output is unknown and history cannot fall through`, async (t) => {
        const f = await fixture(t, dialect);
        let armed = false,
          refused = false;
        const service = await f.issue({
          verifySession: async () => {
            if (armed && !refused && Boolean(await f.row(subject(operation))) === existsAfter(operation)) {
              refused = true;
              return null;
            }
            return { id: 'alice', who: 'Alice' };
          },
        });
        const older = token(await service.update(request, north, { table: 'item', key: { id: 'other' }, values: { name: 'Older' } }));
        const run = await prepare(service, operation);
        armed = true;
        await assert.rejects(run(), safe('unknown'));
        assert.equal(refused, true);
        assert.equal(Boolean(await f.row(subject(operation))), existsAfter(operation));
        const preview = await service.preview(request, north);
        assert.equal(preview.next, undefined);
        if (operation === 'undo creation') {
          // The inverse removed this row, so its original creation image is no
          // longer visible. Its retained entry must still hide the older update.
          assert.deepEqual(plain(preview), { writes: [] });
          await assert.rejects(service.undo(request, north, { expectedId: older }), safe('not_applied'));
          assert.equal((await f.row('other'))!.name, 'Older');
        } else {
          assert.ok(preview.writes.length > 0, 'unknown commit did not forget its stack barrier');
          assert.equal(preview.writes[0].undoState, 'unknown');
        }
        assert.doesNotMatch(JSON.stringify(preview), /tenant_id|db_item|PRIVATE_SENTINEL/);
      });
    }

    for (const operation of ['insert', 'remove'] as const) {
      test(`${operation} double publication failure after COMMIT quarantines the mixed stack, not another tenant`, async (t) => {
        const f = await fixture(t, dialect),
          service = await f.issue();
        await service.update(request, north, { table: 'item', key: { id: 'other' }, values: { name: 'Older' } });
        const south = token(await service.remove(request, ['south'], remove('south-row')));
        // Publication runs after the writer's actual COMMIT; observe that, not a read.
        let committed = false;
        const commits = f.engine.intercept(t, {
          match: (statement) => statement.writer && statement.sql === 'COMMIT',
          after: () => {
            committed = true;
          },
        });
        const original = Date.prototype.toISOString;
        let faults = 0;
        const mocked = t.mock.method(Date.prototype, 'toISOString', function (this: Date) {
          if (!committed) return original.call(this);
          faults++;
          throw new Error('PRIVATE_SENTINEL');
        });
        try {
          await assert.rejects(
            operation === 'insert' ? service.insert(request, north, insert()) : service.remove(request, north, remove()),
            safe('unknown'),
          );
        } finally {
          mocked.mock.restore();
          commits.restore();
        }
        assert.equal(faults, 2);
        assert.equal(Boolean(await f.row(subject(operation))), existsAfter(operation));
        const preview = await service.preview(request, north);
        assert.equal(preview.next, undefined);
        assert.equal(preview.writes[0].undoState, 'unknown');
        assert.equal((await service.preview(request, ['south'])).next?.id, south);
      });
    }

    test('retirement drains a pending deleted policy and denies both new record operations without partial effects', async (t) => {
      const f = await fixture(t, dialect),
        entered = gate(),
        released = gate();
      let retired = false;
      const service = await f.issue({
        authorizeDeletedRecord: async () => {
          entered.release();
          await released.promise;
          return true;
        },
      });
      const running = assert.rejects(service.remove(request, north, remove()), safe('not_applied'));
      await entered.promise;
      const retirement = service.retire();
      void retirement.then(() => {
        retired = true;
      });
      assert.equal(service.retire(), retirement);
      try {
        await assert.rejects(service.insert(request, north, insert()), safe('not_applied'));
        await assert.rejects(service.remove(request, north, remove()), safe('not_applied'));
        assert.equal(retired, false);
      } finally {
        released.release();
      }
      await running;
      await retirement;
      assert.equal(retired, true);
      assert.equal((await f.row())!.name, 'Original');
    });
  });
