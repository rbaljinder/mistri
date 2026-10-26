import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { TenantMembershipEvidence, TenantMembershipLookup } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import {
  TENANT_TABLES as tables,
  assertSqliteTenantStore,
  createSqliteTenantAdministration,
  createSqliteTenantMembershipGuard,
  provisionSqliteTenantStore,
  readSqliteTenantMembership,
  type TenantStoreBinding,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TenantStoreOfAnotherApp } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';

const binding = (): TenantStoreBinding => ({ appId: 'app', source: { id: 'business', connection: 'owned-business' }, storeId: 'store-1' });
const lookup = (): TenantMembershipLookup => ({
  appId: 'app',
  accountId: 'alice',
  tenantId: 'north',
  source: { id: 'business', connection: 'owned-business' },
  deployment: 'generation-1',
});
const tenant = () => ({ tenantId: 'north', status: 'active' as const, expectedVersion: null });
const membership = () => ({
  tenantId: 'north',
  accountId: 'alice',
  membershipId: 'grant-1',
  status: 'active' as const,
  roles: ['reviewer'],
  validUntil: 10_000,
  expectedVersion: null,
});
type Administration = ReturnType<typeof createSqliteTenantAdministration>;
type Guard = ReturnType<typeof createSqliteTenantMembershipGuard>;
type TenantInput = Parameters<Administration['putTenant']>[0];
type MembershipInput = Parameters<Administration['putMembership']>[0];
const secret = 'PRIVATE_TENANT_STORE_SENTINEL';
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, new RegExp(secret));
  return true;
}
const denied = (work: () => unknown) => assert.rejects(async () => work(), safe);
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function catalog(db: DatabaseSync) {
  return db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name').all();
}
function count(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT count(*) AS n FROM main."${table}"`).get()?.n;
}
async function fixture(work: (db: DatabaseSync, path: string) => void | Promise<void>, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-store-'));
  const path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;
      CREATE TABLE business_record(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO business_record VALUES ('one', 'original')`);
    if (provision) assert.deepEqual(provisionSqliteTenantStore(path, binding()), { version: 1, provisioned: true });
    await work(db, path);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
async function transaction<T>(
  db: DatabaseSync,
  work: (admin: Administration, guard: Guard, operations: TransactionOperations) => Promise<T>,
  now: () => number = () => 100,
): Promise<T> {
  db.exec('BEGIN');
  const operations = new TransactionOperations();
  try {
    const result = await work(
      createSqliteTenantAdministration(db, operations, binding()),
      createSqliteTenantMembershipGuard(db, operations, binding(), now),
      operations,
    );
    await operations.finish();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await operations.finish();
    } catch {
      /* The original operation or drain refusal is the assertion target. */
    }
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
async function seed(db: DatabaseSync) {
  await transaction(db, async (admin) => {
    await admin.putTenant(tenant());
    await admin.putMembership(membership());
  });
}
function evidence(db: DatabaseSync): TenantMembershipEvidence {
  const record = readSqliteTenantMembership(db, binding(), lookup());
  assert.ok(record);
  return {
    ...lookup(),
    membershipId: record.membershipId,
    membershipVersion: record.membershipVersion,
    tenantVersion: record.tenantVersion,
    roles: [...record.roles],
    verifiedAt: 50,
    validUntil: 1000,
  };
}

test('explicit provisioning is idempotent, source-bound, and preserves existing business data', async () => {
  await fixture((db, path) => {
    const before = catalog(db);
    assert.deepEqual(provisionSqliteTenantStore(path, binding()), { version: 1, provisioned: false });
    assert.doesNotThrow(() => assertSqliteTenantStore(db, binding()));
    assert.deepEqual(catalog(db), before);
    assert.equal(db.prepare('SELECT value FROM business_record').get()?.value, 'original');
    assert.equal(count(db, tables.tenant), 0);
    assert.equal(count(db, tables.membership), 0);
    assert.equal(db.isTransaction, false);
  });
});

test('provisioning refuses missing paths and directories without creating a database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-store-missing-'));
  const absent = join(directory, 'absent.db');
  try {
    await denied(() => provisionSqliteTenantStore(absent, binding()));
    await denied(() => provisionSqliteTenantStore(directory, binding()));
    assert.equal(existsSync(absent), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const field of ['appId', 'source.id', 'storeId'] as const) {
  test(`provisioning and runtime attestation refuse rebound ${field}`, async () => {
    await fixture(async (db, path) => {
      const other = binding();
      if (field.startsWith('source.')) Reflect.set(other.source, field.split('.')[1], secret);
      else Reflect.set(other, field, secret);
      const before = catalog(db);
      /* Provisioning is the operator's maintenance step: another App's store is
         said by name (both are App ids from configuration, no tenant's data).
         Every other mismatch, and runtime attestation always, stays a denial. */
      if (field === 'appId') {
        assert.throws(
          () => provisionSqliteTenantStore(path, other),
          (error: Error) =>
            error instanceof TenantStoreOfAnotherApp &&
            error.message.startsWith('This database\'s tenant store belongs to the tenant App "app"'),
        );
      } else await denied(() => provisionSqliteTenantStore(path, other));
      await denied(() => assertSqliteTenantStore(db, other));
      assert.deepEqual(catalog(db), before);
      assert.doesNotThrow(() => assertSqliteTenantStore(db, binding()));
    });
  });
}

test('connection registry handles may rotate but each lookup must match its captured handle', async () => {
  await fixture(async (db, path) => {
    await seed(db);
    const rebound = { ...binding(), source: { ...binding().source, connection: 'new-registry-handle' } };
    assert.deepEqual(provisionSqliteTenantStore(path, rebound), { version: 1, provisioned: false });
    assert.doesNotThrow(() => assertSqliteTenantStore(db, rebound));
    await denied(() => readSqliteTenantMembership(db, rebound, lookup()));
    assert.equal(readSqliteTenantMembership(db, rebound, { ...lookup(), source: rebound.source })?.membershipId, 'grant-1');
  });
});

test('runtime reads and writer facades never provision a missing store', async () => {
  await fixture(async (db) => {
    const before = catalog(db);
    await denied(() => assertSqliteTenantStore(db, binding()));
    await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putTenant(tenant());
      }),
    );
    assert.deepEqual(catalog(db), before);
    assert.equal(db.isTransaction, false);
  }, false);
});

