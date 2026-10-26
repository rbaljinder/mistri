/*
 * A database with no schema epoch store (postgresSchemaEpoch.ts) used to ask
 * the catalog again for every write transaction: an insert cost five
 * statements where the epoch store makes it three. The answers are now kept
 * for a short window, and a write that fails on a column or table that is
 * gone forgets them at once. Needs TABLEWALK_TEST_PG.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { epochlessEpoch } from '../packages/engine/src/adapters/postgresSchemaEpoch.js';
import { statementsOf } from './support/statements.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

test(
  'without the epoch store a warm write transaction asks the catalog nothing, and a dropped column is noticed',
  { skip: !process.env.TABLEWALK_TEST_PG, timeout: 60_000 },
  async () => {
    const database = await uuidPostgresDatabase('epochless_writes');
    const control = await pgClient(database.url);
    const adapter = new PostgresAdapter(database.url);
    try {
      await control.query('CREATE TABLE note (id serial PRIMARY KEY, body text NOT NULL, extra text)');
      await adapter.introspect();
      const insert = () => adapter.transaction((tx) => tx.insert({ table: 'public.note', values: { body: 'a' } }));
      const update = () => adapter.transaction((tx) => tx.update({ table: 'public.note', key: { id: 1 }, values: { body: 'b' } }));
      await insert(); // the first one learns there is no store, and what the catalog says
      await update();
      /* The window is a clock's five-second bucket: a write that crosses into the next one rightly asks again, so a
         measurement that straddled the turn is warmed and taken afresh. */
      const warm = async (write: () => Promise<unknown>) => {
        for (;;) {
          const bucket = epochlessEpoch();
          await write();
          const measured = await statementsOf(write);
          if (epochlessEpoch() === bucket) return measured;
        }
      };
      const warmInsert = await warm(insert);
      assert.deepEqual(warmInsert.catalog, [], warmInsert.statements.join('\n'));
      assert.equal(warmInsert.total, 3, warmInsert.statements.join('\n')); // BEGIN, INSERT, COMMIT
      const warmUpdate = await warm(update);
      assert.deepEqual(warmUpdate.catalog, [], warmUpdate.statements.join('\n'));
      assert.equal(warmUpdate.total, 3, warmUpdate.statements.join('\n'));

      // A column dropped elsewhere: the next write says so, and the one after it sees the table as it is.
      await control.query('ALTER TABLE note DROP COLUMN extra');
      const withExtra = () => adapter.transaction((tx) => tx.insert({ table: 'public.note', values: { body: 'c', extra: 'x' } }));
      await assert.rejects(withExtra());
      await assert.rejects(withExtra(), /no column called "extra"/);
    } finally {
      await adapter.close();
      await control.end();
      await database.drop();
    }
  },
);
