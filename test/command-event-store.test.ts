import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import {
  COMMAND_JOURNAL_TABLES,
  createSqliteCommandJournal,
  migrateSqliteCommandJournal,
} from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type {
  CommandJournal,
  CommandJournalTenant,
  StoredCommandReceipt,
} from '../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import type { CommandEventBatch } from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import {
  COMMAND_EVENT_TABLES as tables,
  CommandEventStoreUnavailable,
  provisionSqliteCommandEventStore,
} from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import {
  appendSqliteCommandEvents,
  assertSqliteCommandEvents,
  tenantCommandEventOwner,
} from '../packages/mistri/src/adapters/events/commandEventStore.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';

const tenant: CommandJournalTenant = {
  appId: 'ignition',
  storeId: 'event-store',
  sourceId: 'business',
  tenantId: 'north',
  actorId: 'alice',
  membershipId: 'member',
  membershipVersion: '1',
  tenantVersion: '1',
  roles: ['manager'],
  deployment: 'first',
};
const binding = { appId: tenant.appId, storeId: tenant.storeId, sourceId: tenant.sourceId };
const owner = tenantCommandEventOwner(tenant);
const receipt: StoredCommandReceipt = {
  id: 'receipt',
  appId: tenant.appId,
  actorId: tenant.actorId,
  commandId: 'assign',
  commandVersion: 2,
  idempotencyKey: 'assignment-0000001',
  fingerprint: 'fingerprint',
  resultJson: '{"assigned":true}',
  requestId: 'request',
  completedAt: '2026-09-08T12:00:00.000Z',
};
const audit = { target: 'application', keyJson: '{"id":1}', changesJson: '[]' };
const manifest = [{ name: 'application.reviewer-assigned', version: 1 }];
const batch: CommandEventBatch = [{ ...manifest[0], payloadJson: '{"applicationId":1,"reviewerId":"reviewer-one"}' }];

function fixture(t: TestContext, provision = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-event-store-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("CREATE TABLE application(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO application VALUES(1,'Before')");
  migrateSqliteCommandJournal(path);
  if (provision) provisionSqliteCommandEventStore(path, binding);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const run = async <T>(work: (journal: CommandJournal) => Promise<T>): Promise<T> => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await work(createSqliteCommandJournal(db, operations, tenant));
      await operations.finish();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const seed = () =>
    run(async (journal) => {
      await journal.commit(receipt, audit);
      appendSqliteCommandEvents(db, owner, receipt, audit, batch);
      return assertSqliteCommandEvents(db, owner, receipt, audit, manifest);
    });
  return { db, path, run, seed, count: (table: string) => db.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n };
}

test('event append and exact private inspection persist runtime-owned immutable envelopes', async (t) => {
  const f = fixture(t),
    events = await f.seed();
  assert.equal(events.length, 1);
  assert.ok(Object.isFrozen(events));
  assert.ok(Object.isFrozen(events[0]));
  assert.ok(Object.isFrozen(events[0].key));
  const event = events[0];
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(event, {
    appId: tenant.appId,
    storeId: tenant.storeId,
    sourceId: tenant.sourceId,
    scope: 'tenant',
    tenantId: tenant.tenantId,
    actorId: tenant.actorId,
    commandId: receipt.commandId,
    commandVersion: 2,
    resource: audit.target,
    key: { id: 1 },
    receiptId: receipt.id,
    requestId: receipt.requestId,
    occurredAt: receipt.completedAt,
    correlationId: receipt.requestId,
    causation: { kind: 'command', receiptId: receipt.id },
    envelopeVersion: 2,
    eventId: event.eventId,
    ordinal: 0,
    name: 'application.reviewer-assigned',
    version: 1,
    payloadJson: batch[0].payloadJson,
  });
  for (const field of ['membershipId', 'roles', 'deployment', 'connection', 'path', 'token'])
    assert.equal(Object.hasOwn(event, field), false);
});

test('new connection and renewed grant recover exact event identities without generating replacements', async (t) => {
  const f = fixture(t),
    original = await f.seed();
  const reopened = new DatabaseSync(f.path, { enableForeignKeyConstraints: true });
  try {
    reopened.exec('BEGIN');
    const renewed = {
      ...tenant,
      membershipId: 'new-grant',
      membershipVersion: '2',
      tenantVersion: '2',
      roles: ['reader'],
      deployment: 'second',
    };
    assert.deepEqual(assertSqliteCommandEvents(reopened, tenantCommandEventOwner(renewed), receipt, audit, manifest), original);
    reopened.exec('COMMIT');
  } finally {
    reopened.close();
  }
  assert.equal(f.count(tables.event), 1);
});

