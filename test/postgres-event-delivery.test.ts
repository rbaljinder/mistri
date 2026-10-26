/**
 * What only the PostgreSQL delivery store has to show: discovery that
 * cannot skip a transaction committing late, its catalog attestation,
 * provisioning racing itself, claimers on separate connections, and the
 * database clock standing in for the hosts'. The engine-neutral contract is
 * event-delivery-store.test.ts. Live and opt-in like every PostgreSQL suite:
 * `TABLEWALK_TEST_PG` names a disposable database this file resets.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES as journalTables } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import type { EventDeliveryClaim, EventDeliveryPolicy } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { EVENT_DELIVERY_PREFIX, EVENT_DELIVERY_TABLES as delivery } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { EventDeliveryUnavailable } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import {
  openPostgresEventDeliveryStore,
  provisionPostgresEventDeliveryStore,
  type PostgresEventDeliveryStoreOptions,
} from '../packages/mistri/src/adapters/events/postgresEventDeliveryStore.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { PgConnectionManager, type PgQuery, type PgWriteClientSource } from '../packages/engine/src/adapters/postgresPool.js';
import { trustStoreLayoutsFor } from '../packages/mistri/src/adapters/commands/postgresRelations.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { beginPostgresSeed, deliveryEngines } from './support/eventDeliveryEngines.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl, type Control } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { runtimeName, runtimeSchema, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const q = (name: string) => runtimeTable('postgres', name);
const plain = (name: string) => runtimeName('postgres', name);
/* The attestation cases change a layout under an open store and expect its
   next call to refuse, so the layout trust window is closed here; the test
   that measures an idle tick opens it again. */
trustStoreLayoutsFor(0);
/** A statement that reads the catalog, as an attestation's description does. */
const catalog = (sql: string) => /\bpg_(class|attribute|namespace|constraint|index)\b|information_schema/.test(sql);
/** A pool that records every statement its clients run. */
const recording = (manager: PgConnectionManager, seen: string[]): PgWriteClientSource => ({
  withWriteClient: (run, destroyAfter) =>
    manager.withWriteClient(
      (client) =>
        run({
          query: (text: string | { text: string }, params?: unknown[]) => {
            seen.push(typeof text === 'string' ? text : text.text);
            return (client.query as (text: unknown, params?: unknown[]) => Promise<never>)(text, params);
          },
        } as PgQuery),
      destroyAfter,
    ),
});
const withLimits = (limits: Partial<EventDeliveryPolicy['limits']>, events = 1): EventDeliveryPolicy => {
  const base = eventDeliveryPolicy(events);
  return { ...base, limits: { ...base.limits, ...limits } };
};

