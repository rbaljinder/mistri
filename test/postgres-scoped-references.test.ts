/**
 * A scoped write's parent check on PostgreSQL, compared as the database's
 * own foreign key compares (scopedTransaction.ts parentChecks).
 *
 * The check reads the parent a written reference points at under the
 * principal's rows. It must find the row the foreign key will find: a
 * `char(3)` reference to a `text` key is padded where the key is not, and
 * `'ab '` judged as itself found the visible "ab " while the foreign key,
 * comparing as text, landed on the hidden "ab". The check now binds the
 * value as the child column's declared type and compares by the constraint's
 * own operator (pg_constraint.conpfeqop). What it cannot judge before the
 * write — a reference the write names only in part — is left to the database,
 * whose refusal is said as the check's, so a missing parent and a hidden one
 * answer alike.
 *
 * Live and opt-in like postgres-scoped-transactions.test.ts; everything lives
 * in the schema `scoped_references`, dropped before and after.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Filter, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { TriggerAcceptance } from '../packages/engine/src/adapters/scoped/triggerProof.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { buildWhere, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'scoped_references';

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: LIVE, statement_timeout: 10_000 });
  await created.connect();
  return created;
}

const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
/** Tenant a's rows of each table named. */
const ofA = (...tables: string[]): RowScope => Object.fromEntries(tables.map((table) => [`${SCHEMA}.${table}`, eq('tenant', 'a')]));

