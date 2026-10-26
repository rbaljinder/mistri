import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_EVENT_TABLES as events } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { EVENT_DELIVERY_TABLES as delivery } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { EventDeliveryUnavailable, type EventDeliveryPolicy } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import {
  createEventPublisher,
  type EventPublication,
  type EventPublicationTransport,
} from '../packages/mistri/src/server/events/eventPublisher.js';
import { eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { deliveryEngines, type DeliveryEngine, type DeliveryEngineFixture } from './support/eventDeliveryEngines.js';

// The existing publisher tests prove one failure at a time. This file drives a
// scripted transport through a sustained outage and back, on a clock the test
// owns, and asserts exact bounded counts at every step, on each engine. Real
// time never advances the publisher here: its per-attempt timer is mocked
// wherever a send takes real time (a hang that must outlive a lease, or a
// transport that reads the store), and the store's clock is the injected
// `now` (the PostgreSQL fixture uses the caller's clock for exactly this).
type Mode = 'down' | 'hanging' | 'up' | { rejectEvery: number };
type Outcome = 'threw' | 'rejected' | 'accepted' | 'hung';
function scriptedTransport(observe: (publication: EventPublication) => Promise<void> = async () => {}) {
  let mode: Mode = 'up',
    callsInMode = 0;
  const log: { key: string; outcome: Outcome }[] = [];
  const hanging: ((result: 'accepted' | 'rejected') => void)[] = [];
  const transport: EventPublicationTransport = async (publication) => {
    await observe(publication);
    callsInMode++;
    const key = publication.idempotencyKey;
    if (mode === 'down') {
      log.push({ key, outcome: 'threw' });
      throw new Error('connection refused');
    }
    if (mode === 'hanging') {
      log.push({ key, outcome: 'hung' });
      return new Promise((resolve) => {
        hanging.push(resolve);
      });
    }
    const result = mode === 'up' || callsInMode % mode.rejectEvery !== 0 ? 'accepted' : 'rejected';
    log.push({ key, outcome: result });
    return result;
  };
  return {
    transport,
    log,
    set(next: Mode) {
      mode = next;
      callsInMode = 0;
    },
    /** Settles the n-th hung call late; the caller decides when that is. */
    release(index: number, result: 'accepted' | 'rejected') {
      hanging[index](result);
    },
    outcomes: (key: string) => log.filter((entry) => entry.key === key).map((entry) => entry.outcome),
    keys: (outcome: Outcome) => log.filter((entry) => entry.outcome === outcome).map((entry) => entry.key),
  };
}
/** Lets a started tick reach the transport: several store round trips on
 * PostgreSQL. Polls on setImmediate, which the mocked timers leave alone, for
 * up to ten seconds of real time: a count of turns is a few hundred
 * milliseconds, which a loaded runner's round trips can outlast. */
async function until(condition: () => boolean) {
  const end = performance.now() + 10_000;
  while (!condition() && performance.now() < end) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'the tick never reached the transport');
}
/** Event-loop turns, so a started tick gets as far as the mocked timers let it. */
async function turns(count = 20) {
  for (let i = 0; i < count; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
/** Real time passing, without a timer the mocked clock would never fire. */
async function outlast(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) await new Promise<void>((resolve) => setImmediate(resolve));
}
function outagePolicy(eventCount: number, limits: Partial<EventDeliveryPolicy['limits']>): EventDeliveryPolicy {
  const base = eventDeliveryPolicy(eventCount);
  return { ...base, limits: { ...base.limits, ...limits } };
}
async function seedReceipts(f: DeliveryEngineFixture, count: number) {
  const seeded = [];
  for (let i = 1; i <= count; i++) seeded.push(await f.seed(`receipt-${String(i).padStart(2, '0')}`));
  return seeded;
}
const counted = (table: string, where = '') => `SELECT count(*) AS n FROM "${table}"${where}`;
/** Inspection orders by random event ID; receipt order is what the test reasons about. */
const byReceipt = <T extends { receiptId: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.receiptId.localeCompare(b.receiptId));
async function drive(publisher: ReturnType<typeof createEventPublisher>, expected: string, times: number) {
  for (let i = 0; i < times; i++) assert.equal((await publisher.tick()).status, expected, `tick ${i + 1} of ${times}`);
}

/** Twelve receipts of three declared facts each, against retention for 32
 * rows still to deliver, so the outage runs under pressure with only ten
 * receipt heads eligible. Attempts back off 10, 20, 40, 80ms and fail at the
 * fourth. */
async function sustainedOutage(t: TestContext, engine: DeliveryEngine) {
  // Each send reads the store: a whole attested transaction on another
  // connection, which on a loaded host takes longer than the 20ms attempt
  // timeout. The publisher rightly records such a send as a timeout, not the
  // transport failure scripted here, so on a real timer the exact counts
  // below depend on the database's speed. The timer is the test's, like the
  // clock, and the second send is held past the timeout in real time so
  // that stays proven.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const policy = outagePolicy(3, { maxAttempts: 4, maxBackoffMs: 80, maxRetained: 32 });
  const f = await engine.fixture(t, policy);
  const seeded = await seedReceipts(f, 12);
  const heads = seeded.slice(0, 10).map((batch) => batch[0].eventId);
  const probe = await f.open();
  let now = 1000;
  const leasedDuringSend: number[] = [];
  let sends = 0;
  const scripted = scriptedTransport(async () => {
    if (++sends === 2) await outlast(2 * policy.limits.timeoutMs);
    leasedDuringSend.push((await probe.inspect('leased')).length);
  });
  const publisher = createEventPublisher(await f.open(), scripted.transport, () => now);
  t.after(() => publisher.stop());
  const rows = () => probe.inspect(undefined, '', 128);
  const shape = async (state: string, attempts: number, nextAt: number, lastCode: string | null) =>
    (await rows()).filter((row) => row.state === state && row.attempts === attempts && row.nextAt === nextAt && row.lastCode === lastCode)
      .length;

  // Discovery is bounded by scanBatch, then by retention: 8 receipts, 2 more,
  // then pressure without partially scheduling the eleventh receipt.
  scripted.set('down');
  assert.deepEqual(await publisher.tick(), { status: 'unknown', pressure: false });
  assert.equal((await rows()).length, 24);
  assert.deepEqual(await publisher.tick(), { status: 'unknown', pressure: true });
  assert.equal((await rows()).length, 30);
  await drive(publisher, 'unknown', 8);
  assert.deepEqual(await publisher.tick(), { status: 'idle', pressure: true });
  assert.equal(await f.scalar(counted(delivery.receipt)), 10);
  assert.equal(scripted.log.length, 10);
  assert.deepEqual(scripted.keys('threw'), heads);
  assert.equal(await shape('unknown', 1, 1010, 'transport'), 10);
  assert.equal(await shape('pending', 0, 0, null), 20);
  assert.equal(publisher.status(), 'running');

  // Nothing is re-attempted inside a backoff window, on either failure kind.
  now = 1009;
  assert.deepEqual(await publisher.tick(), { status: 'idle', pressure: true });
  assert.equal(scripted.log.length, 10);
  now = 1010;
  scripted.set({ rejectEvery: 1 });
  await drive(publisher, 'rejected', 10);
  assert.deepEqual(await publisher.tick(), { status: 'idle', pressure: true });
  assert.equal(await shape('retry', 2, 1030, 'rejected'), 10);
  now = 1029;
  assert.deepEqual(await publisher.tick(), { status: 'idle', pressure: true });
  now = 1030;
  scripted.set('down');
  await drive(publisher, 'unknown', 10);
  assert.deepEqual(await publisher.tick(), { status: 'idle', pressure: true });
  assert.equal(await shape('unknown', 3, 1070, 'transport'), 10);
  assert.equal(await shape('pending', 0, 0, null), 20);
  now = 1069;
  assert.deepEqual(await publisher.tick(), { status: 'idle', pressure: true });
  assert.equal(scripted.log.length, 30);
  for (const head of heads) assert.deepEqual(scripted.outcomes(head), ['threw', 'rejected', 'threw']);
  assert.deepEqual(
    leasedDuringSend,
    Array.from({ length: 30 }, () => 1),
  );
  assert.equal(await f.executions(), 12);
  return {
    f,
    policy,
    seeded,
    heads,
    probe,
    scripted,
    publisher,
    rows,
    shape,
    leasedDuringSend,
    clock: (value: number) => {
      now = value;
    },
  };
}

for (const engine of deliveryEngines)
  describe(`event delivery through an outage on ${engine.name}`, { skip: engine.skip }, () => {
    test('a sustained transport outage retries every eligible event once per backoff window under bounded pressure', async (t) => {
      const o = await sustainedOutage(t, engine);
      for (const head of o.heads) {
        assert.deepEqual(
          (await o.probe.attempts(head)).map((row) => [row.outcome, row.code, row.startedAt, row.finishedAt]),
          [
            ['unknown', 'transport', 1000, 1000],
            ['rejected', 'rejected', 1010, 1010],
            ['unknown', 'transport', 1030, 1030],
          ],
        );
      }
      // Later declarations of a receipt are never attempted while its head fails.
      assert.deepEqual(
        (await o.rows()).filter((row) => row.ordinal > 0).map((row) => row.attempts),
        Array.from({ length: 20 }, () => 0),
      );
      assert.equal(o.publisher.status(), 'running');
    });

    test('recovery delivers every event exactly once, in receipt order, and takes up the held receipts as the backlog drains', async (t) => {
      const o = await sustainedOutage(t, engine);
      o.clock(1070);
      o.scripted.set('up');
      const statuses: string[] = [];
      for (let i = 0; i < 60; i++) {
        const tick = await o.publisher.tick();
        statuses.push(tick.status);
        if (tick.status === 'idle') {
          assert.equal(tick.pressure, false);
          break;
        }
      }
      assert.deepEqual(statuses, [...Array.from({ length: 36 }, () => 'accepted'), 'idle']);
      const all = o.seeded.flatMap((batch) => batch.map((event) => event.eventId));
      const accepted = o.scripted.keys('accepted');
      assert.deepEqual([...accepted].sort(), [...all].sort());
      // Every receipt's declarations arrive in their declared order.
      for (const batch of o.seeded) {
        const positions = batch.map((event) => accepted.indexOf(event.eventId));
        assert.deepEqual(
          positions,
          [...positions].sort((a, b) => a - b),
        );
      }
      for (const head of o.heads) assert.deepEqual(o.scripted.outcomes(head), ['threw', 'rejected', 'threw', 'accepted']);
      for (const tail of all.filter((id) => !o.heads.includes(id))) assert.deepEqual(o.scripted.outcomes(tail), ['accepted']);
      assert.equal(await o.shape('delivered', 4, 1070, 'accepted'), 10);
      assert.equal((await o.rows()).filter((row) => row.state === 'delivered').length, 36);
      // Delivered rows no longer count toward retention: receipts 11 and 12
      // were scheduled as soon as rows still to deliver made room for them.
      assert.equal(await o.f.scalar(counted(delivery.receipt)), 12);
      assert.equal(await o.f.scalar(counted(delivery.attempt, " WHERE outcome='accepted'")), 36);
      assert.deepEqual(
        o.leasedDuringSend,
        Array.from({ length: 66 }, () => 1),
      );
      assert.equal(await o.f.executions(), 12);
    });

    test('an outage past the attempt ceiling settles events as failed, and recovery does not resend them', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const seeded = await seedReceipts(f, 3);
      const keys = seeded.map(([event]) => event.eventId);
      let now = 1000;
      const scripted = scriptedTransport();
      const publisher = createEventPublisher(await f.open(), scripted.transport, () => now);
      t.after(() => publisher.stop());
      scripted.set('down');
      for (const [time, status] of [
        [1000, 'unknown'],
        [1010, 'unknown'],
        [1030, 'unknown'],
      ] as const) {
        now = time;
        await drive(publisher, status, 3);
        assert.equal((await publisher.tick()).status, 'idle');
      }
      const store = await f.open();
      assert.deepEqual(
        (await store.inspect('failed')).map((row) => [row.attempts, row.nextAt, row.lastCode]),
        [
          [3, 1050, 'transport'],
          [3, 1050, 'transport'],
          [3, 1050, 'transport'],
        ],
      );
      assert.equal(scripted.log.length, 9);
      now = 1050;
      scripted.set('up');
      assert.equal((await publisher.tick()).status, 'idle');
      now = 100_000;
      assert.equal((await publisher.tick()).status, 'idle');
      assert.equal(scripted.log.length, 9);
      for (const key of keys) assert.deepEqual(scripted.outcomes(key), ['threw', 'threw', 'threw']);
      // A failed row stays failed until an operator redrives it
      // (event-redrive.test.ts): claim excludes rows at their budget.
      assert.equal(await store.claim(100_001), undefined);
      assert.equal((await store.inspect('failed')).length, 3);
      assert.equal((await store.inspect('delivered')).length, 0);
      assert.equal(await f.executions(), 3);
    });

    test('a publisher that crashes mid-send loses its lease to a second instance, and its late acceptance is fenced out', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const [[event]] = await seedReceipts(f, 1);
      let now = 1000;
      const scripted = scriptedTransport();
      scripted.set('hanging');
      // No halt, no stop, no ack: the first instance is simply never heard from
      // again until after the takeover. Its mocked timeout never fires.
      const first = createEventPublisher(await f.open(), scripted.transport, () => now);
      const crashed = first.tick();
      await until(() => scripted.log.length === 1);
      const store = await f.open();
      const base = { eventId: event.eventId, receiptId: 'receipt-01', ordinal: 0, maxAttempts: 3, redrives: 0 };
      assert.deepEqual((await store.inspect())[0], { ...base, state: 'leased', attempts: 1, nextAt: 0, leaseUntil: 1100, lastCode: null });
      now = 1100;
      const second = createEventPublisher(await f.open(), scripted.transport, () => now);
      t.after(async () => {
        await second.stop();
        await first.stop();
      });
      // Expiry settles the abandoned attempt as unknown and schedules its backoff
      // from the lease end, so the takeover itself waits one backoff.
      assert.equal((await second.tick()).status, 'idle');
      assert.deepEqual((await store.inspect())[0], {
        ...base,
        state: 'unknown',
        attempts: 1,
        nextAt: 1110,
        leaseUntil: null,
        lastCode: 'lease_expired',
      });
      now = 1110;
      const takeover = second.tick();
      await until(() => scripted.log.length === 2);
      assert.deepEqual(scripted.outcomes(event.eventId), ['hung', 'hung']);
      // A new lease keeps the previous attempt's code in inspection; claim does
      // not clear last_code. The attempt row, not this column, is the live truth.
      assert.deepEqual((await store.inspect())[0], {
        ...base,
        state: 'leased',
        attempts: 2,
        nextAt: 1110,
        leaseUntil: 1210,
        lastCode: 'lease_expired',
      });
      // The crashed instance finally hears "accepted" while the second lease is
      // live. Its token no longer matches: nothing is marked and it halts.
      scripted.release(0, 'accepted');
      assert.deepEqual(await crashed, { status: 'unknown', pressure: false });
      assert.equal(first.status(), 'halted');
      assert.deepEqual((await store.inspect())[0], {
        ...base,
        state: 'leased',
        attempts: 2,
        nextAt: 1110,
        leaseUntil: 1210,
        lastCode: 'lease_expired',
      });
      scripted.release(1, 'accepted');
      assert.deepEqual(await takeover, { status: 'accepted', pressure: false });
      assert.deepEqual((await store.inspect())[0], {
        ...base,
        state: 'delivered',
        attempts: 2,
        nextAt: 1110,
        leaseUntil: null,
        lastCode: 'accepted',
      });
      assert.deepEqual(
        (await store.attempts(event.eventId)).map((row) => [
          row.attempt,
          row.outcome,
          row.code,
          row.startedAt,
          row.deadline,
          row.finishedAt,
        ]),
        [
          [1, 'unknown', 'lease_expired', 1000, 1100, 1100],
          [2, 'accepted', 'accepted', 1110, 1210, 1110],
        ],
      );
      assert.equal(await f.scalar(counted(delivery.delivery, " WHERE state='delivered'")), 1);
      assert.equal(await f.scalar(counted(delivery.attempt, " WHERE outcome='accepted'")), 1);
      assert.equal(await f.executions(), 1);
    });

    test('an acceptance that arrives after the per-attempt deadline is unknown, and the next attempt resends the same key', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const [[event]] = await seedReceipts(f, 1);
      let now = 1000;
      let published: EventPublication | undefined;
      const scripted = scriptedTransport(async (publication) => {
        published = publication;
      });
      scripted.set('hanging');
      const first = createEventPublisher(await f.open(), scripted.transport, () => now);
      const timedOut = first.tick();
      await until(() => scripted.log.length === 1);
      assert.equal(published!.deadline, 1020);
      t.mock.timers.tick(19);
      assert.equal(published!.signal.aborted, false);
      t.mock.timers.tick(1);
      assert.equal(published!.signal.aborted, true);
      // The publisher waits for the aborted send to let go until the lease
      // ends, 99ms on from here. This one never does, so the publisher halts.
      let settled = false;
      void timedOut.then(() => {
        settled = true;
      });
      await turns();
      t.mock.timers.tick(98);
      await turns();
      assert.equal(settled, false);
      t.mock.timers.tick(1);
      assert.deepEqual(await timedOut, { status: 'unknown', pressure: false });
      assert.equal(first.status(), 'halted');
      const store = await f.open();
      const afterTimeout = {
        eventId: event.eventId,
        receiptId: 'receipt-01',
        ordinal: 0,
        maxAttempts: 3,
        redrives: 0,
        state: 'unknown',
        attempts: 1,
        nextAt: 1010,
        leaseUntil: null,
        lastCode: 'timeout',
      };
      assert.deepEqual((await store.inspect())[0], afterTimeout);
      // The late "accepted" has no path to storage: the attempt is already closed.
      scripted.release(0, 'accepted');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual((await store.inspect())[0], afterTimeout);
      await first.stop();
      assert.deepEqual(await first.tick(), { status: 'stopped', pressure: false });
      now = 1010;
      scripted.set('up');
      const second = createEventPublisher(await f.open(), scripted.transport, () => now);
      t.after(() => second.stop());
      assert.deepEqual(await second.tick(), { status: 'accepted', pressure: false });
      assert.deepEqual(scripted.outcomes(event.eventId), ['hung', 'accepted']);
      assert.deepEqual(
        (await store.attempts(event.eventId)).map((row) => [row.outcome, row.code, row.startedAt, row.finishedAt]),
        [
          ['unknown', 'timeout', 1000, 1000],
          ['accepted', 'accepted', 1010, 1010],
        ],
      );
      assert.equal((await store.inspect())[0].state, 'delivered');
      assert.equal(await f.executions(), 1);
    });

    test('a send slower than its attempt timeout is unknown and retried after backoff, and the publisher keeps running', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const [[event]] = await seedReceipts(f, 1);
      let now = 1000;
      const sent: EventPublication[] = [];
      let answer!: (result: 'accepted') => void;
      // A slow webhook: the first call gives up as soon as it is aborted, the
      // second ignores the abort and answers late but inside the lease, and
      // the third answers in time.
      const publisher = createEventPublisher(
        await f.open(),
        (publication) =>
          new Promise((resolve, reject) => {
            sent.push(publication);
            if (sent.length === 1) publication.signal.addEventListener('abort', () => reject(new Error('aborted')));
            else if (sent.length === 2) answer = resolve;
            else resolve('accepted');
          }),
        () => now,
      );
      t.after(() => publisher.stop());
      const store = await f.open();
      const base = {
        eventId: event.eventId,
        receiptId: 'receipt-01',
        ordinal: 0,
        maxAttempts: 3,
        redrives: 0,
        leaseUntil: null,
        lastCode: 'timeout',
      };
      const first = publisher.tick();
      await until(() => sent.length === 1);
      t.mock.timers.tick(20);
      assert.deepEqual(await first, { status: 'unknown', pressure: false });
      assert.equal(publisher.status(), 'running');
      assert.deepEqual((await store.inspect())[0], { ...base, state: 'unknown', attempts: 1, nextAt: 1010 });
      now = 1009;
      assert.deepEqual(await publisher.tick(), { status: 'idle', pressure: false });
      now = 1010;
      const second = publisher.tick();
      await until(() => sent.length === 2);
      t.mock.timers.tick(20);
      assert.equal(sent[1].signal.aborted, true);
      let settled = false;
      void second.then(() => {
        settled = true;
      });
      await turns();
      assert.equal(settled, false);
      // Acceptance after the deadline is ambiguous: still unknown, still retried.
      answer('accepted');
      assert.deepEqual(await second, { status: 'unknown', pressure: false });
      assert.equal(publisher.status(), 'running');
      assert.deepEqual((await store.inspect())[0], { ...base, state: 'unknown', attempts: 2, nextAt: 1030 });
      now = 1030;
      assert.deepEqual(await publisher.tick(), { status: 'accepted', pressure: false });
      assert.deepEqual(
        sent.map((publication) => publication.idempotencyKey),
        [event.eventId, event.eventId, event.eventId],
      );
      assert.deepEqual(
        (await store.attempts(event.eventId)).map((row) => [row.outcome, row.code, row.startedAt, row.finishedAt]),
        [
          ['unknown', 'timeout', 1000, 1000],
          ['unknown', 'timeout', 1010, 1010],
          ['accepted', 'accepted', 1030, 1030],
        ],
      );
      assert.equal(await f.executions(), 1);
    });

    test('restarting mid-outage keeps retry state, attempt counts and backoff, and leaves the source untouched', async (t) => {
      const policy = outagePolicy(1, { maxAttempts: 4, maxBackoffMs: 80 });
      const f = await engine.fixture(t, policy);
      const seeded = await seedReceipts(f, 3);
      const keys = seeded.map(([event]) => event.eventId);
      // One at a time: the PostgreSQL fixture reads through a single client.
      const evidence = async () => {
        const tables = [];
        // The receipts carry the targets and the event batch as columns; the events are their own table.
        for (const table of [journal.receipt, events.event]) tables.push(await f.rows(`SELECT * FROM "${table}" ORDER BY 1`));
        return JSON.stringify(tables);
      };
      const before = await evidence(),
        executions = await f.executions();
      let now = 1000;
      const scripted = scriptedTransport();
      const first = createEventPublisher(await f.open(), scripted.transport, () => now);
      scripted.set('down');
      await drive(first, 'unknown', 3);
      now = 1010;
      scripted.set({ rejectEvery: 1 });
      await drive(first, 'rejected', 3);
      assert.equal((await first.tick()).status, 'idle');
      await first.stop();
      const store = await f.open();
      const paused = await store.inspect();
      const history = await Promise.all(keys.map((key) => store.attempts(key)));
      assert.deepEqual(
        byReceipt(paused).map((row) => [row.state, row.attempts, row.nextAt, row.lastCode]),
        [
          ['retry', 2, 1030, 'rejected'],
          ['retry', 2, 1030, 'rejected'],
          ['retry', 2, 1030, 'rejected'],
        ],
      );
      const second = createEventPublisher(await f.open(), scripted.transport, () => now);
      t.after(() => second.stop());
      // Same clock, same store: the reopened publisher sees exactly the paused
      // schedule and does not attempt anything until the backoff elapses.
      assert.equal((await second.tick()).status, 'idle');
      now = 1029;
      assert.equal((await second.tick()).status, 'idle');
      assert.deepEqual(await store.inspect(), paused);
      assert.deepEqual(await Promise.all(keys.map((key) => store.attempts(key))), history);
      assert.equal(scripted.log.length, 6);
      // Recovery through a flaky transport: every second call is rejected once
      // more, so receipt-02 needs the fourth (last) attempt after a 40ms backoff.
      now = 1030;
      scripted.set({ rejectEvery: 2 });
      assert.equal((await second.tick()).status, 'accepted');
      assert.equal((await second.tick()).status, 'rejected');
      assert.equal((await second.tick()).status, 'accepted');
      assert.equal((await second.tick()).status, 'idle');
      assert.deepEqual(
        byReceipt(await store.inspect()).map((row) => [row.state, row.attempts, row.nextAt, row.lastCode]),
        [
          ['delivered', 3, 1030, 'accepted'],
          ['retry', 3, 1070, 'rejected'],
          ['delivered', 3, 1030, 'accepted'],
        ],
      );
      now = 1069;
      assert.equal((await second.tick()).status, 'idle');
      now = 1070;
      scripted.set('up');
      assert.equal((await second.tick()).status, 'accepted');
      assert.equal((await second.tick()).status, 'idle');
      assert.deepEqual(
        keys.map((key) => scripted.outcomes(key)),
        [
          ['threw', 'rejected', 'accepted'],
          ['threw', 'rejected', 'rejected', 'accepted'],
          ['threw', 'rejected', 'accepted'],
        ],
      );
      assert.deepEqual(
        byReceipt(await store.inspect()).map((row) => [row.state, row.attempts]),
        [
          ['delivered', 3],
          ['delivered', 4],
          ['delivered', 3],
        ],
      );
      assert.equal(await evidence(), before);
      assert.equal(await f.executions(), executions);
    });

    test('a clock that runs backwards during the outage halts publication instead of shortening a backoff or lease', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const [[event]] = await seedReceipts(f, 1);
      let now = 1000;
      const scripted = scriptedTransport();
      scripted.set('down');
      const first = createEventPublisher(await f.open(), scripted.transport, () => now);
      t.after(() => first.stop());
      assert.equal((await first.tick()).status, 'unknown');
      now = 1010;
      assert.equal((await first.tick()).status, 'unknown');
      const store = await f.open();
      const paused = {
        eventId: event.eventId,
        receiptId: 'receipt-01',
        ordinal: 0,
        maxAttempts: 3,
        redrives: 0,
        state: 'unknown',
        attempts: 2,
        nextAt: 1030,
        leaseUntil: null,
        lastCode: 'transport',
      };
      assert.deepEqual((await store.inspect())[0], paused);
      // The store's persisted clock floor is 1010. A claim at 1005 is refused
      // before any row is read, the publisher reports unavailable and halts, and
      // the transport is not called.
      now = 1005;
      scripted.set('up');
      assert.deepEqual(await first.tick(), { status: 'unavailable', pressure: false });
      assert.equal(first.status(), 'halted');
      assert.equal(scripted.log.length, 2);
      assert.deepEqual((await store.inspect())[0], paused);
      await assert.rejects(store.claim(1009), EventDeliveryUnavailable);
      assert.equal(await f.scalar(`SELECT last_clock FROM "${delivery.meta}"`), 1010);
      // Honest forward time resumes only from a fresh instance; the schedule is intact.
      now = 1030;
      const second = createEventPublisher(await f.open(), scripted.transport, () => now);
      t.after(() => second.stop());
      assert.equal((await second.tick()).status, 'accepted');
      assert.equal((await second.tick()).status, 'idle');
      assert.deepEqual(scripted.outcomes(event.eventId), ['threw', 'threw', 'accepted']);
      assert.deepEqual(
        (await store.attempts(event.eventId)).map((row) => [row.outcome, row.code, row.startedAt]),
        [
          ['unknown', 'transport', 1000],
          ['unknown', 'transport', 1010],
          ['accepted', 'accepted', 1030],
        ],
      );
      assert.equal(await f.executions(), 1);
    });
  });
