/**
 * One delivery-store fixture per engine, so the delivery suites run unchanged
 * on SQLite and on PostgreSQL. Receipts are seeded through the real command
 * journal on each engine: a tenant route's from a tenant-bound journal, an
 * App-scope route's from one bound to the App's event source. PostgreSQL is
 * live and opt-in like the other live suites; its stores use the caller's
 * clock here, so a test's injected time means the same on both engines.
 */
import type { TestContext } from 'node:test';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { COMMAND_JOURNAL_TABLES } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import type { StoredCommandReceipt } from '../../packages/mistri/src/adapters/commands/commandJournalTypes.js';
import {
  createPostgresCommandJournal,
  migratePostgresCommandJournal,
} from '../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { runtimeTable } from '../../packages/engine/src/shared/runtimeTables.js';
import { COMMAND_EVENT_TABLES } from '../../packages/mistri/src/adapters/events/commandEventSchema.js';
import type { CommandEventEnvelope } from '../../packages/mistri/src/adapters/events/commandEventTypes.js';
import type { EventDeliveryStore } from '../../packages/mistri/src/adapters/events/eventDeliveryContract.js';
import { EVENT_DELIVERY_PREFIX, provisionSqliteEventDeliveryStore } from '../../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import { openSqliteEventDeliveryStore } from '../../packages/mistri/src/adapters/events/eventDeliveryStore.js';
import type { EventDeliveryPolicy, EventDeliveryRoute } from '../../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { provisionPostgresCommandEventStore } from '../../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import {
  openPostgresEventDeliveryStore,
  provisionPostgresEventDeliveryStore,
} from '../../packages/mistri/src/adapters/events/postgresEventDeliveryStore.js';
import { PgConnectionManager, type PgQuery } from '../../packages/engine/src/adapters/postgresPool.js';
import { liveSkip } from '../live.js';
import { eventDeliveryFixture } from './eventDeliveryFixture.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl } from './jobStoreEngines.js';
import { postgresRuntimeSql } from './runtimeSql.js';

export type DeliveryEngineName = 'sqlite' | 'postgres';
export interface DeliveryEngineFixture {
  readonly engine: DeliveryEngineName;
  readonly policy: EventDeliveryPolicy;
  open(policy?: EventDeliveryPolicy): Promise<EventDeliveryStore>;
  provision(policy?: EventDeliveryPolicy): Promise<{ provisioned: boolean; destinationAdded: boolean }>;
  seed(id?: string, route?: EventDeliveryRoute): Promise<CommandEventEnvelope[]>;
  /** One statement on a separate connection; `?` placeholders on both engines. */
  exec(sql: string, params?: unknown[]): Promise<void>;
  scalar(sql: string, params?: unknown[]): Promise<number>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  executions(): Promise<number>;
}
export interface DeliveryEngine {
  readonly name: DeliveryEngineName;
  readonly skip: false | string;
  fixture(t: TestContext, policy: EventDeliveryPolicy, provision?: boolean): Promise<DeliveryEngineFixture>;
}

const sqlite: DeliveryEngine = {
  name: 'sqlite',
  skip: false,
  async fixture(t, policy, provision = true) {
    const f = eventDeliveryFixture(t, policy, provision);
    return {
      engine: 'sqlite',
      policy,
      open: async (input = policy) => {
        const store = input === policy ? f.open() : openSqliteEventDeliveryStore(f.path, input);
        if (input !== policy) t.after(() => store.close());
        return store;
      },
      provision: async (input = policy) => provisionSqliteEventDeliveryStore(f.path, input, { stopped: true }),
      seed: (id, route) => f.seed(id, route),
      exec: async (sql, params = []) => {
        if (params.length) f.db.prepare(sql).run(...(params as never[]));
        else f.db.exec(sql);
      },
      scalar: async (sql, params = []) => Number(Object.values(f.db.prepare(sql).get(...(params as never[]))!)[0]),
      rows: async (sql) => f.db.prepare(sql).all() as Record<string, unknown>[],
      executions: async () => Number(f.executions()),
    };
  },
};

/** `?` to `$n`, for statements written once for both engines. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
/** Drops every runtime relation this fixture's layers create, and its own table. */
export async function resetPostgresDelivery(control: PgQuery): Promise<void> {
  await control.query('DROP SCHEMA IF EXISTS mistri CASCADE');
  for (const prefix of [EVENT_DELIVERY_PREFIX, '__mistri_event_', '__mistri_command_']) {
    const rows = (
      await control.query(
        `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE lower(substr(c.relname, 1, $2)) = $1 AND c.relkind = 'r' AND NOT pg_catalog.pg_is_other_temp_schema(n.oid)`,
        [prefix, prefix.length],
      )
    ).rows as { schema: string; name: string }[];
    for (const row of rows) await control.query(`DROP TABLE IF EXISTS "${row.schema}"."${row.name}" CASCADE`);
  }
  await control.query('DROP TABLE IF EXISTS public.delivery_fixture_effects CASCADE');
  await control.query('DROP SCHEMA IF EXISTS tablewalk_delivery_shadow CASCADE');
  await control.query('DROP FUNCTION IF EXISTS public.tablewalk_delivery_fixture_noop() CASCADE');
}

