/**
 * Ways past the trigger proof on PostgreSQL that a review found, each against
 * a real server: code of the database's that a scoped write would run though
 * the proof said its triggers only validate (postgresTriggers.ts).
 *
 * Every case has a function that records that it ran, in a table the write
 * cannot reach, and asserts it did not: what a hostile function would do
 * there instead is read a row the policy hides, or write one.
 *
 * Live and opt-in like postgres-scoped-transactions.test.ts: `TABLEWALK_TEST_PG`
 * names a disposable database. Everything here lives in the schema
 * `trigger_hardening`, dropped before and after; the casts a case makes are
 * the database's own and are dropped with it. Some cases need a superuser (a
 * cast between built-in types); what a non-superuser needs for each is said
 * beside it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Refusal, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'trigger_hardening';
const ITEM = `${SCHEMA}.item`;

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
const scopeA = (): RowScope => ({ [ITEM]: eq('tenant', 'a') });

describe('the trigger proof on PostgreSQL, against what a review found past it', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  // Whether this file installed citext (in public, where every writer's search_path finds it), and so drops it.
  let citext = false;
  const reset = async () => {
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.query(`DROP CAST IF EXISTS (boolean AS numeric)`);
    await control.query(`DROP FUNCTION IF EXISTS public."\u00a0"(integer)`);
    if (citext) await control.query(`DROP EXTENSION IF EXISTS citext`);
    citext = false;
    await control.query(`CREATE SCHEMA ${SCHEMA}`);
    await control.query(`CREATE TABLE ${SCHEMA}.ran (what text)`);
    await control.query(`CREATE TABLE ${ITEM} (id int PRIMARY KEY, tenant text NOT NULL, name text, n int);
      INSERT INTO ${ITEM} VALUES (1, 'a', 'mine', 0), (2, 'b', 'theirs', 0)`);
  };
  const ran = async () => (await control.query(`SELECT what FROM ${SCHEMA}.ran ORDER BY 1`)).rows.map((row) => row.what);
  /** A function that says it ran, of any signature: the hostile code in each case. */
  const telling = (name: string, args: string, returns: string, value: string) =>
    `CREATE FUNCTION ${name}(${args}) RETURNS ${returns} LANGUAGE plpgsql AS $$
       BEGIN INSERT INTO ${SCHEMA}.ran VALUES ('${name.replace(/"/g, '')} ran'); RETURN ${value}; END $$`;
  const check = (condition: string) =>
    `CREATE FUNCTION ${SCHEMA}.check_n() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF ${condition} THEN RAISE EXCEPTION 'bad n'; END IF;
         RETURN NEW;
       END $$;
     CREATE TRIGGER v BEFORE UPDATE OF n ON ${ITEM} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.check_n()`;
  async function withAdapter<T>(run: (adapter: PostgresAdapter) => Promise<T>): Promise<T> {
    const adapter = new PostgresAdapter(LIVE!, 'trigger hardening', [SCHEMA]);
    try {
      return await run(adapter);
    } finally {
      await adapter.close();
    }
  }
  const update = (adapter: PostgresAdapter, values: Record<string, string | number | boolean | null>) =>
    adapter.scopeTransaction(scopeA(), (tx) => tx.update({ table: ITEM, key: { id: 1 }, values }));
  const causeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => assert.fail('the write was not refused'),
      (error: unknown) => String(refusalCause(error)),
    );

  before(async () => {
    control = await client();
  });
  after(async () => {
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await control.query(`DROP CAST IF EXISTS (boolean AS numeric)`).catch(() => {});
    await control.query(`DROP FUNCTION IF EXISTS public."\u00a0"(integer)`).catch(() => {});
    if (citext) await control.query(`DROP EXTENSION IF EXISTS citext`).catch(() => {});
    await control.end();
  });

  /* PL/pgSQL's tokenizer took U+00A0 for whitespace; PostgreSQL reads it as a letter, so `IF <U+00A0>(NEW.n)` is a
     call of a function named U+00A0. Needs only CREATE on a schema in the writer's search_path (public, here). */
  test('a function named by a character PostgreSQL reads as a letter is a call, not a space', async () => {
    await reset();
    await control.query(telling('public."\u00a0"', 'integer', 'boolean', 'false'));
    await control.query(check('\u00a0(NEW.n)'));
    await withAdapter(async (adapter) => {
      assert.match(await causeOf(update(adapter, { n: 5 })), /an update of n fires the trigger "v"/);
    });
    assert.deepEqual(await ran(), []);
  });

  /* `TRUE + 1.5` resolves through an implicit cast from boolean to numeric: a function of the database's, though no
     column of the table is either type. A cast needs ownership of one of its types: a superuser here, but any owner
     of a type of their own could do the same with a literal of it. */
  test('an implicit cast between two literals runs no function of the database’s', async () => {
    await reset();
    await control.query(telling(`${SCHEMA}.b2n`, 'boolean', 'numeric', '0'));
    await control.query(`CREATE CAST (boolean AS numeric) WITH FUNCTION ${SCHEMA}.b2n(boolean) AS IMPLICIT`);
    await control.query(check('TRUE + 1.5 < 0'));
    await withAdapter(async (adapter) => {
      assert.match(await causeOf(update(adapter, { n: 5 })), /fires the trigger "v" \(a condition of it runs a function/);
      // `mistri check` reads the same verdict, on a writer of its own.
      assert.deepEqual(
        (await adapter.triggers()).get(ITEM)?.map((trigger) => [trigger.name, trigger.validates]),
        [['v', false]],
      );
    });
    assert.deepEqual(await ran(), []);
  });

  /* An extension's operators made every trigger using `<` or `=` unproven, by name, though `NEW.n < 0` on an integer
     resolves to PostgreSQL's own. Now it is the operator PostgreSQL resolves that is judged, and an extension's
     immutable C operator (citext's `=`) is one a superuser installed. citext is a trusted extension: a database
     owner may install it. */
  test('with citext installed, a validation trigger on an integer and one on a citext column both validate', async () => {
    await reset();
    const installed = await control.query(`SELECT 1 FROM pg_extension WHERE extname = 'citext'`);
    if (!installed.rows.length) {
      await control.query(`CREATE EXTENSION citext SCHEMA public`);
      citext = true;
    }
    await control.query(`ALTER TABLE ${ITEM} ADD COLUMN email citext`);
    await control.query(check('NEW.n < 0'));
    await control.query(`CREATE FUNCTION ${SCHEMA}.check_email() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.email = 'ROOT@EXAMPLE.COM' THEN RAISE EXCEPTION 'reserved'; END IF;
         RETURN NEW;
       END $$;
     CREATE TRIGGER e BEFORE UPDATE OF email ON ${ITEM} FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.check_email()`);
    await withAdapter(async (adapter) => {
      assert.deepEqual(
        (await adapter.triggers()).get(ITEM)?.map((trigger) => [trigger.name, trigger.validates]),
        [
          ['e', true],
          ['v', true],
        ],
      );
      await update(adapter, { n: 5 });
      await assert.rejects(update(adapter, { n: -1 }), /bad n/);
      // citext's own `=`, which the writer's search_path finds as the trigger will.
      await adapter.scopeTransaction(scopeA(), async (tx) => {
        await tx.update({ table: ITEM, key: { id: 1 }, values: { email: 'me@example.com' } });
      });
    });
    assert.deepEqual((await control.query(`SELECT n, email::text FROM ${ITEM} WHERE id = 1`)).rows[0], { n: 5, email: 'me@example.com' });
  });

  /* A write through a partitioned table lands in a leaf, and one through an inheritance parent reaches its children's
     rows: each fires its own triggers, and meets keys of its own. No table in a partition or inheritance hierarchy is a
     scoped write's target (postgres-scoped-references.test.ts); the triggers are still read as the table's, for
     `mistri check`. Needs ownership of the partition or child (a trigger on it is its owner's to make). */
  const effect = `CREATE FUNCTION ${SCHEMA}.effect() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN INSERT INTO ${SCHEMA}.ran VALUES (TG_NAME || ' on ' || TG_TABLE_NAME); RETURN NEW; END $$`;
  const PART = `${SCHEMA}.part`;
  const partition = async (trigger: string) => {
    await reset();
    await control.query(effect);
    await control.query(`CREATE TABLE ${PART} (id int, tenant text NOT NULL, name text, n int, PRIMARY KEY (id, tenant)) PARTITION BY LIST (tenant);
      CREATE TABLE ${PART}_a PARTITION OF ${PART} FOR VALUES IN ('a');
      CREATE TABLE ${PART}_b PARTITION OF ${PART} FOR VALUES IN ('b');
      INSERT INTO ${PART} VALUES (1, 'a', 'mine', 0), (2, 'b', 'theirs', 0);
      ${trigger}`);
  };
  const partScope = (): RowScope => ({ [PART]: eq('tenant', 'a') });
  const HIERARCHY = /is part of a partition or inheritance hierarchy, which writes under a row policy do not support yet/;
  const everyWrite = (adapter: PostgresAdapter, table: string, scope: RowScope, key: Record<string, string | number>) => [
    () => adapter.scopeTransaction(scope, (tx) => tx.update({ table, key, values: { name: 'x' } })),
    () => adapter.scopeTransaction(scope, (tx) => tx.insert({ table, values: { id: 3, tenant: 'a', name: 'new' } })),
    () => adapter.scopeTransaction(scope, (tx) => tx.remove({ table, key })),
  ];

  test('a partitioned table with a trigger on a leaf is refused as a target; the trigger is still read as its own', async () => {
    await partition(`CREATE TRIGGER leaf AFTER INSERT OR UPDATE ON ${PART}_a FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.effect()`);
    await withAdapter(async (adapter) => {
      for (const write of everyWrite(adapter, PART, partScope(), { id: 1, tenant: 'a' })) assert.match(await causeOf(write()), HIERARCHY);
      assert.deepEqual(
        (await adapter.triggers()).get(PART)?.map((trigger) => [trigger.name, trigger.validates]),
        [['part_a.leaf', false]],
      );
    });
    assert.deepEqual(await ran(), []);
    assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${PART}`)).rows[0].n, 2);
  });

  test('a trigger made on the partitioned table is judged once, not again as each partition’s clone', async () => {
    await partition(`${check('NEW.n < 0').replaceAll(ITEM, PART)}`);
    await withAdapter(async (adapter) => {
      assert.deepEqual(
        (await adapter.triggers()).get(PART)?.map((trigger) => [trigger.name, trigger.validates]),
        [['v', true]],
      );
      assert.match(
        await causeOf(
          adapter.scopeTransaction(partScope(), (tx) => tx.update({ table: PART, key: { id: 1, tenant: 'a' }, values: { n: 4 } })),
        ),
        HIERARCHY,
      );
    });
  });

  test('an inheritance parent with a trigger on its child is refused as a target', async () => {
    await reset();
    await control.query(effect);
    await control.query(`CREATE TABLE ${SCHEMA}.child () INHERITS (${ITEM});
      CREATE TRIGGER heir AFTER UPDATE OR DELETE ON ${SCHEMA}.child FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.effect()`);
    await withAdapter(async (adapter) => {
      for (const write of everyWrite(adapter, ITEM, scopeA(), { id: 1 })) assert.match(await causeOf(write()), HIERARCHY);
    });
    assert.deepEqual(await ran(), []);
  });

  /* A write runs a table's code that is not a trigger: a CHECK, a column's default, a domain's constraints. Each may
     call a function of the database's, which reads past the policy: here `peek` says by refusing whether a hidden row
     holds the value. Needs only ownership of the table, or of a domain or function in a schema the writer uses. */
  const peek = `CREATE FUNCTION ${SCHEMA}.peek(text) RETURNS boolean LANGUAGE plpgsql AS $$
     BEGIN
       INSERT INTO ${SCHEMA}.ran VALUES ('peek ran');
       RETURN NOT EXISTS (SELECT 1 FROM ${ITEM} WHERE tenant = 'b' AND name = $1);
     END $$`;

  test('a CHECK, a default or a domain that calls a function of the database’s refuses the writes that run it', async () => {
    await reset();
    await control.query(peek);
    await control.query(telling(`${SCHEMA}.stamp`, '', 'text', "'x'"));
    await control.query(`CREATE DOMAIN ${SCHEMA}.code AS text CHECK (${SCHEMA}.peek(VALUE))`);
    await control.query(`CREATE TABLE ${SCHEMA}.ledger (id int PRIMARY KEY, tenant text NOT NULL, name text CHECK (${SCHEMA}.peek(name)),
        stamp text DEFAULT ${SCHEMA}.stamp(), c ${SCHEMA}.code);
      INSERT INTO ${SCHEMA}.ledger (id, tenant, name, stamp) VALUES (1, 'a', 'mine', 's'), (2, 'b', 'other', 's');
      DELETE FROM ${SCHEMA}.ran`);
    const LEDGER = `${SCHEMA}.ledger`;
    const scope = (): RowScope => ({ [LEDGER]: eq('tenant', 'a') });
    await withAdapter(async (adapter) => {
      // Whether the CHECK refuses `theirs` says that tenant b has a row named so.
      assert.match(
        await causeOf(adapter.scopeTransaction(scope(), (tx) => tx.update({ table: LEDGER, key: { id: 1 }, values: { name: 'theirs' } }))),
        new RegExp(`an update of name runs the CHECK constraint "ledger_name_check" \\(it calls ${SCHEMA}\\.peek\\(text\\)\\)`),
      );
      const insert = await causeOf(adapter.scopeTransaction(scope(), (tx) => tx.insert({ table: LEDGER, values: { id: 3, tenant: 'a' } })));
      assert.match(insert, new RegExp(`the default of column "stamp" \\(it calls ${SCHEMA}\\.stamp\\(\\)\\)`));
      assert.match(insert, new RegExp(`the domain "${SCHEMA}\\.code" \\(it calls ${SCHEMA}\\.peek\\(text\\)\\)`));
      // A delete runs none of it.
      await adapter.scopeTransaction(scope(), (tx) => tx.remove({ table: LEDGER, key: { id: 1 } }));
      // `mistri check` names each, and which writes it blocks.
      assert.deepEqual(
        (await adapter.triggers()).get(LEDGER)?.map((code) => [code.kind, code.name, code.events, code.columns]),
        [
          ['CHECK constraint', 'ledger_name_check', ['insert', 'update'], undefined],
          ['default of column', 'stamp', ['insert'], undefined],
          ['domain', `${SCHEMA}.code`, ['insert', 'update'], ['c']],
        ],
      );
    });
    assert.deepEqual(await ran(), []);
  });

  test('a domain is found through arrays, composites, domains over domains and a cast in an expression', async () => {
    await reset();
    await control.query(peek);
    await control.query(`CREATE DOMAIN ${SCHEMA}.code AS text CHECK (${SCHEMA}.peek(VALUE));
      CREATE DOMAIN ${SCHEMA}.outer_code AS ${SCHEMA}.code;
      CREATE TYPE ${SCHEMA}.pair AS (a int, b ${SCHEMA}.outer_code);
      ALTER TABLE ${ITEM} ADD COLUMN codes ${SCHEMA}.code[], ADD COLUMN pair ${SCHEMA}.pair,
        ADD CONSTRAINT cast_check CHECK (name IS NULL OR (name::${SCHEMA}.code) IS NOT NULL) NOT VALID`);
    await withAdapter(async (adapter) => {
      const code = (await adapter.triggers()).get(ITEM)!;
      assert.deepEqual(
        code.map((entry) => [entry.kind, entry.name, entry.columns, entry.why]),
        [
          ['CHECK constraint', 'cast_check', undefined, `it calls ${SCHEMA}.peek(text)`],
          ['domain', `${SCHEMA}.code`, ['codes'], `it calls ${SCHEMA}.peek(text)`],
          // Through outer_code, which calls nothing itself.
          ['domain', `${SCHEMA}.code`, ['pair'], `it calls ${SCHEMA}.peek(text)`],
        ],
      );
      assert.match(await causeOf(update(adapter, { n: 1 })), /runs the CHECK constraint "cast_check"/);
    });
    assert.deepEqual(await ran(), []);
  });

  /* A validation trigger's literal compared with an array of a domain is read through the domain's input each time
     PL/pgSQL parses the condition, which runs the domain's checks — on an update that sets no column of that type. */
  test('a literal a validation trigger reads as a domain’s value refuses the trigger', async () => {
    await reset();
    await control.query(peek);
    await control.query(`CREATE DOMAIN ${SCHEMA}.code AS text CHECK (${SCHEMA}.peek(VALUE));
      ALTER TABLE ${ITEM} ADD COLUMN codes ${SCHEMA}.code[]`);
    await control.query(check(`NEW.codes = '{theirs}'`));
    await withAdapter(async (adapter) => {
      assert.match(
        await causeOf(update(adapter, { n: 1 })),
        /fires the trigger "v" \(a literal in a condition of it is read as a domain's value/,
      );
    });
    assert.deepEqual(await ran(), []);
  });

  test('a domain blocks only the writes of its column; a generated column and an expression index block every write', async () => {
    await reset();
    await control.query(peek);
    await control.query(`CREATE DOMAIN ${SCHEMA}.code AS text CHECK (${SCHEMA}.peek(VALUE));
      ALTER TABLE ${ITEM} ADD COLUMN codes ${SCHEMA}.code[]`);
    await withAdapter(async (adapter) => {
      assert.match(await causeOf(update(adapter, { codes: '{x}' })), /an update of codes runs the domain "trigger_hardening\.code"/);
      await update(adapter, { n: 1 });
    });
    // An index or a generated column takes only an IMMUTABLE function, which may still call one that is not.
    await control.query(telling(`${SCHEMA}.said`, '', 'void', ''));
    await control.query(`CREATE FUNCTION ${SCHEMA}.ok(integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
         BEGIN PERFORM ${SCHEMA}.said(); RETURN $1; END $$;
      ALTER TABLE ${ITEM} ADD COLUMN twice int GENERATED ALWAYS AS (${SCHEMA}.ok(n) * 2) STORED;
      CREATE INDEX item_ok ON ${ITEM} (${SCHEMA}.ok(id));
      DELETE FROM ${SCHEMA}.ran`);
    await withAdapter(async (adapter) => {
      const cause = await causeOf(update(adapter, { name: 'mine' }));
      assert.match(cause, /the generated column "twice" \(it calls trigger_hardening\.ok\(integer\)\)/);
      assert.match(cause, /the index "item_ok" \(it calls trigger_hardening\.ok\(integer\)\)/);
    });
    assert.deepEqual(await ran(), []);
  });

  test('a table whose defaults and checks are PostgreSQL’s own is written as before', async () => {
    await reset();
    await control.query(`CREATE TABLE ${SCHEMA}.plain (id int PRIMARY KEY, tenant text NOT NULL, at timestamptz DEFAULT now(),
        serial_id serial, token uuid DEFAULT gen_random_uuid(), CHECK (id > 0), CHECK (length(tenant) < 10))`);
    const PLAIN = `${SCHEMA}.plain`;
    await withAdapter(async (adapter) => {
      assert.equal((await adapter.triggers()).get(PLAIN), undefined);
      await adapter.scopeTransaction({ [PLAIN]: eq('tenant', 'a') }, async (tx) => {
        await tx.insert({ table: PLAIN, values: { id: 1, tenant: 'a' } });
        await tx.update({ table: PLAIN, key: { id: 1 }, values: { tenant: 'a' } });
      });
    });
  });

  /* A trigger's function is replaced, committed, after the transaction read the proof and before its write fires it:
     CREATE OR REPLACE FUNCTION takes no lock on the table. What the replacement raises was the write's error, said to
     the caller before COMMIT, where the proof is read again, was ever reached. Needs only ownership of the function. */
  test('a validation trigger replaced after the proof was read raises nothing to the caller', async () => {
    await reset();
    await control.query(check('NEW.n < 0'));
    await withAdapter(async (adapter) => {
      const failed = await adapter
        .scopeTransaction(scopeA(), async (tx) => {
          await control.query(`CREATE OR REPLACE FUNCTION ${SCHEMA}.check_n() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION '%', (SELECT name FROM ${ITEM} WHERE tenant = 'b'); END $$`);
          await tx.update({ table: ITEM, key: { id: 1 }, values: { n: 1 } });
        })
        .then(
          () => assert.fail('the write was not refused'),
          (error: unknown) => error,
        );
      assert.ok(failed instanceof Refusal, String(failed));
      assert.doesNotMatch(String((failed as Error).message), /theirs/);
      // Unreplaced, a validation trigger's own words still reach the caller.
      await reset();
      await control.query(check('NEW.n < 0'));
      await assert.rejects(update(adapter, { n: -1 }), /bad n/);
    });
  });
});
