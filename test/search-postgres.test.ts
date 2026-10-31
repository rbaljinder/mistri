/**
 * The Postgres tsvector search pack (packs/search-postgres): a provider
 * that holds its index in tables in the database the connection names, on
 * `pg`, and answers the same seam the memory provider and the SQLite pack
 * do — ensureCollection, upsert, remove, search with an optional
 * exact-match scope. A phrase hit is asked beside each word hit, an earlier
 * asked field weighs more than a later one, ties fall to the key, a field
 * added later rebuilds the table (a generated column's expression cannot
 * be altered), each field's vector column carries its own GIN index, and a
 * second provider over the same database reads the same index.
 *
 * The live half is opt-in through `TABLEWALK_TEST_PG` — requiring a server
 * to test a Postgres feature would make the suite something people stop
 * running. CI sets it, and `TABLEWALK_REQUIRE_LIVE=1` there turns a missing
 * server into a failure rather than a silent skip (test/live.ts), so this
 * file cannot pass silently without a server in CI. The live tests run in
 * collections named for this run, and drop them afterwards, so nothing
 * here belongs to anyone else — including another run of this file on the
 * same server.
 *
 *   TABLEWALK_TEST_PG=postgres://postgres:pw@127.0.0.1:5432/tablewalk npm test
 *
 * The connection-config checks need no server: a provider is plugged in
 * without connecting (its pool opens on first use), a bad entry is refused
 * before anything connects, and a bad collection or field name is refused
 * by `ensureCollection` before any query is sent.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresSearch, postgresSearchConnectionOf } from '../packs/search-postgres/src/index.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

describe('the Postgres search pack, without a server', () => {
  test('only a configured connection has an index, and a bad entry is refused', async () => {
    const provider = postgresSearch([{ name: 'pgsearch', url: 'postgres://localhost/mistri' }]);
    assert.ok(provider.index('pgsearch'));
    assert.equal(provider.index('search'), undefined);
    assert.equal(provider.index('memory'), undefined);
    assert.equal(provider.index('pgsearch')!.collectionPrefix, 'mistri');
    assert.throws(
      () =>
        postgresSearch([
          { name: 'pgsearch', url: 'postgres://localhost/mistri' },
          { name: 'pgsearch', url: 'postgres://localhost/other' },
        ]),
      /already configured/,
    );
    assert.throws(() => postgresSearchConnectionOf({ name: 'pgsearch' }, 'connection "pgsearch"'), /has no "url"/);
    assert.throws(
      () =>
        postgresSearchConnectionOf({ name: 'pgsearch', url: 'postgres://localhost/mistri', file: './search.db' }, 'connection "pgsearch"'),
      /does not take/,
    );
    assert.throws(
      () =>
        postgresSearchConnectionOf(
          { name: 'pgsearch', url: 'postgres://localhost/mistri', collectionPrefix: '9bad' },
          'connection "pgsearch"',
        ),
      /collectionPrefix/,
    );
    await provider.close();
  });

  test('a name that is not word characters is refused, never quoted into SQL', async () => {
    const provider = postgresSearch([{ name: 'pgsearch', url: 'postgres://localhost/mistri' }]);
    const index = provider.index('pgsearch')!;
    await assert.rejects(() => index.ensureCollection('bad-name; DROP TABLE x', ['name']), /not a name/);
    await assert.rejects(() => index.ensureCollection('ok', ['na me']), /not a name/);
    assert.deepEqual(await index.search('bad-name; DROP TABLE x', 'stone', ['name'], 10), []);
    await provider.close();
  });

  test('a field that would collide with a vector column is refused', async () => {
    const provider = postgresSearch([{ name: 'pgsearch', url: 'postgres://localhost/mistri' }]);
    const index = provider.index('pgsearch')!;
    await assert.rejects(() => index.ensureCollection('ok', ['name', 'name__tsv']), /collides/);
    await provider.close();
  });
});

describe('the Postgres search pack, against a real server', { skip: liveSkip('postgres', LIVE) }, () => {
  /* One prefix per run, inside the 32-character collectionPrefix limit, so
     two runs on one server never share a collection. */
  const prefix = `pg${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const collection = `${prefix}_test_app_task`;
  const other = `${prefix}_test_app_other`;
  let provider = postgresSearch([]);

  before(() => {
    provider = postgresSearch([{ name: 'pgsearch', url: LIVE!, collectionPrefix: prefix }]);
  });

  after(async () => {
    /* The tables this run created, by name — a collection the run never
       ensured holds nothing to drop. */
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      Client: new (options: unknown) => { connect(): Promise<void>; end(): Promise<void>; query(sql: string): Promise<unknown> };
    };
    const admin = new pg.Client({ connectionString: LIVE });
    try {
      await admin.connect();
      await admin.query(`DROP TABLE IF EXISTS "${collection}"`);
      await admin.query(`DROP TABLE IF EXISTS "${other}"`);
    } finally {
      await admin.end();
      await provider.close();
    }
  });

  test('phrase and word hits, asked-field scope, remove, limit, and a collection never indexed', async () => {
    const index = provider.index('pgsearch')!;
    assert.equal(index.collectionPrefix, prefix);
    await index.ensureCollection(collection, ['name', 'note']);
    await index.upsert(collection, { id: '1', name: 'Stone countertop', note: 'Kitchen remodel' });
    await index.upsert(collection, { id: '2', name: 'Stone path', note: 'Garden' });
    await index.upsert(collection, { id: '3', name: 'Wooden deck', note: 'Stone steps' });
    const hits = await index.search(collection, 'stone', ['name', 'note'], 10);
    assert.deepEqual([...hits].sort(), ['1', '2', '3']);
    // The same query answers in the same order twice.
    assert.deepEqual(await index.search(collection, 'stone', ['name', 'note'], 10), hits);
    assert.deepEqual(await index.search(collection, 'countertop', ['name', 'note'], 10), ['1']);
    assert.deepEqual(await index.search(collection, 'steps', ['name', 'note'], 10), ['3']);
    // A hit in a field the search did not ask cannot lift a record: only
    // the record holding 'stone' in its note answers a note-only search.
    assert.deepEqual(await index.search(collection, 'stone', ['note'], 10), ['3']);
    assert.deepEqual((await index.search(collection, 'stone', ['name'], 10)).sort(), ['1', '2']);
    // The phrase is asked beside each word, not instead of them: the
    // record holding the phrase leads, and the word-only records still answer.
    const phrased = await index.search(collection, 'stone countertop', ['name', 'note'], 10);
    assert.equal(phrased[0], '1');
    assert.deepEqual([...phrased].sort(), ['1', '2', '3']);
    assert.deepEqual(await index.search(collection, 'stone', ['name', 'note'], 10, { field: 'note', value: 'Garden' }), ['2']);
    assert.deepEqual(await index.search(collection, 'stone', ['name', 'note'], 10, { field: 'mistri_tenant', value: 'nope' }), []);
    assert.equal((await index.search(collection, 'stone', ['name', 'note'], 2)).length, 2);
    await index.remove(collection, '2');
    assert.deepEqual((await index.search(collection, 'stone', ['name', 'note'], 10)).sort(), ['1', '3']);
    assert.deepEqual(await index.search(collection, 'nope', ['name', 'note'], 10), []);
    assert.deepEqual(await index.search(collection, '', ['name'], 10), []);
    assert.deepEqual(await index.search('never-indexed', 'stone', ['name'], 10), []);
    await index.remove('never-indexed', '9');
  });

  test('a field added later rebuilds the table and keeps the rows already indexed', async () => {
    const index = provider.index('pgsearch')!;
    await index.ensureCollection(other, ['name']);
    await index.upsert(other, { id: '1', name: 'Stone countertop' });
    await index.ensureCollection(other, ['name', 'note']);
    await index.upsert(other, { id: '2', name: 'Wooden deck', note: 'Stone steps' });
    assert.deepEqual((await index.search(other, 'stone', ['name', 'note'], 10)).sort(), ['1', '2']);
    assert.deepEqual(await index.search(other, 'countertop', ['name', 'note'], 10), ['1']);
    await index.remove(other, '1');
    await index.remove(other, '2');
  });

  test('an earlier asked field weighs more than a later one when the word is equally rare in both', async () => {
    const index = provider.index('pgsearch')!;
    await index.ensureCollection(other, ['name', 'note']);
    for (let i = 0; i < 20; i++) await index.upsert(other, { id: `f${i}`, name: 'common common', note: 'common common' });
    await index.upsert(other, { id: '1', name: 'quarry common', note: 'common common' });
    await index.upsert(other, { id: '2', name: 'common common', note: 'quarry common' });
    assert.deepEqual(await index.search(other, 'quarry', ['name', 'note'], 10), ['1', '2']);
    for (let i = 0; i < 20; i++) await index.remove(other, `f${i}`);
    await index.remove(other, '1');
    await index.remove(other, '2');
  });

  test('a tenant scope is an exact match on the tenant column', async () => {
    const index = provider.index('pgsearch')!;
    await index.ensureCollection(other, ['name']);
    await index.upsert(other, { id: '1', name: 'Stone countertop', mistri_tenant: 'tenant-a' });
    await index.upsert(other, { id: '2', name: 'Stone path', mistri_tenant: 'tenant-b' });
    assert.deepEqual(await index.search(other, 'stone', ['name'], 10, { field: 'mistri_tenant', value: 'tenant-a' }), ['1']);
    assert.deepEqual(await index.search(other, 'stone', ['name'], 10, { field: 'mistri_tenant', value: 'tenant-b' }), ['2']);
    await index.remove(other, '1');
    await index.remove(other, '2');
  });

  test('every field carries its own GIN index, and a second provider reads the same index', async () => {
    const index = provider.index('pgsearch')!;
    await index.ensureCollection(collection, ['name', 'note']);
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      Client: new (options: unknown) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(sql: string, values: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
      };
    };
    const admin = new pg.Client({ connectionString: LIVE });
    try {
      await admin.connect();
      const { rows } = await admin.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexdef ILIKE '%gin%'`,
        [collection],
      );
      assert.equal(rows.length >= 2, true, `expected a GIN index per field, found ${rows.length}`);
      assert.ok(
        rows.some((row) => String(row.indexdef).includes('name__tsv')),
        `no GIN index on the name vector: ${rows.map((row) => row.indexdef).join('; ')}`,
      );
      assert.ok(
        rows.some((row) => String(row.indexdef).includes('note__tsv')),
        `no GIN index on the note vector: ${rows.map((row) => row.indexdef).join('; ')}`,
      );
    } finally {
      await admin.end();
    }
    await index.upsert(collection, { id: 'g1', name: 'Stone arch', note: 'Garden' });
    await index.upsert(collection, { id: 'g2', name: 'Stone bridge', note: 'River' });
    const second = postgresSearch([{ name: 'pgsearch', url: LIVE!, collectionPrefix: prefix }]);
    try {
      const readBack = await second.index('pgsearch')!.search(collection, 'stone', ['name', 'note'], 10);
      assert.ok(
        readBack.includes('g1') && readBack.includes('g2'),
        `a second provider over the same database reads the same index: ${readBack.join(', ')}`,
      );
    } finally {
      await second.close();
      await index.remove(collection, 'g1');
      await index.remove(collection, 'g2');
    }
  });
});