for (const table of Object.values(tables)) {
  for (const [name, sql] of [
    ['main trigger', `CREATE TRIGGER hostile AFTER INSERT ON main."${table}" BEGIN SELECT '${secret}'; END`],
    ['TEMP trigger', `CREATE TEMP TRIGGER hostile AFTER INSERT ON main."${table}" BEGIN SELECT '${secret}'; END`],
    ['TEMP table shadow', `CREATE TEMP TABLE "${table.toUpperCase()}" AS SELECT * FROM main."${table}"`],
    ['TEMP view shadow', `CREATE TEMP VIEW "${table}" AS SELECT * FROM main."${table}"`],
    ['extra column', `ALTER TABLE main."${table}" ADD COLUMN unexpected TEXT`],
    ['missing table', `DROP TABLE main."${table}"`],
  ])
    test(`store refuses ${name} on ${table} without repairing it`, async () => {
      await fixture(async (db, path) => {
        db.exec(sql);
        const before = catalog(db);
        await denied(() => assertSqliteTenantStore(db, binding()));
        await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
        assert.equal(db.isTransaction, false);
        if (!name.startsWith('TEMP')) await denied(() => provisionSqliteTenantStore(path, binding()));
        assert.deepEqual(catalog(db), before);
      });
    });
}

test('unrelated TEMP objects are permitted and cannot supply a missing main store', async () => {
  await fixture((db) => {
    db.exec(`CREATE TEMP TABLE scratch(id INTEGER);
      CREATE TEMP VIEW scratch_view AS SELECT * FROM scratch;
      CREATE TEMP TRIGGER scratch_hook AFTER UPDATE ON business_record BEGIN SELECT 1; END`);
    assert.doesNotThrow(() => assertSqliteTenantStore(db, binding()));
  });
  await fixture(async (db) => {
    for (const table of Object.values(tables)) db.exec(`CREATE TEMP TABLE "${table}"(id TEXT)`);
    const before = catalog(db);
    await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
    assert.deepEqual(catalog(db), before);
  }, false);
});

