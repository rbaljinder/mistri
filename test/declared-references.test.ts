/**
 * Declared references: `references: { product_sku: { to: 'product', column:
 * 'sku' } }`, a text key the database holds no foreign key for, followed
 * like one within one source (stitched-references.test.ts holds the other). The label and the walk, the related list on
 * the target, a rollup over it; the target's grants and hidden columns still
 * apply, since the edge is compiled against the reader's pruned catalog; and
 * it is never authority for a write.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { withViewReferences } from '../packages/engine/src/shared/declaredReferences.js';
import type { DatabaseSchema, ForeignKey } from '../packages/engine/src/shared/schema.js';

const SCHEMA = `CREATE TABLE product (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, cost INTEGER, bin TEXT);
  CREATE TABLE stock_move (id INTEGER PRIMARY KEY, product_sku TEXT, qty INTEGER NOT NULL, bin_code TEXT, product_id INTEGER);
  INSERT INTO product VALUES (1, 'LNT-01', 'Lantern', 12, 'A1'), (2, 'STV-02', 'Stove', 40, 'A1');
  INSERT INTO stock_move VALUES (1, 'LNT-01', 5, 'A1', 1), (2, 'LNT-01', -2, 'A1', 1), (3, 'STV-02', 7, 'A1', 2), (4, 'GONE-9', 1, 'A1', NULL);`;

const base = (more: Record<string, unknown> = {}) => ({
  id: 'depot-refs',
  name: 'Depot refs',
  connection: 'refs',
  resources: {
    product: {
      recordLabel: '{name} ({sku})',
      access: 'write',
      delete: true,
      rollups: { moves: { fn: 'count', from: 'stock_move' }, moved: { fn: 'sum', from: 'stock_move', column: 'qty' } },
    },
    stock_move: { references: { product_sku: { to: 'product', column: 'sku' } } },
  },
  views: { moves: { kind: 'list', from: 'stock_move', label: 'Moves' }, products: { kind: 'list', from: 'product', label: 'Products' } },
  home: 'moves',
  nav: ['moves', 'products'],
  ...more,
});

type Call = (path: string, body?: object) => Promise<{ status: number; text: string; body: any }>;

async function serve(definition: Record<string, unknown> | undefined, run: (call: Call) => Promise<void>, role = 'clerk') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-refs-'));
  const file = join(directory, 'depot.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'refs', name: 'Refs', url: file, source: 'config', writable: true });
  const app = definition ? parseAppConfig(definition, 'references fixture') : undefined;
  const pages = parsePagesConfig(
    { pages: [{ label: 'Product', base: 'product', sections: [{ kind: 'fields', show: ['name'] }] }] },
    'refs pages',
  );
  const hosts: AppHost[] = app
    ? [
        {
          app: { path: 'refs.ts', app, pages, sources: {} },
          pages,
          ...(app.auth
            ? {
                auth: {
                  spec: app.auth,
                  store: 'unused',
                  handler: async () => {},
                  close: async () => {},
                  session: async () => ({ id: 'person', who: 'person@example.test', role }),
                },
              }
            : {}),
        },
      ]
    : [];
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages: app ? pages : [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(async (path, body) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(app ? { app: app.id, ...body } : body) } : {}),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { status: response.status, text, body: parsed };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('refs');
    rmSync(directory, { recursive: true, force: true });
  }
}

const refused = (answer: { status: number; body: any; text: string }, what: string) =>
  assert.ok(answer.status >= 400 || answer.body?.errors?.length, `${what}: ${answer.status} ${answer.text.slice(0, 300)}`);

test('a soft key is a reference in the served catalog: labels, walks, filters, sorts and rollups', async () => {
  await serve(base(), async (call) => {
    const schema = await call('/api/schema');
    const move = schema.body.tables.find((table: { id: string }) => table.id === 'stock_move');
    assert.deepEqual(move.columns.find((column: { name: string }) => column.name === 'product_sku').references, {
      table: 'product',
      column: 'sku',
    });
    assert.ok(
      schema.body.foreignKeys.some((fk: { declared?: boolean; to: { columns: string[] } }) => fk.declared && fk.to.columns[0] === 'sku'),
    );

    const walked = await call('/api/run', { q: 'stock_move show id, product_sku.name, product_sku.$label sort id' });
    assert.equal(walked.status, 200, walked.text);
    assert.ok(walked.body.rows, walked.text);
    assert.deepEqual(
      walked.body.rows.map((row: Record<string, unknown>) => [row.id, row['product_sku.name']]),
      [
        [1, 'Lantern'],
        [2, 'Lantern'],
        [3, 'Stove'],
        [4, null],
      ],
      'a value nothing matches reads as a LEFT JOIN null, and never multiplies the row',
    );
    assert.deepEqual(
      walked.body.rows.slice(0, 3).map((row: Record<string, unknown>) => row['product_sku.$label']),
      ['Lantern (LNT-01)', 'Lantern (LNT-01)', 'Stove (STV-02)'],
      "the target's own recordLabel names it",
    );
    const filtered = await call('/api/run', { q: 'stock_move product_sku.name = Stove show id' });
    assert.deepEqual(
      filtered.body.rows.map((row: { id: number }) => row.id),
      [3],
    );
    const sorted = await call('/api/run', { q: 'stock_move show id sort product_sku.cost desc, id' });
    assert.deepEqual(sorted.body.rows.map((row: { id: number }) => row.id).slice(0, 3), [3, 1, 2]);

    const rolled = await call('/api/run', { q: 'product show name, moves, moved sort id' });
    assert.equal(rolled.status, 200, rolled.text);
    assert.deepEqual(
      rolled.body.rows.map((row: Record<string, unknown>) => [row.name, row.moves, row.moved]),
      [
        ['Lantern', 2, 3],
        ['Stove', 1, 7],
      ],
    );

    const grouped = await call('/api/breakdown', { text: 'stock_move count by product_sku.name' });
    assert.equal(grouped.status, 200, grouped.text);
    assert.ok(
      grouped.body.rows.some((row: Record<string, unknown>) => Object.values(row).includes('Lantern')),
      grouped.text,
    );
  });
});

test('an App with named sources follows a reference within one', async () => {
  await serve({ ...base(), connection: undefined, sources: { ops: { connection: 'refs' } } }, async (call) => {
    const walked = await call('/api/run', { q: 'stock_move show id, product_sku.name sort id' });
    assert.equal(walked.status, 200, walked.text);
    assert.deepEqual(
      walked.body.rows?.map((row: Record<string, unknown>) => row['product_sku.name']),
      ['Lantern', 'Lantern', 'Stove', null],
      walked.text,
    );
  });
});

test('the target lists the rows that name it, found by its own key', async () => {
  await serve(base(), async (call) => {
    const [page] = parsePagesConfig(
      {
        pages: [
          {
            label: 'Product moves',
            base: 'product',
            sections: [{ kind: 'list', from: 'stock_move', whose: 'product_sku', show: ['id', 'qty'] }],
          },
        ],
      },
      'related list',
    );
    const plan = await call('/api/pages/plan', { key: { id: 1 }, page });
    assert.equal(plan.status, 200, plan.text);
    const [section] = plan.body.plans;
    assert.match(section.viewText, /product_sku\.id = 1/, 'the root is found by its own key, through the reference');
    const listed = await call('/api/view/run', { view: section.view });
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.rows.map((row: { id: number }) => row.id).sort(), [1, 2]);
  });
});

test("a record's references count a soft key by the column it points at, not by the record's key", async () => {
  /* The client asks by the record's key ({ id }); the reference is to sku,
     which the key does not carry, so the count reads the row for it. */
  await serve(base(), async (call) => {
    const answer = await call('/api/references', { table: 'product', key: { id: 1 } });
    assert.equal(answer.status, 200, answer.text);
    const soft = answer.body.references.find(
      (ref: { table: string; columns: string[] }) => ref.table === 'stock_move' && ref.columns[0] === 'product_sku',
    );
    assert.ok(soft, answer.text);
    assert.deepEqual(soft.toColumns, ['sku']);
    assert.equal(soft.count, 2, answer.text);
    assert.deepEqual(soft.filter.groups, [[{ column: 'product_sku', op: '=', value: 'LNT-01' }]]);
  });
});

