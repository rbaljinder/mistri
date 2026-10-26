/**
 * Read replicas against a live PostgreSQL server (packages/engine/src/adapters/replicas.ts).
 *
 * The "replica" is the same database reached as a second role, so every
 * read can say which pool served it: the view `whoami` answers
 * `current_user`. The database and the role are this file's own (UUID-named
 * beside TABLEWALK_TEST_PG); nothing here reads or writes the shared one.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { connect } from '../packages/engine/src/adapters/connect.js';
import type { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { lagTolerantReads, primaryReads, type ReadContext, readsAs } from '../packages/engine/src/adapters/replicas.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

/** A port nothing listens on: a replica that is down. */
async function deadPort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test(
  'lists read the replica, records, writes and catalog the primary, and a dead replica falls back',
  { skip: liveSkip('postgres', LIVE), timeout: 120_000 },
  async (t) => {
    const owned = await uuidPostgresDatabase('tw_replica');
    const role = `tw_replica_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const password = randomUUID();
    const opened: Array<{ close(): Promise<void> }> = [];
    let server: Server | undefined;
    t.after(async () => {
      server?.closeAllConnections();
      server?.close();
      await Promise.allSettled(opened.map((adapter) => adapter.close()));
      await owned.drop();
      const admin = await pgClient(LIVE!);
      try {
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await admin.end();
      }
    });

    const setup = await pgClient(owned.url);
    let primaryUser: string;
    try {
      primaryUser = String((await setup.query('SELECT current_user::text AS who')).rows[0].who);
      await setup.query(`
      CREATE TABLE item (id integer PRIMARY KEY, name text NOT NULL);
      INSERT INTO item VALUES (1, 'one'), (2, 'two'), (3, 'three');
      CREATE VIEW whoami AS SELECT current_user::text AS who;
      CREATE ROLE "${role}" LOGIN PASSWORD '${password}';
      GRANT USAGE ON SCHEMA public TO "${role}";
      GRANT SELECT, INSERT ON item TO "${role}";
      GRANT SELECT ON whoami TO "${role}";
    `);
    } finally {
      await setup.end();
    }
    const replicaUrl = new URL(owned.url);
    replicaUrl.username = role;
    replicaUrl.password = password;
    const dead = new URL(replicaUrl.href);
    dead.hostname = '127.0.0.1';
    dead.port = String(await deadPort());

    const adapter = connect(owned.url, { replicas: [replicaUrl.href] }) as PostgresAdapter;
    opened.push(adapter);
    const schema = await adapter.introspect();
    const whoami = schema.tables.find((table) => table.name === 'whoami')!.id;
    const item = schema.tables.find((table) => table.name === 'item')!.id;
    const who = async () => String((await adapter.query({ table: whoami, limit: 10, offset: 0 })).rows[0].who);
    /* One request's read context: a write in it keeps its own later reads on the primary. */
    const tolerant = <T>(request: ReadContext, work: () => Promise<T>) => readsAs(request, () => lagTolerantReads(work));
    const anyone = () => ({ fresh: false }) as ReadContext;

    await t.test('an unclassified read, the catalog and a pinned read stay on the primary', async () => {
      assert.equal(await who(), primaryUser);
      assert.equal(await tolerant(anyone(), () => primaryReads(who)), primaryUser, 'a record page pins its list reads');
      assert.equal(await tolerant(anyone(), () => adapter.introspect().then(() => 'ok')), 'ok');
    });

    await t.test('lists, views and counts in lag-tolerant work read the replica', async () => {
      assert.equal(await tolerant(anyone(), who), role);
      const view = await tolerant(anyone(), () => adapter.runView({ id: 'v', name: 'v', base: whoami, columns: [{ path: 'who' }] }));
      assert.equal(view.rows[0].who, role);
      assert.equal(await tolerant(anyone(), () => adapter.count(item)), 3);
      const stats = adapter.poolStats();
      assert.ok(
        stats.some((pool) => pool.role === 'replica' && pool.replica === 1 && pool.checkouts > 0),
        'the replica pool is metered on its own',
      );
    });

    await t.test("a write's own reads are the primary's, and the writer reads the primary just after", async () => {
      const connections = (adapter as unknown as { connections: PgConnectionManager }).connections;
      assert.equal(await tolerant(anyone(), () => connections.withWriteClient(() => who())), primaryUser, 'inside a transaction');
      const carol = anyone();
      await readsAs(carol, () => adapter.update({ table: item, key: { id: 1 }, values: { name: 'uno' } }));
      assert.equal(await tolerant(carol, who), primaryUser, 'carol just wrote');
      assert.equal(await tolerant(anyone(), who), role, "dave did not: carol's save is not his");
    });

    await t.test('a replica session refuses writes', async () => {
      const connections = (adapter as unknown as { connections: PgConnectionManager }).connections;
      const reads = await connections.read();
      await assert.rejects(
        tolerant(anyone(), () => reads.query("INSERT INTO item VALUES (99, 'no')")),
        (error: { code?: string }) => error.code === '25006',
      );
      const check = await pgClient(owned.url);
      try {
        assert.equal((await check.query('SELECT count(*)::int AS n FROM item WHERE id = 99')).rows[0].n, 0);
      } finally {
        await check.end();
      }
    });

    await t.test('a dead replica hands its reads to the primary and is passed over', async () => {
      const fallback = connect(owned.url, { replicas: [dead.href] }) as PostgresAdapter;
      opened.push(fallback);
      await fallback.introspect();
      const read = async () =>
        String((await tolerant(anyone(), () => fallback.query({ table: whoami, limit: 10, offset: 0 }))).rows[0].who);
      assert.equal(await read(), primaryUser);
      assert.deepEqual(fallback.replicaHealth(), [{ replica: 1, healthy: false, served: 0, fellBack: 1 }]);
      const started = performance.now();
      assert.equal(await read(), primaryUser);
      assert.equal(fallback.replicaHealth()[0].fellBack, 1, 'passed over, not tried again within the backoff');
      assert.ok(performance.now() - started < 1_000);
    });

    await t.test('over HTTP: the grid and lists read the replica, a record row and a write the primary', async () => {
      const registry = new Registry();
      registry.add({ name: 'main', url: owned.url, replicas: [replicaUrl.href], writable: true, source: 'config' });
      registry.setActive('main');
      await registry.open('main');
      opened.push({ close: () => registry.closeAll() });
      server = createApp({ registry, bound: { host: '127.0.0.1', port: 0 } });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      let marker: string | null = null;
      const post = async (path: string, body: Record<string, unknown>, cookie?: string) => {
        const res = await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { rows?: Array<Record<string, unknown>>; error?: string };
        assert.equal(res.status, 200, `${path}: ${json.error ?? ''}`);
        marker = res.headers.get('set-cookie');
        return json;
      };
      const view = (limit: number) => ({ view: { id: 'w', name: 'w', base: whoami, columns: [{ path: 'who' }], limit }, count: 'none' });
      assert.equal((await post('/api/query', { table: whoami })).rows![0].who, role, 'the Workbench grid');
      assert.equal((await post('/api/view/run', view(25))).rows![0].who, role, 'a list');
      assert.equal((await post('/api/view/run', view(1))).rows![0].who, primaryUser, "a record's own row");
      assert.equal(marker, null, 'a read sets no marker');
      await post('/api/update', { table: item, key: { id: 2 }, values: { name: 'dos' } });
      const written = marker as string | null;
      assert.match(written ?? '', /^mistri_fresh=\d+; Path=\/; Max-Age=10; HttpOnly; SameSite=Lax$/, 'the write sets the marker');
      const cookie = written!.split(';')[0];
      assert.equal(
        (await post('/api/query', { table: whoami }, cookie)).rows![0].who,
        primaryUser,
        'the browser that wrote reads the primary',
      );
      assert.equal((await post('/api/query', { table: whoami })).rows![0].who, role, 'another visitor still reads the replica');
      const stale = `mistri_fresh=${Date.now() - 11_000}`;
      assert.equal((await post('/api/query', { table: whoami }, stale)).rows![0].who, role, 'an expired marker is ignored');
    });
  },
);