test('membership reads use a short transaction but refuse and preserve a caller transaction', async () => {
  await fixture(async (db) => {
    await seed(db);
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '1');
    assert.equal(db.isTransaction, false);
    db.exec("BEGIN; UPDATE business_record SET value = 'caller-pending'");
    try {
      await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
      assert.equal(db.isTransaction, true);
      assert.equal(db.prepare('SELECT value FROM business_record').get()?.value, 'caller-pending');
    } finally {
      db.exec('ROLLBACK');
    }
    assert.equal(db.prepare('SELECT value FROM business_record').get()?.value, 'original');
  });
});

test('new grants use store-created revisions and membership reads preserve exact account IDs', async () => {
  await fixture(async (db) => {
    await seed(db);
    const found = readSqliteTenantMembership(db, binding(), lookup());
    assert.ok(found);
    assert.deepEqual(
      { ...found, roles: [...found.roles] },
      {
        appId: 'app',
        accountId: 'alice',
        tenantId: 'north',
        tenantStatus: 'active',
        tenantVersion: '1',
        membershipId: 'grant-1',
        membershipVersion: '1',
        status: 'active',
        roles: ['reviewer'],
        validUntil: 10_000,
      },
    );
    assert.equal(readSqliteTenantMembership(db, binding(), { ...lookup(), accountId: 'Alice' }), null);
    assert.equal(readSqliteTenantMembership(db, binding(), { ...lookup(), tenantId: 'south' }), null);
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), accountId: 'Alice', membershipId: 'grant-2' });
    });
    assert.equal(readSqliteTenantMembership(db, binding(), { ...lookup(), accountId: 'Alice' })?.membershipId, 'grant-2');
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipId, 'grant-1');
  });
});

test('successful CAS increments revisions while stale or create-over-existing CAS rolls back', async () => {
  await fixture(async (db) => {
    await seed(db);
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), roles: ['manager'], expectedVersion: '1' });
      await admin.putTenant({ ...tenant(), status: 'suspended', expectedVersion: '1' });
    });
    const current = readSqliteTenantMembership(db, binding(), lookup());
    assert.equal(current?.tenantVersion, '2');
    assert.equal(current?.tenantStatus, 'suspended');
    assert.equal(current?.membershipVersion, '2');
    assert.deepEqual(current?.roles, ['manager']);
    for (const expectedVersion of [null, '1']) {
      await denied(() =>
        transaction(db, async (admin) => {
          await admin.putTenant({ ...tenant(), expectedVersion });
        }),
      );
      await denied(() =>
        transaction(db, async (admin) => {
          await admin.putMembership({ ...membership(), expectedVersion });
        }),
      );
    }
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '2');
  });
});

test('tenant closure is terminal and a revoked grant survives reinvitation under a new identity', async () => {
  await fixture(async (db) => {
    await seed(db);
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), status: 'revoked', expectedVersion: '1' });
    });
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putMembership({ ...membership(), expectedVersion: '2' });
      }),
    );
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), membershipId: 'grant-2', status: 'invited' });
    });
    assert.equal(count(db, tables.membership), 2);
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), membershipId: 'grant-2', expectedVersion: '1' });
    });
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipId, 'grant-2');
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '2');
    await transaction(db, async (admin) => {
      await admin.putTenant({ ...tenant(), status: 'closed', expectedVersion: '1' });
    });
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putTenant({ ...tenant(), expectedVersion: '2' });
      }),
    );
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.tenantStatus, 'closed');
    assert.equal(count(db, tables.membership), 2);
  });
});

test('only one invited or active grant can exist per exact tenant/account', async () => {
  await fixture(async (db) => {
    await seed(db);
    for (const status of ['active', 'invited'] as const)
      await denied(() =>
        transaction(db, async (admin) => {
          await admin.putMembership({ ...membership(), membershipId: 'grant-2', status });
        }),
      );
    assert.equal(count(db, tables.membership), 1);
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putMembership({ ...membership(), tenantId: 'missing', membershipId: 'grant-3' });
      }),
    );
  });
});

test('the guard accepts current evidence without changing revisions and fences another writer until commit', async () => {
  await fixture(async (db, path) => {
    await seed(db);
    const current = evidence(db);
    const other = new DatabaseSync(path);
    other.exec('PRAGMA busy_timeout = 0');
    try {
      await transaction(db, async (_admin, guard) => {
        await guard.assertCurrent(current);
        assert.throws(() => other.exec("UPDATE business_record SET value = 'raced'"), /locked|busy/i);
      });
      assert.deepEqual(evidence(db), current);
      assert.doesNotThrow(() => other.exec("UPDATE business_record SET value = 'after-commit'"));
    } finally {
      other.close();
    }
  });
});

