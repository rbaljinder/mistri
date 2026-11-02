/**
 * The database browser's tools over a real Postgres: the value sweep (`find`), the row graphs (`insert_graph`,
 * `delete_graph`) and `change_impact`, each written and proven on SQLite first. The adapter they stand on is
 * test/postgres.test.ts's, over the same fixture (test/support/postgresFixture.ts) in a schema of this file's own.
 *
 * Opt-in through `TABLEWALK_TEST_PG`, as that file is.
 */
import { randomUUID } from 'node:crypto';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';
import { buildFixture, dropFixture } from './support/postgresFixture.js';
import { findValue } from '../packages/tablewalk/src/server/mcp.js';
import { deleteGraph, insertGraph } from '../packages/tablewalk/src/server/graph.js';
import { changeImpact } from '../packages/tablewalk/src/server/changeimpact.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const FIXTURE = `tablewalk_pg_browser_${randomUUID().replaceAll('-', '')}`;

describe("the database browser's tools, against a real Postgres", { skip: liveSkip('postgres', LIVE) }, () => {
  let adapter: PostgresAdapter;
  let schema: DatabaseSchema;
  const at = (name: string) => `${FIXTURE}.${name}`;

  before(async () => {
    await buildFixture(LIVE!, FIXTURE);
    adapter = new PostgresAdapter(LIVE!, 'pg-fixture', [FIXTURE]);
    schema = await adapter.introspect();
  });

  after(async () => {
    await adapter?.close().catch(() => {});
    await dropFixture(LIVE!, FIXTURE);
  });

  describe('finding a value', () => {
    test('a value sweep survives the default shape of a Postgres schema', async () => {
      /* The reported failure: `account` has a uuid key and a text[] column,
         both of which read as text to a naive type check and neither of
         which Postgres will LIKE. The thrown statement took the whole table
         with it — its genuine `name` column included — while the answer
         claimed to have searched it. A confident wrong "not found". */
      const found = await findValue(adapter, schema, 'pg-fixture', 'Nakamura');
      const matches = found.matches as Array<{ table: string; columns: string[] }>;
      const account = matches.find((m) => m.table === at('account'));
      assert.ok(account, 'the row was found in the uuid-keyed table');
      assert.deepEqual(account!.columns, ['name']);
      assert.equal(found.failed, undefined, 'and nothing was quietly unreadable');
    });

    test('a whole uuid is matched by equality, since it cannot be matched by LIKE', async () => {
      const found = await findValue(adapter, schema, 'pg-fixture', '3F8C1E42-9B21-4C7A-8F0E-2D5A6B7C8D90');
      const matches = found.matches as Array<{ table: string; columns: string[]; key?: Record<string, unknown> }>;
      /* Dropping uuid columns from the sweep would be the safe fix and would
         miss the commonest primary key there now is — the id someone pasted
         out of a log is exactly what they are searching for. */
      assert.deepEqual(
        matches.map((m) => m.columns),
        [['id']],
      );
      assert.equal(matches[0].key?.id, '3f8c1e42-9b21-4c7a-8f0e-2d5a6b7c8d90');
    });

    test('a partial uuid is not guessed at', async () => {
      const found = await findValue(adapter, schema, 'pg-fixture', '3f8c1e42');
      assert.deepEqual(found.matches, []);
      assert.equal(found.failed, undefined, 'refused, not failed');
    });
  });

  describe('row graphs', () => {
    test('a graph of rows lands as one thing, or not at all', async () => {
      /* The adapter's half of the fixture story. `insertGraph` is engine-
         agnostic; what is Postgres's here is the transaction underneath it,
         which is the only part that can actually fail to be atomic. */
      const made = await insertGraph(adapter, schema, [
        { table: at('country'), as: 'zz', values: { code: 'ZZ', name: 'Zedland' } },
        { table: at('customer'), as: 'c', values: { id: 800, name: 'Graph Ltd', country_code: { ref: 'zz', column: 'code' } } },
        /* A bare name, resolved the way every other write tool resolves one —
           and resolved to *this* schema, not to `public`. */
        { table: 'note', as: 'n', values: { body: 'about the graph' } },
      ]);
      assert.equal(made.rowsWritten, 3);
      assert.equal(made.inserted[1].row?.country_code, 'ZZ');
      // A key the database assigned, referable because the row came back.
      assert.ok(Number(made.inserted[2].key.id) > 0);
      assert.deepEqual(
        made.teardown.map((r) => r.table),
        [at('note'), at('customer'), at('country')],
      );

      // And the whole thing goes away again, in one call, children first.
      const gone = await deleteGraph(adapter, schema, made.teardown);
      assert.equal(gone.rowsDeleted, 3);
      assert.equal(await adapter.count(at('country')), 3);
    });

    test('a graph that fails part way leaves nothing behind', async () => {
      const before = await adapter.count(at('country'));
      await assert.rejects(
        () =>
          insertGraph(adapter, schema, [
            { table: at('country'), values: { code: 'YY', name: 'Wyeland' } },
            { table: at('customer'), values: { id: 801, name: 'Doomed Ltd', country_code: 'YY' } },
            // A reference to a country that does not exist: the engine refuses.
            { table: at('customer'), values: { id: 802, name: 'Also Doomed', country_code: 'XX' } },
          ]),
        /Row 3 \(.*customer\)[\s\S]*Nothing was written/,
      );
      assert.equal(await adapter.count(at('country')), before, 'the first row went back too');
      assert.equal(await adapter.count(at('customer'), { groups: [[{ column: 'id', op: '=', value: 801 }]] }), 0);
    });
  });

  /* ---------- asked before the change, and undone after it ---------- */

  describe('change_impact, against a real Postgres', () => {
    /* Written and proven on SQLite, where a synchronous driver hands back a
       whole catalog and `PRAGMA index_list` answers what is indexed. Postgres
       answers all of that differently — `pg_index`, schema-qualified names,
       delete rules read from `information_schema` — so "it works" was a claim
       about one engine and this is the other. */

    test('names what points at a table, with the rule and the numbers', async () => {
      /* `customer.country_code` references `country` ON DELETE SET NULL, which
         is the interesting direction: the rule is read from
         `information_schema` on Postgres and from a pragma on SQLite, and a
         count without its rule is not an answer. */
      const impact = await changeImpact(adapter, schema, at('country'), 'code');
      assert.equal(impact.table, at('country'));
      assert.equal(impact.rows, 3);

      const customers = impact.referencedBy.find((d) => d.table === at('customer'));
      assert.ok(customers, 'customer points at country');
      /* Schema-qualified on Postgres, which a SQLite test cannot exercise: a
         bare `customer` would have matched nothing. */
      assert.ok(customers.table.startsWith(`${FIXTURE}.`), customers.table);
      assert.deepEqual(customers.columns, ['country_code']);
      assert.equal(customers.onDelete, 'set null');
      assert.equal(customers.rows, 5);
      assert.ok(
        impact.notes.some((n) => /is set null on delete: 5 rows in .*customer would survive with a hole/.test(n)),
        impact.notes.join('\n'),
      );
    });

    test('counts the nulls that decide whether NOT NULL can land', async () => {
      /* `customer.country_code` has one null — Dormant Ltd. The whole point of
         the tool is that this number is right, because it is the one that
         makes a migration fail at the worst moment. */
      const impact = await changeImpact(adapter, schema, at('customer'), 'country_code');
      assert.equal(impact.columnFacts?.nullable, true);
      assert.equal(impact.columnFacts?.nulls, 1);
      assert.ok(
        impact.notes.some((n) => /1 of 5 rows hold null, so NOT NULL would be refused/.test(n)),
        impact.notes.join('\n'),
      );
    });

    test('and says nothing about an index it could not read', async () => {
      /* `indexed` is absent when the adapter does not report indexes, and the
         rule is that absence never becomes a claim. Postgres does report
         them, so this asserts the shape rather than the value: whatever it
         says, it must not say "no index" when it does not know. */
      const impact = await changeImpact(adapter, schema, at('customer'), 'id');
      for (const dep of impact.referencedBy) {
        assert.ok(dep.indexed === undefined || typeof dep.indexed === 'boolean');
        if (dep.indexed === undefined) {
          assert.ok(!impact.notes.some((n) => n.includes(`No index leads on ${dep.table}`)));
        }
      }
    });
  });
});
