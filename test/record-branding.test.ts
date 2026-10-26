import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromRecord, type BrandingCatalog, type BrandingSourceIdentity } from '../packages/mistri/src/shared/branding.js';
import { createRecordBrandingReader, type AuthorizedBrandingReader } from '../packages/mistri/src/server/app/recordBranding.js';

const spec = fromRecord('dealer_site', {
  by: 'tenant',
  tenantField: 'dealer_id',
  publishedField: 'published',
  fallback: { preset: 'sage' },
  fields: { accent: 'color', name: 'name' },
});
const catalog: BrandingCatalog = {
  resources: {
    dealer_site: {
      primaryKey: ['id'],
      columns: { id: 'text', dealer_id: 'text', version: 'integer', published: 'boolean', color: 'text', name: 'text' },
    },
  },
};
const identity: BrandingSourceIdentity = { deployment: 'one', app: 'site', source: 'keystone', bindingRevision: '1', catalogRevision: '1' };
const row = (tenant = 'north') => ({ id: 'same-key', dealer_id: tenant, version: 1, published: true, color: '#17366c', name: tenant });
const owner = (capacity?: number) => createRecordBrandingReader({ spec, catalog, identity, capacity });

test('reader asks only its declared columns, exact tenant and limit two, reauthorizing every cache hit', async () => {
  const reader = owner();
  let calls = 0,
    allowed = true;
  const read: AuthorizedBrandingReader = async (query) => {
    calls++;
    assert.deepEqual(query, {
      resource: 'dealer_site',
      columns: ['color', 'dealer_id', 'id', 'name', 'published', 'version'],
      where: { column: 'dealer_id', value: 'north' },
      limit: 2,
    });
    assert.ok(Object.isFrozen(query));
    assert.ok(Object.isFrozen(query.where));
    assert.ok(Object.isFrozen(query.columns));
    return allowed ? [row()] : null;
  };
  const request = { tenant: 'north', public: false, read };
  const first = await reader.resolve(request);
  assert.equal(first.status, 'resolved');
  assert.equal(await reader.resolve(request), first, 'same compilation, fresh authorized read');
  assert.equal(calls, 2);
  allowed = false;
  const denied = await reader.resolve(request);
  assert.equal(calls, 3);
  assert.equal(denied.status, 'fallback');
  assert.equal(denied.identity.recordKey, null);
  assert.equal(denied.identity.version, null);
  assert.deepEqual(denied.content, {});
});

test('identical row key/version never crosses tenant, deployment, App, source or revision identity', async () => {
  const reader = owner();
  const resolve = (tenant: string) => reader.resolve({ tenant, public: true, read: async () => [row(tenant)] });
  const north = await resolve('north'),
    south = await resolve('south');
  assert.equal(north.content.name, 'north');
  assert.equal(south.content.name, 'south');
  assert.notEqual(north, south);
  assert.equal(reader.cacheSize, 2);
  assert.equal(await resolve('north'), north);
  for (const field of Object.keys(identity) as (keyof BrandingSourceIdentity)[]) {
    const other = createRecordBrandingReader({ spec, catalog, identity: { ...identity, [field]: 'different' } });
    const result = await other.resolve({ tenant: 'north', public: false, read: async () => [row()] });
    assert.equal(result.identity[field], 'different');
    assert.notEqual(result, north);
    other.close();
  }
});

test('version and publication are fresh; public requests require explicit publication even after private cache fill', async () => {
  const reader = owner();
  let current = row();
  const request = { tenant: 'north', public: false, read: async () => [current] };
  const first = await reader.resolve(request);
  current = { ...current, version: 2, name: 'Changed' };
  const changed = await reader.resolve(request);
  assert.notEqual(changed, first);
  assert.equal(changed.identity.version, '2');
  assert.equal(changed.content.name, 'Changed');
  current = { ...current, published: false };
  assert.equal((await reader.resolve(request)).status, 'resolved');
  const unpublished = await reader.resolve({ ...request, public: true });
  assert.equal(unpublished.status, 'fallback');
  assert.equal(unpublished.diagnostics[0].code, 'unpublished');
  assert.equal(unpublished.identity.recordKey, null);
  current = { ...current, published: true };
  assert.equal((await reader.resolve({ ...request, public: true })).status, 'resolved');
  const { publishedField: _published, ...privateSpec } = spec;
  const privateReader = createRecordBrandingReader({ spec: privateSpec, catalog, identity });
  assert.equal((await privateReader.resolve(request)).status, 'resolved');
  assert.equal((await privateReader.resolve({ ...request, public: true })).status, 'fallback');
});

