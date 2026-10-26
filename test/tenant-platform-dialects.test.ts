/**
 * The platform realm's store, sources and fence as a dialect matrix: SQLite
 * always, PostgreSQL live-gated (support/tenantDialects.ts). The engines
 * differ where they honestly do: SQLite's BEGIN IMMEDIATE makes a concurrent
 * platform revocation fail as locked; PostgreSQL's row-lock fence on the
 * `@platform` row makes it wait for the platform command's commit, and makes
 * a platform command wait for a revocation that locked the row first.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { type StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { PlatformMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantPlatform.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { TENANT_TABLES, type TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TenantWriteFailure, type TenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const owner = { appId: 'lending', source: { id: 'business', connection: 'owned-business' }, storeId: 'platform-fixture' };
const SCHEMA = {
  tables: ['db_review', 'db_lead', 'db_dealer'],
  sqlite: `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;
    CREATE TABLE db_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES db_dealer(id), name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE db_review (id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES db_lead(id), note TEXT);`,
  postgres: `
    CREATE TABLE public.db_dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.db_lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.db_dealer(id), name text NOT NULL,
      status text NOT NULL DEFAULT 'open');
    CREATE TABLE public.db_review (id text PRIMARY KEY, lead_id text NOT NULL REFERENCES public.db_lead(id), note text);`,
};
const ROWS = `
    INSERT INTO db_dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO db_lead VALUES ('n1', 'north', 'North lead', 'open'), ('s1', 'south', 'South lead', 'open');`;
const platformRows = { dealer: true, lead: true, review_file: true };
const refused = (error: unknown) => error instanceof TenantWriteFailure && error.outcome === 'not_applied';
/** Whether a promise settles within the window; one waiting on a lock does not. */
async function settles(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(ms).then(() => false),
  ]);
}
const receipt = (id: string): StoredCommandReceipt => ({
  id,
  appId: owner.appId,
  actorId: 'lee',
  commandId: 'approve',
  commandVersion: 1,
  idempotencyKey: `${id}-key`,
  fingerprint: 'fingerprint',
  resultJson: '{}',
  requestId: 'request',
  completedAt: '2026-09-12T12:00:00.000Z',
});

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `platform_dialects_${randomUUID().replaceAll('-', '')}`;
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
  const sources: Array<TenantReadSource | TenantWriteSource> = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  await engine.migrateCommandJournal();
  const maintenance = (run: (admin: TenantStoreAdministration) => Promise<void>) => engine.maintenance(owner, run);
  const grant = { status: 'active' as const, roles: ['manager'], validUntil: 10_000, expectedVersion: null };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'alice', membershipId: 'north-alice', roles: ['staff'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee' });
  });
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(
    [
      ['dealer', 'db_dealer'],
      ['lead', 'db_lead'],
      ['review_file', 'db_review'],
    ].map(([logical, name]) => [logical, engine.id(name)]),
  );
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' }, review_file: { kind: 'platform' } },
    profile: 'dealer',
  });
  const reader = await engine.openRead(ownership, owner, () => 1000);
  sources.push(reader);
  const writer = await engine.openWrite(ownership, owner, () => 1000);
  sources.push(writer);
  const platformEvidence = async (): Promise<PlatformMembershipEvidence> => {
    const lookup = { realm: 'platform' as const, appId: owner.appId, accountId: 'lee', source: owner.source, deployment: 'deployment-1' };
    const record = await reader.readPlatformMembership(lookup);
    assert.ok(record);
    return {
      ...lookup,
      membershipId: record.membershipId,
      membershipVersion: record.membershipVersion,
      platformVersion: record.platformVersion,
      roles: [...record.roles],
      verifiedAt: 1000,
      validUntil: 6000,
    };
  };
  const tenantEvidence = async (): Promise<TenantMembershipEvidence> => {
    const lookup = { appId: owner.appId, source: owner.source, accountId: 'alice', tenantId: 'north', deployment: 'deployment-1' };
    const record = await engine.readMembership(owner, lookup);
    assert.ok(record);
    return {
      ...lookup,
      membershipId: record.membershipId,
      membershipVersion: record.membershipVersion,
      tenantVersion: record.tenantVersion,
      roles: [...record.roles],
      verifiedAt: 1000,
      validUntil: 6000,
    };
  };
  const status = async (id: string) => (await engine.get('SELECT status FROM db_lead WHERE id = ?', [id]))!.status;
  return { engine, reader, writer, maintenance, platformEvidence, tenantEvidence, status };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`the platform realm on ${dialect}`, { skip }, () => {
    const postgres = dialect === 'postgres';
    const revokePlatform = `UPDATE "${TENANT_TABLES.membership}" SET status = 'revoked', version = '2' WHERE id = 'platform-lee'`;

    test('store v2 keeps the platform row and its memberships out of every tenant path', async (t) => {
      const f = await fixture(t, dialect);
      assert.deepEqual(await f.engine.all(`SELECT id, kind FROM "${TENANT_TABLES.tenant}" ORDER BY id`), [
        { id: '@platform', kind: 'platform' },
        { id: 'north', kind: 'tenant' },
        { id: 'south', kind: 'tenant' },
      ]);
      // Discovery lists tenants only, so the platform member holds none.
      assert.deepEqual(
        [...(await f.reader.readMemberships({ appId: owner.appId, accountId: 'lee', source: owner.source, deployment: 'deployment-1' }))],
        [],
      );
      // The reserved row is never a tenant: no tenant change names it, and the store's CHECK refuses a forged kind.
      await assert.rejects(f.maintenance((admin) => admin.putTenant({ tenantId: '@platform', status: 'suspended', expectedVersion: '1' })));
      await assert.rejects(
        f.engine.exec(`INSERT INTO "${TENANT_TABLES.tenant}" (id, status, version, kind) VALUES ('west', 'active', '1', 'platform')`),
      );
    });

    test("the platform scope reads every tenant's rows, and a tenant's scope none of the platform's", async (t) => {
      const f = await fixture(t, dialect);
      const lender = await f.reader.scopePlatformReads(await f.platformEvidence(), platformRows);
      assert.deepEqual(
        (await lender.query({ table: 'lead', limit: 10, offset: 0, orderBy: [{ column: 'id', direction: 'asc' }] })).rows.map(
          (row) => row.id,
        ),
        ['n1', 's1'],
      );
      const dealer = await f.reader.scopeReads(await f.tenantEvidence(), platformRows);
      assert.deepEqual(
        (await dealer.query({ table: 'lead', limit: 10, offset: 0 })).rows.map((row) => row.id),
        ['n1'],
      );
      // The source holds the platform table's scope false, so none of it reads;
      // a tenant context also leaves the table out of its schema altogether.
      assert.deepEqual([...(await dealer.query({ table: 'dealer', limit: 10, offset: 0 })).rows], []);
    });

    /* bindPlatformReads is scopePlatformReads without the snapshot that checks
     the membership first, as bindReads is for a tenant. What must not change
     is that no row is read on evidence the reading snapshot did not find
     current. */
    test('bindPlatformReads opens no snapshot, reads what scopePlatformReads reads, and every read revalidates the membership', async (t) => {
      const f = await fixture(t, dialect),
        evidence = await f.platformEvidence();
      const seen: string[] = [];
      const watch = f.engine.intercept(t, {
        match: (statement) => {
          seen.push(statement.sql);
          return false;
        },
      });
      const lazy = await f.reader.bindPlatformReads(evidence, platformRows);
      assert.equal(seen.length, 0, 'binding reads nothing');
      watch.restore();
      const eager = await f.reader.scopePlatformReads(evidence, platformRows);
      const request = { table: 'lead', limit: 10, offset: 0, orderBy: [{ column: 'id', direction: 'asc' as const }] };
      assert.deepEqual((await lazy.query(request)).rows, (await eager.query(request)).rows);
      assert.deepEqual(
        (await lazy.query(request)).rows.map((row) => row.id),
        ['n1', 's1'],
        'across every tenant',
      );
      // Bound on a membership that is then revoked: the next read refuses.
      await f.engine.exec(revokePlatform);
      await assert.rejects(lazy.count('lead'));
      await assert.rejects(lazy.query(request));
      // Bound on evidence already stale: the reader is handed out, and reads nothing.
      const stale = await f.reader.bindPlatformReads(evidence, platformRows);
      await assert.rejects(stale.count('lead'));
    });

    test("a platform command transaction updates a dealer's row and files its own, journaled in the platform realm", async (t) => {
      const f = await fixture(t, dialect),
        evidence = await f.platformEvidence();
      await f.writer.platformCommandTransaction(evidence, platformRows, async (tx, receipts) => {
        await tx.update({ table: 'lead', key: { id: 'n1' }, values: { status: 'approved' } });
        await tx.insert({ table: 'review_file', values: { id: 'rv1', lead_id: 'n1', note: 'Approved' } });
        await receipts.commit(receipt('approve-n1'), { target: 'lead', keyJson: '{"id":"n1"}', changesJson: '[]', owner: 'north' });
      });
      assert.equal(await f.status('n1'), 'approved');
      assert.deepEqual(
        await f.engine.all(`SELECT realm, tenant_id, owner_tenant_id, realm_version FROM ${auditRows(f.engine.dialect)} a`),
        [{ realm: 'platform', tenant_id: '', owner_tenant_id: 'north', realm_version: '1' }],
      );
      // Never a dealer's row placed, reassigned or removed, and each realm's evidence only through its own method.
      for (const attempt of [
        () =>
          f.writer.platformCommandTransaction(evidence, platformRows, (tx) =>
            tx.insert({ table: 'lead', values: { id: 'n2', name: 'Planted' } }),
          ),
        () =>
          f.writer.platformCommandTransaction(evidence, platformRows, (tx) =>
            tx.update({ table: 'lead', key: { id: 's1' }, values: { tenant_id: 'north' } }),
          ),
        () => f.writer.platformCommandTransaction(evidence, platformRows, (tx) => tx.remove({ table: 'lead', key: { id: 's1' } })),
        () => f.writer.commandTransaction(evidence as never, platformRows, () => undefined),
        async () => f.writer.platformCommandTransaction((await f.tenantEvidence()) as never, platformRows, () => undefined),
      ])
        await assert.rejects(attempt(), refused);
      assert.deepEqual(await f.engine.all('SELECT id, tenant_id FROM db_lead ORDER BY id'), [
        { id: 'n1', tenant_id: 'north' },
        { id: 's1', tenant_id: 'south' },
      ]);
    });

    /* The platform realm's ordinary transaction, under its generic edit. The layer beneath the edit's
       access refuses on its own whatever a caller asks of it: a tenant's row, the profile's birth or end, and any
       key or a column another row's key names. */
    test("a platform edit's transaction writes the platform's own rows alone, never a tenant's, the profile's birth or end, or a key", async (t) => {
      const f = await fixture(t, dialect),
        evidence = await f.platformEvidence();
      await f.writer.platformTransaction(evidence, platformRows, async (tx) => {
        await tx.update({ table: 'dealer', key: { id: 'north' }, values: { name: 'North Motors Ltd' } });
        await tx.insert({ table: 'review_file', values: { id: 'rv1', lead_id: 'n1', note: 'Filed' } });
        await tx.update({ table: 'review_file', key: { id: 'rv1' }, values: { note: 'Refiled' } });
      });
      assert.deepEqual(await f.engine.all("SELECT name FROM db_dealer WHERE id = 'north'"), [{ name: 'North Motors Ltd' }]);
      assert.deepEqual(await f.engine.all('SELECT id, note FROM db_review'), [{ id: 'rv1', note: 'Refiled' }]);
      // No journal is ever handed out, and no receipt is kept.
      assert.deepEqual(await f.engine.all(`SELECT realm FROM ${auditRows(f.engine.dialect)} a`), []);
      for (const attempt of [
        // A tenant's row: no update, insert or removal, as a command's could.
        (tx: WriteTransaction): Promise<unknown> => tx.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Edited' } }),
        (tx: WriteTransaction): Promise<unknown> => tx.insert({ table: 'lead', values: { id: 'n2', tenant_id: 'north', name: 'Planted' } }),
        (tx: WriteTransaction): Promise<unknown> => tx.remove({ table: 'lead', key: { id: 's1' } }),
        // The profile: never made or ended here, and its key — every tenant row's owner — never moved.
        (tx: WriteTransaction): Promise<unknown> => tx.insert({ table: 'dealer', values: { id: 'west', name: 'West' } }),
        (tx: WriteTransaction): Promise<unknown> => tx.remove({ table: 'dealer', key: { id: 'south' } }),
        (tx: WriteTransaction): Promise<unknown> => tx.update({ table: 'dealer', key: { id: 'south' }, values: { id: 'east' } }),
        // A platform row's own key moves with a command only.
        (tx: WriteTransaction): Promise<unknown> => tx.update({ table: 'review_file', key: { id: 'rv1' }, values: { id: 'rv2' } }),
      ])
        await assert.rejects(
          f.writer.platformTransaction(evidence, platformRows, (tx) => attempt(tx)),
          refused,
        );
      // A tenant's evidence never enters the platform's transaction.
      await assert.rejects(
        f.writer.platformTransaction((await f.tenantEvidence()) as never, platformRows, () => undefined),
        refused,
      );
      assert.deepEqual(await f.engine.all('SELECT id, tenant_id, name FROM db_lead ORDER BY id'), [
        { id: 'n1', tenant_id: 'north', name: 'North lead' },
        { id: 's1', tenant_id: 'south', name: 'South lead' },
      ]);
      assert.deepEqual(await f.engine.all('SELECT id FROM db_dealer ORDER BY id'), [{ id: 'north' }, { id: 'south' }]);
      assert.deepEqual(await f.engine.all('SELECT id FROM db_review'), [{ id: 'rv1' }]);
    });

    test(
      postgres
        ? "a platform edit holds another connection's revocation until it commits, and the revoked evidence then writes nothing"
        : 'a platform edit blocks another connection revoking its member until commit, and the revoked evidence then writes nothing',
      async (t) => {
        const f = await fixture(t, dialect),
          evidence = await f.platformEvidence();
        const rename = (name: string) => (tx: WriteTransaction) => tx.update({ table: 'dealer', key: { id: 'south' }, values: { name } });
        if (postgres) {
          const session = await f.engine.session();
          let revoking: Promise<unknown> | undefined;
          await f.writer.platformTransaction(evidence, platformRows, async (tx) => {
            await rename('South Auto Group')(tx);
            revoking = session.query(revokePlatform);
            assert.equal(await settles(revoking), false, 'the revocation waits for the edit to commit');
          });
          await revoking;
        } else {
          let blocked: unknown;
          await f.writer.platformTransaction(evidence, platformRows, async (tx) => {
            await rename('South Auto Group')(tx);
            try {
              f.engine.sqlite().prepare(revokePlatform).run();
            } catch (error) {
              blocked = error;
            }
          });
          assert.ok(blocked instanceof Error);
          assert.match(blocked.message, /locked/);
          f.engine.sqlite().prepare(revokePlatform).run();
        }
        await assert.rejects(
          f.writer.platformTransaction(evidence, platformRows, (tx) => rename('Too late')(tx)),
          refused,
        );
        assert.deepEqual(await f.engine.all("SELECT name FROM db_dealer WHERE id = 'south'"), [{ name: 'South Auto Group' }]);
      },
    );

    test("a dealer's own write sees its profile row through the ownership column, and no other row of the platform realm", async (t) => {
      const f = await fixture(t, dialect),
        evidence = await f.tenantEvidence();
      const seen = await f.writer.transaction(evidence, platformRows, async (tx) => {
        await tx.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Renamed' } });
        return (await tx.query({ table: 'dealer', limit: 5, offset: 0 })).rows.map((row) => row.id);
      });
      assert.deepEqual(seen, ['north']);
      assert.equal((await f.engine.get('SELECT name FROM db_lead WHERE id = ?', ['n1']))!.name, 'Renamed');
    });

    test(
      postgres
        ? "the platform fence holds another connection's revocation until the platform command commits"
        : 'the BEGIN IMMEDIATE writer blocks another connection revoking a platform member until commit',
      async (t) => {
        const f = await fixture(t, dialect),
          evidence = await f.platformEvidence();
        if (postgres) {
          const session = await f.engine.session();
          let revoking: Promise<unknown> | undefined;
          await f.writer.platformCommandTransaction(evidence, platformRows, async (tx) => {
            await tx.update({ table: 'lead', key: { id: 's1' }, values: { status: 'approved' } });
            revoking = session.query(revokePlatform);
            assert.equal(await settles(revoking), false, 'the revocation waits for the platform commit');
          });
          await revoking;
        } else {
          let blocked: unknown;
          await f.writer.platformCommandTransaction(evidence, platformRows, async (tx) => {
            await tx.update({ table: 'lead', key: { id: 's1' }, values: { status: 'approved' } });
            try {
              f.engine.sqlite().prepare(revokePlatform).run();
            } catch (error) {
              blocked = error;
            }
          });
          assert.ok(blocked instanceof Error);
          assert.match(blocked.message, /locked/);
          f.engine.sqlite().prepare(revokePlatform).run();
        }
        assert.equal(await f.status('s1'), 'approved');
        // The committed revocation refuses the evidence it outlived.
        await assert.rejects(
          f.writer.platformCommandTransaction(evidence, platformRows, (tx) =>
            tx.update({ table: 'lead', key: { id: 'n1' }, values: { status: 'late' } }),
          ),
          refused,
        );
        assert.equal(await f.status('n1'), 'open');
      },
    );

    test('a revocation that locked @platform first commits first, and the queued platform command refuses without entering', async (t) => {
      const f = await fixture(t, dialect),
        evidence = await f.platformEvidence();
      let entered = false;
      if (postgres) {
        const session = await f.engine.session();
        await session.query('BEGIN');
        await session.query(`SELECT 1 FROM "${TENANT_TABLES.tenant}" WHERE id = '@platform' FOR UPDATE`);
        await session.query(revokePlatform);
        const rejected = assert.rejects(
          f.writer.platformCommandTransaction(evidence, platformRows, () => {
            entered = true;
          }),
          refused,
        );
        await delay(100);
        await session.query('COMMIT');
        await rejected;
      } else {
        // The source queues at once but cannot BEGIN until this turn ends; the
        // revocation commits first on the independent authoritative writer.
        const rejected = assert.rejects(
          f.writer.platformCommandTransaction(evidence, platformRows, () => {
            entered = true;
          }),
          refused,
        );
        f.engine.sqlite().prepare(revokePlatform).run();
        await rejected;
      }
      assert.equal(entered, false);
    });
  });
