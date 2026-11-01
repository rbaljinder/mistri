/**
 * A read-only Postgres connection stays read-only against statements written to
 * stack a write behind a COMMIT, in a database this file owns.
 *
 * `BEGIN READ ONLY` holds for one statement, not for several: `COMMIT; BEGIN
 * READ WRITE; DELETE …` ends it and opens a writable one. Two payloads got
 * past the stacking check by making it misread a string or a name, and
 * node-postgres sent them on the simple protocol, which runs every statement —
 * through runSql (the /api/sql path) and through the EXPLAIN the reserved-table
 * check and explainSql send. The house rule: assert the refusal, then count
 * the rows to show nothing ran anyway.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const PAYLOADS = [
  'select 1 as x$$; commit; begin read write; delete from t where id = 1; commit; select 1 as y$$',
  "select E'\\''; commit; set transaction read write; delete from t where id = 11; -- '",
];

test(
  'stacked writes do not reach a read-only Postgres connection',
  { skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG), timeout: 60_000 },
  async (t) => {
    const owned = await uuidPostgresDatabase('tw_sql_readonly');
    const setup = await pgClient(owned.url);
    const adapters: PostgresAdapter[] = [];
    t.after(async () => {
      for (const adapter of adapters) await adapter.close().catch(() => {});
      await setup.end().catch(() => {});
      await owned.drop();
    });
    await setup.query('CREATE TABLE t (id integer PRIMARY KEY); INSERT INTO t SELECT generate_series(1, 30)');
    const rows = async () => Number((await setup.query('SELECT count(*)::int AS n FROM t')).rows[0].n);

    const attempt = async (adapter: PostgresAdapter, text: string) => {
      const ways = {
        runSql: () => adapter.runSql({ text, limit: 5 }),
        'runSql, refuseReserved': () => adapter.runSql({ text, limit: 5, refuseReserved: true }),
        explainSql: () => adapter.explainSql({ text }),
        'explainSql, refuseReserved': () => adapter.explainSql({ text, refuseReserved: true }),
      };
      for (const [way, run] of Object.entries(ways)) {
        await assert.rejects(run, Error, `${way}: ${text}`);
        assert.equal(await rows(), 30, `${way} deleted nothing: ${text}`);
      }
    };

    const adapter = new PostgresAdapter(owned.url, 'sql-readonly');
    adapters.push(adapter);
    for (const text of PAYLOADS) await attempt(adapter, text);

    /* The stacking check is the earlier, clearer refusal; the extended protocol
       is the guard. With standard_conforming_strings off, `'\''` is a whole
       string to Postgres and an unclosed one to the check, so only the
       protocol stands between this text and the DELETE. */
    await setup.query(`ALTER DATABASE "${new URL(owned.url).pathname.slice(1)}" SET standard_conforming_strings = off`);
    const lax = new PostgresAdapter(owned.url, 'sql-readonly-lax');
    adapters.push(lax);
    await attempt(lax, "select '\\''; commit; set transaction read write; delete from t where id = 21; -- '");
  },
);