const evidenceDrifts: Array<[string, (value: TenantMembershipEvidence) => TenantMembershipEvidence]> = [
  ['App', (value) => ({ ...value, appId: 'other' })],
  ['account case', (value) => ({ ...value, accountId: 'Alice' })],
  ['tenant', (value) => ({ ...value, tenantId: 'south' })],
  ['source ID', (value) => ({ ...value, source: { ...value.source, id: 'other' } })],
  ['source connection', (value) => ({ ...value, source: { ...value.source, connection: secret } })],
  ['membership identity', (value) => ({ ...value, membershipId: 'grant-other' })],
  ['membership revision', (value) => ({ ...value, membershipVersion: '2' })],
  ['tenant revision', (value) => ({ ...value, tenantVersion: '2' })],
  ['roles', (value) => ({ ...value, roles: ['manager'] })],
  ['empty deployment', (value) => ({ ...value, deployment: '' })],
  ['future verification', (value) => ({ ...value, verifiedAt: 101 })],
  ['expired evidence', (value) => ({ ...value, validUntil: 100 })],
  ['expiry beyond source', (value) => ({ ...value, validUntil: 10_001 })],
];
for (const [name, change] of evidenceDrifts)
  test(`caught guard refusal for ${name} poisons the business transaction`, async () => {
    await fixture(async (db) => {
      await seed(db);
      const invalid = change(evidence(db));
      let later = false;
      await denied(() =>
        transaction(db, async (_admin, guard, operations) => {
          await operations.run(async () => {
            db.exec("UPDATE business_record SET value = 'must-rollback'");
          });
          await denied(() => guard.assertCurrent(invalid));
          await denied(() =>
            operations.run(async () => {
              later = true;
            }),
          );
        }),
      );
      assert.equal(later, false);
      assert.equal(db.prepare('SELECT value FROM business_record').get()?.value, 'original');
    });
  });

test('guard time is sampled after queue waits and stale evidence cannot resume business work', async () => {
  await fixture(async (db) => {
    await seed(db);
    const current = evidence(db);
    let time = 100,
      samples = 0;
    await denied(() =>
      transaction(
        db,
        async (_admin, guard, operations) => {
          const pause = gate();
          const blocked = operations.run(() => pause.wait);
          const pending = guard.assertCurrent(current);
          assert.equal(samples, 0);
          time = 1000;
          pause.release();
          await blocked;
          await denied(() => pending);
        },
        () => {
          samples++;
          return time;
        },
      ),
    );
    assert.equal(samples, 1);
  });
});

for (const time of [NaN, Infinity, -1, 99.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`guard refuses invalid clock ${String(time)} through the transaction queue`, async () => {
    await fixture(async (db) => {
      await seed(db);
      const current = evidence(db);
      await denied(() =>
        transaction(
          db,
          async (_admin, guard) => {
            await denied(() => guard.assertCurrent(current));
          },
          () => time,
        ),
      );
    });
  });
}

test('administration snapshots inputs before queue waits', async () => {
  await fixture(async (db) => {
    const originalTenant = tenant(),
      originalMembership = membership();
    await transaction(db, async (admin, _guard, operations) => {
      const pause = gate();
      const blocked = operations.run(() => pause.wait);
      const first = admin.putTenant(originalTenant),
        second = admin.putMembership(originalMembership);
      originalTenant.tenantId = 'south';
      originalMembership.tenantId = 'south';
      originalMembership.accountId = 'bob';
      originalMembership.roles.push('manager');
      originalMembership.validUntil = 1;
      pause.release();
      await blocked;
      await first;
      await second;
    });
    const record = readSqliteTenantMembership(db, binding(), lookup());
    assert.equal(record?.tenantId, 'north');
    assert.deepEqual(record?.roles, ['reviewer']);
    assert.equal(record?.validUntil, 10_000);
    assert.equal(readSqliteTenantMembership(db, binding(), { ...lookup(), tenantId: 'south' }), null);
  });
});

