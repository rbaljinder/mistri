import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { assertSqliteCommandJournal, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  ADMINISTRATION_JOURNAL_TABLES,
  assertSqliteTenantAdministrationJournal,
  provisionSqliteTenantAdministrationJournal,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import {
  assertSqliteTenantStore,
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  TENANT_TABLES,
  type TenantStoreBinding,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  INVITATION_TABLES as tables,
  assertSqliteTenantInvitations,
  captureStoredTenantInvitation,
  createSqliteTenantInvitations,
  provisionSqliteTenantInvitations,
  type StoredTenantInvitation,
} from '../packages/mistri/src/server/tenant/tenantInvitationStore.js';

const owner = (): TenantStoreBinding => ({ appId: 'app', storeId: 'store', source: { id: 'business', connection: 'alias' } });
const invitationId = '36c77f92-cf69-412d-ade3-3971490fb83a';
const membershipId = '21a53156-f274-4622-8a68-3f0b82c2c45a';
const row = (): StoredTenantInvitation => ({
  invitationId,
  version: '1',
  tenantId: 'north',
  membershipId,
  accountId: 'recipient',
  inviterId: 'operator',
  issuanceOperation: 'issueInvitation',
  roles: ['reader', 'writer'],
  expectedTenantVersion: '1',
  policyId: 'operators',
  policyVersion: 'v1',
  createdAt: 100,
  redeemUntil: 200,
  validUntil: 300,
  status: 'pending',
  digest: 'ab'.repeat(32),
});
type Store = ReturnType<typeof createSqliteTenantInvitations>;
const denied = (work: () => unknown) =>
  assert.rejects(
    async () => work(),
    (error: unknown) => {
      assert.ok(error instanceof TenantContextError);
      assert.equal(error.message, 'The tenant context could not be verified.');
      assert.equal('cause' in error, false);
      return true;
    },
  );
function image(db: DatabaseSync) {
  return {
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY name').all(),
    rows: db
      .prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM main."${name}" ORDER BY rowid`).all()]),
  };
}
async function fixture(
  work: (db: DatabaseSync, path: string) => unknown | Promise<unknown>,
  provision = true,
  prerequisite: 'all' | 'tenant' | 'none' = 'all',
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-invitation-store-'));
  const path = join(directory, 'business.db');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec("CREATE TABLE business_record(id TEXT PRIMARY KEY, value TEXT); INSERT INTO business_record VALUES ('one', 'original')");
    db.close();
    db = undefined;
    if (prerequisite !== 'none') provisionSqliteTenantStore(path, owner());
    if (prerequisite === 'all') provisionSqliteTenantAdministrationJournal(path, owner());
    migrateSqliteCommandJournal(path);
    if (provision) provisionSqliteTenantInvitations(path, owner());
    db = new DatabaseSync(path);
    await work(db, path);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
async function transaction<T>(
  db: DatabaseSync,
  work: (store: Store, operations: TransactionOperations) => Promise<T>,
  verify?: () => void,
): Promise<T> {
  db.exec('BEGIN IMMEDIATE');
  const operations = new TransactionOperations();
  let active = true;
  try {
    const store = createSqliteTenantInvitations(db, operations, owner(), () => {
      if (!active) throw new Error('retired private owner');
      verify?.();
    });
    const result = await work(store, operations);
    await operations.finish();
    active = false;
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await operations.finish();
    } catch {
      /* Retain original failure. */
    }
    active = false;
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
function gate() {
  let release!: () => void;
  return {
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

test('provisioning is separately attested v1, idempotent, and preserves all existing DDL and rows', async () => {
  await fixture(async (db, path) => {
    const before = image(db);
    assert.deepEqual(provisionSqliteTenantInvitations(path, owner()), { version: 1, provisioned: true });
    const after = image(db);
    assert.deepEqual(
      after.schema.filter((entry) => !String(entry.tbl_name).startsWith('__mistri_invitation_')),
      before.schema,
    );
    assert.deepEqual(
      after.rows.filter(([name]) => !String(name).startsWith('__mistri_invitation_')),
      before.rows,
    );
    assertSqliteTenantStore(db, owner());
    assertSqliteTenantAdministrationJournal(db, owner());
    assertSqliteCommandJournal(db);
    assertSqliteTenantInvitations(db, owner());
    const bytes = readFileSync(path);
    assert.deepEqual(provisionSqliteTenantInvitations(path, owner()), { version: 1, provisioned: false });
    assert.deepEqual(readFileSync(path), bytes);
    assert.deepEqual(image(db), after);
    const rotated = { ...owner(), source: { id: 'business', connection: 'new-alias' } };
    assert.deepEqual(provisionSqliteTenantInvitations(path, rotated), { version: 1, provisioned: false });
    await transaction(db, async (store) => {
      assert.equal(await store.read(invitationId), null);
      assert.equal(await store.forMembership(membershipId), null);
      assert.deepEqual(Object.keys(store).sort(), ['forMembership', 'insert', 'read', 'transition']);
      assert.ok(Object.isFrozen(store));
    });
  }, false);
});

test('missing files, directories and absent prerequisites refuse without creation or adoption', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-invitation-missing-'));
  try {
    const missing = join(directory, 'missing.db');
    await denied(() => provisionSqliteTenantInvitations(missing, owner()));
    await denied(() => provisionSqliteTenantInvitations(directory, owner()));
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const prerequisite of ['none', 'tenant'] as const)
    await fixture(
      async (db, path) => {
        const before = image(db),
          bytes = readFileSync(path);
        await denied(() => provisionSqliteTenantInvitations(path, owner()));
        assert.deepEqual(image(db), before);
        assert.deepEqual(readFileSync(path), bytes);
      },
      false,
      prerequisite,
    );
});

for (const mutation of [
  `DROP TABLE "${tables.invitation}"`,
  `ALTER TABLE "${tables.invitation}" ADD COLUMN extra TEXT`,
  `PRAGMA ignore_check_constraints = ON; UPDATE "${tables.meta}" SET version = 2; PRAGMA ignore_check_constraints = OFF`,
  `DELETE FROM "${tables.meta}"`,
  `UPDATE "${tables.meta}" SET app_id = 'foreign'`,
  `UPDATE "${ADMINISTRATION_JOURNAL_TABLES.meta}" SET store_id = 'foreign'`,
  `UPDATE "${TENANT_TABLES.meta}" SET source_id = 'foreign'`,
])
  test(`provisioning refuses drift unchanged: ${mutation.slice(0, 80)}`, async () => {
    await fixture(async (db, path) => {
      db.exec(mutation);
      const before = image(db),
        bytes = readFileSync(path);
      await denied(() => provisionSqliteTenantInvitations(path, owner()));
      await denied(() => assertSqliteTenantInvitations(db, owner()));
      assert.deepEqual(image(db), before);
      assert.deepEqual(readFileSync(path), bytes);
    });
  });

for (const field of ['appId', 'source', 'storeId'] as const)
  test(`foreign ${field} binding refuses unchanged`, async () => {
    await fixture(async (db, path) => {
      const wrong = { ...owner(), [field]: field === 'source' ? { id: 'foreign', connection: 'alias' } : 'foreign' };
      const before = image(db),
        bytes = readFileSync(path);
      await denied(() => provisionSqliteTenantInvitations(path, wrong));
      await denied(() => assertSqliteTenantInvitations(db, wrong));
      await denied(() =>
        transaction(db, async (_store, operations) => {
          await createSqliteTenantInvitations(db, operations, wrong).read(invitationId);
        }),
      );
      assert.deepEqual(image(db), before);
      assert.deepEqual(readFileSync(path), bytes);
    });
  });

for (const schema of ['main', 'temp'])
  for (const kind of ['table', 'view', 'index', 'trigger']) {
    test(`${schema} ${kind} namespace collisions refuse without repair`, async () => {
      await fixture(async (db, path) => {
        const name = `${schema}."__MISTRI_INVITATION_collision"`;
        const sql =
          kind === 'table'
            ? `CREATE TABLE ${name}(id TEXT)`
            : kind === 'view'
              ? `CREATE VIEW ${name} AS SELECT 1`
              : kind === 'index'
                ? `CREATE INDEX ${name} ON "${tables.invitation}"(account_id)`
                : `CREATE ${schema === 'temp' ? 'TEMP ' : ''}TRIGGER "__MISTRI_INVITATION_collision" AFTER INSERT ON main."${tables.invitation}" BEGIN SELECT 1; END`;
        // SQLite forbids a TEMP index on a main table; a same-name TEMP table also
        // proves shadow refusal before constructing that index.
        if (schema === 'temp' && kind === 'index') db.exec(`CREATE TEMP TABLE "${tables.invitation}"(account_id TEXT)`);
        db.exec(sql);
        const before = image(db),
          bytes = readFileSync(path);
        await denied(() => assertSqliteTenantInvitations(db, owner()));
        await denied(() =>
          transaction(db, async (store) => {
            await store.read(invitationId);
          }),
        );
        if (schema === 'main') await denied(() => provisionSqliteTenantInvitations(path, owner()));
        assert.deepEqual(image(db), before);
        assert.deepEqual(readFileSync(path), bytes);
      });
    });
  }

test('a collision in an otherwise absent namespace is not adopted', async () => {
  await fixture(async (db, path) => {
    db.exec('CREATE VIEW "__MISTRI_INVITATION_meta" AS SELECT 1');
    const before = image(db),
      bytes = readFileSync(path);
    await denied(() => provisionSqliteTenantInvitations(path, owner()));
    assert.deepEqual(image(db), before);
    assert.deepEqual(readFileSync(path), bytes);
  }, false);
});

for (const status of ['accepted', 'revoked'] as const)
  test(`pending CAS becomes terminal ${status} with immutable meaning`, async () => {
    await fixture(async (db) => {
      const issued = { ...row(), issuanceOperation: 'reissueInvitation' as const, roles: ['writer', 'reader'] };
      await transaction(db, async (store) => {
        await store.insert(issued);
        const stored = await store.read(invitationId);
        assert.deepEqual(stored, { ...issued, roles: ['reader', 'writer'] });
        assert.ok(Object.isFrozen(stored));
        assert.ok(Object.isFrozen(stored!.roles));
        assert.deepEqual(await store.forMembership(membershipId), stored);
        await store.transition({ invitationId, expectedVersion: '1', status });
        assert.deepEqual(await store.read(invitationId), { ...stored, status, version: '2' });
      });
      const before = image(db);
      for (const expectedVersion of ['1', '2'])
        for (const next of ['accepted', 'revoked'] as const) {
          await denied(() =>
            transaction(db, async (store) => {
              await store.transition({ invitationId, expectedVersion, status: next });
            }),
          );
        }
      assert.deepEqual(image(db), before);
    });
  });

test('missing/stale CAS and duplicate invitation/member identities never replace meaning', async () => {
  await fixture(async (db) => {
    await transaction(db, async (store) => {
      await store.insert(row());
    });
    const before = image(db);
    for (const change of [
      { invitationId, expectedVersion: '2' },
      { invitationId: randomUUID(), expectedVersion: '1' },
    ]) {
      await denied(() =>
        transaction(db, async (store) => {
          await store.transition({ ...change, status: 'accepted' });
        }),
      );
    }
    for (const duplicate of [
      { ...row(), accountId: 'other' },
      { ...row(), invitationId: randomUUID() },
    ]) {
      await denied(() =>
        transaction(db, async (store) => {
          await store.insert(duplicate);
        }),
      );
    }
    assert.deepEqual(image(db), before);
  });
});

test('revisions use exact BigInt arithmetic through 128 digits and refuse overflow', async () => {
  await fixture(async (db) => {
    await transaction(db, async (store) => {
      await store.insert(row());
    });
    for (const revision of ['9007199254740993', '1' + '0'.repeat(127)]) {
      db.prepare(`UPDATE "${tables.invitation}" SET status = 'pending', version = ?`).run(revision);
      await transaction(db, async (store) => {
        await store.transition({ invitationId, expectedVersion: revision, status: 'accepted' });
        assert.equal((await store.read(invitationId))?.version, String(BigInt(revision) + 1n));
      });
    }
    db.prepare(`UPDATE "${tables.invitation}" SET status = 'pending', version = ?`).run('9'.repeat(128));
    const before = image(db);
    await denied(() =>
      transaction(db, async (store) => {
        await store.transition({ invitationId, expectedVersion: '9'.repeat(128), status: 'accepted' });
      }),
    );
    assert.deepEqual(image(db), before);
  });
});

test('attestation tolerates both midpoints of linked atomic transitions; returned rows remain validated', async () => {
  await fixture(async (db) => {
    await transaction(db, async (store, operations) => {
      const admin = createSqliteTenantAdministration(db, operations, owner());
      await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
      await store.insert(row());
      assertSqliteTenantInvitations(db, owner());
      await admin.putMembership({
        membershipId,
        tenantId: 'north',
        accountId: 'recipient',
        status: 'invited',
        roles: ['reader', 'writer'],
        validUntil: 300,
        expectedVersion: null,
      });
      await store.transition({ invitationId, expectedVersion: '1', status: 'accepted' });
      assert.equal((await store.forMembership(membershipId))?.status, 'accepted');
      await admin.putMembership({
        membershipId,
        tenantId: 'north',
        accountId: 'recipient',
        status: 'active',
        roles: ['reader', 'writer'],
        validUntil: 300,
        expectedVersion: '1',
      });
    });
    assert.equal(db.prepare(`SELECT status FROM "${TENANT_TABLES.membership}"`).get()?.status, 'active');
  });
});

const badFields: [string, unknown][] = [
  ['invitationId', invitationId.toUpperCase()],
  ['invitationId', 'not-a-uuid'],
  ['membershipId', 'legacy-member'],
  ['invitationId', invitationId.replace('-412d-', '-712d-')],
  ['membershipId', membershipId.replace('-4622-', '-1622-')],
  ['invitationId', invitationId + '\n'],
  ['membershipId', membershipId + '\n'],
  ['version', '0'],
  ['version', '01'],
  ['version', 1],
  ['version', '1'.repeat(129)],
  ['expectedTenantVersion', '-1'],
  ['version', '1\n'],
  ['expectedTenantVersion', '1\n'],
  ['tenantId', 'north\n'],
  ['digest', 'ab'.repeat(32) + '\n'],
  ['tenantId', 'North'],
  ['accountId', ''],
  ['accountId', ' x'],
  ['accountId', 'x\0hidden'],
  ['inviterId', '\ud800'],
  ['accountId', 'é'.repeat(513)],
  ['policyId', 'x'.repeat(257)],
  ['policyVersion', undefined],
  ['issuanceOperation', 'grantMembership'],
  ['roles', []],
  ['roles', ['reader', 'reader']],
  ['roles', ['']],
  ['roles', ['a\0b']],
  ['roles', ['\udfff']],
  ['roles', Array.from({ length: 257 }, (_, index) => `role${index}`)],
  ['createdAt', -1],
  ['createdAt', 200],
  ['redeemUntil', 100],
  ['redeemUntil', 301],
  ['redeemUntil', 1.5],
  ['validUntil', Number.MAX_SAFE_INTEGER + 1],
  ['validUntil', Infinity],
  ['validUntil', '300'],
  ['status', 'invited'],
  ['digest', 'AB'.repeat(32)],
  ['digest', 'a'.repeat(63)],
  ['digest', 'g'.repeat(64)],
];
for (const [field, value] of badFields)
  test(`pure capture refuses malformed ${field}: ${String(value).slice(0, 35)}`, () => {
    assert.throws(() => captureStoredTenantInvitation({ ...row(), [field]: value }), TenantContextError);
  });

test('capture is detached, exact, frozen and normalizes bounded roles without hooks', () => {
  const input = { ...row(), roles: ['writer', 'reader'] };
  const captured = captureStoredTenantInvitation(input);
  input.roles[0] = 'changed';
  assert.deepEqual(captured.roles, ['reader', 'writer']);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.roles));
  const maximum = captureStoredTenantInvitation({
    ...row(),
    roles: Array.from({ length: 256 }, (_, i) => `r${i}`),
    expectedTenantVersion: '9'.repeat(128),
    redeemUntil: Number.MAX_SAFE_INTEGER,
    validUntil: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(maximum.roles.length, 256);
  for (const field of Object.keys(row())) {
    const missing = { ...row() } as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => captureStoredTenantInvitation(missing), TenantContextError);
  }
  let hooks = 0;
  const hook = () => {
    hooks++;
    throw new Error('private input hook');
  };
  const getter = Object.defineProperty({ ...row() }, 'roles', { get: hook, enumerable: true });
  const arrayGetter = Object.defineProperty(['reader'], '0', { get: hook, enumerable: true });
  const cycle = { ...row(), extra: null as unknown };
  cycle.extra = cycle;
  const revoked = Proxy.revocable(row(), {});
  revoked.revoke();
  for (const bad of [
    getter,
    { ...row(), roles: arrayGetter },
    new Proxy(row(), { get: hook, getPrototypeOf: hook, ownKeys: hook }),
    // Deliberately hostile data must never be treated as an awaitable.
    revoked.proxy,
    { ...row(), toJSON: hook },
    // eslint-disable-next-line unicorn/no-thenable
    { ...row(), then: hook },
    { ...row(), [Symbol('private')]: true },
    Object.create(row()),
    Object.defineProperty({ ...row() }, 'hidden', { value: true }),
    { ...row(), roles: Array(2) },
    { ...row(), roles: Object.assign(['reader'], { extra: true }) },
    cycle,
  ]) {
    assert.throws(() => captureStoredTenantInvitation(bad), TenantContextError);
  }
  assert.equal(hooks, 0);
});

test('insert requires initial pending v1 and transition refuses extra mutable meaning', async () => {
  await fixture(async (db) => {
    for (const invalid of [
      { ...row(), status: 'accepted' as const },
      { ...row(), status: 'revoked' as const },
      { ...row(), version: '2' },
    ]) {
      await denied(() =>
        transaction(db, async (store) => {
          await store.insert(invalid);
        }),
      );
    }
    await transaction(db, async (store) => {
      await store.insert(row());
    });
    const before = image(db);
    for (const extra of [
      'roles',
      'digest',
      'issuanceOperation',
      'membershipId',
      'tenantId',
      'accountId',
      'inviterId',
      'createdAt',
      'validUntil',
    ]) {
      await denied(() =>
        transaction(db, async (store) => {
          await store.transition({ invitationId, expectedVersion: '1', status: 'accepted', [extra]: 'changed' });
        }),
      );
    }
    assert.deepEqual(image(db), before);
  });
});

for (const [column, value] of [
  ['roles_json', '["writer","reader"]'],
  ['roles_json', '[ "reader", "writer" ]'],
  ['roles_json', '["reader","reader"]'],
  ['roles_json', '["reader\\u0000hidden"]'],
  ['roles_json', '["reader","writer"]\0ignored'],
  ['roles_json', '{}'],
  ['roles_json', '[1]'],
  ['roles_json', '['],
  ['account_id', 'recipient\0hidden'],
  ['inviter_id', 'operator\0hidden'],
  ['digest', 'ab'.repeat(32) + '\0hidden'],
  ['issuance_operation', 'issueInvitation\0hidden'],
  ['issuance_operation', 'grantMembership'],
  ['version', '01'],
  ['version', '1\0hidden'],
  ['expected_tenant_version', '0'],
  ['membership_id', 'legacy'],
  ['policy_version', 'v1\n'],
  ['created_at', 1.5],
  ['valid_until', 199],
] as const)
  test(`stored corruption refuses lookup and transition: ${column} ${JSON.stringify(value).slice(0, 50)}`, async () => {
    await fixture(async (db) => {
      await transaction(db, async (store) => {
        await store.insert(row());
      });
      db.exec('PRAGMA ignore_check_constraints = ON');
      db.prepare(`UPDATE "${tables.invitation}" SET ${column} = ?`).run(value);
      db.exec('PRAGMA ignore_check_constraints = OFF');
      assertSqliteTenantInvitations(db, owner());
      await transaction(db, async (store) => {
        assert.equal(await store.read(randomUUID()), null);
      });
      await denied(() =>
        transaction(db, async (store) => {
          await store.read(invitationId);
        }),
      );
      if (column !== 'membership_id')
        await denied(() =>
          transaction(db, async (store) => {
            await store.forMembership(membershipId);
          }),
        );
      await denied(() =>
        transaction(db, async (store) => {
          await store.transition({ invitationId, expectedVersion: '1', status: 'accepted' });
        }),
      );
    });
  });

test('persisted NUL metadata cannot impersonate the correct binding', async () => {
  await fixture(async (db, path) => {
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare(`UPDATE "${tables.meta}" SET app_id = ?`).run('app\0foreign');
    db.exec('PRAGMA ignore_check_constraints = OFF');
    const bytes = readFileSync(path);
    await denied(() => assertSqliteTenantInvitations(db, owner()));
    await denied(() => provisionSqliteTenantInvitations(path, owner()));
    assert.deepEqual(readFileSync(path), bytes);
  });
});

test('caught malformed and SQL failures poison the shared queue and roll back earlier work', async () => {
  await fixture(async (db) => {
    await transaction(db, async (store) => {
      await store.insert(row());
    });
    const before = image(db);
    let hooks = 0;
    const getter = Object.defineProperty({ ...row() }, 'digest', {
      get() {
        hooks++;
        return 'bad';
      },
      enumerable: true,
    });
    for (const fail of [
      (store: Store) => store.insert(getter),
      (store: Store) => store.insert(row()),
      (store: Store) => store.read('bad'),
      (store: Store) => store.forMembership('bad'),
      (store: Store) => store.transition({ invitationId, expectedVersion: '2', status: 'accepted' }),
    ]) {
      let later = false;
      await denied(() =>
        transaction(db, async (store, operations) => {
          await operations.run(async () => {
            db.exec("UPDATE business_record SET value = 'rollback'");
          });
          await denied(() => fail(store));
          await denied(() =>
            operations.run(async () => {
              later = true;
            }),
          );
        }),
      );
      assert.equal(later, false);
      assert.deepEqual(image(db), before);
    }
    assert.equal(hooks, 0);
  });
});

test('owner failure rolls back invitation and membership together; fire-and-forget failures are drained', async () => {
  await fixture(async (db) => {
    const before = image(db);
    await assert.rejects(
      transaction(db, async (store, operations) => {
        const admin = createSqliteTenantAdministration(db, operations, owner());
        await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
        await admin.putMembership({
          membershipId,
          tenantId: 'north',
          accountId: 'recipient',
          status: 'invited',
          roles: ['reader', 'writer'],
          validUntil: 300,
          expectedVersion: null,
        });
        await store.insert(row());
        await store.transition({ invitationId, expectedVersion: '1', status: 'accepted' });
        throw new Error('owner failure');
      }),
      /owner failure/,
    );
    assert.deepEqual(image(db), before);
    await denied(() =>
      transaction(db, async (store) => {
        void store.insert(row());
        void store.transition({ invitationId, expectedVersion: '99', status: 'accepted' });
      }),
    );
    assert.deepEqual(image(db), before);
  });
});

test('queued inputs and binding are captured before waits', async () => {
  await fixture(async (db) => {
    await transaction(db, async (_store, operations) => {
      const binding = owner(),
        store = createSqliteTenantInvitations(db, operations, binding);
      const pause = gate(),
        blocked = operations.run(() => pause.wait);
      const input = { ...row(), roles: ['writer', 'reader'] },
        change = { invitationId, expectedVersion: '1', status: 'accepted' as const };
      const inserted = store.insert(input),
        changed = store.transition(change),
        found = store.read(invitationId);
      input.roles[0] = 'changed';
      input.accountId = 'foreign';
      change.expectedVersion = '99';
      Reflect.set(binding, 'appId', 'foreign');
      Reflect.set(binding.source, 'id', 'foreign');
      pause.release();
      await blocked;
      await inserted;
      await changed;
      assert.deepEqual(await found, { ...row(), version: '2', status: 'accepted' });
    });
  });
});

test('escaped facades refuse after completion, even inside the next transaction', async () => {
  await fixture(async (db) => {
    let retained!: Store;
    await transaction(db, async (store) => {
      retained = store;
    });
    await denied(() => retained.read(invitationId));
    await denied(() => retained.insert(row()));
    await transaction(db, async () => {
      await denied(() => retained.insert(row()));
    });
    assert.equal(db.prepare(`SELECT count(*) AS n FROM "${tables.invitation}"`).get()?.n, 0);
  });
});

test('outside-transaction and queued work after rollback never autocommit', async () => {
  await fixture(async (db) => {
    const outside = new TransactionOperations();
    await denied(() => createSqliteTenantInvitations(db, outside, owner()).insert(row()));
    await denied(() => outside.finish());
    db.exec('BEGIN');
    const operations = new TransactionOperations(),
      pause = gate();
    const blocked = operations.run(() => pause.wait);
    const pending = createSqliteTenantInvitations(db, operations, owner()).insert(row());
    db.exec('ROLLBACK');
    pause.release();
    await blocked;
    await denied(() => pending);
    await denied(() => operations.finish());
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM "${tables.invitation}"`).get()?.n, 0);
  });
});

