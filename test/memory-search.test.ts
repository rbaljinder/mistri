/**
 * The built-in memory search provider (packages/mistri/src/server/app/memorySearch.ts): an App that names the
 * connection `memory` searches without a pack plugged in, and every other connection still needs one. The
 * provider holds only what it is given — upsert, remove, search — and ranks a whole-phrase hit above a word
 * hit, an earlier declared field above a later one, and ties by key, so two runs over the same index answer
 * in the same order.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_SEARCH_CONNECTION, memorySearchProvider } from '../packages/mistri/src/server/app/memorySearch.js';

describe('the memory search provider', () => {
  test('only the memory connection has an index', () => {
    assert.ok(memorySearchProvider.index(MEMORY_SEARCH_CONNECTION));
    assert.equal(memorySearchProvider.index('typesense'), undefined);
    assert.equal(memorySearchProvider.index('search'), undefined);
  });

  test('phrase hits rank by field order, scope keeps only its document, remove drops it, limit caps the page', async () => {
    const index = memorySearchProvider.index(MEMORY_SEARCH_CONNECTION)!;
    await index.ensureCollection('memory-test_app_task', ['name', 'note']);
    await index.upsert('memory-test_app_task', { id: '1', name: 'Stone countertop', note: 'Kitchen remodel' });
    await index.upsert('memory-test_app_task', { id: '2', name: 'Stone path', note: 'Garden' });
    await index.upsert('memory-test_app_task', { id: '3', name: 'Wooden deck', note: 'Stone steps' });
    assert.deepEqual(await index.search('memory-test_app_task', 'stone', ['name', 'note'], 10), ['1', '2', '3']);
    assert.deepEqual(await index.search('memory-test_app_task', 'stone', ['name', 'note'], 10, { field: 'note', value: 'Garden' }), ['2']);
    assert.deepEqual(await index.search('memory-test_app_task', 'stone', ['name', 'note'], 2), ['1', '2']);
    await index.remove('memory-test_app_task', '2');
    assert.deepEqual(await index.search('memory-test_app_task', 'stone', ['name', 'note'], 10), ['1', '3']);
    assert.deepEqual(await index.search('memory-test_app_task', 'nope', ['name', 'note'], 10), []);
    assert.deepEqual(await index.search('memory-test_app_task', 'stone', ['name', 'note'], 10), ['1', '3']);
    assert.deepEqual(await index.search('never-indexed', 'stone', ['name'], 10), []);
  });
});
