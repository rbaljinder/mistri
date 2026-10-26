/**
 * What each choice in an App list's column menu asks the database.
 *
 * The menu and its Filter… popover write the query language through the
 * rail's own rules (filterRailModel, filterbar's withCondition, clauses'
 * nextSort); this is the other end: each choice's question, parsed by the
 * server's reader, compiled for PostgreSQL (the target that matters), and
 * run on a SQLite fixture, so the words a reader picked are the rows they get.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { compileView, parseViewQuery } from '../packages/engine/src/shared/view.js';
import { POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { nextSort } from '../packages/kit/src/client/clauses.js';
import { withCondition } from '../packages/kit/src/client/filterbar.js';
import { moreTail, numberRangeTail, rangeTail, valuesTail } from '../packages/kit/src/client/components/filterRailModel.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const DIR = mkdtempSync(join(tmpdir(), 'tablewalk-colmenu-'));
const FILE = join(DIR, 'tasks.db');
let adapter: SqliteAdapter;
let schema: DatabaseSchema;
const NOW = new Date(2026, 8, 25, 12, 0, 0);

before(async () => {
  const db = new DatabaseSync(FILE);
  db.exec(`
    CREATE TABLE rep (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE task (
      id INTEGER PRIMARY KEY, title TEXT, status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'done')),
      due_on DATE, estimate INTEGER, owner_id INTEGER REFERENCES rep(id));
    CREATE INDEX task_owner ON task(owner_id);
    INSERT INTO rep VALUES (1, 'Nia Andersen'), (2, 'Tariq Osei');
    INSERT INTO task VALUES
      (1, 'Harbor survey', 'open', '2026-09-20', 3, 2),
      (2, 'Harvest plan', 'done', '2026-09-28', 8, 1),
      (3, 'Wharf repair', 'in_progress', NULL, 13, 1),
      (4, NULL, 'open', '2026-10-02', NULL, 2);
  `);
  db.close();
  adapter = new SqliteAdapter(FILE, 'tasks');
  schema = await adapter.introspect();
});
after(async () => {
  await adapter.close();
  rmSync(DIR, { recursive: true, force: true });
});

/** A whole question as the list asks it: its conditions, its sort, the SQL for Postgres and the ids SQLite returns. */
async function ask(question: string) {
  const parsed = parseViewQuery(schema, 'task', question, NOW);
  assert.deepEqual(parsed.errors, [], question);
  const view = {
    id: 'v',
    name: 'v',
    base: 'task',
    columns: [{ path: 'id' }],
    filter: parsed.filter,
    orderBy: parsed.orderBy?.length ? parsed.orderBy : [{ path: 'id', direction: 'asc' as const }],
    limit: 100,
  };
  const sql = compileView(schema, view, POSTGRES_STYLE);
  const result = await adapter.runView(view);
  return { sql: sql.text.replace(/\s+/g, ' '), params: sql.params, ids: result.rows.map((row) => row.id) };
}
const narrowed = (column: string, tail: string) => withCondition('', column, tail) as string;

describe('the sorts', () => {
  test('a figure High → low, a reference by the name it is drawn by', async () => {
    const high = await ask((nextSort('task', 'estimate', 'desc') as string).slice('task '.length));
    assert.match(high.sql, /ORDER BY "\w+"\."estimate" DESC/);
    // SQLite puts an empty figure first going down.
    assert.deepEqual(high.ids, [3, 2, 1, 4]);
    const byName = await ask((nextSort('task', 'owner_id.name', 'asc') as string).slice('task '.length));
    assert.match(byName.sql, /JOIN "rep"/);
    assert.match(byName.sql, /ORDER BY "\w+"\."name" ASC/);
    assert.deepEqual(byName.ids.slice(0, 2).sort(), [2, 3]);
  });
});

describe('Filter…', () => {
  test('a checklist of two values is one IN, bound', async () => {
    const { sql, params, ids } = await ask(narrowed('status', valuesTail(['open', 'done'])));
    assert.match(sql, /"status" IN \(\$1, \$2\)/);
    assert.deepEqual(params.slice(0, 2), ['open', 'done']);
    assert.deepEqual(ids, [1, 2, 4]);
  });

  test('a range of figures is both ends inclusive; a date range too', async () => {
    const figures = await ask(narrowed('estimate', numberRangeTail('5', '13')));
    assert.match(figures.sql, /"estimate" >= \$1 AND "\w+"\."estimate" <= \$2/);
    assert.deepEqual(figures.ids, [2, 3]);
    const dates = await ask(narrowed('due_on', rangeTail('2026-09-21', '2026-10-02')));
    assert.deepEqual(dates.ids, [2, 4]);
  });

  test('a date preset resolves on the server: overdue is before today', async () => {
    const { ids } = await ask(narrowed('due_on', '< today'));
    assert.deepEqual(ids, [1]);
  });

  test('contains matches anywhere, any case', async () => {
    const { ids } = await ask(narrowed('title', 'contains HAR'));
    assert.deepEqual(ids, [1, 2, 3]);
  });
});

describe('More conditions', () => {
  test('starts with is a prefix, its wildcards escaped; a pattern keeps them', async () => {
    const prefix = await ask(narrowed('title', moreTail('startswith', 'Har')));
    assert.deepEqual(prefix.ids, [1, 2]);
    const pattern = await ask(narrowed('title', moreTail('like', '%sur_ey')));
    assert.deepEqual(pattern.ids, [1]);
    // A % typed into "starts with" is a character, not a wildcard.
    assert.deepEqual((await ask(narrowed('title', moreTail('startswith', '%ar')))).ids, []);
  });

  test('empty and not empty are IS NULL and IS NOT NULL', async () => {
    const empty = await ask(narrowed('estimate', moreTail('empty')));
    assert.match(empty.sql, /"estimate" IS NULL/);
    assert.deepEqual(empty.ids, [4]);
    const filled = await ask(narrowed('due_on', moreTail('notempty')));
    assert.deepEqual(filled.ids, [1, 2, 4]);
  });

  test('Clear filter takes the column out and leaves the rest of the question', async () => {
    const both = withCondition(narrowed('status', valuesTail(['open'])), 'title', moreTail('startswith', 'Har')) as string;
    assert.deepEqual((await ask(both)).ids, [1]);
    assert.deepEqual((await ask(withCondition(both, 'title', '') as string)).ids, [1, 4]);
  });
});
