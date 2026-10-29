/**
 * A condition's right-hand side that names a column, and a record's name as a
 * template — both compiled by the view planner, so both judged here on the
 * statement text for every engine's style and on real rows in SQLite (the
 * live PostgreSQL run are in query-column-values-live.test.ts).
 *
 * The defect this exists for: `on_hand < product_id.reorder_level` passed the
 * App check and compared each quantity with the *text* "product_id.reorder_level",
 * which SQLite answers "less" for every row — a Low tab of all 360.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { ANSI_STYLE, POSTGRES_STYLE, buildWhere } from '../packages/engine/src/shared/filter.js';
import { ANYONE, parseQuery, type QueryPerson } from '../packages/engine/src/shared/query.js';
import { compileView, parseViewQuery, withViewLabels, type ViewDef } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { resolvePath } from '../packages/engine/src/shared/viewPaths.js';
import { labelPath, type DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseLabelTemplate } from '../packages/engine/src/shared/recordLabel.js';

async function inventory(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-column-values-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'inv.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE product (id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT, email TEXT, reorder_level INTEGER, ordered_on DATE);
    CREATE TABLE stock (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product(id), on_hand INTEGER NOT NULL,
      counted_on DATE, low_at INTEGER);
    INSERT INTO product VALUES (1, 'Bolt', 'email', 'a@x.test', 10, '2026-01-01'), (2, 'Nut', 'web', 'b@x.test', 5, '2026-02-01'),
      (3, 'Washer', 'email', 'email', NULL, NULL);
    INSERT INTO stock VALUES (1, 1, 4, '2026-03-01', 6), (2, 1, 20, '2026-03-02', 25), (3, 2, 5, '2026-01-15', 5), (4, 2, 1, NULL, NULL),
      (5, 3, 0, NULL, NULL);
  `);
  db.close();
  const adapter = new SqliteAdapter(file, 'inv');
  t.after(() => adapter.close());
  return { adapter, schema: await adapter.introspect() };
}

test('a plain query names a column or a path on the right, never compares with its text', async (t) => {
  const { schema } = await inventory(t);
  const plain = (text: string) => parseQuery(`stock ${text}`, { schema });
  assert.match(
    plain('on_hand < low_at').errors[0].message,
    /"low_at" is a column, and a condition here compares a column with a value\. Quote it/,
  );
  assert.match(plain('on_hand < product_id.reorder_level').errors[0].message, /"product_id\.reorder_level" is a path/);
  assert.match(
    plain('product_id.name = Bolt').errors[0].message,
    /"product_id\.name" is a path, and a condition here reads only stock's own columns/,
  );
  // Quoted, it is text; a dotted word that is no path of the table is a value.
  assert.deepEqual(plain('on_hand = "low_at"').errors, []);
  assert.deepEqual(parseQuery('product email = a.b', { schema }).query!.filter.groups, [[{ column: 'email', op: '=', value: 'a.b' }]]);
  // Beside text a bare word is its value, even where a column has that name: the tab means the source "email".
  assert.deepEqual(parseQuery('product source = email', { schema }).query!.filter.groups, [
    [{ column: 'source', op: '=', value: 'email' }],
  ]);
});

test('a view compares with another column or a path, of the same kind, and says which one it cannot follow', async (t) => {
  const { schema } = await inventory(t);
  const view = (text: string) => parseViewQuery(schema, 'stock', text);
  assert.deepEqual(view('on_hand < low_at').filter.groups, [[{ path: 'on_hand', op: '<', other: 'low_at' }]]);
  assert.deepEqual(view('on_hand < product_id.reorder_level').filter.groups, [
    [{ path: 'on_hand', op: '<', other: 'product_id.reorder_level' }],
  ]);
  assert.match(
    view('on_hand < product_id.reordr_level').errors[0].message,
    /"reordr_level" is not a column on product\. Did you mean "reorder_level"\?/,
  );
  assert.match(
    view('on_hand < counted_on').errors[0].message,
    /"on_hand" is INTEGER and "counted_on" is DATE, so comparing them says nothing/,
  );
  assert.deepEqual(
    view('on_hand contains product_id.name').filter.groups,
    [[{ path: 'on_hand', op: 'contains', value: 'product_id.name' }]],
    'a text search keeps its words',
  );
  // An API's standing query has no wire form for one, so it refuses by name.
  assert.match(parseViewQuery(schema, 'stock', 'on_hand < low_at', undefined, { columnValues: false }).errors[0].message, /is a column/);
});

test("the comparison runs on real rows, through the bar's view reading and in a breakdown", async (t) => {
  const { adapter, schema } = await inventory(t);
  const low = textToView(schema, 'stock where on_hand < product_id.reorder_level').view!;
  const rows = (await adapter.runView(low)).rows.map((row) => row.id);
  assert.deepEqual(rows.sort(), [1, 4], "below its product's reorder level; a null level is below nothing");
  const local = textToView(schema, 'stock where on_hand <= low_at').view!;
  assert.deepEqual((await adapter.runView(local)).rows.map((row) => row.id).sort(), [1, 2, 3]);
  assert.equal(await adapter.countView(low), 2);
  const counted = textToBreakdown(schema, 'stock on_hand < product_id.reorder_level count').breakdown!;
  assert.equal(Number((await adapter.runBreakdown!(counted)).rows[0].count), 2);
});

test('only a builder that resolves a column comparison may write one', () => {
  const filter = { groups: [[{ column: 'on_hand', op: '<' as const, other: 'low_at' }]] };
  assert.throws(() => buildWhere(filter, ANSI_STYLE), /cannot compare two columns/);
  assert.equal(
    buildWhere(
      filter,
      ANSI_STYLE,
      1,
      (name) => `"t"."${name}"`,
      (name) => `"t"."${name}"`,
    ).text,
    ' WHERE "t"."on_hand" < "t"."low_at"',
  );
  assert.throws(
    () =>
      buildWhere(
        { groups: [[{ column: 'a', op: 'contains' as const, other: 'b' }]] },
        ANSI_STYLE,
        1,
        (n) => n,
        (n) => n,
      ),
    /cannot compare two columns/,
  );
});

test('me is the signed-in person: an email beside text, their row beside a reference to people', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-me-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'me.db'));
  db.exec(`CREATE TABLE employee (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES employee(id), filed_by TEXT, opened_on DATE, priority INTEGER);`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'me.db'), 'me');
  t.after(() => adapter.close());
  const schema: DatabaseSchema = await adapter.introspect();
  const ada: QueryPerson = { email: 'ada@x.test', person: { table: 'employee', key: 2 } };
  const groups = (text: string, me: QueryPerson | null | undefined) =>
    parseQuery(`ticket ${text}`, { schema, ...(me === undefined ? {} : { me }) });
  assert.deepEqual(groups('owner_id = me', ada).query!.filter.groups, [[{ column: 'owner_id', op: '=', value: 2 }]]);
  assert.deepEqual(groups('filed_by = me', ada).query!.filter.groups, [[{ column: 'filed_by', op: '=', value: 'ada@x.test' }]]);
  assert.deepEqual(groups('owner_id in (me, 7)', ada).query!.filter.groups, [[{ column: 'owner_id', op: 'in', value: [2, 7] }]]);
  assert.deepEqual(parseQuery('employee id = me', { schema, me: ada }).query!.filter.groups, [[{ column: 'id', op: '=', value: 2 }]]);
  // Quoted, it is the word. With no person handed in, nobody says whose it is: refused, never read as the word,
  // which made `owner != me` every row on a path that forgot the person.
  assert.deepEqual(groups('filed_by = "me"', ada).query!.filter.groups, [[{ column: 'filed_by', op: '=', value: 'me' }]]);
  for (const text of ['filed_by = me', 'filed_by != me', 'owner_id in (me, 7)'])
    assert.match(groups(text, undefined).errors[0]?.message ?? '', /me is the signed-in person, and nobody is named here/, text);
  // A check before any request reads it as anyone's: the word, judged by the rest of what the text says.
  assert.deepEqual(parseQuery('ticket filed_by = me', { schema, me: ANYONE }).query!.filter.groups, [
    [{ column: 'filed_by', op: '=', value: 'me' }],
  ]);
  // Signed in with no row: nothing is theirs, and everything owned is someone else's.
  const nobody: QueryPerson = { email: 'new@x.test', person: { table: 'employee', key: null } };
  assert.deepEqual(groups('owner_id = me', nobody).query!.filter.groups, [[{ column: 'owner_id', op: 'in', value: [] }]]);
  assert.deepEqual(groups('owner_id != me', nobody).query!.filter.groups, [[{ column: 'owner_id', op: 'isNotNull' }]]);
  // Refused by name, never compared as text.
  assert.match(
    groups('priority = me', ada).errors[0].message,
    /"priority" is INTEGER, and me is the signed-in account's email or their employee row/,
  );
  assert.match(
    groups('owner_id = me', { email: 'ada@x.test' }).errors[0].message,
    /auth: \{ me: \{ from: 'employee', column: 'email' \} \}/,
  );
  assert.match(groups('filed_by = me', { email: null }).errors[0].message, /nobody is signed in/);
  // Through a path, in a view: the path lands on the text column.
  const view = parseViewQuery(schema, 'ticket', 'owner_id.email = me', undefined, { me: ada });
  assert.deepEqual(view.filter.groups, [[{ path: 'owner_id.email', op: '=', value: 'ada@x.test' }]]);
});

test('a record label template is computed in the statement, sorted and searched like a column', async (t) => {
  const { adapter, schema } = await inventory(t);
  const served: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.name === 'product'
        ? { ...table, labelTemplate: "{name} ({id}) O'Neil" }
        : table.name === 'stock'
          ? { ...table, labelTemplate: '{product_id.name} × {on_hand}' }
          : table,
    ),
  };
  assert.equal(
    labelPath(
      served,
      served.tables.find((table) => table.name === 'stock')!,
    ),
    '$label',
  );
  assert.equal(resolvePath(served, 'stock', 'product_id.$label').column.name, '$label');
  assert.throws(() => resolvePath(schema, 'stock', '$label'), /no record label template/);

  const parsed = textToView(served, 'stock show $label, product_id.$label where $label contains Bolt sort $label desc').view!;
  // A template in the request is never the one written: the catalog's replaces it.
  const view = withViewLabels(served, { ...parsed, labels: { '': "') OR 1=1 --" } });
  assert.deepEqual(view.labels, { '': '{product_id.name} × {on_hand}', product_id: "{name} ({id}) O'Neil" });
  const result = await adapter.runView(view);
  assert.deepEqual(result.rows, [
    { $label: 'Bolt × 4', 'product_id.$label': "Bolt (1) O'Neil" },
    { $label: 'Bolt × 20', 'product_id.$label': "Bolt (1) O'Neil" },
  ]);
  // Each engine joins text its own way; a quote in the words is doubled, never a string's end.
  const sql = (style: typeof ANSI_STYLE) =>
    compileView(schema, { ...view, filter: undefined, orderBy: undefined, columns: [{ path: 'product_id.$label' }] }, style).text;
  assert.match(
    sql(ANSI_STYLE),
    /\(COALESCE\(CAST\("product_1"\."name" AS TEXT\), ''\) \|\| ' \(' \|\| COALESCE\(CAST\("product_1"\."id" AS TEXT\), ''\) \|\| '\) O''Neil'\)/,
  );
  assert.match(sql(POSTGRES_STYLE), /COALESCE\(CAST\("product_1"\."name" AS TEXT\), ''\) \|\|/);
  // Without the catalog's template a `$label` names nothing, and the compiler says so rather than guessing.
  assert.throws(
    () => compileView(schema, { id: 'x', name: '', base: 'stock', columns: [{ path: '$label' }] } as ViewDef, ANSI_STYLE),
    /names a record label/,
  );
});

test('a template holds words and columns, and nothing a statement could misread', () => {
  assert.deepEqual(parseLabelTemplate('PO-{id}'), { parts: [{ text: 'PO-' }, { path: 'id' }], paths: ['id'] });
  const problem = (template: string) => {
    const parsed = parseLabelTemplate(template);
    return 'problem' in parsed ? parsed.problem : '';
  };
  assert.match(problem('PO-{id'), /never closes/);
  assert.match(problem('PO-}'), /no "\{" before it/);
  assert.match(problem('No columns'), /names no column/);
  assert.match(problem('a\\b {id}'), /backslash/);
  assert.match(problem('{id; drop}'), /not a column or a reference path/);
});