describe('the parent check on PostgreSQL, compared as the foreign key compares', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const reset = async (sql: string) => {
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.query(`CREATE SCHEMA ${SCHEMA}; ${sql}`);
  };
  const rows = async (sql: string) => (await control.query(sql)).rows as Array<Record<string, unknown>>;
  before(async () => {
    control = await client();
  });
  after(async () => {
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.end();
  });

  /** 'committed', or the refusal's message and its cause for the operator. */
  const said = async (scope: RowScope, operation: (tx: WriteTransaction) => Promise<unknown>, accepted?: TriggerAcceptance) => {
    const adapter = new PostgresAdapter(LIVE!, 'references', [SCHEMA]);
    try {
      await adapter.scopeTransaction(scope, operation, accepted);
      return { said: 'committed', cause: '' };
    } catch (error) {
      return { said: `${(error as Error).constructor.name}: ${(error as Error).message}`, cause: String(refusalCause(error as Error)) };
    } finally {
      await adapter.close();
    }
  };
  const REFUSED = 'ScopeRefusal: This operation is not available in the current row scope.';
  const HIERARCHY = 'is part of a partition or inheritance hierarchy, which writes under a row policy do not support yet';

  const OWNERS = `CREATE TABLE ${SCHEMA}.owner (id int PRIMARY KEY, tenant text NOT NULL);
    CREATE TABLE ${SCHEMA}.item (id int PRIMARY KEY, tenant text NOT NULL, owner_id int REFERENCES ${SCHEMA}.owner (id));
    INSERT INTO ${SCHEMA}.owner VALUES (1, 'a'), (2, 'b'), (7, 'a');`;

  test('a value the column coerces is checked as it is written: "" for a nullable reference is NULL, "7.0" is 7', async () => {
    await reset(OWNERS);
    const insert = (id: number, owner: unknown) => (tx: WriteTransaction) =>
      tx.insert({ table: `${SCHEMA}.item`, values: { id, tenant: 'a', owner_id: owner as string } });
    assert.equal((await said(ofA('item', 'owner'), insert(1, ''))).said, 'committed');
    assert.equal((await said(ofA('item', 'owner'), insert(2, '7.0'))).said, 'committed');
    assert.deepEqual(await rows(`SELECT id, owner_id FROM ${SCHEMA}.item ORDER BY id`), [
      { id: 1, owner_id: null },
      { id: 2, owner_id: 7 },
    ]);
    // "2.0" is the hidden owner 2, refused as 2 is.
    assert.equal((await said(ofA('item', 'owner'), insert(3, '2.0'))).said, REFUSED);
  });

  test('a row that references itself by the key it is written with is admitted', async () => {
    await reset(`CREATE TABLE ${SCHEMA}.node (id int PRIMARY KEY, tenant text NOT NULL, parent_id int REFERENCES ${SCHEMA}.node (id))`);
    const insert = (values: Record<string, number | string>) => (tx: WriteTransaction) =>
      tx.insert({ table: `${SCHEMA}.node`, values: { tenant: 'a', ...values } });
    assert.equal((await said(ofA('node'), insert({ id: 1, parent_id: 1 }))).said, 'committed');
    // Another row's key is still a parent to check: node 1 is tenant a's, node 9 nobody's.
    assert.equal((await said(ofA('node'), insert({ id: 2, parent_id: 1 }))).said, 'committed');
    assert.equal((await said(ofA('node'), insert({ id: 3, parent_id: 9 }))).said, REFUSED);
  });

  test('a char(3) reference to a text key is checked as the foreign key compares it: "ab " finds the hidden "ab"', async () => {
    await reset(`CREATE TABLE ${SCHEMA}.tag (code text PRIMARY KEY, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.note (id int PRIMARY KEY, tenant text NOT NULL, tag char(3) REFERENCES ${SCHEMA}.tag (code));
      INSERT INTO ${SCHEMA}.tag VALUES ('ab ', 'a'), ('ab', 'b'), ('cd', 'a');`);
    const insert = (tag: string) => (tx: WriteTransaction) => tx.insert({ table: `${SCHEMA}.note`, values: { id: 1, tenant: 'a', tag } });
    const hidden = await said(ofA('tag', 'note'), insert('ab '));
    assert.equal(hidden.said, REFUSED);
    assert.match(hidden.cause, /points at the "scoped_references\.tag" row/);
    assert.deepEqual(await rows(`SELECT * FROM ${SCHEMA}.note`), []);
    await control.query(`DELETE FROM ${SCHEMA}.tag WHERE code = 'ab'`);
    assert.equal((await said(ofA('tag', 'note'), insert('ab '))).said, hidden.said, 'a missing parent and a hidden one answer alike');
    // A visible one, padded as the column pads it, is found.
    assert.equal((await said(ofA('tag', 'note'), insert('cd'))).said, 'committed');
  });

  test('an enum, a domain, a wider numeric and a bigint key are each compared by their own constraint', async () => {
    await reset(`CREATE TYPE ${SCHEMA}.mood AS ENUM ('a', 'b');
      CREATE DOMAIN ${SCHEMA}.code3 AS varchar(3);
      CREATE TABLE ${SCHEMA}.p (id bigint PRIMARY KEY, m ${SCHEMA}.mood UNIQUE, d ${SCHEMA}.code3 UNIQUE, n numeric(10,2) UNIQUE, tenant text);
      CREATE TABLE ${SCHEMA}.c (id int PRIMARY KEY, tenant text, pid int REFERENCES ${SCHEMA}.p (id), m ${SCHEMA}.mood REFERENCES ${SCHEMA}.p (m),
        d text REFERENCES ${SCHEMA}.p (d), n numeric(10,1) REFERENCES ${SCHEMA}.p (n));
      INSERT INTO ${SCHEMA}.p VALUES (1, 'a', 'x', 1.5, 'a'), (2, 'b', 'y', 2.5, 'b');`);
    let id = 0;
    const insert = (values: Record<string, string | number>) => (tx: WriteTransaction) =>
      tx.insert({ table: `${SCHEMA}.c`, values: { id: ++id, tenant: 'a', ...values } });
    assert.equal((await said(ofA('p', 'c'), insert({ pid: 1, m: 'a', d: 'x', n: '1.5' }))).said, 'committed');
    for (const hidden of [{ pid: 2 }, { m: 'b' }, { d: 'y' }, { n: 2.5 }] as Array<Record<string, string | number>>)
      assert.equal((await said(ofA('p', 'c'), insert(hidden))).said, REFUSED, JSON.stringify(hidden));
  });

  test('a reference the write names only in part is judged by the database, and its refusal is said as the check says one', async () => {
    await reset(`CREATE TABLE ${SCHEMA}.project (org text NOT NULL, code text NOT NULL, tenant text NOT NULL, PRIMARY KEY (org, code));
      CREATE TABLE ${SCHEMA}.task (id int PRIMARY KEY, tenant text NOT NULL, org text NOT NULL DEFAULT 'acme', code text,
        CONSTRAINT task_project FOREIGN KEY (org, code) REFERENCES ${SCHEMA}.project (org, code));
      INSERT INTO ${SCHEMA}.project VALUES ('acme', 'secret', 'b');`);
    const insert = (code: string) => (tx: WriteTransaction) => tx.insert({ table: `${SCHEMA}.task`, values: { id: 1, tenant: 'a', code } });
    const hidden = await said(ofA('project', 'task'), insert('secret'));
    const missing = await said(ofA('project', 'task'), insert('nothing'));
    assert.equal(hidden.said, REFUSED);
    assert.equal(missing.said, hidden.said);
    // The database's refusal names its constraint for the operator, and no value of the row it did not find.
    assert.match(missing.cause, /The database's foreign key "task_project" refused the write/);
    assert.doesNotMatch(missing.cause, /nothing/);
    assert.deepEqual(await rows(`SELECT * FROM ${SCHEMA}.task`), []);
  });

  /* Each a parent and a reference of the types named, tenant a's parent and tenant b's: the visible one is found and
     the hidden one is not, through the type as the catalog names it (schema-qualified, its modifier as digits). A type
     a key may not be (a timestamp, bit varying, "char", an array, an interval, jsonb) is refused whatever it names:
     scoped-key-types.test.ts. */
  const TYPES: Array<{ name: string; parent: string; child: string; visible: string; hidden: string; pre?: string }> = [
    { name: 'varchar(10) to text', parent: 'text', child: 'varchar(10)', visible: 'a1', hidden: 'b1' },
    { name: 'numeric(10,2)', parent: 'numeric(10,2)', child: 'numeric(10,2)', visible: '1.50', hidden: '2.50' },
    { name: 'char(3) to char(5)', parent: 'char(5)', child: 'char(3)', visible: 'a1', hidden: 'b1' },
    { name: 'a key under an ICU collation', parent: 'text COLLATE "und-x-icu"', child: 'text', visible: 'a1', hidden: 'b1' },
    {
      name: 'a domain over text in a schema whose name needs quoting',
      pre: `CREATE SCHEMA "Odd ""Types"" S"; CREATE DOMAIN "Odd ""Types"" S"."my dom" AS text CHECK (VALUE <> '')`,
      parent: `"Odd ""Types"" S"."my dom"`,
      child: `"Odd ""Types"" S"."my dom"`,
      visible: 'a1',
      hidden: 'b1',
    },
    {
      name: 'an enum whose name has a space, in such a schema',
      pre: `CREATE SCHEMA "Odd ""Types"" S"; CREATE TYPE "Odd ""Types"" S"."Mood Type" AS ENUM ('a1', 'b1')`,
      parent: `"Odd ""Types"" S"."Mood Type"`,
      child: `"Odd ""Types"" S"."Mood Type"`,
      visible: 'a1',
      hidden: 'b1',
    },
  ];
  for (const type of TYPES)
    test(`${type.name}: the visible parent is found and the hidden one is not`, async () => {
      await control.query(`DROP SCHEMA IF EXISTS "Odd ""Types"" S" CASCADE`);
      try {
        await reset(`${type.pre ? `${type.pre};` : ''}
          CREATE TABLE ${SCHEMA}.p (k ${type.parent} PRIMARY KEY, tenant text NOT NULL);
          CREATE TABLE ${SCHEMA}.c (id int PRIMARY KEY, tenant text NOT NULL, ref ${type.child} REFERENCES ${SCHEMA}.p (k));
          INSERT INTO ${SCHEMA}.p VALUES ($$${type.visible}$$, 'a'), ($$${type.hidden}$$, 'b');`);
        const insert = (id: number, ref: string) => (tx: WriteTransaction) =>
          tx.insert({ table: `${SCHEMA}.c`, values: { id, tenant: 'a', ref } });
        const visible = await said(ofA('p', 'c'), insert(1, type.visible));
        assert.equal(visible.said, 'committed', visible.cause);
        assert.equal((await said(ofA('p', 'c'), insert(2, type.hidden))).said, REFUSED);
      } finally {
        await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP SCHEMA IF EXISTS "Odd ""Types"" S" CASCADE`);
      }
    });

  test('citext, wherever it is installed, compares as its own equality', async () => {
    const installed = (
      await rows(`SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'citext'`)
    )[0];
    const at = installed ? String(installed.schema) : 'Odd "Types" S';
    const quoted = `"${at.replaceAll('"', '""')}"`;
    if (!installed)
      await control.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted}; CREATE EXTENSION citext SCHEMA ${quoted}`);
    try {
      await reset(`CREATE TABLE ${SCHEMA}.p (k ${quoted}.citext PRIMARY KEY, tenant text NOT NULL);
        CREATE TABLE ${SCHEMA}.c (id int PRIMARY KEY, tenant text NOT NULL, ref ${quoted}.citext REFERENCES ${SCHEMA}.p (k));
        INSERT INTO ${SCHEMA}.p VALUES ('A1', 'a'), ('B1', 'b');`);
      const insert = (id: number, ref: string) => (tx: WriteTransaction) =>
        tx.insert({ table: `${SCHEMA}.c`, values: { id, tenant: 'a', ref } });
      assert.equal((await said(ofA('p', 'c'), insert(1, 'a1'))).said, 'committed');
      assert.equal((await said(ofA('p', 'c'), insert(2, 'b1'))).said, REFUSED);
    } finally {
      await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      if (!installed) await control.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    }
  });

  test('a reference through a domain over integer is coerced as the write coerces it: "" is NULL, "7.0" is 7', async () => {
    await reset(`CREATE DOMAIN ${SCHEMA}.ident AS integer;
      CREATE TABLE ${SCHEMA}.p (id ${SCHEMA}.ident PRIMARY KEY, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.c (id int PRIMARY KEY, tenant text NOT NULL, ref ${SCHEMA}.ident REFERENCES ${SCHEMA}.p (id));
      INSERT INTO ${SCHEMA}.p VALUES (7, 'a'), (2, 'b');`);
    const insert = (id: number, ref: string) => (tx: WriteTransaction) =>
      tx.insert({ table: `${SCHEMA}.c`, values: { id, tenant: 'a', ref } });
    assert.equal((await said(ofA('p', 'c'), insert(1, ''))).said, 'committed');
    assert.equal((await said(ofA('p', 'c'), insert(2, '7.0'))).said, 'committed');
    assert.deepEqual(await rows(`SELECT id, ref FROM ${SCHEMA}.c ORDER BY id`), [
      { id: 1, ref: null },
      { id: 2, ref: 7 },
    ]);
    // "2.0" is the hidden parent 2, refused as 2 is.
    assert.equal((await said(ofA('p', 'c'), insert(3, '2.0'))).said, REFUSED);
  });

  /* A reference with a generated column moves with what its expression reads, which no update names: an update of `x`
     re-pointed `k GENERATED ALWAYS AS (x + 1) STORED REFERENCES p` at a hidden parent and committed, while a missing
     one was refused by the foreign key. Every update now checks it after the statement, from the stored text. */
  test('a generated reference is checked after every update: a hidden parent and a missing one answer alike', async () => {
    await reset(`CREATE TABLE ${SCHEMA}.p (k int PRIMARY KEY, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.ch (id int PRIMARY KEY, x int NOT NULL, k int GENERATED ALWAYS AS (x + 1) STORED REFERENCES ${SCHEMA}.p,
                                 tenant text NOT NULL, note text);
      INSERT INTO ${SCHEMA}.p VALUES (1, 'a'), (2, 'b'), (3, 'a');
      INSERT INTO ${SCHEMA}.ch (id, x, tenant) VALUES (1, 0, 'a');`);
    const retag = (x: number) => (tx: WriteTransaction) => tx.update({ table: `${SCHEMA}.ch`, key: { id: 1 }, values: { x } });
    const hidden = await said(ofA('p', 'ch'), retag(1));
    assert.equal(hidden.said, REFUSED);
    assert.match(hidden.cause, /"scoped_references\.ch"\.k points at the "scoped_references\.p" row k "2"/);
    assert.equal((await said(ofA('p', 'ch'), retag(8))).said, REFUSED);
    assert.deepEqual(await rows(`SELECT x, k FROM ${SCHEMA}.ch`), [{ x: 0, k: 1 }]);
    assert.equal((await said(ofA('p', 'ch'), retag(2))).said, 'committed');
    const note = await said(ofA('p', 'ch'), (tx) => tx.update({ table: `${SCHEMA}.ch`, key: { id: 1 }, values: { note: 'seen' } }));
    assert.equal(note.said, 'committed', note.cause);
    assert.deepEqual(await rows(`SELECT x, k, note FROM ${SCHEMA}.ch`), [{ x: 2, k: 3, note: 'seen' }]);
  });

  /* The same hole in a trigger's proof (triggerProof.ts): an accepted trigger's `UPDATE g SET x = …` re-pointed g's
     generated reference at a hidden parent. */
  test("a trigger effect's update re-points a generated reference only at a parent the principal reads", async () => {
    await reset(`CREATE TABLE ${SCHEMA}.p (k int PRIMARY KEY, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.g (id int PRIMARY KEY, x int NOT NULL, k int GENERATED ALWAYS AS (x + 1) STORED REFERENCES ${SCHEMA}.p, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.s (id int PRIMARY KEY, ref int NOT NULL, n int NOT NULL);
      INSERT INTO ${SCHEMA}.p VALUES (1, 'a'), (2, 'b'), (3, 'a');
      INSERT INTO ${SCHEMA}.g (id, x, tenant) VALUES (10, 0, 'a');
      INSERT INTO ${SCHEMA}.s VALUES (1, 10, 0);
      CREATE FUNCTION ${SCHEMA}.f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE ${SCHEMA}.g SET x = NEW.n WHERE id = NEW.ref; RETURN NULL; END $$;
      CREATE TRIGGER t AFTER UPDATE OF n ON ${SCHEMA}.s FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.f();`);
    const scope = { [`${SCHEMA}.s`]: true, ...ofA('g', 'p') };
    const named = { named: new Map([[`${SCHEMA}.s`, new Map([['t', undefined]])]]) };
    const set = (n: number) => (tx: WriteTransaction) => tx.update({ table: `${SCHEMA}.s`, key: { id: 1 }, values: { n } });
    const hidden = await said(scope, set(1), named);
    assert.equal(hidden.said, REFUSED);
    assert.match(hidden.cause, /"scoped_references\.g"\.k points at the "scoped_references\.p" row k "2"/);
    assert.equal((await said(scope, set(8), named)).said, REFUSED);
    assert.deepEqual(await rows(`SELECT x, k FROM ${SCHEMA}.g`), [{ x: 0, k: 1 }]);
    const visible = await said(scope, set(2), named);
    assert.equal(visible.said, 'committed', visible.cause);
    assert.deepEqual(await rows(`SELECT x, k FROM ${SCHEMA}.g`), [{ x: 2, k: 3 }]);
  });

  test('a referenced generated column moved by an update is refused, and its cascade with it', async () => {
    await reset(`CREATE TABLE ${SCHEMA}.p (id int PRIMARY KEY, x int NOT NULL, g int GENERATED ALWAYS AS (x + 1) STORED UNIQUE, tenant text NOT NULL, note text);
      CREATE TABLE ${SCHEMA}.ch (id int PRIMARY KEY, g int REFERENCES ${SCHEMA}.p (g) ON UPDATE CASCADE, tenant text NOT NULL);
      INSERT INTO ${SCHEMA}.p (id, x, tenant) VALUES (1, 0, 'a');
      INSERT INTO ${SCHEMA}.ch VALUES (1, 1, 'b');`);
    const moved = await said(ofA('p', 'ch'), (tx) => tx.update({ table: `${SCHEMA}.p`, key: { id: 1 }, values: { x: 5 } }));
    assert.equal(moved.said, REFUSED);
    assert.match(moved.cause, /may not change "scoped_references\.p"\.g: a key, or a column another table references, generated/);
    assert.deepEqual(await rows(`SELECT g FROM ${SCHEMA}.ch`), [{ g: 1 }]);
    const note = await said(ofA('p', 'ch'), (tx) => tx.update({ table: `${SCHEMA}.p`, key: { id: 1 }, values: { note: 'x' } }));
    assert.equal(note.said, 'committed', note.cause);
  });

  /* A foreign key to a partitioned table is copied onto each of its partitions, each copy naming a partition the
     policy never declares: the catalog read those copies, and the check counted a visible parent through its
     partition and refused it. It reads the key as declared, counted through the partitioned table the policy names.
     Neither the partitioned table nor a partition is a scoped write's target (the hierarchy tests below). */
  for (const by of ['RANGE (k)', 'LIST (tenant)'])
    test(`a reference to a table partitioned by ${by}: the visible parent commits, a hidden or missing one is refused`, async () => {
      const partitions =
        by === 'RANGE (k)'
          ? `CREATE TABLE ${SCHEMA}.p_low PARTITION OF ${SCHEMA}.p FOR VALUES FROM (0) TO (100);
             CREATE TABLE ${SCHEMA}.p_high PARTITION OF ${SCHEMA}.p FOR VALUES FROM (100) TO (200);`
          : `CREATE TABLE ${SCHEMA}.p_low PARTITION OF ${SCHEMA}.p FOR VALUES IN ('a');
             CREATE TABLE ${SCHEMA}.p_high PARTITION OF ${SCHEMA}.p FOR VALUES IN ('b');`;
      await reset(`CREATE TABLE ${SCHEMA}.p (k int, tenant text NOT NULL, PRIMARY KEY (k${by.includes('tenant') ? ', tenant' : ''})) PARTITION BY ${by};
        ${partitions}
        CREATE TABLE ${SCHEMA}.ch (id int PRIMARY KEY, k int NOT NULL, ${by.includes('tenant') ? "pt text NOT NULL DEFAULT 'a', " : ''}tenant text NOT NULL,
          FOREIGN KEY (k${by.includes('tenant') ? ', pt' : ''}) REFERENCES ${SCHEMA}.p ON DELETE CASCADE);
        INSERT INTO ${SCHEMA}.p VALUES (1, 'a'), (101, 'b');
        INSERT INTO ${SCHEMA}.ch (id, k, tenant) VALUES (1, 1, 'b');`);
      const insert = (id: number, k: number, pt?: string) => (tx: WriteTransaction) =>
        tx.insert({ table: `${SCHEMA}.ch`, values: { id, k, tenant: 'a', ...(pt ? { pt } : {}) } });
      const list = by.includes('tenant');
      const visible = await said(ofA('p', 'ch'), insert(2, 1, list ? 'a' : undefined));
      assert.equal(visible.said, 'committed', visible.cause);
      const hidden = await said(ofA('p', 'ch'), insert(3, 101, list ? 'b' : undefined));
      assert.equal(hidden.said, REFUSED);
      assert.match(hidden.cause, /points at the "scoped_references\.p" row/);
      assert.equal((await said(ofA('p', 'ch'), insert(4, 150, list ? 'b' : undefined))).said, REFUSED);
      // Neither a partition nor the partitioned table is written: either would cascade to the hidden row.
      for (const table of ['p_low', 'p']) {
        const removed = await said(ofA(table, 'ch'), (tx) =>
          tx.remove({ table: `${SCHEMA}.${table}`, key: list ? { k: 1, tenant: 'a' } : { k: 1 } }),
        );
        assert.equal(removed.said, REFUSED);
        assert.match(removed.cause, new RegExp(`"scoped_references\\.${table}" ${HIERARCHY}`));
      }
      assert.deepEqual(await rows(`SELECT id FROM ${SCHEMA}.ch ORDER BY id`), [{ id: 1 }, { id: 2 }]);
    });

  /* A foreign key may be declared on a partition alone, or point at one, and an inheritance child keeps keys of its
     own: a write through the table above reaches rows under keys and cascades the table written does not have, which
     no parent or child check read. So no table in a partition or inheritance hierarchy is a scoped write's target,
     refused when the catalog is read, before any statement runs. */
  const PARTITIONED = `CREATE TABLE ${SCHEMA}.p (k int PRIMARY KEY, x int, code text, tenant text NOT NULL) PARTITION BY RANGE (k);
    CREATE TABLE ${SCHEMA}.p_low PARTITION OF ${SCHEMA}.p FOR VALUES FROM (0) TO (100);`;
  const refusedAs = (table: string, outcome: { said: string; cause: string }) => {
    assert.equal(outcome.said, REFUSED);
    assert.match(outcome.cause, new RegExp(`"scoped_references\\.${table}" ${HIERARCHY}`));
  };

  test('a key pointing at a partition: a delete or an update through the partitioned table is refused, nothing cascades', async () => {
    await reset(`${PARTITIONED}
      CREATE UNIQUE INDEX ON ${SCHEMA}.p_low (code);
      CREATE TABLE ${SCHEMA}.ch (id int PRIMARY KEY, k int REFERENCES ${SCHEMA}.p_low ON DELETE CASCADE,
        code text REFERENCES ${SCHEMA}.p_low (code) ON UPDATE CASCADE, tenant text NOT NULL);
      INSERT INTO ${SCHEMA}.p VALUES (1, NULL, 'x', 'a');
      INSERT INTO ${SCHEMA}.ch VALUES (1, 1, 'x', 'b'), (2, 1, 'x', 'a');`);
    // The hidden row of ch, and the visible one where ch is not declared: a cascade reached both.
    for (const scope of [ofA('p', 'ch'), ofA('p')])
      refusedAs('p', await said(scope, (tx) => tx.remove({ table: `${SCHEMA}.p`, key: { k: 1 } })));
    refusedAs('p', await said(ofA('p', 'ch'), (tx) => tx.update({ table: `${SCHEMA}.p`, key: { k: 1 }, values: { code: 'y' } })));
    assert.deepEqual(await rows(`SELECT id, k, code FROM ${SCHEMA}.ch ORDER BY id`), [
      { id: 1, k: 1, code: 'x' },
      { id: 2, k: 1, code: 'x' },
    ]);
  });

  test('a key declared on a partition alone: an insert or an update through the partitioned table is refused', async () => {
    await reset(`CREATE TABLE ${SCHEMA}.r (id int PRIMARY KEY, tenant text NOT NULL);
      ${PARTITIONED}
      ALTER TABLE ${SCHEMA}.p_low ADD FOREIGN KEY (x) REFERENCES ${SCHEMA}.r;
      INSERT INTO ${SCHEMA}.r VALUES (1, 'a'), (2, 'b');
      INSERT INTO ${SCHEMA}.p VALUES (5, 1, NULL, 'a');`);
    // x = 2 is tenant b's: nothing checked it.
    refusedAs('p', await said(ofA('p', 'r'), (tx) => tx.insert({ table: `${SCHEMA}.p`, values: { k: 1, x: 2, tenant: 'a' } })));
    refusedAs('p', await said(ofA('p', 'r'), (tx) => tx.update({ table: `${SCHEMA}.p`, key: { k: 5 }, values: { x: 2 } })));
    refusedAs('p_low', await said(ofA('p_low', 'r'), (tx) => tx.update({ table: `${SCHEMA}.p_low`, key: { k: 5 }, values: { x: 2 } })));
    assert.deepEqual(await rows(`SELECT k, x FROM ${SCHEMA}.p ORDER BY k`), [{ k: 5, x: 1 }]);
  });

  test('an inheritance parent and its child are refused as targets, whatever keys the child keeps', async () => {
    await reset(`CREATE TABLE ${SCHEMA}.r (id int PRIMARY KEY, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.p (k int PRIMARY KEY, x int, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.pc (PRIMARY KEY (k), FOREIGN KEY (x) REFERENCES ${SCHEMA}.r) INHERITS (${SCHEMA}.p);
      CREATE TABLE ${SCHEMA}.ch (id int PRIMARY KEY, k int REFERENCES ${SCHEMA}.pc ON DELETE CASCADE, tenant text NOT NULL);
      INSERT INTO ${SCHEMA}.r VALUES (1, 'a'), (2, 'b');
      INSERT INTO ${SCHEMA}.pc VALUES (5, 1, 'a');
      INSERT INTO ${SCHEMA}.ch VALUES (1, 5, 'b');`);
    // Through the parent: the child's key to r went unchecked, and its referrer's cascade reached a hidden row.
    refusedAs('p', await said(ofA('p', 'r'), (tx) => tx.update({ table: `${SCHEMA}.p`, key: { k: 5 }, values: { x: 2 } })));
    refusedAs('p', await said(ofA('p', 'ch'), (tx) => tx.remove({ table: `${SCHEMA}.p`, key: { k: 5 } })));
    refusedAs('pc', await said(ofA('pc', 'r', 'ch'), (tx) => tx.update({ table: `${SCHEMA}.pc`, key: { k: 5 }, values: { x: 1 } })));
    refusedAs('p', await said(ofA('p'), (tx) => tx.insert({ table: `${SCHEMA}.p`, values: { k: 9, tenant: 'a' } })));
    assert.deepEqual(await rows(`SELECT k, x FROM ${SCHEMA}.pc`), [{ k: 5, x: 1 }]);
    assert.deepEqual(await rows(`SELECT id FROM ${SCHEMA}.ch`), [{ id: 1 }]);
  });

  test('a trigger effect onto a partition or an inheritance child is refused, named for the hierarchy', async () => {
    await reset(`${PARTITIONED}
      CREATE TABLE ${SCHEMA}.q (k int PRIMARY KEY, n int, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.qc (PRIMARY KEY (k)) INHERITS (${SCHEMA}.q);
      CREATE TABLE ${SCHEMA}.s (id int PRIMARY KEY, ref int NOT NULL, n int NOT NULL);
      INSERT INTO ${SCHEMA}.p VALUES (1, 0, NULL, 'a'); INSERT INTO ${SCHEMA}.qc VALUES (1, 0, 'a'); INSERT INTO ${SCHEMA}.s VALUES (1, 1, 0);
      CREATE FUNCTION ${SCHEMA}.leaf() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE ${SCHEMA}.p_low SET x = NEW.n WHERE k = NEW.ref; RETURN NULL; END $$;
      CREATE TRIGGER leaf AFTER UPDATE OF n ON ${SCHEMA}.s FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.leaf();
      CREATE FUNCTION ${SCHEMA}.heir() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE ${SCHEMA}.qc SET n = NEW.ref WHERE k = NEW.ref; RETURN NULL; END $$;
      CREATE TRIGGER heir AFTER UPDATE OF ref ON ${SCHEMA}.s FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.heir();`);
    const named = (trigger: string): TriggerAcceptance => ({ named: new Map([[`${SCHEMA}.s`, new Map([[trigger, undefined]])]]) });
    const leaf = await said(
      { [`${SCHEMA}.s`]: true, ...ofA('p_low', 'p') },
      (tx) => tx.update({ table: `${SCHEMA}.s`, key: { id: 1 }, values: { n: 5 } }),
      named('leaf'),
    );
    assert.match(leaf.cause, /it writes "scoped_references\.p_low", part of a partition or inheritance hierarchy/);
    const heir = await said(
      { [`${SCHEMA}.s`]: true, ...ofA('qc') },
      (tx) => tx.update({ table: `${SCHEMA}.s`, key: { id: 1 }, values: { ref: 1 } }),
      named('heir'),
    );
    assert.match(heir.cause, /it writes "scoped_references\.qc", part of a partition or inheritance hierarchy/);
    assert.deepEqual(await rows(`SELECT n FROM ${SCHEMA}.s`), [{ n: 0 }]);
  });
});

test('a foreign key comparison names a type, not an expression: a type that would end the comparison is refused', () => {
  const where = (type: string) =>
    buildWhere(
      { groups: [[{ column: 'k', op: '=', value: 'x', equality: { operator: 'pg_catalog.=', type } }]] },
      POSTGRES_STYLE,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
  for (const type of [
    'pg_catalog.text',
    'pg_catalog."numeric"(10,2)',
    '"Odd ""Types"" S"."my dom"',
    'pg_catalog."varchar"(3)[]',
    'pg_catalog."numeric"(5,-2)',
  ])
    assert.match(where(type).text, /OPERATOR\(pg_catalog\.=\) \$1::/, type);
  for (const type of [
    'text) OR (true',
    'text OR true',
    'pg_catalog.text(1) OR (2)',
    'text--',
    'numeric(10,2,3)',
    'pg_catalog..text',
    'text[1]',
  ])
    assert.throws(() => where(type), /This read cannot compare as a foreign key does/, type);
});
