/**
 * An App's scoped reads on PostgreSQL against an operator of the same name on
 * the reader's search_path.
 *
 * pg_catalog is searched first, so an exact signature stays the database's,
 * but it has no `varchar = varchar` and no `varchar ~~* text`: a varchar
 * column compared with a bare `=` (or read through IN, or ILIKE) found an
 * exact-typed operator a schema author made in public before pg_catalog's
 * `text = text`. One answering true read every tenant's rows through a policy
 * of `tenant = 'a'`. With pg_catalog after public on the path, even an exact
 * signature is the shadow's, and a `false` policy written `1 = 0` admitted
 * every row. Each comparison of a built-in type now names pg_catalog's
 * operator (filter.ts SqlStyle.builtin); a type of the database's own, citext
 * here, keeps its own operator, which is what its column means.
 *
 * Live and opt-in like postgres-scope-search-path.test.ts; the tables live in
 * the schema `scoped_read_ops` and the shadows in public, all dropped before
 * and after.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Filter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { ViewDef } from '../packages/engine/src/shared/viewPaths.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SCHEMA = 'scoped_read_ops';
const DOC = `${SCHEMA}.doc`;

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

const where = (column: string, op: '=' | 'in' | 'contains' | '!=', value: string | string[]): Filter => ({
  groups: [[{ column, op, value }]],
});
const ids = (rows: readonly Record<string, unknown>[]) => rows.map((row) => Number(row.id)).sort((a, b) => a - b);

/** Each shadow by the operator it makes, answering true, and how it is dropped. */
const SHADOWS = {
  eq: {
    create: `CREATE FUNCTION public.ops_yes(varchar, varchar) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
             CREATE OPERATOR public.= (leftarg = varchar, rightarg = varchar, function = public.ops_yes)`,
    drop: `DROP OPERATOR IF EXISTS public.= (varchar, varchar); DROP FUNCTION IF EXISTS public.ops_yes(varchar, varchar)`,
  },
  ne: {
    create: `CREATE FUNCTION public.ops_no(varchar, varchar) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
             CREATE OPERATOR public.<> (leftarg = varchar, rightarg = varchar, function = public.ops_no)`,
    drop: `DROP OPERATOR IF EXISTS public.<> (varchar, varchar); DROP FUNCTION IF EXISTS public.ops_no(varchar, varchar)`,
  },
  like: {
    create: `CREATE FUNCTION public.ops_like(varchar, text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
             CREATE OPERATOR public.~~* (leftarg = varchar, rightarg = text, function = public.ops_like)`,
    drop: `DROP OPERATOR IF EXISTS public.~~* (varchar, text); DROP FUNCTION IF EXISTS public.ops_like(varchar, text)`,
  },
  int: {
    create: `CREATE FUNCTION public.ops_int(int4, int4) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true';
             CREATE OPERATOR public.= (leftarg = int4, rightarg = int4, function = public.ops_int)`,
    drop: `DROP OPERATOR IF EXISTS public.= (int4, int4); DROP FUNCTION IF EXISTS public.ops_int(int4, int4)`,
  },
};

