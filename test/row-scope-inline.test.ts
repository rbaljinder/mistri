/**
 * A row scope's CTE inlined on Postgres (`AS NOT MATERIALIZED`) and its
 * repeated conditions said once — two changes to how a scope is compiled,
 * neither of which may change which rows it admits.
 *
 * The leak this guards against is the one an optimisation invites: a scope
 * whose predicate is "simplified" until a joined, self-joined or aggregated
 * occurrence of the table reads rows outside it. So every case reads the
 * scoped table more than once in one statement — the shape Postgres used to
 * materialize — and checks the rows against the scope, not against the
 * compiler's own opinion of what it did.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ANSI_STYLE, POSTGRES_STYLE, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { POSTGRES_INLINE_STYLE } from '../packages/engine/src/shared/filter.js';
import { ScopedRelations, type RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

const tenant = (value: string): Filter['groups'][number][number] => ({ column: 'tenant', op: '=', value });
/* A composed scope as a tenant host builds one: ownership, then a membership
   rule that happens to say the same thing, then one that narrows further. */
const composed = (value: string, extra: Filter['groups'][number] = []): Filter => ({ groups: [[tenant(value), tenant(value), ...extra]] });

const catalog: DatabaseSchema = {
  label: 'scope',
  dialect: 'postgres',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      name: 'item',
      schema: 'public',
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'tenant', type: 'text', nullable: false },
      ],
    },
  ],
} as unknown as DatabaseSchema;

test('a Postgres 12+ scope inlines its CTE and says a repeated condition once', () => {
  for (const [style, hint] of [
    [POSTGRES_INLINE_STYLE, ' NOT MATERIALIZED'],
    [POSTGRES_STYLE, ''],
    [ANSI_STYLE, ''],
  ] as const) {
    const relations = new ScopedRelations(catalog, style, { item: composed('north') });
    relations.table('item');
    const { text, params } = relations.finish();
    assert.ok(text.includes(`AS${hint} (SELECT`), `${hint || 'no hint'}: ${text}`);
    assert.deepEqual(params, ['north'], 'the duplicate is dropped');
  }
  // A condition every OR-group holds is said once, before the OR; a group it
  // leaves empty admits every row, so (a AND b AND c) OR (a) is a alone.
  const relations = new ScopedRelations(catalog, POSTGRES_INLINE_STYLE, {
    item: {
      groups: [
        [tenant('north'), { column: 'tenant', op: 'in', value: ['north'] }, { column: 'tenant', op: '!=', value: 'north' }],
        [tenant('north')],
      ],
    },
  });
  relations.table('item');
  assert.deepEqual(relations.finish().params, ['north']);
  // Conditions that differ in any field are all kept, each in its own group.
  const differing = new ScopedRelations(catalog, POSTGRES_INLINE_STYLE, {
    item: {
      groups: [
        [tenant('north'), { column: 'tenant', op: '!=', value: 'south' }],
        [tenant('north'), { column: 'tenant', op: 'in', value: ['east'] }],
      ],
    },
  });
  differing.table('item');
  const kept = differing.finish();
  assert.deepEqual(kept.params, ['north', 'south', 'east']);
  assert.match(kept.text, /= \$1 AND \(\(.+ != \$2\) OR \(.+ IN \(\$3\)\)\)/);
});

/* item(id, tenant, parent_id → item, name); north and south interleaved so a
   self-join or a reverse count that escaped the scope would see the other. */
const ROWS: Array<[number, string, number | null, string]> = [
  [1, 'north', null, 'North root'],
  [2, 'south', null, 'South root'],
  [3, 'north', 1, 'North child'],
  [4, 'south', 1, 'South child of north root'],
  [5, 'north', 2, 'North child of south root'],
  [6, 'north', 3, 'North grandchild'],
];