test('missing, ambiguous, mismatched and failed reads cannot release a prior compilation', async () => {
  const reader = owner();
  const request = { tenant: 'north', public: true, read: async () => [row()] };
  await reader.resolve(request);
  for (const rows of [null, [], [row(), row()], [row('south')]]) {
    const answer = await reader.resolve({ ...request, read: async () => rows });
    assert.equal(answer.status, 'fallback');
    assert.equal(answer.identity.recordKey, null);
    assert.deepEqual(answer.content, {});
  }
  const hidden: Record<string, unknown> = row();
  delete hidden.color;
  const narrowed = await reader.resolve({ ...request, read: async () => [hidden] });
  assert.equal(narrowed.status, 'fallback');
  assert.equal(narrowed.identity.recordKey, null);
  const failed = await reader.resolve({
    ...request,
    read: async () => {
      throw new Error('private database details');
    },
  });
  assert.equal(failed.status, 'fallback');
  assert.ok(!JSON.stringify(failed).includes('private database details'));
  let calls = 0;
  for (const tenant of [null, '', 'north&tenant=south', 'North', 'north,north']) {
    const answer = await reader.resolve({
      ...request,
      tenant,
      read: async () => {
        calls++;
        return [row()];
      },
    });
    assert.equal(answer.status, 'fallback');
    assert.equal(answer.identity.tenant, null);
  }
  assert.equal(calls, 0);
});

test('publication intent is captured before an asynchronous read', async () => {
  const reader = owner();
  let release!: (value: readonly Record<string, unknown>[]) => void;
  const request = {
    tenant: 'north',
    public: true,
    read: () =>
      new Promise<readonly Record<string, unknown>[]>((resolve) => {
        release = resolve;
      }),
  };
  const pending = reader.resolve(request);
  request.public = false;
  release([{ ...row(), published: false }]);
  assert.equal((await pending).diagnostics[0].code, 'unpublished');
});

test('out-of-band edits without a version bump cannot reuse old content or evade contrast validation', async () => {
  const reader = owner();
  let current = row();
  const request = { tenant: 'north', public: true, read: async () => [current] };
  const first = await reader.resolve(request);
  current = { ...current, name: 'Changed without a bump' };
  const second = await reader.resolve(request);
  assert.notEqual(first, second);
  assert.equal(second.content.name, current.name);
  current = { ...current, color: '#ffffff' };
  const invalid = await reader.resolve(request);
  assert.equal(invalid.status, 'fallback');
  assert.ok(invalid.diagnostics.some((item) => item.code === 'contrast'));
  assert.equal(reader.cacheSize, 0);
});

test('nonfinite values cannot collide with a cached nullable field', async () => {
  const reader = owner();
  let color: number | null = null;
  const request = { tenant: 'north', public: true, read: async () => [{ ...row(), color }] };
  const cached = await reader.resolve(request);
  assert.equal(cached.status, 'resolved');
  assert.equal(reader.cacheSize, 1);
  assert.equal(await reader.resolve(request), cached);
  for (const value of [NaN, Infinity, -Infinity]) {
    color = value;
    const rejected = await reader.resolve(request);
    assert.equal(rejected.status, 'fallback', String(value));
    assert.equal(rejected.identity.recordKey, null);
    assert.equal(rejected.identity.version, null);
    assert.deepEqual(rejected.content, {});
    assert.deepEqual(rejected.images, {});
  }
});

test('accessors and toJSON values cannot run during capture or cache key construction', async () => {
  const reader = owner();
  let ran = false;
  const poisoned = Object.defineProperty(row(), 'color', {
    enumerable: true,
    get() {
      ran = true;
      return '#17366c';
    },
  });
  const answer = await reader.resolve({ tenant: 'north', public: false, read: async () => [poisoned] });
  assert.equal(answer.status, 'fallback');
  assert.equal(ran, false);
  const key = {
    toJSON() {
      ran = true;
      return 'same-key';
    },
  };
  const malicious = await reader.resolve({ tenant: 'north', public: false, read: async () => [{ ...row(), id: key }] });
  assert.equal(malicious.status, 'fallback');
  assert.equal(ran, false);
});

test('bounded LRU touches hits, evicts the oldest compilation and never skips a read', async () => {
  const reader = owner(2);
  let reads = 0;
  const resolve = (tenant: string) =>
    reader.resolve({
      tenant,
      public: false,
      read: async () => {
        reads++;
        return [row(tenant)];
      },
    });
  const north = await resolve('north'),
    south = await resolve('south');
  assert.equal(await resolve('north'), north);
  await resolve('east');
  assert.equal(reader.cacheSize, 2);
  assert.equal(await resolve('north'), north);
  assert.notEqual(await resolve('south'), south);
  assert.equal(reader.cacheSize, 2);
  assert.equal(reads, 6);
});

test('close clears and fences in-flight results; retired owners never call a reader again', async () => {
  const reader = owner();
  await reader.resolve({ tenant: 'north', public: false, read: async () => [row()] });
  let release!: (value: readonly Record<string, unknown>[]) => void;
  const pending = reader.resolve({
    tenant: 'south',
    public: false,
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  reader.close();
  assert.equal(reader.cacheSize, 0);
  release([row('south')]);
  assert.equal((await pending).diagnostics[0].code, 'closed');
  const stopped = await reader.resolve({
    tenant: 'north',
    public: false,
    read: async () => {
      throw new Error('must not read');
    },
  });
  assert.equal(stopped.diagnostics[0].code, 'closed');
  assert.equal(reader.cacheSize, 0);
});

test('factory refuses malformed capacity, catalog and identity before acquiring anything', () => {
  for (const capacity of [0, -1, 1.5, 4097, NaN]) assert.throws(() => owner(capacity));
  assert.throws(() => createRecordBrandingReader({ spec, catalog, identity: { ...identity, deployment: '' } }));
  assert.throws(() => createRecordBrandingReader({ spec, catalog: { resources: {} }, identity }));
});
