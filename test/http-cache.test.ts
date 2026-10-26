import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { HttpAdapter } from '../packages/engine/src/adapters/http/httpAdapter.js';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { MemoryCacheStore } from '../packages/engine/src/adapters/cache/cacheStore.js';
import { openHttp } from '../packages/engine/src/server/httpConnection.js';
import { BIG_ID, startFakeRest } from './support/fakeRest.js';

/* An HTTP connection that opts into the cache (`"cache": { "ttl": 60 }`)
   asks the API once per distinct read while its copy is fresh. Each test
   counts what reached the API, which the fake keeps. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const description = draftDescription(readOpenApi(spec));
const policy = { ...DEFAULT_POLICY, insecure: true };
let api: Awaited<ReturnType<typeof startFakeRest>>;
before(async () => {
  api = await startFakeRest();
});
after(() => api.close());

const adapterWith = (cache?: { store: MemoryCacheStore; ttlMs: number }) =>
  new HttpAdapter({
    base: new URL(`${api.origin}/v1/`),
    description,
    label: 'Desk',
    auth: { header: 'authorization', value: 'Bearer cache-test' },
    policy,
    ...(cache ? { cache } : {}),
  });

test('a cached connection asks the API once per read while the copy is fresh, and a different read is its own', async () => {
  const store = new MemoryCacheStore();
  const adapter = adapterWith({ store, ttlMs: 60_000 });
  const before = api.seen.length;
  const first = await adapter.query({ table: 'contacts', limit: 5, offset: 0 });
  const second = await adapter.query({ table: 'contacts', limit: 5, offset: 0 });
  assert.deepEqual(second.rows, first.rows);
  assert.equal(api.seen.length - before, 1);
  await adapter.query({ table: 'contacts', limit: 5, offset: 5 });
  assert.equal(api.seen.length - before, 2);
  // Kept under the path and query only: the credential is not part of the key.
  assert.ok([...(store as unknown as { entries: Map<string, unknown> }).entries.keys()].every((key) => !key.includes('cache-test')));
});

test('a number past 2^53 comes back from the cache with every digit', async () => {
  const adapter = adapterWith({ store: new MemoryCacheStore(), ttlMs: 60_000 });
  const read = async () => (await adapter.query({ table: 'tickets', limit: 10, offset: 0 })).rows.map((row) => row.id);
  const fresh = await read();
  const cached = await read();
  assert.ok(fresh.includes(BIG_ID));
  assert.deepEqual(cached, fresh);
});

test('the copy expires with its time to live', async () => {
  let now = 0;
  const store = new MemoryCacheStore(100, () => now);
  const adapter = adapterWith({ store, ttlMs: 1_000 });
  const before = api.seen.length;
  await adapter.query({ table: 'contacts', limit: 3, offset: 0 });
  now = 999;
  await adapter.query({ table: 'contacts', limit: 3, offset: 0 });
  now = 1_000;
  await adapter.query({ table: 'contacts', limit: 3, offset: 0 });
  assert.equal(api.seen.length - before, 2);
});

test("the explorer's operations always ask the API, and a connection that did not opt in is never cached", async () => {
  const cached = adapterWith({ store: new MemoryCacheStore(), ttlMs: 60_000 });
  const before = api.seen.length;
  await cached.operation('contacts', 'list', {});
  await cached.operation('contacts', 'list', {});
  assert.equal(api.seen.length - before, 2);
  const plain = adapterWith();
  await plain.query({ table: 'contacts', limit: 2, offset: 0 });
  await plain.query({ table: 'contacts', limit: 2, offset: 0 });
  assert.equal(api.seen.length - before, 4);
});

test('a URL a browser supplied opens without the cache, as it opens without the credential', async () => {
  const store = new MemoryCacheStore();
  const { adapter } = await openHttp(
    'Desk',
    `${api.origin}/v1/`,
    { description, insecure: true, cache: { ttl: 60 } },
    { secrets: false, cache: store },
  );
  const before = api.seen.length;
  await adapter.query({ table: 'contacts', limit: 2, offset: 0 });
  await adapter.query({ table: 'contacts', limit: 2, offset: 0 });
  assert.equal(api.seen.length - before, 2);
  assert.equal(store.size, 0);
});
