/**
 * Rollups wherever a column may stand (rollups.ts): a rollup of a rollup —
 * two hops — and what refuses a third; a rollup as a breakdown's measure,
 * key and condition, the def carrying the catalog's rollups and never a
 * request's; a card's figure and facts, a queue's facts, a picker's query
 * and a page breakdown's measure judged against the catalog that serves
 * them; the statements on each engine's style; and the served App, where a
 * reader who may not read the rows a number is built from is served neither
 * the number nor a breakdown of it, whatever the request brings.
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
import { appRollupRules, parseAppConfig, resolveViews, withLabelTemplates, withRollups } from '../packages/mistri/src/shared/app.js';
import { compileBreakdown, withBreakdownComputed, type BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { commandInputProblem } from '../packages/mistri/src/shared/command.js';
import { ANSI_STYLE, MYSQL_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { breakdownPlan, validatePage } from '../packages/engine/src/shared/page.js';
import { parsePageBody } from '../packages/engine/src/shared/pageConfig.js';
import type { PageBreakdown } from '../packages/engine/src/shared/pageModel.js';
import { rollupReads } from '../packages/engine/src/shared/rollups.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const schema: DatabaseSchema = {
  label: 'Orders',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { id: 'vendor', name: 'vendor', schema: '', isView: false, columns: [key('id'), column('name', 'TEXT')] },
    {
      id: 'po',
      name: 'po',
      schema: '',
      isView: false,
      columns: [key('id'), column('number', 'TEXT'), column('status', 'TEXT'), column('vendor_id', 'INTEGER')],
    },
    {
      id: 'po_line',
      name: 'po_line',
      schema: '',
      isView: false,
      columns: [key('id'), column('po_id', 'INTEGER'), column('amount', 'NUMERIC'), column('state', 'TEXT'), column('due_on', 'DATE')],
    },
    { id: 'receipt', name: 'receipt', schema: '', isView: false, columns: [key('id'), column('po_id', 'INTEGER')] },
  ],
  foreignKeys: [
    { name: 'po_vendor', from: { table: 'po', columns: ['vendor_id'] }, to: { table: 'vendor', columns: ['id'] } },
    { name: 'line_po', from: { table: 'po_line', columns: ['po_id'] }, to: { table: 'po', columns: ['id'] } },
    { name: 'receipt_po', from: { table: 'receipt', columns: ['po_id'] }, to: { table: 'po', columns: ['id'] } },
  ],
} as DatabaseSchema;

const PO_ROLLUPS = {
  lines: { fn: 'count', from: 'po_line' },
  total: { fn: 'sum', from: 'po_line', column: 'amount' },
  last_due: { fn: 'max', from: 'po_line', column: 'due_on' },
  open_total: { fn: 'sum', from: 'po_line', column: 'amount', query: 'state = open' },
};
const app = (vendorRollups: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Orders',
      resources: { vendor: { rollups: vendorRollups }, po: { rollups: PO_ROLLUPS }, po_line: {}, receipt: {} },
      views: { orders: { kind: 'list', from: 'po' } },
      home: 'orders',
      nav: ['orders'],
      ...extra,
    },
    'rollups everywhere',
  );

test('a rollup may read a rollup of its rows — two hops — and a third level, or a date summed, is refused by name', () => {
  const judged = appRollupRules(
    app({
      lines: { fn: 'sum', from: 'po', column: 'lines' },
      open_value: { fn: 'sum', from: 'po', column: 'open_total', query: 'status = open' },
      latest_due: { fn: 'max', from: 'po', column: 'last_due' },
    }),
    schema,
  );
  assert.deepEqual(judged.problems, []);
  const vendor = judged.rules.get('vendor')!;
  assert.deepEqual(vendor.lines, {
    fn: 'sum',
    via: 'po.vendor_id',
    column: 'lines',
    type: 'integer',
    of: { fn: 'count', via: 'po_line.po_id', type: 'integer' },
  });
  assert.equal(vendor.open_value.of!.filter!.groups[0][0].column, 'state', 'the inner rollup keeps its own query');
  assert.equal(vendor.open_value.filter!.groups[0][0].column, 'status', 'and the outer its own');
  assert.equal(vendor.latest_due.type, 'DATE');
  // What it reads, for a reader's grants: both levels, never an inner rollup's name as a field.
  assert.deepEqual(rollupReads(vendor.open_value), [
    { table: 'po', fields: ['vendor_id', 'status'] },
    { table: 'po_line', fields: ['po_id', 'amount', 'state'] },
  ]);

  assert.match(
    appRollupRules(app({ due: { fn: 'sum', from: 'po', column: 'last_due' } }), schema).problems[0],
    /"due": the rollup "po\.last_due" is DATE; a sum reads numbers/,
  );
  // A rollup of a rollup of a rollup: refused whichever order the resources are declared in.
  const deep = (order: 'first' | 'last') => {
    const resources: Record<string, unknown> = {
      po: { rollups: PO_ROLLUPS },
      po_line: {},
      receipt: {},
      vendor: { rollups: { lines: { fn: 'sum', from: 'po', column: 'lines' } } },
    };
    const region = { rollups: { lines: { fn: 'sum', from: 'vendor', column: 'lines' } } };
    return parseAppConfig(
      {
        name: 'Deep',
        resources: order === 'first' ? { region, ...resources } : { ...resources, region },
        views: { orders: { kind: 'list', from: 'po' } },
        home: 'orders',
        nav: ['orders'],
      },
      'deep',
    );
  };
  const regional: DatabaseSchema = {
    ...schema,
    tables: [
      ...schema.tables.map((t) => (t.id === 'vendor' ? { ...t, columns: [...t.columns, column('region_id', 'INTEGER')] } : t)),
      { id: 'region', name: 'region', schema: '', isView: false, columns: [key('id')] },
    ],
    foreignKeys: [
      ...schema.foreignKeys,
      { name: 'vendor_region', from: { table: 'vendor', columns: ['region_id'] }, to: { table: 'region', columns: ['id'] } },
    ],
  };
  for (const order of ['first', 'last'] as const) {
    const { rules, problems } = appRollupRules(deep(order), regional);
    assert.equal(problems.length, 1, order);
    assert.match(problems[0], /"vendor\.lines" is itself a rollup of a rollup\. A rollup reads a column, or a rollup that reads one\./);
    assert.ok(rules.get('vendor')?.lines && !rules.get('region'), order);
  }
  // A rollup's query narrows by its rows' own columns, not their rollups.
  assert.match(
    appRollupRules(app({ busy: { fn: 'count', from: 'po', query: 'lines > 1' } }), schema).problems[0],
    /"lines" is not a column on po/,
  );
});

const served = withRollups(
  app({ lines: { fn: 'sum', from: 'po', column: 'lines' }, open_value: { fn: 'sum', from: 'po', column: 'open_total' } }),
  schema,
);

test("a rollup of a rollup is the inner subquery inside the outer aggregate, on every engine's style", () => {
  const view = withViewComputed(served, textToView(served, 'vendor show name, lines, open_value where lines > 2').view!);
  for (const [style, q, p] of [
    [ANSI_STYLE, '"', /\?/],
    [POSTGRES_STYLE, '"', /\$\d/],
    [MYSQL_STYLE, '`', /\?/],
  ] as const) {
    const { text } = compileView(schema, view, style);
    const inner = `\\(SELECT COUNT\\(\\*\\) FROM ${q}po_line${q} ${q}po_line_\\d+${q} WHERE ${q}po_line_\\d+${q}\\.${q}po_id${q} = ${q}po_\\d+${q}\\.${q}id${q}\\)`;
    assert.match(
      text,
      new RegExp(
        `\\(SELECT COALESCE\\(SUM\\(${inner}\\), 0\\) FROM ${q}po${q} ${q}po_\\d+${q} WHERE ${q}po_\\d+${q}\\.${q}vendor_id${q} = ${q}vendor_0${q}\\.${q}id${q}\\) AS ${q}lines${q}`,
      ),
      text,
    );
    // The inner rollup's own query rides in a CTE bound first, as a plain one's does.
    assert.match(text, /^WITH /);
    assert.match(text, p);
  }
});

test("a breakdown measures, groups and narrows by a rollup — the base's or through a reference — from the catalog, never the request", () => {
  const def = (text: string): BreakdownDef => {
    const parsed = textToBreakdown(served, text);
    assert.deepEqual(parsed.errors ?? [], [], text);
    const { text: _text, ...rest } = parsed.breakdown!;
    return withBreakdownComputed(served, rest);
  };
  const measured = def('po lines > 0 sum total by status');
  assert.deepEqual(Object.keys(measured.computed!).sort(), ['lines', 'total']);
  for (const style of [ANSI_STYLE, POSTGRES_STYLE, MYSQL_STYLE]) {
    // Compiled where the adapter's own catalog knows nothing of rollups.
    const { text, columns } = compileBreakdown(schema, measured, style);
    assert.match(text, /SUM\(\(SELECT COALESCE\(SUM\(/);
    assert.match(text, /WHERE \(SELECT COUNT\(\*\)/);
    assert.deepEqual(
      columns.map((c) => [c.name, c.kind, c.type]),
      [
        ['status', 'key', 'TEXT'],
        ['sum(total)', 'measure', 'NUMERIC'],
      ],
    );
  }
  /* Grouped by a rollup: by its place in the SELECT list, where its subquery is written once. MySQL under
     ONLY_FULL_GROUP_BY does not take a second copy of a correlated subquery as the same expression, and
     refuses the first as ungrouped (rollups-live.test.ts holds all three engines to one answer). */
  for (const style of [ANSI_STYLE, POSTGRES_STYLE, MYSQL_STYLE]) {
    const keyed = compileBreakdown(schema, def('receipt count by po_id.lines, po_id'), style);
    assert.match(keyed.text, /^SELECT \(SELECT COUNT\(\*\) FROM [`"]po_line/m);
    // The reference key's name (the purchase order's) is grouped by its place too, after the measure.
    assert.match(keyed.text, / GROUP BY 1, [`"]receipt_0[`"]\.[`"]po_id[`"], 4$/m, keyed.text);
    assert.doesNotMatch(keyed.text, /GROUP BY \(SELECT/);
    assert.equal(keyed.columns[0].type, 'integer');
  }
  const twoHops = compileBreakdown(schema, def('vendor sum lines by name'), ANSI_STYLE);
  assert.match(twoHops.text, /SUM\(\(SELECT COALESCE\(SUM\(\(SELECT COUNT\(\*\)/);

  // A request's own definition is dropped, and without the catalog's there is no such column.
  const forged: BreakdownDef = {
    base: 'po',
    by: [],
    measures: [{ fn: 'sum', path: 'secret' }],
    computed: { secret: { fn: 'sum', via: 'po_line.po_id', column: 'amount', type: 'NUMERIC', on: '' } },
  };
  assert.equal(withBreakdownComputed(served, forged).computed, undefined);
  assert.throws(() => compileBreakdown(schema, withBreakdownComputed(served, forged), ANSI_STYLE), /"secret" is not a column on po/);
  assert.throws(
    () => compileBreakdown(schema, { base: 'po', by: [], measures: [{ fn: 'sum', path: 'total' }] }, ANSI_STYLE),
    /"total" is not a column on po/,
  );
});

test('cards, queues, pickers and page breakdowns take a rollup where they take a column', () => {
  const views = parseAppConfig(
    {
      name: 'Orders',
      resources: {
        vendor: { rollups: { lines: { fn: 'sum', from: 'po', column: 'lines' } } },
        po: { rollups: PO_ROLLUPS },
        po_line: {},
        receipt: {},
      },
      views: {
        cards: {
          kind: 'list',
          from: 'po',
          presentation: {
            kind: 'cards',
            primary: 'number',
            value: 'total',
            badge: 'lines',
            facts: ['open_total', 'vendor_id.lines'],
            properties: ['last_due'],
          },
        },
        queue: {
          kind: 'list',
          from: 'receipt',
          presentation: { kind: 'queue', primary: 'po_id.number', badge: 'po_id.lines', properties: ['po_id.total'] },
        },
        'po-queue': {
          kind: 'list',
          from: 'po',
          presentation: { kind: 'queue', primary: 'number', properties: ['lines', 'vendor_id.lines'] },
        },
        bad: { kind: 'list', from: 'po', presentation: { kind: 'cards', primary: 'number', facts: ['nothing'] } },
        title: { kind: 'list', from: 'po', presentation: { kind: 'queue', primary: 'lines' } },
      },
      home: 'cards',
      nav: ['cards', 'queue', 'po-queue', 'bad', 'title'],
    },
    'presentations',
  );
  const resolved = resolveViews(views, withRollups(views, schema)) as Record<string, { error?: string }>;
  assert.equal(resolved.cards.error, undefined);
  assert.equal(resolved.queue.error, undefined);
  assert.equal(resolved['po-queue'].error, undefined);
  assert.match(resolved.bad.error!, /Cards facts\[0\]: "nothing" must be a readable column/);
  // A title is text: a rollup is a number, and never one.
  assert.match(resolved.title.error!, /Queue primary: "lines" must be a readable column/);
  // Without the catalog that serves them, the same names are not there.
  assert.match((resolveViews(views, schema).cards as { error?: string }).error!, /"last_due" must be a readable column/);

  // A reference input's picker query is judged as its read will run it: a view, where it names a rollup.
  const input = [
    {
      name: 'po',
      label: 'Order',
      type: 'reference',
      from: 'po',
      by: 'id',
      labelColumn: 'number',
      query: 'lines > 0 and vendor_id.lines > 1',
    },
  ];
  assert.equal(commandInputProblem(input as never, withRollups(views, schema)), undefined);
  assert.match(commandInputProblem(input as never, schema)!, /Command input "po" query: "lines" is not a column/);

  const page = parsePageBody(
    {
      base: 'vendor',
      sections: [
        { kind: 'breakdown', from: 'po', whose: 'vendor_id', by: 'status', measure: 'sum total' },
        { kind: 'metric', from: 'po', whose: 'vendor_id', measure: 'sum open_total' },
        { kind: 'breakdown', from: 'po', whose: 'vendor_id', by: 'status', measure: 'sum nothing' },
      ],
    },
    'page',
    'vendor',
  );
  const catalog = withRollups(views, schema);
  assert.match(validatePage(catalog, page).error!, /"nothing" is not a column on po/);
  const good = { ...page, sections: page.sections.slice(0, 2) };
  assert.equal(validatePage(catalog, good).error, undefined);
  const plan = breakdownPlan(catalog, good, good.sections[0] as PageBreakdown, { id: 1 }, 0);
  assert.deepEqual(plan.def!.measures, [{ fn: 'sum', path: 'total', alias: 'value' }]);
  assert.deepEqual(plan.def!.orderBy, [{ name: 'value', direction: 'desc' }]);
  assert.match(
    compileBreakdown(schema, withBreakdownComputed(catalog, plan.def!), ANSI_STYLE).text,
    /SUM\(\(SELECT COALESCE\(SUM\("po_line_\d+"\."amount"\), 0\)/,
  );
});

test("a record named by its key in the App's words is flagged for a grid's key column; a noun-and-key or a path is not", () => {
  const labelled = parseAppConfig(
    {
      name: 'Orders',
      resources: {
        po: { recordLabel: 'PO-{id}' },
        vendor: { recordLabel: 'name' },
        po_line: { recordLabel: '{po_id.number} · {id}' },
        receipt: {},
      },
      views: { orders: { kind: 'list', from: 'po' } },
      home: 'orders',
      nav: ['orders'],
    },
    'labels',
  );
  const tables = Object.fromEntries(
    withLabelTemplates(labelled, schema).tables.map((table) => [table.id, [table.labelTemplate, table.keyLabel]]),
  );
  assert.deepEqual(tables, {
    po: ['PO-{id}', true],
    vendor: [undefined, undefined],
    po_line: ['{po_id.number} · {id}', undefined],
    receipt: ['Receipt #{id}', undefined],
  });
});

/* ---------- served ---------- */

const identity = (role: string): Identity => ({ id: `account-${role}`, who: `${role}@example.test`, role });
const sessions: Record<string, Identity> = { manager: identity('manager'), buyer: identity('buyer') };

test("served: a breakdown and a two-hop rollup read the rows under the reader's grants, and a request brings no rollup of its own", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rollups-everywhere-'));
  const path = join(directory, 'orders.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE vendor (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE po (id INTEGER PRIMARY KEY, number TEXT NOT NULL, status TEXT NOT NULL, vendor_id INTEGER NOT NULL REFERENCES vendor(id));
    CREATE TABLE po_line (id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES po(id), amount NUMERIC NOT NULL, state TEXT NOT NULL);
    INSERT INTO vendor VALUES (1, 'Acme'), (2, 'Brio');
    INSERT INTO po VALUES (1, 'PO-1', 'open', 1), (2, 'PO-2', 'open', 1), (3, 'PO-3', 'closed', 2);
    INSERT INTO po_line VALUES (1, 1, 10, 'open'), (2, 1, 30, 'done'), (3, 2, 100, 'open'), (4, 3, 7, 'open');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'orders', name: 'Orders', url: path, source: 'config', writable: false });
  const manifest = parseAppConfig(
    {
      id: 'orders-app',
      name: 'Orders',
      connection: 'orders',
      resources: {
        vendor: { rollups: { lines: { fn: 'sum', from: 'po', column: 'lines' }, orders: { fn: 'count', from: 'po' } } },
        po: { rollups: { lines: { fn: 'count', from: 'po_line' }, total: { fn: 'sum', from: 'po_line', column: 'amount' } } },
        po_line: {},
      },
      // The buyer reads vendors and their orders, never the lines a number would be built from.
      auth: { providers: ['email'], defaultRole: 'buyer', roles: { manager: { read: true }, buyer: { read: ['vendor', 'po'] } } },
      views: { vendors: { kind: 'list', from: 'vendor', show: ['name', 'lines'] } },
      home: 'vendors',
      nav: ['vendors'],
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
    const rows = (reply: { body: Record<string, unknown> }) => reply.body.rows as Array<Record<string, unknown>> | undefined;

    // The manager: two hops in a list, and rollups as a breakdown's measure, key and condition, by text and by def.
    const list = await post('manager', '/api/run', { q: 'vendor show name, lines where lines > 0 sort name', limit: 10 });
    assert.deepEqual(
      rows(list),
      [
        { name: 'Acme', lines: 3 },
        { name: 'Brio', lines: 1 },
      ],
      JSON.stringify(list.body),
    );
    const byText = await post('manager', '/api/breakdown', { text: 'po lines > 0 sum total by status' });
    assert.deepEqual(
      rows(byText),
      [
        { status: 'closed', 'sum(total)': 7 },
        { status: 'open', 'sum(total)': 140 },
      ],
      JSON.stringify(byText.body),
    );
    assert.equal((byText.body.breakdown as BreakdownDef).computed, undefined, "the answer echoes the def asked, not the catalog's rollups");
    const byDef = await post('manager', '/api/breakdown', {
      def: { base: 'vendor', by: [], measures: [{ fn: 'sum', path: 'lines', alias: 'value' }] },
    });
    assert.deepEqual(rows(byDef), [{ value: 4 }], JSON.stringify(byDef.body));
    const batch = await post('manager', '/api/breakdowns', {
      items: [{ text: 'po count by lines' }, { def: { base: 'po', by: [], measures: [{ fn: 'max', path: 'total' }] } }],
    });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const results = (batch.body.results as Array<{ body: { rows?: unknown[] } }>).map((result) => result.body);
    assert.deepEqual(results[0].rows, [
      { lines: 1, count: 2 },
      { lines: 2, count: 1 },
    ]);
    assert.deepEqual(results[1].rows, [{ 'max(total)': 100 }]);

    // The buyer's catalog serves neither the orders' rollups nor the vendors' rollup of them — only the count of orders it may read.
    const catalog = async (who: string) => {
      const res = await fetch(`http://${bound.host}:${bound.port}/api/schema?app=orders-app`, { headers: { cookie: `session=${who}` } });
      return Object.fromEntries(((await res.json()) as DatabaseSchema).tables.map((table) => [table.id, Object.keys(table.rollups ?? {})]));
    };
    assert.deepEqual(await catalog('manager'), { vendor: ['lines', 'orders'], po: ['lines', 'total'], po_line: [] });
    assert.deepEqual(await catalog('buyer'), { vendor: ['orders'], po: [] });
    const allowed = await post('buyer', '/api/breakdown', {
      def: { base: 'vendor', by: [{ path: 'name' }], measures: [{ fn: 'sum', path: 'orders', alias: 'value' }] },
    });
    assert.deepEqual(
      rows(allowed),
      [
        { name: 'Acme', value: 2 },
        { name: 'Brio', value: 1 },
      ],
      JSON.stringify(allowed.body),
    );
    for (const body of [
      { text: 'vendor sum lines' },
      { text: 'po sum total by status' },
      { def: { base: 'po', by: [{ path: 'status' }], measures: [{ fn: 'sum', path: 'total' }] } },
      { def: { base: 'vendor', by: [], measures: [{ fn: 'count' }], filter: { groups: [[{ path: 'lines', op: '>', value: 0 }]] } } },
      // A def that brings its own rollup over the lines: dropped, so there is no such column.
      {
        def: {
          base: 'po',
          by: [],
          measures: [{ fn: 'sum', path: 'secret' }],
          computed: { secret: { fn: 'sum', via: 'po_line.po_id', column: 'amount', type: 'NUMERIC', on: '' } },
        },
      },
      {
        def: {
          base: 'vendor',
          by: [],
          measures: [{ fn: 'sum', path: 'lines' }],
          computed: {
            lines: {
              fn: 'sum',
              via: 'po.vendor_id',
              column: 'lines',
              type: 'integer',
              on: '',
              of: { fn: 'count', via: 'po_line.po_id', type: 'integer' },
            },
          },
        },
      },
    ]) {
      const refused = await post('buyer', '/api/breakdown', body);
      assert.equal(rows(refused), undefined, `${JSON.stringify(body)} → ${JSON.stringify(refused.body)}`);
    }
    const listRefused = await post('buyer', '/api/run', { q: 'vendor show name, lines', limit: 10 });
    assert.equal(rows(listRefused), undefined, JSON.stringify(listRefused.body));
    const forgedView = await post('buyer', '/api/view/run', {
      count: 'none',
      view: {
        id: 'x',
        name: 'x',
        base: 'vendor',
        columns: [{ path: 'lines' }],
        computed: {
          lines: {
            fn: 'sum',
            via: 'po.vendor_id',
            column: 'lines',
            type: 'integer',
            on: '',
            of: { fn: 'count', via: 'po_line.po_id', type: 'integer' },
          },
        },
      },
    });
    assert.equal(rows(forgedView), undefined, JSON.stringify(forgedView.body));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});
