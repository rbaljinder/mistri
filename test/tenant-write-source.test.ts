/**
 * The tenant write source, as a dialect matrix: SQLite always, PostgreSQL
 * live-gated by TABLEWALK_TEST_PG (support/tenantDialects.ts). The engines
 * differ where they honestly do: SQLite's BEGIN IMMEDIATE makes a concurrent
 * revocation fail as locked, PostgreSQL's row-lock fence makes it wait for
 * the business commit; and each attests uniqueness from its own catalog.
 */
import { databaseUnanswered, denyTenantFor, refusalCause, TenantUnavailableError } from '../packages/engine/src/server/evidence.js';
import { PoolBusy } from '../packages/engine/src/adapters/poolMetrics.js';
import { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { pausedTenantWriters } from '../packages/mistri/src/server/tenant/tenantWriterHealth.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Filter, QueryRequest, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { TENANT_TABLES, type TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  captureTenantWriteSource,
  openSqliteTenantWriteSource,
  TenantWriteFailure,
  type TenantWriteSource,
} from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import {
  CASE_INSENSITIVE,
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  TENANT_DIALECTS,
  type TenantDialect,
} from './support/tenantDialects.js';

const secret = 'PRIVATE_TENANT_WRITE_SENTINEL';
const owner = { appId: 'write-app', source: { id: 'business', connection: 'owned-business' }, storeId: 'write-fixture' };
const logicalTables = ['item', 'person', 'note', 'local', 'local_child', 'country'];
const allow: RowScope = Object.fromEntries(logicalTables.map((id) => [id, true]));
const query = (table = 'item', patch: Partial<QueryRequest> = {}): QueryRequest => ({ table, limit: 30, offset: 0, ...patch });
const equal = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const changed = { table: 'item', key: { id: 'north-row' }, values: { name: 'Changed' } };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
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

function safe(outcome: 'not_applied' | 'unknown') {
  return (error: unknown): boolean => {
    assert.ok(error instanceof TenantWriteFailure);
    assert.equal(error.code, 'tenant_write_unavailable');
    assert.equal(error.outcome, outcome);
    assert.equal(error.message, 'The tenant write could not be completed.');
    assert.equal('cause' in error, false);
    for (const hidden of [secret, 'db_item', 'north-alice', 'owned-business']) {
      assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(hidden), false);
    }
    return true;
  };
}

function frozen(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}

/* The same rows on both engines. On SQLite the ownership columns fold case
   (NOCASE) or padding (RTRIM), and tenant-local uniqueness is declared
   COLLATE BINARY; PostgreSQL's plain text columns are byte-exact already. */
const SCHEMA = {
  tables: ['db_local_child', 'db_local', 'db_note', 'db_item', 'db_person', 'db_country'],
  sqlite: `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;
    CREATE TABLE db_country (code TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_person (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE RTRIM NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL DEFAULT 'south',
      person_id TEXT REFERENCES db_person(id), name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0,
      UNIQUE (tenant_id COLLATE BINARY, name));
    CREATE TABLE db_note (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL,
      item_id TEXT REFERENCES db_item(id) ON DELETE CASCADE, body TEXT NOT NULL DEFAULT 'Note');
    CREATE TABLE db_local (tenant_id TEXT NOT NULL, local_id INTEGER NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY (tenant_id, local_id));
    CREATE TABLE db_local_child (tenant_id TEXT NOT NULL, local_id INTEGER NOT NULL, parent_id INTEGER,
      name TEXT NOT NULL, PRIMARY KEY (tenant_id, local_id),
      FOREIGN KEY (tenant_id, parent_id) REFERENCES db_local(tenant_id, local_id));`,
  postgres: `
    CREATE TABLE public.db_country (code text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.db_person (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.db_item (id text PRIMARY KEY, tenant_id text NOT NULL DEFAULT 'south',
      person_id text REFERENCES public.db_person(id), name text NOT NULL, quantity integer NOT NULL DEFAULT 0,
      UNIQUE (tenant_id, name));
    CREATE TABLE public.db_note (id text PRIMARY KEY, tenant_id text NOT NULL,
      item_id text REFERENCES public.db_item(id) ON DELETE CASCADE, body text NOT NULL DEFAULT 'Note');
    CREATE TABLE public.db_local (tenant_id text NOT NULL, local_id integer NOT NULL, name text NOT NULL,
      PRIMARY KEY (tenant_id, local_id));
    CREATE TABLE public.db_local_child (tenant_id text NOT NULL, local_id integer NOT NULL, parent_id integer,
      name text NOT NULL, PRIMARY KEY (tenant_id, local_id),
      FOREIGN KEY (tenant_id, parent_id) REFERENCES public.db_local(tenant_id, local_id));`,
};
const ROWS = `
    INSERT INTO db_country VALUES ('us', 'Global');
    INSERT INTO db_person VALUES ('north-row', 'north', 'North'), ('south-row', 'south', 'South'),
      ('case-row', 'North', 'Case alias'), ('padded-row', 'north ', 'Padding alias');
    INSERT INTO db_item VALUES ('north-row', 'north', 'north-row', 'Original', 0), ('south-row', 'south', 'south-row', 'Other tenant', 0),
      ('case-row', 'North', 'case-row', 'Case item', 0), ('padded-row', 'north ', 'padded-row', 'Padding item', 0),
      ('bad-parent-row', 'north', 'south-row', 'Invalid stored parent', 0);
    INSERT INTO db_note VALUES ('north-row', 'north', 'north-row', 'Original note'), ('south-row', 'south', 'south-row', 'Other note');
    INSERT INTO db_local VALUES ('north', 1, 'North local'), ('south', 1, 'South local'), ('south', 2, 'South only');
    INSERT INTO db_local_child VALUES ('north', 1, 1, 'North child'), ('south', 1, 1, 'South child');`;

