/**
 * The scope's catalog reads on PostgreSQL against a function or operator of the
 * same name on the writer's search_path.
 *
 * pg_catalog is searched first, so an exact signature stays the database's;
 * a polymorphic built-in — cardinality(anyarray), array_agg(anynonarray),
 * unnest(anyarray), format(text, VARIADIC "any"), anynonarray || text — loses
 * to an exact-typed one anywhere on the path. A role that can CREATE in such
 * a schema (any role in public up to PostgreSQL 14) and nothing else could
 * then answer the scope's questions: `public.cardinality(text[])` returning 0
 * read every table as having no triggers, and a scoped insert ran a trigger
 * that writes rows no policy bounds. Every catalog read the scope makes names
 * pg_catalog (scoped/postgresTriggers.ts CAT).
 *
 * One shadow per case, each with the answer that would mislead the scope, and
 * each case asserts the refusal the scope gives without it. Live and opt-in
 * like postgres-trigger-hardening.test.ts; the tables live in the schema
 * `scope_search_path` and the shadows in public, all dropped before and after.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Filter, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'scope_search_path';

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
const scope = (): RowScope => ({
  [`${SCHEMA}.item`]: eq('tenant', 'a'),
  [`${SCHEMA}.owner`]: eq('tenant', 'a'),
  [`${SCHEMA}.thing`]: eq('tenant', 'a'),
});

/** Each shadow by what it answers and how it is dropped: a misleading answer, never an error, so a scope that
 * called it would go on and decide by it. */
const SHADOWS: Array<{ name: string; create: string; drop: string }> = [
  {
    // Every table's trigger names counted as none: the facts read no triggers anywhere.
    name: 'cardinality(text[])',
    create: `CREATE FUNCTION public.cardinality(text[]) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 0'`,
    drop: `DROP FUNCTION IF EXISTS public.cardinality(text[])`,
  },
  {
    // Every aggregated name list empty: no trigger names, and every foreign key's columns none.
    name: 'array_agg(text)',
    create: `CREATE FUNCTION public.scope_keep(text[], text) RETURNS text[] LANGUAGE sql IMMUTABLE AS 'SELECT $1';
             CREATE AGGREGATE public.array_agg(text) (sfunc = public.scope_keep, stype = text[], initcond = '{}')`,
    drop: `DROP AGGREGATE IF EXISTS public.array_agg(text); DROP FUNCTION IF EXISTS public.scope_keep(text[], text)`,
  },
  {
    // A constraint's or trigger's column numbers (int2[]) unnested to nothing.
    name: 'unnest(smallint[])',
    create: `CREATE FUNCTION public.unnest(smallint[]) RETURNS SETOF smallint LANGUAGE sql IMMUTABLE AS 'SELECT 1::smallint WHERE false'`,
    drop: `DROP FUNCTION IF EXISTS public.unnest(smallint[])`,
  },
  {
    // A trigger's relation named as another table's, so the one written reads as having none.
    name: 'format(text, name, name)',
    create: `CREATE FUNCTION public.format(text, name, name) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT '${SCHEMA}.elsewhere'$$`,
    drop: `DROP FUNCTION IF EXISTS public.format(text, name, name)`,
  },
];