/** A seeded receipt's journal write on its own connection, left open so a
 * test can decide the order in which overlapping transactions commit. */
export async function beginPostgresSeed(policy: EventDeliveryPolicy, id: string, route: EventDeliveryRoute = policy.routes[0]) {
  const client = await pgControl(await ownedPostgresDatabase());
  const actorId = 'native-account-proof';
  const owner =
    route.scope === 'tenant'
      ? {
          ...policy.source,
          tenantId: route.tenantId,
          actorId,
          membershipId: 'historical-grant',
          membershipVersion: '1',
          tenantVersion: '1',
          roles: ['manager'],
          deployment: 'historical-generation',
        }
      : { scope: 'app' as const, ...policy.source };
  const receipt: StoredCommandReceipt = {
    id,
    appId: policy.source.appId,
    actorId,
    commandId: route.commandId,
    commandVersion: route.commandVersion,
    idempotencyKey: `attempt-${id}`,
    fingerprint: `fingerprint-${id}`,
    resultJson: '{"assigned":true}',
    requestId: `request-${id}`,
    completedAt: '2026-09-08T12:00:00.000Z',
  };
  const operations = new TransactionOperations();
  await client.query('BEGIN');
  try {
    // One row per receipt, not one counter: seeds held open side by side
    // must not wait on each other's row lock.
    await client.query('INSERT INTO public.delivery_fixture_effects (receipt_id) VALUES ($1)', [id]);
    await createPostgresCommandJournal(client, operations, owner).commit(
      receipt,
      { target: 'effects', keyJson: '{"id":1}', changesJson: '[{"operation":"update","resource":"effects"}]' },
      route.manifest.map((event) => ({ ...event, payloadJson: '{"assigned":true}' })),
    );
    await operations.finish();
  } catch (error) {
    await operations.finish().catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    throw error;
  }
  return {
    async commit(): Promise<CommandEventEnvelope[]> {
      try {
        await client.query('COMMIT');
        return (
          await client.query(
            `SELECT envelope_json FROM ${runtimeTable('postgres', COMMAND_EVENT_TABLES.event)} WHERE receipt_id = $1 ORDER BY ordinal`,
            [id],
          )
        ).rows.map((row) => JSON.parse(String(row.envelope_json)) as CommandEventEnvelope);
      } finally {
        await client.end();
      }
    },
    async rollback() {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    },
  };
}

const postgres: DeliveryEngine = {
  name: 'postgres',
  skip: liveSkip('postgres', LIVE_PG),
  async fixture(t, policy, provision = true) {
    const url = await ownedPostgresDatabase();
    const control = await pgControl(url);
    await resetPostgresDelivery(control);
    await control.query('CREATE TABLE public.delivery_fixture_effects (receipt_id text PRIMARY KEY)');
    await migratePostgresCommandJournal(url);
    await provisionPostgresCommandEventStore(url, policy.source);
    if (provision) await provisionPostgresEventDeliveryStore(url, policy);
    const managers: PgConnectionManager[] = [],
      stores: EventDeliveryStore[] = [];
    t.after(async () => {
      for (const store of stores) await store.close();
      for (const manager of managers) await manager.close().catch(() => {});
      await control.end();
    });
    return {
      engine: 'postgres',
      policy,
      open: async (input = policy) => {
        const manager = new PgConnectionManager(url);
        managers.push(manager);
        const store = await openPostgresEventDeliveryStore(manager, input, { clock: 'caller' });
        stores.push(store);
        return store;
      },
      provision: async (input = policy) => {
        const { provisioned, destinationAdded } = await provisionPostgresEventDeliveryStore(url, input);
        return { provisioned, destinationAdded };
      },
      seed: async (id = 'receipt-001', route = policy.routes[0]) => (await beginPostgresSeed(policy, id, route)).commit(),
      exec: async (sql, params = []) => {
        await control.query(postgresRuntimeSql(params.length ? numbered(sql) : sql), params);
      },
      scalar: async (sql, params = []) =>
        Number(Object.values((await control.query(postgresRuntimeSql(numbered(sql)), params)).rows[0])[0]),
      rows: async (sql) => (await control.query(postgresRuntimeSql(sql))).rows,
      executions: async () => Number((await control.query('SELECT count(*) AS n FROM public.delivery_fixture_effects')).rows[0].n),
    };
  },
};

export const deliveryEngines: readonly DeliveryEngine[] = [sqlite, postgres];
export { COMMAND_JOURNAL_TABLES };