test('guard captures evidence before queue waits and captures factory binding ownership', async () => {
  await fixture(async (db) => {
    await seed(db);
    const current = evidence(db),
      owner = binding();
    await transaction(db, async (_admin, _guard, operations) => {
      const guard = createSqliteTenantMembershipGuard(db, operations, owner, () => 100);
      const pause = gate(),
        blocked = operations.run(() => pause.wait);
      const pending = guard.assertCurrent(current);
      Reflect.set(current, 'accountId', 'bob');
      Reflect.set(current.source, 'connection', 'other');
      Reflect.set(current, 'roles', ['manager']);
      Reflect.set(owner, 'storeId', 'other');
      Reflect.set(owner.source, 'connection', 'other');
      pause.release();
      await blocked;
      await pending;
    });
  });
});

test('retained facades refuse after transaction completion even inside another transaction', async () => {
  await fixture(async (db) => {
    await seed(db);
    const current = evidence(db);
    let retainedAdmin!: Administration, retainedGuard!: Guard;
    await transaction(db, async (admin, guard) => {
      retainedAdmin = admin;
      retainedGuard = guard;
    });
    await assert.rejects(retainedAdmin.putTenant({ ...tenant(), expectedVersion: '1' }), /no longer active/);
    await assert.rejects(retainedGuard.assertCurrent(current), /no longer active/);
    await transaction(db, async () => {
      await assert.rejects(retainedAdmin.putMembership({ ...membership(), expectedVersion: '1' }), /no longer active/);
      await assert.rejects(retainedGuard.assertCurrent(current), /no longer active/);
    });
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '1');
  });
});

for (const table of [tables.tenant, tables.membership])
  test(`DDL attestation rejects NOCASE identity substitution on ${table}`, async () => {
    await fixture(async (db, path) => {
      const ddl = db.prepare('SELECT sql FROM main.sqlite_schema WHERE name = ?').get(table)?.sql;
      assert.equal(typeof ddl, 'string');
      db.exec(`DROP TABLE main."${table}"`);
      db.exec((ddl as string).replaceAll('COLLATE BINARY', 'COLLATE NOCASE'));
      const before = catalog(db);
      await denied(() => assertSqliteTenantStore(db, binding()));
      await denied(() => provisionSqliteTenantStore(path, binding()));
      assert.deepEqual(catalog(db), before);
    });
  });

test('the partial live-grant index is attested, not merely a matching set of columns', async () => {
  await fixture(async (db, path) => {
    const index = db
      .prepare("SELECT name, sql FROM main.sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
      .get(tables.membership);
    assert.ok(index && typeof index.name === 'string' && typeof index.sql === 'string');
    db.exec(`DROP INDEX main."${index.name}"`);
    db.exec(index.sql.replace("status != 'revoked'", "status = 'active'"));
    await denied(() => assertSqliteTenantStore(db, binding()));
    await denied(() => provisionSqliteTenantStore(path, binding()));
  });
});

for (const schema of ['main', 'temp']) {
  for (const kind of ['TABLE', 'VIEW', 'TRIGGER', 'INDEX'])
    test(`unknown reserved ${schema} ${kind} refuses`, async () => {
      await fixture(async (db) => {
        const name = `${schema}."__MISTRI_TENANT_FUTURE"`;
        if (kind === 'TABLE') db.exec(`CREATE TABLE ${name}(id TEXT)`);
        if (kind === 'VIEW') db.exec(`CREATE VIEW ${name} AS SELECT 1`);
        if (kind === 'TRIGGER') db.exec(`CREATE TRIGGER ${name} AFTER UPDATE ON business_record BEGIN SELECT 1; END`);
        if (kind === 'INDEX') {
          db.exec(`CREATE TABLE ${schema}.scratch(id TEXT); CREATE INDEX ${name} ON scratch(id)`);
        }
        await denied(() => assertSqliteTenantStore(db, binding()));
        await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
      });
    });
}

test('partial preexisting private schema refuses provisioning without filling missing tables', async () => {
  await fixture(async (db, path) => {
    db.exec(`CREATE TABLE "${tables.meta}"(singleton INTEGER, version INTEGER)`);
    const before = catalog(db);
    await denied(() => provisionSqliteTenantStore(path, binding()));
    assert.deepEqual(catalog(db), before);
  }, false);
});

test('attached lookalike tables cannot attest or provision the missing main store during a read', async () => {
  await fixture(async (db) => {
    db.exec("ATTACH DATABASE ':memory:' AS attached");
    for (const table of Object.values(tables)) db.exec(`CREATE TABLE attached."${table}"(id TEXT)`);
    const before = catalog(db);
    await denied(() => assertSqliteTenantStore(db, binding()));
    await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
    assert.deepEqual(catalog(db), before);
  }, false);
});

test('foreign key enforcement and durable metadata are required without automatic repair', async () => {
  await fixture(async (db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    await denied(() => assertSqliteTenantStore(db, binding()));
    await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
    assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 0);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`DELETE FROM main."${tables.meta}"`);
    await denied(() => assertSqliteTenantStore(db, binding()));
    assert.equal(count(db, tables.meta), 0);
  });
});

