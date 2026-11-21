/**
 * A computed column in a handler's and a loader's `db.<table>.where` (commandDb.ts): `db.task.where('is_overdue = true')`
 * reads the rows a list's `is_overdue` column says yes for, asked where the read executes.
 *
 * The column is no column of the table, so the read carries the expression the reader is served on the filter
 * (`Filter.computed`), its `today` and `now` this read's, and the adapter writes it where the condition names it with
 * the compiler a view uses. The adapter re-checks every node before a word of it reaches a statement, and a grant holds
 * the condition to the columns the expression reads. A column reading through a reference or saying `me`, a sort by
 * one, one compared with another column and one inside `any` are refused by name; a `when` names none. SQLite always;
 * PostgreSQL when `TABLEWALK_TEST_PG` names a disposable server (the schema `computed_where`, dropped before and after).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { AggregateRequest, Filter, QueryRequest, UpdateRequest } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { computedReads, type ComputedColumn, type ComputedType } from '../packages/engine/src/shared/computed.js';
import { parseComputed } from '../packages/engine/src/shared/computedParse.js';
import { buildWhere, renamedAnyRows } from '../packages/engine/src/shared/filter.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { authorizeColumnWrites } from '../packages/engine/src/server/columnGrants.js';
import { assertStructuredReadFilter } from '../packages/engine/src/server/resourceReadOperations.js';
import { ANSI_STYLE } from '../packages/engine/src/adapters/adapter.js';
import { commandCatalog, compileWhere, createCommandDb } from '../packages/mistri/src/server/commands/commandDb.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import { defineLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'computed_where';

type Row = Record<string, unknown>;
interface World {
  id(table: string): string;
  readonly adapter: SqliteAdapter | PostgresAdapter;
  /** The introspected schema with the App's computed columns on task, as an App's catalog serves them. */
  schema(): Promise<DatabaseSchema>;
  close(): Promise<void>;
}

/* Four tasks, two people. Overdue (due long ago, not done): 1 and 4. Over budget (spent - estimate): 3, -3, 0, -6.
   Ends a week after it is due: 2000-01-08, 2000-01-08, 2999-01-08, 2000-06-08. */
function statements(postgres: boolean): string[] {
  const bool = postgres ? 'BOOLEAN' : 'BOOLEAN';
  const [no, yes] = postgres ? ['false', 'true'] : ['0', '1'];
  return [
    `CREATE TABLE person (id INTEGER PRIMARY KEY, region TEXT NOT NULL)`,
    `CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_on DATE NOT NULL, done ${bool} NOT NULL, estimate INTEGER NOT NULL, spent INTEGER NOT NULL, owner TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES person (id))`,
    `INSERT INTO person VALUES (1, 'west'), (2, 'east')`,
    `INSERT INTO task VALUES (1, 'a', '2000-01-01', ${no}, 5, 8, 'ann@example.com', 1), (2, 'b', '2000-01-01', ${yes}, 5, 2, 'bo@example.com', 2), (3, 'c', '2999-01-01', ${no}, 3, 3, 'ann@example.com', 1), (4, 'd', '2000-06-01', ${no}, 10, 4, 'bo@example.com', 2)`,
  ];
}

const DECLARED: Record<string, { type: ComputedType; value: string }> = {
  is_overdue: { type: 'boolean', value: 'due_on < today and not done' },
  over: { type: 'number', value: 'spent - estimate' },
  ends_on: { type: 'date', value: 'due_on + 7 days' },
  owner_region: { type: 'text', value: 'owner_id.region' },
  mine: { type: 'boolean', value: 'owner = me' },
};

function withComputed(schema: DatabaseSchema): DatabaseSchema {
  return {
    ...schema,
    tables: schema.tables.map((table) => {
      if (table.name !== 'task') return table;
      const columns = new Set(table.columns.map((column) => column.name));
      const computed: Record<string, ComputedColumn> = {};
      for (const [name, { type, value }] of Object.entries(DECLARED)) {
        const expr = parseComputed(value, (path) => columns.has(path) || path === 'owner_id.region');
        computed[name] = { type, expr, reads: computedReads(expr) };
      }
      return { ...table, computed };
    }),
  };
}

