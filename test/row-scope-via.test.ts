/**
 * A row scope that reads through a relationship (`via`, rowScope.ts): "a customer sees the messages on their own
 * cases" said without listing the cases, and a tree said as "the folders I own and everything beneath them".
 *
 * The compile and the refusals are proved over a catalog alone; the reads, the writes and the trees run against a
 * real database: SQLite always, and PostgreSQL when `TABLEWALK_TEST_PG` names a disposable server (the tables live in
 * the schema `via_scope`, dropped before and after). The sizes are the design's: 5,000 parents, a tree 50 deep.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { ANSI_STYLE, POSTGRES_STYLE, Refusal, type SqlStyle } from '../packages/engine/src/adapters/adapter.js';
import { POSTGRES_INLINE_STYLE } from '../packages/engine/src/shared/filter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import { ScopedRelations, rowScopeViaAdvisories, snapshotRowScope, via, type RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView } from '../packages/engine/src/shared/view.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'via_scope';

/* ---------- over a catalog alone: the refusals (4, 17) and the compile (11) ---------- */

const chain: DatabaseSchema = {
  label: 'via chain',
  dialect: 'sqlite',
  readAt: '2026-11-07T00:00:00Z',
  tables: Array.from({ length: 11 }, (_, i) => ({
    id: `t${i}`,
    schema: '',
    name: `t${i}`,
    isView: false,
    columns: ['id', 'next_id', 'owner_id', 'k1', 'k2'].map((name) => ({
      name,
      type: 'integer',
      nullable: true,
      primaryKey: name === 'id',
    })),
  })),
  foreignKeys: [],
};
const refused = (input: unknown, message: RegExp) =>
  assert.throws(
    () => snapshotRowScope(chain, input as RowScope),
    (error: Error) => error instanceof Refusal && message.test(error.message),
  );
const link = (to: string, column = 'next_id') => ({ groups: [[via(column, to)]] });

