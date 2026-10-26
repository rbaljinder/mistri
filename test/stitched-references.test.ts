/**
 * Stitched references: a declared reference whose target is in another
 * source, on another connection (`stock_move.product_sku` →
 * `catalog.product.sku`). Read in two steps, the list and one batched read
 * of the keys a page names through the target source's own reads: the grid
 * label, a link that opens the target by its primary key, and a related list
 * on the target. What would need the targets inside the first statement is
 * refused, at load where the App says it and per request where a request
 * does; the target's grants, hidden columns and row policy hold in the
 * second step, and the edge is never write authority.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { appProblems } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import type { ViewResult } from '../packages/engine/src/adapters/adapter.js';
import { MAX_STITCHED_KEYS, runStitchedView } from '../packages/mistri/src/server/app/appStitchedReads.js';
import { LIVE_PG, ownedPostgresDatabase, pgControl } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';

const OPS = `CREATE TABLE stock_move (id INTEGER PRIMARY KEY, product_sku TEXT, qty INTEGER NOT NULL, bin_code TEXT);
  CREATE TABLE bin (code TEXT PRIMARY KEY, zone TEXT NOT NULL);
  INSERT INTO stock_move VALUES (1, 'LNT-01', 5, 'A1'), (2, 'LNT-01', -2, 'A1'), (3, 'STV-02', 7, 'B2'), (4, 'GONE-9', 1, 'Z9'), (5, NULL, 3, NULL), (6, 'VLT-07', 1, 'Z9');
  INSERT INTO bin VALUES ('A1', 'Aisle one'), ('B2', 'Back two'), ('Z9', 'VAULT_ZONE');`;
const CATALOG = `CREATE TABLE product (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, cost INTEGER, secret TEXT, bin TEXT);
  INSERT INTO product VALUES (1, 'LNT-01', 'Lantern', 12, 'LANTERN_SECRET', 'A1'), (2, 'STV-02', 'Stove', 40, 'STOVE_SECRET', 'A1'),
    (3, 'VLT-07', 'Vault', 99, 'VAULT_SECRET', 'Z9');`;

const app = (more: Record<string, unknown> = {}, resources: Record<string, unknown> = {}) => ({
  id: 'depot-stitch',
  name: 'Depot stitch',
  sources: { ops: { connection: 'ops', default: true }, catalog: { connection: 'catalog' } },
  resources: {
    'catalog.product': { recordLabel: '{name} ({sku})', access: 'write' },
    stock_move: { access: 'write', references: { product_sku: { to: 'catalog.product', column: 'sku' } } },
    ...resources,
  },
  views: {
    moves: { kind: 'list', from: 'stock_move', label: 'Moves' },
    products: { kind: 'list', from: 'catalog.product', label: 'Products' },
  },
  home: 'moves',
  nav: ['moves', 'products'],
  ...more,
});

type Answer = { status: number; text: string; body: any };
type Call = (path: string, body?: object) => Promise<Answer>;

/** The two databases: SQLite files, or the catalog in PostgreSQL where `catalogUrl` names one. */
function databases(catalogUrl?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-stitch-'));
  const registry = new Registry();
  for (const [id, sql] of [['ops', OPS], ...(catalogUrl ? [] : [['catalog', CATALOG]])] as const) {
    const file = join(directory, `${id}.db`);
    const db = new DatabaseSync(file);
    db.exec(sql);
    db.close();
    registry.add({ id, name: id, url: file, source: 'config', writable: true });
  }
  if (catalogUrl) registry.add({ id: 'catalog', name: 'catalog', url: catalogUrl, source: 'config', writable: true });
  return { directory, registry };
}

