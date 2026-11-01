import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { EventDeliveryStore } from '../packages/mistri/src/adapters/events/eventDeliveryContract.js';
import { EVENT_DELIVERY_TABLES as tables } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { createEventPublisher, type EventPublication } from '../packages/mistri/src/server/events/eventPublisher.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';

test('transport receives a captured safe envelope and event idempotency key outside the SQLite writer lock', async (t) => {
  const f = eventDeliveryFixture(t);
  const [event] = await f.seed();
  const publisher = createEventPublisher(
    f.open(),
    async (publication) => {
      assert.deepEqual(publication.envelope, event);
      assert.equal(publication.idempotencyKey, event.eventId);
      assert.equal(publication.serviceId, f.policy.serviceId);
      assert.equal(publication.destinationId, f.policy.destinationId);
      assert.ok(Object.isFrozen(publication));
      assert.ok(Object.isFrozen(publication.envelope));
      assert.ok(Object.isFrozen(publication.envelope.key));
      assert.ok(Object.isFrozen(publication.envelope.causation));
      assert.equal(publication.signal.aborted, false);
      assert.doesNotMatch(JSON.stringify(publication.envelope), /historical-grant|membership|roles|fingerprint|resultJson/);
      const other = new DatabaseSync(f.path);
      try {
        other.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
        assert.equal(other.isTransaction, true);
        other.exec('ROLLBACK');
      } finally {
        other.close();
      }
      return 'accepted';
    },
    () => 1000,
  );
  try {
    assert.equal((await publisher.tick()).status, 'accepted');
    assert.equal((await publisher.tick()).status, 'idle');
  } finally {
    await publisher.stop();
  }
  assert.equal((await f.open().inspect())[0].state, 'delivered');
  assert.equal(f.executions(), 1);
});

test('broker acceptance then failed local acknowledgement duplicates the same event after restart', async (t) => {
  const f = eventDeliveryFixture(t);
  const [event] = await f.seed();
  const accepted: EventPublication[] = [];
  let restore = () => {};
  const publisher = createEventPublisher(
    f.open(),
    async (publication) => {
      accepted.push(publication);
      const prepare = DatabaseSync.prototype.prepare;
      restore = () => {
        DatabaseSync.prototype.prepare = prepare;
      };
      DatabaseSync.prototype.prepare = function (sql) {
        if (sql.startsWith(`UPDATE main."${tables.attempt}" SET outcome=`)) {
          restore();
          throw new Error('Synthetic local acknowledgement failure');
        }
        return Reflect.apply(prepare, this, [sql]);
      };
      return 'accepted';
    },
    () => 1000,
  );
  try {
    assert.equal((await publisher.tick()).status, 'unavailable');
    assert.equal(publisher.status(), 'halted');
  } finally {
    restore();
    await publisher.stop();
  }
  assert.equal((await f.open().inspect())[0].state, 'leased');
  const restarted = createEventPublisher(
    f.open(),
    async (publication) => {
      accepted.push(publication);
      return 'accepted';
    },
    () => 1110,
  );
  try {
    assert.equal((await restarted.tick()).status, 'accepted');
  } finally {
    await restarted.stop();
  }
  assert.equal(accepted.length, 2);
  assert.deepEqual(
    accepted.map((call) => call.idempotencyKey),
    [event.eventId, event.eventId],
  );
  assert.deepEqual(accepted[0].envelope, accepted[1].envelope);
  assert.equal(f.executions(), 1);
  assert.deepEqual(
    (await f.open().attempts(event.eventId)).map((row) => row.outcome),
    ['unknown', 'accepted'],
  );
});

test('lost response after committed local acknowledgement retains delivered state on restart', async (t) => {
  const f = eventDeliveryFixture(t);
  await f.seed();
  let sends = 0;
  const publisher = createEventPublisher(
    f.open(),
    async () => {
      sends++;
      return 'accepted';
    },
    () => 1000,
  );
  const exec = DatabaseSync.prototype.exec;
  let armed = true;
  DatabaseSync.prototype.exec = function (sql) {
    const result = Reflect.apply(exec, this, [sql]);
    if (armed && sql === 'COMMIT' && this.prepare(`SELECT 1 FROM "${tables.delivery}" WHERE state='delivered'`).get()) {
      armed = false;
      throw new Error('Synthetic postcommit response loss');
    }
    return result;
  };
  try {
    assert.equal((await publisher.tick()).status, 'unavailable');
  } finally {
    DatabaseSync.prototype.exec = exec;
    await publisher.stop();
  }
  const restarted = createEventPublisher(
    f.open(),
    async () => {
      sends++;
      return 'accepted';
    },
    () => 1110,
  );
  try {
    assert.equal((await restarted.tick()).status, 'idle');
  } finally {
    await restarted.stop();
  }
  assert.equal(sends, 1);
  assert.equal(f.executions(), 1);
});

for (const kind of ['throw', 'reject', 'invalid'] as const)
  test(`bad transport ${kind} is a bounded retained unknown with safe diagnostics`, async (t) => {
    const f = eventDeliveryFixture(t);
    await f.seed();
    let calls = 0,
      now = 1000;
    const publisher = createEventPublisher(
      f.open(),
      () => {
        calls++;
        if (kind === 'throw') throw new Error('secret-password-do-not-record');
        return kind === 'reject' ? Promise.reject(new Error('secret-password-do-not-record')) : Promise.resolve('invalid' as never);
      },
      () => now,
    );
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await publisher.tick()).status, 'unknown');
        now += 20;
      }
      assert.equal((await publisher.tick()).status, 'idle');
    } finally {
      await publisher.stop();
    }
    assert.equal(calls, 3);
    const store = f.open();
    assert.equal((await store.inspect('failed')).length, 1);
    assert.doesNotMatch(JSON.stringify(await store.attempts((await store.inspect())[0].eventId)), /secret-password/);
  });

