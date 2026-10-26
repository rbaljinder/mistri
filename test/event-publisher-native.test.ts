import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_EVENT_TABLES as events } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { sqliteAuditRows, sqliteBatchRows } from './support/commandTargets.js';
import { EVENT_DELIVERY_TABLES as delivery } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { openSqliteEventDeliveryStore } from '../packages/mistri/src/adapters/events/eventDeliveryStore.js';
import { createEventPublisher, type EventPublication } from '../packages/mistri/src/server/events/eventPublisher.js';
import { nativeEventDeliveryFixture } from './support/eventDeliveryNative.js';

test('native assignment: accepted transport/local-ack loss restarts with the same event and no command reexecution', async (t) => {
  const f = await nativeEventDeliveryFixture(t),
    db = new DatabaseSync(f.path, { readOnly: true });
  t.after(() => db.close());
  const evidence = () => {
    db.exec('BEGIN');
    try {
      return Object.fromEntries(
        // The receipt row carries the targets (the audit) and the event batch; both are read off it below.
        ['physical_loan_application', 'physical_assignment_history', journal.receipt, events.event, sqliteAuditRows, sqliteBatchRows].map(
          (table) => [table, db.prepare(`SELECT * FROM ${table.startsWith('(') ? `${table} t` : `"${table}"`} ORDER BY 1`).all()],
        ),
      );
    } finally {
      db.exec('ROLLBACK');
    }
  };
  const before = evidence(),
    receipt = before[journal.receipt][0],
    audit = before[sqliteAuditRows][0];
  assert.equal(before[journal.receipt].length, 1);
  assert.equal(before[sqliteAuditRows].length, 1);
  assert.equal(before[sqliteBatchRows].length, 1);
  assert.equal(before.physical_assignment_history.length, 1);
  assert.equal(receipt.id, f.receiptId);
  assert.equal(audit.receipt_id, receipt.id);
  assert.equal(audit.actor_id, f.actorId);
  const accepted: EventPublication[] = [];
  let restore = () => {};
  const first = createEventPublisher(
    openSqliteEventDeliveryStore(f.path, f.policy),
    async (publication) => {
      accepted.push(publication);
      assert.equal(publication.envelope.receiptId, f.receiptId);
      assert.equal(publication.envelope.actorId, f.actorId);
      assert.equal(publication.envelope.tenantId, 'northstar');
      assert.equal(publication.envelope.key.id, f.applicationId);
      assert.equal(JSON.parse(publication.envelope.payloadJson).applicationId, f.applicationId);
      assert.doesNotMatch(JSON.stringify(publication.envelope), /Disposable private reason|membership|roles|password/);
      const competing = new DatabaseSync(f.path);
      try {
        competing.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK');
      } finally {
        competing.close();
      }
      const prepare = DatabaseSync.prototype.prepare;
      restore = () => {
        DatabaseSync.prototype.prepare = prepare;
      };
      DatabaseSync.prototype.prepare = function (sql) {
        if (sql.startsWith(`UPDATE main."${delivery.attempt}" SET outcome=`)) {
          restore();
          throw new Error('Disposable local ack loss');
        }
        return Reflect.apply(prepare, this, [sql]);
      };
      return 'accepted';
    },
    () => 1000,
  );
  try {
    assert.equal((await first.tick()).status, 'unavailable');
  } finally {
    restore();
    await first.stop();
  }
  const second = createEventPublisher(
    openSqliteEventDeliveryStore(f.path, f.policy),
    async (publication) => {
      accepted.push(publication);
      return 'accepted';
    },
    () => 1110,
  );
  try {
    assert.equal((await second.tick()).status, 'accepted');
    assert.equal((await second.tick()).status, 'idle');
  } finally {
    await second.stop();
  }
  assert.equal(accepted.length, 2);
  assert.equal(accepted[0].idempotencyKey, accepted[1].idempotencyKey);
  assert.deepEqual(accepted[0].envelope, accepted[1].envelope);
  assert.equal(accepted[0].envelope.eventId, before[events.event][0].event_id);
  assert.deepEqual(evidence(), before);
  const store = openSqliteEventDeliveryStore(f.path, f.policy);
  try {
    assert.equal((await store.inspect())[0].state, 'delivered');
    assert.deepEqual(
      (await store.attempts(accepted[0].envelope.eventId)).map((row) => [row.outcome, row.code]),
      [
        ['unknown', 'lease_expired'],
        ['accepted', 'accepted'],
      ],
    );
  } finally {
    await store.close();
  }
});
