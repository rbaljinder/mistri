/**
 * Live sync's binding rides on what is already open (live/liveBinding.ts): a
 * request marks its App's databases and opens none, a database that will not
 * open holds up no other request, the hub's wake starts with the first
 * subscriber, and a write through an adapter dialed after the mark, or open
 * before it, is still captured and told.
 *
 * In one process over two SQLite files, each with the change store, under an
 * App that reads both and signs nobody in.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { capturesLiveChanges, LIVE_CHANGE_TABLES } from '../packages/mistri/src/adapters/live/liveChange.js';
import { provisionSqliteLiveChange } from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import type { AppHost, LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { ensureAppLive } from '../packages/mistri/src/server/live/liveBinding.js';
import { madeLiveHub } from '../packages/mistri/src/server/live/liveHub.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { createApp } from './support/createApp.js';

/** The App over both databases, or one App over each; asking for live sync unless told not to. */
function app(id = 'binding', connection?: 'ops' | 'stock', live = true): AppHost {
  const loaded: LoadedApp = {
    path: `/private/operator/${id}/app.ts`,
    app: parseAppConfig(
      {
        id,
        name: id,
        ...(live ? { live: true } : {}),
        ...(connection
          ? { connection, resources: { incident: { access: 'write' } } }
          : {
              sources: {
                operations: { connection: 'ops', default: true },
                inventory: { connection: 'stock' },
              },
              resources: {
                incident: { access: 'write' },
                'inventory.incident': { access: 'write' },
              },
            }),
        views: {
          incidents: { kind: 'list', from: 'incident', label: 'Incidents' },
        },
        home: 'incidents',
        nav: ['incidents'],
      },
      'live binding fixture',
    ),
    pages: [],
    sources: {},
  };
  return { app: loaded, pages: [] };
}

type Ids = 'ops' | 'stock';

async function fixture(
  run: (base: string, registry: Registry, files: Record<Ids, string>) => Promise<void>,
  options: {
    before?: (registry: Registry) => void | Promise<void>;
    apps?: AppHost[];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-live-binding-'));
  const files = {
    ops: join(directory, 'ops.db'),
    stock: join(directory, 'stock.db'),
  };
  for (const [id, file] of Object.entries(files)) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.prepare('INSERT INTO incident (id, name) VALUES (1, ?)').run(`${id} incident`);
    db.close();
    provisionSqliteLiveChange(file);
  }
  const registry = new Registry();
  registry.add({
    id: 'stock',
    name: 'Stock',
    url: files.stock,
    writable: true,
    source: 'config',
  });
  registry.add({
    id: 'ops',
    name: 'Operations',
    url: files.ops,
    writable: true,
    source: 'config',
  });
  let server: Server | undefined;
  try {
    await options.before?.(registry);
    const bound = { host: '127.0.0.1', port: 0 };
    server = createApp({ registry, apps: options.apps ?? [app()], bound });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run(`http://${bound.host}:${bound.port}`, registry, files);
  } finally {
    if (server) {
      const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

const update = (base: string, table: string, name: string, appId = 'binding') =>
  fetch(`${base}/api/update`, {
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: appId,
      table,
      key: { id: 1 },
      values: { name },
    }),
  });

/** A stream, read in the background. */
async function follow(base: string, appId = 'binding') {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/live?app=${appId}`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  let text = '';
  const done = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body!) text += decoder.decode(chunk as Uint8Array, { stream: true });
    } catch {
      /* aborted */
    }
  })();
  const until = async (pattern: RegExp, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!pattern.test(text) && Date.now() < deadline) await delay(20);
    assert.match(text, pattern);
  };
  await until(/event: hello/);
  return {
    until,
    close: async () => {
      controller.abort();
      await done;
    },
  };
}

const changeRows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM "${LIVE_CHANGE_TABLES.change}"`).get()!.n);
  } finally {
    db.close();
  }
};

