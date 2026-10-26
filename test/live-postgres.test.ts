/**
 * Live sync's order on PostgreSQL, in a database the case owns: a change is
 * announced at its commit and never before, and a transaction that took its
 * change row first but commits last is still told — the reader waits for it
 * rather than stepping past its id (DESIGN-LIVE-SYNC §2.3).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { LiveChangeRow } from '../packages/mistri/src/adapters/live/liveChange.js';
import { appendPostgresLiveChange, provisionPostgresLiveChange } from '../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { bindLiveChanges } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { dropLiveHub, liveHubOf, type LiveTap } from '../packages/mistri/src/server/live/liveHub.js';
import type { LiveDelivery } from '../packages/mistri/src/server/live/liveFilter.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const PG = process.env.TABLEWALK_TEST_PG;

const row = (id: number): LiveChangeRow => ({
  at: Date.now(),
  actor: '',
  tenant: null,
  entries: [{ table: 'ticket', kind: 'update', keys: [{ id }] }],
});

test(
  'a change is announced at commit only, and one that commits after a later row is still told',
  { skip: PG ? false : 'TABLEWALK_TEST_PG is not set', timeout: 60_000 },
  async (t) => {
    const owned = await uuidPostgresDatabase('tw_live_order');
    const cleanup: Array<() => Promise<void>> = [];
    t.after(async () => {
      for (const step of cleanup.reverse()) await step().catch(() => {});
      await owned.drop();
    });
    const setup = await pgClient(owned.url);
    await setup.query(
      `CREATE TABLE ticket (id integer PRIMARY KEY, title text NOT NULL); INSERT INTO ticket VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
    );
    await setup.end();
    await provisionPostgresLiveChange(owned.url);

    const adapter = new PostgresAdapter(owned.url, 'live-order');
    bindLiveChanges(adapter, {});
    const listener = (await pgClient(owned.url)) as unknown as {
      query(sql: string): Promise<unknown>;
      on(event: 'notification', listener: () => void): void;
      end(): Promise<void>;
    };
    const first = await pgClient(owned.url);
    const second = await pgClient(owned.url);
    cleanup.push(async () => {
      await dropLiveHub(adapter);
      bindLiveChanges(adapter, undefined);
      await adapter.close();
      for (const client of [listener, first, second]) await client.end().catch(() => {});
    });
    let notified = 0;
    listener.on('notification', () => notified++);
    await listener.query('LISTEN mistri_live');

    const hub = (await liveHubOf(adapter, { listen: owned.url }))!;
    assert.ok(hub);
    const told: LiveDelivery[] = [];
    const tap: LiveTap = {
      authority: async () => ({
        actor: '',
        tables: new Map([['ticket', { id: 'ticket', key: ['id'], columns: 'all' as const, scope: true as const, fingerprint: '' }]]),
        probe: async () => new Set<string>(),
      }),
      receive: (delivery) => told.push(delivery),
      placed: () => {},
      reset: () => assert.fail('reset'),
      fail: () => assert.fail('failed'),
    };
    await hub.attach(tap);
    const keys = () =>
      told
        .flatMap((delivery) =>
          [...((delivery.tables.get('ticket')?.keys as Map<string, { id: number }>) ?? new Map()).values()].map((key) => key.id),
        )
        .sort();

    // The first transaction takes the lower id, and holds it uncommitted: nothing is announced.
    await first.query('BEGIN');
    await appendPostgresLiveChange(first, row(1));
    await delay(300);
    assert.equal(notified, 0, 'a notification is held to the commit');

    // A second commits past it: announced, but not told while the first is open, or the first would be skipped.
    await second.query('BEGIN');
    await appendPostgresLiveChange(second, row(2));
    await second.query('COMMIT');
    await delay(600);
    assert.equal(notified, 1);
    assert.deepEqual(keys(), [], 'the reader waits behind the open transaction');

    // The first commits: both are told, the late lower id included.
    await first.query('COMMIT');
    const deadline = Date.now() + 5000;
    while (keys().length < 2 && Date.now() < deadline) await delay(20);
    assert.equal(notified, 2);
    assert.deepEqual(keys(), [1, 2]);

    // A rolled-back change row is neither announced nor told.
    await first.query('BEGIN');
    await appendPostgresLiveChange(first, row(3));
    await first.query('ROLLBACK');
    await delay(600);
    assert.equal(notified, 2);
    assert.deepEqual(keys(), [1, 2]);
    hub.detach(tap);
  },
);

test(
  'a transaction held open in another database holds no change back, and one in this database is told when it ends, with no further write',
  { skip: PG ? false : 'TABLEWALK_TEST_PG is not set', timeout: 60_000 },
  async (t) => {
    /* The snapshot's xmin is the server's: read below it, any test, job or report holding a write transaction open
       anywhere on the server held every change back (CI's shared server held one past this case's wait). Only a
       transaction that may be this database's can still write a row here, so only one of those holds it, and its
       end announces nothing. */
    const owned = await uuidPostgresDatabase('tw_live_horizon');
    const elsewhere = await uuidPostgresDatabase('tw_live_elsewhere');
    const cleanup: Array<() => Promise<void>> = [];
    t.after(async () => {
      for (const step of cleanup.reverse()) await step().catch(() => {});
      await owned.drop();
      await elsewhere.drop();
    });
    const setup = await pgClient(owned.url);
    await setup.query(`CREATE TABLE ticket (id integer PRIMARY KEY, title text NOT NULL); INSERT INTO ticket VALUES (1, 'a'), (2, 'b')`);
    await setup.end();
    await provisionPostgresLiveChange(owned.url);
    const adapter = new PostgresAdapter(owned.url, 'live-horizon');
    bindLiveChanges(adapter, {});
    const away = await pgClient(elsewhere.url);
    const here = await pgClient(owned.url);
    const writer = await pgClient(owned.url);
    cleanup.push(async () => {
      await dropLiveHub(adapter);
      bindLiveChanges(adapter, undefined);
      await adapter.close();
      for (const client of [away, here, writer]) await client.end().catch(() => {});
    });
    const hub = (await liveHubOf(adapter, { listen: owned.url }))!;
    const told: LiveDelivery[] = [];
    const tap: LiveTap = {
      authority: async () => ({
        actor: '',
        tables: new Map([['ticket', { id: 'ticket', key: ['id'], columns: 'all' as const, scope: true as const, fingerprint: '' }]]),
        probe: async () => new Set<string>(),
      }),
      receive: (delivery) => told.push(delivery),
      placed: () => {},
      reset: () => assert.fail('reset'),
      fail: () => assert.fail('failed'),
    };
    await hub.attach(tap);
    const commit = async (id: number) => {
      await writer.query('BEGIN');
      await appendPostgresLiveChange(writer, row(id));
      await writer.query('COMMIT');
    };
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (told.length < count && Date.now() < deadline) await delay(20);
    };

    await away.query('BEGIN');
    await away.query('SELECT pg_current_xact_id()');
    await commit(1);
    await waitFor(1);
    assert.equal(told.length, 1, 'told while another database holds a transaction open');

    await here.query('BEGIN');
    await here.query('SELECT pg_current_xact_id()');
    await commit(2);
    await delay(600);
    assert.equal(told.length, 1, 'held behind the older transaction open in this database');

    await here.query('ROLLBACK');
    await waitFor(2);
    assert.equal(told.length, 2, 'told once the horizon passed it, though nothing was written after');
    await away.query('ROLLBACK');
    hub.detach(tap);
  },
);
