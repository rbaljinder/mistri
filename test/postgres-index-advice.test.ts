/**
 * The trigram half of the index advice, against a live PostgreSQL: the
 * catalog says which columns a pg_trgm index covers (at any position, GIN
 * or GiST), a B-tree over the same column is not one, and `mistri check`'s
 * advice names the `contains` search that has none.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { appIndexWarnings, LARGE_TABLE_ROWS } from '../packages/mistri/src/shared/appIndexWarnings.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { liveSkip } from './live.js';
import { LIVE_PG, ownedPostgresDatabase } from './support/jobStoreEngines.js';

test(
  'the catalog records trigram-indexed columns and the advice names a contains search without one',
  { skip: liveSkip('postgres', LIVE_PG) },
  async () => {
    const adapter = new PostgresAdapter(await ownedPostgresDatabase(), 'Owned index advice test');
    try {
      const run = (sql: string) => adapter.runSql({ text: sql, write: true, limit: 1 });
      await run('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await run('CREATE TABLE lead (id integer PRIMARY KEY, name text NOT NULL, city text, code text, note text)');
      await run(
        `INSERT INTO lead SELECT n, 'Lead ' || n, 'City ' || (n % 90), 'C' || n, 'note' FROM generate_series(1, ${LARGE_TABLE_ROWS + 5000}) n`,
      );
      await run('CREATE INDEX lead_city ON lead (city)');
      await run('CREATE INDEX lead_name_trgm ON lead USING gin (name gin_trgm_ops)');
      await run('CREATE INDEX lead_code_note_trgm ON lead USING gist (code gist_trgm_ops, note gist_trgm_ops)');
      await run('ANALYZE lead');
      const schema = await adapter.introspect();
      const lead = schema.tables.find((table) => table.name === 'lead')!;
      assert.deepEqual([...lead.trigram!].sort(), ['code', 'name', 'note']);
      assert.ok(lead.indexed!.includes('city'), 'a B-tree still leads its column');
      const app = { name: 'Leads', nav: [], views: { leads: { table: lead.id, filters: ['city', 'note'] } } } as unknown as AppDef;
      const advice = appIndexWarnings(app, [], schema);
      assert.equal(advice.length, 1, advice.join('\n'));
      assert.match(advice[0], /lead\.city.*gin_trgm_ops/);
    } finally {
      await adapter.close();
    }
  },
);