async function sqliteWorld(): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-computed-where-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  for (const statement of statements(false)) db.exec(statement);
  const adapter = new SqliteAdapter(file, 'cw');
  return {
    id: (table) => table,
    adapter,
    schema: async () => withComputed(await adapter.introspect()),
    async close() {
      await adapter.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function postgresWorld(): Promise<World> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: never }; Client?: never };
  const Client = (pg.Client ?? pg.default?.Client)! as new (c: unknown) => {
    connect(): Promise<void>;
    query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
    end(): Promise<void>;
  };
  const control = new Client({ connectionString: LIVE, statement_timeout: 60_000 });
  await control.connect();
  await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  await control.query(`SET search_path TO ${SCHEMA}`);
  for (const statement of statements(true)) await control.query(statement);
  const adapter = new PostgresAdapter(LIVE!, 'cw', [SCHEMA]);
  return {
    id: (table) => `${SCHEMA}.${table}`,
    adapter,
    schema: async () => withComputed(await adapter.introspect()),
    async close() {
      await adapter.close();
      await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await control.end();
    },
  };
}

const ids = (rows: readonly Row[]) => rows.map((row) => Number(row.id)).sort((a, b) => a - b);
const READS = ['task', 'person'];

type Query = PromiseLike<Row[]> & {
  first(): Promise<Row | undefined>;
  orderBy(column: string, direction?: 'asc' | 'desc'): Query;
  sum(column: string): Promise<string | number>;
  aggregate(measures: object): Promise<Row>;
};
type Handle = {
  where(where: unknown, ...values: unknown[]): Query;
  find(where: unknown): Promise<Row | undefined>;
  count(where: unknown): Promise<number>;
};
type WriteHandle = Handle & { updateWhere(where: unknown, changes: Row): Promise<Row[]>; update(row: Row, changes: Row): Promise<Row> };
type Grant = Parameters<typeof authorizeColumnWrites>[1];