describe("an App's scoped reads on PostgreSQL, against an operator on the search_path", { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  let citext = false;
  const dropShadows = async () => {
    for (const shadow of Object.values(SHADOWS)) await control.query(shadow.drop);
  };
  before(async () => {
    control = await client();
    await dropShadows();
    try {
      await control.query('CREATE EXTENSION IF NOT EXISTS citext');
      citext = true;
    } catch {
      citext = false;
    }
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${DOC} (id int PRIMARY KEY, tenant varchar(8) NOT NULL, title varchar NOT NULL);
      CREATE TABLE ${SCHEMA}.hidden (id int PRIMARY KEY);
      INSERT INTO ${DOC} VALUES (1, 'a', 'alpha'), (2, 'a', 'beta'), (3, 'b', 'gamma');
      INSERT INTO ${SCHEMA}.hidden VALUES (1), (2);
      ${citext ? `CREATE TABLE ${SCHEMA}.member (id int PRIMARY KEY, email citext NOT NULL); INSERT INTO ${SCHEMA}.member VALUES (1, 'Ana@Example.com'), (2, 'bo@example.com');` : ''}`);
  });
  after(async () => {
    await dropShadows();
    await control.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await control.end();
  });

  /** One adapter per case, on the path the case names, closed after it; each shadow made for the case and dropped. */
  const reading = async (
    shadows: Array<keyof typeof SHADOWS>,
    read: (adapter: PostgresAdapter) => Promise<void>,
    path?: string,
  ): Promise<void> => {
    for (const shadow of shadows) await control.query(SHADOWS[shadow].create);
    const url = path ? `${LIVE!}${LIVE!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${path}`)}` : LIVE!;
    const adapter = new PostgresAdapter(url, 'shadow', [SCHEMA]);
    try {
      await read(adapter);
    } finally {
      await adapter.close();
      for (const shadow of shadows) await control.query(SHADOWS[shadow].drop);
    }
  };
  const tenantA: RowScope = { [DOC]: where('tenant', '=', 'a') };

  test("public.=(varchar, varchar) answering true: a policy of tenant = 'a' still reads tenant a's rows only", async () => {
    await reading(['eq'], async (adapter) => {
      const reads = await adapter.scopeReads(tenantA);
      assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: DOC })).rows), [1, 2]);
      assert.equal(await reads.count(DOC), 2);
      // The reader's own filter, inside the policy, compares as the database does too.
      assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: DOC, filter: where('title', '=', 'beta') })).rows), [2]);
      const view: ViewDef = {
        id: 'docs',
        name: 'docs',
        base: DOC,
        columns: [{ path: 'id' }, { path: 'title' }],
        filter: { groups: [[{ path: 'title', op: '=', value: 'alpha' }]] },
      };
      assert.deepEqual(ids((await reads.runView(view)).rows), [1]);
    });
  });

  test("public.=(varchar, varchar) answering true: a policy of tenant in ['a'] still reads tenant a's rows only", async () => {
    await reading(['eq'], async (adapter) => {
      const reads = await adapter.scopeReads({ [DOC]: where('tenant', 'in', ['a']) });
      assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: DOC })).rows), [1, 2]);
      assert.deepEqual(
        ids((await reads.query({ limit: 50, offset: 0, table: DOC, filter: where('title', 'in', ['gamma', 'beta']) })).rows),
        [2],
      );
    });
  });

  test('public.<>(varchar, varchar) answering true: a filter of title != alpha still keeps alpha out', async () => {
    await reading(['ne'], async (adapter) => {
      const reads = await adapter.scopeReads(tenantA);
      assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: DOC, filter: where('title', '!=', 'alpha') })).rows), [2]);
    });
  });

  test('public.~~*(varchar, text) answering true: contains still matches what it contains', async () => {
    await reading(['like'], async (adapter) => {
      const reads = await adapter.scopeReads(tenantA);
      assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: DOC, filter: where('title', 'contains', 'ALP') })).rows), [1]);
    });
  });

  test('public.=(int4, int4) ahead of pg_catalog on the path: a table the policy does not name still reads no rows', async () => {
    await reading(
      ['int', 'eq'],
      async (adapter) => {
        const reads = await adapter.scopeReads({ ...tenantA, [`${SCHEMA}.hidden`]: false });
        assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: `${SCHEMA}.hidden` })).rows), []);
        assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: DOC })).rows), [1, 2]);
        // An empty IN is the same nothing.
        assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table: DOC, filter: where('title', 'in', []) })).rows), []);
      },
      'public,pg_catalog',
    );
  });

  test("a citext column keeps its own operator: email = 'ana@example.com' still finds Ana", async (t) => {
    if (!citext) return t.skip('citext is not installed on this server');
    await reading([], async (adapter) => {
      const reads = await adapter.scopeReads({ [`${SCHEMA}.member`]: true });
      const table = `${SCHEMA}.member`;
      assert.deepEqual(ids((await reads.query({ limit: 50, offset: 0, table, filter: where('email', '=', 'ana@example.com') })).rows), [1]);
      assert.deepEqual(
        ids((await reads.query({ limit: 50, offset: 0, table, filter: where('email', 'in', ['BO@EXAMPLE.COM']) })).rows),
        [2],
      );
    });
  });
});