async function leakChecks(
  reads: Awaited<ReturnType<SqliteAdapter['scopeReads']>>,
  table: string,
  parentFk: string,
  text: (sql: string) => void,
) {
  // The parent path joins the scoped table to itself.
  const view: ViewDef = {
    id: 'tree',
    name: 'Tree',
    base: table,
    columns: [{ path: 'id' }, { path: 'parent_id.name', alias: 'parent' }],
    aggregates: [{ fn: 'count', via: parentFk, alias: 'children' }],
    orderBy: [{ path: 'id', direction: 'asc' }],
  };
  const page = await reads.runView(view);
  text(page.sql.text);
  assert.deepEqual(
    page.rows.map((row) => [Number(row.id), row.parent ?? null, Number(row.children)]),
    [
      [1, null, 1], // North root: its south child is not counted
      [3, 'North root', 1],
      [5, null, 0], // its parent is south: joined as nothing, not as the south row
      [6, 'North child', 0],
    ],
  );
  assert.equal(await reads.countView(view), 4);
  const filtered = await reads.query({
    table,
    columns: ['id'],
    filter: { groups: [[{ column: 'parent_id', op: 'isNotNull' }]] },
    orderBy: [{ column: 'id', direction: 'asc' }],
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(
    filtered.rows.map((row) => Number(row.id)),
    [3, 5, 6],
  );
  assert.equal(await reads.count(table), 4);
  const grouped = await reads.runBreakdown({
    base: table,
    by: [{ path: 'parent_id.name', alias: 'parent' }],
    measures: [{ fn: 'count', alias: 'n' }],
  });
  assert.deepEqual(
    grouped.rows.map((row) => [row.parent ?? null, Number(row.n)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ['North child', 1],
      ['North root', 1],
      [null, 2],
    ],
  );
}

test('a scope with repeated conditions admits exactly its rows through self-joins and reverse counts (SQLite)', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-scope-inline-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'scope.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, parent_id INTEGER REFERENCES item(id), name TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO item VALUES (?, ?, ?, ?)');
  for (const row of ROWS) insert.run(...row);
  db.close();
  const adapter = new SqliteAdapter(file);
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const reads = await adapter.scopeReads({ item: composed('north') } as RowScope);
  await leakChecks(reads, 'item', schema.foreignKeys[0].name, (sql) => assert.doesNotMatch(sql, /MATERIALIZED/));
});

// Deliberately independent of TABLEWALK_TEST_PG and its shared seeded fixtures, as row-scope-live is.
const LIVE_ROW_PG = process.env.TABLEWALK_TEST_ROW_PG;
test(
  'a Postgres scope inlined with NOT MATERIALIZED admits exactly its rows through self-joins and reverse counts',
  {
    skip: !LIVE_ROW_PG && 'Set TABLEWALK_TEST_ROW_PG to an explicitly disposable PostgreSQL database.',
    timeout: 30_000,
  },
  async () => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as unknown as {
      default: {
        Client: new (options: { connectionString: string }) => {
          connect(): Promise<void>;
          query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
          end(): Promise<void>;
        };
      };
    };
    const setup = new pg.default.Client({ connectionString: LIVE_ROW_PG! });
    const schemaName = `tw_inline_${randomUUID().replaceAll('-', '')}`;
    const adapter = new PostgresAdapter(LIVE_ROW_PG!, 'inline scope proof', [schemaName]);
    let created = false;
    try {
      await setup.connect();
      await setup.query(`CREATE SCHEMA "${schemaName}"`);
      created = true;
      await setup.query(`CREATE TABLE "${schemaName}".item (id integer PRIMARY KEY, tenant text NOT NULL,
      parent_id integer REFERENCES "${schemaName}".item(id), name text NOT NULL)`);
      for (const row of ROWS) await setup.query(`INSERT INTO "${schemaName}".item VALUES ($1, $2, $3, $4)`, row);
      const version = Number((await setup.query(`SELECT current_setting('server_version_num')::int AS v`)).rows[0].v);
      const schema = await adapter.introspect();
      const table = `${schemaName}.item`;
      const reads = await adapter.scopeReads({ [table]: composed('north') });
      await leakChecks(reads as never, table, schema.foreignKeys[0].name, (sql) => {
        if (version >= 120_000) assert.match(sql, /AS NOT MATERIALIZED \(SELECT/);
        else assert.doesNotMatch(sql, /MATERIALIZED/);
        assert.equal(sql.match(/"tenant" = \$/g)?.length, 1, 'the repeated condition is said once');
      });
    } finally {
      await adapter.close();
      if (created) await setup.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await setup.end();
    }
  },
);
