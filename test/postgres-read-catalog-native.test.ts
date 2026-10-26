import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { liveSkip } from './live.js';
import { StatementStopped, withCancellation } from '../packages/engine/src/adapters/statementControl.js';
import { postgresSnapshotReads } from '../packages/mistri/src/server/api/postgresSnapshotReads.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

test(
  'native pinned PostgreSQL read source attests and holds exact relation shape',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const database = `tw_pinned_read_${randomUUID().replaceAll('-', '')}`;
    let owned = false,
      db: Client | undefined,
      adapter: PostgresAdapter | undefined;
    try {
      try {
        await control.connect();
      } catch {
        throw new Error('Pinned-read fixture control connection failed.');
      }
      await control.query(`CREATE DATABASE ${quote(database)}`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${database}`;
      db = new pg.default.Client({ connectionString: url.href, statement_timeout: 5000 });
      try {
        await db.connect();
      } catch {
        throw new Error('Pinned-read fixture connection failed.');
      }
      assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, database);
      await db.query("CREATE TABLE public.items(id integer PRIMARY KEY, name text NOT NULL); INSERT INTO public.items VALUES(1,'One')");
      adapter = new PostgresAdapter(url.href, 'Owned pinned read test');
      const reader = adapter,
        client = db;
      const dependency = [{ schema: 'public', name: 'items' }];

      await t.test('observed native catalog does not use an instance-supplied description', async () => {
        let called = false;
        Object.defineProperty(reader, 'describe', {
          configurable: true,
          value: async () => {
            called = true;
            throw new Error('Injected description');
          },
        });
        try {
          const owner = await reader.capturePinnedReadSnapshot(dependency, () => {});
          try {
            assert.equal(owner.schema.tables[0].id, 'public.items');
          } finally {
            await owner.retire();
          }
          assert.equal(called, false);
        } finally {
          Reflect.deleteProperty(reader, 'describe');
        }
      });

      await t.test('replaced native manager and accessor refuse without invoking supplied code', async () => {
        const original = Object.getOwnPropertyDescriptor(reader, 'connections')!;
        const owner = await reader.capturePinnedReadSnapshot(dependency, () => {});
        let calls = 0;
        try {
          for (const replacement of [
            {
              configurable: true,
              value: {
                withObservedReadClient: () => {
                  calls++;
                },
              },
            },
            {
              configurable: true,
              get: () => {
                calls++;
                return original.value;
              },
            },
          ]) {
            Object.defineProperty(reader, 'connections', replacement);
            await assert.rejects(
              owner.withSnapshot(async () => {
                calls++;
              }),
            );
            assert.throws(() => reader.capturePinnedReadSnapshot(dependency, () => {}));
            assert.equal(calls, 0);
            Object.defineProperty(reader, 'connections', original);
          }
          await owner.withSnapshot(async (snapshot) => {
            Object.defineProperty(reader, 'connections', {
              configurable: true,
              get: () => {
                calls++;
                return original.value;
              },
            });
            try {
              assert.throws(snapshot.assertCurrent);
              assert.equal(calls, 0);
            } finally {
              Object.defineProperty(reader, 'connections', original);
            }
          });
        } finally {
          Object.defineProperty(reader, 'connections', original);
          await owner.retire();
        }
      });

      await t.test('transaction-mode snapshot cancellation destroys native work and drains owner retirement', async () => {
        // Exercise transaction-mode client semantics against owned native PG;
        // this fixture is not a claim of a live PgBouncer deployment.
        await client.query('CREATE TABLE public.cancel_items(id integer PRIMARY KEY)');
        const pooled = new PostgresAdapter(url.href, 'Owned cancellation test', [], undefined, { pooler: 'transaction' });
        const owner = await pooled.capturePinnedReadSnapshot([{ schema: 'public', name: 'cancel_items' }], () => {});
        const controller = new AbortController();
        let ready!: () => void, finish!: () => void;
        const started = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const cleanup = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let pid: unknown,
          cleaning = false,
          retired = false;
        let retirement: Promise<void> | undefined;
        const pending = withCancellation(controller.signal, () =>
          owner.withSnapshot(async (snapshot) => {
            pid = (await snapshot.execute({ text: 'SELECT pg_backend_pid() AS pid', params: [] })).rows[0].pid;
            const query = snapshot.execute({ text: 'SELECT pg_sleep(10)', params: [] });
            ready();
            try {
              await query;
            } finally {
              cleaning = true;
              await cleanup;
            }
          }),
        );
        const rejected = assert.rejects(pending, StatementStopped);
        try {
          await started;
          const deadline = Date.now() + 5000;
          while (true) {
            const active = await client.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pid]);
            if (active.rows[0]?.wait_event === 'PgSleep') break;
            assert.ok(Date.now() < deadline, 'Owned read did not enter its sleep statement');
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          controller.abort();
          while (!cleaning) {
            assert.ok(Date.now() < deadline, 'Destroyed native query did not settle');
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          retirement = owner.retire().then(() => {
            retired = true;
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(retired, false);
          assert.equal(pooled.poolStats()[0].inUse, 1);
        } finally {
          controller.abort();
          finish();
          await rejected;
          await (retirement ?? owner.retire());
          await pooled.close();
          // Socket destruction drains local driver promises, not necessarily
          // the still-sleeping server backend. Clean up only this owned DB's
          // captured backend; do not leave its locks for following fixtures.
          if (typeof pid === 'number')
            await client.query(
              'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND pid<>pg_backend_pid()',
              [pid, database],
            );
        }
        assert.equal(pooled.poolStats()[0].inUse, 0);
      });

      await t.test('real adapter baseline and full callback execute stay in one native transaction', async () => {
        const owner = await reader.capturePinnedReadSnapshot(dependency, () => {});
        try {
          assert.ok(Object.isFrozen(owner.schema));
          const rows = await owner.withSnapshot(async (snapshot) => {
            assert.deepEqual(Object.keys(snapshot).sort(), ['assertCurrent', 'execute', 'schema']);
            snapshot.assertCurrent();
            return (await snapshot.execute({ text: 'SELECT id, name FROM public.items', params: [] })).rows;
          });
          assert.deepEqual(rows, [{ id: 1, name: 'One' }]);
        } finally {
          await owner.retire();
        }
        assert.throws(() => PostgresAdapter.prototype.capturePinnedReadSnapshot.call({} as PostgresAdapter, dependency, () => {}));
      });

      await t.test('native backend termination invalidates the held synchronous handoff guard', async () => {
        const owner = await reader.capturePinnedReadSnapshot(dependency, () => {});
        let sent = false;
        try {
          await assert.rejects(
            owner.withSnapshot(async (snapshot) => {
              const pid = (await snapshot.execute({ text: 'SELECT pg_backend_pid() AS pid', params: [] })).rows[0].pid;
              assert.equal(typeof pid, 'number');
              await client.query(
                'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND pid<>pg_backend_pid()',
                [pid, database],
              );
              const deadline = Date.now() + 5000;
              let invalidated = false;
              while (!invalidated && Date.now() < deadline) {
                try {
                  snapshot.assertCurrent();
                } catch {
                  invalidated = true;
                }
                if (!invalidated) await new Promise<void>((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(invalidated, true, 'Native client termination must invalidate the checkout');
              snapshot.assertCurrent();
              sent = true;
            }),
          );
          assert.equal(sent, false);
          await owner.withSnapshot(async (snapshot) => {
            snapshot.assertCurrent();
            assert.equal((await snapshot.execute({ text: 'SELECT id FROM public.items', params: [] })).rows.length, 1);
          });
        } finally {
          await owner.retire();
        }
      });

      await t.test('mapped compiled reads and bounded counts execute on the held native snapshot', async () => {
        const owner = await reader.capturePinnedReadSnapshot(dependency, () => {});
        try {
          let escaped: ReturnType<typeof postgresSnapshotReads> | undefined;
          await owner.withSnapshot(async (snapshot) => {
            const adapter = postgresSnapshotReads(snapshot);
            escaped = adapter;
            const mapped = createAppResources(adapter, snapshot.schema, { item: 'public.items' });
            const view = { id: 'items', name: 'Items', base: 'item', columns: [{ path: 'id' }, { path: 'name' }], limit: 2 };
            const result = await mapped.adapter.runView!(view);
            assert.deepEqual(result.rows, [{ id: 1, name: 'One' }]);
            assert.equal(result.resolved[0].table, 'item');
            assert.equal(await mapped.adapter.countView!(view, 10001), 1);
            assert.equal(reader.poolStats()[0].inUse, 1);
            snapshot.assertCurrent();
          });
          await assert.rejects(escaped!.introspect());
        } finally {
          await owner.retire();
        }
      });

      await t.test('DDL waits behind ACCESS SHARE until the trusted callback ends', async () => {
        const owner = await reader.capturePinnedReadSnapshot(dependency, () => {});
        try {
          await owner.withSnapshot(async (snapshot) => {
            await client.query("SET lock_timeout = '100ms'");
            try {
              await assert.rejects(
                client.query('ALTER TABLE public.items ADD COLUMN blocked integer'),
                (error) => !!error && typeof error === 'object' && 'code' in error && error.code === '55P03',
              );
            } finally {
              await client.query('SET lock_timeout = 0');
            }
            assert.equal((await snapshot.execute({ text: 'SELECT id FROM public.items', params: [] })).rows.length, 1);
          });
          await client.query('ALTER TABLE public.items ADD COLUMN later integer');
          await assert.rejects(owner.withSnapshot(async () => 1));
          await client.query('ALTER TABLE public.items DROP COLUMN later');
        } finally {
          await owner.retire();
        }
      });

      await t.test('drop/recreate with identical names and columns does not inherit baseline identity', async () => {
        await client.query('CREATE TABLE public.replaced(id integer PRIMARY KEY)');
        const owner = await reader.capturePinnedReadSnapshot([{ schema: 'public', name: 'replaced' }], () => {});
        try {
          await client.query('DROP TABLE public.replaced; CREATE TABLE public.replaced(id integer PRIMARY KEY)');
          await assert.rejects(owner.withSnapshot(async () => 1));
        } finally {
          await owner.retire();
        }
      });

      await t.test('exact schema/name pairs preserve dots and quotes without SQL interpolation', async () => {
        const schema = 'odd.schema',
          table = 't"able';
        await client.query(`CREATE SCHEMA ${quote(schema)}; CREATE TABLE ${quote(schema)}.${quote(table)}(id bigint PRIMARY KEY)`);
        const owner = await reader.capturePinnedReadSnapshot([{ schema, name: table }], () => {});
        try {
          await owner.withSnapshot(async (snapshot) => {
            assert.equal(snapshot.schema.tables[0].schema, schema);
            assert.equal(snapshot.schema.tables[0].name, table);
            assert.equal((await snapshot.execute({ text: `SELECT id FROM ${quote(schema)}.${quote(table)}`, params: [] })).rows.length, 0);
          });
        } finally {
          await owner.retire();
        }
      });

      /* R1: a generated column ('s' stored here; 'v' virtual from PostgreSQL 18) keeps its table readable on the
         pinned path, read like any other column and described as one nothing writes. */
      await t.test('a stored generated column is attested, read on the held snapshot and described as unwritable', async () => {
        await client.query(`CREATE TABLE public.priced(id integer PRIMARY KEY, net integer NOT NULL,
          gross integer GENERATED ALWAYS AS (net * 2) STORED); INSERT INTO public.priced(id, net) VALUES(1, 21)`);
        const owner = await reader.capturePinnedReadSnapshot([{ schema: 'public', name: 'priced' }], () => {});
        try {
          const gross = owner.schema.tables[0].columns.find((column) => column.name === 'gross');
          assert.equal(gross?.writable, false);
          assert.notEqual(owner.schema.tables[0].columns.find((column) => column.name === 'net')?.writable, false);
          const rows = await owner.withSnapshot(
            async (snapshot) => (await snapshot.execute({ text: 'SELECT id, net, gross FROM public.priced', params: [] })).rows,
          );
          assert.deepEqual(rows, [{ id: 1, net: 21, gross: 42 }]);
        } finally {
          await owner.retire();
        }
      });

      await t.test('views, partitions, inheritance, domains, RLS and unsupported numeric types refuse', async () => {
        await client.query(`CREATE VIEW public.v AS SELECT 1 AS id;
          CREATE TABLE public.partitioned(id integer PRIMARY KEY) PARTITION BY RANGE(id);
          CREATE TABLE public.parent(id integer PRIMARY KEY);
          CREATE TABLE public.child() INHERITS(public.parent);
          CREATE DOMAIN public.custom_id AS integer;
          CREATE TABLE public.domain_table(id public.custom_id PRIMARY KEY);
          CREATE TABLE public.policy_table(id integer PRIMARY KEY); ALTER TABLE public.policy_table ENABLE ROW LEVEL SECURITY;
          CREATE TABLE public.decimal_table(id integer PRIMARY KEY, amount numeric)`);
        for (const name of ['v', 'partitioned', 'parent', 'child', 'domain_table', 'policy_table', 'decimal_table']) {
          await assert.rejects(reader.capturePinnedReadSnapshot([{ schema: 'public', name }], () => {}));
        }
      });

      await t.test('owner revocation before queued acquisition prevents callback execution', async () => {
        let active = true,
          checks = 0;
        const owner = await reader.capturePinnedReadSnapshot([{ schema: 'public', name: 'replaced' }], () => {
          if (!active) throw new Error('Owner retired');
          checks++;
        });
        try {
          active = false;
          let called = false;
          await assert.rejects(
            owner.withSnapshot(async () => {
              called = true;
            }),
          );
          assert.equal(called, false);
          assert.ok(checks > 0);
        } finally {
          await owner.retire();
        }
      });
    } finally {
      await adapter?.close();
      await db?.end().catch(() => {});
      if (owned) {
        await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [
          database,
        ]);
        await control.query(`DROP DATABASE ${quote(database)}`);
      }
      await control.end().catch(() => {});
    }
  },
);