for (const status of ['suspended', 'closed'] as const) {
  test(`tenant creation cannot start ${status}; existing ${status} tenant permits revocation only`, async () => {
    await fixture(async (db) => {
      await denied(() =>
        transaction(db, async (admin) => {
          await admin.putTenant({ ...tenant(), status });
        }),
      );
      assert.equal(count(db, tables.tenant), 0);
      await seed(db);
      await transaction(db, async (admin) => {
        await admin.putTenant({ ...tenant(), status, expectedVersion: '1' });
      });
      await denied(() =>
        transaction(db, async (admin) => {
          await admin.putMembership({ ...membership(), roles: ['manager'], expectedVersion: '1' });
        }),
      );
      await denied(() =>
        transaction(db, async (admin) => {
          await admin.putMembership({ ...membership(), membershipId: 'new-grant', accountId: 'bob', status: 'invited' });
        }),
      );
      await transaction(db, async (admin) => {
        await admin.putMembership({ ...membership(), status: 'revoked', expectedVersion: '1' });
      });
      assert.equal(readSqliteTenantMembership(db, binding(), lookup()), null);
      assert.deepEqual(
        { ...db.prepare(`SELECT id, status, version FROM main."${tables.membership}"`).get() },
        { id: 'grant-1', status: 'revoked', version: '2' },
      );
      if (status === 'suspended') {
        await transaction(db, async (admin) => {
          await admin.putTenant({ ...tenant(), expectedVersion: '2' });
        });
        await transaction(db, async (admin) => {
          await admin.putMembership({ ...membership(), membershipId: 'grant-2' });
        });
        assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.tenantVersion, '3');
      }
    });
  });
}

test('membership creation cannot be revoked and active grants cannot revert to invited', async () => {
  await fixture(async (db) => {
    await transaction(db, async (admin) => {
      await admin.putTenant(tenant());
    });
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putMembership({ ...membership(), status: 'revoked' });
      }),
    );
    await transaction(db, async (admin) => {
      await admin.putMembership(membership());
    });
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putMembership({ ...membership(), status: 'invited', expectedVersion: '1' });
      }),
    );
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '1');
  });
});

for (const field of ['accountId', 'tenantId'] as const)
  test(`CAS cannot reassign an existing grant's ${field}`, async () => {
    await fixture(async (db) => {
      await seed(db);
      await transaction(db, async (admin) => {
        await admin.putTenant({ ...tenant(), tenantId: 'south' });
      });
      await denied(() =>
        transaction(db, async (admin) => {
          await admin.putMembership({ ...membership(), [field]: field === 'accountId' ? 'bob' : 'south', expectedVersion: '1' });
        }),
      );
      assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '1');
    });
  });

test('CAS revisions increment beyond safe integers without coercion and refuse 128-digit overflow', async () => {
  await fixture(async (db) => {
    await seed(db);
    const large = '9007199254740993';
    db.prepare(`UPDATE main."${tables.tenant}" SET version = ?`).run(large);
    db.prepare(`UPDATE main."${tables.membership}" SET version = ?`).run(large);
    await transaction(db, async (admin) => {
      await admin.putTenant({ ...tenant(), expectedVersion: large });
      await admin.putMembership({ ...membership(), expectedVersion: large });
    });
    const found = readSqliteTenantMembership(db, binding(), lookup());
    assert.equal(found?.tenantVersion, '9007199254740994');
    assert.equal(found?.membershipVersion, '9007199254740994');
    const maximum = '9'.repeat(128);
    db.prepare(`UPDATE main."${tables.tenant}" SET version = ?`).run(maximum);
    db.prepare(`UPDATE main."${tables.membership}" SET version = ?`).run(maximum);
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putTenant({ ...tenant(), expectedVersion: maximum });
      }),
    );
    await denied(() =>
      transaction(db, async (admin) => {
        await admin.putMembership({ ...membership(), expectedVersion: maximum });
      }),
    );
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.tenantVersion, maximum);
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, maximum);
  });
});

