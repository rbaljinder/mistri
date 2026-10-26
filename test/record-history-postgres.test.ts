/**
 * The record history store on a live PostgreSQL, in a database this run owns
 * (`ownedPostgresDatabase`): the layout provisioning pins, the append inside
 * every transaction kind the adapter opens, and the read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { RECORD_HISTORY_TABLES, RecordHistoryUnavailable, historyKey } from '../packages/mistri/src/adapters/history/recordHistory.js';
import { bindRecordHistory } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { provisionPostgresRecordHistory } from '../packages/mistri/src/adapters/history/postgresRecordHistory.js';
import { LIVE_PG, ownedPostgresDatabase } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const skip = liveSkip('postgres', LIVE_PG);

async function client(url: string) {
  const specifier = 'pg';
  const pg = (await import(specifier)) as unknown as {
    default: {
      Client: new (options: unknown) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
      };
    };
  };
  const created = new pg.default.Client({ connectionString: url });
  await created.connect();
  return created;
}

test("PostgreSQL record history: provisioned once, appended in the write's transaction, read for one record", { skip }, async () => {
  const url = await ownedPostgresDatabase();
  const control = await client(url);
  const adapter = new PostgresAdapter(url, 'history');
  try {
    await control.query(
      `DROP TABLE IF EXISTS ${runtimeTable('postgres', RECORD_HISTORY_TABLES.change)}, ${runtimeTable('postgres', RECORD_HISTORY_TABLES.meta)}, public.rh_ticket`,
    );
    await control.query(`CREATE TABLE public.rh_ticket (id integer PRIMARY KEY, status text, salary integer)`);
    await control.query(`INSERT INTO public.rh_ticket VALUES (1, 'open', 100)`);
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), false);
    assert.deepEqual(await provisionPostgresRecordHistory(url), { version: 1, provisioned: true });
    assert.deepEqual(await provisionPostgresRecordHistory(url), { version: 1, provisioned: false });
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), true);

    const schema = await adapter.introspect();
    const table = schema.tables.find((candidate) => candidate.name === 'rh_ticket')!.id;
    bindRecordHistory(adapter, new Map([[table, { redact: new Set(['salary']) }]]));
    await attributeWrites({ actor: 'maya@example.com', name: 'Maya Chen', via: 'app', action: 'Close' }, () =>
      adapter.transaction((tx) => tx.update({ table, key: { id: 1 }, values: { status: 'closed', salary: 150 } })),
    );
    // The public write goes through a transaction for a recorded table.
    await adapter.update({ table, key: { id: 1 }, values: { status: 'open' } });
    // A rolled-back write leaves nothing.
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ table, key: { id: 1 }, values: { status: 'lost' } });
        throw new Error('handler failed');
      }),
      /handler failed/,
    );
    const read = await appStoresOf(adapter).readRecordHistory({ resource: table, key: historyKey({ id: 1 }), limit: 20 });
    assert.deepEqual(
      read.map((row) => [row.action, row.via, row.actor, row.actorName]),
      [
        ['', 'system', '', ''],
        ['Close', 'app', 'maya@example.com', 'Maya Chen'],
      ],
    );
    assert.deepEqual(read[1].changes, [
      { c: 'status', b: 'open', a: 'closed' },
      { c: 'salary', r: 1 },
    ]);

    // An altered layout is refused, and a write that cannot append fails whole.
    await control.query(`CREATE FUNCTION public.rh_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await control.query(
      `CREATE TRIGGER rh_scrub BEFORE INSERT ON ${runtimeTable('postgres', RECORD_HISTORY_TABLES.change)} FOR EACH ROW EXECUTE FUNCTION public.rh_noop()`,
    );
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), false);
    await assert.rejects(provisionPostgresRecordHistory(url), RecordHistoryUnavailable);
    // The adapter attested the store when it first read it; one that starts now refuses.
    const restarted = new PostgresAdapter(url, 'history, restarted');
    try {
      await assert.rejects(
        appStoresOf(restarted).readRecordHistory({ resource: table, key: historyKey({ id: 1 }), limit: 5 }),
        RecordHistoryUnavailable,
      );
    } finally {
      await restarted.close();
    }
    await control.query(`DROP TABLE ${runtimeTable('postgres', RECORD_HISTORY_TABLES.change)}`);
    await assert.rejects(adapter.update({ table, key: { id: 1 }, values: { status: 'closed' } }));
    assert.equal((await control.query('SELECT status FROM public.rh_ticket WHERE id = 1')).rows[0].status, 'open');
  } finally {
    await adapter.close();
    await control.end();
  }
});