test("the target's grants and hidden columns prune the edge; a request cannot supply one", async () => {
  const roles = { auth: { roles: { clerk: { read: ['stock_move'] }, manager: { read: true, write: true } } } };
  await serve(
    base(roles),
    async (call) => {
      const schema = await call('/api/schema');
      const move = schema.body.tables.find((table: { id: string }) => table.id === 'stock_move');
      assert.equal(move.columns.find((column: { name: string }) => column.name === 'product_sku').references, undefined);
      assert.ok(!JSON.stringify(schema.body).includes('Lantern'));
      refused(await call('/api/run', { q: 'stock_move show product_sku.name' }), 'walk to an unreadable target');
      refused(await call('/api/run', { q: 'stock_move product_sku.cost > 10' }), 'filter on an unreadable target');
    },
    'clerk',
  );
  const hidden = base();
  (hidden.resources as any).product.hidden = ['sku'];
  await serve(hidden, async (call) => {
    const schema = await call('/api/schema');
    assert.equal(
      schema.body.tables
        .find((table: { id: string }) => table.id === 'stock_move')
        .columns.find((column: { name: string }) => column.name === 'product_sku').references,
      undefined,
      'the edge goes with the hidden key',
    );
    refused(await call('/api/run', { q: 'stock_move show product_sku.name' }), 'walk through a hidden key');
  });
  /* The Workbench over the same database: a forged edge in the request joins nothing. */
  await serve(undefined, async (call) => {
    const forged = await call('/api/view/run', {
      view: {
        id: 'forged',
        name: 'Forged',
        base: 'stock_move',
        columns: [{ path: 'product_sku.name' }],
        references: [
          {
            name: 'forged',
            from: { table: 'stock_move', columns: ['product_sku'] },
            to: { table: 'product', columns: ['sku'] },
            declared: true,
          },
        ],
      },
    });
    refused(forged, 'a request-supplied edge');
  });
});