for (const expectedVersion of ['', '0', '01', '-1', '1.0', '1e0', ' 1', '1'.repeat(129), 1, undefined]) {
  test(`malformed CAS revision ${JSON.stringify(expectedVersion)} poisons administration`, async () => {
    await fixture(async (db) => {
      await seed(db);
      for (const target of ['tenant', 'membership'])
        await denied(() =>
          transaction(db, async (admin) => {
            const change = { ...(target === 'tenant' ? tenant() : membership()), expectedVersion };
            await denied(() =>
              target === 'tenant' ? admin.putTenant(change as TenantInput) : admin.putMembership(change as MembershipInput),
            );
          }),
        );
      assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '1');
    });
  });
}

for (const [name, mutate] of [
  [
    'tenant revision',
    (db: DatabaseSync) => {
      db.exec(`UPDATE main."${tables.tenant}" SET version = '01'`);
    },
  ],
  [
    'membership revision',
    (db: DatabaseSync) => {
      db.exec(`UPDATE main."${tables.membership}" SET version = '0'`);
    },
  ],
  [
    'role shape',
    (db: DatabaseSync) => {
      db.exec(`UPDATE main."${tables.membership}" SET roles_json = '{"admin":true}'`);
    },
  ],
  [
    'duplicate roles',
    (db: DatabaseSync) => {
      db.exec(`UPDATE main."${tables.membership}" SET roles_json = '["admin","admin"]'`);
    },
  ],
] as const)
  test(`malformed stored ${name} refuses without leaving the read transaction open`, async () => {
    await fixture(async (db) => {
      await seed(db);
      mutate(db);
      await denied(() => readSqliteTenantMembership(db, binding(), lookup()));
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare('SELECT value FROM business_record').get()?.value, 'original');
    });
  });

test('guard observes revocation, regrant identity, and tenant suspension after evidence issuance', async () => {
  await fixture(async (db) => {
    await seed(db);
    const old = evidence(db);
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), status: 'revoked', expectedVersion: '1' });
    });
    await denied(() =>
      transaction(db, async (_admin, guard) => {
        await guard.assertCurrent(old);
      }),
    );
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), membershipId: 'grant-2' });
    });
    await denied(() =>
      transaction(db, async (_admin, guard) => {
        await guard.assertCurrent(old);
      }),
    );
    const current = evidence(db);
    await transaction(db, async (_admin, guard) => {
      await guard.assertCurrent(current);
    });
    await transaction(db, async (admin) => {
      await admin.putTenant({ ...tenant(), status: 'suspended', expectedVersion: '1' });
    });
    await denied(() =>
      transaction(db, async (_admin, guard) => {
        await guard.assertCurrent(current);
      }),
    );
    await transaction(db, async (admin) => {
      await admin.putTenant({ ...tenant(), expectedVersion: '2' });
    });
    await denied(() =>
      transaction(db, async (_admin, guard) => {
        await guard.assertCurrent(current);
      }),
    );
  });
});

test('guard compares exact role membership independent of order, without attesting deployment lifetime', async () => {
  await fixture(async (db) => {
    await seed(db);
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), roles: ['reviewer', 'manager'], expectedVersion: '1' });
    });
    const current = evidence(db);
    const reordered = { ...current, deployment: 'another-host-owned-generation', roles: [...current.roles].reverse() };
    await transaction(db, async (_admin, guard) => {
      await guard.assertCurrent(reordered);
    });
  });
});

test('factories cannot silently start transactions or allow queued work to autocommit after rollback', async () => {
  await fixture(async (db) => {
    await seed(db);
    const current = evidence(db);
    for (const kind of ['admin', 'guard']) {
      const operations = new TransactionOperations();
      const admin = createSqliteTenantAdministration(db, operations, binding());
      const guard = createSqliteTenantMembershipGuard(db, operations, binding(), () => 100);
      await denied(() => (kind === 'admin' ? admin.putTenant({ ...tenant(), expectedVersion: '1' }) : guard.assertCurrent(current)));
      await denied(() => operations.finish());
      assert.equal(db.isTransaction, false);
    }
    db.exec('BEGIN');
    const operations = new TransactionOperations();
    const admin = createSqliteTenantAdministration(db, operations, binding());
    const pause = gate(),
      blocked = operations.run(() => pause.wait);
    const pending = admin.putMembership({ ...membership(), expectedVersion: '1' });
    db.exec('ROLLBACK');
    pause.release();
    await blocked;
    await denied(() => pending);
    await denied(() => operations.finish());
    assert.equal(readSqliteTenantMembership(db, binding(), lookup())?.membershipVersion, '1');
  });
});

