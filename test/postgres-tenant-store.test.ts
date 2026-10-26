/**
 * The tenant store, its membership fence and the administration journal on
 * PostgreSQL, against a real server.
 *
 * The SQLite suites (tenant-store*.test.ts, tenant-administration-journal.test.ts)
 * prove the contract on the engine that had it first. This file proves the
 * PostgreSQL store keeps it: an explicit, idempotent, versioned migration that
 * refuses a foreign layout or binding unchanged; drift refused at runtime;
 * byte-exact COLLATE "C" identity; the same CAS revisions and terminal
 * states; the membership fence composed with the adapter's verified scoped
 * transactions, ordering a revocation and a business commit in both
 * directions across two connections; and the administration journal's
 * receipts, audit and duplicate serialisation.
 *
 * Live and opt-in like postgres.test.ts: `TABLEWALK_TEST_PG` names a
 * disposable database this file may reset, and `TABLEWALK_REQUIRE_LIVE=1`
 * turns a missing server into a failure. Before each test it drops every
 * `__mistri_*` table in that database and its own fixtures, so point it at
 * nothing you keep. One case creates and drops a NOLOGIN role, so the role
 * needs CREATEROLE.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { Refusal, TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { runtimeName, runtimeSchema, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_JOURNAL_TABLES as journalTables } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { postgresAuditRows } from './support/commandTargets.js';
import type { CommandJournalTenant, StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import {
  describePostgresRelations,
  migratePostgresCommandJournal,
} from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import {
  ADMINISTRATION_JOURNAL_TABLES as adminTables,
  type AdministrationAudit,
  type AdministrationReceiptScope,
  type StoredAdministrationReceipt,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import {
  assertPostgresTenantAdministrationJournal,
  createPostgresTenantAdministrationJournal,
  migratePostgresTenantAdministrationJournal,
  TenantAdministrationJournalUnavailable,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { TenantStoreOfAnotherApp } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import type { TenantMembershipEvidence, TenantMembershipLookup } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import {
  TENANT_TABLES as tables,
  type MembershipChange,
  type TenantStoreAdministration,
  type TenantStoreBinding,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  assertPostgresTenantMembershipFence,
  assertPostgresTenantStore,
  createPostgresTenantAdministration,
  createPostgresTenantMembershipGuard,
  migratePostgresTenantStore,
  readPostgresTenantMembership,
  readPostgresTenantMemberships,
  TenantStoreUnavailable,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

/** Whether the live half runs: the skip decision, and nothing else. */
const LIVE = process.env.TABLEWALK_TEST_PG;
/* This file's RESET drops every reserved table in `public`, so it works in a
   database of this run's own, created and dropped by the hooks below. The role
   is named for this run too: roles are the server's, not a database's, so two
   runs would otherwise create and drop each other's. */
const FIXTURE_ID = randomUUID().replaceAll('-', '');
const DATABASE = `tw_tenant_store_${FIXTURE_ID}`;
let url: string;
const OTHER_ROLE = `mistri_tenant_store_other_${FIXTURE_ID}`;
const ITEM = 'public.tenant_item';
const m = runtimeTable('postgres', tables.membership),
  t = runtimeTable('postgres', tables.tenant),
  meta = runtimeTable('postgres', tables.meta);

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
/** This run's own database by default; the server's only for the hooks that
 * create and drop that database. */
async function client(target = url): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: target, statement_timeout: 10_000 });
  await created.connect();
  return created;
}

const owner = (): TenantStoreBinding => ({ appId: 'app', source: { id: 'business', connection: 'owned-business' }, storeId: 'store-1' });
const lookup = (patch: Partial<TenantMembershipLookup> = {}): TenantMembershipLookup => ({
  appId: 'app',
  accountId: 'alice',
  tenantId: 'north',
  source: owner().source,
  deployment: 'generation-1',
  ...patch,
});
const grant = (patch: Partial<MembershipChange> = {}): MembershipChange => ({
  tenantId: 'north',
  accountId: 'alice',
  membershipId: 'grant-1',
  status: 'active',
  roles: ['reviewer'],
  validUntil: 10_000,
  expectedVersion: null,
  ...patch,
});
const evidence = (patch: Partial<TenantMembershipEvidence> = {}): TenantMembershipEvidence => ({
  ...lookup(),
  membershipId: 'grant-1',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['reviewer'],
  verifiedAt: 50,
  validUntil: 5_000,
  ...patch,
});
const clock = () => 100;
const northRows = (): RowScope => ({ [ITEM]: { groups: [[{ column: 'tenant_id', op: '=', value: 'north' }]] } });
const fence =
  (value = evidence(), now = clock) =>
  (c: PgQuery) =>
    assertPostgresTenantMembershipFence(c, owner(), value, now);
const denied = (error: unknown) => {
  assert.ok(error instanceof TenantContextError, String(error));
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  return true;
};

