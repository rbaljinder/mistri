/**
 * The SQLite FTS5 search pack (packs/search-sqlite): a provider that holds
 * its index in a file, on Node's built-in `node:sqlite`, and answers the
 * same seam the memory provider and the Typesense pack do — ensureCollection,
 * upsert, remove, search with an optional exact-match scope. A phrase hit is
 * asked beside each word hit, an earlier declared field weighs more than a
 * later one, ties fall to the key, a field added later rebuilds the table
 * (FTS5 tables cannot be altered), and a file reopened after a close still
 * holds its documents.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteSearch, sqliteSearchConnectionOf } from '../packs/search-sqlite/src/index.js';

describe('the SQLite search pack', () => {
  test('only a configured connection has an index, and a bad entry is refused', () => {
    const provider = sqliteSearch([{ name: 'fts', file: ':memory:' }]);
    assert.ok(provider.index('fts'));
    assert.equal(provider.index('search'), undefined);
    assert.equal(provider.index('memory'), undefined);
    assert.throws(
      () =>
        sqliteSearch([
          { name: 'fts', file: ':memory:' },
          { name: 'fts', file: ':memory:' },
        ]),
      /already configured/,
    );
    assert.throws(() => sqliteSearchConnectionOf({ name: 'fts' }, 'connection "fts"'), /has no "file"/);
    assert.throws(
      () => sqliteSearchConnectionOf({ name: 'fts', file: './search.db', url: 'https://x' }, 'connection "fts"'),
      /does not take/,
    );
    assert.throws(
      () => sqliteSearchConnectionOf({ name: 'fts', file: './search.db', collectionPrefix: '9bad' }, 'connection "fts"'),
      /collectionPrefix/,
    );
    provider.close();
  });

  test('phrase and word hits, field order, scope, remove, limit, and a collection never indexed', async () => {
    const provider = sqliteSearch([{ name: 'fts', file: ':memory:' }]);
    const index = provider.index('fts')!;
    assert.equal(index.collectionPrefix, 'mistri');
    await index.ensureCollection('mistri_test_app_task', ['name', 'note']);
    await index.upsert('mistri_test_app_task', { id: '1', name: 'Stone countertop', note: 'Kitchen remodel' });
    await index.upsert('mistri_test_app_task', { id: '2', name: 'Stone path', note: 'Garden' });
    await index.upsert('mistri_test_app_task', { id: '3', name: 'Wooden deck', note: 'Stone steps' });
    const hits = await index.search('mistri_test_app_task', 'stone', ['name', 'note'], 10);
    assert.deepEqual([...hits].sort(), ['1', '2', '3']);
    // bm25, not the memory provider's strict field order: the same query
    // answers in the same order twice, and a word held by one record only
    // finds that record whichever field holds it.
    assert.deepEqual(await index.search('mistri_test_app_task', 'stone', ['name', 'note'], 10), hits);
    assert.deepEqual(await index.search('mistri_test_app_task', 'countertop', ['name', 'note'], 10), ['1']);
    assert.deepEqual(await index.search('mistri_test_app_task', 'steps', ['name', 'note'], 10), ['3']);
    assert.deepEqual(await index.search('mistri_test_app_task', 'stone countertop', ['name', 'note'], 10), ['1', '3', '2']);
    // The phrase is asked beside each word, not instead of them: the record
    // holding the phrase leads, and the word-only records still answer.
    assert.deepEqual(await index.search('mistri_test_app_task', 'stone', ['name', 'note'], 10, { field: 'note', value: 'Garden' }), ['2']);
    assert.deepEqual(
      await index.search('mistri_test_app_task', 'stone', ['name', 'note'], 10, { field: 'mistri_tenant', value: 'nope' }),
      [],
    );
    assert.equal((await index.search('mistri_test_app_task', 'stone', ['name', 'note'], 2)).length, 2);
    await index.remove('mistri_test_app_task', '2');
    assert.deepEqual((await index.search('mistri_test_app_task', 'stone', ['name', 'note'], 10)).sort(), ['1', '3']);
    assert.deepEqual(await index.search('mistri_test_app_task', 'nope', ['name', 'note'], 10), []);
    assert.deepEqual(await index.search('mistri_test_app_task', '', ['name'], 10), []);
    assert.deepEqual(await index.search('never-indexed', 'stone', ['name'], 10), []);
    await index.remove('never-indexed', '9');
    provider.close();
  });

  test('a field added later rebuilds the table and keeps the rows already indexed', async () => {
    const provider = sqliteSearch([{ name: 'fts', file: ':memory:' }]);
    const index = provider.index('fts')!;
    await index.ensureCollection('mistri_test_app_task', ['name']);
    await index.upsert('mistri_test_app_task', { id: '1', name: 'Stone countertop' });
    await index.ensureCollection('mistri_test_app_task', ['name', 'note']);
    await index.upsert('mistri_test_app_task', { id: '2', name: 'Wooden deck', note: 'Stone steps' });
    assert.deepEqual((await index.search('mistri_test_app_task', 'stone', ['name', 'note'], 10)).sort(), ['1', '2']);
    assert.deepEqual(await index.search('mistri_test_app_task', 'countertop', ['name', 'note'], 10), ['1']);
    provider.close();
  });

  test('an earlier declared field weighs more than a later one when the word is equally rare in both', async () => {
    const provider = sqliteSearch([{ name: 'fts', file: ':memory:' }]);
    const index = provider.index('fts')!;
    await index.ensureCollection('mistri_test_app_task', ['name', 'note']);
    for (let i = 0; i < 20; i++) await index.upsert('mistri_test_app_task', { id: `f${i}`, name: 'common common', note: 'common common' });
    await index.upsert('mistri_test_app_task', { id: '1', name: 'quarry common', note: 'common common' });
    await index.upsert('mistri_test_app_task', { id: '2', name: 'common common', note: 'quarry common' });
    assert.deepEqual(await index.search('mistri_test_app_task', 'quarry', ['name', 'note'], 10), ['1', '2']);
    provider.close();
  });

  test('a tenant scope is an exact match on the tenant column', async () => {
    const provider = sqliteSearch([{ name: 'fts', file: ':memory:' }]);
    const index = provider.index('fts')!;
    await index.ensureCollection('mistri_test_app_task', ['name']);
    await index.upsert('mistri_test_app_task', { id: '1', name: 'Stone countertop', mistri_tenant: 'tenant-a' });
    await index.upsert('mistri_test_app_task', { id: '2', name: 'Stone path', mistri_tenant: 'tenant-b' });
    assert.deepEqual(await index.search('mistri_test_app_task', 'stone', ['name'], 10, { field: 'mistri_tenant', value: 'tenant-a' }), [
      '1',
    ]);
    assert.deepEqual(await index.search('mistri_test_app_task', 'stone', ['name'], 10, { field: 'mistri_tenant', value: 'tenant-b' }), [
      '2',
    ]);
    provider.close();
  });

  test('a file survives a close and reopen, and a second provider over it reads the same index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-search-sqlite-'));
    try {
      const file = join(dir, 'search.db');
      const first = sqliteSearch([{ name: 'fts', file, collectionPrefix: 'acme' }]);
      const index = first.index('fts')!;
      assert.equal(index.collectionPrefix, 'acme');
      await index.ensureCollection('acme_test_app_task', ['name']);
      await index.upsert('acme_test_app_task', { id: '7', name: 'Stone countertop' });
      first.close();
      const second = sqliteSearch([{ name: 'fts', file, collectionPrefix: 'acme' }]);
      assert.deepEqual(await second.index('fts')!.search('acme_test_app_task', 'stone', ['name'], 10), ['7']);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a name that is not word characters is refused, never quoted into SQL', async () => {
    const provider = sqliteSearch([{ name: 'fts', file: ':memory:' }]);
    const index = provider.index('fts')!;
    await assert.rejects(() => index.ensureCollection('bad-name; DROP TABLE x', ['name']), /not a name/);
    await assert.rejects(() => index.ensureCollection('ok', ['na me']), /not a name/);
    assert.deepEqual(await index.search('bad-name; DROP TABLE x', 'stone', ['name'], 10), []);
    provider.close();
  });
});