test('missing storage or missing batch is never interpreted as a successful event-bearing receipt', async (t) => {
  const absent = fixture(t, false);
  await absent.run(async () => {
    assert.deepEqual(assertSqliteCommandEvents(absent.db, owner, receipt, audit), []);
    assert.throws(() => assertSqliteCommandEvents(absent.db, owner, receipt, audit, manifest), CommandEventStoreUnavailable);
  });
  const f = fixture(t);
  await f.run(async (journal) => {
    await journal.commit(receipt, audit);
    assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, manifest), CommandEventStoreUnavailable);
  });
});

test('unexpected batch and changed event declaration are refused on replay', async (t) => {
  const f = fixture(t);
  await f.seed();
  await f.run(async () => {
    assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit), CommandEventStoreUnavailable);
    for (const changes of [{ name: 'application.other' }, { version: 2 }, { fields: ['applicationId'] }, { slot: 'other' }]) {
      const changed = [{ ...manifest[0], ...changes }];
      assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, changed), CommandEventStoreUnavailable);
    }
  });
});

for (const field of ['appId', 'storeId', 'sourceId', 'tenantId', 'actorId'] as const) {
  test(`current ${field} cannot reinterpret another event batch`, async (t) => {
    const f = fixture(t);
    await f.seed();
    await f.run(async () => {
      assert.throws(
        () => assertSqliteCommandEvents(f.db, { ...owner, [field]: 'other' }, receipt, audit, manifest),
        CommandEventStoreUnavailable,
      );
    });
  });
}

for (const sql of [
  `DELETE FROM "${tables.event}"`,
  `UPDATE "${tables.event}" SET ordinal=1`,
  `UPDATE "${tables.event}" SET event_id='malformed'`,
  `UPDATE "${COMMAND_JOURNAL_TABLES.receipt}" SET event_count=2`,
  `UPDATE "${COMMAND_JOURNAL_TABLES.receipt}" SET manifest_json='[]'`,
  `UPDATE "${COMMAND_JOURNAL_TABLES.receipt}" SET digest='${'f'.repeat(64)}'`,
])
  test(`missing or altered ordered association refuses: ${sql}`, async (t) => {
    const f = fixture(t);
    await f.seed();
    f.db.exec(sql);
    await f.run(async () => {
      assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, manifest), CommandEventStoreUnavailable);
    });
  });

for (const patch of [
  { tenantId: 'south' },
  { actorId: 'mallory' },
  { receiptId: 'other' },
  { requestId: 'other' },
  { commandVersion: 3 },
  { resource: 'other' },
  { key: { id: 2 } },
  { correlationId: 'other' },
  { causation: { kind: 'command', receiptId: 'other' } },
  { occurredAt: '2026-09-09T12:00:00.000Z' },
  { envelopeVersion: 1 },
  { scope: 'app' },
  { version: 2 },
  { privateExtra: 'not-allowed' },
])
  test(`envelope provenance tampering refuses even with recomputed digest: ${JSON.stringify(patch)}`, async (t) => {
    const f = fixture(t),
      events = await f.seed(),
      modified = { ...events[0], ...patch };
    f.db.prepare(`UPDATE "${tables.event}" SET envelope_json=?`).run(canonicalCommandJson(modified, 131072));
    const digest = createHash('sha256')
      .update(canonicalCommandJson({ manifest, events: [modified] }, 1048576))
      .digest('hex');
    f.db.prepare(`UPDATE "${COMMAND_JOURNAL_TABLES.receipt}" SET digest=?`).run(digest);
    await f.run(async () => {
      assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, manifest), CommandEventStoreUnavailable);
    });
  });

test('altered payload with original digest refuses rather than silently redelivering', async (t) => {
  const f = fixture(t),
    events = await f.seed();
  f.db
    .prepare(`UPDATE "${tables.event}" SET envelope_json=?`)
    .run(canonicalCommandJson({ ...events[0], payloadJson: '{"applicationId":1,"reviewerId":"another"}' }));
  await f.run(async () => {
    assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, manifest), CommandEventStoreUnavailable);
  });
});

