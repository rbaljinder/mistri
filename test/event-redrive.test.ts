/**
 * Operator redrive of event deliveries, on each engine: a failed or unknown
 * delivery goes back to retry with a fresh attempt budget, the redrive is a
 * row in the attempt history naming the operator, the number of redrives is
 * capped, and a delivered (or still leased, or never attempted) delivery is
 * refused. Nothing about the event changes: the same envelope and the same
 * idempotency key go out again.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EventDeliveryStore } from '../packages/mistri/src/adapters/events/eventDeliveryContract.js';
import {
  EVENT_DELIVERY_REDRIVE_LIMIT,
  EventDeliveryRefusal,
  type EventDeliveryPolicy,
} from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { createEventPublisher } from '../packages/mistri/src/server/events/eventPublisher.js';
import { eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { deliveryEngines } from './support/eventDeliveryEngines.js';

const refused = (code: string) => (error: unknown) => error instanceof EventDeliveryRefusal && error.code === code;
const policy = (events = 1): EventDeliveryPolicy => eventDeliveryPolicy(events);
/** Rejects the head of the only receipt until its budget is spent. */
async function exhaust(store: EventDeliveryStore, from: number): Promise<number> {
  let time = from;
  for (let i = 0; i < 64; i++, time += 100) {
    const claim = await store.claim(time);
    if (!claim) {
      if ((await store.inspect('failed')).length) return time;
      continue;
    }
    assert.ok(await store.complete(claim, 'rejected', 'rejected', time));
  }
  return assert.fail('the delivery never failed');
}

for (const engine of deliveryEngines)
  describe(`event delivery redrive on ${engine.name}`, { skip: engine.skip }, () => {
    test('a failed delivery goes back to retry with a fresh budget, the operator in its history, and is then delivered', async (t) => {
      const f = await engine.fixture(t, policy());
      const [event] = await f.seed();
      const store = await f.open();
      await store.discover();
      const time = await exhaust(store, 1_000);
      const [failed] = await store.inspect('failed');
      assert.deepEqual([failed.attempts, failed.maxAttempts, failed.redrives], [3, 3, 0]);
      const redriven = await store.redrive(event.eventId, 'operator-ada', time);
      assert.deepEqual(
        [redriven.state, redriven.attempts, redriven.maxAttempts, redriven.redrives, redriven.nextAt, redriven.lastCode],
        ['retry', 4, 7, 1, time, 'redriven'],
      );
      const history = await store.attempts(event.eventId);
      assert.deepEqual(history.at(-1), {
        attempt: 4,
        startedAt: time,
        deadline: null,
        outcome: 'redriven',
        code: 'redriven',
        finishedAt: time,
        operator: 'operator-ada',
      });
      assert.ok(history.slice(0, 3).every((row) => row.operator === null && row.outcome === 'rejected'));
      const keys: string[] = [];
      const publisher = createEventPublisher(
        await f.open(),
        async (publication) => {
          assert.deepEqual(publication.envelope, event);
          keys.push(publication.idempotencyKey);
          return 'accepted';
        },
        () => time,
      );
      try {
        assert.equal((await publisher.tick()).status, 'accepted');
      } finally {
        await publisher.stop();
      }
      assert.deepEqual(keys, [event.eventId]);
      const [delivered] = await store.inspect('delivered');
      assert.deepEqual([delivered.attempts, delivered.redrives], [5, 1]);
      assert.equal(await f.executions(), 1);
      // Inspection of the row itself names no operator.
      assert.doesNotMatch(JSON.stringify(await store.inspect()), /operator/);
    });

    test('an unknown delivery can be redriven at once, and the later declarations of its receipt still wait for it', async (t) => {
      const f = await engine.fixture(t, policy(2));
      const [head, tail] = await f.seed();
      const store = await f.open();
      await store.discover();
      const claim = (await store.claim(1_000))!;
      assert.ok(await store.complete(claim, 'unknown', 'transport', 1_000));
      assert.equal((await store.inspect(undefined, '', 8)).find((row) => row.eventId === head.eventId)!.nextAt, 1_010);
      await assert.rejects(store.redrive(tail.eventId, 'operator-ada', 1_001), refused('not_redrivable'));
      const redriven = await store.redrive(head.eventId, 'operator-ada', 1_001);
      assert.deepEqual([redriven.state, redriven.nextAt, redriven.maxAttempts], ['retry', 1_001, 5]);
      const again = (await store.claim(1_001))!;
      assert.deepEqual([again.eventId, again.attempt], [head.eventId, 3]);
      assert.equal(await store.claim(1_002), undefined);
      assert.ok(await store.complete(again, 'accepted', 'accepted', 1_002));
      assert.equal((await store.claim(1_003))!.eventId, tail.eventId);
    });

    test('delivered, leased and never-attempted deliveries refuse, and so do an unknown id and a bad operator', async (t) => {
      const f = await engine.fixture(t, policy(2));
      const [head, tail] = await f.seed();
      const store = await f.open();
      await store.discover();
      await assert.rejects(store.redrive(head.eventId, 'operator-ada', 1_000), refused('not_redrivable'));
      const claim = (await store.claim(1_000))!;
      await assert.rejects(store.redrive(head.eventId, 'operator-ada', 1_001), refused('not_redrivable'));
      assert.ok(await store.complete(claim, 'accepted', 'accepted', 1_001));
      await assert.rejects(store.redrive(head.eventId, 'operator-ada', 1_002), refused('not_redrivable'));
      await assert.rejects(store.redrive(tail.eventId, 'operator-ada', 1_002), refused('not_redrivable'));
      await assert.rejects(store.redrive('00000000-0000-4000-8000-000000000000', 'operator-ada', 1_002), refused('not_found'));
      await assert.rejects(store.redrive('short', 'operator-ada', 1_002), refused('not_found'));
      for (const operator of ['', ' ada', 'x'.repeat(129), 'ada lovelace', 7]) {
        await assert.rejects(store.redrive(head.eventId, operator as never, 1_002), refused('operator_invalid'));
      }
      assert.deepEqual(
        (await store.attempts(head.eventId)).map((row) => row.outcome),
        ['accepted'],
      );
    });

    test('redrives are capped: the fourth is refused and the delivery stays failed', async (t) => {
      const f = await engine.fixture(t, policy());
      const [event] = await f.seed();
      const store = await f.open();
      await store.discover();
      let time = await exhaust(store, 1_000);
      for (let redrive = 1; redrive <= EVENT_DELIVERY_REDRIVE_LIMIT; redrive++) {
        assert.equal((await store.redrive(event.eventId, `operator-${redrive}`, time)).redrives, redrive);
        time = await exhaust(store, time);
      }
      await assert.rejects(store.redrive(event.eventId, 'operator-ada', time), refused('redrive_limit'));
      const [failed] = await store.inspect('failed');
      assert.deepEqual([failed.state, failed.redrives, failed.attempts, failed.maxAttempts], ['failed', 3, 15, 15]);
      assert.deepEqual(
        (await store.attempts(event.eventId)).filter((row) => row.outcome === 'redriven').map((row) => row.operator),
        ['operator-1', 'operator-2', 'operator-3'],
      );
    });
  });
