import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  assertSqliteCommandJournal,
  migrateSqliteCommandJournal,
  COMMAND_JOURNAL_TABLES,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import {
  assertSqliteTenantStore,
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  TENANT_TABLES,
  type TenantStoreBinding,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  ADMINISTRATION_JOURNAL_TABLES as tables,
  assertSqliteTenantAdministrationJournal,
  createSqliteTenantAdministrationJournal,
  provisionSqliteTenantAdministrationJournal,
  type AdministrationReceiptScope,
  type StoredAdministrationReceipt,
  type AdministrationAudit,
} from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';

const binding = (): TenantStoreBinding => ({ appId: 'app', source: { id: 'business', connection: 'business-alias' }, storeId: 'store' });
const scope = (): AdministrationReceiptScope => ({
  actorId: 'operator',
  tenantId: 'north',
  operation: 'tenant.create',
  operationVersion: 1,
  idempotencyKey: 'attempt-1',
});
const receipt = (): StoredAdministrationReceipt => ({
  ...scope(),
  id: 'receipt-1',
  fingerprint: 'fingerprint',
  resultJson: '{"tenantId":"north","version":"1"}',
  requestId: 'request-1',
  completedAt: '2026-09-08T12:00:00.000Z',
});
const audit = (): AdministrationAudit => ({
  policyId: 'operators',
  policyVersion: 'v1',
  deployment: 'deployment-1',
  sessionId: 'session-id',
  changeJson: '{"status":"active"}',
});
type Journal = ReturnType<typeof createSqliteTenantAdministrationJournal>;
const secret = 'PRIVATE_ADMINISTRATION_SENTINEL';
function safe(error: unknown): boolean {
  assert.ok(error instanceof TenantContextError);
  assert.equal(error.message, 'The tenant context could not be verified.');
  assert.equal('cause' in error, false);
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, new RegExp(secret));
  return true;
}
const denied = (work: () => unknown) => assert.rejects(async () => work(), safe);
const count = (db: DatabaseSync, table: string) => db.prepare(`SELECT count(*) AS n FROM main."${table}"`).get()?.n;
const catalog = (db: DatabaseSync) => db.prepare('SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name').all();
function image(db: DatabaseSync) {
  return {
    catalog: catalog(db),
    rows: db
      .prepare("SELECT name FROM main.sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM main."${name}" ORDER BY rowid`).all()]),
  };
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
async function fixture(work: (db: DatabaseSync, path: string) => void | Promise<void>, provision = true, tenantStore = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-admin-journal-'));
  const path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE business_record(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO business_record VALUES ('one', 'original')`);
    if (tenantStore) {
      provisionSqliteTenantStore(path, binding());
      db.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES ('existing', 'active', '1', 'tenant');
        INSERT INTO "${TENANT_TABLES.membership}" VALUES ('grant', 'existing', 'account', 'active', '1', '["reader"]', 1000, 'member', NULL, NULL, NULL)`);
    }
    migrateSqliteCommandJournal(path);
    if (provision) provisionSqliteTenantAdministrationJournal(path, binding());
    await work(db, path);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
async function transaction<T>(
  db: DatabaseSync,
  work: (journal: Journal, operations: TransactionOperations) => Promise<T>,
  verify?: () => void,
): Promise<T> {
  db.exec('BEGIN');
  const operations = new TransactionOperations();
  let active = true;
  try {
    const journal = createSqliteTenantAdministrationJournal(db, operations, binding(), () => {
      if (!active) throw new Error(secret);
      verify?.();
    });
    const result = await work(journal, operations);
    await operations.finish();
    active = false;
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      await operations.finish();
    } catch {
      /* Preserve the original failure. */
    }
    active = false;
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

test('provisioning independently attests version 1 and preserves existing tenant/command/business images', async () => {
  await fixture(async (db, path) => {
    const before = image(db);
    assert.deepEqual(provisionSqliteTenantAdministrationJournal(path, binding()), { version: 1, provisioned: true });
    const after = image(db);
    assert.deepEqual(
      after.catalog.filter((row) => !String(row.tbl_name).startsWith('__mistri_admin_')),
      before.catalog,
    );
    assert.deepEqual(
      after.rows.filter(([name]) => !String(name).startsWith('__mistri_admin_')),
      before.rows,
    );
    assertSqliteTenantStore(db, binding());
    assertSqliteCommandJournal(db);
    assertSqliteTenantAdministrationJournal(db, binding());
    assert.deepEqual(provisionSqliteTenantAdministrationJournal(path, binding()), { version: 1, provisioned: false });
    assert.deepEqual(image(db), after);
    assert.equal(db.prepare(`SELECT version FROM "${TENANT_TABLES.meta}"`).get()?.version, 1);
    // Version 3 since multi-target commands (one audit row per target); provisioning leaves it as created.
    assert.equal(db.prepare(`SELECT version FROM "${COMMAND_JOURNAL_TABLES.meta}"`).get()?.version, 1);
    await transaction(db, async (journal) => {
      assert.equal(await journal.read(scope()), null);
    });
  }, false);
});

test('missing paths, directories and absent tenant stores refuse without adoption', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-admin-missing-'));
  const missing = join(directory, 'absent.db');
  try {
    await denied(() => provisionSqliteTenantAdministrationJournal(missing, binding()));
    await denied(() => provisionSqliteTenantAdministrationJournal(directory, binding()));
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  await fixture(
    async (db, path) => {
      const before = image(db);
      await denied(() => provisionSqliteTenantAdministrationJournal(path, binding()));
      assert.deepEqual(image(db), before);
    },
    false,
    false,
  );
});

for (const field of ['appId', 'storeId', 'source'] as const)
  test(`foreign ${field} binding refuses without writes`, async () => {
    await fixture(async (db, path) => {
      const wrong = { ...binding(), [field]: field === 'source' ? { id: 'foreign', connection: 'business-alias' } : 'foreign' };
      const before = image(db);
      await denied(() => provisionSqliteTenantAdministrationJournal(path, wrong));
      await denied(() => assertSqliteTenantAdministrationJournal(db, wrong));
      await denied(() =>
        transaction(db, async (_journal, operations) => {
          await createSqliteTenantAdministrationJournal(db, operations, wrong).read(scope());
        }),
      );
      assert.deepEqual(image(db), before);
    });
  });

test('transient connection aliases rotate without changing durable binding or replay scope', async () => {
  await fixture(async (db, path) => {
    await transaction(db, async (journal) => {
      await journal.commit(receipt(), audit());
    });
    const rotated = { ...binding(), source: { id: 'business', connection: 'new-alias' } };
    assert.deepEqual(provisionSqliteTenantAdministrationJournal(path, rotated), { version: 1, provisioned: false });
    await transaction(db, async (_journal, operations) => {
      assert.deepEqual(await createSqliteTenantAdministrationJournal(db, operations, rotated).read(scope()), receipt());
    });
  });
});

for (const schema of ['main', 'temp'])
  for (const kind of ['TABLE', 'VIEW', 'INDEX', 'TRIGGER']) {
    test(`reserved ${schema} ${kind} collision refuses attestation and queued access`, async () => {
      await fixture(async (db, path) => {
        const name = `${schema}."__MISTRI_ADMIN_foreign"`;
        if (kind === 'TABLE') db.exec(`CREATE TABLE ${name}(id TEXT)`);
        if (kind === 'VIEW') db.exec(`CREATE VIEW ${name} AS SELECT 1`);
        if (kind === 'TRIGGER') db.exec(`CREATE TRIGGER ${name} AFTER UPDATE ON business_record BEGIN SELECT 1; END`);
        if (kind === 'INDEX') db.exec(`CREATE TABLE ${schema}.scratch(id TEXT); CREATE INDEX ${name} ON scratch(id)`);
        const before = image(db);
        await denied(() => assertSqliteTenantAdministrationJournal(db, binding()));
        await denied(() =>
          transaction(db, async (journal) => {
            await journal.commit(receipt(), audit());
          }),
        );
        if (schema === 'main') await denied(() => provisionSqliteTenantAdministrationJournal(path, binding()));
        assert.deepEqual(image(db), before);
      });
    });
  }

for (const schema of ['main', 'temp'])
  for (const table of Object.values(tables)) {
    test(`unreserved ${schema} trigger on ${table} refuses before side effects`, async () => {
      await fixture(async (db) => {
        db.exec(`CREATE TRIGGER ${schema}.hidden AFTER INSERT ON main."${table}"
        BEGIN UPDATE business_record SET value = '${secret}'; END`);
        await denied(() => assertSqliteTenantAdministrationJournal(db, binding()));
        await denied(() =>
          transaction(db, async (journal) => {
            await journal.commit(receipt(), audit());
          }),
        );
        assert.equal(db.prepare('SELECT value FROM business_record').get()?.value, 'original');
      });
    });
  }

for (const mutation of ['partial', 'missing meta', 'future version', 'NOCASE', 'extra index', 'rebound meta']) {
  test(`${mutation} administration namespace is never repaired or reseeded`, async () => {
    await fixture(async (db, path) => {
      if (mutation === 'partial') db.exec(`DROP TABLE "${tables.receipt}"`);
      if (mutation === 'missing meta') db.exec(`DELETE FROM "${tables.meta}"`);
      if (mutation === 'future version') db.exec(`PRAGMA ignore_check_constraints = ON; UPDATE "${tables.meta}" SET version = 2`);
      if (mutation === 'NOCASE') {
        const ddl = db.prepare('SELECT sql FROM sqlite_schema WHERE name = ?').get(tables.receipt)?.sql as string;
        db.exec(`DROP TABLE "${tables.receipt}"`);
        db.exec(ddl.replaceAll('COLLATE BINARY', 'COLLATE NOCASE'));
      }
      if (mutation === 'extra index') db.exec(`CREATE INDEX hidden ON "${tables.receipt}"(fingerprint)`);
      if (mutation === 'rebound meta') db.exec(`UPDATE "${tables.meta}" SET store_id = 'foreign'`);
      const before = image(db);
      await denied(() => provisionSqliteTenantAdministrationJournal(path, binding()));
      await denied(() => assertSqliteTenantAdministrationJournal(db, binding()));
      assert.deepEqual(image(db), before);
    });
  });
}

test('tenant-store tampering and disabled foreign keys invalidate the sibling journal', async () => {
  await fixture(async (db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    await denied(() => assertSqliteTenantAdministrationJournal(db, binding()));
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`CREATE TRIGGER hidden AFTER UPDATE ON "${TENANT_TABLES.tenant}" BEGIN SELECT 1; END`);
    await denied(() =>
      transaction(db, async (journal) => {
        await journal.read(scope());
      }),
    );
  });
});

for (const kind of ['TABLE', 'VIEW', 'INDEX', 'TRIGGER'])
  test(`initial ${kind} collision never fills a foreign namespace`, async () => {
    await fixture(async (db, path) => {
      const name = '"__MISTRI_ADMIN_foreign"';
      if (kind === 'TABLE') db.exec(`CREATE TABLE ${name}(id TEXT)`);
      if (kind === 'VIEW') db.exec(`CREATE VIEW ${name} AS SELECT 1`);
      if (kind === 'INDEX') db.exec(`CREATE INDEX ${name} ON business_record(value)`);
      if (kind === 'TRIGGER') db.exec(`CREATE TRIGGER ${name} AFTER UPDATE ON business_record BEGIN SELECT 1; END`);
      const before = image(db);
      await denied(() => provisionSqliteTenantAdministrationJournal(path, binding()));
      assert.deepEqual(image(db), before);
    }, false);
  });

test('command journal attestation remains independent from administration provisioning and access', async () => {
  await fixture(async (db, path) => {
    db.exec('CREATE TABLE __mistri_command_future(id TEXT)');
    const before = image(db);
    assert.throws(() => assertSqliteCommandJournal(db));
    assert.deepEqual(provisionSqliteTenantAdministrationJournal(path, binding()), { version: 1, provisioned: true });
    assertSqliteTenantStore(db, binding());
    await transaction(db, async (journal) => {
      await journal.commit(receipt(), audit());
    });
    const after = image(db);
    assert.deepEqual(
      after.catalog.filter((row) => !String(row.tbl_name).startsWith('__mistri_admin_')),
      before.catalog,
    );
    assert.deepEqual(
      after.rows.filter(([name]) => !String(name).startsWith('__mistri_admin_')),
      before.rows,
    );
  }, false);
});

test('hostile bindings and proxy callbacks refuse without invoking supplied behavior', async () => {
  await fixture(async (db, path) => {
    let calls = 0;
    const hostile = (): never => {
      calls++;
      throw new Error(secret);
    };
    const owner = binding();
    Object.defineProperty(owner.source, 'connection', { enumerable: true, get: hostile });
    const before = image(db);
    await denied(() => provisionSqliteTenantAdministrationJournal(path, owner));
    await denied(() => assertSqliteTenantAdministrationJournal(db, owner));
    await denied(() => createSqliteTenantAdministrationJournal(db, new TransactionOperations(), owner));
    await denied(() =>
      createSqliteTenantAdministrationJournal(db, new TransactionOperations(), binding(), new Proxy(hostile, { apply: hostile })),
    );
    assert.equal(calls, 0);
    assert.deepEqual(image(db), before);
  });
});

test('receipt and audit persist together, with a detached explicit private receipt projection', async () => {
  await fixture(async (db, path) => {
    await transaction(db, async (journal) => {
      assert.ok(Object.isFrozen(journal));
      await journal.commit(receipt(), audit());
      const found = await journal.read(scope());
      assert.deepEqual(found, receipt());
      assert.ok(Object.isFrozen(found));
      assert.equal(Reflect.set(found!, 'fingerprint', 'forged'), false);
      assert.deepEqual(Object.keys(found!).sort(), Object.keys(receipt()).sort());
    });
    assert.deepEqual(
      { ...db.prepare(`SELECT id, policy_id, policy_version, deployment, session_id, change_json FROM "${tables.receipt}"`).get() },
      {
        id: 'receipt-1',
        policy_id: 'operators',
        policy_version: 'v1',
        deployment: 'deployment-1',
        session_id: 'session-id',
        change_json: audit().changeJson,
      },
    );
    const reopened = new DatabaseSync(path);
    try {
      await transaction(reopened, async (journal) => {
        assert.deepEqual(await journal.read(scope()), receipt());
      });
    } finally {
      reopened.close();
    }
  });
});

test('duplicate scopes fail-stop even when caught; tenant/actor/operation/version/key scopes are independent', async () => {
  await fixture(async (db) => {
    await transaction(db, async (journal) => {
      await journal.commit(receipt(), audit());
    });
    const before = image(db);
    let later = false;
    await denied(() =>
      transaction(db, async (journal, operations) => {
        await operations.run(async () => {
          db.exec("UPDATE business_record SET value = 'rollback'");
        });
        await denied(() => journal.commit({ ...receipt(), id: 'duplicate' }, audit()));
        await denied(() =>
          operations.run(async () => {
            later = true;
          }),
        );
      }),
    );
    assert.equal(later, false);
    assert.deepEqual(image(db), before);
    const variants = [
      { tenantId: 'south' },
      { actorId: 'another' },
      { operation: 'tenant.status' },
      { operationVersion: 2 },
      { idempotencyKey: 'another' },
    ];
    await transaction(db, async (journal) => {
      for (const [index, variant] of variants.entries()) {
        const stored = { ...receipt(), ...variant, id: `receipt-${index + 2}` };
        await journal.commit(stored, audit());
        assert.deepEqual(await journal.read({ ...scope(), ...variant }), stored);
      }
      assert.equal(await journal.read({ ...scope(), actorId: 'Operator' }), null);
    });
    assert.equal(count(db, tables.receipt), 6);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM "${tables.receipt}" WHERE change_json = ?`).get(audit().changeJson)?.n, 6);
  });
});

test('owner rollback atomically removes metadata and the receipt (with its audit columns) after a later failure', async () => {
  await fixture(async (db) => {
    const before = image(db);
    await assert.rejects(
      transaction(db, async (journal, operations) => {
        await createSqliteTenantAdministration(db, operations, binding()).putTenant({
          tenantId: 'north',
          status: 'active',
          expectedVersion: null,
        });
        await journal.commit(receipt(), audit());
        assert.equal(count(db, tables.receipt), 1);
        throw new Error('owner failure');
      }),
      /owner failure/,
    );
    assert.deepEqual(image(db), before);
  });
});

// The receipt and its audit columns are one row, so a half-written pair cannot exist; the nearest
// thing the store can still be handed is a receipt table of another layout.
test('an extra receipt column refuses attestation, lookup, provisioning and attempted adoption', async () => {
  await fixture(async (db, path) => {
    db.exec(`ALTER TABLE "${tables.receipt}" ADD COLUMN note TEXT`);
    const before = image(db);
    await denied(() => assertSqliteTenantAdministrationJournal(db, binding()));
    await denied(() => provisionSqliteTenantAdministrationJournal(path, binding()));
    await denied(() =>
      transaction(db, async (journal) => {
        await journal.read(scope());
      }),
    );
    await denied(() =>
      transaction(db, async (journal) => {
        await denied(() => journal.commit(receipt(), audit()));
        assert.equal(count(db, tables.receipt), 0);
      }),
    );
    assert.deepEqual(image(db), before);
  });
});

test('receipt insertion failure poisons the queue and rolls back metadata', async (t) => {
  await fixture(async (db) => {
    const before = image(db),
      prepare = db.prepare.bind(db);
    let inserted = false,
      later = false;
    const stub = t.mock.method(db, 'prepare', (sql: string) => {
      if (sql.startsWith(`INSERT INTO main."${tables.receipt}"`)) {
        inserted = count(db, tables.receipt) === 0;
        throw new Error(secret);
      }
      return prepare(sql);
    });
    try {
      await denied(() =>
        transaction(db, async (journal, operations) => {
          await createSqliteTenantAdministration(db, operations, binding()).putTenant({
            tenantId: 'north',
            status: 'active',
            expectedVersion: null,
          });
          await denied(() => journal.commit(receipt(), audit()));
          await denied(() =>
            operations.run(async () => {
              later = true;
            }),
          );
        }),
      );
      assert.equal(inserted, true);
      assert.equal(later, false);
      assert.deepEqual(image(db), before);
    } finally {
      stub.mock.restore();
    }
  });
});

test('inputs and factory binding are captured before a queued wait', async () => {
  await fixture(async (db) => {
    await transaction(db, async (_journal, operations) => {
      const owner = binding(),
        journal = createSqliteTenantAdministrationJournal(db, operations, owner);
      const pause = gate(),
        blocked = operations.run(() => pause.wait);
      const input = receipt(),
        provenance = audit(),
        query = scope();
      const committed = journal.commit(input, provenance),
        found = journal.read(query);
      input.tenantId = 'south';
      input.resultJson = '{}';
      provenance.sessionId = secret;
      query.tenantId = 'south';
      Reflect.set(owner, 'storeId', 'foreign');
      Reflect.set(owner.source, 'id', 'foreign');
      pause.release();
      await blocked;
      await committed;
      assert.deepEqual(await found, receipt());
    });
    assert.equal(db.prepare(`SELECT session_id FROM "${tables.receipt}"`).get()?.session_id, 'session-id');
  });
});

for (const target of ['scope', 'receipt', 'audit'])
  for (const kind of ['getter', 'proxy', 'symbol', 'cycle', 'extra']) {
    test(`${target} ${kind} input is sanitized without invoking accessors and poisons caught failures`, async () => {
      await fixture(async (db) => {
        let calls = 0,
          later = false;
        const hostile = (): never => {
          calls++;
          throw new Error(secret);
        };
        let input: object = target === 'scope' ? scope() : target === 'receipt' ? receipt() : audit();
        if (kind === 'getter') Object.defineProperty(input, 'hostile', { enumerable: true, get: hostile });
        if (kind === 'proxy') input = new Proxy(input, { get: hostile, getPrototypeOf: hostile, ownKeys: hostile });
        if (kind === 'symbol') Reflect.set(input, Symbol(secret), true);
        if (kind === 'cycle') Reflect.set(input, 'cycle', input);
        if (kind === 'extra') Reflect.set(input, 'token', secret);
        const before = image(db);
        await denied(() =>
          transaction(db, async (journal, operations) => {
            await operations.run(async () => {
              db.exec("UPDATE business_record SET value = 'rollback'");
            });
            await denied(() =>
              target === 'scope'
                ? journal.read(input as AdministrationReceiptScope)
                : journal.commit(
                    target === 'receipt' ? (input as StoredAdministrationReceipt) : receipt(),
                    target === 'audit' ? (input as AdministrationAudit) : audit(),
                  ),
            );
            await denied(() =>
              operations.run(async () => {
                later = true;
              }),
            );
          }),
        );
        assert.equal(calls, 0);
        assert.equal(later, false);
        assert.deepEqual(image(db), before);
      });
    });
  }

test('retained handles refuse after completion, including inside a new transaction', async () => {
  await fixture(async (db) => {
    let retained!: Journal;
    await transaction(db, async (journal) => {
      retained = journal;
    });
    await denied(() => retained.read(scope()));
    await denied(() => retained.commit(receipt(), audit()));
    await transaction(db, async () => {
      await denied(() => retained.commit(receipt(), audit()));
    });
    assert.equal(count(db, tables.receipt), 0);
  });
});

test('queued methods never start a transaction or autocommit after owner rollback', async () => {
  await fixture(async (db) => {
    const outside = new TransactionOperations();
    await denied(() => createSqliteTenantAdministrationJournal(db, outside, binding()).commit(receipt(), audit()));
    await denied(() => outside.finish());
    db.exec('BEGIN');
    const operations = new TransactionOperations(),
      pause = gate();
    const blocked = operations.run(() => pause.wait);
    const pending = createSqliteTenantAdministrationJournal(db, operations, binding()).commit(receipt(), audit());
    db.exec('ROLLBACK');
    pause.release();
    await blocked;
    await denied(() => pending);
    await denied(() => operations.finish());
    assert.equal(db.isTransaction, false);
    assert.equal(count(db, tables.receipt), 0);
  });
});

for (const phase of ['before', 'after'])
  test(`${phase} owner callback refusal rolls back without diagnostics`, async () => {
    await fixture(async (db) => {
      let calls = 0;
      const before = image(db);
      await denied(() =>
        transaction(
          db,
          async (journal) => {
            await journal.commit(receipt(), audit());
          },
          () => {
            if (++calls === (phase === 'before' ? 1 : 2)) throw new Error(secret);
          },
        ),
      );
      assert.deepEqual(image(db), before);
    });
  });

test('schema is checked after callbacks, including callback tampering and invalid async callbacks', async () => {
  await fixture(async (db) => {
    const before = image(db);
    await denied(() =>
      transaction(
        db,
        async (journal) => {
          await journal.commit(receipt(), audit());
        },
        () => {
          db.exec(`CREATE TEMP TRIGGER hidden AFTER INSERT ON main."${tables.receipt}" BEGIN SELECT 1; END`);
        },
      ),
    );
    assert.deepEqual(image(db), before);
    await denied(() =>
      transaction(db, async (_journal, operations) => {
        await createSqliteTenantAdministrationJournal(db, operations, binding(), async () => {
          throw new Error(secret);
        }).read(scope());
      }),
    );
  });
});

test('post-operation schema mutation is refused even after the insert succeeded', async () => {
  await fixture(async (db) => {
    let calls = 0;
    const before = image(db);
    await denied(() =>
      transaction(
        db,
        async (journal) => {
          await journal.commit(receipt(), audit());
        },
        () => {
          if (++calls === 2) {
            assert.equal(count(db, tables.receipt), 1);
            db.exec(`UPDATE "${tables.meta}" SET app_id = 'foreign'`);
          }
        },
      ),
    );
    assert.equal(calls, 2);
    assert.deepEqual(image(db), before);
  });
});

test('fire-and-forget invalid calls still poison owner drain after error sanitization', async () => {
  await fixture(async (db) => {
    const before = image(db);
    await denied(() =>
      transaction(db, async (journal, operations) => {
        await operations.run(async () => {
          db.exec("UPDATE business_record SET value = 'rollback'");
        });
        void journal.commit({ ...receipt(), operationVersion: 0 }, audit());
      }),
    );
    assert.deepEqual(image(db), before);
  });
});

for (const [field, value] of [
  ['actorId', ' operator'],
  ['tenantId', 'North'],
  ['operation', 'bad\noperation'],
  ['idempotencyKey', ''],
  ['id', '\ud800'],
  ['fingerprint', 'x'.repeat(257)],
  ['requestId', 'x'.repeat(1025)],
  ['completedAt', '2026-09-08'],
  ['operationVersion', 0],
  ['operationVersion', -1],
  ['operationVersion', 1.5],
  ['operationVersion', Number.MAX_SAFE_INTEGER + 1],
  ['operationVersion', '1'],
  ['resultJson', '{'],
  ['resultJson', '{"number":1e999}'],
  ['resultJson', '['.repeat(26) + '0' + ']'.repeat(26)],
] as const)
  test(`invalid receipt ${field} ${JSON.stringify(value).slice(0, 50)} refuses`, async () => {
    await fixture(async (db) => {
      await denied(() =>
        transaction(db, async (journal) => {
          await journal.commit({ ...receipt(), [field]: value } as StoredAdministrationReceipt, audit());
        }),
      );
      assert.equal(count(db, tables.receipt), 0);
    });
  });

const sizedJson = (bytes: number) => JSON.stringify({ data: 'x'.repeat(bytes - 11) });
test('full 16KiB result and 64KiB change JSON survive exact replay; one byte and UTF8 overflow refuse', async () => {
  await fixture(async (db) => {
    const stored = { ...receipt(), resultJson: sizedJson(16384) },
      provenance = { ...audit(), changeJson: sizedJson(65536) };
    assert.equal(Buffer.byteLength(stored.resultJson), 16384);
    assert.equal(Buffer.byteLength(provenance.changeJson), 65536);
    await transaction(db, async (journal) => {
      await journal.commit(stored, provenance);
      assert.deepEqual(await journal.read(scope()), stored);
    });
    const before = image(db);
    for (const resultJson of [sizedJson(16385), JSON.stringify('é'.repeat(8192))]) {
      await denied(() =>
        transaction(db, async (journal) => {
          await journal.commit({ ...receipt(), id: 'new', idempotencyKey: 'new', resultJson }, audit());
        }),
      );
    }
    await denied(() =>
      transaction(db, async (journal) => {
        await journal.commit({ ...receipt(), id: 'new', idempotencyKey: 'new' }, { ...audit(), changeJson: sizedJson(65537) });
      }),
    );
    assert.deepEqual(image(db), before);
  });
});

for (const [table, column, value] of [
  [tables.receipt, 'result_json', '{'],
  [tables.receipt, 'result_json', sizedJson(16385)],
  [tables.receipt, 'result_json', '{"n":1e999}'],
  [tables.receipt, 'id', ' bad'],
  [tables.receipt, 'completed_at', 'yesterday'],
  [tables.receipt, 'request_id', 'bad\nrequest'],
  [tables.receipt, 'session_id', 'bad\nidentity'],
  [tables.receipt, 'change_json', sizedJson(65537)],
  [tables.receipt, 'change_json', '['.repeat(26) + '0' + ']'.repeat(26)],
] as const)
  test(`stored ${column} tampering refuses receipt release`, async () => {
    await fixture(async (db) => {
      await transaction(db, async (journal) => {
        await journal.commit(receipt(), audit());
      });
      db.exec('PRAGMA ignore_check_constraints = ON; PRAGMA foreign_keys = OFF');
      db.prepare(`UPDATE "${table}" SET ${column} = ?`).run(value);
      db.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON');
      await denied(() =>
        transaction(db, async (journal) => {
          await journal.read(scope());
        }),
      );
    });
  });

test('a receipt table missing its change column refuses attestation, provisioning and even unrelated receipt lookup', async () => {
  await fixture(async (db, path) => {
    await transaction(db, async (journal) => {
      await journal.commit(receipt(), audit());
    });
    db.exec(`ALTER TABLE "${tables.receipt}" RENAME COLUMN change_json TO changes`);
    const before = image(db);
    await denied(() => assertSqliteTenantAdministrationJournal(db, binding()));
    await denied(() => provisionSqliteTenantAdministrationJournal(path, binding()));
    await denied(() =>
      transaction(db, async (journal) => {
        await journal.read(scope());
      }),
    );
    await denied(() =>
      transaction(db, async (journal) => {
        await journal.read({ ...scope(), idempotencyKey: 'unrelated' });
      }),
    );
    assert.deepEqual(image(db), before);
  });
});

test('SQLite enforces unique identities, safe integer versions, bounded JSON and audit columns', async () => {
  await fixture(async (db) => {
    await transaction(db, async (journal) => {
      await journal.commit(receipt(), audit());
    });
    const before = image(db);
    for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => db.prepare(`UPDATE "${tables.receipt}" SET operation_version = ?`).run(version));
    }
    assert.throws(() => db.prepare(`UPDATE "${tables.receipt}" SET result_json = ?`).run(sizedJson(16385)));
    assert.throws(() => db.prepare(`UPDATE "${tables.receipt}" SET change_json = ?`).run(sizedJson(65537)));
    assert.throws(() => db.exec(`UPDATE "${tables.receipt}" SET change_json = '{'`));
    assert.deepEqual(image(db), before);
  });
});
