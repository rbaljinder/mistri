import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import type { CommandJournal, StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import { CommandTransactionFailure, migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqlitePublicPlacementJournal } from '../packages/mistri/src/adapters/commands/publicPlacementJournal.js';
import { PUBLIC_PLACEMENT_TABLES as tables } from '../packages/mistri/src/adapters/commands/publicPlacementSchema.js';
import type {
  PublicPlacementAdmission,
  PublicPlacementAnchor,
  PublicPlacementOwner,
} from '../packages/mistri/src/adapters/commands/publicPlacementTypes.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const owner: PublicPlacementOwner = {
  issuerId: 'issuer',
  sourceIdentity: 'source-1',
  appId: 'site',
  form: 'contact',
  tenant: 'north',
  commandId: 'contact',
  commandVersion: 1,
};
const admission: PublicPlacementAdmission = {
  ...owner,
  epoch: 'epoch-1',
  anchors: [
    { table: 'dealer', key: { id: 'north' }, expected: { active: 1, version: 1 } },
    { table: 'storefront', key: { dealer: 'north', locale: 'en' }, expected: { published: true, version: 1 } },
  ],
};
const scope: RowScope = {
  dealer: { groups: [[{ column: 'id', op: '=', value: 'north' }]] },
  storefront: { groups: [[{ column: 'dealer', op: '=', value: 'north' }]] },
  lead: { groups: [[{ column: 'dealer', op: '=', value: 'north' }]] },
};
const receipt: StoredCommandReceipt = {
  id: 'receipt-1',
  appId: owner.appId,
  actorId: `public:${owner.form}`,
  commandId: owner.commandId,
  commandVersion: 1,
  idempotencyKey: 'submission-1',
  fingerprint: 'validated-command-fingerprint',
  resultJson: '{"reference":"lead-1"}',
  requestId: 'request-1',
  completedAt: '2026-09-30T12:00:00.000Z',
};
const audit = { target: 'lead', keyJson: '{}', changesJson: '{"redacted":true}' };
const lead = { table: 'lead', values: { id: 'lead-1', dealer: 'north', answer: 'private' } };

