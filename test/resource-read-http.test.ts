import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { ResourceReadError } from '../packages/engine/src/server/resourceReadOperations.js';
import { MAX_PAGE_OFFSET } from '../packages/engine/src/server/resourceReadHttp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const secret = 'PRIVATE_READ_DRIVER_SENTINEL';
async function fixture(
  app: boolean,
  run: (f: {
    adapter: Adapter;
    other: Adapter;
    call(path: string, body?: Record<string, unknown>): Promise<{ status: number; body: any }>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-resource-read-http-'));
  const registry = new Registry();
  let server: Server | undefined;
  try {
    for (const owner of ['first', 'second']) {
      const file = join(directory, `${owner}.db`);
      const db = new DatabaseSync(file);
      try {
        db.exec(`CREATE TABLE physical_team(id INTEGER PRIMARY KEY, name TEXT);
          CREATE TABLE physical_item(id INTEGER PRIMARY KEY, team INTEGER REFERENCES physical_team(id), name TEXT, hidden TEXT);
          INSERT INTO physical_team VALUES (1, 'Team');`);
        const insert = db.prepare('INSERT INTO physical_item VALUES (?, 1, ?, ?)');
        for (let id = 1; id <= (owner === 'second' ? 3 : 1); id++) insert.run(id, `${owner} ${id}`, secret);
      } finally {
        db.close();
      }
      registry.add({ id: owner, name: owner, url: file, writable: false, source: 'config' });
    }
    const other = (await registry.open('first')).adapter;
    const adapter = (await registry.open('second')).adapter;
    registry.setActive('first');
    const definition = parseAppConfig(
      {
        id: 'read-app',
        name: 'Read App',
        sources: { main: { connection: 'first', default: true }, inventory: { connection: 'second' } },
        resources: {
          item: { physical: 'physical_item' },
          team: { physical: 'physical_team' },
          'inventory.item': { physical: 'physical_item' },
          'inventory.team': { physical: 'physical_team' },
        },
        auth: {
          roles: {
            reader: {
              read: true,
              write: false,
              fields: {
                item: { read: ['id', 'team', 'name'] },
                'inventory.item': { read: ['id', 'team', 'name'] },
              },
            },
          },
        },
        views: { 'inventory-items': { kind: 'list', from: 'inventory.item' } },
        home: 'inventory-items',
        nav: ['inventory-items'],
      },
      'read fixture',
    );
    const host: AppHost = {
      app: { path: join(directory, 'app.ts'), app: definition, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: definition.auth!,
        store: 'unused',
        close: async () => {},
        handler: async () => {},
        session: async () => ({ id: 'verified-reader', who: 'reader@example.test', role: 'reader' }),
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    server = createApp({ registry, bound, ...(app ? { apps: [host] } : {}) });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({
      adapter,
      other,
      call: async (path, body = {}) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(app ? { app: 'read-app' } : { conn: 'second' }), ...body }),
          signal: AbortSignal.timeout(5000),
        });
        return { status: response.status, body: await response.json() };
      },
    });
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

for (const app of [false, true]) {
  test(`${app ? 'App' : 'browser'} shared reads retain named-source ownership and transport projection`, async () => {
    await fixture(app, async (f) => {
      const table = app ? 'inventory.item' : 'physical_item';
      f.other.query = async () => assert.fail('must not use active/default source');
      f.other.count = async () => assert.fail('must not count the active/default source');
      for (const [path, input] of [
        ['/api/query', { table, columns: ['name'], orderBy: [{ column: 'id', direction: 'desc' }], limit: '1.9', offset: '1.9' }],
        ['/api/run', { q: `${table} show name order by id desc`, limit: 1, offset: 1, exactCount: true }],
        [
          '/api/view/run',
          {
            view: { id: 'items', name: 'Items', base: table, columns: [{ path: 'name' }], orderBy: [{ path: 'id', direction: 'desc' }] },
            limit: 1,
            offset: 1,
          },
        ],
      ] as const) {
        const reply = await f.call(path, input);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(reply.body.errors?.length ?? 0, 0, JSON.stringify(reply.body));
        assert.equal(reply.body.rows.length, 1);
        assert.equal(Object.values(reply.body.rows[0])[0], 'second 2');
        assert.equal('sql' in reply.body, !app);
        assert.doesNotMatch(JSON.stringify(reply.body), new RegExp(secret));
        if (path !== '/api/query') assert.equal(reply.body.total, 3);
      }
      const count = await f.call('/api/count', { table, exactCount: true });
      assert.deepEqual(count.body, { count: 3, exact: true });
      const groups = await f.call('/api/breakdown', { text: `${table} count by team` });
      assert.equal(groups.status, 200);
      assert.equal(groups.body.total, 1);
      assert.equal(groups.body.rows.length, 1);
      assert.equal('sql' in groups.body, !app);
      assert.doesNotMatch(JSON.stringify(groups.body), new RegExp(secret));
    });
  });
}

for (const app of [false, true]) {
  test(`${app ? 'App' : 'browser'} breakdown batch answers each item as the single route would, and fails an item alone`, async () => {
    await fixture(app, async (f) => {
      const table = app ? 'inventory.item' : 'physical_item';
      f.other.runBreakdown = async () => assert.fail('must not use active/default source');
      const asks = [{ text: `${table} count by team` }, { text: `${table} count`, limit: 1 }, { text: `${table} count by nowhere` }];
      const batch = await f.call('/api/breakdowns', { items: asks });
      assert.equal(batch.status, 200, JSON.stringify(batch.body));
      assert.equal(batch.body.results.length, 3);
      for (const [index, ask] of asks.entries()) {
        const alone = await f.call('/api/breakdown', ask);
        const item = batch.body.results[index];
        assert.equal(item.status, alone.status);
        // Timings differ run to run; everything else is the same answer.
        const same = (body: Record<string, unknown>) => ({ ...body, ms: undefined });
        assert.deepEqual(same(item.body), same(alone.body));
        assert.doesNotMatch(JSON.stringify(item.body), new RegExp(secret));
      }
      assert.equal(batch.body.results[0].body.rows.length, 1);
      assert.ok(batch.body.results[2].body.errors.length, 'the misspelled item carries its own error');
      for (const items of [undefined, [], Array(49).fill({ text: `${table} count` }), [null], ['text'], [{ run: 'text' }], [{ run: [] }]]) {
        const refused = await f.call('/api/breakdowns', { items });
        assert.equal(refused.status, 400, JSON.stringify({ items, body: refused.body }));
      }
    });
  });

  test(`${app ? 'App' : 'browser'} a list's tabs, asked with their show paths, are counted in one statement`, async () => {
    await fixture(app, async (f) => {
      const table = app ? 'inventory.item' : 'physical_item';
      // A tab's count is asked in the list's words, a path in `show` and all; only conditions through a path need the view.
      const items = [
        `${table} show name, team.name`,
        `${table} name = "second 1" show name, team.name`,
        `${table} team.name = Team show name`,
      ];
      const views: unknown[] = [];
      const countView = f.adapter.countView!.bind(f.adapter);
      f.adapter.countView = async (view, limit) => {
        views.push(view);
        return countView(view, limit);
      };
      const counts = await f.call('/api/counts', { items });
      assert.equal(counts.status, 200, JSON.stringify(counts.body));
      assert.deepEqual(
        counts.body.results.map((result: { total: number }) => result.total),
        [3, 1, 3],
      );
      assert.equal(views.length, 1, 'only the condition through a reference is counted as a view');
    });
  });

  test(`${app ? 'App' : 'browser'} breakdown batch carries a list's page, answered as /api/run answers it`, async () => {
    await fixture(app, async (f) => {
      const table = app ? 'inventory.item' : 'physical_item';
      const page = { q: `${table} sort name`, limit: 2, offset: 0, count: 'none' };
      const batch = await f.call('/api/breakdowns', {
        items: [{ text: `${table} count` }, { run: page }, { run: { q: `${table} nowhere = 1`, limit: 2 } }],
      });
      assert.equal(batch.status, 200, JSON.stringify(batch.body));
      const alone = await f.call('/api/run', page);
      const same = (body: Record<string, unknown>) => ({ ...body, ms: undefined });
      assert.equal(batch.body.results[1].status, alone.status);
      assert.deepEqual(same(batch.body.results[1].body), same(alone.body));
      assert.equal(batch.body.results[1].body.rows.length, 2);
      assert.ok(batch.body.results[2].body.errors.length, 'a list that does not read carries its own error');
    });
  });

  test(`${app ? 'App' : 'browser'} view count:none skips countView while an omitted count stays exact`, async () => {
    await fixture(app, async (f) => {
      const table = app ? 'inventory.item' : 'physical_item';
      const exact = await f.call('/api/view/run', { view: { base: table, columns: [{ path: 'name' }] } });
      assert.equal(exact.status, 200, JSON.stringify(exact.body));
      assert.equal(exact.body.total, 3, 'omitting count preserves the exact-total contract');
      let counted = 0;
      f.adapter.countView = async () => {
        counted++;
        throw new Error(secret);
      };
      const reply = await f.call('/api/view/run', { view: { base: table, columns: [{ path: 'name' }] }, count: 'none' });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(counted, 0);
      assert.equal('total' in reply.body, false);
      assert.equal(reply.body.rows.length, 3);
    });
  });

  test(`${app ? 'App' : 'browser'} view count refuses values outside none or exact`, async () => {
    await fixture(app, async (f) => {
      const table = app ? 'inventory.item' : 'physical_item';
      for (const count of [null, true, 'estimate', {}, 0]) {
        const reply = await f.call('/api/view/run', { view: { base: table, columns: [{ path: 'name' }] }, count });
        assert.equal(reply.status, 400, JSON.stringify({ count, body: reply.body }));
        assert.match(reply.body.error, /count must be "none" or "exact"/);
        assert.equal('rows' in reply.body, false);
      }
    });
  });
}

test('HTTP query-bar view without count capability does not fabricate a zero total', async () => {
  await fixture(false, async (f) => {
    f.adapter.countView = undefined;
    const reply = await f.call('/api/run', { q: 'physical_item show name, team.name', limit: 1 });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.errors?.length ?? 0, 0, JSON.stringify(reply.body));
    assert.equal(reply.body.rows.length, 1);
    assert.equal('total' in reply.body, false);
  });
});