describe('event delivery on PostgreSQL', { skip: liveSkip('postgres', LIVE_PG) }, () => {
  let control: Control;
  /* This run's own database: every reset here drops whole delivery, event and
     journal namespaces, so it must never be the server's shared one. */
  let url: string;
  const managers: PgConnectionManager[] = [];
  before(async () => {
    url = await ownedPostgresDatabase();
    control = await pgControl(url);
  });
  after(async () => {
    for (const manager of managers) await manager.close().catch(() => {});
    await control.end();
  });
  const setup = (t: TestContext, policy = eventDeliveryPolicy(), provision = true) => deliveryEngines[1].fixture(t, policy, provision);
  /** A host: its own pool, so two hosts are two real connections. */
  const host = async (policy: EventDeliveryPolicy, options: PostgresEventDeliveryStoreOptions = {}) => {
    const manager = new PgConnectionManager(url);
    managers.push(manager);
    return openPostgresEventDeliveryStore(manager, policy, options);
  };
  const cursor = async () => String((await control.query(`SELECT cursor_xact::text AS c FROM ${q(delivery.destination)}`)).rows[0].c);
  const xidAtMost = async (a: string, b: string) => (await control.query('SELECT $1::xid8 <= $2::xid8 AS ok', [a, b])).rows[0].ok === true;

  test('two transactions that commit out of id order are both delivered: the cursor never passes the one still open', async (t) => {
    const f = await setup(t);
    // The early seed takes its transaction id first and commits last.
    const early = await beginPostgresSeed(f.policy, 'receipt-early');
    const late = await beginPostgresSeed(f.policy, 'receipt-late');
    const [lateEvent] = await late.commit();
    const store = await host(f.policy, { clock: 'caller' });
    try {
      assert.deepEqual(await store.discover(), { scanned: 1, scheduled: 1, pressure: false });
      const first = (await store.claim(1_000))!;
      assert.equal(first.eventId, lateEvent.eventId);
      assert.ok(await store.complete(first, 'accepted', 'accepted', 1_000));
      assert.deepEqual(await store.discover(), { scanned: 0, scheduled: 0, pressure: false });
      const held = await cursor();
      const [earlyEvent] = await early.commit();
      const batches = (
        await control.query(
          `SELECT id AS receipt_id, xact_id::text AS xact FROM ${q(journalTables.receipt)} WHERE xact_id IS NOT NULL ORDER BY xact_id`,
        )
      ).rows;
      // The receipt that committed last holds the lower transaction id: a
      // high-water mark past the late one would never have come back for it.
      assert.deepEqual(
        batches.map((row) => row.receipt_id),
        ['receipt-early', 'receipt-late'],
      );
      assert.ok(await xidAtMost(held, String(batches[0].xact)), 'the cursor stayed at or below the transaction still open');
      assert.deepEqual(await store.discover(), { scanned: 1, scheduled: 1, pressure: false });
      const second = (await store.claim(1_001))!;
      assert.equal(second.eventId, earlyEvent.eventId);
      assert.ok(await store.complete(second, 'accepted', 'accepted', 1_001));
      assert.equal((await store.inspect('delivered')).length, 2);
    } finally {
      await early.rollback().catch(() => {});
    }
  });

  test('the cursor moves up to the horizon once everything below it has been seen', async (t) => {
    const f = await setup(t);
    for (let i = 0; i < 5; i++) await f.seed(`receipt-${i}`);
    const store = await host(f.policy, { clock: 'caller' });
    const horizon = String((await control.query('SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS h')).rows[0].h);
    assert.deepEqual(await store.discover(), { scanned: 5, scheduled: 5, pressure: false });
    assert.ok(await xidAtMost(horizon, await cursor()), 'the cursor reached the horizon read before discovery');
    const reached = await cursor();
    assert.deepEqual(await store.discover(), { scanned: 0, scheduled: 0, pressure: false });
    assert.ok(await xidAtMost(reached, await cursor()), 'the cursor never moves back');
  });

  for (const [what, sql] of [
    ['an unrelated relation under the prefix', `CREATE TABLE ${q(`${EVENT_DELIVERY_PREFIX}unexpected`)} (id text)`],
    [
      // The scan reads only the runtime schema, so a look-alike has to sit inside it: a different case still lower-cases into the prefix.
      'a look-alike in another case',
      `CREATE TABLE ${runtimeSchema('postgres')}."${plain(EVENT_DELIVERY_PREFIX).toUpperCase()}${delivery.delivery.slice(EVENT_DELIVERY_PREFIX.length)}" (id text)`,
    ],
    [
      'a trigger',
      `CREATE FUNCTION public.tablewalk_delivery_fixture_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER extra BEFORE UPDATE ON ${q(delivery.delivery)} FOR EACH ROW EXECUTE FUNCTION public.tablewalk_delivery_fixture_noop()`,
    ],
    ['a dropped index', `DROP INDEX ${runtimeSchema('postgres')}."${plain(EVENT_DELIVERY_PREFIX)}ready"`],
    ['row level security', `ALTER TABLE ${q(delivery.delivery)} ENABLE ROW LEVEL SECURITY`],
    ['a changed cursor type', `ALTER TABLE ${q(delivery.destination)} ALTER COLUMN cursor_xact TYPE text USING cursor_xact::text`],
    ['a changed destination policy', `UPDATE ${q(delivery.destination)} SET policy_json = '{}'`],
    [
      'a changed transaction id type',
      `ALTER TABLE ${q(journalTables.receipt)} ALTER COLUMN xact_id TYPE bigint USING xact_id::text::bigint`,
    ],
  ] as const)
    test(`attestation refuses ${what}`, async (t) => {
      const f = await setup(t);
      await f.seed();
      const store = await host(f.policy, { clock: 'caller' });
      await store.discover();
      await control.query(sql);
      await assert.rejects(store.discover(), EventDeliveryUnavailable);
      await assert.rejects(store.claim(1_000), EventDeliveryUnavailable);
      await assert.rejects(host(f.policy), EventDeliveryUnavailable);
      await assert.rejects(provisionPostgresEventDeliveryStore(url, f.policy), EventDeliveryUnavailable);
    });

  test('two provisioning runs racing each other serialise, and so do two new destinations', async (t) => {
    const f = await setup(t, eventDeliveryPolicy(), false);
    const results = await Promise.all([
      provisionPostgresEventDeliveryStore(url, f.policy),
      provisionPostgresEventDeliveryStore(url, f.policy),
    ]);
    assert.deepEqual(results.map((result) => [result.provisioned, result.destinationAdded]).sort(), [
      [false, false],
      [true, true],
    ]);
    const second = { ...f.policy, destinationId: 'second-destination' },
      third = { ...f.policy, destinationId: 'third-destination' };
    const added = await Promise.all([provisionPostgresEventDeliveryStore(url, second), provisionPostgresEventDeliveryStore(url, third)]);
    assert.deepEqual(
      added.map((result) => [result.provisioned, result.destinationAdded]),
      [
        [false, true],
        [false, true],
      ],
    );
    await assert.rejects(provisionPostgresEventDeliveryStore(url, { ...second, serviceId: 'other-service' }), EventDeliveryUnavailable);
  });

  test('claimers on separate connections never lease the same delivery', async (t) => {
    const policy = withLimits({ leaseMs: 30_000, timeoutMs: 1_000, maxRetained: 64, scanBatch: 8 });
    const f = await setup(t, policy);
    for (let i = 0; i < 20; i++) await f.seed(`receipt-${String(i).padStart(2, '0')}`);
    const hosts = [await host(policy), await host(policy), await host(policy)];
    for (let round = 0; round < 3; round++) await hosts[0].discover();
    const claims: EventDeliveryClaim[] = [];
    for (let round = 0; round < 20 && claims.length < 20; round++) {
      const batch = await Promise.all(
        hosts.map(async (store) => {
          const claim = await store.claim(Date.now());
          if (claim) assert.ok(await store.complete(claim, 'accepted', 'accepted', Date.now()));
          return claim;
        }),
      );
      for (const claim of batch) if (claim) claims.push(claim);
    }
    assert.equal(claims.length, 20);
    assert.equal(new Set(claims.map((claim) => claim.eventId)).size, 20);
    assert.ok(claims.every((claim) => claim.attempt === 1));
    assert.equal(Number((await control.query(`SELECT count(*) AS n FROM ${q(delivery.attempt)}`)).rows[0].n), 20);
  });

  test("the database clock, not each host's, drives leases, so skewed hosts do not halt each other", async (t) => {
    const policy = withLimits({ leaseMs: 30_000, timeoutMs: 1_000 });
    const f = await setup(t, policy);
    await f.seed('receipt-1');
    await f.seed('receipt-2');
    await f.seed('receipt-3');
    const skew = 60_000;
    const ahead = await host(policy),
      behind = await host(policy);
    const db = async () =>
      Number((await control.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now')).rows[0].now);
    await ahead.discover();
    const start = await db();
    const first = (await ahead.claim(Date.now() + skew))!;
    assert.ok(Math.abs(first.deadline - (start + 30_000)) < 5_000, 'the lease is measured on the database clock');
    assert.ok(await behind.complete(first, 'accepted', 'accepted', Date.now() - skew));
    const second = (await behind.claim(Date.now() - skew))!;
    assert.ok(await ahead.complete(second, 'accepted', 'accepted', Date.now() + skew));
    // With the caller's clock instead, the host behind trips the floor.
    const callerAhead = await host(policy, { clock: 'caller' }),
      callerBehind = await host(policy, { clock: 'caller' });
    assert.ok(await callerAhead.claim(Date.now() + skew));
    await assert.rejects(callerBehind.claim(Date.now() - skew), EventDeliveryUnavailable);
    // The floor still guards against the database clock itself going back.
    await control.query(`UPDATE ${q(delivery.meta)} SET last_clock = $1`, [Date.now() + 10 * skew]);
    await assert.rejects(ahead.claim(Date.now()), EventDeliveryUnavailable);
  });

  test('an idle poll after warm-up reads no catalog, and a statement failing on a moved table re-attests at once', async (t) => {
    const was = trustStoreLayoutsFor(60_000);
    t.after(() => void trustStoreLayoutsFor(was));
    const f = await setup(t);
    const manager = new PgConnectionManager(url);
    managers.push(manager);
    const seen: string[] = [];
    const store = await openPostgresEventDeliveryStore(recording(manager, seen), f.policy, { clock: 'caller' });
    try {
      assert.ok(seen.some(catalog), 'opening attests the delivery, event and journal layouts');
      seen.length = 0;
      for (let tick = 0; tick < 5; tick++) {
        assert.deepEqual(await store.discover(), { scanned: 0, scheduled: 0, pressure: false });
        assert.equal(await store.claim(1_000), undefined);
      }
      assert.ok(seen.length > 0, 'the polls ran');
      assert.deepEqual(seen.filter(catalog), [], 'no idle poll describes the stores again');
      await control.query(`ALTER TABLE ${q(delivery.delivery)} RENAME TO "${plain(EVENT_DELIVERY_PREFIX)}moved"`);
      await assert.rejects(store.claim(1_000), EventDeliveryUnavailable);
      seen.length = 0;
      await assert.rejects(store.claim(1_000), EventDeliveryUnavailable);
      assert.ok(seen.some(catalog), 'the failure ended the trust: the next poll describes the stores and refuses');
    } finally {
      await store.close();
      await control.query(`ALTER TABLE IF EXISTS ${q(`${EVENT_DELIVERY_PREFIX}moved`)} RENAME TO "${plain(delivery.delivery)}"`);
    }
  });

  test('the delivery tables stay out of the App catalog', async (t) => {
    const f = await setup(t);
    await f.seed();
    const adapter = new PostgresAdapter(url, 'delivery catalog proof', ['public']);
    try {
      const physical = await adapter.introspect();
      assert.ok(
        !physical.tables.some((table) => table.id.toLowerCase().includes(plain(delivery.delivery))),
        'the adapter never sees the runtime schema',
      );
      const mapped = createAppResources(adapter, physical);
      assert.ok(mapped.schema.tables.some((table) => table.id.endsWith('delivery_fixture_effects')));
      assert.ok(
        !mapped.schema.tables.some((table) => table.id.toLowerCase().includes('__mistri_')),
        'runtime tables stay out of the App catalog',
      );
    } finally {
      await adapter.close();
    }
  });
});