test('a declared reference is never write authority: its target deletes as the database allows', async () => {
  await serve(base(), async (call) => {
    const deleted = await call('/api/delete', { table: 'product', key: { id: 2 }, confirm: true });
    assert.equal(deleted.status, 200, deleted.text);
    const left = await call('/api/run', { q: 'stock_move show id, product_sku.name sort id' });
    assert.deepEqual(
      left.body.rows.map((row: Record<string, unknown>) => row['product_sku.name']),
      ['Lantern', 'Lantern', null, null],
    );
  });
});

test('a reference the catalog cannot prove is refused when the App loads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-refs-load-'));
  const file = join(directory, 'depot.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'refs', name: 'Refs', url: file, source: 'config' });
  const load = (references: Record<string, unknown>) =>
    loadAppRuntimeResources(registry, parseAppConfig(base({ resources: { product: {}, stock_move: { references } } }), 'refusals'), 'refs');
  try {
    await assert.rejects(load({ bin_code: { to: 'product', column: 'bin' } }), /not proven unique/);
    await assert.rejects(load({ qty: { to: 'product', column: 'sku' } }), /compares like with like/);
    await assert.rejects(load({ nope: { to: 'product', column: 'sku' } }), /not a column/);
    await assert.rejects(load({ product_sku: { to: 'product', column: 'nope' } }), /not a column of product/);
    await assert.rejects(load({ id: { to: 'product' } }), /primary key/);
    const plain = await load({ product_id: { to: 'product' } });
    assert.ok(
      plain.schema.foreignKeys.some((fk) => fk.declared && fk.to.columns[0] === 'id'),
      "column defaults to the target's primary key",
    );
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.throws(
    () => parseAppConfig(base({ resources: { stock_move: { references: { product_sku: { to: 'product', column: 'sku' } } } } }), 'x'),
    /no resource block declares/,
  );
  // Another source's target parses; how it is read is the catalog's to say (stitched-references.test.ts).
  assert.doesNotThrow(() =>
    parseAppConfig(
      {
        id: 'x',
        name: 'X',
        sources: { ops: { connection: 'a', default: true }, catalog: { connection: 'b' } },
        resources: { 'catalog.product': {}, stock_move: { references: { product_sku: { to: 'catalog.product', column: 'sku' } } } },
        views: { moves: { kind: 'list', from: 'stock_move' } },
        home: 'moves',
      },
      'x',
    ),
  );
  // A row policy scopes a path through a declared edge as through a real key.
  assert.doesNotThrow(() =>
    parseAppConfig(
      {
        ...base({ auth: { rows: 'policy', roles: { clerk: { read: true } } } }),
        connection: undefined,
        sources: { ops: { connection: 'refs' } },
      },
      'x',
    ),
  );
});

test("a view's references widen its catalog once for their words, though a scoped reader hands them over as a copy", () => {
  const column = (name: string, primaryKey = false) => ({ name, type: primaryKey ? 'INTEGER' : 'TEXT', nullable: !primaryKey, primaryKey });
  const catalog: DatabaseSchema = {
    label: 'refs',
    dialect: 'sqlite',
    readAt: '',
    tables: [
      {
        id: 'product',
        name: 'product',
        schema: '',
        isView: false,
        columns: [column('id', true), { ...column('sku'), nullable: false }],
        unique: ['sku'],
      },
      { id: 'stock_move', name: 'stock_move', schema: '', isView: false, columns: [column('id', true), column('product_sku')] },
    ],
    foreignKeys: [],
  } as DatabaseSchema;
  const edge = (to: string): ForeignKey => ({
    name: 'stock_move.product_sku',
    from: { table: 'stock_move', columns: ['product_sku'] },
    to: { table: 'product', columns: [to] },
  });
  const widened = withViewReferences(catalog, [edge('sku')]);
  assert.notEqual(widened, catalog);
  assert.equal(widened.foreignKeys.length, 1);
  // A copy of the same words (what snapshotScopedData hands the compiler on every read) finds the same catalog.
  assert.equal(withViewReferences(catalog, structuredClone([edge('sku')])), widened);
  // Other words are their own catalog: here the same edge under another name.
  const other = withViewReferences(catalog, [{ ...edge('sku'), name: 'stock_move.sku' }]);
  assert.notEqual(other, widened);
  assert.equal(other.foreignKeys[0].name, 'stock_move.sku');
});
