/**
 * A list's filters across its related tables (shared/listFilters.ts): a path
 * up a reference (`'account_id.industry_id'`) and the rows that point at the
 * record (`{ has: 'opportunity', filter: 'stage' }`), which the language says
 * as `any opportunity where stage = won`. What the catalog refuses at load,
 * the EXISTS it compiles to on each dialect, the rows and the counts it reads
 * from SQLite, and the grants every hop is held to.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeResources, type ResourceAccess } from '../packages/mistri/src/server/app/appAccess.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import { assertStructuredReadFilter } from '../packages/engine/src/server/resourceReadOperations.js';
import { listFilterProblems, parseAppConfig, resolveViews } from '../packages/mistri/src/shared/app.js';
import { compileBreakdown } from '../packages/engine/src/shared/breakdown.js';
import { breakdownToText, textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { ANSI_STYLE, MYSQL_STYLE, POSTGRES_STYLE, type SqlStyle } from '../packages/engine/src/shared/filter.js';
import { filterAddressWord, filterLabel, hasFilterOf, listFilterKey } from '../packages/engine/src/shared/listFilters.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, compileViewCount, parseViewQuery, PathError, type ViewDef } from '../packages/engine/src/shared/view.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const table = (id: string, columns: object[], extra: object = {}) => ({ id, name: id, schema: '', isView: false, columns, ...extra });
const fk = (from: string, by: string, to: string, extra: object = {}) => ({
  name: `${from}_${by}`,
  from: { table: from, columns: [by] },
  to: { table: to, columns: ['id'] },
  ...extra,
});
const schema = {
  label: 'Sales',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    table('industry', [key('id'), column('name', 'TEXT')]),
    table('account', [key('id'), column('name', 'TEXT'), column('industry_id', 'INTEGER'), column('partner_id', 'INTEGER')]),
    table(
      'opportunity',
      [key('id'), column('account_id', 'INTEGER'), column('partner_id', 'INTEGER'), column('stage', 'TEXT'), column('owner', 'TEXT')],
      { segments: { open: "stage != 'won' and stage != 'lost'" } },
    ),
    table('task', [key('id'), column('account_id', 'INTEGER'), column('due', 'DATE'), column('done', 'INTEGER')]),
    table('tag', [key('id'), column('name', 'TEXT')]),
    table('account_tag', [key('id'), column('account_id', 'INTEGER'), column('tag_id', 'INTEGER')]),
    table('region', [key('id'), column('name', 'TEXT')]),
  ],
  foreignKeys: [
    fk('account', 'industry_id', 'industry'),
    fk('account', 'partner_id', 'region', { stitched: true }),
    fk('opportunity', 'account_id', 'account'),
    fk('opportunity', 'partner_id', 'account'),
    fk('task', 'account_id', 'account'),
    fk('account_tag', 'account_id', 'account'),
    fk('account_tag', 'tag_id', 'tag'),
  ],
} as DatabaseSchema;

/* ---------- the key a filter is held under ---------- */

test('a { has } filter is held as the words of its condition, and its address word reads back', () => {
  assert.equal(listFilterKey('account_id.industry_id', 'v'), 'account_id.industry_id');
  assert.equal(listFilterKey({ has: 'opportunity', filter: 'stage' }, 'v'), 'any opportunity where stage');
  assert.equal(
    listFilterKey({ has: 'opportunity', whose: 'account_id', segment: 'open' }, 'v'),
    'any opportunity via account_id where open',
  );
  assert.throws(() => listFilterKey({ has: 'opportunity' }, 'v'), /names a "filter" .* or a "segment" .* one of them/);
  assert.throws(() => listFilterKey({ has: 'opportunity', filter: 'stage', segment: 'open' }, 'v'), /one of them/);
  assert.throws(() => listFilterKey({ has: 'opportunity', column: 'stage' }, 'v'), /a filter with "column"/);
  assert.throws(() => listFilterKey({ filter: 'stage' }, 'v'), /without the table it asks about/);
  assert.throws(() => listFilterKey({ has: 'opportunity', via: 'account_id', filter: 'stage' }, 'v'), /"via", which is now "whose"/);
  assert.deepEqual(hasFilterOf('any opportunity via partner_id where account_id.name'), {
    child: 'opportunity',
    via: 'partner_id',
    asks: 'account_id.name',
  });
  assert.equal(hasFilterOf('account_id.industry_id'), undefined);
  // A whole condition with a tail is a question, not a filter's key.
  assert.equal(hasFilterOf('any opportunity where stage = won'), undefined);
  assert.equal(filterAddressWord('any opportunity via partner_id where stage'), 'has.opportunity.partner_id.stage');
  assert.equal(filterAddressWord('account_id.industry_id'), 'account_id.industry_id');
});

