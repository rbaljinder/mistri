/**
 * A field report: a list grouped by a reference joins the group's table to name each group, and the groups are sorted
 * with the empty one last. That ORDER BY tested the key's output name inside an expression, which PostgreSQL reads as
 * an input column: ambiguous when the joined table has a column of the key's own name (items grouped by `hold_id`,
 * `holds` having a `hold_id`), and the page said "This list could not be read". `check` cannot see it; only the run does.
 */
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { connect } from '../packages/engine/src/adapters/connect.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';

const dir = mkdtempSync(join(tmpdir(), 'tw-group-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const ddl = (serial: string) => `
CREATE TABLE holds (id ${serial} PRIMARY KEY, hold_id INTEGER, name TEXT);
CREATE TABLE items (id ${serial} PRIMARY KEY, hold_id INTEGER REFERENCES holds(id), label TEXT);
INSERT INTO holds (hold_id, name) VALUES (5, 'Alpha'), (6, 'Beta');
INSERT INTO items (hold_id, label) VALUES (1, 'a'), (1, 'b'), (2, 'c'), (NULL, 'd');`;

const grouped = (base: string): BreakdownDef =>
  ({
    base,
    by: [{ path: 'hold_id' }],
    measures: [{ fn: 'count' }],
    names: { hold_id: 'hold_id.name' },
    /* The empty group last, then the groups by their key: without the second entry only the empty group is placed and
       the rest come in whatever order the engine's plan gives (SQLite's key order; PostgreSQL's hash). */
    orderBy: [
      { name: 'hold_id', direction: 'asc', emptyLast: true },
      { name: 'hold_id', direction: 'asc' },
    ],
    limit: 10,
  }) as unknown as BreakdownDef;

/* The same list as pagePaths builds it: sorted by the group table's own same-named column, and filtered by it. */
async function checkSorted(adapter: ReturnType<typeof connect>, base: string) {
  const def = {
    base,
    by: [{ path: 'hold_id' }],
    measures: [
      { fn: 'count', alias: 'group_rows' },
      { fn: 'max', path: 'hold_id.hold_id', alias: 'group_order' },
    ],
    names: { hold_id: 'hold_id.name' },
    filter: { groups: [[{ path: 'hold_id.hold_id', op: '>', value: 4 }]] },
    orderBy: [
      { name: 'hold_id', direction: 'asc', emptyLast: true },
      { name: 'group_order', direction: 'desc' },
    ],
    limit: 10,
  } as unknown as BreakdownDef;
  const ran = await adapter.runBreakdown!(def, 0);
  assert.deepEqual(
    ran.rows.map((row) => row['hold_id.$label']),
    ['Beta', 'Alpha'],
    'by the group table\u2019s own column, descending',
  );
  assert.equal(await adapter.countBreakdown!(def, 100), 2);
}

async function check(adapter: ReturnType<typeof connect>, base: string) {
  const ran = await adapter.runBreakdown!(grouped(base), 0);
  assert.doesNotMatch(ran.sql.text, /\(\s*"?hold_id"?\s+IS NULL\)/, 'the key is tested by its expression, not its output name');
  assert.match(ran.sql.text, /ORDER BY \("?[\w]+_0"?\."?hold_id"? IS NULL\) ASC/);
  assert.deepEqual(
    ran.rows.map((row) => row['hold_id.$label'] ?? null),
    ['Alpha', 'Beta', null],
    'named, and the empty group last',
  );
  assert.equal(await adapter.countBreakdown!(grouped(base), 100), 3);
  await checkSorted(adapter, base);
}

describe('a grouped list whose group table has a column of the key’s name', () => {
  test('SQLite', async () => {
    const file = join(dir, 'g.db');
    const db = new DatabaseSync(file);
    db.exec(ddl('INTEGER'));
    db.close();
    const adapter = connect(file, { schemas: [] });
    try {
      await check(adapter, 'items');
    } finally {
      await adapter.close();
    }
  });

  const PG = process.env.TABLEWALK_TEST_PG;
  test('PostgreSQL', { skip: PG ? false : 'TABLEWALK_TEST_PG is not set' }, async () => {
    type Client = { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> };
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const scratch = `tw_group_${process.pid}`;
    const client = new pg.default.Client({ connectionString: PG });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE; CREATE SCHEMA ${scratch}; SET search_path TO ${scratch};`);
      await client.query(ddl('SERIAL'));
      const adapter = connect(PG!, { schemas: [scratch] });
      try {
        await check(adapter, `${scratch}.items`); // a table id carries its schema on Postgres;
      } finally {
        await adapter.close();
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
      await client.end();
    }
  });
});