describe('a via is validated before it is compiled', () => {
  test('on PostgreSQL a text column against an integer key is refused, naming both columns and their types', () => {
    const pg: DatabaseSchema = {
      ...chain,
      dialect: 'postgres',
      tables: ['child', 'parent'].map((id) => ({
        id,
        schema: '',
        name: id,
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'ref', type: id === 'child' ? 'text' : 'integer', nullable: true, primaryKey: false },
        ],
      })),
    };
    const rule = (column: string): RowScope => ({ child: { groups: [[via(column, 'parent', 'id')]] }, parent: true });
    assert.throws(
      () => snapshotRowScope(pg, rule('ref')),
      (error: Error) =>
        error instanceof Refusal && /child\.ref \(text\) with parent\.id \(integer\): the types do not compare/.test(error.message),
    );
    // Integer against bigint is one family; the same text on SQLite is the engine's own affinity to judge.
    snapshotRowScope(
      {
        ...pg,
        tables: pg.tables.map((t) => ({
          ...t,
          columns: t.columns.map((c) => ({ ...c, type: c.name === 'id' && t.id === 'parent' ? 'bigint' : 'integer' })),
        })),
      },
      rule('id'),
    );
    snapshotRowScope({ ...pg, dialect: 'sqlite' }, rule('ref'));
  });

  test('a chain of 8 hops stands and 9 is refused; a table that names itself is one hop', () => {
    const hops = (n: number): RowScope => ({
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, link(`t${i + 1}`)])),
      [`t${n}`]: true,
    });
    assert.doesNotThrow(() => snapshotRowScope(chain, hops(8)));
    refused(hops(9), /chain 9 hops; the bound is 8/);
    const tree = (n: number): RowScope => ({
      ...hops(n),
      [`t${n}`]: { groups: [[{ column: 'owner_id', op: '=', value: 1 }], [via('next_id', `t${n}`)]] },
    });
    assert.doesNotThrow(() => snapshotRowScope(chain, tree(7)));
    refused(tree(8), /chain 9 hops/);
  });

  test('a loop across tables is refused, and the refusal names it', () => {
    refused({ t0: link('t1'), t1: link('t0') }, /loop back: "t0" -> "t1" -> "t0"/);
    refused({ t0: link('t1'), t1: link('t2'), t2: link('t0') }, /"t0" -> "t1" -> "t2" -> "t0"/);
  });

  test('only "in" is a via, a target and its columns must exist and a composite key must pair up', () => {
    const rule = (condition: unknown) => ({ t0: { groups: [[condition]] }, t1: true });
    const target = { resource: 't1', column: 'id' };
    refused(rule({ column: 'next_id', op: 'notIn', via: target }), /takes only the operator "in", not "notIn"/);
    refused(rule({ column: 'next_id', op: '!=', via: target }), /takes only the operator "in"/);
    refused(rule({ column: 'next_id', op: 'in', via: { ...target, resource: 'nope' } }), /names "nope", which this catalog does not have/);
    refused(rule({ column: 'missing', op: 'in', via: target }), /names a column that "t0" does not have/);
    refused(rule({ column: 'next_id', op: 'in', via: { ...target, column: 'missing' } }), /names a column that "t1" does not have/);
    refused(rule({ column: ['k1', 'k2'], op: 'in', via: target }), /compares 2 columns with 1 of "t1"/);
    refused(rule({ column: [], op: 'in', via: target }), /names none/);
    refused(rule({ column: ['k1', 'k1'], op: 'in', via: { resource: 't1', column: ['k1', 'k2'] } }), /names one twice/);
    assert.throws(() => snapshotRowScope(chain, rule({ column: 'next_id', op: 'in', via: { ...target, extra: 1 } }) as RowScope), Refusal);
    assert.throws(() => snapshotRowScope(chain, rule({ column: 'next_id', op: 'in', via: target, value: [1] }) as RowScope), Refusal);
    assert.throws(() => snapshotRowScope(chain, rule({ column: 'next_id', op: 'in', via: { ...target, where: [] } }) as RowScope), Refusal);
    // A composite key pairs up; the target's filter takes literals only.
    assert.doesNotThrow(() => snapshotRowScope(chain, { t0: { groups: [[via(['k1', 'k2'], 't1', ['k1', 'k2'])]] }, t1: true }));
    refused(
      { t0: { groups: [[via('next_id', 't1', 'id', [[via('next_id', 't2')]] as never)]] }, t1: true, t2: true },
      /filters "t1" by another "via"/,
    );
    assert.doesNotThrow(() =>
      snapshotRowScope(chain, { t0: { groups: [[via('next_id', 't1', 'id', [[{ column: 'owner_id', op: '=', value: 4 }]])]] }, t1: true }),
    );
  });

  test('a tree needs a base group, one walk per group, no other via beside it and no filter on its own table', () => {
    refused({ t0: { groups: [[via('next_id', 't0')]] } }, /none could ever admit a first row/);
    refused(
      { t0: { groups: [[via('next_id', 't0'), via('owner_id', 't0')], [{ column: 'owner_id', op: '=', value: 1 }]] } },
      /one "via" to its own table, not 2/,
    );
    refused(
      { t0: { groups: [[via('next_id', 't0'), via('owner_id', 't1')], [{ column: 'owner_id', op: '=', value: 1 }]] }, t1: true },
      /must be the only "via" in its group/,
    );
    refused(
      {
        t0: {
          groups: [
            [via('next_id', 't0', 'id', [[{ column: 'owner_id', op: '=', value: 1 }]])],
            [{ column: 'owner_id', op: '=', value: 1 }],
          ],
        },
      },
      /with a "where"/,
    );
    refused(
      { t0: { groups: [[via('next_id', 't0')], [via('owner_id', 't0', 'k1')], [{ column: 'owner_id', op: '=', value: 1 }]] } },
      /must name the same key/,
    );
    assert.doesNotThrow(() =>
      snapshotRowScope(chain, {
        t0: { groups: [[{ column: 'owner_id', op: '=', value: 1 }], [{ column: 'k1', op: '=', value: 0 }, via('next_id', 't0')]] },
      }),
    );
  });

  test('a via counts as a condition toward the bound, and a target filter does too', () => {
    const many = (n: number, filter = false): RowScope => ({
      t0: {
        groups: [
          Array.from({ length: n }, () => via('next_id', 't1', 'id', filter ? [[{ column: 'owner_id', op: '=', value: 1 }]] : undefined)),
        ],
      },
      t1: true,
    });
    assert.doesNotThrow(() => snapshotRowScope(chain, many(2048)));
    assert.throws(() => snapshotRowScope(chain, many(2049)), /2,049 conditions/);
    assert.throws(() => snapshotRowScope(chain, many(1025, true)), /2,050 conditions/);
  });
});