describe('the scope catalog on PostgreSQL, against a shadow on the search_path', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const dropShadows = async () => {
    for (const shadow of SHADOWS) await control.query(shadow.drop);
    await control.query(`DROP OPERATOR IF EXISTS public.|| (text, oid); DROP FUNCTION IF EXISTS public.scope_same(text, oid)`);
  };
  const reset = async () => {
    await dropShadows();
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.query(`CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.secret (id serial PRIMARY KEY, note text);
      CREATE TABLE ${SCHEMA}.item (id int PRIMARY KEY, tenant text NOT NULL);
      CREATE FUNCTION ${SCHEMA}.spill() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO ${SCHEMA}.secret (note) VALUES ('written by a trigger no policy bounds'); RETURN NEW; END $$;
      CREATE TRIGGER spill AFTER INSERT ON ${SCHEMA}.item FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.spill();
      CREATE TABLE ${SCHEMA}.owner (id int PRIMARY KEY, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.thing (id int PRIMARY KEY, tenant text NOT NULL, owner_id int REFERENCES ${SCHEMA}.owner (id));
      INSERT INTO ${SCHEMA}.owner VALUES (1, 'a'), (2, 'b');`);
  };
  before(async () => {
    control = await client();
    await reset();
  });
  after(async () => {
    await dropShadows();
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.end();
  });

  const attempt = async (
    write: (adapter: PostgresAdapter) => Promise<unknown>,
    adapter = new PostgresAdapter(LIVE!, 'shadow', [SCHEMA]),
  ) => {
    try {
      await write(adapter);
      return 'committed';
    } catch (error) {
      return String(refusalCause(error as Error) ?? (error as Error).message);
    }
  };
  const insert = (table: string, values: Record<string, string | number>) => (adapter: PostgresAdapter) =>
    adapter.scopeTransaction(scope(), (tx) => tx.insert({ table: `${SCHEMA}.${table}`, values }));

  for (const shadow of SHADOWS) {
    test(`public.${shadow.name}: a writing trigger still refuses the write, and a hidden parent is still refused`, async () => {
      await reset();
      await control.query(shadow.create);
      const adapter = new PostgresAdapter(LIVE!, 'shadow', [SCHEMA]);
      try {
        const triggered = await attempt(insert('item', { id: 1, tenant: 'a' }), adapter);
        assert.match(triggered, /fires the trigger "spill"/, triggered);
        const spilled = (await control.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.secret`)).rows[0] as { n: number };
        assert.equal(spilled.n, 0);
        const pointed = await attempt(insert('thing', { id: 1, tenant: 'a', owner_id: 2 }), adapter);
        assert.match(pointed, /points at the "scope_search_path\.owner" row id 2, which the principal's rows do not include/, pointed);
        assert.equal(await attempt(insert('thing', { id: 2, tenant: 'a', owner_id: 1 }), adapter), 'committed');
      } finally {
        await adapter.close();
        await control.query(shadow.drop);
      }
    });
  }

  test('public.||(text, oid): the catalog digest still moves when a trigger is added', async () => {
    await reset();
    await control.query(`DROP TRIGGER spill ON ${SCHEMA}.item;
      CREATE FUNCTION public.scope_same(text, oid) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT 'same'$$;
      CREATE OPERATOR public.|| (leftarg = text, rightarg = oid, function = public.scope_same)`);
    const adapter = new PostgresAdapter(LIVE!, 'shadow', [SCHEMA]);
    try {
      assert.equal(await attempt(insert('item', { id: 1, tenant: 'a' }), adapter), 'committed');
      await control.query(`CREATE TRIGGER spill AFTER INSERT ON ${SCHEMA}.item FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.spill()`);
      const after = await attempt(insert('item', { id: 2, tenant: 'a' }), adapter);
      assert.match(after, /fires the trigger "spill"/, after);
      const spilled = (await control.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.secret`)).rows[0] as { n: number };
      assert.equal(spilled.n, 0);
    } finally {
      await adapter.close();
    }
  });
  /* The parent check reads the value as the referencing column's type: named by its schema, not found through the
     search_path, or a type made after the catalog was read decides what it reads. With pg_catalog after public, a
     domain public.text over name, made mid-transaction, read a 64-character key as its first 63: the check found tenant
     a's 63-character key, the foreign key tenant b's 64-character one, and the insert committed. */
  test('public.text made mid-transaction: the parent check still reads the value as pg_catalog.text', async () => {
    await control.query(`DROP DOMAIN IF EXISTS public.text CASCADE; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.code (code text PRIMARY KEY, tenant text NOT NULL);
      CREATE TABLE ${SCHEMA}.pick (id int PRIMARY KEY, tenant text NOT NULL, code text REFERENCES ${SCHEMA}.code (code));
      INSERT INTO ${SCHEMA}.code VALUES (repeat('x', 63), 'a'), (repeat('x', 64), 'b');`);
    const path = `options=${encodeURIComponent('-c search_path=public,pg_catalog')}`;
    const adapter = new PostgresAdapter(`${LIVE!}${LIVE!.includes('?') ? '&' : '?'}${path}`, 'shadow', [SCHEMA]);
    const picks: RowScope = { [`${SCHEMA}.code`]: eq('tenant', 'a'), [`${SCHEMA}.pick`]: eq('tenant', 'a') };
    const pick = (id: number, code: string) => (tx: WriteTransaction) =>
      tx.insert({ table: `${SCHEMA}.pick`, values: { id, tenant: 'a', code } });
    try {
      // The catalog read and kept for the next transaction.
      assert.equal(await attempt(() => adapter.scopeTransaction(picks, pick(1, 'x'.repeat(63))), adapter), 'committed');
      const shadowed = await attempt(
        () =>
          adapter.scopeTransaction(picks, async (tx) => {
            await control.query(`CREATE DOMAIN public.text AS name`);
            await pick(2, 'x'.repeat(64))(tx);
          }),
        adapter,
      );
      assert.match(shadowed, /points at the "scope_search_path\.code" row/, shadowed);
      const rows = (await control.query(`SELECT id FROM ${SCHEMA}.pick ORDER BY id`)).rows as Array<{ id: number }>;
      assert.deepEqual(
        rows.map((row) => row.id),
        [1],
      );
    } finally {
      await adapter.close();
      await control.query(`DROP DOMAIN IF EXISTS public.text CASCADE`);
    }
  });

  /* The description's own reads compare information_schema names (sql_identifier) with text: an exact-signature
     operator in public answering either way must not change the tables or keys the scope reads. */
  for (const answer of ['false', 'true'])
    test(`public.=(sql_identifier, text) answering ${answer}: the description still reads the scope's tables and keys`, async () => {
      await reset();
      const drop = `DROP OPERATOR IF EXISTS public.= (information_schema.sql_identifier, text);
        DROP FUNCTION IF EXISTS public.scope_answer(information_schema.sql_identifier, text)`;
      await control.query(`${drop};
        CREATE FUNCTION public.scope_answer(information_schema.sql_identifier, text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT ${answer}';
        CREATE OPERATOR public.= (leftarg = information_schema.sql_identifier, rightarg = text, function = public.scope_answer)`);
      const adapter = new PostgresAdapter(LIVE!, 'shadow', [SCHEMA]);
      try {
        const pointed = await attempt(insert('thing', { id: 1, tenant: 'a', owner_id: 2 }), adapter);
        assert.match(pointed, /points at the "scope_search_path\.owner" row id 2, which the principal's rows do not include/, pointed);
        assert.equal(await attempt(insert('thing', { id: 2, tenant: 'a', owner_id: 1 }), adapter), 'committed');
        assert.match(await attempt(insert('thing', { id: 3, tenant: 'b', owner_id: 1 }), adapter), /outside the principal's rows/);
      } finally {
        await adapter.close();
        await control.query(drop);
      }
    });
});
