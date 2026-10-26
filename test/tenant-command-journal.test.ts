import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  assertSqliteCommandJournal,
  captureCommandJournalTenant,
  COMMAND_JOURNAL_TABLES as tables,
  CommandJournalUnavailable,
  createSqliteCommandJournal,
  migrateSqliteCommandJournal,
  type CommandAudit,
  type CommandJournal,
  type CommandJournalTenant,
  type StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';

const tenant: CommandJournalTenant = {
  appId: 'app',
  storeId: 'store',
  sourceId: 'business',
  tenantId: 'north',
  actorId: 'alice',
  membershipId: 'grant',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['editor'],
  deployment: 'deployment',
};
const receipt = (id = 'receipt'): StoredCommandReceipt => ({
  id,
  appId: tenant.appId,
  actorId: tenant.actorId,
  commandId: 'assign',
  commandVersion: 1,
  idempotencyKey: 'same-key',
  fingerprint: 'fingerprint',
  resultJson: '{"done":true}',
  requestId: 'request',
  completedAt: '2026-09-08T12:00:00.000Z',
});
const audit: CommandAudit = { target: 'item', keyJson: '{"id":"one"}', changesJson: '[{"field":"name","value":"After"}]' };

test('portable tenant capture is detached, deeply frozen and rejects proxy/getter hooks before inspection', () => {
  const input = structuredClone(tenant),
    captured = captureCommandJournalTenant(input);
  assert.deepEqual(captured, tenant);
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.roles));
  Reflect.set(input, 'tenantId', 'south');
  Reflect.set(input.roles, '0', 'admin');
  assert.equal(captured.tenantId, 'north');
  assert.deepEqual(captured.roles, ['editor']);
  let hooks = 0;
  const proxy = new Proxy(tenant, {
    ownKeys() {
      hooks++;
      return [];
    },
  });
  const getter = {
    ...tenant,
    get roles() {
      hooks++;
      return [];
    },
  };
  const nested = {
    ...tenant,
    roles: new Proxy(['editor'], {
      getPrototypeOf() {
        hooks++;
        return Array.prototype;
      },
    }),
  };
  for (const input of [proxy, getter, nested]) assert.throws(() => captureCommandJournalTenant(input));
  assert.equal(hooks, 0);
});
function fixture(t: TestContext, migrate = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-command-journal-')),
    path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE item(id TEXT PRIMARY KEY, name TEXT); INSERT INTO item VALUES ('one','Before')");
  if (migrate) migrateSqliteCommandJournal(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const run = async <T>(
    work: (journal: CommandJournal, operations: TransactionOperations) => Promise<T>,
    bound: CommandJournalTenant | undefined = tenant,
    verify?: () => void,
  ): Promise<T> => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(createSqliteCommandJournal(db, operations, bound, verify), operations);
      await operations.finish();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  return {
    db,
    path,
    directory,
    run,
    count: (table: string = tables.receipt) => db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n,
    unchanged: () => assert.equal(db.prepare('SELECT name FROM item').get()!.name, 'Before'),
  };
}

test('fresh explicit migration creates version 1 only, is idempotent, and never creates missing files', (t) => {
  const f = fixture(t, false),
    missing = join(f.directory, 'missing.db');
  assert.throws(() => migrateSqliteCommandJournal(missing));
  assert.equal(existsSync(missing), false);
  assert.deepEqual(migrateSqliteCommandJournal(f.path), { version: 1, migrated: true });
  assert.deepEqual(migrateSqliteCommandJournal(f.path), { version: 1, migrated: false });
  assert.equal(f.db.prepare(`SELECT version FROM "${tables.meta}"`).get()!.version, 1);
  assertSqliteCommandJournal(f.db);
  f.unchanged();
});

test('v1 provenance is never guessed or implicitly upgraded, including explicit migration', async (t) => {
  const f = fixture(t, false);
  f.db.exec(`CREATE TABLE "${tables.meta}" (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1));
    INSERT INTO "${tables.meta}" VALUES(1,1);
    CREATE TABLE "${tables.receipt}" (id TEXT PRIMARY KEY, app_id TEXT, actor_id TEXT);
    INSERT INTO "${tables.receipt}" VALUES('old','app','alice')`);
  const before = f.db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  assert.throws(() => migrateSqliteCommandJournal(f.path), CommandJournalUnavailable);
  await assert.rejects(
    f.run((journal) => journal.find(receipt())),
    CommandJournalUnavailable,
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before);
  assert.equal(f.db.prepare(`SELECT id FROM "${tables.receipt}"`).get()!.id, 'old');
});

test('ordinary and tenant receipts coexist with real namespace columns and unchanged receipt DTOs', async (t) => {
  const f = fixture(t);
  await f.run(async (_journal, operations) => {
    const ordinary = createSqliteCommandJournal(f.db, operations);
    await ordinary.commit(receipt('ordinary'), audit);
    assert.deepEqual(await ordinary.find(receipt()), receipt('ordinary'));
  });
  await f.run(async (journal) => {
    assert.equal(await journal.find(receipt()), undefined);
    await journal.commit(receipt('tenant'), audit);
    assert.deepEqual(await journal.find(receipt()), receipt('tenant'));
  });
  assert.equal(f.count(), 2);
  const ordinary = f.db.prepare(`SELECT * FROM ${sqliteAuditRows} a WHERE receipt_id='ordinary'`).get()!;
  assert.equal(ordinary.app_id, 'app');
  assert.equal(ordinary.actor_id, 'alice');
  for (const column of [
    'store_id',
    'source_id',
    'tenant_id',
    'owner_tenant_id',
    'membership_id',
    'membership_version',
    'realm_version',
    'deployment',
  ])
    assert.equal(ordinary[column], '');
  assert.equal(ordinary.realm, 'tenant');
  assert.equal(ordinary.roles_json, '[]');
  const stored = f.db.prepare(`SELECT * FROM ${sqliteAuditRows} a WHERE receipt_id='tenant'`).get()!;
  assert.equal(stored.store_id, tenant.storeId);
  assert.equal(stored.source_id, tenant.sourceId);
  assert.equal(stored.tenant_id, tenant.tenantId);
  assert.equal(stored.membership_id, tenant.membershipId);
  assert.equal(stored.membership_version, '1');
  assert.equal(stored.realm_version, '1');
  assert.equal(stored.roles_json, '["editor"]');
  assert.equal(stored.deployment, tenant.deployment);
  assert.equal(stored.realm, 'tenant');
  assert.equal(stored.owner_tenant_id, tenant.tenantId);
});

for (const field of ['appId', 'storeId', 'sourceId', 'tenantId', 'actorId'] as const)
  test(`${field} separates same command/key receipts without encoded actors`, async (t) => {
    const f = fixture(t),
      other = { ...tenant, [field]: field === 'tenantId' ? 'south' : `${tenant[field]}Other` };
    await f.run((journal) => journal.commit(receipt('first'), audit));
    const otherReceipt = { ...receipt('second'), appId: other.appId, actorId: other.actorId };
    await f.run(async (journal) => {
      assert.equal(await journal.find(otherReceipt), undefined);
      await journal.commit(otherReceipt, audit);
    }, other);
    assert.equal(f.count(), 2);
    assert.deepEqual(await f.run((journal) => journal.find(receipt())), receipt('first'));
    assert.deepEqual(await f.run((journal) => journal.find(otherReceipt), other), otherReceipt);
  });

test('revision, grant, roles and deployment changes preserve replay uniqueness and original audit provenance', async (t) => {
  const f = fixture(t);
  await f.run((journal) => journal.commit(receipt(), audit));
  const current = {
    ...tenant,
    membershipId: 'replacement-grant',
    membershipVersion: '999',
    tenantVersion: '1000',
    roles: ['reader'],
    deployment: 'new-deployment',
  };
  assert.deepEqual(await f.run((journal) => journal.find(receipt()), current), receipt());
  await assert.rejects(
    f.run(async (journal) => {
      f.db.exec("UPDATE item SET name='Wrong'");
      await journal.commit(receipt('duplicate'), audit).catch(() => {});
    }, current),
  );
  f.unchanged();
  assert.equal(f.count(), 1);
  assert.equal(f.db.prepare(`SELECT membership_id FROM ${sqliteAuditRows} a`).get()!.membership_id, 'grant');
});

for (const field of ['appId', 'actorId'])
  test(`bound tenant refuses mismatched ${field} on lookup and commit`, async (t) => {
    const f = fixture(t),
      wrong = { ...receipt(), [field]: 'other' };
    for (const method of ['find', 'commit'])
      await assert.rejects(
        f.run(async (journal) => {
          f.db.exec("UPDATE item SET name='Wrong'");
          await (method === 'find' ? journal.find(wrong) : journal.commit(wrong, audit)).catch(() => {});
        }),
      );
    f.unchanged();
    assert.equal(f.count(), 0);
  });

for (const field of [
  'storeId',
  'sourceId',
  'tenantId',
  'membershipId',
  'membershipVersion',
  'tenantVersion',
  'roles',
  'deployment',
  'tenant_id',
]) {
  test(`receipt/find/audit cannot supply ${field} provenance`, async (t) => {
    const f = fixture(t);
    for (const target of ['find', 'receipt', 'audit'])
      await assert.rejects(
        f.run(async (journal) => {
          const extra = { [field]: 'forged' };
          if (target === 'find') await journal.find({ ...receipt(), ...extra });
          else
            await journal.commit(
              { ...receipt(), ...(target === 'receipt' ? extra : {}) },
              { ...audit, ...(target === 'audit' ? extra : {}) },
            );
        }),
      );
    assert.equal(f.count(), 0);
  });
}

// The provenance is the receipt's own columns, one copy: a forged one is not the receipt's scope any more,
// so the replay finds nothing under it (it can never be read back as the true receipt).
for (const column of ['app_id', 'store_id', 'source_id', 'tenant_id', 'actor_id'])
  test(`forged receipt ${column} is never found under the true scope`, async (t) => {
    const f = fixture(t);
    await f.run((journal) => journal.commit(receipt(), audit));
    f.db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
    f.db.prepare(`UPDATE "${tables.receipt}" SET ${column}=?`).run('forged');
    f.db.exec('PRAGMA foreign_keys=ON; PRAGMA ignore_check_constraints=OFF');
    assert.equal(await f.run((journal) => journal.find(receipt())), undefined);
  });

for (const [column, value] of [
  ['membership_id', ''],
  ['membership_version', '0'],
  ['realm_version', '01'],
  ['roles_json', '["editor","editor"]'],
  ['roles_json', '{}'],
  ['roles_json', '[1]'],
  ['deployment', ' '],
  ['key_json', 'broken'],
  ['changes_json', 'broken'],
  ['target', ''],
] as const) {
  test(`malformed historical ${column} ${value} refuses replay`, async (t) => {
    const f = fixture(t);
    await f.run((journal) => journal.commit(receipt(), audit));
    f.db.exec('PRAGMA ignore_check_constraints=ON');
    // A target's key and changes are the receipt's arrays of JSON texts.
    const stored = column === 'key_json' ? 'keys_json' : column;
    const target = column === 'key_json' || column === 'changes_json';
    f.db.prepare(`UPDATE "${tables.receipt}" SET ${stored}=${target ? 'json_array(?)' : '?'}`).run(value);
    f.db.exec('PRAGMA ignore_check_constraints=OFF');
    await assert.rejects(f.run((journal) => journal.find(receipt())));
  });
}

test('ordinary replay refuses tenant execution metadata injected into its empty namespace', async (t) => {
  const f = fixture(t);
  await f.run(async (_, operations) => {
    await createSqliteCommandJournal(f.db, operations).commit(receipt(), audit);
  });
  f.db.prepare(`UPDATE "${tables.receipt}" SET membership_id='forged'`).run();
  await assert.rejects(
    f.run((_, operations) => createSqliteCommandJournal(f.db, operations).find(receipt())),
    CommandJournalUnavailable,
  );
});

for (const ddl of [
  `CREATE TEMP TABLE "${tables.receipt}" (id TEXT)`,
  `CREATE TEMP TRIGGER hostile AFTER INSERT ON main."${tables.receipt}" BEGIN SELECT 1; END`,
  `CREATE TRIGGER hostile AFTER INSERT ON "${tables.receipt}" BEGIN SELECT 1; END`,
  'CREATE TABLE __MISTRI_COMMAND_EXTRA (id TEXT)',
  `ALTER TABLE "${tables.receipt}" ADD COLUMN extra TEXT`,
]) {
  test(`queued tenant journal refuses DDL drift: ${ddl}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      f.run(async (journal) => {
        f.db.exec(ddl);
        await journal.find(receipt());
      }),
      CommandJournalUnavailable,
    );
    assertSqliteCommandJournal(f.db);
  });
}

test('verification surrounds actual queued finds/commits and post-write refusal poisons rollback', async (t) => {
  const f = fixture(t);
  let calls = 0,
    expectedRows = 0;
  await f.run(
    async (journal) => {
      await journal.find(receipt());
      await journal.commit(receipt(), audit);
    },
    tenant,
    () => {
      calls++;
      assert.equal(f.count(), expectedRows);
      if (calls === 3) expectedRows = 1;
    },
  );
  assert.equal(calls, 4);
  let after = 0;
  const rejected = new Error('verification refused');
  await assert.rejects(
    f.run(
      async (journal) => {
        f.db.exec("UPDATE item SET name='Wrong'");
        await journal.commit({ ...receipt('later'), idempotencyKey: 'later' }, audit).catch(() => {});
        await assert.rejects(journal.find(receipt()), (error) => error === rejected);
      },
      tenant,
      () => {
        if (++after === 2) throw rejected;
      },
    ),
    (error) => error === rejected,
  );
  f.unchanged();
  assert.equal(f.count(), 1);
});

test('verifier mutations cannot invalidate attestation or end the owned transaction before SQL', async (t) => {
  for (const command of [`CREATE TEMP TABLE "${tables.meta}" (id INTEGER)`, 'ROLLBACK']) {
    const f = fixture(t);
    await assert.rejects(
      f.run(
        (journal) => journal.commit(receipt(), audit),
        tenant,
        () => {
          f.db.exec(command);
        },
      ),
    );
    assert.equal(f.count(), 0);
  }
});

for (const result of [1, false, null, 'value'])
  test(`nonvoid verifier result ${result} poisons even caught failure`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      f.run(
        async (journal) => {
          await journal.find(receipt()).catch(() => {});
        },
        tenant,
        (() => result) as () => void,
      ),
    );
  });

test('native async verifier rejection is consumed; arbitrary thenable is never assimilated', async (t) => {
  const f = fixture(t);
  let called = 0;
  const thenable = {};
  Reflect.set(thenable, 'then', () => {
    called++;
  });
  for (const verify of [() => Promise.reject(new Error('private-async')), () => thenable]) {
    await assert.rejects(f.run((journal) => journal.find(receipt()), tenant, verify as () => void));
  }
  assert.equal(called, 0);
});

test('binding, receipt, audit and lookup capture precede queue waits; returned DTO is frozen and detached', async (t) => {
  const f = fixture(t),
    bound = structuredClone(tenant);
  await f.run(async (_, operations) => {
    const journal = createSqliteCommandJournal(f.db, operations, bound);
    Reflect.set(bound, 'tenantId', 'south');
    Reflect.set(bound.roles, '0', 'admin');
    let release!: () => void;
    const gate = operations.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const input = receipt(),
      change = { ...audit },
      pending = journal.commit(input, change);
    input.actorId = 'mallory';
    change.target = 'other';
    release();
    await gate;
    await pending;
    const scope = receipt(),
      found = journal.find(scope);
    scope.idempotencyKey = 'mutated';
    const value = await found;
    assert.deepEqual(value, receipt());
    assert.ok(Object.isFrozen(value));
    assert.equal(Reflect.set(value!, 'resultJson', 'null'), false);
    assert.equal(f.db.prepare(`SELECT target FROM ${sqliteAuditRows} a`).get()!.target, 'item');
    assert.equal(f.db.prepare(`SELECT roles_json FROM ${sqliteAuditRows} a`).get()!.roles_json, '["editor"]');
  });
});

for (const target of ['tenant', 'find', 'receipt', 'audit'])
  test(`${target} proxy/getter capture executes no hostile code`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    for (const kind of ['proxy', 'getter']) {
      const input = target === 'tenant' ? tenant : target === 'audit' ? audit : receipt();
      const bad =
        kind === 'proxy'
          ? new Proxy(input, {
              ownKeys() {
                calls++;
                return [];
              },
            })
          : Object.defineProperty({ ...input }, 'extra', {
              enumerable: true,
              get() {
                calls++;
                return 'secret';
              },
            });
      if (target === 'tenant')
        assert.throws(() => createSqliteCommandJournal(f.db, new TransactionOperations(), bad as CommandJournalTenant));
      else
        await assert.rejects(
          f.run(async (journal) => {
            f.db.exec("UPDATE item SET name='Wrong'");
            await (
              target === 'find'
                ? journal.find(bad as StoredCommandReceipt)
                : journal.commit(
                    target === 'receipt' ? (bad as StoredCommandReceipt) : receipt(),
                    target === 'audit' ? (bad as CommandAudit) : audit,
                  )
            ).catch(() => {});
          }),
        );
    }
    assert.equal(calls, 0);
    assert.equal(f.count(), 0);
    f.unchanged();
  });

for (const patch of [
  { tenantId: 'North' },
  { tenantId: 'north ' },
  { actorId: ' alice' },
  { actorId: '\uD800' },
  { sourceId: 'business.alias' },
  { storeId: '' },
  { membershipVersion: '0' },
  { tenantVersion: '1'.repeat(129) },
  { roles: ['editor', 'editor'] },
  { deployment: '' },
  { extra: true },
  { canonicalPath: '/private/file' },
  { connection: 'private' },
]) {
  test(`malformed binding ${JSON.stringify(patch)} refuses before publication`, (t) => {
    const f = fixture(t);
    assert.throws(() => createSqliteCommandJournal(f.db, new TransactionOperations(), { ...tenant, ...patch }));
  });
}

test('null/nonobject tenant binding cannot downgrade to ordinary namespace', (t) => {
  const f = fixture(t);
  for (const value of [null, false, 0, '', [], {}])
    assert.throws(() => createSqliteCommandJournal(f.db, new TransactionOperations(), value as unknown as CommandJournalTenant));
});

test('JSON byte and capture budgets refuse and poison receipt publication', async (t) => {
  const f = fixture(t);
  for (const [entry, change] of [
    [{ ...receipt(), resultJson: JSON.stringify('é'.repeat(8192)) }, audit],
    [receipt(), { ...audit, keyJson: JSON.stringify('x'.repeat(8192)) }],
    [receipt(), { ...audit, changesJson: JSON.stringify('x'.repeat(65536)) }],
    [{ ...receipt(), extra: 'x'.repeat(1_048_577) }, audit],
  ] as Array<[StoredCommandReceipt, CommandAudit]>) {
    await assert.rejects(
      f.run(async (journal) => {
        await journal.commit(entry, change).catch(() => {});
      }),
    );
  }
  assert.equal(f.count(), 0);
});

test('tenant journals require an active transaction and all finished handles refuse without reentering verifier', async (t) => {
  const f = fixture(t);
  let retained!: CommandJournal,
    checks = 0;
  await f.run(
    async (journal) => {
      retained = journal;
      await journal.find(receipt());
    },
    tenant,
    () => {
      checks++;
    },
  );
  const before = checks;
  await assert.rejects(retained.find(receipt()), /no longer active/);
  await assert.rejects(retained.commit(receipt(), audit), /no longer active/);
  assert.equal(checks, before);
  const operations = new TransactionOperations(),
    outside = createSqliteCommandJournal(f.db, operations, tenant);
  await assert.rejects(outside.find(receipt()), CommandJournalUnavailable);
  await assert.rejects(operations.finish());
});

test('receipt storage failure rolls back the business write; a caught error never permits later queue work', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.run(async (journal) => {
      f.db.exec("UPDATE item SET name='Wrong'");
      const prepare = f.db.prepare.bind(f.db),
        error = new Refusal('receipt storage unavailable');
      f.db.prepare = (statement) => {
        if (statement.startsWith(`INSERT INTO main."${tables.receipt}"`)) throw error;
        return prepare(statement);
      };
      try {
        await assert.rejects(journal.commit(receipt(), audit), (value) => value === error);
        await assert.rejects(journal.find(receipt()), (value) => value === error);
      } finally {
        f.db.prepare = prepare;
      }
    }),
  );
  f.unchanged();
  assert.equal(f.count(), 0);
});