async function serve(definition: Record<string, unknown>, run: (call: Call) => Promise<void>, role = 'clerk', catalogUrl?: string) {
  const { directory, registry } = databases(catalogUrl);
  const parsed = parseAppConfig(definition, 'stitched fixture');
  const pages = parsePagesConfig(
    { pages: [{ label: 'Product', base: 'catalog.product', sections: [{ kind: 'fields', show: ['name'] }] }] },
    'stitch pages',
  );
  const hosts: AppHost[] = [
    {
      app: { path: 'stitch.ts', app: parsed, pages, sources: {} },
      pages,
      ...(parsed.auth
        ? {
            auth: {
              spec: parsed.auth,
              store: 'unused',
              handler: async () => {},
              close: async () => {},
              session: async () => ({ id: 'person', who: 'person@example.test', role }),
            },
          }
        : {}),
    },
  ];
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(async (path, body) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}${path.includes('?') ? '&' : '?'}app=${parsed.id}`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify({ app: parsed.id, ...body }) } : {}),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, text, body: json };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('ops');
    clearJournal('catalog');
    rmSync(directory, { recursive: true, force: true });
  }
}

const ok = (answer: Answer, what: string) => {
  assert.equal(answer.status, 200, `${what}: ${answer.text.slice(0, 400)}`);
  assert.ok(!answer.body?.errors?.length, `${what}: ${answer.text.slice(0, 400)}`);
  return answer.body;
};
const refused = (answer: Answer, what: string, pattern?: RegExp) => {
  assert.ok(answer.status >= 400 || answer.body?.errors?.length, `${what}: ${answer.status} ${answer.text.slice(0, 300)}`);
  if (pattern) assert.match(answer.text, pattern, what);
};
const labels = (body: any, column: string) => body.rows.map((row: Record<string, unknown>) => [row.id, row[column]]);

test('a reference into another source labels the list from the target, in two reads', async () => {
  await serve(app(), async (call) => {
    const schema = ok(await call('/api/schema'), 'schema');
    const move = schema.tables.find((table: { id: string }) => table.id === 'stock_move');
    assert.deepEqual(move.columns.find((column: { name: string }) => column.name === 'product_sku').references, {
      table: 'catalog.product',
      column: 'sku',
    });
    assert.ok(schema.foreignKeys.some((fk: { stitched?: boolean }) => fk.stitched));

    const walked = ok(await call('/api/run', { q: 'stock_move show id, qty, product_sku.name, product_sku.$label sort id' }), 'walk');
    assert.deepEqual(
      labels(walked, 'product_sku.name'),
      [
        [1, 'Lantern'],
        [2, 'Lantern'],
        [3, 'Stove'],
        [4, null],
        [5, null],
        [6, 'Vault'],
      ],
      'a key nothing matches, and no key, read as a LEFT JOIN null; no row is multiplied or lost',
    );
    assert.deepEqual(
      walked.rows.slice(0, 3).map((row: Record<string, unknown>) => row['product_sku.$label']),
      ['Lantern (LNT-01)', 'Lantern (LNT-01)', 'Stove (STV-02)'],
      "the target's own recordLabel names it",
    );
    assert.deepEqual(walked.columns, ['id', 'qty', 'product_sku.name', 'product_sku.$label'], 'only what was asked for comes back');
    const resolved = walked.resolved.find((column: { path: string }) => column.path === 'product_sku.name');
    assert.equal(resolved.table, 'catalog.product');
    assert.equal(resolved.hops, 1);
  });
});

test('the link opens the target by its primary key, and the target lists the rows that name it', async () => {
  await serve(app(), async (call) => {
    const found = ok(
      await call('/api/query', {
        table: 'catalog.product',
        columns: ['id'],
        filter: { groups: [[{ column: 'sku', op: '=', value: 'STV-02' }]] },
        limit: 1,
        offset: 0,
      }),
      'the key a link opens',
    );
    assert.deepEqual(found.rows, [{ id: 2 }]);
    const [page] = parsePagesConfig(
      {
        pages: [
          {
            label: 'Product moves',
            base: 'catalog.product',
            sections: [{ kind: 'list', from: 'stock_move', whose: 'product_sku', show: ['id', 'qty'] }],
          },
        ],
      },
      'related list',
    );
    const plan = ok(await call('/api/pages/plan', { key: { id: 1 }, page }), 'plan');
    const [section] = plan.plans;
    const listed = ok(await call('/api/view/run', { view: section.view }), 'related list');
    assert.deepEqual(listed.rows.map((row: { id: number }) => row.id).sort(), [1, 2]);
    const none = ok(await call('/api/pages/plan', { key: { id: 404 }, page }), 'plan of a missing root');
    assert.deepEqual(ok(await call('/api/view/run', { view: none.plans[0].view }), 'no root').rows, []);
  });
});

test('what needs the targets inside the first statement is refused, saying why', async () => {
  await serve(app(), async (call) => {
    refused(await call('/api/run', { q: 'stock_move product_sku.name = Stove show id' }), 'far filter', /another connection/);
    refused(await call('/api/run', { q: 'stock_move show id sort product_sku.cost desc' }), 'far sort', /another connection/);
    refused(await call('/api/breakdown', { text: 'stock_move count by product_sku.name' }), 'far group', /another connection/);
    ok(await call('/api/run', { q: 'stock_move product_sku = LNT-01 show id, product_sku.name' }), 'the local key filters as a column');
  });
});

test('what a stitched reference cannot carry is refused when the App loads, saying why', async () => {
  const { directory, registry } = databases();
  const load = async (definition: Record<string, unknown>) => {
    const parsed = parseAppConfig(definition, 'stitched load');
    const runtime = await loadAppRuntimeResources(registry, parsed, 'ops');
    return appProblems({ path: join(directory, 'app.ts'), app: parsed, pages: [], sources: {} }, runtime.schema);
  };
  try {
    const clean = await load(app());
    assert.deepEqual(clean, []);
    const rollup = await load(app({}, { 'catalog.product': { rollups: { moves: { fn: 'count', from: 'stock_move' } } } }));
    assert.ok(
      rollup.some((line) => /rollup counts rows in the same database/.test(line)),
      rollup.join('\n'),
    );
    const listed = await load(
      app(
        {
          views: {
            moves: { kind: 'list', from: 'stock_move', query: 'product_sku.cost > 10' },
            sorted: { kind: 'list', from: 'stock_move', sort: 'product_sku.name' },
            tabbed: { kind: 'list', from: 'stock_move', tabs: ['pricey'] },
            products: { kind: 'list', from: 'catalog.product' },
          },
        },
        {
          stock_move: {
            access: 'write',
            references: { product_sku: { to: 'catalog.product', column: 'sku' } },
            segments: { pricey: 'product_sku.cost > 10' },
          },
        },
      ),
    );
    for (const view of ['moves', 'sorted', 'tabbed']) {
      assert.ok(
        listed.some((line) => line.includes(`view "${view}"`) && /another connection/.test(line)),
        `${view}: ${listed.join('\n')}`,
      );
    }
    const noticed = await load(
      app(
        { auth: { roles: { clerk: { read: true, write: true } } } },
        {
          stock_move: {
            access: 'write',
            references: { product_sku: { to: 'catalog.product', column: 'sku' } },
            notify: [{ on: 'insert', to: ['product_sku.bin'], title: 'Moved {product_sku.name}' }],
          },
        },
      ),
    );
    assert.ok(
      noticed.some((line) => /in another source/.test(line) && /notify/.test(line)),
      noticed.join('\n'),
    );
    const named = await load(
      app(
        {},
        {
          stock_move: { recordLabel: '{qty} of {product_sku.name}', references: { product_sku: { to: 'catalog.product', column: 'sku' } } },
        },
      ),
    );
    assert.ok(
      named.some((line) => /recordLabel/.test(line) && /read in its own database/.test(line)),
      named.join('\n'),
    );
    await assert.rejects(
      load(app({}, { stock_move: { references: { product_sku: { to: 'catalog.product', column: 'bin' } } } })),
      /not proven unique/,
    );
    await assert.rejects(
      load(app({}, { stock_move: { references: { qty: { to: 'catalog.product', column: 'sku' } } } })),
      /like with like/,
    );
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a stitched label never shows what the reader cannot read of the target: its grants, its hidden columns', async () => {
  const roles = { auth: { roles: { clerk: { read: ['stock_move'] }, manager: { read: true, write: true } } } };
  await serve(
    app(roles),
    async (call) => {
      const schema = ok(await call('/api/schema'), 'schema');
      const move = schema.tables.find((table: { id: string }) => table.id === 'stock_move');
      assert.equal(
        move.columns.find((column: { name: string }) => column.name === 'product_sku').references,
        undefined,
        'the edge goes with the unreadable target',
      );
      assert.ok(!schema.foreignKeys.some((fk: { stitched?: boolean }) => fk.stitched));
      for (const q of ['stock_move show id, product_sku.name', 'stock_move show id, product_sku.$label']) {
        const answer = await call('/api/run', { q });
        refused(answer, q);
        assert.doesNotMatch(answer.text, /Lantern|Stove|SECRET/);
      }
    },
    'clerk',
  );
  await serve(app({}, { 'catalog.product': { recordLabel: '{name} {secret}', hidden: ['secret'] } }), async (call) => {
    const answer = await call('/api/run', { q: 'stock_move show id, product_sku.secret' });
    refused(answer, 'a hidden target column');
    assert.doesNotMatch(answer.text, /SECRET/);
    const labelled = await call('/api/run', { q: 'stock_move show id, product_sku.name, product_sku.$label sort id' });
    assert.doesNotMatch(labelled.text, /SECRET/, 'a label naming a hidden column never reads it');
  });
});

test("a reference a request carries is replaced by the App's own, and the edge is never write authority", async () => {
  await serve(
    app({}, { 'catalog.product': { recordLabel: '{name}', hidden: ['secret'], access: 'write', delete: true } }),
    async (call) => {
      const forged = await call('/api/view/run', {
        view: {
          id: 'forged',
          name: 'Forged',
          base: 'stock_move',
          columns: [{ path: 'id' }, { path: 'product_sku.secret' }],
          references: [
            {
              name: 'forged',
              from: { table: 'stock_move', columns: ['product_sku'] },
              to: { table: 'catalog.product', columns: ['sku'] },
              stitched: true,
              declared: true,
            },
          ],
        },
      });
      refused(forged, 'a request-supplied edge to a hidden column');
      assert.doesNotMatch(forged.text, /SECRET/);
      const relabelled = await call('/api/view/run', {
        view: {
          id: 'relabel',
          name: 'Relabel',
          base: 'stock_move',
          columns: [{ path: 'id' }, { path: 'product_sku.$label' }],
          labels: { product_sku: '{secret}' },
        },
      });
      assert.doesNotMatch(relabelled.text, /SECRET/, "a request's label template is replaced by the catalog's");
    },
  );
  await serve(app({}, { 'catalog.product': { recordLabel: '{name}', access: 'write', delete: true } }), async (call) => {
    /* A product that moves name is deleted as its own database allows: nothing in the other one holds it. */
    const deleted = ok(await call('/api/delete', { table: 'catalog.product', key: { id: 2 }, confirm: true }), 'delete a named target');
    assert.ok(deleted);
    const left = ok(await call('/api/run', { q: 'stock_move show id, product_sku.name sort id' }), 'after');
    assert.deepEqual(
      labels(left, 'product_sku.name').map(([, name]: [number, unknown]) => name),
      ['Lantern', 'Lantern', null, null, null, 'Vault'],
    );
  });
  /* Writing the column that names a product is a write of the move alone: it grants nothing on the product. */
  const roles = { auth: { roles: { clerk: { read: ['stock_move', 'catalog.product'], write: ['stock_move'] } } } };
  await serve(
    app(roles),
    async (call) => {
      ok(await call('/api/update', { table: 'stock_move', key: { id: 5 }, values: { product_sku: 'VLT-07' } }), 'write the key');
      refused(
        await call('/api/update', { table: 'catalog.product', key: { id: 3 }, values: { name: 'Mine' } }),
        'write through the reference',
      );
      refused(await call('/api/delete', { table: 'catalog.product', key: { id: 3 }, confirm: true }), 'delete through the reference');
      const after = ok(await call('/api/run', { q: 'stock_move show id, product_sku.name sort id' }), 'after');
      assert.equal(after.rows.find((row: { id: number }) => row.id === 5)['product_sku.name'], 'Vault');
    },
    'clerk',
  );
});

/* ---------- under a row policy ---------- */

async function servePolicy(definition: Record<string, unknown>, rows: string, run: (call: Call) => Promise<void>) {
  const { directory, registry } = databases();
  const parsed = parseAppConfig(definition, 'stitched policy fixture');
  const pages = parsePagesConfig(
    { pages: [{ label: 'Product', base: 'catalog.product', sections: [{ kind: 'fields', show: ['name'] }] }] },
    'stitch pages',
  );
  const file = join(directory, 'policy.mjs');
  writeFileSync(file, `export default { appId: ${JSON.stringify(parsed.id)}, resolveRows() { return ${rows}; } };`);
  const identity = { id: 'clerk-one', who: 'clerk@example.test', role: 'clerk' };
  const policy = await loadHttpAppPolicy({ app: parsed, registry, file, verifySession: async () => identity });
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app: parsed, pages, sources: {} },
    pages,
    auth: {
      spec: parsed.auth!,
      store: join(directory, 'sessions.db'),
      close: async () => {},
      session: async () => identity,
      handler: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, apps: [host], policy, pages, bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(async (path, body) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}${path.includes('?') ? '&' : '?'}app=${parsed.id}`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify({ app: parsed.id, ...body }) } : {}),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, text, body: json };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await policy.retire();
    await registry.closeAll();
    clearJournal('ops');
    clearJournal('catalog');
    rmSync(directory, { recursive: true, force: true });
  }
}