test("a path's facet is called by the record it reaches, and by whose it is where that name is taken", () => {
  const captions: Record<string, string> = {
    industry_id: 'Industry',
    'account_id.industry_id': 'Industry',
    account_id: 'Account',
    stage: 'Stage',
  };
  const caption = (path: string) => captions[path] ?? path;
  assert.equal(filterLabel('account_id.industry_id', caption, ['stage', 'account_id.industry_id']), 'Industry');
  assert.equal(filterLabel('account_id.industry_id', caption, ['industry_id', 'account_id.industry_id']), 'Account industry');
});

/* ---------- refused at load, one problem each ---------- */

const app = (filters: unknown[]) =>
  parseAppConfig(
    {
      name: 'Sales',
      resources: Object.fromEntries(schema.tables.map((t) => [t.id, {}])),
      views: { accounts: { kind: 'list', from: 'account', filters } },
      home: 'accounts',
      nav: ['accounts'],
    },
    'filters',
  );
const problems = (filter: unknown) => listFilterProblems(app([filter]), schema);

test('a filter that cannot be read across its tables is one clear problem at load', () => {
  assert.deepEqual(problems('industry_id.name'), []);
  assert.deepEqual(problems({ has: 'opportunity', whose: 'account_id', filter: 'stage' }), []);
  assert.deepEqual(problems({ has: 'account_tag', filter: 'tag_id' }), []);
  assert.deepEqual(problems({ has: 'task', filter: 'account_id.industry_id' }), []);
  assert.deepEqual(problems({ has: 'opportunity', whose: 'account_id', segment: 'open' }), []);
  const one = (filter: unknown, pattern: RegExp) => {
    const said = problems(filter);
    assert.equal(said.length, 1, said.join('\n'));
    assert.match(said[0], /^view "accounts": This view's filter "/);
    assert.match(said[0], pattern);
  };
  one({ has: 'invoice', filter: 'total' }, /No table called "invoice"/);
  one({ has: 'opportunity', filter: 'stage' }, /through account_id and partner_id: say which — any opportunity via account_id/);
  one('name.industry_id', /name/);
  one('partner_id.name', /stitched|another source|partner_id/);
  one({ has: 'opportunity', whose: 'account_id', segment: 'stale' }, /opportunity has no column or segment "stale"/);
  one({ has: 'task', filter: 'due' }, /"due" of task is date.*segment of task/);
});

test("a reader who cannot read a filter's table is served the list without that filter", () => {
  const reader = { ...schema, tables: schema.tables.filter((t) => t.id !== 'opportunity' && t.id !== 'industry') } as DatabaseSchema;
  const served = resolveViews(app(['name', 'industry_id.name', { has: 'opportunity', whose: 'account_id', filter: 'stage' }]), reader);
  const accounts = served.accounts as { error?: string; filters?: string[] };
  assert.equal(accounts.error, undefined);
  assert.deepEqual(accounts.filters, ['name']);
});

/* ---------- the statement ---------- */

const asked = (question: string, base = 'account') => {
  const parsed = parseViewQuery(schema, base, question);
  assert.deepEqual(parsed.errors, [], question);
  return { id: 'rows', name: 'Rows', base, columns: [{ path: 'name' }], filter: parsed.filter } as ViewDef;
};

test('any is an EXISTS over the rows that point at the record, no is NOT EXISTS, on every dialect', () => {
  for (const [style, q] of [
    [ANSI_STYLE, '"'],
    [POSTGRES_STYLE, '"'],
    [MYSQL_STYLE, '`'],
  ] as Array<[SqlStyle, string]>) {
    const { text } = compileViewCount(schema, asked('any opportunity via account_id where stage = won'), style);
    const child = `${q}opportunity_\\d+${q}`;
    assert.match(
      text,
      new RegExp(
        `WHERE EXISTS \\(SELECT 1 FROM ${q}[^ ]+${q} ${child} WHERE ${child}\\.${q}account_id${q} = ${q}account_\\d+${q}\\.${q}id${q}\\)`,
      ),
      text,
    );
    assert.match(compileViewCount(schema, asked('no task'), style).text, /NOT EXISTS \(SELECT 1 FROM /);
  }
  const ambiguous = parseViewQuery(schema, 'account', 'any opportunity where stage = won');
  assert.match(ambiguous.errors[0].message, /say which — any opportunity via account_id/);
  // A sort after the rows' condition is the list's own, read against the record.
  assert.deepEqual(parseViewQuery(schema, 'account', 'any opportunity via account_id where stage = won sort name').errors, []);
  assert.match(
    parseViewQuery(schema, 'account', 'any opportunity via account_id where stage = won sort stage').errors[0].message,
    /"stage" is not a column on account/,
  );
});

async function database(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-cross-filters-'));
  const path = join(dir, 'sales.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE industry (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE region (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT, industry_id INTEGER REFERENCES industry(id), partner_id INTEGER);
    CREATE TABLE opportunity (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), partner_id INTEGER REFERENCES account(id),
      stage TEXT, owner TEXT);
    CREATE TABLE task (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), due DATE, done INTEGER);
    CREATE TABLE tag (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE account_tag (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), tag_id INTEGER REFERENCES tag(id));
    INSERT INTO industry VALUES (1, 'Energy'), (2, 'Retail');
    INSERT INTO account VALUES (1, 'Acme', 1, NULL), (2, 'Brio', 2, NULL), (3, 'Cato', 1, NULL), (4, 'Dune', 2, NULL);
    -- Acme won twice and is negotiating; Brio negotiates; Cato only partners on a win; Dune has nothing.
    INSERT INTO opportunity VALUES (1, 1, NULL, 'won', 'ana'), (2, 1, NULL, 'won', 'ben'), (3, 1, 3, 'negotiation', 'ben'),
      (4, 2, NULL, 'negotiation', 'ana'), (5, NULL, 3, 'won', 'ana');
    INSERT INTO task VALUES (1, 1, '2026-10-01', 0), (2, 3, '2026-10-02', 1);
    INSERT INTO tag VALUES (1, 'Key'), (2, 'Churn risk');
    INSERT INTO account_tag VALUES (1, 1, 1), (2, 2, 1), (3, 2, 2);
  `);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const names = (question: string) => {
    const { text, params } = compileView(schema, { ...asked(question), orderBy: [{ path: 'name', direction: 'asc' }] }, ANSI_STYLE);
    return db
      .prepare(text)
      .all(...(params as never[]))
      .map((row) => row.name);
  };
  const count = (question: string) => {
    const { text, params } = compileViewCount(schema, asked(question), ANSI_STYLE);
    return Number(Object.values(db.prepare(text).get(...(params as never[]))!)[0]);
  };
  return { path, db, names, count };
}

test('SQLite reads the records whose rows match, each record once', async (t) => {
  const { db, names, count } = await database(t);
  assert.deepEqual(names('any opportunity via account_id where stage = won'), ['Acme']);
  assert.deepEqual(names('any opportunity via partner_id where stage = won'), ['Cato']);
  assert.deepEqual(names('no opportunity via account_id'), ['Cato', 'Dune']);
  // m2m: the link rows name a tag; a path up from the child reads the tag's own name.
  assert.deepEqual(names('any account_tag where tag_id = 2'), ['Brio']);
  assert.deepEqual(names('any account_tag where tag_id.name = Key'), ['Acme', 'Brio']);
  // A segment of the child, as a has segment facet writes it.
  assert.deepEqual(names('any opportunity via account_id where open'), ['Acme', 'Brio']);
  // Two has filters each hold of a row of their own: Acme won one and negotiates another.
  assert.deepEqual(names('any opportunity via account_id where stage = won and any opportunity via account_id where stage = negotiation'), [
    'Acme',
  ]);
  // One row holding both is one condition inside one any.
  assert.deepEqual(names('any opportunity via account_id where (stage = won and stage = negotiation)'), []);
  // OR across groups, and a path up the record beside the rows below it.
  assert.deepEqual(names('industry_id.name = Energy and any task where done = 0'), ['Acme']);
  // Counts are distinct records: Acme's two wins count it once, as the rail's per-value count asks.
  assert.equal(count('any opportunity via account_id where stage = won'), 1);
  assert.equal(count('any opportunity via account_id where stage in (won, negotiation)'), 2);
  const grouped = textToBreakdown(schema, 'account any opportunity via account_id where stage = won count by industry_id', {});
  assert.deepEqual(grouped.errors, []);
  const { text, params } = compileBreakdown(schema, grouped.breakdown!, ANSI_STYLE);
  const rows = db.prepare(text).all(...(params as never[]));
  assert.equal(rows.length, 1);
  assert.equal(Object.values(rows[0]).filter((v) => v === 1).length >= 2, true, JSON.stringify(rows));
});

/* ---------- grants on every hop ---------- */

test("the rows inside any are the reader's own rows, and a hop the reader cannot read is refused", async (t) => {
  const { path } = await database(t);
  const raw = new SqliteAdapter(path, 'main');
  t.after(() => raw.close());
  const runtime = createAppSourceAdapter(
    {
      main: {
        adapter: raw,
        schema: await raw.introspect(),
        writable: false,
        resources: Object.fromEntries(schema.tables.map((t) => [t.id, t.id])),
      },
    },
    'main',
  );
  const resources: RuntimeResources = {
    ...runtime,
    connections: ['main'],
    connectionFor: (name) => runtime.resolve(name).source,
    toPhysical: (name) => runtime.resolve(name).physicalTable,
    toLogical: (name) => runtime.catalogs.get('main')!.toLogical(name),
    toLogicalAt: (name) => runtime.catalogs.get('main')!.toLogical(name),
    forConnection: (owner) => runtime.forSource(owner),
  };
  const equal = (column: string, value: string): Filter => ({ groups: [[{ column, op: '=', value }]] });
  const everything = (tables: string[], hidden: string[] = []): ResourceAccess => ({
    readable: new Set(tables),
    writable: new Set(),
    rows: Object.fromEntries(tables.map((t) => [t, t === 'opportunity' ? equal('owner', 'ana') : true])),
    fields: new Map(
      runtime.schema.tables.map((t) => [
        t.id,
        { read: new Set(t.columns.map((c) => c.name).filter((c) => !hidden.includes(`${t.id}.${c}`))), write: new Set<string>() },
      ]),
    ),
  });
  const view = (question: string) => {
    const parsed = parseViewQuery(runtime.schema, 'account', question);
    assert.deepEqual(parsed.errors, []);
    return { id: 'rows', name: 'Rows', base: 'account', columns: [{ path: 'name' }], filter: parsed.filter } as ViewDef;
  };
  const all = ['industry', 'account', 'opportunity', 'task', 'tag', 'account_tag'];
  const reader = authorizeResources(resources, everything(all)).adapter;
  // Ana owns one of Acme's wins and Brio's negotiation: ben's rows are not hers to ask about.
  const won = view('any opportunity via account_id where stage = won');
  assert.deepEqual((await reader.runView!(won)).rows, [{ name: 'Acme' }]);
  const negotiating = view('any opportunity via account_id where stage = negotiation');
  assert.deepEqual((await reader.runView!(negotiating)).rows, [{ name: 'Brio' }]);
  assert.equal(await reader.countView!(negotiating), 1);
  // No opportunity of hers: Acme's negotiation is ben's.
  assert.deepEqual(
    (
      (await reader.runView!({ ...view('no opportunity via account_id'), orderBy: [{ path: 'name', direction: 'asc' }] })).rows as Array<{
        name: string;
      }>
    ).map((r) => r.name),
    ['Cato', 'Dune'],
  );
  const refused = (error: unknown) => error instanceof Refusal || error instanceof PathError;
  // Without the child table, or the column it asks, there is nothing to ask.
  await assert.rejects(
    async () => authorizeResources(resources, everything(all.filter((t) => t !== 'opportunity'))).adapter.runView!(won),
    refused,
  );
  await assert.rejects(async () => authorizeResources(resources, everything(all, ['opportunity.stage'])).adapter.runView!(won), refused);
  await assert.rejects(
    async () => authorizeResources(resources, everything(all, ['opportunity.account_id'])).adapter.runView!(won),
    refused,
  );
  // A path up from the child is held to the parent it reaches.
  const tagged = view('any account_tag where tag_id.name = Key');
  assert.equal((await reader.runView!(tagged)).rows.length, 2);
  await assert.rejects(async () => authorizeResources(resources, everything(all, ['tag.name'])).adapter.runView!(tagged), refused);
});

test('a read carries the rows its condition asks about, and says them back in the words they were asked in', () => {
  const said = textToBreakdown(schema, 'account no task and any opportunity via account_id where (stage = won and owner = ana) count', {});
  assert.deepEqual(said.errors, []);
  assertStructuredReadFilter(said.breakdown!.filter, 'path');
  const again = textToBreakdown(schema, breakdownToText(schema, said.breakdown!), {});
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.breakdown!.filter, said.breakdown!.filter);
  const condition = said.breakdown!.filter!.groups[0][1];
  const refused = (any: unknown, extra: object = {}) =>
    assert.throws(() => assertStructuredReadFilter({ groups: [[{ ...condition, ...extra, any }]] }, 'path'), /Invalid structured filter/);
  refused({ via: 'opportunity' });
  refused({ via: 'opportunity.account_id', filter: { groups: [[{ column: 'stage', op: '=', value: { sql: 1 } }]] } });
  refused({ via: 'opportunity.account_id', where: 'stage = won' });
  refused({ via: 'opportunity.account_id' }, { op: '=', value: 1 });
});
