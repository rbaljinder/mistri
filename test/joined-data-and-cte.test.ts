/**
 * End-to-end test suite for joined data, row projection, batch helpers, scoped SQL CTEs,
 * and declarative CTE-backed derived resources:
 *
 * 1. Pages `useRows` / `useRecord` parent & bounded child `include` over `/api/view/run`
 * 2. `ctx.db` column projection (`.select`, `get`, `find`), batch lookups (`getMany`, `by`),
 *    `.include()` (parent + bounded child, zero N+1), and 1-hop FK `orderBy` & `groupBy`
 * 3. Layer 1 scoped SQL CTEs (`ctx.cte`) in commands & page loaders, including chained CTEs,
 *    concurrent `AsyncLocalStorage` isolation, `RowScope` tenant isolation, and `cteFor` grants
 * 4. Layer 2 declarative CTE-backed `derived` resources (`defineQuery` in `app.ts`): parsing,
 *    `derivedProblems`, `withDerived` grant pruning, `mistri-schema.d.ts` typegen, and HTTP
 *    `/api/view/run` + `/api/breakdown` execution
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { resourceChecks } from '../packages/engine/src/server/columnGrants.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parentIncludePaths, shapeIncludedRows, splitInclude } from '../packages/engine/src/shared/viewInclude.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { derivedProblems, withDerived } from '../packages/mistri/src/shared/appDerived.js';
import { appCatalog } from '../packages/mistri/src/shared/appRollups.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import { appProblems, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { commandCatalog, count, createCommandDb, cteOf, sum } from '../packages/mistri/src/server/commands/commandDb.js';
import { defineLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import { defineQuery } from '../packages/mistri/schema/app.mjs';

function seedMarketDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE seller (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      secret_notes TEXT
    );
    CREATE TABLE listing (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      seller_id INTEGER REFERENCES seller(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      price INTEGER NOT NULL
    );
    CREATE TABLE listing_photo (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      listing_id INTEGER NOT NULL REFERENCES listing(id),
      url TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE tag_assignment (
      listing_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (listing_id, tag)
    );

    INSERT INTO seller VALUES
      (1, 't1', 'Zelda Studio', 'Portland', 'vip'),
      (2, 't1', 'Aurelia Goods', 'Seattle', 'std'),
      (3, 't1', 'Empty Workshop', 'Austin', 'new'),
      (4, 't2', 'Other Tenant', 'Miami', 'secret');

    INSERT INTO listing VALUES
      (10, 't1', 1, 'Brass Lamp', 'active', 240),
      (11, 't1', 1, 'Walnut Shelf', 'active', 460),
      (12, 't1', 1, 'Archived Vase', 'sold', 90),
      (13, 't1', 2, 'Vintage Turntable', 'active', 600),
      (14, 't1', NULL, 'Unassigned Piece', 'active', 150),
      (20, 't2', 4, 'Tenant 2 Chair', 'active', 999);

    INSERT INTO listing_photo VALUES
      (100, 't1', 10, '/lamp-3.jpg', 3),
      (101, 't1', 10, '/lamp-1.jpg', 1),
      (102, 't1', 10, '/lamp-2.jpg', 2),
      (103, 't1', 13, '/tt-1.jpg', 1),
      (200, 't2', 20, '/t2-1.jpg', 1);

    INSERT INTO tag_assignment VALUES
      (10, 'lighting'),
      (10, 'brass'),
      (13, 'audio');
  `);
  db.close();
}

test('viewInclude: splits parent + child specs, derives join paths, and shapes nested rows with null FKs', () => {
  const split = splitInclude({
    seller_id: ['name', 'city'],
    maker: { via: 'seller_id', show: ['name'] },
    listing_photo: { by: 'listing_id', show: ['url', 'sort_order'], sort: 'sort_order asc', limit: 2 },
  });
  assert.equal(split.parents.length, 2);
  assert.equal(Object.keys(split.children).length, 1);
  assert.deepEqual(parentIncludePaths(split.parents), ['seller_id', 'seller_id.name', 'seller_id.city']);

  const shaped = shapeIncludedRows(
    [
      { id: 10, title: 'Lamp', seller_id: 1, 'seller_id.name': 'Zelda', 'seller_id.city': 'Portland' },
      { id: 14, title: 'Orphan', seller_id: null, 'seller_id.name': null, 'seller_id.city': null },
    ] as Record<string, unknown>[],
    split.parents,
    { listing_photo: { rowsByParent: { '10': [{ id: 101, url: '/lamp-1.jpg', sort_order: 1 }] } } },
    'id',
    undefined,
  );
  assert.deepEqual(shaped[0]!.seller_id, { name: 'Zelda', city: 'Portland' });
  assert.deepEqual(shaped[0]!.maker, { name: 'Zelda' });
  assert.deepEqual(shaped[0]!.listing_photo, [{ id: 101, url: '/lamp-1.jpg', sort_order: 1 }]);
  assert.equal(shaped[1]!.seller_id, null);
  assert.equal(shaped[1]!.maker, null);
  assert.deepEqual(shaped[1]!.listing_photo, []);
});

test('ctx.db: projection (.select), batching (getMany, by), .include() zero N+1, and 1-hop FK orderBy/groupBy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-db-join-'));
  try {
    const dbPath = join(dir, 'market.db');
    seedMarketDb(dbPath);
    const adapter = new SqliteAdapter(dbPath);
    const schema = await adapter.introspect();
    const catalog = commandCatalog(schema, ['seller', 'listing', 'listing_photo', 'tag_assignment'], (name) => name)!;

    let queryCount = 0;
    const tx = {
      query: async (req: Parameters<typeof adapter.query>[0]) => {
        queryCount++;
        return adapter.query(req);
      },
      count: (table: string, filter?: Parameters<typeof adapter.count>[1]) => adapter.count(table, filter),
      aggregate: adapter.aggregate!.bind(adapter),
      cte: adapter.cte!.bind(adapter),
    };

    const db = createCommandDb({
      tx,
      catalog,
      read: ['seller', 'listing', 'listing_photo', 'tag_assignment'],
      write: [],
      now: () => new Date('2026-11-26T00:00:00Z'),
    });

    // 1. Row projection (.select + get/find options)
    const projected = await db.listing.where({ tenant_id: 't1', status: 'active' }).select('id', 'title').orderBy('id', 'asc');
    assert.equal(projected.length, 4);
    assert.deepEqual(Object.keys(projected[0]!).sort(), ['id', 'title']);
    const oneProj = await db.listing.get(10, { select: ['title', 'price'] });
    assert.deepEqual(Object.keys(oneProj).sort(), ['price', 'title']);
    assert.equal(oneProj.title, 'Brass Lamp');
    const foundProj = await db.listing.find({ id: 13 }, { select: ['title'] });
    assert.deepEqual(foundProj, { title: 'Vintage Turntable' });
    await assert.rejects(() => Promise.resolve().then(() => db.listing.where().select('does_not_exist' as never)), {
      name: 'BusinessCommandExecutionError',
    });

    // 2. getMany (single PK + empty + dedup + composite PK)
    const emptyMap = await db.seller.getMany([]);
    assert.equal(emptyMap.size, 0);
    const sellerMap = await db.seller.getMany([1, 2, 1, 999], { select: ['id', 'name'] });
    assert.equal(sellerMap.size, 2);
    assert.deepEqual(sellerMap.get(1), { id: 1, name: 'Zelda Studio' });
    assert.equal(sellerMap.get(999), undefined);
    const compMap = await db.tag_assignment.getMany([
      { listing_id: 10, tag: 'brass' },
      { listing_id: 13, tag: 'audio' },
    ]);
    assert.equal(compMap.size, 2);

    // 3. by() grouped lookup with orderBy + per-key limit
    const photoMap = await db.listing_photo.by('listing_id', [10, 13, 14], {
      select: ['url', 'sort_order'],
      orderBy: ['sort_order', 'asc'],
      limit: 2,
    });
    assert.deepEqual(
      photoMap.get(10)?.map((p) => p.url),
      ['/lamp-1.jpg', '/lamp-2.jpg'],
    );
    assert.deepEqual(
      photoMap.get(13)?.map((p) => p.url),
      ['/tt-1.jpg'],
    );
    assert.deepEqual(photoMap.get(14), []);

    // 4. .include() parent + aliased parent + bounded child with zero N+1
    queryCount = 0;
    const withRelations = await db.listing
      .where({ tenant_id: 't1', status: 'active' })
      .select('id', 'title')
      .include({
        seller_id: ['name', 'city'],
        maker: { via: 'seller_id', select: ['name'] },
        listing_photo: { by: 'listing_id', select: ['url'], orderBy: ['sort_order', 'asc'], limit: 2 },
      })
      .orderBy('id', 'asc');
    // 1 base listing query + 1 batched seller query + 1 batched seller query (alias) + 1 batched photo query = 4 total regardless of row count (no N+1)
    assert.ok(queryCount <= 4, `expected batched queries (<=4), got ${queryCount}`);
    assert.equal(withRelations.length, 4);
    const lamp = withRelations.find((r) => r.id === 10) as Record<string, unknown>;
    assert.deepEqual(Object.keys(lamp).sort(), ['id', 'listing_photo', 'maker', 'seller_id', 'title']);
    assert.deepEqual(lamp.seller_id, { name: 'Zelda Studio', city: 'Portland' });
    assert.deepEqual(lamp.maker, { name: 'Zelda Studio' });
    assert.deepEqual(lamp.listing_photo, [{ url: '/lamp-1.jpg' }, { url: '/lamp-2.jpg' }]);
    const orphan = withRelations.find((r) => r.id === 14) as Record<string, unknown>;
    assert.equal(orphan.seller_id, null);
    assert.equal(orphan.maker, null);
    assert.deepEqual(orphan.listing_photo, []);

    // Undeclared table in include is refused
    const narrowDb = createCommandDb({
      tx,
      catalog: commandCatalog(schema, ['listing'], (name) => name)!,
      read: ['listing'],
      write: [],
      now: () => new Date('2026-11-26T00:00:00Z'),
    });
    await assert.rejects(
      async () => {
        await narrowDb.listing.where({ id: 10 }).include({ seller_id: ['name'] });
      },
      { name: 'BusinessCommandExecutionError' },
    );

    // 5. 1-hop FK orderBy('seller_id.name') & groupBy('seller_id.city')
    const orderedBySeller = await db.listing
      .where({ tenant_id: 't1', status: 'active', seller_id: { not: null } })
      .select('id', 'title')
      .orderBy('seller_id.name', 'asc');
    assert.equal(orderedBySeller[0]!.title, 'Vintage Turntable'); // Aurelia Goods < Zelda Studio

    const groupedByCity = await db.listing
      .where({ tenant_id: 't1', status: 'active', seller_id: { not: null } })
      .groupBy('seller_id.city')
      .aggregate({ listings: count(), total: sum('price') })
      .orderBy('total', 'desc');
    assert.deepEqual(groupedByCity, [
      { 'seller_id.city': 'Portland', listings: 2, total: '700' },
      { 'seller_id.city': 'Seattle', listings: 1, total: '600' },
    ]);

    await adapter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Layer 1 SQL CTEs (ctx.cte): aggregate-join, left join, chained CTEs, concurrency, RowScope & grants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-cte-'));
  try {
    const dbPath = join(dir, 'market.db');
    seedMarketDb(dbPath);
    const adapter = new SqliteAdapter(dbPath);
    const schema = await adapter.introspect();
    const catalog = commandCatalog(schema, ['seller', 'listing'], (name) => name)!;

    // 1. Direct CTE execution through createCommandDb + cteOf
    const db = createCommandDb({
      tx: adapter,
      catalog,
      read: ['seller', 'listing'],
      write: [],
      now: () => new Date('2026-11-26T00:00:00Z'),
    });
    const cte = cteOf(db);

    const scorecard = await cte(
      {
        live_stats: db.listing
          .where({ tenant_id: 't1', status: 'active' })
          .groupBy('seller_id')
          .aggregate({ live_count: count(), total_value: sum('price') }),
      },
      (q) =>
        db.seller
          .join(q.live_stats, { on: ['id', 'seller_id'], kind: 'left' })
          .where({ tenant_id: 't1' })
          .select('id', 'name', 'city', 'live_stats.live_count', 'live_stats.total_value')
          .orderBy('live_stats.total_value', 'desc'),
    );
    assert.equal(scorecard.length, 3);
    assert.equal(scorecard[0]!.name, 'Zelda Studio');
    assert.equal(Number(scorecard[0]!.live_count), 2);
    assert.equal(Number(scorecard[0]!.total_value), 700);
    assert.equal(scorecard[1]!.name, 'Aurelia Goods');
    assert.equal(Number(scorecard[1]!.live_count), 1);
    const emptyWorkshop = scorecard.find((r) => r.name === 'Empty Workshop')!;
    assert.equal(emptyWorkshop.live_count, null);

    // HAVING-style filter on CTE aggregate column
    const prolific = await cte(
      {
        live_stats: db.listing.where({ tenant_id: 't1', status: 'active' }).groupBy('seller_id').aggregate({ live_count: count() }),
      },
      (q) =>
        db.seller
          .join(q.live_stats, { on: ['id', 'seller_id'] })
          .where({ 'live_stats.live_count': { gte: 2 } })
          .select('name', 'live_stats.live_count'),
    );
    assert.deepEqual(prolific, [{ name: 'Zelda Studio', live_count: 2 }]);

    // Chained nested CTEs + concurrent AsyncLocalStorage isolation
    const [r1, r2] = await Promise.all([
      cte(
        {
          active_listings: db.listing.where({ tenant_id: 't1', status: 'active' }).select('id', 'seller_id', 'price'),
        },
        (q1) =>
          cte(
            {
              seller_totals: db.seller.join(q1.active_listings, { on: ['id', 'seller_id'] }).select('id', 'name', 'active_listings.price'),
            },
            (q2) =>
              db.seller
                .join(q2.seller_totals, { on: ['id', 'id'], alias: 'st' })
                .where({ 'st.price': { gte: 400 } })
                .select('name', 'st.price')
                .orderBy('st.price', 'desc'),
          ),
      ),
      cte(
        {
          t2_listings: db.listing.where({ tenant_id: 't2' }).select('seller_id', 'title'),
        },
        (q) => db.seller.join(q.t2_listings, { on: ['id', 'seller_id'] }).select('name', 't2_listings.title'),
      ),
    ]);
    assert.equal(r1.length, 2);
    assert.equal(r1[0]!.name, 'Aurelia Goods');
    assert.deepEqual(r2, [{ name: 'Other Tenant', title: 'Tenant 2 Chair' }]);

    // 2. RowScope tenant isolation inside CTEs (tenant t1 NEVER sees tenant t2!)
    const scopedReads = await adapter.scopeReads!({
      seller: { groups: [[{ column: 'tenant_id', op: '=', value: 't1' }]] },
      listing: { groups: [[{ column: 'tenant_id', op: '=', value: 't1' }]] },
    });
    const scopedLoader = defineLoader({
      reads: ['seller', 'listing'],
      load: async ({ db: ldb, cte: lcte }) =>
        lcte(
          {
            stats: ldb.listing
              .where({ status: 'active' })
              .groupBy('seller_id')
              .aggregate({ n: count(), total: sum('price') }),
          },
          (q) =>
            ldb.seller
              .join(q.stats, { on: ['id', 'seller_id'] })
              .select('name', 'stats.n', 'stats.total')
              .orderBy('stats.total', 'desc'),
        ),
    });
    const loaderRows = (await runPageLoader({
      name: 'tenantScorecard',
      loader: scopedLoader,
      reader: scopedReads as never,
      schema,
      params: {},
      viewer: { account: 'u1', roles: ['member'] },
      now: new Date('2026-11-26T00:00:00Z'),
    })) as Array<Record<string, unknown>>;
    assert.equal(loaderRows.length, 2);
    assert.equal(
      loaderRows.some((r) => r.name === 'Other Tenant'),
      false,
      'Tenant t2 row must never leak through scoped CTE',
    );

    // 3. Column grant enforcement via cteFor
    const checks = resourceChecks(schema, {
      readable: new Set(['seller', 'listing']),
      writable: new Set(),
      fields: new Map([
        ['seller', { read: new Set(['id', 'name', 'city']), write: new Set() }],
        ['listing', { read: new Set(['id', 'seller_id', 'price']), write: new Set() }],
      ]),
    });
    assert.throws(
      () =>
        checks.cteFor({
          with: [],
          query: {
            from: 'seller',
            select: [
              { column: 'id', alias: 'id' },
              { column: 'secret_notes', alias: 'secret_notes' },
            ],
          },
        }),
      { name: 'AppAccessDenied' },
    );
    assert.doesNotThrow(() =>
      checks.cteFor({
        with: [
          {
            name: 's',
            from: 'listing',
            by: [{ column: 'seller_id', name: 'seller_id' }],
            measures: [{ name: 'total', fn: 'sum', column: 'price' }],
          },
        ],
        query: {
          from: 'seller',
          joins: [{ target: 's', on: ['id', 'seller_id'], kind: 'left' }],
          select: [
            { column: 'name', alias: 'name' },
            { column: 's.total', alias: 'total' },
          ],
        },
      }),
    );

    await adapter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Layer 2 declarative derived CTE resources + HTTP /api/view/run parent & child includes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-derived-http-'));
  const dbPath = join(dir, 'market.db');
  seedMarketDb(dbPath);
  const connection = 'market-db';
  const appId = 'market';

  const manifest = parseAppConfig(
    {
      id: appId,
      name: 'Market',
      connection,
      resources: { seller: {}, listing: {}, listing_photo: {} },
      derived: [
        defineQuery('seller_scorecard', {
          with: {
            live_stats: {
              from: 'listing',
              where: 'tenant_id = t1 and status = active',
              groupBy: ['seller_id'],
              measures: {
                live_count: { fn: 'count' },
                catalog_value: { fn: 'sum', column: 'price' },
              },
            },
          },
          from: 'seller',
          where: 'tenant_id = t1',
          join: [{ target: 'live_stats', on: ['id', 'seller_id'], kind: 'left' }],
          select: {
            id: 'id',
            name: 'name',
            city: 'city',
            live_count: 'live_stats.live_count',
            catalog_value: 'live_stats.catalog_value',
          },
        }),
      ],
      auth: {
        providers: ['email'],
        defaultRole: 'restricted',
        roles: {
          analyst: { read: ['seller', 'listing', 'listing_photo'] },
          restricted: { read: ['seller', 'listing'] }, // cannot read listing_photo
          seller_only: { read: ['seller'] }, // cannot read listing -> seller_scorecard hidden
        },
      },
      views: {
        scorecard: { kind: 'list', from: 'seller_scorecard', label: 'Scorecard', show: ['name', 'city', 'live_count', 'catalog_value'] },
        listings: { kind: 'list', from: 'listing', label: 'Listings', show: ['title', 'price'] },
      },
      home: 'scorecard',
      nav: ['scorecard', 'listings'],
    },
    'derived fixture',
  );

  const sessions: Record<string, Identity> = {
    analyst: { id: 'u-analyst', who: 'analyst@example.test', role: 'analyst' },
    restricted: { id: 'u-restricted', who: 'restricted@example.test', role: 'restricted' },
    seller_only: { id: 'u-seller', who: 'seller@example.test', role: 'seller_only' },
  };

  const registry = new Registry();
  registry.add({ id: connection, name: 'Market', url: dbPath, source: 'config' });

  // 1. Validate startup checks, grant pruning, and mistri-schema.d.ts typegen
  const rawAdapter = new SqliteAdapter(dbPath);
  const rawSchema = await rawAdapter.introspect();
  assert.deepEqual(derivedProblems(manifest, rawSchema), []);
  assert.deepEqual(appProblems({ path: '/market/app.ts', app: manifest, pages: [], sources: {} }, rawSchema), []);
  const fullCatalog = appCatalog(manifest, rawSchema);
  const derivedMeta = fullCatalog.tables.find((t) => t.id === 'seller_scorecard');
  assert.ok(derivedMeta?.derived, 'withDerived adds virtual read-only TableMeta');
  assert.equal(derivedMeta.isView, true);
  const generatedDts = typesForSchema(fullCatalog, 'market-db');
  assert.match(generatedDts, /seller_scorecard/);
  assert.match(generatedDts, /catalog_value/);

  // Pruned schema without `listing` omits `seller_scorecard`
  const sellerOnlySchema = { ...rawSchema, tables: rawSchema.tables.filter((t) => t.id === 'seller') };
  const pruned = withDerived(manifest, sellerOnlySchema);
  assert.equal(
    pruned.tables.some((t) => t.id === 'seller_scorecard'),
    false,
    'derived table must be omitted when a referenced base table is ungranted',
  );

  // Invalid derived query is caught by derivedProblems
  const badManifest = parseAppConfig(
    {
      id: appId,
      name: 'Market',
      connection,
      resources: { seller: {}, listing: {} },
      derived: [defineQuery('broken_q', { from: 'nonexistent', select: { id: 'id' } })],
      views: { listings: { kind: 'list', from: 'listing', label: 'Listings', show: ['title'] } },
      home: 'listings',
      nav: ['listings'],
    },
    'bad derived',
  );
  assert.ok(derivedProblems(badManifest, rawSchema).some((p) => /not one of the App's resources/.test(p)));
  await rawAdapter.close();

  // 2. Full HTTP server tests
  const host: AppHost = {
    app: { path: '/market/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: '/market/sessions.db',
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const base = `http://${bound.host}:${port}`;

  try {
    // 2a. Query derived CTE resource via /api/view/run (filter, sort, pagination)
    const viewRes = await fetch(`${base}/api/view/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=analyst' },
      body: JSON.stringify({
        app: appId,
        view: {
          id: 'test-scorecard',
          name: 'Scorecard',
          base: 'seller_scorecard',
          columns: [{ path: 'name' }, { path: 'city' }, { path: 'live_count' }, { path: 'catalog_value' }],
          orderBy: [{ path: 'catalog_value', direction: 'desc' }],
          limit: 10,
        },
        count: 'exact',
      }),
    });
    assert.equal(viewRes.status, 200);
    const viewJson = (await viewRes.json()) as { rows: Array<Record<string, unknown>>; total: number };
    assert.equal(viewJson.total, 3);
    assert.equal(viewJson.rows[0]!.name, 'Zelda Studio');
    assert.equal(Number(viewJson.rows[0]!.live_count), 2);
    assert.equal(Number(viewJson.rows[0]!.catalog_value), 700);

    // Filtered derived CTE resource
    const filteredRes = await fetch(`${base}/api/view/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=analyst' },
      body: JSON.stringify({
        app: appId,
        view: {
          id: 'test-scorecard-filtered',
          name: 'Scorecard',
          base: 'seller_scorecard',
          columns: [{ path: 'name' }, { path: 'catalog_value' }],
          filter: { groups: [[{ path: 'city', op: '=', value: 'Seattle' }]] },
          limit: 10,
        },
        count: 'exact',
      }),
    });
    assert.equal(filteredRes.status, 200);
    const filteredJson = (await filteredRes.json()) as { rows: Array<Record<string, unknown>>; total: number };
    assert.equal(filteredJson.total, 1);
    assert.equal(filteredJson.rows[0]!.name, 'Aurelia Goods');

    // Role lacking `listing` grant cannot query `seller_scorecard`
    const deniedDerivedRes = await fetch(`${base}/api/view/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=seller_only' },
      body: JSON.stringify({
        app: appId,
        view: {
          id: 'denied-scorecard',
          name: 'Scorecard',
          base: 'seller_scorecard',
          columns: [{ path: 'name' }],
          limit: 10,
        },
      }),
    });
    assert.ok(deniedDerivedRes.status === 400 || deniedDerivedRes.status === 403 || deniedDerivedRes.status === 404);

    // 2b. Single-round-trip /api/view/run with parent FK join + bounded child `include`
    const incRes = await fetch(`${base}/api/view/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=analyst' },
      body: JSON.stringify({
        app: appId,
        view: {
          id: 'listings-with-includes',
          name: 'Listings',
          base: 'listing',
          columns: [{ path: 'id' }, { path: 'title' }, { path: 'seller_id' }, { path: 'seller_id.name' }, { path: 'seller_id.city' }],
          filter: {
            groups: [
              [
                { path: 'tenant_id', op: '=', value: 't1' },
                { path: 'status', op: '=', value: 'active' },
              ],
            ],
          },
          orderBy: [{ path: 'id', direction: 'asc' }],
          limit: 10,
        },
        include: {
          listing_photo: { by: 'listing_id', show: ['url', 'sort_order'], sort: 'sort_order asc', limit: 2 },
        },
      }),
    });
    assert.equal(incRes.status, 200);
    const incJson = (await incRes.json()) as {
      rows: Array<Record<string, unknown>>;
      included?: Record<string, { rowsByParent: Record<string, Array<Record<string, unknown>>> }>;
    };
    assert.equal(incJson.rows.length, 4);
    assert.ok(incJson.included?.listing_photo);
    assert.deepEqual(
      incJson.included!.listing_photo.rowsByParent['10']?.map((p) => p.url),
      ['/lamp-1.jpg', '/lamp-2.jpg'],
    );
    assert.deepEqual(
      incJson.included!.listing_photo.rowsByParent['13']?.map((p) => p.url),
      ['/tt-1.jpg'],
    );
    assert.equal(incJson.included!.listing_photo.rowsByParent['14'], undefined);

    // 2c. Role lacking `listing_photo` grant is refused when requesting child include on `listing_photo`
    const deniedChildRes = await fetch(`${base}/api/view/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=restricted' },
      body: JSON.stringify({
        app: appId,
        view: {
          id: 'listings-denied-child',
          name: 'Listings',
          base: 'listing',
          columns: [{ path: 'id' }, { path: 'title' }],
          limit: 10,
        },
        include: {
          listing_photo: { by: 'listing_id', show: ['url'], limit: 2 },
        },
      }),
    });
    assert.ok(deniedChildRes.status === 400 || deniedChildRes.status === 403);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('viewInclude (#585): /api/view/run defers lastWave() until the final child include read so fenced snapshots never overrun', async () => {
  const { dispatchResourceReadHttp } = await import('../packages/engine/src/server/resourceReadHttp.js');
  const dir = mkdtempSync(join(tmpdir(), 'mistri-view-include-lastwave-'));
  const dbPath = join(dir, 'market.db');
  seedMarketDb(dbPath);
  const adapter = new SqliteAdapter(dbPath);
  try {
    const schema = await adapter.introspect();
    const run = async (body: Record<string, unknown>) => {
      let closing = false;
      let closed = false;
      let overran = false;
      let lastWaveCalls = 0;
      const events: string[] = [];
      const tracked = Object.create(adapter) as typeof adapter;
      tracked.runView = async (view, offset) => {
        if (closed) overran = true;
        events.push(`runView:${view.base}`);
        // Mirrors tenantReadSource.ts ride(): after lastWave(), the first query sent in that wave
        // schedules the release fence via setImmediate, closing the snapshot once that turn completes.
        if (closing && !closed) {
          setImmediate(() => {
            closed = true;
          });
        }
        const res = await adapter.runView(view, offset);
        // Yield a macrotask so any scheduled setImmediate fires before the next sequential wave.
        await new Promise((resolve) => setImmediate(resolve));
        return res;
      };
      const reply = await dispatchResourceReadHttp('/api/view/run', body, tracked, schema, {
        app: undefined,
        now: () => new Date('2026-11-27T00:00:00Z'),
        lastWave: () => {
          lastWaveCalls += 1;
          events.push('lastWave');
          closing = true;
        },
      });
      return { reply, events, overran, lastWaveCalls };
    };

    // 1. Without includes: lastWave fires before the single parent readView.
    const plain = await run({
      count: 'none',
      view: { id: 'v1', name: 'Listings', base: 'listing', columns: [{ path: 'id' }, { path: 'title' }], limit: 5 },
    });
    assert.equal(plain.reply?.status, 200);
    assert.equal(plain.overran, false);
    assert.deepEqual(plain.events, ['lastWave', 'runView:listing']);

    // 2. With child includes (non-empty parent): lastWave does NOT fire before parent readView;
    //    it fires right before the final child readView, with zero queries after.
    const withTwo = await run({
      count: 'none',
      view: { id: 'v2', name: 'Listings', base: 'listing', columns: [{ path: 'id' }, { path: 'title' }], limit: 5 },
      include: {
        photos: { from: 'listing_photo', by: 'listing_id', show: ['url'], limit: 2 },
        tags: { from: 'tag_assignment', by: 'listing_id', show: ['tag'], limit: 2 },
      },
    });
    assert.equal(withTwo.reply?.status, 200);
    assert.equal(withTwo.overran, false);
    assert.equal(withTwo.lastWaveCalls, 1);
    assert.deepEqual(withTwo.events, ['runView:listing', 'runView:listing_photo', 'lastWave', 'runView:tag_assignment']);

    // 3. With child includes and empty parent result: no child readView runs and no overrun.
    const emptyParent = await run({
      count: 'none',
      view: {
        id: 'v3',
        name: 'Listings',
        base: 'listing',
        columns: [{ path: 'id' }, { path: 'title' }],
        filter: { groups: [[{ path: 'status', op: '=', value: 'nonexistent' }]] },
        limit: 5,
      },
      include: {
        photos: { from: 'listing_photo', by: 'listing_id', show: ['url'], limit: 2 },
      },
    });
    assert.equal(emptyParent.reply?.status, 200);
    assert.equal(emptyParent.overran, false);
    assert.deepEqual(emptyParent.events, ['runView:listing']);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