for (const app of [false, true]) {
  test(`${app ? 'App' : 'browser'} failed count waits for outstanding rows and returns no partial data`, async () => {
    await fixture(app, async (f) => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const query = f.adapter.query.bind(f.adapter);
      f.adapter.query = async (request) => {
        entered();
        await gate;
        return query(request);
      };
      f.adapter.count = async () => {
        throw new Error(secret);
      };
      let finished = false;
      const response = f
        .call('/api/run', { q: app ? 'inventory.item show name' : 'physical_item show name', exactCount: true })
        .then((reply) => {
          finished = true;
          return reply;
        });
      try {
        await started;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(finished, false);
      } finally {
        release();
      }
      const reply = await response;
      assert.equal(reply.status, 500);
      assert.equal('rows' in reply.body, false);
      if (app) assert.doesNotMatch(JSON.stringify(reply.body), new RegExp(secret));
      else assert.equal(reply.body.error, secret);
    });
  });
}

for (const method of ['query', 'count'] as const) {
  for (const failure of ['rejection', 'throw', 'getter'] as const) {
    test(`App HTTP sanitizes provider ResourceReadError from ${method} ${failure}`, async () => {
      await fixture(true, async (f) => {
        let attempts = 0;
        const error = new ResourceReadError(method === 'query' ? 400 : 404, secret);
        error.cause = new Error('PRIVATE_READ_PROVIDER_CAUSE');
        const fail = () => {
          attempts++;
          throw error;
        };
        if (failure === 'getter') Object.defineProperty(f.adapter, method, { configurable: true, get: fail });
        else if (failure === 'throw') f.adapter[method] = fail;
        else f.adapter[method] = async () => fail();
        for (const [path, body] of [
          [`/api/${method}`, { table: 'inventory.item', exactCount: true }],
          ['/api/run', { q: 'inventory.item show name', exactCount: true }],
        ] as const) {
          const reply = await f.call(path, body);
          assert.equal(reply.status, 500, JSON.stringify(reply.body));
          assert.deepEqual(reply.body, {
            error: 'The data could not be loaded. Try again shortly.',
            code: 'data_unavailable',
          });
          assert.doesNotMatch(JSON.stringify(reply.body), /PRIVATE_READ|physical_item|second 1|second 2|second 3/);
          assert.equal('rows' in reply.body, false);
          assert.equal('count' in reply.body, false);
          assert.equal('total' in reply.body, false);
        }
        assert.ok(attempts >= 2, 'both HTTP paths must reach the failing provider');
      });
    });
  }
}

