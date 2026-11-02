/**
 * A delivery destination whose producing command was bumped (a field report, F17). A job's destination is named
 * `job:<id>@<job version>`, and its stored policy names the producing command's version in its routes; after a bump
 * the two disagree, and the store used to refuse with a generic "could not be verified", which provisioning could
 * not repair. Now the refusal names its cause, maintenance replaces a drained destination, and an effect's destinations
 * (a new one for every bump) are retired once drained, so a store never reaches its sixteen through upgrades alone.
 * On every engine: SQLite always, PostgreSQL when TABLEWALK_TEST_PG names a server.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EVENT_DELIVERY_TABLES as delivery } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import {
  EventDeliveryDestinationChanged,
  EventDeliveryUnavailable,
  type EventDeliveryPolicy,
} from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { deliveryEngines } from './support/eventDeliveryEngines.js';

const rows = (table: string) => `SELECT count(*) AS n FROM "${table}"`;
/** The same destination, its producer at another version. */
const bumped = (policy: EventDeliveryPolicy, version = 3): EventDeliveryPolicy => ({
  ...policy,
  routes: policy.routes.map((route) => ({ ...route, commandVersion: version })),
});
const effect = (base: EventDeliveryPolicy, version: number): EventDeliveryPolicy => ({
  ...bumped(base, version),
  destinationId: `effect:hook@${version}`,
});

for (const engine of deliveryEngines)
  describe(`a delivery destination whose producer version changed, on ${engine.name}`, { skip: engine.skip }, () => {
    test('is refused by name: the destination, the versions it was made for and the versions now', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      for (const attempt of [() => f.open(bumped(f.policy)), () => f.provision(bumped(f.policy))]) {
        await assert.rejects(attempt(), (error: unknown) => {
          assert.ok(error instanceof EventDeliveryDestinationChanged, String(error));
          // It is still the unavailable-store refusal every caller already handles.
          assert.ok(error instanceof EventDeliveryUnavailable);
          assert.equal(error.destinationId, 'assignment-facts-v1');
          assert.deepEqual([error.stored, error.current], [['assign@2'], ['assign@3']]);
          assert.match(error.message, /"assignment-facts-v1" was made for assign@2 and this App now derives assign@3/);
          assert.match(error.message, /bump the version of the job or workflow/);
          assert.match(error.message, /mistri migrate up --app/);
          assert.doesNotMatch(error.message, /north|payload|fingerprint/, 'no tenant, payload or provenance is echoed');
          return true;
        });
      }
    });

    test('is replaced by maintenance once nothing in it is undelivered, and not before', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      await f.seed();
      const store = await f.open();
      await store.discover();
      const next = bumped(f.policy);
      await assert.rejects(
        f.provision(next, { replace: true }),
        (error: unknown) =>
          error instanceof EventDeliveryDestinationChanged &&
          error.undelivered === 1 &&
          /1 delivery is still undelivered/.test(error.message),
      );
      assert.equal(await f.scalar(rows(delivery.delivery)), 1, 'a refused replacement changed nothing');
      const claim = (await store.claim(1_000))!;
      assert.ok(await store.complete(claim, 'accepted', 'accepted', 1_001));
      await store.close();

      const replaced = await f.provision(next, { replace: true });
      assert.equal(replaced.destinationReplaced, true);
      assert.equal(replaced.destinationAdded, true);
      assert.equal(await f.scalar(rows(delivery.destination)), 1);
      assert.equal(await f.scalar(rows(delivery.delivery)), 0, 'what was kept for the old destination goes with it');
      assert.equal(await f.scalar(rows(delivery.receipt)), 0);
      const opened = await f.open(next);
      assert.deepEqual(await opened.discover(), { scanned: 1, scheduled: 0, pressure: false });

      const again = await f.provision(next, { replace: true });
      assert.deepEqual([again.destinationReplaced, again.destinationAdded], [false, false]);
    });

    test('is not replaced when its routes are the same, which would deliver delivered events again', async (t) => {
      const f = await engine.fixture(t, eventDeliveryPolicy());
      const looser = { ...f.policy, limits: { ...f.policy.limits, maxAttempts: 4 } };
      await assert.rejects(
        f.provision(looser, { replace: true }),
        (error: unknown) =>
          error instanceof EventDeliveryDestinationChanged &&
          !error.replaceable &&
          /same routes/.test(error.summary) &&
          /does not replace it/.test(error.message),
      );
    });

    test('effect destinations a bump leaves behind are retired once drained: a store never reaches its limit', async (t) => {
      const base = eventDeliveryPolicy();
      // Before: every version is a destination for good, and the store refuses a seventeenth.
      const kept = await engine.fixture(t, effect(base, 1));
      let refusedAt = 0;
      for (let version = 2; version <= 20 && !refusedAt; version++) {
        await kept.provision(effect(base, version)).catch((error: unknown) => {
          assert.ok(error instanceof EventDeliveryUnavailable);
          refusedAt = version;
        });
      }
      assert.equal(refusedAt, 17, 'the seventeenth destination is refused');

      const retired = await engine.fixture(t, effect(base, 1));
      for (let version = 2; version <= 20; version++) {
        const policy = effect(base, version);
        const made = await retired.provision(policy, { retire: { prefix: 'effect:', keep: [policy.destinationId] } });
        assert.equal(made.destinationAdded, true);
        assert.deepEqual(made.retired, [`effect:hook@${version - 1}`]);
      }
      assert.equal(await retired.scalar(rows(delivery.destination)), 1);
      await (await retired.open(effect(base, 20))).close();
    });

    test('an effect destination with undelivered rows is not retired', async (t) => {
      const base = eventDeliveryPolicy();
      const f = await engine.fixture(t, effect(base, 1));
      await f.seed();
      await (await f.open()).discover();
      const next = effect(base, 2);
      const made = await f.provision(next, { retire: { prefix: 'effect:', keep: [next.destinationId] } });
      assert.deepEqual(made.retired, []);
      assert.equal(await f.scalar(rows(delivery.destination)), 2);
    });
  });