for (const phase of [1, 2])
  test(`guard refusal at phase ${phase} rolls back insertion`, async () => {
    await fixture(async (db) => {
      const before = image(db);
      let calls = 0;
      await denied(() =>
        transaction(
          db,
          async (store) => {
            await store.insert(row());
          },
          () => {
            if (++calls === phase) throw new Error('private callback details');
          },
        ),
      );
      assert.deepEqual(image(db), before);
    });
  });

test('guards cannot introduce hidden TEMP triggers, metadata drift or asynchronous results', async () => {
  await fixture(async (db) => {
    const before = image(db);
    await denied(() =>
      transaction(
        db,
        async (store) => {
          await store.insert(row());
        },
        () => {
          db.exec(`CREATE TEMP TRIGGER hidden AFTER INSERT ON main."${tables.invitation}" BEGIN SELECT 1; END`);
        },
      ),
    );
    let calls = 0;
    await denied(() =>
      transaction(
        db,
        async (store) => {
          await store.insert(row());
        },
        () => {
          if (++calls === 2) db.exec(`UPDATE "${tables.meta}" SET app_id = 'foreign'`);
        },
      ),
    );
    await denied(() =>
      transaction(db, async (_store, operations) => {
        await createSqliteTenantInvitations(db, operations, owner(), async () => {
          throw new Error('private async rejection');
        }).read(invitationId);
      }),
    );
    assert.deepEqual(image(db), before);
  });
});