for (const app of [false, true]) {
  test(`${app ? 'App' : 'browser'} HTTP retains public validation diagnostics without running provider reads`, async () => {
    await fixture(app, async (f) => {
      let reads = 0;
      const unexpected = async () => {
        reads++;
        throw new Error('Unexpected provider read');
      };
      f.adapter.query = unexpected;
      f.adapter.count = unexpected;
      f.adapter.estimateCount = unexpected;
      const table = app ? 'inventory.item' : 'physical_item';
      for (const [path, body] of [
        ['/api/query', { table, columns: ['missing_column'] }],
        ['/api/query', { table, orderBy: [{ column: 'missing_column', direction: 'asc' }] }],
        ['/api/count', { table, filter: { groups: [[{ column: 'missing_column', op: '=', value: 1 }]] } }],
      ] as const) {
        const reply = await f.call(path, body);
        assert.equal(reply.status, 400, JSON.stringify(reply.body));
        assert.match(reply.body.error, /has no column "missing_column"/);
        assert.equal('rows' in reply.body, false);
        assert.equal('count' in reply.body, false);
        if (app) assert.doesNotMatch(JSON.stringify(reply.body), /physical_item|PRIVATE_READ/);
      }
      for (const path of ['/api/query', '/api/count']) {
        const reply = await f.call(path, { table: 'missing_table' });
        // App resource authorization still takes precedence over catalog lookup.
        assert.equal(reply.status, app ? 403 : 404, JSON.stringify(reply.body));
        if (app) assert.deepEqual(reply.body, { error: 'Access to this resource is denied.', code: 'forbidden' });
        else assert.equal(reply.body.error, 'Unknown table "missing_table"');
      }
      assert.equal(reads, 0);
    });
  });
}