function proofs(open: () => Promise<World>, label: string, skip: false | string = false) {
  describe(`computed columns in a handler's where on ${label}`, { skip }, () => {
    let w: World;
    before(async () => {
      w = await open();
    });
    after(async () => {
      await w?.close();
    });

    /** A handle set over the raw adapter, as a command's is, held to a grant when one is given. */
    const handles = async (grant?: (schema: DatabaseSchema) => Grant) => {
      const schema = await w.schema();
      const catalog = commandCatalog(schema, READS, (local) => w.id(local));
      assert.ok(catalog, 'the catalog builds');
      const physical = (local: string) => w.id(local);
      const below = grant
        ? authorizeColumnWrites(schema, grant(schema), {
            query: (request: never) => w.adapter.query(request),
            count: (table: string, filter?: never) => w.adapter.count(table, filter),
            aggregate: (request: never) => w.adapter.aggregate(request),
          } as never)
        : w.adapter;
      const tx = {
        query: (request: QueryRequest) =>
          below.query({ ...request, table: physical(request.table), filter: renamedAnyRows(request.filter, physical) } as never),
        count: (table: string, filter?: Filter) => below.count(physical(table), renamedAnyRows(filter, physical) as never),
        aggregate: (request: AggregateRequest) =>
          below.aggregate!({ ...request, table: physical(request.table), filter: renamedAnyRows(request.filter, physical) } as never),
      };
      return createCommandDb({ tx: tx as never, catalog, read: READS, write: [], now: () => new Date() }) as unknown as Record<
        string,
        Handle
      >;
    };
    const tasks = async (where: unknown) => ids(await (await handles()).task!.where(where));

    test('the query language and the object form read the rows the computed column says, beside stored columns', async () => {
      assert.deepEqual(await tasks('is_overdue = true'), [1, 4]);
      assert.deepEqual(await tasks('is_overdue = false'), [2, 3]);
      assert.deepEqual(await tasks('over > 0'), [1]);
      assert.deepEqual(await tasks('over >= 0 and estimate < 5'), [3]);
      assert.deepEqual(await tasks('ends_on < 2000-02-01'), [1, 2]);
      assert.deepEqual(await tasks({ is_overdue: true }), [1, 4]);
      assert.deepEqual(await tasks({ over: { gte: 0 } }), [1, 3]);
      assert.deepEqual(await tasks({ over: { lt: 0 }, owner_id: 2 }), [2, 4]);
      assert.deepEqual(await tasks({ ends_on: { lt: '2000-02-01' } }), [1, 2]);
      // A template's value binds; the computed name is the column it compares.
      const db = await handles();
      assert.deepEqual(ids(await db.task!.where`over >= ${0}`), [1, 3]);
      assert.equal(await db.task!.count('is_overdue = true'), 2);
      assert.equal(await db.task!.count({ over: { gt: -4 } }), 3);
      assert.equal((await db.task!.find({ is_overdue: true, owner_id: 2 }))?.id, 4);
      assert.equal(Number(await db.task!.where('is_overdue = true').sum('estimate')), 15);
      // A sort by a stored column beside it is the read's own.
      assert.deepEqual(
        (await db.task!.where({ is_overdue: true }).orderBy('estimate', 'desc')).map((row) => Number(row.id)),
        [4, 1],
      );
      // The rows come back as the table's own: no computed column is written into them.
      assert.equal(Object.hasOwn((await db.task!.find({ is_overdue: true, owner_id: 1 }))!, 'is_overdue'), false);
    });

    test('a column reading through a reference, saying me, a sort, a comparison with a column and one inside any are refused by name', async () => {
      const db = await handles();
      await assert.rejects(
        async () => db.task!.where({ owner_region: 'west' }),
        /"owner_region" reads "owner_id\.region" through a reference/,
      );
      await assert.rejects(async () => db.task!.where('owner_region = west'), /through a reference/);
      await assert.rejects(
        async () => db.task!.where({ mine: true }),
        /"mine" says "me", and a handler's where is handed no one; write actor\.email/,
      );
      await assert.rejects(
        async () => db.task!.where('is_overdue = true sort over'),
        /"over" is a computed column, and a handler's read is ordered by its columns/,
      );
      assert.throws(() => db.task!.where({ is_overdue: true }).orderBy('over'), /"over" is not one of its columns/);
      // A child's conditions read its stored columns, as its EXISTS writes them: none of its computed ones.
      await assert.rejects(async () => db.person!.where('any task where is_overdue = true'), /"is_overdue" is not a column on task/);
      for (const text of ['over > estimate', 'estimate < over'])
        await assert.rejects(
          async () => db.task!.where(text),
          /compared with a value, not with another column|compares a column with a value/,
        );
    });

    test("a where compiled outside a handler's db (a when, a lookup) names no computed column", async () => {
      const catalog = commandCatalog(await w.schema(), READS, (local) => w.id(local))!;
      assert.throws(
        () => compileWhere(catalog.task!, { is_overdue: true }, new Date()),
        /task: "is_overdue" is a computed column, which a where names only in a handler's db\./,
      );
      // In a handler's db, the filter carries the expression with today folded, so the statement compares what a list shows.
      const compiled = compileWhere(catalog.task!, { is_overdue: true }, new Date(), [], undefined, { anyRows: true });
      assert.deepEqual(Object.keys(compiled.filter.computed ?? {}), ['is_overdue']);
      assert.doesNotMatch(JSON.stringify(compiled.filter.computed), /"k":"today"/);
      assert.equal(compileWhere(catalog.task!, { estimate: 5 }, new Date(), [], undefined, { anyRows: true }).filter.computed, undefined);
    });

    test('a command held to its grant reads a computed column only where it reads every column under it', async () => {
      const id = (table: string) => w.id(table);
      const grant = (task: readonly string[]) => () => ({
        readable: new Set(READS.map(id)),
        writable: new Set<string>(),
        fields: new Map([[id('task'), { read: new Set(task), write: new Set<string>() }]]),
      });
      const all = ['id', 'title', 'due_on', 'done', 'estimate', 'spent', 'owner', 'owner_id'];
      const granted = await handles(grant(all));
      assert.deepEqual(ids(await granted.task!.where({ over: { gt: 0 } })), [1]);
      assert.equal(Number(await granted.task!.where('is_overdue = true').sum('estimate')), 15);
      const denied = (error: Error) => error.name === 'AppAccessDenied';
      // "spent" is under "over", and this grant does not read it: the where is refused, never answered without it.
      const narrower = await handles(grant(all.filter((name) => name !== 'spent')));
      await assert.rejects(async () => narrower.task!.where({ over: { gt: 0 } }), denied);
      await assert.rejects(async () => narrower.task!.count('over > 0'), denied);
      await assert.rejects(async () => narrower.task!.where('over > 0').sum('estimate'), denied);
      // A column outside it still reads.
      assert.deepEqual(ids(await narrower.task!.where({ is_overdue: true })), [1, 4]);
    });

    test('the raw adapter refuses an expression the parser never makes, never writes it', async () => {
      const read = (computed: unknown, column = 'x') =>
        w.adapter.query({
          table: w.id('task'),
          limit: 10,
          offset: 0,
          filter: { groups: [[{ column, op: '=', value: true }]], computed } as Filter,
        });
      const path = (name: string) => ({ k: 'path', path: name });
      // An expression the check refuses, or a map that is none (read as no map, then refused by buildWhere), is never written.
      const fault = /This read cannot use (that|a) computed column/;
      await assert.rejects(read({ x: { type: 'boolean', expr: { k: 'call', fn: 'pg_sleep', args: [{ k: 'number', value: 1 }] } } }), fault);
      await assert.rejects(
        read({ x: { type: 'boolean', expr: { k: 'op', op: '; drop', left: path('spent'), right: path('estimate') } } }),
        fault,
      );
      await assert.rejects(read({ x: { type: 'date', expr: { k: 'span', unit: 'eon', of: path('due_on') } } }), fault);
      await assert.rejects(read({ x: { type: 'text', expr: { k: 'json', column: 'title', keys: ["a'b"] } } }), fault);
      await assert.rejects(
        read({ x: { type: 'boolean', expr: { k: 'op', op: '<', left: path('due_on'), right: { k: 'today' } } } }),
        fault,
      );
      await assert.rejects(
        read({ x: { type: 'boolean', expr: { k: 'op', op: '=', left: path('secret'), right: { k: 'number', value: 1 } } } }),
        fault,
      );
      await assert.rejects(read({ estimate: { type: 'number', expr: path('spent') } }, 'estimate'), fault);
      await assert.rejects(read({ x: { type: 'blob', expr: path('spent') } }), fault);
      await assert.rejects(read([]), fault);
      // The well-formed one reads.
      const rows = await read({
        x: { type: 'boolean', expr: { k: 'op', op: '>', left: path('spent'), right: path('estimate') } },
      });
      assert.deepEqual(ids(rows.rows), [1]);
    });

    /** A handle set that writes tasks inside one of the adapter's transactions, as a command's does. */
    const writing = <T>(run: (db: Record<string, WriteHandle>) => Promise<T>) =>
      w.adapter.transaction(async (raw) => {
        const catalog = commandCatalog(await w.schema(), READS, (local) => w.id(local))!;
        const physical = (local: string) => w.id(local);
        const named = (request: UpdateRequest) => ({ ...request, table: physical(request.table) });
        const tx = {
          query: (request: QueryRequest) =>
            raw.query({ ...request, table: physical(request.table), filter: renamedAnyRows(request.filter, physical) }),
          count: (table: string, filter?: Filter) => raw.count(physical(table), renamedAnyRows(filter, physical)),
          update: (request: UpdateRequest) => raw.update(named(request)),
          ...(raw.updateMany ? { updateMany: (requests: readonly UpdateRequest[]) => raw.updateMany!(requests.map(named)) } : {}),
        };
        return run(createCommandDb({ tx: tx as never, catalog, read: READS, write: ['task'], now: () => new Date() }) as never);
      });

    test('updateWhere writes the rows the computed column says, inside a transaction, and leaves the rest', async () => {
      try {
        const written = await writing((db) => db.task!.updateWhere({ is_overdue: true }, { title: 'late' }));
        assert.deepEqual(ids(written), [1, 4]);
        const titles = await writing(async (db) => (await db.task!.where({})).map((row) => `${row.id}:${row.title}`).sort());
        assert.deepEqual(titles, ['1:late', '2:b', '3:c', '4:late']);
      } finally {
        await writing(async (db) => {
          for (const row of await db.task!.where({})) await db.task!.update(row, { title: 'abcd'[Number(row.id) - 1] });
        });
      }
    });

    test("a loader's where reads a computed column through the reader's scoped reads, its row policy beside it", async () => {
      const schema = await w.schema();
      const load = async (where: unknown, scope: RowScope) => {
        const reader = await w.adapter.scopeReads(scope);
        return (await runPageLoader({
          name: 'late',
          loader: defineLoader({
            reads: READS,
            load: async ({ db }: { db: Record<string, Handle> }) => ({
              rows: ids(await db.task!.where(where)),
              count: await db.task!.count(where),
            }),
          } as never) as never,
          reader: { query: reader.query, count: reader.count, aggregate: reader.aggregate },
          schema,
          logical: (local) => w.id(local),
          params: {},
          viewer: { roles: [] },
          now: new Date(),
        })) as { rows: number[]; count: number };
      };
      const everyone: RowScope = { [w.id('task')]: true, [w.id('person')]: true };
      assert.deepEqual(await load({ is_overdue: true }, everyone), { rows: [1, 4], count: 2 });
      assert.deepEqual(await load('over >= 0', everyone), { rows: [1, 3], count: 2 });
      // A row policy that shows owner 1's tasks only: task 4 is overdue but not this reader's.
      const own: RowScope = { ...everyone, [w.id('task')]: { groups: [[{ column: 'owner_id', op: '=', value: 1 }]] } };
      assert.deepEqual(await load({ is_overdue: true }, own), { rows: [1], count: 1 });
    });
  });
}

describe('a computed column on the wire is checked, and a call that does not write it refuses it', () => {
  const computed = { x: { type: 'boolean', expr: { k: 'bool', value: true } } };
  test('buildWhere never reads a computed name as a column', () => {
    assert.throws(
      () => buildWhere({ groups: [[{ column: 'x', op: '=', value: true }]], computed } as Filter, ANSI_STYLE),
      /This read cannot use a computed column/,
    );
  });
  test('the read validator lets a column filter carry its computed columns as a map, and nothing else', () => {
    const groups = [[{ column: 'x', op: '=', value: true }]];
    assertStructuredReadFilter({ groups, computed }, 'column');
    const refused = (filter: object, field: 'column' | 'path' = 'column') =>
      assert.throws(() => assertStructuredReadFilter(filter, field), /Invalid structured filter/);
    refused({ groups: [[{ path: 'x', op: '=', value: true }]], computed }, 'path');
    refused({ groups, computed: [] });
    refused({ groups, computed: null });
    refused({ groups, computed: 'x' });
  });
});

proofs(sqliteWorld, 'SQLite');
proofs(postgresWorld, 'PostgreSQL', liveSkip('postgres', LIVE));
