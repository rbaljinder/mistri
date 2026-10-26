/**
 * Retention, on each engine. Rows still to deliver are what retention
 * bounds, so a destination never stops for its age; delivered receipts are
 * pruned by age, whole, in bounded batches; and a pruned receipt's marker
 * stays, so discovery never takes it up again.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EVENT_DELIVERY_TABLES as delivery } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { EventDeliveryUnavailable, type EventDeliveryPolicy } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { createEventPublisher, type PublicationTick } from '../packages/mistri/src/server/events/eventPublisher.js';
import { eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { deliveryEngines, type DeliveryEngineFixture } from './support/eventDeliveryEngines.js';

/** The smallest retention a destination may have: 32 rows still to deliver. */
const retention = (events = 1): EventDeliveryPolicy => {
  const base = eventDeliveryPolicy(events);
  return { ...base, limits: { ...base.limits, maxRetained: 32 } };
};
const counted = (table: string, where = '') => `SELECT count(*) AS n FROM "${table}"${where}`;
async function seedMany(f: DeliveryEngineFixture, from: number, count: number) {
  const seeded = [];
  for (let i = from; i < from + count; i++) seeded.push(...(await f.seed(`receipt-${String(i).padStart(3, '0')}`)));
  return seeded;
}

for (const engine of deliveryEngines)
  describe(`event delivery retention on ${engine.name}`, { skip: engine.skip }, () => {
    test('delivery continues past maxRetained delivered facts, across prune cycles, and never sends a fact twice', async (t) => {
      const f = await engine.fixture(t, retention());
      const sent: string[] = [];
      let now = 1_000;
      const publisher = createEventPublisher(
        await f.open(),
        async (publication) => {
          sent.push(publication.idempotencyKey);
          return 'accepted';
        },
        () => now,
      );
      t.after(() => publisher.stop());
      const store = await f.open();
      const drain = async (): Promise<PublicationTick> => {
        for (let i = 0; i < 500; i++) {
          const tick = await publisher.tick();
          if (tick.status === 'idle') return tick;
          assert.equal(tick.status, 'accepted');
          now++;
        }
        return assert.fail('delivery never went idle');
      };
      const pruneAll = async (limit: number) => {
        const batches: number[] = [];
        for (let more = true; more;) {
          const result = await store.prune(500, now, limit);
          batches.push(result.receipts);
          more = result.more;
        }
        return batches;
      };
      // Forty facts and nothing pruned: delivered rows do not count toward
      // retention, so the destination goes past its 32 rows without stopping.
      const seeded = await seedMany(f, 0, 40);
      assert.deepEqual(await drain(), { status: 'idle', pressure: false });
      assert.equal(await f.scalar(counted(delivery.delivery, " WHERE state='delivered'")), 40);
      // Pruning is by age and in bounded batches: whole receipts, markers kept.
      assert.deepEqual(await pruneAll(16), [0]);
      now += 1_000;
      assert.deepEqual(await pruneAll(16), [16, 16, 8]);
      assert.equal(await f.scalar(counted(delivery.delivery)), 0);
      assert.equal(await f.scalar(counted(delivery.attempt)), 0);
      assert.equal(await f.scalar(counted(delivery.receipt)), 40);
      assert.equal(await f.scalar(counted(delivery.receipt, ' WHERE pruned_at IS NOT NULL')), 40);
      // Nothing pruned is discovered again.
      assert.deepEqual(await store.discover(), { scanned: 0, scheduled: 0, pressure: false });
      // Two more cycles of new facts, each pruned before the next arrives.
      for (const [from, count] of [
        [40, 30],
        [70, 30],
      ] as const) {
        seeded.push(...(await seedMany(f, from, count)));
        assert.deepEqual(await drain(), { status: 'idle', pressure: false });
        now += 1_000;
        assert.equal(
          (await pruneAll(64)).reduce((sum, receipts) => sum + receipts, 0),
          count,
        );
      }
      assert.equal(sent.length, 100);
      assert.deepEqual([...sent].sort(), seeded.map((event) => event.eventId).sort());
      assert.equal(await f.scalar(counted(delivery.receipt)), 100);
      assert.deepEqual(await store.discover(), { scanned: 0, scheduled: 0, pressure: false });
      assert.equal(await store.claim(now), undefined);
      assert.equal(await f.executions(), 100);
    });

    test('prune takes only whole receipts whose every fact was delivered long enough ago', async (t) => {
      const f = await engine.fixture(t, retention(2));
      await f.seed('receipt-a');
      await f.seed('receipt-b');
      const store = await f.open();
      await store.discover();
      // receipt-a's two facts at 1000 and 1001, receipt-b's head at 1002; its tail stays pending.
      for (const time of [1_000, 1_001, 1_002]) {
        const claim = (await store.claim(time))!;
        assert.ok(await store.complete(claim, 'accepted', 'accepted', time));
      }
      assert.deepEqual(await store.prune(500, 1_400), { receipts: 0, deliveries: 0, more: false });
      assert.deepEqual(await store.prune(500, 1_600), { receipts: 1, deliveries: 2, more: false });
      assert.deepEqual(await store.prune(0, 9_000), { receipts: 0, deliveries: 0, more: false });
      assert.equal(await f.scalar(counted(delivery.delivery)), 2);
      assert.equal(await f.scalar(counted(delivery.receipt, " WHERE pruned_at IS NOT NULL AND receipt_id='receipt-a'")), 1);
      assert.deepEqual(await store.discover(), { scanned: 0, scheduled: 0, pressure: false });
      const tail = (await store.claim(9_001))!;
      assert.equal(tail.envelope.receiptId, 'receipt-b');
      assert.equal(tail.envelope.ordinal, 1);
      for (const [age, limit] of [
        [-1, 1],
        [0, 0],
        [0, 1_001],
      ])
        await assert.rejects(store.prune(age, 9_002, limit), EventDeliveryUnavailable);
    });
  });