for (const target of ['tenant', 'membership', 'guard'] as const) {
  for (const kind of ['proxy', 'getter', 'symbol', 'cycle', 'extra field'] as const) {
    test(`${target} ${kind} capture refuses without executing host data and poisons caught failures`, async () => {
      await fixture(async (db) => {
        await seed(db);
        const current = evidence(db);
        let executions = 0;
        const fail = (): never => {
          executions++;
          throw new Error(secret);
        };
        let value: object =
          target === 'tenant'
            ? { ...tenant(), expectedVersion: '1' }
            : target === 'membership'
              ? { ...membership(), expectedVersion: '1' }
              : current;
        if (kind === 'proxy') value = new Proxy(value, { get: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail });
        if (kind === 'getter') Object.defineProperty(value, 'tenantId', { enumerable: true, get: fail });
        if (kind === 'symbol') Reflect.set(value, Symbol(secret), true);
        if (kind === 'cycle') Reflect.set(value, 'cycle', value);
        if (kind === 'extra field') Reflect.set(value, 'untrustedGrant', secret);
        let later = false;
        await denied(() =>
          transaction(db, async (admin, guard, operations) => {
            await operations.run(async () => {
              db.exec("UPDATE business_record SET value = 'must-rollback'");
            });
            await denied(() =>
              target === 'tenant'
                ? admin.putTenant(value as TenantInput)
                : target === 'membership'
                  ? admin.putMembership(value as MembershipInput)
                  : guard.assertCurrent(value as TenantMembershipEvidence),
            );
            await denied(() =>
              operations.run(async () => {
                later = true;
              }),
            );
          }),
        );
        assert.equal(executions, 0);
        assert.equal(later, false);
        assert.equal(db.prepare('SELECT value FROM business_record').get()?.value, 'original');
      });
    });
  }
}

for (const roles of [
  ['reviewer', 'reviewer'],
  [''],
  [' trailing'],
  ['a'.repeat(257)],
  [1],
  Array.from({ length: 257 }, (_, i) => `role-${i}`),
])
  test(`invalid administration roles ${JSON.stringify(roles).slice(0, 80)} refuse`, async () => {
    await fixture(async (db) => {
      await seed(db);
      await denied(() =>
        transaction(db, async (admin) => {
          await denied(() => admin.putMembership({ ...membership(), roles, expectedVersion: '1' } as MembershipInput));
        }),
      );
      assert.deepEqual(readSqliteTenantMembership(db, binding(), lookup())?.roles, ['reviewer']);
    });
  });

test('generic store roles permit the full bounded host ceiling; issuer allowlists remain separate', async () => {
  await fixture(async (db) => {
    await seed(db);
    const roles = Array.from({ length: 256 }, (_, i) => `role-${i}`);
    await transaction(db, async (admin) => {
      await admin.putMembership({ ...membership(), roles, expectedVersion: '1' });
    });
    assert.deepEqual(readSqliteTenantMembership(db, binding(), lookup())?.roles, roles);
  });
});

test('hostile binding and lookup accessors are never invoked or used to migrate', async () => {
  await fixture(async (db, path) => {
    let calls = 0;
    const owner = binding();
    Object.defineProperty(owner.source, 'connection', {
      enumerable: true,
      get() {
        calls++;
        throw new Error(secret);
      },
    });
    await denied(() => provisionSqliteTenantStore(path, owner));
    await denied(() => assertSqliteTenantStore(db, owner));
    await denied(() => createSqliteTenantAdministration(db, new TransactionOperations(), owner));
    await denied(() => createSqliteTenantMembershipGuard(db, new TransactionOperations(), owner));
    const query = lookup();
    Object.defineProperty(query, 'accountId', {
      enumerable: true,
      get() {
        calls++;
        throw new Error(secret);
      },
    });
    await denied(() => readSqliteTenantMembership(db, binding(), query));
    assert.equal(calls, 0);
    assert.equal(db.isTransaction, false);
    assert.doesNotThrow(() => assertSqliteTenantStore(db, binding()));
  });
});