test('never-settling transport is aborted once and halts this publisher without accumulating calls', async (t) => {
  const f = eventDeliveryFixture(t);
  await f.seed();
  let calls = 0;
  let publication: EventPublication | undefined;
  const publisher = createEventPublisher(
    f.open(),
    (value) => {
      publication = value;
      calls++;
      return new Promise(() => {});
    },
    () => 1000,
  );
  try {
    const first = publisher.tick();
    assert.equal((await publisher.tick()).status, 'busy');
    assert.equal((await first).status, 'unknown');
    assert.equal(publication!.signal.aborted, true);
    assert.equal(publisher.status(), 'halted');
    for (let i = 0; i < 100; i++) assert.equal((await publisher.tick()).status, 'halted');
    assert.equal(calls, 1);
    assert.equal((await f.open().inspect())[0].state, 'unknown');
  } finally {
    await publisher.stop();
  }
});

test('shutdown aborts in-flight work, retains unknown state, and ignores late acceptance after newer delivery', async (t) => {
  const f = eventDeliveryFixture(t);
  await f.seed();
  let finish!: (result: 'accepted') => void, started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let publication: EventPublication | undefined;
  const publisher = createEventPublisher(
    f.open(),
    (value) => {
      publication = value;
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => 1000,
  );
  const tick = publisher.tick();
  await ready;
  await publisher.stop();
  await publisher.stop();
  assert.equal((await tick).status, 'unknown');
  assert.equal(publication!.signal.aborted, true);
  assert.equal((await publisher.tick()).status, 'stopped');
  const restarted = createEventPublisher(
    f.open(),
    async () => 'accepted',
    () => 1010,
  );
  try {
    assert.equal((await restarted.tick()).status, 'accepted');
  } finally {
    await restarted.stop();
  }
  finish('accepted');
  await Promise.resolve();
  await Promise.resolve();
  const store = f.open();
  assert.equal((await store.inspect())[0].attempts, 2);
  assert.equal((await store.inspect())[0].state, 'delivered');
  assert.deepEqual(
    (await store.attempts((await store.inspect())[0].eventId)).map((row) => row.outcome),
    ['unknown', 'accepted'],
  );
});

test('immediate shutdown before scheduled tick cannot dispatch a transport', async (t) => {
  const f = eventDeliveryFixture(t);
  await f.seed();
  let calls = 0;
  const publisher = createEventPublisher(
    f.open(),
    async () => {
      calls++;
      return 'accepted';
    },
    () => 1000,
  );
  const tick = publisher.tick();
  await publisher.stop();
  await tick;
  assert.equal(calls, 0);
  assert.equal(publisher.status(), 'stopped');
});

test('source corruption after publisher open refuses before transport and retains delivery state', async (t) => {
  const f = eventDeliveryFixture(t);
  await f.seed();
  let calls = 0;
  const publisher = createEventPublisher(
    f.open(),
    async () => {
      calls++;
      return 'accepted';
    },
    () => 1000,
  );
  f.db.exec('ALTER TABLE __mistri_command_receipt ADD COLUMN unexpected TEXT');
  try {
    /* Refused at discovery, before anything is claimed: a cycle that did not
       happen, not a halt (readiness reads the store as unknown meanwhile). Every
       later cycle refuses the same way, and none reaches the transport. */
    assert.equal((await publisher.tick()).status, 'unavailable');
    assert.equal(publisher.status(), 'running');
    assert.equal((await publisher.tick()).status, 'unavailable');
  } finally {
    await publisher.stop();
  }
  assert.equal(calls, 0);
});

test('transport rejection retries with unchanged identity and bounded backoff', async (t) => {
  const f = eventDeliveryFixture(t, eventDeliveryPolicy());
  await f.seed();
  let now = 1000;
  const ids: string[] = [];
  const publisher = createEventPublisher(
    f.open(),
    async (value) => {
      ids.push(value.idempotencyKey);
      return ids.length === 1 ? 'rejected' : 'accepted';
    },
    () => now,
  );
  try {
    assert.equal((await publisher.tick()).status, 'rejected');
    now = 1009;
    assert.equal((await publisher.tick()).status, 'idle');
    now = 1010;
    assert.equal((await publisher.tick()).status, 'accepted');
    assert.equal(ids[0], ids[1]);
  } finally {
    await publisher.stop();
  }
});

test('a store that fails before anything is claimed costs one cycle, not the publisher', async (t) => {
  /* A failover under discover or claim halted delivery until a restart,
     though nothing had been sent and nothing was leased. */
  for (const failing of ['discover', 'claim'] as const) {
    const f = eventDeliveryFixture(t);
    await f.seed();
    const real = f.open();
    let fail = true;
    const store: EventDeliveryStore = {
      ...real,
      [failing]: (...args: never[]) => {
        if (!fail) return (real[failing] as (...a: never[]) => unknown)(...args);
        fail = false;
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      },
    };
    let sent = 0;
    const publisher = createEventPublisher(
      store,
      async () => {
        sent += 1;
        return 'accepted';
      },
      () => 1000,
    );
    try {
      assert.equal((await publisher.tick()).status, 'unavailable', failing);
      assert.equal(publisher.status(), 'running', failing);
      assert.equal(sent, 0, failing);
      assert.equal((await publisher.tick()).status, 'accepted', failing);
      assert.equal(sent, 1, failing);
    } finally {
      await publisher.stop();
    }
  }
});