async function fixture(run: (source: SqliteAdapter, db: DatabaseSync, path: string) => Promise<void>, provision = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-public-placement-')),
    path = join(dir, 'business.db');
  const db = new DatabaseSync(path);
  let source: SqliteAdapter | undefined;
  try {
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, active INTEGER NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE storefront(dealer TEXT NOT NULL REFERENCES dealer(id), locale TEXT NOT NULL, published BOOLEAN NOT NULL,
        version INTEGER NOT NULL, PRIMARY KEY(dealer,locale));
      CREATE TABLE lead(id TEXT PRIMARY KEY NOT NULL, dealer TEXT NOT NULL REFERENCES dealer(id), answer TEXT NOT NULL);
      CREATE TABLE foreign_table(id TEXT PRIMARY KEY NOT NULL, active INTEGER NOT NULL);
      INSERT INTO dealer VALUES('north',1,1),('south',1,1);
      INSERT INTO storefront VALUES('north','en',1,1),('south','en',1,1);
      INSERT INTO foreign_table VALUES('north',1);`);
    if (provision) assert.deepEqual(provisionSqlitePublicPlacementJournal(path), { version: 1, provisioned: true });
    source = new SqliteAdapter(path);
    await run(source, db, path);
  } finally {
    await source?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const failed = (error: unknown) => error instanceof CommandTransactionFailure && error.outcome === 'not_applied';
const count = (db: DatabaseSync, table: string) => db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()?.n;
const empty = (db: DatabaseSync) => {
  for (const table of ['lead', tables.receipt]) assert.equal(count(db, table), 0);
};

test('placement commits inserts, redacted audit and one receipt atomically, preserving legacy journal namespace', async () => {
  await fixture(async (source, db, path) => {
    migrateSqliteCommandJournal(path);
    let escaped: WriteTransaction | undefined, store: CommandJournal | undefined;
    await commandsOf(source).publicPlacementCommandTransaction(scope, admission, async (tx, journal, catalog) => {
      escaped = tx;
      store = journal;
      assert.equal('lockRecord' in tx, false);
      assert.equal(
        catalog.tables.some((table) => table.name.startsWith('__mistri_')),
        false,
      );
      assert.equal(await journal.find(receipt), undefined);
      assert.deepEqual(
        (await tx.query({ table: 'dealer', limit: 10, offset: 0 })).rows.map((row) => row.id),
        ['north'],
      );
      await tx.insert(lead);
      await journal.commit(receipt, audit);
    });
    assert.equal(count(db, 'lead'), 1);
    assert.equal(count(db, tables.receipt), 1);
    assert.equal(count(db, '__mistri_command_receipt'), 0);
    assert.equal(db.prepare(`SELECT epoch FROM "${tables.receipt}"`).get()?.epoch, admission.epoch);
    assert.equal(
      db.prepare(`SELECT json_extract(changes_json, '$[0]') AS changes FROM "${tables.receipt}"`).get()?.changes,
      audit.changesJson,
    );
    assert.deepEqual(await commandsOf(source).publicPlacementReceipt(owner, receipt.idempotencyKey), receipt);
    await assert.rejects(escaped!.insert({ ...lead, values: { ...lead.values, id: 'escaped' } }));
    await assert.rejects(store!.find(receipt));
  });
});

test('failure after receipt and caught malformed journal operations roll back all writes', async () => {
  for (const phase of ['after', 'journal', 'mutation', 'foreign'])
    await fixture(async (source, db) => {
      await assert.rejects(
        commandsOf(source).publicPlacementCommandTransaction(scope, admission, async (tx, journal) => {
          await tx.insert(lead);
          if (phase === 'journal') await journal.commit({ ...receipt, appId: 'other-app' }, audit).catch(() => {});
          else {
            await journal.commit(receipt, audit);
            if (phase === 'after') throw new Error('rollback');
            if (phase === 'mutation') await tx.update({ table: 'dealer', key: { id: 'north' }, values: { active: 0 } }).catch(() => {});
            if (phase === 'foreign') await tx.insert({ ...lead, values: { ...lead.values, id: 'bad', dealer: 'south' } }).catch(() => {});
          }
        }),
        failed,
      );
      empty(db);
    });
});

test('changed expected eligibility refuses before the callback', async () => {
  await fixture(async (source, db) => {
    db.exec("UPDATE storefront SET published=0,version=2 WHERE dealer='north'");
    let called = false;
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction(scope, admission, async () => {
        called = true;
      }),
      failed,
    );
    assert.equal(called, false);
    empty(db);
  });
});

test('complete real primary keys, declared source tables and typed expected columns are required', async () => {
  const bad: PublicPlacementAnchor[] = [
    { table: 'storefront', key: { dealer: 'north' }, expected: { published: true } },
    { table: 'dealer', key: { id: 'north', active: 1 }, expected: { version: 1 } },
    { table: 'foreign_table', key: { id: 'north' }, expected: { active: 1 } },
    { table: 'other_source.dealer', key: { id: 'north' }, expected: { active: 1 } },
    { table: 'dealer', key: { id: 'north' }, expected: { missing: 1 } },
    { table: 'dealer', key: { id: 'north' }, expected: { active: '1' } },
    { table: 'dealer', key: { id: 'north' }, expected: {} },
  ];
  await fixture(async (source, db) => {
    for (const anchor of bad) {
      let called = false;
      await assert.rejects(
        commandsOf(source).publicPlacementCommandTransaction(scope, { ...admission, anchors: [anchor] }, async () => {
          called = true;
        }),
      );
      assert.equal(called, false);
    }
    for (const anchors of [[], Array(9).fill(admission.anchors[0]), [admission.anchors[0], admission.anchors[0]]]) {
      await assert.rejects(
        commandsOf(source).publicPlacementCommandTransaction(scope, { ...admission, anchors }, async () => assert.fail('called')),
      );
    }
    empty(db);
  });
});

test('epoch changes do not create another receipt namespace; recovery needs no current eligibility or handler', async () => {
  await fixture(async (source, db) => {
    await commandsOf(source).publicPlacementCommandTransaction(scope, admission, async (tx, journal) => {
      await tx.insert(lead);
      await journal.commit(receipt, audit);
    });
    let replay: StoredCommandReceipt | undefined;
    await commandsOf(source).publicPlacementCommandTransaction(scope, { ...admission, epoch: 'epoch-2' }, async (_tx, journal) => {
      replay = await journal.find(receipt);
    });
    assert.deepEqual(replay, receipt);
    assert.equal(count(db, 'lead'), 1);
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction(scope, { ...admission, epoch: 'epoch-2' }, async (tx, journal) => {
        await tx.insert({ ...lead, values: { ...lead.values, id: 'duplicate-attempt' } });
        await journal.commit({ ...receipt, id: 'another-receipt' }, audit);
      }),
      failed,
    );
    assert.equal(count(db, 'lead'), 1);
    assert.equal(count(db, tables.receipt), 1);
    db.exec("UPDATE dealer SET active=0,version=2 WHERE id='north'; DROP TABLE storefront; DROP TABLE lead;");
    assert.deepEqual(await commandsOf(source).publicPlacementReceipt(owner, receipt.idempotencyKey), receipt);
    for (const changed of [
      { tenant: 'south' },
      { sourceIdentity: 'source-2' },
      { issuerId: 'issuer-2' },
      { form: 'other' },
      { commandVersion: 2 },
    ]) {
      assert.equal(await commandsOf(source).publicPlacementReceipt({ ...owner, ...changed }, receipt.idempotencyKey), undefined);
    }
    assert.equal(await commandsOf(source).publicPlacementReceipt(owner, 'unknown-submission'), undefined);
  });
});

test('serve and recovery refuse unprovisioned or altered journal layouts without creating anything', async () => {
  await fixture(async (source, db, path) => {
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction(scope, admission, async () => assert.fail('called')),
      failed,
    );
    await assert.rejects(commandsOf(source).publicPlacementReceipt(owner, 'submission-1'));
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__mistri_%'").get()?.n, 0);
    provisionSqlitePublicPlacementJournal(path);
    assert.deepEqual(provisionSqlitePublicPlacementJournal(path), { version: 1, provisioned: false });
    db.exec(`CREATE TRIGGER break_receipt AFTER INSERT ON "${tables.receipt}" BEGIN DELETE FROM lead; END;`);
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction(scope, admission, async () => assert.fail('called')),
      failed,
    );
    await assert.rejects(commandsOf(source).publicPlacementReceipt(owner, 'submission-1'));
    assert.throws(() => provisionSqlitePublicPlacementJournal(path));
    empty(db);
  }, false);
});

test('admission captures before queue waits and rechecks current writer rows after acquisition', async () => {
  await fixture(async (source, db) => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const held = source.transaction(async (tx) => {
      enter();
      await gate;
      await tx.update({ table: 'dealer', key: { id: 'north' }, values: { active: 0 } });
    });
    await entered;
    const mutable = structuredClone(admission);
    const waiting = commandsOf(source).publicPlacementCommandTransaction(scope, mutable, async () => assert.fail('stale admission ran'));
    (mutable.anchors[0].expected as Record<string, unknown>).active = 0;
    release();
    await held;
    await assert.rejects(waiting, failed);
    empty(db);
  });
});

test('proxies and getters in admission are refused without evaluating authored code', async () => {
  await fixture(async (source) => {
    let touched = 0;
    for (const value of [
      new Proxy(admission, {
        ownKeys() {
          touched++;
          return [];
        },
      }),
      {
        ...admission,
        anchors: [
          {
            ...admission.anchors[0],
            get expected() {
              touched++;
              return { active: 1 };
            },
          },
        ],
      },
    ]) {
      await assert.rejects(commandsOf(source).publicPlacementCommandTransaction(scope, value, async () => assert.fail('called')));
    }
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction(
        new Proxy(scope, {
          ownKeys() {
            touched++;
            return [];
          },
        }),
        admission,
        async () => assert.fail('called'),
      ),
    );
    assert.equal(touched, 0);
  });
});

test('lost commit acknowledgement reports unknown and original-owner recovery finds the committed receipt', async (t) => {
  await fixture(async (source, db) => {
    await commandsOf(source).publicPlacementCommandTransaction(scope, admission, async () => {});
    const writer = Reflect.get(source, 'writeDb') as DatabaseSync;
    const exec = writer.exec.bind(writer);
    t.mock.method(writer, 'exec', (sql: string) => {
      exec(sql);
      if (sql === 'COMMIT') throw new Error('lost acknowledgement');
    });
    await assert.rejects(
      commandsOf(source).publicPlacementCommandTransaction(scope, admission, async (tx, journal) => {
        await tx.insert(lead);
        await journal.commit(receipt, audit);
      }),
      (error: unknown) => error instanceof CommandTransactionFailure && error.outcome === 'unknown',
    );
    assert.equal(count(db, 'lead'), 1);
    assert.deepEqual(await commandsOf(source).publicPlacementReceipt(owner, receipt.idempotencyKey), receipt);
  });
});

test('journal format ownership/version/fingerprint must exist; provisioning never adopts unowned or partial tables', async () => {
  for (const alteration of [
    `DROP TABLE "${tables.meta}"`, // Identical receipt table, never adopted.
    `DELETE FROM "${tables.meta}"`,
    `UPDATE "${tables.meta}" SET format_owner='some-other-format'`,
    `UPDATE "${tables.meta}" SET version=2`,
    `UPDATE "${tables.meta}" SET schema_fingerprint='foreign-layout'`,
    `DROP TABLE "${tables.receipt}"`,
  ])
    await fixture(async (source, db, path) => {
      db.exec(alteration);
      const before = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
      const hasMeta = db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(tables.meta);
      const marker = hasMeta ? db.prepare(`SELECT * FROM "${tables.meta}"`).all() : undefined;
      await assert.rejects(
        commandsOf(source).publicPlacementCommandTransaction(scope, admission, async () => assert.fail('unowned journal served')),
      );
      await assert.rejects(commandsOf(source).publicPlacementReceipt(owner, receipt.idempotencyKey));
      assert.throws(() => provisionSqlitePublicPlacementJournal(path));
      assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(), before);
      if (hasMeta) assert.deepEqual(db.prepare(`SELECT * FROM "${tables.meta}"`).all(), marker);
      assert.equal(count(db, 'lead'), 0);
    });
});

test('failed final marker attestation rolls back provisioning tables and marker together', async (t) => {
  await fixture(async (_source, db, path) => {
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('SELECT singleton, version, format_owner, schema_fingerprint FROM'))
        throw new Error('marker attestation unavailable');
      return prepare.call(this, sql);
    });
    assert.throws(() => provisionSqlitePublicPlacementJournal(path), /marker attestation unavailable/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE '__mistri_public_placement_%'").get()?.n, 0);
  }, false);
});