/* This suite's own PostgreSQL database, beside the server's: a run of it next
   to another must not have its fixture tables reset under it. */
const DATABASE = `write_source_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext, dialect: TenantDialect, beforeCapture?: string) {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const sources: TenantWriteSource[] = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  const maintenance = (run: (admin: TenantStoreAdministration) => Promise<void>) => engine.maintenance(owner, run);
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['editor'],
    validUntil: 10_000,
    expectedVersion: null,
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({ ...grant, tenantId, membershipId: `${tenantId}-alice` });
    }
  });
  if (beforeCapture) await engine.exec(beforeCapture);
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(
    [
      ['item', 'db_item'],
      ['person', 'db_person'],
      ['note', 'db_note'],
      ['local', 'db_local'],
      ['local_child', 'db_local_child'],
      ['country', 'db_country'],
    ].map(([logical, name]) => [logical, engine.id(name)]),
  );
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      person: { kind: 'tenant', column: 'tenant_id' },
      note: { kind: 'tenant', column: 'tenant_id' },
      local: { kind: 'tenant', column: 'tenant_id' },
      local_child: { kind: 'tenant', column: 'tenant_id' },
      country: { kind: 'global', access: 'read-only' },
    },
  });
  let time = 1000;
  const evidence = async (tenantId = 'north'): Promise<TenantMembershipEvidence> => {
    // Actual persisted membership evidence, obtained before the write. It is
    // host data, not an authentication or transaction-outcome wrapper.
    const lookup = { appId: owner.appId, source: owner.source, accountId: 'alice', tenantId, deployment: 'deployment-1' };
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
  const open = async (now: () => number = () => time, expected: TenantOwnershipSnapshot = ownership) => {
    const source = await engine.openWrite(expected, owner, now);
    sources.push(source);
    return source;
  };
  const name = async () => (await engine.get('SELECT name FROM db_item WHERE id = ?', ['north-row']))!.name;
  const count = async (sql: string, params?: unknown[]) =>
    Number((await engine.get(`SELECT CAST(count(*) AS INTEGER) AS n FROM ${sql}`, params))?.n);
  return {
    engine,
    dialect,
    ownership,
    open,
    evidence,
    maintenance,
    grant,
    name,
    count,
    setTime: (value: number) => {
      time = value;
    },
    revoke: () => maintenance((admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
  };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`tenant write source on ${dialect}`, { skip }, () => {
    const postgres = dialect === 'postgres';
    const revokeRaw = `UPDATE "${TENANT_TABLES.membership}" SET status = 'revoked', version = '2' WHERE id = 'north-alice'`;

    test('genuine frozen source exposes only managed transactions and ownership, not raw writer authority', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      assert.equal(captureTenantWriteSource(source), source);
      /* `supportTransaction` and `supportCommandTransaction` (0.5.0): an
       operator inside a dealer writes through its own kind, which records
       every row it changes in the same transaction. `platformTenantCommandTransaction`
       (1.0, G1): a platform command acting in one named tenant, on its own kind. */
      assert.deepEqual(Reflect.ownKeys(source).sort(), [
        'close',
        'commandTransaction',
        // The notice-mail outbox (claim, settle, a recipient's switch): a queue, not a writer of tenant rows.
        'inboxMail',
        'intakeCommandTransaction',
        'markInboxRead',
        'ownership',
        'platformCommandTransaction',
        'platformTenantCommandTransaction',
        'platformTransaction',
        'serviceCommandTransaction',
        'supportCommandTransaction',
        'supportTransaction',
        'transaction',
        'writeBranding',
      ]);
      frozen(source);
      let records!: WriteTransaction;
      await source.transaction(await f.evidence(), allow, (tx) => {
        records = tx;
        assert.deepEqual(Reflect.ownKeys(tx).sort(), ['count', 'insert', 'query', 'remove', 'update']);
        assert.ok(Object.isFrozen(tx));
      });
      await assert.rejects(records.count('item'));
      await assert.rejects(records.update(changed));
      assert.equal(await f.name(), 'Original');
    });

    test('lookalikes and proxies cannot forge source authority or execute inspection traps', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      let traps = 0;
      const proxy = new Proxy(source, {
        ownKeys: (target) => {
          traps++;
          return Reflect.ownKeys(target);
        },
      });
      for (const input of [{ ...source }, proxy]) assert.throws(() => captureTenantWriteSource(input));
      assert.equal(traps, 0);
      assert.equal(await source.transaction(await f.evidence(), allow, (tx) => tx.count('item')), 2);
    });

    test('all-true caller rows still bind exact tenants and ordinary CRUD shares the owned writer', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      const result = await source.transaction(await f.evidence(), allow, async (tx) => {
        assert.deepEqual(
          (await tx.query(query('item', { columns: ['id'], orderBy: [{ column: 'id', direction: 'asc' }] }))).rows.map((row) => row.id),
          ['bad-parent-row', 'north-row'],
        );
        assert.equal(await tx.count('country'), 1);
        const created = await tx.insert({ table: 'item', values: { id: 'created-row', person_id: 'north-row', name: 'Created' } });
        assert.equal(created.row?.tenant_id, 'north', 'a hostile SQL default cannot supply ownership');
        await tx.update({ table: 'item', key: { id: 'created-row' }, values: { quantity: 7 }, expected: { quantity: 0 } });
        assert.equal((await tx.query(query('item', { filter: equal('id', 'created-row') }))).rows[0].quantity, 7);
        await tx.insert({ table: 'note', values: { id: 'created-row', item_id: 'created-row', body: 'Temporary' } });
        assert.equal((await tx.remove({ table: 'note', key: { id: 'created-row' } })).affected, 1);
        return created.key;
      });
      assert.equal(result.id, 'created-row');
      assert.deepEqual(plain(await f.engine.get('SELECT tenant_id, quantity FROM db_item WHERE id = ?', ['created-row'])), {
        tenant_id: 'north',
        quantity: 7,
      });
      assert.equal(await f.count('db_note WHERE id = ?', ['created-row']), 0);
      assert.equal(await source.transaction(await f.evidence('south'), allow, (tx) => tx.count('item')), 1);
    });

    /* A generated column keeps its table a tenant's to write: the database computes it, the source reads it back,
       and a write that names it changes nothing. */
    test('a tenant table with a generated column is written around it and read with it', async (t) => {
      const f = await fixture(
          t,
          dialect,
          postgres
            ? 'ALTER TABLE public.db_item ADD COLUMN doubled integer GENERATED ALWAYS AS (quantity * 2) STORED'
            : 'ALTER TABLE db_item ADD COLUMN doubled INTEGER AS (quantity * 2)',
        ),
        source = await f.open();
      const item = f.ownership.schema.tables.find((table) => table.id === 'item')!;
      assert.equal(item.columns.find((column) => column.name === 'doubled')?.writable, false);
      await source.transaction(await f.evidence(), allow, async (tx) => {
        await tx.insert({ table: 'item', values: { id: 'computed-row', person_id: 'north-row', name: 'Computed', quantity: 4 } });
        await tx.update({ table: 'item', key: { id: 'computed-row' }, values: { quantity: 5 }, expected: { quantity: 4 } });
        assert.equal((await tx.query(query('item', { filter: equal('id', 'computed-row') }))).rows[0].doubled, 10);
      });
      await assert.rejects(
        source.transaction(await f.evidence(), allow, (tx) =>
          tx.update({ table: 'item', key: { id: 'computed-row' }, values: { doubled: 99 } }),
        ),
        // Refused as not applied on both engines: PostgreSQL's "can only be updated to DEFAULT" is no unknown outcome.
        (error) => error instanceof TenantWriteFailure && error.outcome === 'not_applied',
      );
      assert.deepEqual(plain(await f.engine.get('SELECT quantity, doubled FROM db_item WHERE id = ?', ['computed-row'])), {
        quantity: 5,
        doubled: 10,
      });
    });

    test('composite keys receive the server-owned tenant component and never select an equal local ID in another tenant', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      await source.transaction(await f.evidence(), allow, async (tx) => {
        await tx.update({ table: 'local_child', key: { local_id: 1 }, values: { name: 'North changed' } });
        await tx.insert({ table: 'local_child', values: { local_id: 2, parent_id: 1, name: 'New north child' } });
        await tx.remove({ table: 'local_child', key: { local_id: 2 } });
      });
      assert.deepEqual(plain(await f.engine.all('SELECT tenant_id, name FROM db_local_child ORDER BY tenant_id')), [
        { tenant_id: 'north', name: 'North changed' },
        { tenant_id: 'south', name: 'South child' },
      ]);
    });

    test('tenant-scoped business uniqueness permits the same business value in two tenants', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      for (const tenantId of ['north', 'south']) {
        await source.transaction(await f.evidence(tenantId), allow, (tx) =>
          tx.insert({ table: 'item', values: { id: `${tenantId}-duplicate-business`, name: 'Shared business name' } }),
        );
      }
      assert.deepEqual(
        plain(await f.engine.all('SELECT tenant_id FROM db_item WHERE name = ? ORDER BY tenant_id', ['Shared business name'])),
        [{ tenant_id: 'north' }, { tenant_id: 'south' }],
      );
    });

    for (const [label, ddl] of [
      ['global business uniqueness', 'CREATE UNIQUE INDEX global_business ON db_item(name)'],
      [
        'nonbinary tenant uniqueness',
        postgres
          ? `CREATE UNIQUE INDEX folded_tenant_business ON db_item(tenant_id COLLATE ${CASE_INSENSITIVE}, name)`
          : 'CREATE UNIQUE INDEX folded_tenant_business ON db_item(tenant_id, name)',
      ],
      ['global expression uniqueness', 'CREATE UNIQUE INDEX expression_business ON db_item(lower(name))'],
      [
        'integer auto primary key',
        postgres
          ? 'DROP TABLE db_note; CREATE TABLE db_note (id serial PRIMARY KEY, tenant_id text NOT NULL, body text NOT NULL)'
          : `DROP TABLE db_note; CREATE TABLE db_note (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, body TEXT NOT NULL)`,
      ],
      ...(postgres
        ? [
            [
              'exclusion constraint',
              'ALTER TABLE db_item ADD CONSTRAINT exclusive_name EXCLUDE USING btree (tenant_id WITH =, name WITH =)',
            ],
            ['case-folding opaque key', `ALTER TABLE db_note ALTER COLUMN id TYPE text COLLATE ${CASE_INSENSITIVE}`],
            ['case-folding ownership column', `ALTER TABLE db_note ALTER COLUMN tenant_id TYPE text COLLATE ${CASE_INSENSITIVE}`],
          ]
        : []),
    ] as const) {
      test(`${label} refuses source construction even with matching ownership metadata`, async (t) => {
        const f = await fixture(t, dialect, ddl);
        await assert.rejects(f.open(), safe('not_applied'));
        assert.equal(await f.name(), 'Original');
      });
    }

    for (const [label, violate] of [
      ['cross-tenant update key', (tx: WriteTransaction) => tx.update({ ...changed, key: { id: 'south-row' } })],
      ['NOCASE tenant alias key', (tx: WriteTransaction) => tx.update({ ...changed, key: { id: 'case-row' } })],
      ['padded tenant alias key', (tx: WriteTransaction) => tx.update({ ...changed, key: { id: 'padded-row' } })],
      ['absent update key', (tx: WriteTransaction) => tx.update({ ...changed, key: { id: 'absent-row' } })],
      ['cross-tenant delete key', (tx: WriteTransaction) => tx.remove({ table: 'note', key: { id: 'south-row' } })],
      [
        'same-tenant explicit insert ownership',
        (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 'created-row', tenant_id: 'north', name: 'Forged' } }),
      ],
      [
        'cross-tenant explicit insert ownership',
        (tx: WriteTransaction) => tx.insert({ table: 'item', values: { id: 'created-row', tenant_id: 'south', name: 'Forged' } }),
      ],
      ['same-tenant ownership update', (tx: WriteTransaction) => tx.update({ ...changed, values: { tenant_id: 'north' } })],
      ['cross-tenant ownership update', (tx: WriteTransaction) => tx.update({ ...changed, values: { tenant_id: 'south' } })],
      [
        'composite cross-tenant key',
        (tx: WriteTransaction) => tx.update({ table: 'local_child', key: { tenant_id: 'south', local_id: 1 }, values: { name: 'Forged' } }),
      ],
      ['ordinary primary key mutation', (tx: WriteTransaction) => tx.update({ ...changed, values: { id: 'moved-row' } })],
      ['unknown field', (tx: WriteTransaction) => tx.update({ ...changed, values: { unknown: secret } })],
      ['global insert', (tx: WriteTransaction) => tx.insert({ table: 'country', values: { code: 'ca', name: 'Forged' } })],
      ['global update', (tx: WriteTransaction) => tx.update({ table: 'country', key: { code: 'us' }, values: { name: 'Forged' } })],
      ['global delete', (tx: WriteTransaction) => tx.remove({ table: 'country', key: { code: 'us' } })],
      ['physical alias', (tx: WriteTransaction) => tx.update({ ...changed, table: 'db_item' })],
      ['private membership table', (tx: WriteTransaction) => tx.count(TENANT_TABLES.membership)],
      [
        'cross-tenant parent insert',
        (tx: WriteTransaction) =>
          tx.insert({ table: 'item', values: { id: 'created-row', person_id: 'south-row', name: 'Forbidden parent' } }),
      ],
      [
        'case-alias parent insert',
        (tx: WriteTransaction) =>
          tx.insert({ table: 'item', values: { id: 'created-row', person_id: 'case-row', name: 'Forbidden parent' } }),
      ],
      [
        'padded-alias parent insert',
        (tx: WriteTransaction) =>
          tx.insert({ table: 'item', values: { id: 'created-row', person_id: 'padded-row', name: 'Forbidden parent' } }),
      ],
      ['cross-tenant parent update', (tx: WriteTransaction) => tx.update({ ...changed, values: { person_id: 'south-row' } })],
      ['invalid current stored parent', (tx: WriteTransaction) => tx.update({ ...changed, key: { id: 'bad-parent-row' } })],
      [
        'composite foreign parent',
        (tx: WriteTransaction) => tx.insert({ table: 'local_child', values: { local_id: 3, parent_id: 2, name: 'Forbidden parent' } }),
      ],
      ['cascading parent delete', (tx: WriteTransaction) => tx.remove({ table: 'item', key: { id: 'north-row' } })],
      ...(postgres
        ? [['physical schema alias', (tx: WriteTransaction) => tx.update({ ...changed, table: 'public.db_item' })] as const]
        : []),
    ] as const) {
      test(`caught ${label} rolls back earlier writes`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open();
        let refused = false;
        await assert.rejects(
          source.transaction(await f.evidence(), allow, async (tx) => {
            await tx.update(changed);
            try {
              await violate(tx);
            } catch {
              refused = true;
            }
          }),
          safe('not_applied'),
        );
        // Keep assertions outside the sanitized callback to avoid false positives.
        assert.equal(refused, true);
        assert.equal(await f.name(), 'Original');
        assert.equal(await f.count('db_item WHERE id = ?', ['created-row']), 0);
      });
    }

    test('authored row ceilings remain mandatory on original and stored afterimage checks', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      await assert.rejects(
        source.transaction(await f.evidence(), { ...allow, item: equal('name', 'Original') }, (tx) => tx.update(changed)),
        safe('not_applied'),
      );
      assert.equal(await f.name(), 'Original');
      await assert.rejects(
        source.transaction(await f.evidence(), { ...allow, item: false }, (tx) => tx.update(changed)),
        safe('not_applied'),
      );
      await assert.rejects(
        source.transaction(await f.evidence(), {}, (tx) => tx.insert({ table: 'item', values: { id: 'created-row', name: 'Denied' } })),
        safe('not_applied'),
      );
    });

    test('a confirmed ordinary rollback keeps the pinned source usable for a later transaction', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence();
      await assert.rejects(
        source.transaction(evidence, allow, (tx) => tx.update({ ...changed, key: { id: 'absent-row' } })),
        safe('not_applied'),
      );
      await source.transaction(evidence, allow, (tx) => tx.update(changed));
      assert.equal(await f.name(), 'Changed');
    });

    for (const reason of [
      'revoked',
      'reinvited',
      'suspended',
      'membership version',
      'membership roles',
      'tenant version',
      'expired',
    ] as const) {
      test(`${reason} membership evidence refuses before the transaction callback`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        if (reason === 'revoked' || reason === 'reinvited') await f.revoke();
        if (reason === 'reinvited') await f.maintenance((admin) => admin.putMembership({ ...f.grant, membershipId: 'replacement-grant' }));
        if (reason === 'suspended')
          await f.maintenance((admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
        if (reason === 'membership version' || reason === 'membership roles') {
          await f.maintenance((admin) =>
            admin.putMembership({ ...f.grant, expectedVersion: '1', roles: reason === 'membership roles' ? ['other'] : ['editor'] }),
          );
        }
        if (reason === 'tenant version')
          await f.maintenance((admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '1' }));
        if (reason === 'expired') f.setTime(6000);
        let entered = false;
        await assert.rejects(
          source.transaction(evidence, allow, () => {
            entered = true;
          }),
          safe('not_applied'),
        );
        assert.equal(entered, false);
        assert.equal(await f.name(), 'Original');
      });
    }

    test(
      postgres
        ? "the writer fence holds another connection's revocation until the business commit"
        : 'the actual BEGIN IMMEDIATE writer blocks another connection revoking until commit',
      async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        if (postgres) {
          // The membership row is held FOR SHARE to COMMIT: the revocation waits, then lands.
          const session = await f.engine.session();
          let revoking: Promise<unknown> | undefined;
          await source.transaction(evidence, allow, async (tx) => {
            await tx.update(changed);
            revoking = session.query(revokeRaw);
            assert.equal(await settles(revoking), false, 'the revocation waits for the business commit');
          });
          await revoking;
        } else {
          let blocked: unknown;
          await source.transaction(evidence, allow, async (tx) => {
            await tx.update(changed);
            try {
              f.engine.sqlite().prepare(revokeRaw).run();
            } catch (error) {
              blocked = error;
            }
          });
          assert.ok(blocked instanceof Error);
          assert.match(blocked.message, /locked/);
        }
        assert.equal(await f.name(), 'Changed');
        if (!postgres) await f.revoke();
        await assert.rejects(
          source.transaction(evidence, allow, (tx) => tx.update({ ...changed, values: { name: 'Late' } })),
          safe('not_applied'),
        );
        assert.equal(await f.name(), 'Changed');
      },
    );

    test('revocation committed before queued writer acquisition refuses without callback entry', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence();
      let entered = false;
      if (postgres) {
        // A revocation holding the tenant row FOR UPDATE commits first; the
        // queued fence waits on that row, then rereads the membership and refuses.
        const session = await f.engine.session();
        await session.query('BEGIN');
        await session.query(`SELECT 1 FROM "${TENANT_TABLES.tenant}" WHERE id = 'north' FOR UPDATE`);
        await session.query(revokeRaw);
        const rejected = assert.rejects(
          source.transaction(evidence, allow, () => {
            entered = true;
          }),
          safe('not_applied'),
        );
        await delay(100);
        await session.query('COMMIT');
        await rejected;
      } else {
        // The source queues immediately but cannot enter its BEGIN until this turn
        // finishes; commit revocation first on the independent authoritative writer.
        const pending = source.transaction(evidence, allow, () => {
          entered = true;
        });
        const rejected = assert.rejects(pending, safe('not_applied'));
        f.engine.sqlite().prepare(revokeRaw).run();
        await rejected;
      }
      assert.equal(entered, false);
    });

    for (const phase of ['before operation', 'before commit'] as const) {
      for (const reason of ['expiry', 'lease refusal', 'close'] as const) {
        test(`${reason} ${phase} rolls back earlier writes`, async (t) => {
          const f = await fixture(t, dialect),
            source = await f.open(),
            evidence = await f.evidence();
          let active = true,
            closing: Promise<void> | undefined;
          await assert.rejects(
            source.transaction(
              evidence,
              allow,
              async (tx) => {
                await tx.update(changed);
                if (reason === 'expiry') f.setTime(6000);
                if (reason === 'lease refusal') active = false;
                if (reason === 'close') closing = source.close();
                if (phase === 'before operation') await tx.count('item');
              },
              () => {
                if (!active) throw new Error(secret);
              },
            ),
            safe('not_applied'),
          );
          await closing;
          assert.equal(await f.name(), 'Original');
        });
      }
    }

    test('expiry is checked after waiting for another accepted writer', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence(),
        entered = gate(),
        release = gate();
      const first = source.transaction(evidence, allow, async (tx) => {
        await tx.update(changed);
        entered.release();
        await release.promise;
      });
      const firstRejected = assert.rejects(first, safe('not_applied'));
      await entered.promise;
      let secondEntered = false;
      const secondRejected = assert.rejects(
        source.transaction(evidence, allow, () => {
          secondEntered = true;
        }),
        safe('not_applied'),
      );
      f.setTime(6000);
      release.release();
      await Promise.all([firstRejected, secondRejected]);
      assert.equal(secondEntered, false);
      assert.equal(await f.name(), 'Original');
    });

    test('queued evidence and row policies detach at transaction submission', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        entered = gate(),
        release = gate();
      const first = source.transaction(await f.evidence(), allow, async () => {
        entered.release();
        await release.promise;
      });
      await entered.promise;
      const evidence = { ...(await f.evidence()), roles: ['editor'] };
      const rows: Record<string, boolean | Filter> = { ...allow, item: equal('id', 'north-row') };
      const second = source.transaction(evidence, rows, async (tx) => {
        assert.deepEqual(
          (await tx.query(query('item'))).rows.map((row) => row.id),
          ['north-row'],
        );
        await tx.update(changed);
      });
      evidence.tenantId = 'south';
      evidence.roles.push('administrator');
      rows.item = true;
      release.release();
      await Promise.all([first, second]);
      assert.equal(await f.name(), 'Changed');
    });

    test('operation values and keys detach before queue waits', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      await source.transaction(await f.evidence(), allow, async (tx) => {
        const update = { table: 'item', key: { id: 'north-row' }, values: { name: 'Captured' } };
        const pending = tx.update(update);
        update.key.id = 'south-row';
        update.values.name = 'Mutated';
        await pending;
      });
      assert.equal(await f.name(), 'Captured');
      assert.equal((await f.engine.get('SELECT name FROM db_item WHERE id = ?', ['south-row']))!.name, 'Other tenant');
    });

    test('caught malformed input cannot commit a previous write or invoke getters', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      let accesses = 0,
        rejected = false;
      const malformed = {
        ...changed,
        values: Object.defineProperty({}, 'name', {
          enumerable: true,
          get: () => {
            accesses++;
            return secret;
          },
        }),
      };
      await assert.rejects(
        source.transaction(await f.evidence(), allow, async (tx) => {
          await tx.update(changed);
          try {
            await tx.update(malformed);
          } catch {
            rejected = true;
          }
        }),
        safe('not_applied'),
      );
      assert.equal(rejected, true);
      assert.equal(accesses, 0);
      assert.equal(await f.name(), 'Original');
    });

    test('unawaited successful operations drain before commit and retained handles cannot borrow the next transaction', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      let retained!: WriteTransaction;
      await source.transaction(await f.evidence(), allow, (tx) => {
        retained = tx;
        void tx.update(changed);
      });
      assert.equal(await f.name(), 'Changed');
      await source.transaction(await f.evidence('south'), allow, async (tx) => {
        await assert.rejects(retained.update({ ...changed, values: { name: 'Escaped' } }));
        assert.equal(await tx.count('item'), 1);
      });
      assert.equal(await f.name(), 'Changed');
    });

    test('unawaited failing operations poison callback success and drain before rollback', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      await assert.rejects(
        source.transaction(await f.evidence(), allow, (tx) => {
          void tx.update(changed);
          void tx.update({ ...changed, key: { id: 'south-row' } });
          return 'not a successful transaction';
        }),
        safe('not_applied'),
      );
      assert.equal(await f.name(), 'Original');
    });

    test('close stops acceptance synchronously and drains accepted callbacks before closing exactly once', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence(),
        entered = gate(),
        release = gate();
      const pending = source.transaction(evidence, allow, async (tx) => {
        await tx.update(changed);
        entered.release();
        await release.promise;
      });
      const rejected = assert.rejects(pending, safe('not_applied'));
      await entered.promise;
      let closed = false;
      const closing = source.close();
      assert.equal(source.close(), closing);
      void closing.then(() => {
        closed = true;
      });
      await assert.rejects(
        source.transaction(evidence, allow, () => {}),
        safe('not_applied'),
      );
      assert.equal(closed, false);
      release.release();
      await rejected;
      await closing;
      assert.equal(await f.name(), 'Original');
    });

    for (const boundary of ['COMMIT', 'ROLLBACK'] as const) {
      for (const timing of ['before execution', 'lost acknowledgement'] as const) {
        test(`${boundary} ${timing} remains unknown without disclosing private diagnostics`, async (t) => {
          const f = await fixture(t, dialect),
            source = await f.open(),
            evidence = await f.evidence();
          let armed = false;
          const fault = f.engine.intercept(t, {
            match: (statement) => armed && statement.sql === boundary,
            fault: timing === 'lost acknowledgement' ? 'after' : 'before',
          });
          try {
            await assert.rejects(
              source.transaction(evidence, allow, async (tx) => {
                await tx.update(changed);
                armed = true;
                if (boundary === 'ROLLBACK') throw new Error(secret);
              }),
              safe('unknown'),
            );
          } finally {
            fault.restore();
          }
          assert.ok(fault.calls > 0);
          assert.equal(await f.name(), boundary === 'COMMIT' && timing === 'lost acknowledgement' ? 'Changed' : 'Original');
          let entered = false;
          await assert.rejects(
            source.transaction(evidence, allow, () => {
              entered = true;
            }),
            safe('not_applied'),
          );
          assert.equal(entered, false, 'uncertainty retires the pinned source rather than lazily opening another writer');
        });
      }
    }

    test('pre-entry connection failure retires the source instead of reopening on the next request', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence();
      let entries = 0;
      const fault = f.engine.intercept(t, {
        match: (statement) => statement.sql.split(';', 1)[0].trim() === f.engine.begin,
        fault: 'before',
      });
      try {
        await assert.rejects(
          source.transaction(evidence, allow, () => {
            entries++;
          }),
          safe('not_applied'),
        );
      } finally {
        fault.restore();
      }
      assert.ok(fault.calls > 0, 'the actual writer BEGIN must encounter the injected fault');
      await assert.rejects(
        source.transaction(evidence, allow, () => {
          entries++;
        }),
        safe('not_applied'),
      );
      assert.equal(entries, 0);
      assert.equal(await f.name(), 'Original');
    });

    /* A field report: at twelve users on half a core the write pool's queue ran past
       two seconds, the checkout was refused as busy, and that pre-entry failure
       closed the writer like a lost COMMIT. Every write, inbox and live stream of
       the deployment then failed until it reopened, and again at the next busy
       moment. A refused checkout leased nothing: it is busy, and the writer stays. */
    test('a write the pool refused a connection for is busy, and the writer stays open', { skip: !postgres }, async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        evidence = await f.evidence();
      const proto = PgConnectionManager.prototype as unknown as {
        withClient(write: boolean, ...rest: unknown[]): Promise<unknown>;
      };
      const original = proto.withClient;
      let refused = 0;
      const busy = t.mock.method(proto, 'withClient', function (this: unknown, write: boolean, ...rest: unknown[]) {
        if (write && refused === 0) {
          refused++;
          return Promise.reject(new PoolBusy('write', 'queue_timeout'));
        }
        return original.call(this, write, ...rest);
      });
      await assert.rejects(
        source.transaction(evidence, allow, (tx) => tx.update(changed)),
        (error) => {
          safe('not_applied')(error);
          assert.ok(databaseUnanswered(error), 'said as the database not answering, not as a refusal');
          return true;
        },
      );
      busy.mock.restore();
      assert.equal(refused, 1);
      assert.deepEqual(pausedTenantWriters(), [], 'the writer stays open');
      await source.transaction(evidence, allow, (tx) => tx.update(changed));
      assert.equal(await f.name(), 'Changed');
    });

    /* A field report: pools sized past what the database role allows (53300, "too many connections for role"). The
       write pool's next connection was refused at open, before the verifier, and the writer closed as if the write's
       outcome were unknown, reopened into the same refusal and closed again: two commands in three failed at three
       users while its one connection sat idle. Refused at open, nothing was leased: the write goes on the connection
       the pool holds, and the writer stays open. */
    test(
      'a write the database refuses a new connection for runs on the one held, and the writer stays open',
      { skip: !postgres },
      async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        // The write pool holds a connection.
        await source.transaction(evidence, allow, (tx) => tx.update(changed));
        const lines: string[] = [];
        t.mock.method(console, 'error', (line: unknown) => {
          lines.push(String(line));
        });
        // The driver the pools load (postgresPool.ts), by a name the type checker does not resolve: pg ships no types.
        const driver = 'pg';
        const { default: pg } = (await import(driver)) as {
          default: {
            Pool: {
              prototype: {
                connect(this: { options: { min?: number } }): Promise<unknown>;
              };
            };
          };
        };
        const connect = pg.Pool.prototype.connect;
        let refused = 0;
        // The writer's pools keep no idle minimum (postgresPool.ts); the readers keep two.
        t.mock.method(pg.Pool.prototype, 'connect', function (this: { options: { min?: number } }) {
          if (this.options.min === 0 && refused === 0) {
            refused++;
            return Promise.reject(Object.assign(new Error('too many connections for role "app"'), { code: '53300', severity: 'FATAL' }));
          }
          return connect.call(this);
        });
        await source.transaction(evidence, allow, (tx) => tx.update(changed));
        assert.equal(refused, 1);
        assert.deepEqual(pausedTenantWriters(), [], 'the writer stays open');
        assert.match(lines.join('\n'), /connection limit reached: the app write pool holds 1 of \d+ connections/);
        await source.transaction(evidence, allow, (tx) => tx.update(changed));
        assert.equal(await f.name(), 'Changed');
      },
    );

    /* While a writer is closed, an inbox read still asks its outbox for the reader's
       email switch. That refusal carried a plain error beneath it and was answered
       403 "The tenant context could not be verified" (a field report: a third of
       inbox reads under load). It is the writer not answering: 503. */
    test("a closed writer's outbox refuses as unavailable, never as a denial", async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open();
      await source.close();
      for (const ask of [
        () => source.inboxMail.emailOff('write-app/north', 'alice'),
        () => source.inboxMail.dueInboxes('write-app', new Date().toISOString()),
      ]) {
        await assert.rejects(ask(), (error) => {
          safe('not_applied')(error);
          assert.ok(databaseUnanswered(error));
          assert.throws(() => denyTenantFor(error), TenantUnavailableError);
          return true;
        });
      }
    });

    test('different private callback failures project the same constant value-free failure', async (t) => {
      const f = await fixture(t, dialect),
        source = await f.open(),
        messages: string[] = [];
      for (const reason of [secret, 'another private provider reason']) {
        await assert.rejects(
          source.transaction(await f.evidence(), allow, async (tx) => {
            await tx.update(changed);
            throw Object.assign(new Error(reason), { privateRows: [{ value: secret }] });
          }),
          (error) => {
            safe('not_applied')(error);
            assert.ok(error instanceof TenantWriteFailure);
            messages.push(error.message);
            assert.equal('privateRows' in error, false);
            /* The caller's answer is the same constant either way — and the owner
           that has to diagnose it can still read which failure it was, from a
           record the refusal above proves is invisible to everyone else. */
            let cause: unknown = refusalCause(error),
              found = false;
            for (let depth = 0; cause && depth < 6; depth++) {
              found ||= String((cause as Error).message ?? '').includes(reason);
              cause = (cause as { cause?: unknown }).cause;
            }
            assert.ok(found, 'the writer dropped the reason it refused for');
            return true;
          },
        );
      }
      assert.equal(messages[0], messages[1]);
      assert.equal(await f.name(), 'Original');
    });

    for (const reason of ['close', 'lease refusal'] as const) {
      test(`successful COMMIT followed by late ${reason} is never classified not_applied`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        let armed = false,
          committed = false,
          active = true,
          closing: Promise<void> | undefined;
        const watch = f.engine.intercept(t, {
          match: (statement) => armed && statement.sql === 'COMMIT',
          after: () => {
            committed = true;
            if (reason === 'close') closing = source.close();
            else active = false;
          },
        });
        try {
          try {
            await source.transaction(
              evidence,
              allow,
              async (tx) => {
                await tx.update(changed);
                armed = true;
              },
              () => {
                if (!active) throw new Error(secret);
              },
            );
          } catch (error) {
            safe('unknown')(error);
          }
        } finally {
          watch.restore();
        }
        await closing;
        assert.equal(committed, true);
        assert.equal(await f.name(), 'Changed');
      });
    }

    if (!postgres)
      test('construction never creates a missing file', async (t) => {
        const f = await fixture(t, dialect),
          absent = join(f.engine.path, '..', 'absent.db');
        await assert.rejects(() => openSqliteTenantWriteSource(absent, f.ownership, owner, () => 1000));
        assert.equal(existsSync(absent), false);
      });

    test('construction never provisions a missing membership namespace', async (t) => {
      const f = await fixture(t, dialect);
      await f.engine.exec(
        `DROP TABLE "${TENANT_TABLES.membership}"; DROP TABLE "${TENANT_TABLES.tenant}"; DROP TABLE "${TENANT_TABLES.meta}";`,
      );
      await assert.rejects(() => f.open());
      assert.deepEqual(await f.engine.layout('__mistri_tenant_'), []);
    });

    for (const [label, ddl] of [
      ['column change', 'ALTER TABLE db_item ADD COLUMN extra TEXT'],
      ['index change', 'CREATE UNIQUE INDEX new_business_constraint ON db_item(name)'],
      [
        'new trigger',
        postgres
          ? 'CREATE TRIGGER item_effect AFTER UPDATE ON db_item FOR EACH ROW EXECUTE FUNCTION tablewalk_fixture_noop()'
          : "CREATE TRIGGER item_effect AFTER UPDATE ON db_item BEGIN UPDATE db_note SET body = 'side effect'; END",
      ],
      ...(postgres
        ? ([
            ['ownership collation', `ALTER TABLE db_item ALTER COLUMN tenant_id TYPE text COLLATE ${CASE_INSENSITIVE}`],
            ['row security', 'ALTER TABLE db_person ENABLE ROW LEVEL SECURITY'],
          ] as const)
        : []),
    ] as const) {
      test(`${label} after construction refuses actual writer attestation before the callback`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        await f.engine.exec(ddl);
        let entered = false;
        await assert.rejects(
          source.transaction(evidence, allow, () => {
            entered = true;
          }),
          safe('not_applied'),
        );
        assert.equal(entered, false);
        assert.equal(await f.name(), 'Original');
      });
    }

    /* The writer's attestation read the catalog in full on every write, eight
       round trips a transaction (a field report: the relation, index and role reads,
       thousands of runs each). Under the epoch of one that passed, read after
       the same pins, it stands; DDL moves the epoch, and the next write
       attests in full and refuses. */
    if (postgres)
      test('a write under an unchanged catalog attests nothing again, and the first write after DDL refuses', async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open(),
          evidence = await f.evidence();
        await source.transaction(evidence, allow, async (tx) => {
          await tx.update(changed);
        });
        const seen: string[] = [];
        const watch = f.engine.intercept(t, {
          match: (statement) => {
            seen.push(statement.sql);
            return false;
          },
        });
        try {
          await source.transaction(evidence, allow, async (tx) => {
            await tx.update({ ...changed, values: { name: 'Again' } });
          });
        } finally {
          watch.restore();
        }
        assert.ok(seen.length > 0, 'the write was seen');
        assert.deepEqual(
          // The message that begins it reads the epoch (here the digest, which names information_schema to leave it out).
          seen.filter(
            (sql) =>
              !sql.startsWith('BEGIN;') &&
              /^\s*WITH me AS|indisunique|relrowsecurity|SAVEPOINT mistri_tenant_store|information_schema/.test(sql),
          ),
          [],
          'no attestation read: the store, ownership, unique keys and relations stand under the epoch',
        );
        assert.equal(await f.name(), 'Again');
        await f.engine.exec('ALTER TABLE db_person ENABLE ROW LEVEL SECURITY');
        let entered = false;
        await assert.rejects(
          source.transaction(evidence, allow, () => {
            entered = true;
          }),
          safe('not_applied'),
        );
        assert.equal(entered, false);
      });

    for (const evidence of [null, undefined, [], 0, '']) {
      test(`non-record evidence ${JSON.stringify(evidence)} refuses safely before writer entry`, async (t) => {
        const f = await fixture(t, dialect),
          source = await f.open();
        let entered = false;
        await assert.rejects(
          source.transaction(evidence as never, allow, () => {
            entered = true;
          }),
          safe('not_applied'),
        );
        assert.equal(entered, false);
        await source.transaction(await f.evidence(), allow, async (tx) => {
          await tx.query({ table: 'item', limit: 1, offset: 0 });
        });
      });
    }
  });
