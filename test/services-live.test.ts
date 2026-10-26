import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { ValkeyCacheStore } from '../packages/engine/src/adapters/cache/cacheStore.js';
import { RespClient } from '../packages/engine/src/adapters/cache/resp.js';
import { TypesenseClient } from '../packs/search-typesense/src/index.js';
import { cacheAddress } from '../packages/mistri/src/server/serviceConnections.js';
import { FixedWindowLimiter, SharedWindowLimiter } from '../packages/engine/src/server/http/rateLimit.js';
import { liveSkip } from './live.js';

/* Against real servers, opt in like the database engines:
     TABLEWALK_TEST_VALKEY=valkey://127.0.0.1:6379   (+ TABLEWALK_TEST_VALKEY_PASSWORD)
     TABLEWALK_TEST_TYPESENSE=http://127.0.0.1:8108/ (+ TABLEWALK_TEST_TYPESENSE_KEY)
   TABLEWALK_REQUIRE_LIVE=1 turns a missing server into a failure. */
const valkeyUrl = process.env.TABLEWALK_TEST_VALKEY;
const typesenseUrl = process.env.TABLEWALK_TEST_TYPESENSE;
const run = randomBytes(4).toString('hex');

const valkey = () => {
  const address = cacheAddress(valkeyUrl!, true, 'TABLEWALK_TEST_VALKEY');
  return new ValkeyCacheStore(
    new RespClient({
      ...address,
      policy: { allowPrivate: true, allowLinkLocal: false },
      ...(process.env.TABLEWALK_TEST_VALKEY_PASSWORD ? { password: process.env.TABLEWALK_TEST_VALKEY_PASSWORD } : {}),
    }),
  );
};

test('valkey: values with a time to live, and windows that expire on their own', { skip: liveSkip('valkey', valkeyUrl) }, async () => {
  const store = valkey();
  try {
    await store.set(`tw:test:${run}:k`, 'v', 60_000);
    assert.equal(await store.get(`tw:test:${run}:k`), 'v');
    await store.delete(`tw:test:${run}:k`);
    assert.equal(await store.get(`tw:test:${run}:k`), undefined);
    await store.set(`tw:test:${run}:short`, 'v', 50);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await store.get(`tw:test:${run}:short`), undefined);
    assert.equal((await store.incr(`tw:test:${run}:w`, 200)).count, 1);
    const second = await store.incr(`tw:test:${run}:w`, 200);
    assert.equal(second.count, 2);
    assert.ok(second.ttlMs > 0 && second.ttlMs <= 200);
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal((await store.incr(`tw:test:${run}:w`, 200)).count, 1);
  } finally {
    await store.close();
  }
});

test('valkey: two instances spend one rate-limit budget', { skip: liveSkip('valkey', valkeyUrl) }, async () => {
  const windows = [{ limit: 2, ms: 60_000 }];
  const [one, two] = [valkey(), valkey()];
  try {
    const a = new SharedWindowLimiter(`live-${run}`, windows, one, new FixedWindowLimiter(windows));
    const b = new SharedWindowLimiter(`live-${run}`, windows, two, new FixedWindowLimiter(windows));
    assert.equal((await a.take('192.0.2.7')).ok, true);
    assert.equal((await b.take('192.0.2.7')).ok, true);
    const refused = await a.take('192.0.2.7');
    assert.ok(!refused.ok && refused.scope === 'client');
  } finally {
    await one.close();
    await two.close();
  }
});

test(
  "typesense: a collection, documents by key, a search that forgives a typo, removal, and a tenant's scope",
  { skip: liveSkip('typesense', typesenseUrl) },
  async () => {
    const client = new TypesenseClient({
      base: new URL(typesenseUrl!),
      label: 'live',
      policy: { ...DEFAULT_POLICY, insecure: true },
      ...(process.env.TABLEWALK_TEST_TYPESENSE_KEY ? { apiKey: process.env.TABLEWALK_TEST_TYPESENSE_KEY } : {}),
    });
    const collection = `tablewalk_live_${run}`;
    assert.equal(await client.health(), true);
    await client.ensureCollection(collection, ['name']);
    await client.ensureCollection(collection, ['name', 'company']);
    await client.upsert(collection, { id: '1', name: 'Margot Fontaine', company: 'Stonebridge Marine' });
    await client.upsert(collection, { id: '2', name: 'Ada Stone', company: 'Harbor' });
    await client.upsert(collection, { id: '3', name: 'Wei Iyer', company: 'Greywacke' });
    assert.deepEqual(await client.search(collection, 'stone', ['name'], 10), ['2']);
    // A real engine forgives a typo, which a substring filter never would.
    assert.deepEqual(await client.search(collection, 'fontaime', ['name'], 10), ['1']);
    await client.remove(collection, '2');
    assert.deepEqual(await client.search(collection, 'stone', ['name'], 10), []);
    assert.deepEqual(await client.search(`tablewalk_live_absent_${run}`, 'x', ['name'], 5), []);
    // A tenant's scope is the engine's own exact match: south's match is never answered to north.
    const shared = `tablewalk_live_tenants_${run}`;
    await client.ensureCollection(shared, ['name', 'mistri_tenant']);
    await client.upsert(shared, { id: 'north-1', name: 'Granite slab', mistri_tenant: 'north' });
    await client.upsert(shared, { id: 'south-1', name: 'Granite block', mistri_tenant: 'south' });
    assert.deepEqual(await client.search(shared, 'granite', ['name'], 10, { field: 'mistri_tenant', value: 'north' }), ['north-1']);
  },
);