test('a page past the offset ceiling is refused before any read, and the ceiling itself is read', async () => {
  await fixture(false, async (f) => {
    let reads = 0;
    const query = f.adapter.query.bind(f.adapter),
      runView = f.adapter.runView!.bind(f.adapter);
    f.adapter.query = (request) => {
      reads++;
      return query(request);
    };
    f.adapter.runView = (view, offset) => {
      reads++;
      return runView(view, offset);
    };
    for (const [path, input] of [
      ['/api/query', { table: 'physical_item' }],
      ['/api/run', { q: 'physical_item', count: 'none' }],
      ['/api/view/run', { view: { id: 'items', name: 'Items', base: 'physical_item', columns: [{ path: 'name' }] }, count: 'none' }],
    ] as const) {
      const deep = await f.call(path, { ...input, limit: 1, offset: MAX_PAGE_OFFSET + 1 });
      assert.equal(deep.status, 200);
      assert.equal(deep.body.errors.length, 1, path);
      assert.equal(deep.body.rows, undefined);
      const edge = await f.call(path, { ...input, limit: 1, offset: MAX_PAGE_OFFSET });
      assert.equal(edge.body.errors?.length ?? 0, 0, JSON.stringify(edge.body));
    }
    assert.equal(reads, 3, 'only the pages at the ceiling reached the database');
  });
});

for (const app of [false, true]) {
  test(`${app ? 'an App' : 'the browser'} steps a list by key through its reader, and a hidden column is never a boundary`, async () => {
    await fixture(app, async (f) => {
      const q = `${app ? 'inventory.item' : 'physical_item'} show name sort name desc`;
      const names: unknown[] = [];
      let reply = await f.call('/api/run', { q, limit: 1, count: 'none' });
      names.push(reply.body.rows[0].name);
      for (let page = 1; page < 3; page++) {
        assert.deepEqual(Object.keys(reply.body.bounds.last).sort(), ['id', 'name']);
        reply = await f.call('/api/run', { q, limit: 1, offset: page, count: 'none', after: reply.body.bounds.last });
        assert.equal(reply.body.keyset, true, JSON.stringify(reply.body));
        assert.deepEqual(Object.keys(reply.body.rows[0]), ['name']);
        names.push(reply.body.rows[0].name);
      }
      assert.deepEqual(names, ['second 3', 'second 2', 'second 1']);
      if (app) {
        // The App's reader may not read `hidden`: a boundary naming it is a filter on it, and refused as one.
        const probe = await f.call('/api/run', { q: 'inventory.item sort hidden', limit: 1, count: 'none' });
        assert.ok(probe.status !== 200 || probe.body.errors?.length, JSON.stringify(probe.body));
      }
    });
  });
}

for (const app of [false, true]) {
  test(`${app ? 'App' : 'browser'} a count compares two columns, as a list's question does`, async () => {
    await fixture(app, async (f) => {
      const table = app ? 'inventory.item' : 'physical_item';
      const items = [`${table} id <= team`, `${table} id > team`];
      const counts = await f.call('/api/counts', { items });
      assert.equal(counts.status, 200, JSON.stringify(counts.body));
      assert.deepEqual(
        counts.body.results.map((result: { total?: number; errors?: unknown }) => result.total ?? result.errors),
        [1, 2],
      );
    });
  });
}