test('marking an App opens, leases and asks nothing; the adapter is bound when something else dials it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-live-mark-'));
  const file = join(directory, 'ops.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.close();
  provisionSqliteLiveChange(file);
  const registry = new Registry();
  registry.add({
    id: 'ops',
    name: 'Operations',
    url: file,
    writable: true,
    source: 'config',
  });
  t.after(async () => {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = t.mock.method(registry, 'open');
  const lease = t.mock.method(registry, 'lease');
  for (let n = 0; n < 3; n++) ensureAppLive(registry, app('binding', 'ops'));
  assert.equal(open.mock.callCount(), 0, 'nothing opened');
  assert.equal(lease.mock.callCount(), 0, 'nothing leased');
  assert.equal(registry.dialedAdapter('ops'), undefined);
  // Opened for another reason: bound before anything can write through it.
  await registry.open('ops');
  assert.equal(capturesLiveChanges(registry.dialedAdapter('ops')!, 'incident'), true);
});

test('a database whose open never finishes holds up no request to an App that does not read it', { timeout: 15_000 }, async () => {
  let resolve!: () => void;
  const release = {
    promise: new Promise<void>((done) => (resolve = done)),
    resolve: () => resolve(),
  };
  await fixture(
    async (base, registry, files) => {
      const open = registry.open.bind(registry);
      registry.open = async (id) => {
        if (id === 'stock') await release.promise;
        return open(id);
      };
      try {
        // The other App's first request starts its open, which never finishes.
        const stuck = fetch(`${base}/api/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            app: 'stocked',
            table: 'incident',
            key: { id: 1 },
            values: { name: 'stuck' },
          }),
        }).catch(() => undefined);
        for (let n = 0; n < 3; n++) {
          const started = Date.now();
          const response = await update(base, 'incident', `saved ${n}`, 'opsed');
          assert.equal(response.status, 200, await response.text());
          assert.ok(Date.now() - started < 1_500, `request ${n} waited ${Date.now() - started} ms`);
        }
        assert.equal(changeRows(files.ops), 3, 'every write captured');
        release.resolve();
        await stuck;
      } finally {
        release.resolve();
      }
    },
    { apps: [app('opsed', 'ops'), app('stocked', 'stock')] },
  );
});

test('the hub wakes with the first subscriber and sleeps after the last', { timeout: 15_000 }, async () => {
  await fixture(async (base, registry) => {
    assert.equal((await update(base, 'incident', 'before anyone listens')).status, 200);
    const adapter = registry.dialedAdapter('ops');
    assert.ok(adapter);
    const deadline = Date.now() + 2_000;
    while (!madeLiveHub(adapter) && Date.now() < deadline) await delay(10);
    const hub = madeLiveHub(adapter);
    assert.ok(hub, 'the store attested at the first write: the hub is made, for its prune');
    assert.equal(hub.waking, false, 'nothing listens until someone subscribes');
    const first = await follow(base);
    assert.equal(hub.waking, true);
    const second = await follow(base);
    await first.close();
    await delay(100);
    assert.equal(hub.waking, true, 'one subscriber is still there');
    await second.close();
    const quiet = Date.now() + 2_000;
    while (hub.waking && Date.now() < quiet) await delay(20);
    assert.equal(hub.waking, false);
  });
});

test('a write through an adapter dialed after the mark, or open before it, is captured and told', { timeout: 15_000 }, async () => {
  await fixture(
    async (base, registry, files) => {
      // The first request marks; ops is dialed by the write itself, stock was open before anyone asked.
      assert.equal(registry.dialedAdapter('ops'), undefined);
      assert.ok(registry.dialedAdapter('stock'));
      assert.equal((await update(base, 'incident', 'first')).status, 200);
      assert.equal(changeRows(files.ops), 1, 'the write that dialed ops wrote its change row');
      assert.equal((await update(base, 'inventory.incident', 'first')).status, 200);
      assert.equal(changeRows(files.stock), 1, 'the adapter open before the mark writes its change row');

      const reading = await follow(base);
      try {
        assert.equal((await update(base, 'incident', 'told')).status, 200);
        await reading.until(/event: change\ndata: .*"incident":\{"keys":\[\{"id":1\}\]/);
        assert.equal((await update(base, 'inventory.incident', 'told')).status, 200);
        await reading.until(/event: change\ndata: .*"inventory\.incident":\{"keys":\[\{"id":1\}\]/);
      } finally {
        await reading.close();
      }

      // A reconnect is a new adapter, bound as it is dialed.
      await registry.refresh('ops');
      assert.equal((await update(base, 'incident', 'after a reconnect')).status, 200);
      assert.equal(changeRows(files.ops), 3);
    },
    {
      before: async (registry) => {
        await registry.open('stock');
      },
    },
  );
});

test(
  'on a connection two Apps share, writes are captured when either asks, and only the App that asked is served',
  { timeout: 15_000 },
  async () => {
    await fixture(
      async (base, _registry, files) => {
        // The App that does not ask: no stream, though its write is captured for the one that does.
        assert.equal((await fetch(`${base}/api/live?app=quiet`)).status, 204);
        assert.equal((await update(base, 'incident', 'by the quiet App', 'quiet')).status, 200);
        assert.equal(changeRows(files.ops), 1, 'the connection is bound: another App on it asked');
        const reading = await follow(base, 'asking');
        try {
          assert.equal((await update(base, 'incident', 'told', 'quiet')).status, 200);
          await reading.until(/event: change\ndata: .*"incident":\{"keys":\[\{"id":1\}\]/);
        } finally {
          await reading.close();
        }
      },
      { apps: [app('quiet', 'ops', false), app('asking', 'ops')] },
    );
  },
);

test('a connection no App on it asks for is never bound', { timeout: 15_000 }, async () => {
  await fixture(
    async (base, registry, files) => {
      assert.equal((await fetch(`${base}/api/live?app=quiet`)).status, 204);
      assert.equal((await update(base, 'incident', 'unheard', 'quiet')).status, 200);
      assert.equal(changeRows(files.ops), 0, 'no change row written');
      assert.equal(capturesLiveChanges(registry.dialedAdapter('ops')!, 'incident'), false);
    },
    { apps: [app('quiet', 'ops', false)] },
  );
});