/* Every reserved table (the store, the administration journal, the command
   journal) is in the runtime schema, so dropping it is all of them; and this file's own fixtures. */
const RESET = [
  `DROP SCHEMA IF EXISTS mistri CASCADE`,
  `DROP TABLE IF EXISTS ${ITEM} CASCADE`,
  `DROP SCHEMA IF EXISTS tenant_lookalike CASCADE`,
  `DROP FUNCTION IF EXISTS public.tenant_store_noop()`,
  `DROP ROLE IF EXISTS ${OTHER_ROLE}`,
];
const SETUP = [
  `CREATE TABLE ${ITEM} (id text PRIMARY KEY, tenant_id text COLLATE "C" NOT NULL, name text NOT NULL)`,
  `INSERT INTO ${ITEM} (id, tenant_id, name) VALUES ('north-1', 'north', 'North'), ('south-1', 'south', 'South')`,
];

/** Whether a promise settles within the window; a lock that holds does not. */
async function settles(promise: Promise<unknown>, ms = 400): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('the tenant store on PostgreSQL, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const extra: Control[] = [];
  const connection = async () => {
    const created = await client();
    extra.push(created);
    return created;
  };
  /** One owned transaction and queue, drained before COMMIT or ROLLBACK as the store requires. */
  const transaction = async <T>(c: PgQuery, work: (operations: TransactionOperations) => Promise<T>): Promise<T> => {
    await c.query('BEGIN');
    const operations = new TransactionOperations();
    try {
      const out = await work(operations);
      await operations.finish();
      await c.query('COMMIT');
      return out;
    } catch (error) {
      await operations.finish().catch(() => {});
      await c.query('ROLLBACK');
      throw error;
    }
  };
  const administer = (c: PgQuery, work: (admin: TenantStoreAdministration) => Promise<void>) =>
    transaction(c, (operations) => work(createPostgresTenantAdministration(c, operations, owner())));
  const seed = async () => {
    await migratePostgresTenantStore(url, owner());
    await administer(control, async (admin) => {
      await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
      await admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: null });
      await admin.putMembership(grant());
    });
  };
  const tenantRow = async (id: string) => (await control.query(`SELECT status, version FROM ${t} WHERE id = $1`, [id])).rows[0];
  const membershipRow = async (id = 'grant-1') =>
    (await control.query(`SELECT status, version, roles_json FROM ${m} WHERE id = $1`, [id])).rows[0];
  // The store and its administration journal, the two namespaces a migration here creates.
  const described = async (...prefixes: string[]) =>
    JSON.stringify(
      await Promise.all(
        (prefixes.length ? prefixes : ['__mistri_tenant_', '__mistri_admin_']).map((prefix) => describePostgresRelations(control, prefix)),
      ),
    );
  const itemName = async (id = 'north-1') => (await control.query(`SELECT name FROM ${ITEM} WHERE id = $1`, [id])).rows[0]?.name;
  const count = async (table: string) =>
    Number((await control.query(`SELECT count(*) AS n FROM ${runtimeTable('postgres', table)}`)).rows[0].n);

  before(async () => {
    const server = await client(LIVE!);
    try {
      await server.query(`CREATE DATABASE "${DATABASE}"`);
    } finally {
      await server.end();
    }
    const target = new URL(LIVE!);
    target.pathname = `/${DATABASE}`;
    url = target.href;
    control = await client();
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
    const server = await client(LIVE!);
    try {
      await server.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    } finally {
      await server.end();
    }
  });
  beforeEach(async () => {
    for (const statement of [...RESET, ...SETUP]) await control.query(statement);
  });
  afterEach(async () => {
    while (extra.length)
      await extra
        .pop()!
        .end()
        .catch(() => {});
  });

  test('migration creates the store once, idempotently, bound to one App, source and store', async () => {
    assert.deepEqual(await migratePostgresTenantStore(url, owner()), { version: 1, migrated: true });
    const created = await described();
    assert.deepEqual(await migratePostgresTenantStore(url, owner()), { version: 1, migrated: false });
    // The connection id is a transient alias, not stored identity, as on SQLite.
    assert.deepEqual(await migratePostgresTenantStore(url, { ...owner(), source: { id: 'business', connection: 'renamed' } }), {
      version: 1,
      migrated: false,
    });
    for (const other of [
      { ...owner(), storeId: 'other-store' },
      { ...owner(), appId: 'other-app' },
      { ...owner(), source: { id: 'other_source', connection: 'owned-business' } },
    ]) {
      // Another App's is said for what it is: one database holds one tenant App (tenantStoreContract.ts).
      await assert.rejects(
        migratePostgresTenantStore(url, other),
        other.appId === 'other-app'
          ? (error: Error) =>
              error instanceof TenantStoreOfAnotherApp && /belongs to the tenant App "app", not "other-app"/.test(error.message)
          : TenantStoreUnavailable,
      );
      await assert.rejects(
        transaction(control, () => assertPostgresTenantStore(control, other)),
        denied,
      );
    }
    assert.equal(await described(), created, 'a refused migration changes nothing');
    assert.deepEqual((await control.query(`SELECT * FROM ${meta}`)).rows, [
      { singleton: 1, version: 1, app_id: 'app', source_id: 'business', store_id: 'store-1' },
    ]);
    await transaction(control, () => assertPostgresTenantStore(control, owner()));
    await assert.rejects(assertPostgresTenantStore(control, owner()), denied, 'attestation outside a transaction refuses');
    await assert.rejects(migratePostgresTenantStore('sqlite:business.db', owner()), Refusal);
    await assert.rejects(migratePostgresTenantStore(url, { appId: 'app' } as never), Refusal);
  });

  test('the App catalog hides the reserved tables and scoped transactions refuse them', async () => {
    await seed();
    const adapter = new PostgresAdapter(url, 'tenant store proof', ['public']);
    try {
      const physical = await adapter.introspect();
      assert.ok(physical.tables.some((table) => table.name === 'tenant_item'));
      const app = createAppResources(adapter, physical);
      assert.deepEqual(
        app.schema.tables.filter(
          (table) => table.name.toLowerCase().startsWith('__mistri_') || table.id.startsWith(`${runtimeSchema('postgres')}.`),
        ),
        [],
      );
      for (const name of Object.values(tables)) {
        await assert.rejects(
          commandsOf(adapter).scopeCommandTransaction(
            { [`${runtimeSchema('postgres')}.${runtimeName('postgres', name)}`]: true },
            async () => {},
          ),
          /Reserved resources are runtime-only/,
        );
        await assert.rejects(
          adapter.scopeVerifiedTransaction(
            { [`${runtimeSchema('postgres')}.${runtimeName('postgres', name)}`]: true },
            fence(),
            async () => {},
          ),
          /This verified transaction is unavailable/,
        );
      }
    } finally {
      await adapter.close();
    }
  });

  for (const [label, prepare] of [
    ['a hand-made table under the prefix', ['CREATE SCHEMA IF NOT EXISTS mistri', `CREATE TABLE ${t} (id text PRIMARY KEY)`]],
    [
      'a look-alike in another case in the runtime schema',
      ['CREATE SCHEMA IF NOT EXISTS mistri', 'CREATE TABLE mistri."TENANT_Extra" (id text)'],
    ],
    ['the layout with an added column', ['migrate', `ALTER TABLE ${m} ADD COLUMN note text`]],
    [
      'the layout of another version',
      [
        'migrate',
        `ALTER TABLE ${meta} DROP CONSTRAINT "${runtimeName('postgres', tables.meta)}_version_check"`,
        `UPDATE ${meta} SET version = 2`,
        `ALTER TABLE ${meta} ADD CHECK (version = 2)`,
      ],
    ],
  ] as const) {
    test(`migration refuses ${label} unchanged`, async () => {
      for (const step of prepare) {
        if (step === 'migrate') await migratePostgresTenantStore(url, owner());
        else await control.query(step);
      }
      const before = await described();
      await assert.rejects(migratePostgresTenantStore(url, owner()), TenantStoreUnavailable);
      assert.equal(await described(), before);
    });
  }

  for (const [label, drift] of [
    ['an added column', [`ALTER TABLE ${m} ADD COLUMN note text`]],
    ['an added index', [`CREATE INDEX tenant_store_extra ON ${m} (account_id)`]],
    ['a dropped check', [`ALTER TABLE ${t} DROP CONSTRAINT "${runtimeName('postgres', tables.tenant)}_status_check"`]],
    ['a non-C identity collation', [`ALTER TABLE ${m} ALTER COLUMN account_id TYPE text COLLATE "default"`]],
    [
      'a trigger',
      [
        `CREATE FUNCTION public.tenant_store_noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
        `CREATE TRIGGER tenant_store_noop BEFORE UPDATE ON ${m} FOR EACH ROW EXECUTE FUNCTION public.tenant_store_noop()`,
      ],
    ],
    ['a rule', [`CREATE RULE tenant_store_rule AS ON UPDATE TO ${t} DO ALSO NOTIFY tenant_store`]],
    ['row security', [`ALTER TABLE ${m} ENABLE ROW LEVEL SECURITY`]],
    ['a policy', [`CREATE POLICY tenant_store_policy ON ${m} USING (true)`]],
    ['a rebound meta row', [`UPDATE ${meta} SET store_id = 'other-store'`]],
    ['a PUBLIC table grant', [`GRANT SELECT ON ${m} TO PUBLIC`]],
    ['a PUBLIC column grant', [`GRANT UPDATE (status) ON ${m} TO PUBLIC`]],
    ['a look-alike in another case', [`CREATE TABLE mistri."${runtimeName('postgres', tables.membership).toUpperCase()}" (id text)`]],
    ['another owner', [`CREATE ROLE ${OTHER_ROLE} NOLOGIN`, `ALTER TABLE ${m} OWNER TO ${OTHER_ROLE}`]],
  ] as const) {
    test(`${label} refuses the fence, the reader, administration and re-migration`, async () => {
      await seed();
      for (const statement of drift) await control.query(statement);
      await assert.rejects(
        transaction(control, () => fence()(control)),
        denied,
      );
      await assert.rejects(
        transaction(control, () => readPostgresTenantMembership(control, owner(), lookup())),
        denied,
      );
      await assert.rejects(
        administer(control, (admin) => admin.putTenant({ tenantId: 'east', status: 'active', expectedVersion: null })),
        denied,
      );
      await assert.rejects(migratePostgresTenantStore(url, owner()), TenantStoreUnavailable);
      assert.equal(await tenantRow('east'), undefined);
    });
  }

  test('identity is byte-exact under COLLATE "C": case, normalisation and discovery order', async () => {
    await migratePostgresTenantStore(url, owner());
    const composed = 'caf\u00e9',
      decomposed = 'cafe\u0301';
    assert.notEqual(composed, decomposed);
    await administer(control, async (admin) => {
      for (const tenantId of ['north', 'a_b', 'a0', 'a-b']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      // Distinct exact identities coexist in one tenant where a folding or
      // normalising comparison would collide on the live-membership index.
      await admin.putMembership(grant({ accountId: 'Alice', membershipId: 'upper' }));
      await admin.putMembership(grant({ accountId: 'alice', membershipId: 'lower' }));
      await admin.putMembership(grant({ accountId: composed, membershipId: 'composed' }));
      await admin.putMembership(grant({ accountId: decomposed, membershipId: 'decomposed' }));
      await admin.putMembership(grant({ accountId: '\uFFFD', membershipId: 'replacement' }));
      for (const tenantId of ['a_b', 'a0', 'a-b'])
        await admin.putMembership(grant({ tenantId, accountId: 'x', membershipId: `x-${tenantId}` }));
    });
    const read = (accountId: string) => transaction(control, () => readPostgresTenantMembership(control, owner(), lookup({ accountId })));
    assert.equal((await read('Alice'))?.membershipId, 'upper');
    assert.equal((await read('alice'))?.membershipId, 'lower');
    assert.equal((await read(composed))?.membershipId, 'composed');
    assert.equal((await read(decomposed))?.membershipId, 'decomposed');
    assert.equal((await read('\uFFFD'))?.membershipId, 'replacement');
    assert.equal(await read('ALICE'), null);
    // A lone surrogate would reach the server as U+FFFD and match that
    // account; it is refused instead, on reads and on writes.
    await assert.rejects(read('\uD800'), denied);
    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ accountId: 'lone\uDC00', membershipId: 'lone' }))),
      denied,
    );
    const discovered = await transaction(control, () =>
      readPostgresTenantMemberships(
        control,
        owner(),
        { appId: 'app', accountId: 'x', source: owner().source, deployment: 'generation-1' },
        clock,
      ),
    );
    assert.deepEqual(
      discovered.map((record) => record.tenantId),
      ['a-b', 'a0', 'a_b'],
      'code-unit order, not the database locale',
    );
    const collations = (
      await control.query(`SELECT a.attname AS name, l.collname AS collation FROM pg_attribute a
      JOIN pg_collation l ON l.oid = a.attcollation WHERE a.attrelid = '${m}'::regclass AND a.attnum > 0 ORDER BY a.attnum`)
    ).rows;
    assert.deepEqual(
      collations.filter((row) => ['id', 'tenant_id', 'account_id'].includes(row.name as string)).map((row) => row.collation),
      ['C', 'C', 'C'],
    );
  });

  test('CAS revisions are store-created and exact; stale or create-over-existing changes roll the transaction back', async () => {
    await seed();
    await assert.rejects(
      administer(control, async (admin) => {
        await admin.putTenant({ tenantId: 'east', status: 'active', expectedVersion: null });
        await admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '2' });
      }),
      denied,
    );
    assert.equal(await tenantRow('east'), undefined, 'an earlier change in the refused transaction is rolled back');
    assert.deepEqual({ ...(await tenantRow('north')) }, { status: 'active', version: '1' });
    await assert.rejects(
      administer(control, (admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null })),
      denied,
    );
    await administer(control, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
    assert.deepEqual({ ...(await tenantRow('north')) }, { status: 'suspended', version: '2' });
    await administer(control, (admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '2' }));

    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant())),
      denied,
      'create over an existing grant',
    );
    await administer(control, (admin) => admin.putMembership(grant({ roles: ['reader', 'reviewer'], expectedVersion: '1' })));
    assert.deepEqual({ ...(await membershipRow()) }, { status: 'active', version: '2', roles_json: '["reader","reviewer"]' });
    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ expectedVersion: '1' }))),
      denied,
    );

    // Decimal strings past 2^53 increment without coercion; the 128-digit
    // ceiling refuses rather than wrapping or truncating.
    await control.query(`UPDATE ${t} SET version = '9007199254740993' WHERE id = 'south'`);
    await administer(control, (admin) => admin.putTenant({ tenantId: 'south', status: 'suspended', expectedVersion: '9007199254740993' }));
    assert.equal((await tenantRow('south')).version, '9007199254740994');
    const ceiling = '9'.repeat(128);
    await control.query(`UPDATE ${t} SET version = $1 WHERE id = 'south'`, [ceiling]);
    await assert.rejects(
      administer(control, (admin) => admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: ceiling })),
      denied,
    );
    for (const expectedVersion of ['0', '01', '1.0', ' 3', '', 3]) {
      await assert.rejects(
        administer(control, (admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion } as never)),
        denied,
      );
    }
    assert.deepEqual({ ...(await tenantRow('north')) }, { status: 'active', version: '3' });
  });

  test('closure and revocation are terminal; a regrant is a new identity; one live grant per exact tenant and account', async () => {
    await seed();
    await administer(control, (admin) => admin.putMembership(grant({ tenantId: 'south', membershipId: 'south-grant' })));
    await administer(control, (admin) => admin.putTenant({ tenantId: 'south', status: 'closed', expectedVersion: '1' }));
    await assert.rejects(
      administer(control, (admin) => admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: '2' })),
      denied,
    );
    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ tenantId: 'south', accountId: 'bob', membershipId: 'late' }))),
      denied,
    );
    await assert.rejects(
      administer(control, (admin) =>
        admin.putMembership(grant({ tenantId: 'south', membershipId: 'south-grant', roles: ['reader'], expectedVersion: '1' })),
      ),
      denied,
      'a closed tenant accepts revocation only',
    );
    await administer(control, (admin) =>
      admin.putMembership(grant({ tenantId: 'south', membershipId: 'south-grant', status: 'revoked', expectedVersion: '1' })),
    );

    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ accountId: 'carol', membershipId: 'born-revoked', status: 'revoked' }))),
      denied,
    );
    await administer(control, (admin) => admin.putMembership(grant({ status: 'revoked', expectedVersion: '1' })));
    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ expectedVersion: '2' }))),
      denied,
      'revocation is terminal',
    );

    await administer(control, (admin) => admin.putMembership(grant({ membershipId: 'grant-2', status: 'invited' })));
    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ membershipId: 'grant-3' }))),
      denied,
      'one live grant',
    );
    await administer(control, (admin) => admin.putMembership(grant({ membershipId: 'grant-2', expectedVersion: '1' })));
    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ membershipId: 'grant-2', status: 'invited', expectedVersion: '2' }))),
      denied,
    );
    await assert.rejects(
      administer(control, (admin) => admin.putMembership(grant({ membershipId: 'grant-2', accountId: 'bob', expectedVersion: '2' }))),
      denied,
    );
    assert.deepEqual({ ...(await membershipRow('grant-1')) }, { status: 'revoked', version: '2', roles_json: '["reviewer"]' });
    assert.deepEqual({ ...(await membershipRow('grant-2')) }, { status: 'active', version: '2', roles_json: '["reviewer"]' });
  });

  test('two connections racing to grant the same tenant and account settle to one live grant', async () => {
    await seed();
    await administer(control, (admin) => admin.putMembership(grant({ status: 'revoked', expectedVersion: '1' })));
    const a = await connection(),
      b = await connection();
    await a.query('BEGIN');
    const operations = new TransactionOperations();
    await createPostgresTenantAdministration(a, operations, owner()).putMembership(grant({ membershipId: 'from-a' }));
    const fromB = administer(b, (admin) => admin.putMembership(grant({ membershipId: 'from-b' })));
    assert.equal(await settles(fromB), false, 'the second grant waits on the tenant row');
    await operations.finish();
    await a.query('COMMIT');
    await assert.rejects(fromB, denied);
    assert.deepEqual(
      (await control.query(`SELECT id FROM ${m} WHERE tenant_id = 'north' AND account_id = 'alice' AND status <> 'revoked'`)).rows,
      [{ id: 'from-a' }],
    );
  });

  test('the guard accepts current evidence and refuses changed, expired or unsequenced evidence', async () => {
    await seed();
    const guarded = (value: TenantMembershipEvidence, now = clock) =>
      transaction(control, (operations) => createPostgresTenantMembershipGuard(control, operations, owner(), now).assertCurrent(value));
    await guarded(evidence());
    await assert.rejects(
      guarded(evidence(), () => 5_000),
      denied,
      'at the end of the window',
    );
    await assert.rejects(
      guarded(evidence(), () => 10),
      denied,
      'before the evidence was verified',
    );
    await assert.rejects(guarded(evidence({ validUntil: 20_000 })), denied, 'longer than the grant');
    await assert.rejects(guarded(evidence({ tenantId: 'south' })), denied, 'no grant in that tenant');
    await administer(control, (admin) => admin.putMembership(grant({ roles: ['reader', 'reviewer'], expectedVersion: '1' })));
    await assert.rejects(guarded(evidence()), denied, 'changed roles and revision');
    await guarded(evidence({ membershipVersion: '2', roles: ['reviewer', 'reader'] }));
    await administer(control, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
    await assert.rejects(guarded(evidence({ membershipVersion: '2', roles: ['reviewer', 'reader'] })), denied, 'a suspended tenant');
    await assert.rejects(assertPostgresTenantMembershipFence(control, owner(), evidence(), clock), denied, 'outside a transaction');
  });

  test('a revocation waits for an in-flight business commit, which then stands', async () => {
    await seed();
    const adapter = new PostgresAdapter(url, 'tenant fence', ['public']);
    const other = await connection();
    try {
      const entered = gate(),
        release = gate();
      const business = adapter.scopeVerifiedTransaction(northRows(), fence(), async (tx) => {
        await tx.update({ table: ITEM, key: { id: 'north-1' }, values: { name: 'Business write' } });
        entered.release();
        await release.promise;
      });
      await entered.promise;
      const revocation = administer(other, (admin) => admin.putMembership(grant({ status: 'revoked', expectedVersion: '1' })));
      assert.equal(await settles(revocation), false, 'the revocation waits on the tenant row the fence holds');
      release.release();
      await business;
      await revocation;
      assert.equal(await itemName(), 'Business write');
      assert.deepEqual({ ...(await membershipRow()) }, { status: 'revoked', version: '2', roles_json: '["reviewer"]' });
      await assert.rejects(
        adapter.scopeVerifiedTransaction(northRows(), fence(), async (tx) => {
          await tx.update({ table: ITEM, key: { id: 'north-1' }, values: { name: 'Too late' } });
        }),
        denied,
        'the same evidence no longer admits a write',
      );
      assert.equal(await itemName(), 'Business write');
    } finally {
      await adapter.close();
    }
  });

  for (const [label, change] of [
    ['revocation', (admin: TenantStoreAdministration) => admin.putMembership(grant({ status: 'revoked', expectedVersion: '1' }))],
    ['role change', (admin: TenantStoreAdministration) => admin.putMembership(grant({ roles: ['reader'], expectedVersion: '1' }))],
    [
      'tenant suspension',
      (admin: TenantStoreAdministration) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }),
    ],
  ] as const) {
    test(`a business transaction waits for an in-flight ${label}, then refuses without writing`, async () => {
      await seed();
      const adapter = new PostgresAdapter(url, 'tenant fence', ['public']);
      const other = await connection();
      try {
        await other.query('BEGIN');
        const operations = new TransactionOperations();
        await change(createPostgresTenantAdministration(other, operations, owner()));
        let ran = false;
        const business = adapter.scopeVerifiedTransaction(northRows(), fence(), async (tx) => {
          ran = true;
          await tx.update({ table: ITEM, key: { id: 'north-1' }, values: { name: 'Business write' } });
        });
        assert.equal(await settles(business), false, `the fence waits for the uncommitted ${label}`);
        await operations.finish();
        await other.query('COMMIT');
        await assert.rejects(business, denied);
        assert.equal(ran, false, 'the callback never ran');
        assert.equal(await itemName(), 'North');
      } finally {
        await adapter.close();
      }
    });
  }

  test('the verified command transaction orders receipts behind the same fence', async () => {
    await seed();
    await migratePostgresCommandJournal(url);
    const adapter = new PostgresAdapter(url, 'tenant command fence', ['public']);
    const other = await connection();
    const provenance: CommandJournalTenant = {
      appId: 'app',
      storeId: 'store-1',
      sourceId: 'business',
      tenantId: 'north',
      actorId: 'alice',
      membershipId: 'grant-1',
      membershipVersion: '1',
      tenantVersion: '1',
      roles: ['reviewer'],
      deployment: 'generation-1',
    };
    const receipt = (key: string): StoredCommandReceipt => ({
      id: `receipt-${key}`,
      appId: 'app',
      actorId: 'alice',
      commandId: 'rename',
      commandVersion: 1,
      idempotencyKey: key,
      fingerprint: 'fingerprint',
      resultJson: '{}',
      requestId: `request-${key}`,
      completedAt: '2026-09-10T12:00:00.000Z',
    });
    const run = (key: string, name: string, hold?: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> }) =>
      commandsOf(adapter).scopeVerifiedCommandTransaction(northRows(), fence(), provenance, async (tx, journal) => {
        assert.equal(await journal.find(receipt(key)), undefined);
        await tx.update({ table: ITEM, key: { id: 'north-1' }, values: { name } });
        await journal.commit(receipt(key), { target: ITEM, keyJson: '{"id":"north-1"}', changesJson: JSON.stringify({ name }) });
        if (hold) {
          hold.entered.release();
          await hold.release.promise;
        }
      });
    try {
      const hold = { entered: gate(), release: gate() };
      const first = run('command-attempt-0001', 'Command write', hold);
      await hold.entered.promise;
      const revocation = administer(other, (admin) => admin.putMembership(grant({ status: 'revoked', expectedVersion: '1' })));
      assert.equal(await settles(revocation), false);
      hold.release.release();
      await first;
      await revocation;
      assert.deepEqual((await control.query(`SELECT tenant_id, membership_id, membership_version FROM ${postgresAuditRows} a`)).rows, [
        { tenant_id: 'north', membership_id: 'grant-1', membership_version: '1' },
      ]);
      await assert.rejects(run('command-attempt-0002', 'Too late'), denied);
      assert.equal(await count(journalTables.receipt), 1, 'no receipt for the refused attempt');
      assert.equal(await itemName(), 'Command write');
    } finally {
      await adapter.close();
    }
  });

  /* ---------- one attestation per adapter ---------- */

  /* An adapter attests the store when it first uses it (postgresStoreFence.ts),
     and its fences read rows after that. Each change here is made from another
     connection once an adapter has attested: that adapter goes on, and the
     next one to start refuses. */
  for (const [label, prepare, drift] of [
    [
      'a trigger',
      [`CREATE FUNCTION public.tenant_store_noop() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`],
      `CREATE TRIGGER tenant_store_noop BEFORE UPDATE ON ${m} FOR EACH ROW EXECUTE FUNCTION public.tenant_store_noop()`,
    ],
    ['an index', [], `CREATE INDEX tenant_store_extra ON ${m} (account_id)`],
    ['a foreign key', [], `ALTER TABLE ${m} ADD CONSTRAINT tenant_store_extra FOREIGN KEY (parent_version) REFERENCES ${t} (id) NOT VALID`],
    ['a grant', [], `GRANT SELECT ON ${m} TO PUBLIC`],
  ] as const) {
    test(`${label} made after an adapter attested is refused by the next adapter to start`, async () => {
      await seed();
      for (const statement of prepare) await control.query(statement);
      const running = new PostgresAdapter(url, 'tenant fence', ['public']);
      const next = new PostgresAdapter(url, 'tenant fence, restarted', ['public']);
      try {
        await running.scopeVerifiedTransaction(northRows(), fence(), async (tx) => {
          await tx.update({ table: ITEM, key: { id: 'north-1' }, values: { name: 'First write' } });
        });
        await control.query(drift);
        await running.scopeVerifiedTransaction(northRows(), fence(), async (tx) => {
          await tx.update({ table: ITEM, key: { id: 'north-1' }, values: { name: 'Second write' } });
        });
        await assert.rejects(
          next.scopeVerifiedTransaction(northRows(), fence(), async (tx) => {
            await tx.update({ table: ITEM, key: { id: 'north-1' }, values: { name: 'Refused write' } });
          }),
          denied,
        );
        assert.equal(await itemName(), 'Second write', 'nothing committed after the restart');
      } finally {
        await running.close();
        await next.close();
      }
    });
  }

  /* ---------- the administration journal ---------- */

  const scope = (key = 'attempt-0001'): AdministrationReceiptScope => ({
    actorId: 'operator',
    tenantId: 'north',
    operation: 'createTenant',
    operationVersion: 1,
    idempotencyKey: key,
  });
  const adminReceipt = (key = 'attempt-0001', id = `receipt-${key}`): StoredAdministrationReceipt => ({
    ...scope(key),
    id,
    fingerprint: 'fingerprint',
    resultJson: '{"tenantId":"north","version":"1"}',
    requestId: `request-${key}`,
    completedAt: '2026-09-10T12:00:00.000Z',
  });
  const adminAudit = (): AdministrationAudit => ({
    policyId: 'operators',
    policyVersion: 'v1',
    deployment: 'deployment-1',
    sessionId: 'session-id',
    changeJson: '{"status":"active"}',
  });
  const journaled = <T>(
    c: PgQuery,
    work: (journal: ReturnType<typeof createPostgresTenantAdministrationJournal>, admin: TenantStoreAdministration) => Promise<T>,
  ) =>
    transaction(c, (operations) =>
      work(createPostgresTenantAdministrationJournal(c, operations, owner()), createPostgresTenantAdministration(c, operations, owner())),
    );
  const south = { tenantId: 'south', status: 'active' as const, expectedVersion: null };

  test('the administration journal migrates after its store, idempotently and bound, and refuses a foreign layout', async () => {
    await assert.rejects(migratePostgresTenantAdministrationJournal(url, owner()), TenantAdministrationJournalUnavailable);
    assert.equal(await described('__mistri_admin_'), '[[]]', 'nothing is created without the store');
    await migratePostgresTenantStore(url, owner());
    assert.deepEqual(await migratePostgresTenantAdministrationJournal(url, owner()), { version: 1, migrated: true });
    assert.deepEqual(await migratePostgresTenantAdministrationJournal(url, owner()), { version: 1, migrated: false });
    await assert.rejects(
      migratePostgresTenantAdministrationJournal(url, { ...owner(), storeId: 'other-store' }),
      TenantAdministrationJournalUnavailable,
    );
    await transaction(control, () => assertPostgresTenantAdministrationJournal(control, owner()));
    await control.query(`ALTER TABLE ${runtimeTable('postgres', adminTables.receipt)} ADD COLUMN note text`);
    const before = await described();
    await assert.rejects(migratePostgresTenantAdministrationJournal(url, owner()), TenantAdministrationJournalUnavailable);
    assert.equal(await described(), before);
    await assert.rejects(
      transaction(control, () => assertPostgresTenantAdministrationJournal(control, owner())),
      denied,
    );
  });

  test('a receipt and its audit columns commit with the metadata change, replay exactly, and roll back together', async () => {
    await migratePostgresTenantStore(url, owner());
    await migratePostgresTenantAdministrationJournal(url, owner());
    await journaled(control, async (journal, admin) => {
      assert.equal(await journal.read(scope()), null);
      await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
      await journal.commit(adminReceipt(), adminAudit());
    });
    const stored = await journaled(control, (journal) => journal.read(scope()));
    assert.ok(stored && Object.isFrozen(stored));
    assert.deepEqual({ ...stored }, adminReceipt());
    assert.deepEqual(
      (
        await control.query(
          `SELECT id, policy_id, policy_version, deployment, session_id, change_json FROM ${runtimeTable('postgres', adminTables.receipt)}`,
        )
      ).rows,
      [
        {
          id: 'receipt-attempt-0001',
          policy_id: 'operators',
          policy_version: 'v1',
          deployment: 'deployment-1',
          session_id: 'session-id',
          change_json: '{"status":"active"}',
        },
      ],
    );

    await assert.rejects(
      journaled(control, async (journal, admin) => {
        await admin.putTenant(south);
        await journal.commit(adminReceipt('attempt-0001', 'receipt-duplicate'), adminAudit());
      }),
      denied,
      'a second receipt for one scope',
    );
    await assert.rejects(
      journaled(control, async (journal, admin) => {
        await admin.putTenant(south);
        await journal.commit(adminReceipt('attempt-0002'), { ...adminAudit(), changeJson: 'not json' });
      }),
      denied,
      'an invalid audit',
    );
    assert.equal(await tenantRow('south'), undefined, 'the metadata change rolled back with the refused receipt');
    assert.equal(await count(adminTables.receipt), 1);

    const widest = { ...adminReceipt('attempt-0003'), operationVersion: Number.MAX_SAFE_INTEGER };
    await journaled(control, (journal) => journal.commit(widest, adminAudit()));
    assert.deepEqual(
      { ...(await journaled(control, (journal) => journal.read({ ...scope('attempt-0003'), operationVersion: Number.MAX_SAFE_INTEGER }))) },
      widest,
    );
  });

  test('drift in the store refuses the journal', async () => {
    await migratePostgresTenantStore(url, owner());
    await migratePostgresTenantAdministrationJournal(url, owner());
    await journaled(control, (journal) => journal.commit(adminReceipt(), adminAudit()));
    assert.equal((await journaled(control, (journal) => journal.read(scope())))?.id, 'receipt-attempt-0001');
    await control.query(`ALTER TABLE ${m} ADD COLUMN note text`);
    await assert.rejects(
      journaled(control, (journal) => journal.read(scope())),
      denied,
    );
  });

  test('duplicate attempts on two connections serialise on the receipt scope', async () => {
    await migratePostgresTenantStore(url, owner());
    await migratePostgresTenantAdministrationJournal(url, owner());
    const a = await connection(),
      b = await connection();
    await a.query('BEGIN');
    const operations = new TransactionOperations();
    const journal = createPostgresTenantAdministrationJournal(a, operations, owner());
    assert.equal(await journal.read(scope()), null);
    const duplicate = journaled(b, (other) => other.read(scope()));
    assert.equal(await settles(duplicate), false, 'the duplicate waits for the first attempt');
    await createPostgresTenantAdministration(a, operations, owner()).putTenant({
      tenantId: 'north',
      status: 'active',
      expectedVersion: null,
    });
    await journal.commit(adminReceipt(), adminAudit());
    await operations.finish();
    await a.query('COMMIT');
    assert.deepEqual({ ...(await duplicate) }, adminReceipt(), "and then reads the first attempt's receipt");
  });
});