test('event insert failure rolls back business effects, receipt, audit and batch together', async (t) => {
  const f = fixture(t),
    prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    if (sql.startsWith(`INSERT INTO main."${tables.event}"`)) throw new Error('storage unavailable');
    return prepare(sql);
  };
  try {
    await assert.rejects(
      f.run(async (journal) => {
        f.db.exec("UPDATE application SET name='After'");
        await journal.commit(receipt, audit);
        appendSqliteCommandEvents(f.db, owner, receipt, audit, batch);
      }),
      CommandEventStoreUnavailable,
    );
  } finally {
    f.db.prepare = prepare;
  }
  assert.equal(f.db.prepare('SELECT name FROM application').get()!.name, 'Before');
  for (const table of [tables.event, COMMAND_JOURNAL_TABLES.receipt]) assert.equal(f.count(table), 0);
});

test('duplicate append never replaces committed event identities', async (t) => {
  const f = fixture(t),
    original = await f.seed();
  await assert.rejects(
    f.run(async () => appendSqliteCommandEvents(f.db, owner, receipt, audit, batch)),
    CommandEventStoreUnavailable,
  );
  await f.run(async () => assert.deepEqual(assertSqliteCommandEvents(f.db, owner, receipt, audit, manifest), original));
});

test('helpers refuse outside an active transaction', async (t) => {
  const f = fixture(t);
  await f.seed();
  assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, manifest), CommandEventStoreUnavailable);
  assert.throws(() => appendSqliteCommandEvents(f.db, owner, receipt, audit, batch), CommandEventStoreUnavailable);
});

test('ordered multi-event batch preserves nested payloads and detects reordered declarations', async (t) => {
  const f = fixture(t),
    next = { name: 'application.assignment-recorded', version: 1 };
  const expected = [...manifest, next];
  const payload = { applicationId: 1, change: { fields: ['reviewer'], previous: null } };
  const drafts = [...batch, { ...next, payloadJson: canonicalCommandJson(payload) }];
  await f.run(async (journal) => {
    await journal.commit(receipt, audit);
    appendSqliteCommandEvents(f.db, owner, receipt, audit, drafts);
    const events = assertSqliteCommandEvents(f.db, owner, receipt, audit, expected);
    assert.deepEqual(
      events.map((event) => event.ordinal),
      [0, 1],
    );
    assert.notEqual(events[0].eventId, events[1].eventId);
    assert.deepEqual(JSON.parse(events[1].payloadJson), payload);
    assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, [...expected].reverse()), CommandEventStoreUnavailable);
  });
});

test('orphaned event rows do not make an absent batch valid', async (t) => {
  const f = fixture(t);
  await f.seed();
  f.db.exec('PRAGMA foreign_keys=OFF');
  f.db.exec(`UPDATE "${COMMAND_JOURNAL_TABLES.receipt}" SET manifest_json = NULL, event_count = NULL, digest = NULL`);
  f.db.exec('PRAGMA foreign_keys=ON');
  await f.run(async () => {
    for (const expected of [manifest, undefined]) {
      assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, expected), CommandEventStoreUnavailable);
    }
  });
});

test('NUL-truncated stored envelope text is refused before parsing', async (t) => {
  const f = fixture(t);
  await f.seed();
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db.exec(`UPDATE "${tables.event}" SET envelope_json=envelope_json || char(0) || 'hidden'`);
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  await f.run(async () => {
    assert.throws(() => assertSqliteCommandEvents(f.db, owner, receipt, audit, manifest), CommandEventStoreUnavailable);
  });
});

test('noncanonical payload bytes and authored envelope fields cannot reach storage', async (t) => {
  const f = fixture(t);
  for (const drafts of [
    [{ ...batch[0], payloadJson: '{ "applicationId": 1, "reviewerId": "reviewer-one" }' }],
    [{ ...batch[0], tenantId: 'south' }],
    [],
    [{ ...batch[0], payloadJson: JSON.stringify({ name: 'x'.repeat(16385) }) }],
  ]) {
    await assert.rejects(
      f.run(async (journal) => {
        await journal.commit(receipt, audit);
        appendSqliteCommandEvents(f.db, owner, receipt, audit, drafts);
      }),
      CommandEventStoreUnavailable,
    );
  }
  assert.equal(f.count(COMMAND_JOURNAL_TABLES.receipt), 0);
});
