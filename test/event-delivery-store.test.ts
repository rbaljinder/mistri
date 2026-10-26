/**
 * The delivery store contract, on every engine: SQLite always, PostgreSQL
 * when `TABLEWALK_TEST_PG` names a disposable database (see
 * test/support/eventDeliveryEngines.ts). What only SQLite can show (file
 * pinning, TEMP shadows, catalog text, VACUUM) is in its block at the end;
 * PostgreSQL's own proofs are in postgres-event-delivery.test.ts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  COMMAND_EVENT_TABLES as events,
  assertSqliteCommandEventStore,
} from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { assertSqliteCommandJournal, COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import {
  assertSqliteEventDeliveryStore,
  EVENT_DELIVERY_TABLES as delivery,
  provisionSqliteEventDeliveryStore,
} from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { openSqliteEventDeliveryStore } from '../packages/mistri/src/adapters/events/eventDeliveryStore.js';
import {
  captureEventDeliveryPolicy,
  EventDeliveryUnavailable,
  type EventDeliveryRoute,
} from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { deliveryEngines } from './support/eventDeliveryEngines.js';

const count = (table: string) => `SELECT count(*) AS n FROM "${table}"`;

test('policy capture refuses accessors/proxies and owns routing snapshots', () => {
  const policy = eventDeliveryPolicy();
  let called = false;
  const accessor = {
    ...policy,
    get serviceId() {
      called = true;
      return 'forged';
    },
  };
  assert.throws(() => captureEventDeliveryPolicy(accessor));
  assert.equal(called, false);
  assert.throws(() =>
    captureEventDeliveryPolicy(
      new Proxy(policy, {
        ownKeys() {
          called = true;
          return [];
        },
      }),
    ),
  );
  assert.equal(called, false);
  const captured = captureEventDeliveryPolicy(policy);
  Object.assign(policy.routes[0], { tenantId: 'forged' });
  assert.equal((captured.routes[0] as { tenantId?: string }).tenantId, 'north');
  assert.ok(Object.isFrozen(captured.routes[0].manifest));
  for (const bad of [0, 17, NaN, Infinity])
    assert.throws(() => captureEventDeliveryPolicy({ ...captured, limits: { ...captured.limits, maxAttempts: bad } }));
  for (const route of [
    { ...captured.routes[0], scope: 'everyone' },
    { scope: 'app', tenantId: 'north', commandId: 'assign', commandVersion: 2, manifest: [] },
    { scope: 'tenant', commandId: 'assign', commandVersion: 2, manifest: captured.routes[0].manifest },
  ]) {
    assert.throws(() => captureEventDeliveryPolicy({ ...captured, routes: [route as never] }), EventDeliveryUnavailable);
  }
});

for (const engine of deliveryEngines)
  describe(`event delivery store on ${engine.name}`, { skip: engine.skip }, () => {
    test('delivery provisioning is explicit, idempotent and source-bound, and leaves the events alone', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy(), false);
      await f.seed();
      const before = await f.scalar(count(events.event));
      await assert.rejects(f.open(), EventDeliveryUnavailable);
      const first = await f.provision(),
        again = await f.provision();
      assert.deepEqual([first.provisioned, first.destinationAdded, again.provisioned, again.destinationAdded], [true, true, false, false]);
      assert.equal(await f.scalar(count(events.event)), before);
      assert.deepEqual(await (await f.open()).discover(), { scanned: 1, scheduled: 1, pressure: false });
    });

    for (const change of ['service', 'route', 'source', 'limits'] as const)
      test(`destination identity cannot be reinterpreted by changed ${change}`, async (t) => {
        const f = await engine.fixture(t, eventDeliveryPolicy()),
          altered = structuredClone(f.policy);
        if (change === 'service') Object.assign(altered, { serviceId: 'other' });
        if (change === 'route') Object.assign(altered.routes[0], { tenantId: 'south' });
        if (change === 'source') Object.assign(altered.source, { storeId: 'other' });
        if (change === 'limits') Object.assign(altered.limits, { maxAttempts: 4 });
        await assert.rejects(f.open(altered), EventDeliveryUnavailable);
        await assert.rejects(f.provision(altered), EventDeliveryUnavailable);
        await (await f.open()).discover();
      });

    for (const outcome of ['unknown', 'rejected'] as const)
      test(`readiness detects exhausted ${outcome} attempts and clears after redrive`, async (t) => {
        const f = await engine.fixture(t, eventDeliveryPolicy());
        await f.seed();
        const store = await f.open();
        await store.discover();
        const failed = async () => (await store.inspect('failed', '', 1)).length > 0;
        assert.equal(await failed(), false);
        let now = 1000;
        for (let attempt = 1; attempt <= f.policy.limits.maxAttempts; attempt++) {
          const claim = (await store.claim(now))!;
          assert.ok(claim);
          assert.equal(await store.complete(claim, outcome, outcome === 'unknown' ? 'transport' : 'rejected', now + 1), true);
          assert.equal(await failed(), attempt === f.policy.limits.maxAttempts);
          now += 100;
        }
        const [row] = await store.inspect();
        assert.equal(row.state, 'failed');
        await store.redrive(row.eventId, 'operator', now);
        assert.equal(await failed(), false);
        const claim = (await store.claim(now + 1))!;
        assert.equal(await store.complete(claim, 'accepted', 'accepted', now + 2), true);
        assert.equal(await failed(), false);
      });

    test('competing connections fence leases, preserve expired ambiguity and reject stale completions', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const [event] = await f.seed();
      const a = await f.open(),
        b = await f.open();
      assert.deepEqual(await a.discover(), { scanned: 1, scheduled: 1, pressure: false });
      assert.deepEqual(await b.discover(), { scanned: 0, scheduled: 0, pressure: false });
      const first = (await a.claim(1000))!;
      assert.equal(first.eventId, event.eventId);
      assert.equal(await b.claim(1001), undefined);
      assert.equal(await b.claim(1100), undefined);
      assert.equal((await a.inspect())[0].state, 'unknown');
      const second = (await b.claim(1110))!;
      assert.notEqual(second.token, first.token);
      assert.equal(second.attempt, 2);
      assert.equal(await a.complete(first, 'accepted', 'accepted', 1111), false);
      assert.equal(await b.complete(second, 'accepted', 'accepted', 1112), true);
      assert.equal(await a.complete(first, 'rejected', 'rejected', 1113), false);
      assert.deepEqual(
        (await a.attempts(event.eventId)).map((row) => [row.outcome, row.code]),
        [
          ['unknown', 'lease_expired'],
          ['accepted', 'accepted'],
        ],
      );
      assert.equal((await a.inspect())[0].state, 'delivered');
      assert.equal(await f.executions(), 1);
    });

    test('restart retains identities and leased/unknown attempts without command execution', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      await f.seed();
      const a = await f.open();
      await a.discover();
      const first = (await a.claim(1000))!;
      await a.close();
      const b = await f.open();
      const retry = (await b.claim(1110))!;
      assert.equal(retry.eventId, first.eventId);
      assert.deepEqual(retry.envelope, first.envelope);
      assert.notEqual(retry.token, first.token);
      assert.equal(await f.executions(), 1);
      assert.equal((await b.attempts(first.eventId))[0].outcome, 'unknown');
    });

    test('declaration order waits for local acceptance; unrelated receipts and destinations are independent', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy(2));
      await f.seed('receipt-a');
      await f.seed('receipt-b');
      const a = await f.open(),
        b = await f.open();
      await a.discover();
      const first = (await a.claim(1000))!;
      assert.equal(first.envelope.ordinal, 0);
      const independent = (await b.claim(1001))!;
      assert.notEqual(independent.envelope.receiptId, first.envelope.receiptId);
      assert.equal(independent.envelope.ordinal, 0);
      assert.equal(await a.claim(1002), undefined);
      await a.complete(first, 'accepted', 'accepted', 1003);
      const next = (await b.claim(1004))!;
      assert.equal(next.envelope.receiptId, first.envelope.receiptId);
      assert.equal(next.envelope.ordinal, 1);
      const otherPolicy = { ...f.policy, destinationId: 'second-destination' };
      await f.provision(otherPolicy);
      const other = await f.open(otherPolicy);
      await other.discover();
      assert.equal((await other.claim(1005))!.eventId, first.eventId);
    });

    test('retry backoff/attempt ceiling retains failures and blocks later receipt declarations', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy(2));
      await f.seed();
      const store = await f.open();
      await store.discover();
      let time = 1000;
      for (let i = 1; i <= 3; i++) {
        const claim = (await store.claim(time))!;
        assert.equal(claim.attempt, i);
        assert.equal(claim.envelope.ordinal, 0);
        assert.ok(await store.complete(claim, 'rejected', 'rejected', time + 1));
        assert.equal(await store.claim(time + 2), undefined);
        time += 1 + Math.min(20, 10 * 2 ** (i - 1));
      }
      assert.equal(await store.claim(time), undefined);
      const failures = await store.inspect('failed');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].attempts, 3);
      assert.equal((await store.inspect('pending')).length, 1);
      const inspection = JSON.stringify({ failures, attempts: await store.attempts(failures[0].eventId) });
      assert.doesNotMatch(inspection, /native-account|payload|historical-grant|token/);
    });

    test('pressure is bounded and never partially schedules an ordered batch or discards retained deliveries', async (t) => {
      const base = eventDeliveryPolicy(32),
        policy = { ...base, limits: { ...base.limits, maxRetained: 32 } };
      const f = await engine.fixture(t, policy);
      await f.seed('receipt-a');
      await f.seed('receipt-b');
      const store = await f.open();
      assert.deepEqual(await store.discover(), { scanned: 1, scheduled: 32, pressure: true });
      assert.deepEqual(await store.discover(), { scanned: 0, scheduled: 0, pressure: true });
      assert.equal((await store.inspect()).length, 32);
      assert.equal(await f.scalar(count(delivery.receipt)), 1);
    });

    test('publication authority is explicit routing, independent of historical membership roles', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      await f.seed('north');
      await f.seed('south', { ...f.policy.routes[0], tenantId: 'south' } as EventDeliveryRoute);
      await f.exec(`UPDATE "${journal.receipt}" SET roles_json='["revoked-role"]',membership_version='99',deployment='retired'`);
      const store = await f.open();
      assert.equal((await store.discover()).scheduled, 1);
      assert.equal((await store.claim(1000))!.envelope.tenantId, 'north');
      assert.equal(await f.scalar(count(events.event)), 2);
    });

    // A one-element array of texts, as the receipt keeps its owners and keys.
    const array = (text: string) => (engine.name === 'postgres' ? `json_build_array('${text}'::text)::text` : `json_array('${text}')`);
    for (const [sql, engines] of [
      [`UPDATE "${journal.receipt}" SET actor_id='forged'`, ['sqlite', 'postgres']],
      // The owner is no longer the receipt's tenant. (The provenance columns are the receipt's alone now, so a
      // forged one cannot disagree with a second copy; the owner is what a receipt can still contradict.)
      [`UPDATE "${journal.receipt}" SET owners_json=${array('forged')}`, ['sqlite', 'postgres']],
      [`UPDATE "${journal.receipt}" SET membership_version='0'`, ['sqlite', 'postgres']],
      // PostgreSQL's own CHECK keeps roles an array.
      [`UPDATE "${journal.receipt}" SET roles_json='{}'`, ['sqlite']],
      [`UPDATE "${journal.receipt}" SET keys_json=${array('{"id":2}')}`, ['sqlite', 'postgres']],
      [`UPDATE "${journal.receipt}" SET completed_at='yesterday'`, ['sqlite', 'postgres']],
      [`UPDATE "${journal.receipt}" SET request_id='different'`, ['sqlite', 'postgres']],
      // A receipt left with no targets: its audit is gone.
      [`UPDATE "${journal.receipt}" SET owners_json='[]', keys_json='[]', changes_json='[]'`, ['sqlite', 'postgres']],
      [`UPDATE "${journal.receipt}" SET digest='${'f'.repeat(64)}'`, ['sqlite', 'postgres']],
      [`DELETE FROM "${events.event}"`, ['sqlite', 'postgres']],
      // SQLite discovery scans receipts and finds one whose batch is gone;
      // PostgreSQL discovery walks batches, and there is none left to walk.
      [`DELETE FROM "${events.event}"; UPDATE "${journal.receipt}" SET manifest_json=NULL, event_count=NULL, digest=NULL`, ['sqlite']],
    ] as const)
      test(
        `source association refuses damaged journal data: ${sql}`,
        { skip: !(engines as readonly string[]).includes(engine.name) },
        async (t) => {
          const f = await engine.fixture(t, eventDeliveryPolicy());
          await f.seed();
          await f.exec(sql);
          const store = await f.open();
          await assert.rejects(store.discover(), EventDeliveryUnavailable);
          assert.equal(await f.scalar(count(delivery.delivery)), 0);
        },
      );

    test('recomputed event digest cannot forge actual receipt/audit provenance', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const [original] = await f.seed();
      const forged = { ...original, actorId: 'forged-actor' };
      await f.exec(`UPDATE "${events.event}" SET envelope_json=?`, [canonicalCommandJson(forged)]);
      await f.exec(`UPDATE "${journal.receipt}" SET digest=?`, [
        createHash('sha256')
          .update(canonicalCommandJson({ manifest: f.policy.routes[0].manifest, events: [forged] }, 1_048_576))
          .digest('hex'),
      ]);
      await assert.rejects((await f.open()).discover(), EventDeliveryUnavailable);
    });

    test('missing delivery rows cannot be silently treated as an empty queue', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      await f.seed();
      const store = await f.open();
      await store.discover();
      await f.exec(`DELETE FROM "${delivery.delivery}"`);
      await assert.rejects(store.claim(1000), EventDeliveryUnavailable);
    });

    test('wall-clock regression refuses mutation and does not shorten a lease', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      await f.seed();
      const store = await f.open();
      await store.discover();
      const claim = (await store.claim(1000))!;
      await assert.rejects(store.complete(claim, 'accepted', 'accepted', 999), EventDeliveryUnavailable);
      assert.equal((await store.inspect())[0].leaseUntil, 1100);
    });
  });

describe('event delivery store on SQLite only', () => {
  test('provisioning and opening never create a missing file', async (t) => {
    const f = eventDeliveryFixture(t, eventDeliveryPolicy(), false);
    await f.seed();
    assertSqliteCommandJournal(f.db);
    assertSqliteCommandEventStore(f.db, f.policy.source);
    assert.throws(() => provisionSqliteEventDeliveryStore(f.path, f.policy, { stopped: false } as never));
    const absent = join(f.directory, 'absent.db');
    assert.throws(() => provisionSqliteEventDeliveryStore(absent, f.policy, { stopped: true }), EventDeliveryUnavailable);
    assert.equal(existsSync(absent), false);
    assert.throws(() => openSqliteEventDeliveryStore(absent, f.policy), EventDeliveryUnavailable);
    assert.equal(existsSync(absent), false);
  });

  test('new receipts older by ID/time and SQLite VACUUM are not lost by discovery checkpoints', async (t) => {
    const f = eventDeliveryFixture(t);
    await f.seed('z-last');
    const store = f.open();
    await store.discover();
    await store.close();
    await f.seed('a-late');
    f.db.exec('VACUUM');
    const reopened = f.open();
    assert.deepEqual(await reopened.discover(), { scanned: 1, scheduled: 1, pressure: false });
    assert.equal((await reopened.inspect()).length, 2);
  });

  for (const sql of [
    `CREATE TABLE __mistri_delivery_unexpected (id TEXT)`,
    `CREATE TRIGGER extra AFTER UPDATE ON "${delivery.delivery}" BEGIN SELECT 1; END`,
    `DROP INDEX __mistri_delivery_ready`,
    `DROP TABLE "${delivery.attempt}"`,
    `UPDATE "${delivery.meta}" SET version=2`,
  ])
    test(`changed delivery schema is refused: ${sql}`, (t) => {
      const f = eventDeliveryFixture(t);
      f.db.exec('PRAGMA ignore_check_constraints=ON');
      f.db.exec(sql);
      assert.throws(() => f.open(), EventDeliveryUnavailable);
      assert.throws(() => provisionSqliteEventDeliveryStore(f.path, f.policy, { stopped: true }), EventDeliveryUnavailable);
    });

  test('TEMP shadow/trigger, disabled foreign keys and source replacement refuse attestation', async (t) => {
    const f = eventDeliveryFixture(t);
    f.db.exec(`CREATE TEMP TRIGGER shadow AFTER INSERT ON main."${delivery.delivery}" BEGIN SELECT 1; END`);
    assert.throws(() => assertSqliteEventDeliveryStore(f.db, f.policy));
    f.db.exec('DROP TRIGGER temp.shadow');
    f.db.exec('PRAGMA foreign_keys=OFF');
    assert.throws(() => assertSqliteEventDeliveryStore(f.db, f.policy));
    f.db.exec('PRAGMA foreign_keys=ON');
    const store = f.open();
    renameSync(f.path, join(f.directory, 'original.db'));
    const replacement = new DatabaseSync(f.path);
    replacement.close();
    await assert.rejects(store.discover(), EventDeliveryUnavailable);
  });
});