describe('a via compiles its targets first, so placeholders stay in text order', () => {
  const programs: DatabaseSchema = {
    ...chain,
    tables: ['program_access', 'program', 'program_task'].map((id) => ({
      id,
      schema: '',
      name: id,
      isView: false,
      columns: ['id', 'staff_id', 'status', 'program_id', 'region', 'tier', 'state', 'priority'].map((name) => ({
        name,
        type: 'integer',
        nullable: true,
        primaryKey: name === 'id',
      })),
    })),
  };
  const scope: RowScope = {
    program_access: {
      groups: [
        [
          { column: 'staff_id', op: '=', value: 7 },
          { column: 'status', op: '=', value: 'active' },
        ],
      ],
    },
    program: {
      groups: [
        [
          { column: 'region', op: '=', value: 'EU' },
          via('id', 'program_access', 'program_id'),
          { column: 'tier', op: 'in', value: ['gold', 'silver'] },
        ],
      ],
    },
    program_task: {
      groups: [
        [
          { column: 'state', op: '!=', value: 'done' },
          via('program_id', 'program', 'id', [[{ column: 'tier', op: '=', value: 'gold' }]]),
          { column: 'priority', op: '>=', value: 2 },
        ],
      ],
    },
  };

  test('the values bind in the order their placeholders are written, on every style', () => {
    for (const style of [POSTGRES_STYLE, POSTGRES_INLINE_STYLE, ANSI_STYLE]) {
      const relations = new ScopedRelations(programs, style, scope);
      const task = relations.table('program_task');
      const { text, params } = relations.finish();
      assert.deepEqual(params, [7, 'active', 'EU', 'gold', 'silver', 'gold', 'done', 2], style.placeholder(1));
      if (style.placeholder(1) === '$1') {
        const written = [...text.matchAll(/(?<!\w)\$(\d+)/g)].map((match) => Number(match[1]));
        assert.deepEqual(
          written,
          params.map((_, i) => i + 1),
        );
      }
      // The access table, then the program it opens, then the filtered program, then the task: each names only earlier ones.
      const at = (name: string) => text.indexOf(`FROM "${name}"`);
      assert.ok(at('program_access') < at('program') && at('program') < at('program_task'), text);
      assert.match(task, /^"_tw_scope\$\d+"$/);
    }
  });

  test('the Postgres hint stays on the scoped relations and the EXISTS reads the target by its key', () => {
    const relations = new ScopedRelations(programs, POSTGRES_INLINE_STYLE, scope);
    relations.table('program');
    const { text } = relations.finish();
    assert.match(
      text,
      /AS NOT MATERIALIZED \(SELECT .* FROM "program" "_tw_o" WHERE "_tw_o"."region" OPERATOR\(pg_catalog\.=\) \$3 AND EXISTS \(SELECT 1 FROM "_tw_scope\$1" "_tw_p"/,
    );
  });
});

/* ---------- against a database ---------- */

type Row = Record<string, unknown>;
interface World {
  readonly name: string;
  /** A table's id in this database (schema-qualified on PostgreSQL). */
  id(table: string): string;
  readonly style: SqlStyle;
  readonly adapter: SqliteAdapter | PostgresAdapter;
  raw(text: string, params?: readonly unknown[]): Promise<Row[]>;
  schema(): Promise<DatabaseSchema>;
  close(): Promise<void>;
}

const customer = 'customer',
  supportCase = 'support_case',
  message = 'support_case_message',
  note = 'case_note',
  attachment = 'attachment',
  program = 'program',
  access = 'program_access',
  task = 'program_task',
  folder = 'folder',
  item = 'item',
  branch = 'branch';

function statements(postgres: boolean): string[] {
  const pk = postgres ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY (START WITH 1000000) PRIMARY KEY' : 'INTEGER PRIMARY KEY';
  /* The first n integers as `s.i`: SQLite has no generate_series. */
  const series = (n: number) =>
    postgres
      ? `generate_series(1, ${n}) AS s(i)`
      : `(WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) SELECT i FROM n) AS s`;
  return [
    `CREATE TABLE ${customer} (id ${pk}, name TEXT)`,
    `CREATE TABLE ${supportCase} (id ${pk}, customer_id INTEGER NOT NULL, status TEXT NOT NULL)`,
    // No declared foreign key: a via needs none (the case a message joins is not always one).
    `CREATE TABLE ${message} (id ${pk}, case_id INTEGER NOT NULL, body TEXT, qty INTEGER NOT NULL)`,
    `CREATE TABLE ${note} (id ${pk}, case_id INTEGER NOT NULL REFERENCES ${supportCase} (id), body TEXT)`,
    `CREATE TABLE ${attachment} (id ${pk}, note_id INTEGER NOT NULL REFERENCES ${note} (id), name TEXT)`,
    `CREATE TABLE ${program} (id ${pk}, name TEXT, region TEXT, tier TEXT)`,
    `CREATE TABLE ${access} (id ${pk}, staff_id INTEGER, program_id INTEGER, status TEXT)`,
    `CREATE TABLE ${task} (id ${pk}, program_id INTEGER, state TEXT, priority INTEGER, title TEXT)`,
    `CREATE TABLE ${folder} (id ${pk}, parent_id INTEGER, owner_id INTEGER, archived INTEGER NOT NULL DEFAULT 0, name TEXT)`,
    `CREATE TABLE ${item} (id ${pk}, folder_id INTEGER NOT NULL REFERENCES ${folder} (id), name TEXT)`,
    `CREATE TABLE ${branch} (id ${pk}, "ParentId" INTEGER, owner_id INTEGER)`,
    `INSERT INTO ${branch} VALUES (1, NULL, 1), (2, 1, NULL), (3, 2, NULL), (4, NULL, 2), (5, 4, NULL)`,
    `INSERT INTO ${customer} VALUES (1, 'Ana'), (2, 'Ben'), (3, 'Cy')`,
    // 5,000 cases for customer 1 (odd ones open), two for customer 2, one for customer 3.
    `INSERT INTO ${supportCase} SELECT s.i, 1, CASE WHEN s.i % 2 = 1 THEN 'open' ELSE 'closed' END FROM ${series(5000)}`,
    `INSERT INTO ${supportCase} VALUES (6001, 2, 'open'), (6002, 2, 'closed'), (7001, 3, 'open')`,
    `INSERT INTO ${message} SELECT s.i, s.i, 'm' || s.i, 2 FROM ${series(5000)}`,
    `INSERT INTO ${message} VALUES (6001, 6001, 'ben open', 1), (6002, 6002, 'ben closed', 1), (7001, 7001, 'cy', 1), (9001, 99999, 'orphan', 1)`,
    `INSERT INTO ${note} VALUES (1, 1, 'x'), (2, 2, 'x'), (3, 6001, 'x'), (4, 1, 'y')`,
    `INSERT INTO ${attachment} VALUES (1, 1, 'a1'), (2, 3, 'a3'), (3, 4, 'a4')`,
    `INSERT INTO ${program} VALUES (1, 'Alpha', 'EU', 'gold'), (2, 'Beta', 'EU', 'silver'), (3, 'Gamma', 'US', 'gold'),
       (4, 'Delta', 'EU', 'bronze'), (5, 'Eps', 'EU', 'gold')`,
    `INSERT INTO ${access} VALUES (1, 7, 1, 'active'), (2, 7, 2, 'active'), (3, 7, 3, 'active'), (4, 7, 4, 'active'),
       (5, 7, 5, 'revoked'), (6, 8, 1, 'active')`,
    `INSERT INTO ${task} VALUES (1, 1, 'open', 3, 't1'), (2, 1, 'done', 5, 't2'), (3, 2, 'open', 1, 't3'), (4, 2, 'open', 4, 't4'),
       (5, 4, 'open', 9, 't5'), (6, 5, 'open', 9, 't6'), (7, 1, 'open', 2, 't7')`,
    /* Ana's tree: a spine 50 deep (1 is the root she owns) and 9,950 more folders hung from it, 10,000 in all. Ben's:
       a root and 99 under it. Cy's: two folders that are each other's parent, and a child of one. */
    `INSERT INTO ${folder} SELECT 1, NULL, 1, 0, 'n1' FROM ${series(1)}`,
    `INSERT INTO ${folder} SELECT s.i, s.i - 1, NULL, CASE WHEN s.i = 10 THEN 1 ELSE 0 END, 'n' || s.i FROM ${series(50)} WHERE s.i > 1`,
    `INSERT INTO ${folder} SELECT s.i, ((s.i - 51) % 50) + 1, NULL, 0, 'n' || s.i FROM ${series(10000)} WHERE s.i > 50`,
    `INSERT INTO ${folder} SELECT 20000 + s.i, CASE WHEN s.i = 1 THEN NULL ELSE 20001 END, CASE WHEN s.i = 1 THEN 2 ELSE NULL END, 0, 'n' || (20000 + s.i)
       FROM ${series(100)}`,
    `INSERT INTO ${folder} VALUES (30001, 30002, 3, 0, 'n30001'), (30002, 30001, NULL, 0, 'n30002'), (30003, 30002, NULL, 0, 'n30003')`,
    `INSERT INTO ${item} VALUES (1, 1, 'i1'), (2, 20001, 'i2'), (3, 30001, 'i3')`,
  ];
}

async function sqliteWorld(): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-via-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec('BEGIN');
  for (const statement of statements(false)) db.exec(statement);
  db.exec('COMMIT');
  const adapter = new SqliteAdapter(file, 'via');
  return {
    name: 'SQLite',
    id: (table) => table,
    style: ANSI_STYLE,
    adapter,
    raw: async (text, params = []) => db.prepare(text).all(...(params as never[])) as Row[],
    schema: () => adapter.introspect(),
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
  const adapter = new PostgresAdapter(LIVE!, 'via', [SCHEMA]);
  return {
    name: 'PostgreSQL',
    id: (table) => `${SCHEMA}.${table}`,
    style: POSTGRES_STYLE,
    adapter,
    raw: async (text, params = []) => (await control.query(text, params)).rows,
    schema: () => adapter.introspect(),
    async close() {
      await adapter.close();
      await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await control.end();
    },
  };
}

const ids = (rows: readonly Row[]) => rows.map((row) => Number(row.id)).sort((a, b) => a - b);
class Rollback extends Error {}

function proofs(open: () => Promise<World>, skip: false | string = false) {
  describe(
    `via row scopes on ${skip === false ? '' : '(skipped) '}${open.name === 'sqliteWorld' ? 'SQLite' : 'PostgreSQL'}`,
    { skip },
    () => {
      let w: World;
      before(async () => {
        w = await open();
      });
      after(async () => {
        await w?.close();
      });

      const T = (table: string) => w.id(table);
      /* The customer-1 scope of the design: her cases, and the messages on them. */
      const mine = (extra: RowScope = {}): RowScope => ({
        [T(supportCase)]: { groups: [[{ column: 'customer_id', op: '=', value: 1 }]] },
        [T(message)]: { groups: [[via('case_id', T(supportCase))]] },
        ...extra,
      });
      const read = async (scope: RowScope, table: string, filter?: { column: string; op: '='; value: string | number }) => {
        const reads = await w.adapter.scopeReads(scope);
        return reads.query({ table: T(table), limit: 100_000, offset: 0, ...(filter ? { filter: { groups: [[filter]] } } : {}) });
      };
      /** A scoped relation read as the statement the compiler wrote, on the same connection kind the test holds. */
      const relationRows = async (scope: RowScope, schema: DatabaseSchema, policy: DatabaseSchema, table: string, order = 'id') => {
        const relations = new ScopedRelations(schema, w.style, scope, policy);
        const relation = relations.table(T(table));
        const prefix = relations.finish();
        return w.raw(`${prefix.text}SELECT * FROM ${relation} ORDER BY ${order}`, prefix.params);
      };

      // 1
      test('more than 4,096 parents: every message is listed, counted and summed, where an in-list refuses at 4,096', async () => {
        const reads = await w.adapter.scopeReads(mine());
        const listed = await reads.query({ table: T(message), limit: 100_000, offset: 0 });
        assert.equal(listed.rows.length, 5000);
        assert.equal(ids(listed.rows)[4999], 5000);
        assert.equal(await reads.count(T(message)), 5000);
        const sum = await reads.runBreakdown({ base: T(message), by: [], measures: [{ fn: 'sum', path: 'qty' }] });
        assert.equal(Number(Object.values(sum.rows[0])[0]), 10_000);
        // The form this replaces cannot say it: a list of the parents is refused past the bound.
        const keys = Array.from({ length: 5000 }, (_, i) => i + 1);
        assert.throws(
          () => snapshotRowScope({ ...chain, dialect: 'sqlite' }, { t0: { groups: [[{ column: 'id', op: 'in', value: keys }]] } }),
          /a list holds 5,000 values, 904 past the bound of 4,096 per list/,
        );
      });

      // 2
      test('a membership table the reader cannot read still opens programs, and is still refused as a read', async () => {
        const full = await w.schema();
        const pruned: DatabaseSchema = { ...full, tables: full.tables.filter((table) => table.id !== T(access)) };
        const scope: RowScope = {
          [T(access)]: {
            groups: [
              [
                { column: 'staff_id', op: '=', value: 7 },
                { column: 'status', op: '=', value: 'active' },
              ],
            ],
          },
          [T(program)]: {
            groups: [
              [
                { column: 'region', op: '=', value: 'EU' },
                via('id', T(access), 'program_id'),
                { column: 'tier', op: 'in', value: ['gold', 'silver'] },
              ],
            ],
          },
        };
        assert.deepEqual(ids(await relationRows(scope, pruned, full, program)), [1, 2]);
        // Resolved against the pruned catalog alone, the membership table is missing: an author error, never a silent deny.
        assert.throws(() => new ScopedRelations(pruned, w.style, scope), Refusal);
        const relations = new ScopedRelations(pruned, w.style, scope, full);
        assert.throws(() => relations.table(T(access)), Refusal);
        assert.throws(() => relations.filtered(T(access), { groups: [[{ column: 'id', op: '=', value: 1 }]] }), Refusal);
        // A view over the program compiles the same, through the policy catalog it is handed.
        const compiled = compileView(pruned, { id: 'v', name: 'v', base: T(program), columns: [{ path: 'id' }] }, w.style, 0, scope, full);
        assert.deepEqual(ids(await w.raw(compiled.text, compiled.params)), [1, 2]);
      });

      // 3
      test('transitive: message, case, customer; each table reads the one before it, scoped', async () => {
        const scope: RowScope = {
          [T(customer)]: { groups: [[{ column: 'id', op: '=', value: 1 }]] },
          [T(supportCase)]: { groups: [[via('customer_id', T(customer))]] },
          [T(message)]: { groups: [[via('case_id', T(supportCase))]] },
        };
        const reads = await w.adapter.scopeReads(scope);
        assert.equal(await reads.count(T(message)), 5000);
        assert.equal(await reads.count(T(supportCase)), 5000);
        // Customer 1 only: the messages of customers 2 and 3, and the orphan, are not here.
        assert.equal(
          (await reads.query({ table: T(message), limit: 10, offset: 0, filter: { groups: [[{ column: 'id', op: '>', value: 5000 }]] } }))
            .rows.length,
          0,
        );
        const full = await w.schema();
        const relations = new ScopedRelations(full, w.style, scope);
        relations.table(T(message));
        const { text } = relations.finish();
        const q = (name: string) => (w.id(name).includes('.') ? `"${SCHEMA}"."${name}"` : `"${name}"`);
        const defs = [customer, supportCase, message].map((name) => text.indexOf(`FROM ${q(name)}`));
        assert.ok(defs[0] >= 0 && defs[0] < defs[1] && defs[1] < defs[2], text);
      });

      // 5
      test('a target that is absent or false denies every row; one that is true only asks that the parent exist', async () => {
        const only = (target: RowScope): RowScope => ({ [T(message)]: { groups: [[via('case_id', T(supportCase))]] }, ...target });
        assert.equal((await read(only({}), message)).rows.length, 0);
        assert.equal((await read(only({ [T(supportCase)]: false }), message)).rows.length, 0);
        // Every message whose case exists: not the orphan.
        assert.equal((await read(only({ [T(supportCase)]: true }), message)).rows.length, 5003);
      });

      // 12 (the advisory, and the plan smoke on PostgreSQL)
      test('a via whose target key or own column no index leads is advised, never refused', async () => {
        const full = await w.schema();
        const scope: RowScope = {
          [T(supportCase)]: { groups: [[{ column: 'customer_id', op: '=', value: 1 }]] },
          [T(message)]: { groups: [[via('case_id', T(supportCase))]] },
          [T(access)]: true,
          [T(program)]: { groups: [[via('id', T(access), 'program_id')]] },
        };
        const advice = rowScopeViaAdvisories(full, scope);
        assert.equal(advice.length, 2, advice.join('\n'));
        assert.match(advice[0], /support_case_message\.case_id/);
        assert.doesNotMatch(advice[0], /support_case\.id/, 'a primary key leads its own index');
        assert.match(advice[1], /program_access\.program_id/);
        assert.doesNotMatch(advice[1], /program\.id/);
        // Advice, not a refusal: the scope reads as ever.
        assert.equal((await read(scope, message)).rows.length, 5000);
      });

      test('plan smoke: the EXISTS over 5,000 parents is a semi-join or an index probe, not a scan per row', async (t) => {
        if (w.name !== 'PostgreSQL') return t.skip('PostgreSQL plans only');
        const full = await w.schema();
        const compiled = compileView(full, { id: 'v', name: 'v', base: T(message), columns: [{ path: 'id' }] }, w.style, 0, mine());
        await w.raw('ANALYZE');
        const plan = (await w.raw(`EXPLAIN ${compiled.text}`, compiled.params)).map((row) => String(Object.values(row)[0])).join('\n');
        // Advisory by design: it names the plan for a reader of the log and does not gate the suite.
        t.diagnostic(plan);
        assert.ok(plan.length > 0);
        assert.doesNotMatch(plan, /SubPlan/, 'a correlated subplan per row is the nested scan the compile is meant to avoid');
      });

      // 11
      test('literal params before and after a via target bind to the right placeholders', async () => {
        const scope: RowScope = {
          [T(access)]: {
            groups: [
              [
                { column: 'staff_id', op: '=', value: 7 },
                { column: 'status', op: '=', value: 'active' },
              ],
            ],
          },
          [T(program)]: {
            groups: [
              [
                { column: 'region', op: '=', value: 'EU' },
                via('id', T(access), 'program_id'),
                { column: 'tier', op: 'in', value: ['gold', 'silver'] },
              ],
            ],
          },
          [T(task)]: {
            groups: [
              [
                { column: 'state', op: '!=', value: 'done' },
                via('program_id', T(program), 'id', [[{ column: 'tier', op: '=', value: 'gold' }]]),
                { column: 'priority', op: '>=', value: 2 },
              ],
            ],
          },
        };
        assert.deepEqual(ids((await read(scope, task)).rows), [1, 7]);
        // The reader's own filter follows the scope's prefix, and binds after it.
        assert.deepEqual(ids((await read(scope, task, { column: 'title', op: '=', value: 't7' })).rows), [7]);
        assert.deepEqual(ids((await read(scope, program)).rows), [1, 2]);
      });

      // 6
      describe('writes', () => {
        const sentinel = async <T>(scope: RowScope, run: Parameters<typeof w.adapter.scopeTransaction<T>>[1]) =>
          assert.rejects(
            w.adapter.scopeTransaction(scope, async (tx, catalog) => {
              await run(tx, catalog);
              throw new Rollback();
            }),
            Rollback,
          );

        test('a message on a case out of scope is refused by its parent check, before the statement', async () => {
          let cause = '';
          await assert.rejects(
            w.adapter.scopeTransaction(mine(), (tx) => tx.insert({ table: T(message), values: { case_id: 6001, body: 'x', qty: 1 } })),
            (error: Error) => {
              cause = String((refusalCause(error) as Error | undefined)?.message);
              return error instanceof Refusal;
            },
          );
          assert.match(cause, /"[\w.]*support_case_message"\.case_id points at the "[\w.]*support_case" row id 6001/);
          assert.deepEqual(await w.raw(`SELECT id FROM ${T(message)} WHERE body = 'x'`), []);
        });

        test('a case and its message, made in one transaction, both land', async () => {
          await sentinel(mine(), async (tx) => {
            const made = await tx.insert({ table: T(supportCase), values: { customer_id: 1, status: 'open' } });
            const first = await tx.insert({ table: T(message), values: { case_id: made.key.id, body: 'hello', qty: 1 } });
            const back = await tx.query({
              table: T(message),
              filter: { groups: [[{ column: 'id', op: '=', value: first.key.id as number }]] },
              limit: 2,
              offset: 0,
            });
            assert.equal(back.rows.length, 1);
          });
          assert.deepEqual(await w.raw(`SELECT id FROM ${T(message)} WHERE body = 'hello'`), []);
        });

        test('an update that points a message at a case out of scope is refused; one that stays is not', async () => {
          await assert.rejects(
            w.adapter.scopeTransaction(mine(), (tx) => tx.update({ table: T(message), key: { id: 1 }, values: { case_id: 6001 } })),
            Refusal,
          );
          await sentinel(mine(), async (tx) => void (await tx.update({ table: T(message), key: { id: 1 }, values: { case_id: 2 } })));
          // A message already out of scope cannot be updated at all: the scoped relation does not hold it.
          await assert.rejects(
            w.adapter.scopeTransaction(mine(), (tx) => tx.update({ table: T(message), key: { id: 6001 }, values: { body: 'y' } })),
            Refusal,
          );
          await assert.rejects(
            w.adapter.scopeTransaction(mine(), (tx) => tx.remove({ table: T(message), key: { id: 6001 } })),
            Refusal,
          );
        });

        test("the target's filter holds for a write: a message cannot be added to a closed case", async () => {
          const open = mine({
            [T(message)]: { groups: [[via('case_id', T(supportCase), 'id', [[{ column: 'status', op: '=', value: 'open' }]])]] },
          });
          await assert.rejects(
            w.adapter.scopeTransaction(open, (tx) => tx.insert({ table: T(message), values: { case_id: 2, body: 'z', qty: 1 } })),
            Refusal,
          );
          await sentinel(open, async (tx) => void (await tx.insert({ table: T(message), values: { case_id: 1, body: 'z', qty: 1 } })));
          assert.deepEqual(await w.raw(`SELECT id FROM ${T(message)} WHERE body = 'z'`), []);
        });
      });

      // 7, 8
      describe('record reads, path hops, exports and rollups read the same scoped relation', () => {
        const notes = (extra: RowScope = {}): RowScope => ({
          [T(supportCase)]: { groups: [[{ column: 'customer_id', op: '=', value: 1 }]] },
          [T(note)]: { groups: [[via('case_id', T(supportCase))]] },
          ...extra,
        });

        test('a record read (filtered) starts from the via-scoped relation', async () => {
          const full = await w.schema();
          const relations = new ScopedRelations(full, w.style, notes());
          const narrowed = relations.filtered(T(note), { groups: [[{ column: 'body', op: '=', value: 'x' }]] });
          const prefix = relations.finish();
          const rows = await w.raw(`${prefix.text}SELECT id FROM ${narrowed} ORDER BY id`, prefix.params);
          // Note 3 is on a case of customer 2.
          assert.deepEqual(ids(rows), [1, 2]);
        });

        test('a path hop (filtered) through a via-scoped table reads what the person may see there', async () => {
          const full = await w.schema();
          const relations = new ScopedRelations(full, w.style, notes({ [T(attachment)]: true }));
          const narrowed = relations.filtered(T(attachment), { groups: [[{ column: 'note_id.body', op: '=', value: 'x' }]] });
          const prefix = relations.finish();
          const rows = await w.raw(`${prefix.text}SELECT id FROM ${narrowed} ORDER BY id`, prefix.params);
          // Attachment 2 hangs on note 3, which is hidden; attachment 3 on a note whose body is y.
          assert.deepEqual(ids(rows), [1]);
        });

        test('an export (a view) and a rollup (an aggregate over the children) are narrowed by the via', async () => {
          const reads = await w.adapter.scopeReads(mine());
          const view = { id: 'messages', name: 'Messages', base: T(message), columns: [{ path: 'id' }, { path: 'body' }] };
          assert.equal(await reads.countView(view), 5000);
          const exported = await reads.runView({ ...view, limit: 100_000 });
          assert.equal(exported.rows.length, 5000);
          assert.ok(exported.rows.every((row) => Number(row.id) <= 5000));
          // The children counted are the ones this person may see: notes on an open case only, through the target's filter.
          const scope = notes({
            [T(note)]: { groups: [[via('case_id', T(supportCase), 'id', [[{ column: 'status', op: '=', value: 'open' }]])]] },
          });
          const rollup = await (
            await w.adapter.scopeReads(scope)
          ).runView({
            id: 'cases',
            name: 'Cases',
            base: T(supportCase),
            columns: [{ path: 'id' }],
            aggregates: [{ fn: 'count', via: `${T(note)}.case_id` }],
            filter: { groups: [[{ path: 'id', op: 'in', value: [1, 2, 3] }]] },
          });
          const counts = Object.fromEntries(
            rollup.rows.map((row) => [Number(row.id), Number(Object.entries(row).find(([key]) => key.startsWith('count('))![1])]),
          );
          // Case 1 is open with notes 1 and 4; case 2 is closed, so its note is gone; case 3 has none.
          assert.deepEqual(counts, { 1: 2, 2: 0, 3: 0 });
        });
      });

      // 13..17
      describe('trees', () => {
        const own = (user: number) => ({ column: 'owner_id', op: '=' as const, value: user });
        const below = (extra: RowScope = {}, ...beside: Array<{ column: string; op: '='; value: number }>): RowScope => ({
          [T(folder)]: { groups: [[own(1)], [...beside, via('parent_id', T(folder))]] },
          ...extra,
        });

        test('a tree walked through a quoted, mixed-case column reads the same on every engine', async () => {
          const reads = await w.adapter.scopeReads({
            [T(branch)]: { groups: [[own(1)], [via('ParentId', T(branch), 'id')]] },
          });
          assert.deepEqual(ids((await reads.query({ table: T(branch), limit: 100, offset: 0 })).rows), [1, 2, 3]);
        });

        test('13: a tree 50 deep with 10,000 nodes is walked from its root, and one person sees only their own', async () => {
          const reads = await w.adapter.scopeReads(below());
          assert.equal(await reads.count(T(folder)), 10_000);
          const listed = await reads.query({ table: T(folder), limit: 100_000, offset: 0 });
          assert.equal(listed.rows.length, 10_000);
          assert.equal(Math.max(...ids(listed.rows)), 10_000);
          // Ben's 100 and Cy's three are not Ana's.
          const ben = await w.adapter.scopeReads({ [T(folder)]: { groups: [[own(2)], [via('parent_id', T(folder))]] } });
          assert.equal(await ben.count(T(folder)), 100);
          // The depth is real: the deepest spine node is reached only through 49 parents.
          const deepest = await reads.query({
            table: T(folder),
            limit: 5,
            offset: 0,
            filter: { groups: [[{ column: 'id', op: '=', value: 50 }]] },
          });
          assert.equal(deepest.rows.length, 1);
        });

        test('13: a level that fails an ordinary condition ends its branch', async () => {
          // Folder 10 is archived: nothing at or below it is reached, its leaves included.
          const reads = await w.adapter.scopeReads({
            [T(folder)]: { groups: [[own(1)], [{ column: 'archived', op: '=', value: 0 }, via('parent_id', T(folder))]] },
          });
          const everything = await w.raw(`SELECT id, parent_id, archived FROM ${T(folder)} WHERE id <= 10000`);
          const children = new Map<number, number[]>();
          for (const row of everything) {
            const list = children.get(Number(row.parent_id)) ?? [];
            list.push(Number(row.id));
            children.set(Number(row.parent_id), list);
          }
          const archived = new Set(everything.filter((row) => Number(row.archived) === 1).map((row) => Number(row.id)));
          const reached = new Set<number>([1]);
          for (const id of reached) for (const child of children.get(id) ?? []) if (!archived.has(child)) reached.add(child);
          assert.ok(reached.size < 10_000 && reached.size > 9);
          assert.equal(await reads.count(T(folder)), reached.size);
        });

        test('14: a cycle in the data ends the query', async () => {
          const cyc = await w.adapter.scopeReads({ [T(folder)]: { groups: [[own(3)], [via('parent_id', T(folder))]] } });
          // 30001 is Cy's root and the parent of 30002, which is the parent of 30001 and of 30003.
          assert.deepEqual(ids((await cyc.query({ table: T(folder), limit: 100, offset: 0 })).rows), [30001, 30002, 30003]);
        });

        test('the recursive definition is the one the design writes', async () => {
          const full = await w.schema();
          const relations = new ScopedRelations(full, POSTGRES_INLINE_STYLE, below());
          relations.table(T(folder));
          const { text } = relations.finish();
          assert.match(text, /^WITH RECURSIVE /);
          assert.match(text, /\("id"\) AS \(SELECT "_tw_o"\."id" FROM .* UNION SELECT "_tw_c"\."id" FROM /);
          assert.equal([...text.matchAll(/NOT MATERIALIZED/g)].length, 1, 'only the relation over the walk is hinted');
          assert.doesNotMatch(text, /UNION ALL/);
        });

        test('15: a move out of scope is refused, and an insert under a parent out of scope', async () => {
          await assert.rejects(
            w.adapter.scopeTransaction(below(), (tx) => tx.update({ table: T(folder), key: { id: 7 }, values: { parent_id: 20001 } })),
            Refusal,
          );
          await assert.rejects(
            w.adapter.scopeTransaction(below(), (tx) => tx.insert({ table: T(folder), values: { parent_id: 20001, name: 'sneak' } })),
            Refusal,
          );
          await assert.rejects(
            w.adapter.scopeTransaction(below(), async (tx, _catalog) => {
              await tx.update({ table: T(folder), key: { id: 7 }, values: { parent_id: 3 } });
              throw new Rollback();
            }),
            Rollback,
          );
          await assert.rejects(
            w.adapter.scopeTransaction(below(), async (tx) => {
              const made = await tx.insert({ table: T(folder), values: { parent_id: 5, name: 'child' } });
              assert.equal(typeof made.key.id, 'number');
              throw new Rollback();
            }),
            Rollback,
          );
          assert.deepEqual(await w.raw(`SELECT id FROM ${T(folder)} WHERE name IN ('sneak', 'child')`), []);
          assert.equal(Number((await w.raw(`SELECT parent_id FROM ${T(folder)} WHERE id = 7`))[0].parent_id), 6);
        });

        test('16: record reads and path hops read the tree', async () => {
          const full = await w.schema();
          const scope = below({ [T(item)]: true });
          const relations = new ScopedRelations(full, w.style, scope);
          const record = relations.filtered(T(folder), { groups: [[{ column: 'name', op: '=', value: 'n10000' }]] });
          const hop = relations.filtered(T(item), { groups: [[{ column: 'folder_id.name', op: '=', value: 'n1' }]] });
          const hopHidden = relations.filtered(T(item), { groups: [[{ column: 'folder_id.name', op: '=', value: 'n20001' }]] });
          const prefix = relations.finish();
          assert.match(prefix.text, /^WITH RECURSIVE /);
          const run = async (name: string) => ids(await w.raw(`${prefix.text}SELECT id FROM ${name} ORDER BY id`, prefix.params));
          assert.deepEqual(await run(record), [10_000]);
          assert.deepEqual(await run(hop), [1]);
          // Ben's folder is not in Ana's tree, so the hop finds nothing there.
          assert.deepEqual(await run(hopHidden), []);
        });
      });
    },
  );
}

proofs(sqliteWorld);
proofs(postgresWorld, liveSkip('postgres', LIVE));
