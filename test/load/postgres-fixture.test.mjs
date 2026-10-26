import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedPostgresFixture } from './postgres-fixture.mjs';

test('pre-aborted fixture refuses before Docker, database or filesystem work', async () => {
  const controller = new AbortController();
  controller.abort(new Error('stopped'));
  await assert.rejects(seedPostgresFixture('/must-not-be-created', 100, controller.signal), /stopped/);
});

test(
  'owned PG Thread fixture preserves every canonical row and drops only its captured database',
  { skip: process.env.TABLEWALK_TEST_PG_LOAD !== '1', timeout: 60000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-pg-load-fixture-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fixture = await seedPostgresFixture(directory, 100);
    try {
      assert.equal(fixture.evidence.dialect, 'postgres');
      assert.equal(fixture.evidence.dataset.issue.rows, 100);
      assert.equal(Object.keys(fixture.evidence.dataset).length, 8);
      assert.equal(fixture.evidence.dataset.attachment.rows, 3);
      assert.equal(fixture.evidence.analyzed.length, 8);
      assert.match(fixture.evidence.database, /^tw_load_[a-f0-9]{32}$/);
      assert.ok(fixture.evidence.constraints.some((row) => row.definition.includes('FOREIGN KEY')));
      assert.ok(fixture.evidence.indexes.length >= 8);
    } finally {
      await fixture.cleanup();
    }
    await fixture.cleanup();
    const { default: pg } = await import('pg');
    const control = new pg.Client({
      connectionString: 'postgresql://postgres@127.0.0.1:55450/tablewalk',
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    try {
      await control.connect();
      assert.equal(
        (await control.query('SELECT count(*)::integer AS n FROM pg_catalog.pg_database WHERE datname=$1', [fixture.evidence.database]))
          .rows[0].n,
        0,
      );
    } finally {
      await control.end();
    }
  },
);