const POLICY = { auth: { rows: 'policy', roles: { clerk: { read: true } } } };
/* The clerk sees every move, and only the products outside bin Z9. */
const SCOPED = `{ stock_move: true, 'catalog.product': { groups: [[{ column: 'bin', op: '!=', value: 'Z9' }]] } }`;

test("under a row policy a stitched label is read through the target's own scope: a hidden row is a null", async () => {
  await servePolicy(
    app(POLICY, {
      'catalog.product': { recordLabel: '{name} ({sku})' },
      stock_move: {
        references: { product_sku: { to: 'catalog.product', column: 'sku' } },
      },
    }),
    SCOPED,
    async (call) => {
      const walked = ok(await call('/api/run', { q: 'stock_move show id, product_sku.name, product_sku.$label sort id' }), 'walk');
      assert.deepEqual(labels(walked, 'product_sku.name'), [
        [1, 'Lantern'],
        [2, 'Lantern'],
        [3, 'Stove'],
        [4, null],
        [5, null],
        [6, null],
      ]);
      assert.doesNotMatch(JSON.stringify(walked), /Vault|VLT-07 \(|VAULT/, 'the row the policy hides is never named');
      refused(await call('/api/run', { q: 'stock_move product_sku.name = Vault show id' }), 'probing by a far filter');
    },
  );
});

test("under a row policy a reference within one source joins through the target's scope", async () => {
  const rows = `{ stock_move: true, bin: { groups: [[{ column: 'code', op: '!=', value: 'Z9' }]] }, 'catalog.product': true }`;
  await servePolicy(
    app(POLICY, {
      bin: { recordLabel: '{zone}' },
      stock_move: {
        references: { product_sku: { to: 'catalog.product', column: 'sku' }, bin_code: { to: 'bin' } },
      },
    }),
    rows,
    async (call) => {
      const walked = ok(
        await call('/api/run', { q: 'stock_move show id, bin_code.zone, bin_code.$label, product_sku.name sort id' }),
        'walk',
      );
      assert.deepEqual(labels(walked, 'bin_code.zone'), [
        [1, 'Aisle one'],
        [2, 'Aisle one'],
        [3, 'Back two'],
        [4, null],
        [5, null],
        [6, null],
      ]);
      assert.deepEqual(
        labels(walked, 'product_sku.name').map(([, name]: [number, unknown]) => name),
        ['Lantern', 'Lantern', 'Stove', null, null, 'Vault'],
      );
      assert.doesNotMatch(JSON.stringify(walked), /VAULT_ZONE/);
      const probed = ok(await call('/api/run', { q: 'stock_move bin_code.zone = VAULT_ZONE show id' }), 'probe by a joined filter');
      assert.deepEqual(probed.rows, [], 'a filter through the edge sees only the rows the policy shows');
      const grouped = ok(await call('/api/breakdown', { text: 'stock_move count by bin_code.zone' }), 'group by the joined edge');
      assert.doesNotMatch(JSON.stringify(grouped), /VAULT_ZONE/);
    },
  );
});

describe('a stitched reference from SQLite into PostgreSQL', { skip: liveSkip('postgres', LIVE_PG) }, () => {
  test('labels, the link and the related list read across the two engines', { timeout: 30_000 }, async () => {
    const url = await ownedPostgresDatabase();
    const control = await pgControl(url);
    try {
      await control.query(`DROP TABLE IF EXISTS product; CREATE TABLE product (id int PRIMARY KEY, sku text NOT NULL UNIQUE, name text NOT NULL,
        cost int, secret text, bin text);
        INSERT INTO product VALUES (1, 'LNT-01', 'Lantern', 12, 'LANTERN_SECRET', 'A1'), (2, 'STV-02', 'Stove', 40, 'STOVE_SECRET', 'A1'),
          (3, 'VLT-07', 'Vault', 99, 'VAULT_SECRET', 'Z9');`);
    } finally {
      await control.end();
    }
    await serve(
      app(),
      async (call) => {
        const walked = ok(await call('/api/run', { q: 'stock_move show id, product_sku.name, product_sku.$label sort id' }), 'walk');
        assert.deepEqual(labels(walked, 'product_sku.name'), [
          [1, 'Lantern'],
          [2, 'Lantern'],
          [3, 'Stove'],
          [4, null],
          [5, null],
          [6, 'Vault'],
        ]);
        assert.equal(walked.rows[0]['product_sku.$label'], 'Lantern (LNT-01)');
        const [page] = parsePagesConfig(
          {
            pages: [
              {
                label: 'Product moves',
                base: 'catalog.product',
                sections: [{ kind: 'list', from: 'stock_move', whose: 'product_sku', show: ['id'] }],
              },
            ],
          },
          'related list',
        );
        const plan = ok(await call('/api/pages/plan', { key: { id: 2 }, page }), 'plan');
        assert.deepEqual(
          ok(await call('/api/view/run', { view: plan.plans[0].view }), 'related').rows.map((row: { id: number }) => row.id),
          [3],
        );
        refused(await call('/api/run', { q: 'stock_move product_sku.cost > 10 show id' }), 'far filter', /another connection/);
      },
      'clerk',
      url,
    );
  });
});

test('a key the target holds twice gives no label, and a page naming too many keys is refused', async () => {
  const column = (name: string, type = 'text', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const schema: DatabaseSchema = {
    label: 'fixture',
    dialect: 'sqlite',
    readAt: '',
    tables: [
      {
        id: 'stock_move',
        name: 'stock_move',
        schema: '',
        isView: false,
        columns: [column('id', 'integer', true), { ...column('product_sku'), references: { table: 'catalog.product', column: 'sku' } }],
      },
      {
        id: 'catalog.product',
        name: 'catalog.product',
        schema: '',
        isView: false,
        columns: [column('id', 'integer', true), column('sku'), column('name')],
        unique: ['sku'],
      },
    ],
    foreignKeys: [
      {
        name: 'stock_move_product_sku_declared',
        from: { table: 'stock_move', columns: ['product_sku'] },
        to: { table: 'catalog.product', columns: ['sku'] },
        declared: true,
        stitched: true,
      },
    ],
  };
  const catalog = { schema, sourceOf: (resource: string) => (resource.includes('.') ? 'catalog' : 'ops') };
  const result = (rows: Array<Record<string, unknown>>, columns: string[]): ViewResult => ({
    columns,
    rows,
    ms: 0,
    sql: { text: '', params: [] },
    resolved: columns.map((name) => ({
      path: name,
      name,
      table: '',
      column: name,
      type: 'text',
      nullable: true,
      primaryKey: false,
      hops: 0,
    })),
    joins: [],
  });
  const view: ViewDef = { id: 'moves', name: 'Moves', base: 'stock_move', columns: [{ path: 'id' }, { path: 'product_sku.name' }] };
  const asked: ViewDef[] = [];
  const stitched = await runStitchedView(
    catalog,
    view,
    0,
    async (local) =>
      result(
        [
          { id: 1, product_sku: 'A' },
          { id: 2, product_sku: 'B' },
        ],
        local.columns.map((each) => each.path),
      ),
    () => async (far) => {
      asked.push(far);
      return result(
        [
          { sku: 'A', name: 'One' },
          { sku: 'B', name: 'Two' },
          { sku: 'B', name: 'Twin' },
        ],
        ['sku', 'name'],
      );
    },
  );
  assert.deepEqual(stitched.rows, [
    { id: 1, 'product_sku.name': 'One' },
    { id: 2, 'product_sku.name': null },
  ]);
  assert.equal(asked.length, 1, 'one read of the target for the whole page');
  assert.deepEqual(asked[0].filter, { groups: [[{ path: 'sku', op: 'in', value: ['A', 'B'] }]] });
  const many = Array.from({ length: MAX_STITCHED_KEYS + 1 }, (_, i) => ({ id: i, product_sku: `K-${i}` }));
  await assert.rejects(
    runStitchedView(
      catalog,
      view,
      0,
      async (local) =>
        result(
          many,
          local.columns.map((each) => each.path),
        ),
      () => async () => assert.fail('no second read past the bound'),
    ),
    /Show fewer rows/,
  );
});
