/**
 * Rollups (rollups.ts, appRollups.ts): what a resource block may say, what
 * the catalog refuses by name, the statement a rollup path compiles to, and
 * the served App — a list, a sort, a condition and a record's fields reading
 * one, a reader who may not read the child rows served none, and a request
 * that brings its own definition of one ignored.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { appRollupRules, parseAppConfig, resolveViews, withRollups } from '../packages/mistri/src/shared/app.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { ANSI_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, compileViewCount, parseViewQuery, withViewComputed, type ViewDef } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const schema: DatabaseSchema = {
  label: 'Orders',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { id: 'po', name: 'po', schema: '', isView: false, columns: [key('id'), column('number', 'TEXT'), column('status', 'TEXT')] },
    {
      id: 'po_line',
      name: 'po_line',
      schema: '',
      isView: false,
      columns: [
        key('id'),
        column('po_id', 'INTEGER'),
        column('replaces_po_id', 'INTEGER'),
        column('amount', 'NUMERIC'),
        column('state', 'TEXT'),
        column('note', 'TEXT'),
        column('due_on', 'DATE'),
      ],
    },
    { id: 'receipt', name: 'receipt', schema: '', isView: false, columns: [key('id'), column('po_id', 'INTEGER')] },
  ],
  foreignKeys: [
    { name: 'line_po', from: { table: 'po_line', columns: ['po_id'] }, to: { table: 'po', columns: ['id'] } },
    { name: 'line_replaces', from: { table: 'po_line', columns: ['replaces_po_id'] }, to: { table: 'po', columns: ['id'] } },
    { name: 'receipt_po', from: { table: 'receipt', columns: ['po_id'] }, to: { table: 'po', columns: ['id'] } },
  ],
} as DatabaseSchema;

const app = (rollups: unknown, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Orders',
      resources: { po: { rollups }, po_line: {}, receipt: {} },
      views: { orders: { kind: 'list', from: 'po' } },
      home: 'orders',
      nav: ['orders'],
      ...extra,
    },
    'rollups fixture',
  );
const problems = (rollups: unknown) => appRollupRules(app(rollups), schema).problems;

test('a rollup block is refused by name when its shape is wrong', () => {
  assert.throws(() => app({ total: { fn: 'avg', from: 'po_line', column: 'amount' } }), /"fn" of "avg"\. Use "count", "sum", "min", "max"/);
  assert.throws(() => app({ lines: { fn: 'count', from: 'po_line', column: 'amount' } }), /counts rows and names a "column"/);
  assert.throws(() => app({ total: { fn: 'sum', from: 'po_line' } }), /is a sum and needs a "column"/);
  assert.throws(
    () => app({ total: { fn: 'sum', from: 'po_line', column: 'amount', whose: 'po_id.vendor_id.id' } }),
    /reads through one or two references/,
  );
  assert.throws(() => app({ 'line total': { fn: 'count', from: 'po_line' } }), /a rollup's name is read like a column's/);
  assert.throws(() => app({ lines: { fn: 'count', from: 'po_line', where: 'x' } }), /has no "where"/);
  assert.deepEqual(app({ lines: { fn: 'count', from: ' po_line ', whose: ' po_id ', query: ' state = open ' } }).resources!.po.rollups, {
    lines: { fn: 'count', from: 'po_line', whose: 'po_id', query: 'state = open' },
  });
});

test('the catalog judges each rollup and names the fix', () => {
  assert.match(
    problems({ lines: { fn: 'count', from: 'po_line' } })[0],
    /"po_line" points at "po" through po_id, replaces_po_id\. Say which with "whose"/,
  );
  assert.match(
    problems({ lines: { fn: 'count', from: 'po_line', whose: 'state' } })[0],
    /"state" is not a reference from "po_line" to "po"\. Its references here: po_id, replaces_po_id/,
  );
  assert.match(problems({ lines: { fn: 'count', from: 'nowhere' } })[0], /no resource "nowhere"/);
  assert.match(problems({ receipts: { fn: 'count', from: 'po', whose: 'id' } })[0], /nothing on "po" points at "po"/);
  assert.match(
    problems({ total: { fn: 'sum', from: 'po_line', column: 'note', whose: 'po_id' } })[0],
    /"po_line\.note" is TEXT; a sum reads numbers/,
  );
  assert.match(problems({ total: { fn: 'sum', from: 'po_line', column: 'cost', whose: 'po_id' } })[0], /"po_line" has no column "cost"/);
  assert.match(problems({ status: { fn: 'count', from: 'receipt' } })[0], /already has a column "status"/);
  assert.match(problems({ open: { fn: 'count', from: 'receipt', query: 'nope = 1' } })[0], /open" query: /);
  assert.match(
    problems({ open: { fn: 'count', from: 'receipt', query: 'id > 1 sort id' } })[0],
    /only says which rows count — no show, sort or limit/,
  );
  // One figure for every reader, read without a session: `me` was bound as the two letters (Keystone lender's 500).
  assert.match(
    problems({ mine: { fn: 'count', from: 'receipt', query: 'id = me' } })[0],
    /mine" query: a rollup is the same figure for every reader, so its query cannot say "me"/,
  );
  assert.deepEqual(
    problems({ named: { fn: 'count', from: 'receipt', query: 'id = "me"' } }).filter((p) => /cannot say "me"/.test(p)),
    [],
    'quoted, it is the text',
  );
  assert.deepEqual(
    problems({ first_due: { fn: 'min', from: 'po_line', column: 'due_on', whose: 'po_id' }, receipts: { fn: 'count', from: 'receipt' } }),
    [],
  );
  // A tenant App's rollups are judged as any App's: its lease's scoped relations narrow them (tenant-rollups.test.ts).
  const tenant = { ...app({ r: { fn: 'count', from: 'receipt' } }), auth: { rows: 'tenant' } } as AppDef;
  assert.deepEqual(appRollupRules(tenant, schema).problems, []);
});

const served = withRollups(
  app({
    lines: { fn: 'count', from: 'po_line', whose: 'po_id' },
    total: { fn: 'sum', from: 'po_line', column: 'amount', whose: 'po_id', query: 'state = open' },
  }),
  schema,
);

test('a rollup is a correlated subquery in the one statement, its own filter bound first', () => {
  assert.equal(served.tables.find((t) => t.id === 'po')!.columns.length, 3, 'never a column of the table');
  const view = withViewComputed(
    served,
    textToView(served, "po show number, lines, total where total > 5 and number != 'x' sort lines desc").view!,
  );
  assert.deepEqual(Object.keys(view.computed!), ['lines', 'total']);
  const { text, params, columns } = compileView(schema, view, POSTGRES_STYLE);
  assert.match(text, /^WITH "_tw_scope\$1" AS \(SELECT .* FROM "po_line" WHERE "state" = \$1\)/);
  assert.match(text, /\(SELECT COUNT\(\*\) FROM "po_line" "po_line_\d+" WHERE "po_line_\d+"\."po_id" = "po_0"\."id"\) AS "lines"/);
  assert.match(
    text,
    /WHERE \(SELECT COALESCE\(SUM\("po_line_\d+"\."amount"\), 0\) FROM "_tw_scope\$1" "po_line_\d+" WHERE .*\) > \$2 AND "po_0"\."number" != \$3/,
  );
  assert.match(text, /ORDER BY \(SELECT COUNT\(\*\).*\) DESC/);
  assert.deepEqual(params.slice(0, 3), ['open', 5, 'x']);
  assert.deepEqual(
    columns.map((c) => [c.name, c.aggregate, c.type]),
    [
      ['number', undefined, 'TEXT'],
      ['lines', 'count', 'integer'],
      ['total', 'sum', 'NUMERIC'],
    ],
  );
  const counted = compileViewCount(schema, view, ANSI_STYLE);
  assert.match(counted.text, /^WITH/);
  assert.deepEqual(counted.params, ['open', 5, 'x']);
  // Through a reference, from the row that holds it.
  const receipt = withViewComputed(served, textToView(served, 'receipt show id, po_id.total').view!);
  assert.match(compileView(schema, receipt, ANSI_STYLE).text, /LEFT JOIN "po" "po_1".*|SUM\("po_line_\d+"\."amount"\).*"po_1"\."id"/s);
});

test('a latest reads a column of the newest row: judged, typed as its column, and one ordered subquery that runs', () => {
  assert.throws(() => app({ last: { fn: 'count', from: 'po_line', sort: 'due_on' } }), /only a latest orders its rows/);
  assert.throws(() => app({ last: { fn: 'latest', from: 'po_line' } }), /is a latest and needs a "column"/);
  assert.match(
    problems({ last: { fn: 'latest', from: 'po_line', column: 'state', whose: 'po_id', sort: 'note' } })[0],
    /"po_line\.note" is TEXT, so it does not say which row is newest/,
  );
  assert.match(
    problems({ last: { fn: 'latest', from: 'po_line', column: 'state', whose: 'po_id', sort: 'nope' } })[0],
    /has no column "nope" to order by/,
  );
  // Through two references each hop is judged by name, as a sum's are (rollups-two-hops.test.ts).
  assert.match(
    problems({ last: { fn: 'latest', from: 'po_line', column: 'state', whose: 'po_id.x' } })[0],
    /"x" is not a reference from "po"/,
  );
  const latest = withRollups(
    app({
      last_state: { fn: 'latest', from: 'po_line', column: 'state', whose: 'po_id', sort: 'due_on' },
      newest: { fn: 'latest', from: 'po_line', column: 'note', whose: 'po_id' },
    }),
    {
      ...schema,
      tables: schema.tables.map((t) =>
        t.id === 'po_line' ? { ...t, columns: t.columns.map((c) => (c.name === 'state' ? { ...c, allowed: ['open', 'closed'] } : c)) } : t,
      ),
    },
  );
  const rollups = latest.tables.find((t) => t.id === 'po')!.rollups!;
  assert.deepEqual([rollups.last_state.by, rollups.last_state.allowed, rollups.newest.by], ['due_on', ['open', 'closed'], 'id']);
  const view = withViewComputed(latest, textToView(latest, 'po show number, last_state, newest where last_state = closed sort id').view!);
  const { text, params, columns } = compileView(schema, view, ANSI_STYLE);
  // A line with no due date is not the newest: nulls last, as every engine reads it, and the key breaks a tie.
  assert.match(
    text,
    /\(SELECT "po_line_\d+"\."state" FROM "po_line" "po_line_\d+" WHERE "po_line_\d+"\."po_id" = "po_0"\."id" ORDER BY "po_line_\d+"\."due_on" IS NULL ASC, "po_line_\d+"\."due_on" DESC, "po_line_\d+"\."id" DESC LIMIT 1\) AS "last_state"/,
  );
  assert.deepEqual(
    columns.map((c) => [c.name, c.aggregate, c.type]),
    [
      ['number', undefined, 'TEXT'],
      ['last_state', 'latest', 'TEXT'],
      ['newest', 'latest', 'TEXT'],
    ],
  );
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE po (id INTEGER PRIMARY KEY, number TEXT, status TEXT);
    CREATE TABLE po_line (id INTEGER PRIMARY KEY, po_id INTEGER, replaces_po_id INTEGER, amount NUMERIC, state TEXT, note TEXT, due_on DATE);
    INSERT INTO po VALUES (1, 'A', NULL), (2, 'B', NULL), (3, 'C', NULL);
    INSERT INTO po_line (id, po_id, state, note, due_on) VALUES
      (1, 1, 'closed', 'first', '2026-02-01'), (2, 1, 'open', 'second', '2026-01-01'),
      (3, 2, 'open', 'dated', '2026-01-01'), (4, 2, 'closed', 'undated', NULL);`);
  const rows = db.prepare(text).all(...(params as never[])) as Array<Record<string, unknown>>;
  db.close();
  assert.deepEqual(
    rows.map((row) => [row.number, row.last_state, row.newest]),
    [['A', 'closed', 'second']],
  );
});

test("a rollup is the catalog's: a request's own definition is dropped, and a catalog without it says there is no such column", () => {
  const forged: ViewDef = {
    id: 'x',
    name: 'x',
    base: 'po',
    columns: [{ path: 'secret' }],
    computed: { secret: { fn: 'sum', via: 'po_line.po_id', column: 'amount', type: 'NUMERIC', on: '' } },
  };
  assert.equal(withViewComputed(served, forged).computed, undefined);
  assert.throws(() => compileView(schema, withViewComputed(served, forged), ANSI_STYLE), /"secret" is not a column on po/);
  assert.deepEqual(parseViewQuery(schema, 'po', 'total > 5').errors.map((e) => e.message)[0], '"total" is not a column on po.');
});

test('views, sorts and tabs name rollups like columns', () => {
  const orders = parseAppConfig(
    {
      name: 'Orders',
      resources: { po: { rollups: { lines: { fn: 'count', from: 'receipt' } }, segments: { received: 'lines > 0' } }, receipt: {} },
      views: {
        orders: {
          kind: 'list',
          from: 'po',
          show: ['number', 'lines'],
          sort: [
            { label: 'Most receipts', sort: 'lines desc' },
            { label: 'Number', sort: 'number' },
          ],
          tabs: [{ segment: 'received', sort: 'lines desc' }],
        },
      },
      home: 'orders',
      nav: ['orders'],
    },
    'views',
  );
  assert.equal((resolveViews(orders, withRollups(orders, schema)).orders as { error?: string }).error, undefined);
  assert.match((resolveViews(orders, schema).orders as { error?: string }).error!, /"lines"/);
});

/* ---------- served ---------- */

const identity = (role: string): Identity => ({ id: `account-${role}`, who: `${role}@example.test`, role });
const sessions: Record<string, Identity> = { manager: identity('manager'), clerk: identity('clerk') };

test('a served App reads rollups in lists, sorts, conditions and fields, and a reader who may not read the rows is served none', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rollups-'));
  const path = join(directory, 'orders.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE po (id INTEGER PRIMARY KEY, number TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE po_line (id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES po(id), amount NUMERIC NOT NULL, state TEXT NOT NULL);
    INSERT INTO po VALUES (1, 'PO-1', 'open'), (2, 'PO-2', 'open'), (3, 'PO-3', 'closed');
    INSERT INTO po_line VALUES (1, 1, 10, 'open'), (2, 1, 30, 'done'), (3, 2, 100, 'open');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'orders', name: 'Orders', url: path, source: 'config', writable: false });
  const manifest = parseAppConfig(
    {
      id: 'orders-app',
      name: 'Orders',
      connection: 'orders',
      resources: {
        po: {
          rollups: {
            lines: { fn: 'count', from: 'po_line' },
            open_total: { fn: 'sum', from: 'po_line', column: 'amount', query: 'state = open' },
          },
          display: { open_total: { format: 'money' } },
          labels: { open_total: 'Open total' },
        },
        po_line: {},
      },
      auth: { providers: ['email'], defaultRole: 'clerk', roles: { manager: { read: true }, clerk: { read: ['po'] } } },
      views: { orders: { kind: 'list', from: 'po', show: ['number', 'lines', 'open_total'] } },
      home: 'orders',
      nav: ['orders'],
    },
    'served',
  );
  const host: AppHost = {
    app: { path: '/orders/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const post = async (who: string, route: string, body: unknown) => {
      const res = await fetch(`http://${bound.host}:${bound.port}${route}?app=orders-app`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `session=${who}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const list = await post('manager', '/api/run', {
      q: 'po show number, lines, open_total where lines > 0 sort open_total desc',
      limit: 10,
    });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.rows, [
      { number: 'PO-2', lines: 1, open_total: 100 },
      { number: 'PO-1', lines: 2, open_total: 10 },
    ]);
    assert.equal(list.body.total, 2);
    // A list's tab badges count through the rollup its question names, as the list reads it.
    const tabs = await post('manager', '/api/counts', {
      items: ['po lines > 1 show number, lines', 'po open_total >= 50', 'po status = open'],
    });
    assert.equal(tabs.status, 200, JSON.stringify(tabs.body));
    assert.deepEqual(
      (tabs.body.results as { total: number }[]).map((result) => result.total),
      [1, 1, 2],
    );
    // A list's tab badges count a tab that names a rollup, beside a plain one, in one batch.
    const counts = await post('manager', '/api/counts', { items: ['po lines > 0', 'po lines = 0', 'po'] });
    assert.equal(counts.status, 200, JSON.stringify(counts.body));
    assert.deepEqual(
      (counts.body.results as Array<{ total: number }>).map((result) => result.total),
      [2, 1, 3],
    );

    const fields = await post('manager', '/api/view/run', {
      count: 'none',
      view: {
        id: 'page',
        name: 'po',
        base: 'po',
        columns: [{ path: 'number' }, { path: 'open_total' }],
        filter: { groups: [[{ path: 'id', op: '=', value: 3 }]] },
      },
    });
    // An order with no lines totals 0, as it counts 0: a sum of nothing is not unknown.
    assert.deepEqual((fields.body as { rows: unknown[] }).rows, [{ number: 'PO-3', open_total: 0 }]);

    const catalog = async (who: string) => {
      const res = await fetch(`http://${bound.host}:${bound.port}/api/schema?app=orders-app`, { headers: { cookie: `session=${who}` } });
      return ((await res.json()) as DatabaseSchema).tables.find((table) => table.id === 'po')?.rollups;
    };
    assert.deepEqual(Object.keys((await catalog('manager')) ?? {}), ['lines', 'open_total']);
    // The clerk may read orders but not their lines: no number built from them.
    assert.equal(await catalog('clerk'), undefined);
    const refused = await post('clerk', '/api/run', { q: 'po show number, open_total', limit: 10 });
    assert.ok(!('rows' in refused.body), JSON.stringify(refused.body));
    const forged = await post('clerk', '/api/view/run', {
      count: 'none',
      view: {
        id: 'x',
        name: 'x',
        base: 'po',
        columns: [{ path: 'open_total' }],
        computed: { open_total: { fn: 'sum', via: 'po_line.po_id', column: 'amount', type: 'NUMERIC', on: '' } },
      },
    });
    assert.ok(!('rows' in forged.body), JSON.stringify(forged.body));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});
