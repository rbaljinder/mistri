import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { TypesenseClient, typesenseConnectionOf, typesenseSearch } from '../packs/search-typesense/src/index.js';
import { SearchUnavailable } from '../packages/mistri/src/server/app/searchProvider.js';
import { startFakeTypesense, type FakeTypesense } from './support/fakeTypesense.js';

const KEY = 'fake-typesense-key';
let fake: FakeTypesense;
before(async () => {
  fake = await startFakeTypesense(KEY);
});
after(async () => {
  await fake.close();
});

const client = (apiKey: string | undefined = KEY, url = fake.url) =>
  new TypesenseClient({
    base: new URL(url),
    label: 'search',
    policy: { ...DEFAULT_POLICY, insecure: true },
    ...(apiKey ? { apiKey } : {}),
  });

test('a collection is created with its fields, and a field added later is added to it', async () => {
  await client().ensureCollection('tw_crm_lead', ['name']);
  await client().ensureCollection('tw_crm_lead', ['name', 'company']);
  assert.deepEqual(fake.collections.get('tw_crm_lead')?.fields, ['name', 'company']);
  // A second ensure with nothing new sends no PATCH.
  const before = fake.requests.length;
  await client().ensureCollection('tw_crm_lead', ['name', 'company']);
  assert.deepEqual(
    fake.requests.slice(before).map((r) => r.method),
    ['GET'],
  );
});

test('records go in by key, come out as keys best match first, and leave by key', async () => {
  const search = client();
  await search.ensureCollection('tw_crm_contact', ['name', 'company']);
  await search.upsert('tw_crm_contact', { id: '1', name: 'Margot Fontaine', company: 'Stonebridge' });
  await search.upsert('tw_crm_contact', { id: '2', name: 'Ada Stone', company: 'Stonebridge Marine' });
  await search.upsert('tw_crm_contact', { id: '3', name: 'Wei Iyer', company: 'Greywacke' });
  assert.deepEqual(await search.search('tw_crm_contact', 'stone', ['name', 'company'], 10), ['2', '1']);
  await search.remove('tw_crm_contact', '2');
  await search.remove('tw_crm_contact', '2');
  assert.deepEqual(await search.search('tw_crm_contact', 'stone', ['name', 'company'], 10), ['1']);
});

test('a collection nobody has indexed matches nothing', async () => {
  assert.deepEqual(await client().search('tw_nobody', 'x', ['name'], 5), []);
});

test('a wrong key is unavailable search, said without the key, and the key only ever travels as the header', async () => {
  await assert.rejects(
    client('not-the-key').search('tw_crm_contact', 'x', ['name'], 5),
    (error: Error) =>
      error instanceof SearchUnavailable &&
      /401 \(check the connection's apiKey\)/.test(error.message) &&
      !error.message.includes('not-the-key'),
  );
  assert.ok(fake.requests.every((r) => !r.path.includes(KEY) && !r.path.includes('not-the-key')));
});

test('an address the policy refuses is refused before anything is sent, and a service that is down is unavailable', async () => {
  await assert.rejects(client(KEY, 'http://169.254.169.254:8108/').search('c', 'x', ['name'], 5), /may not reach/);
  const down = await startFakeTypesense(KEY);
  const url = down.url;
  await down.stop();
  await assert.rejects(client(KEY, url).search('c', 'x', ['name'], 5), SearchUnavailable);
  assert.equal(await client(KEY, url).health(), false);
  assert.equal(await client().health(), true);
});

test('a connection is read as mistri.json wrote it, and refused with the field named', () => {
  const where = 'mistri.json: connection "search"';
  assert.deepEqual(
    typesenseConnectionOf(
      { name: 'search', url: 'https://search.internal:8108', auth: { apiKey: '${TYPESENSE_API_KEY}' }, collectionPrefix: 'acme' },
      where,
    ),
    { name: 'search', url: 'https://search.internal:8108', auth: { apiKey: '${TYPESENSE_API_KEY}' }, collectionPrefix: 'acme' },
  );
  for (const [entry, message] of [
    [{ url: 'http://s.internal:8108' }, /Use https, or set "insecure": true/],
    [{ url: 'https://user:pw@s.internal' }, /credential in its "url"/],
    [{ url: 'https://s.internal', engine: 'typesense' }, /takes no "engine"/],
    [{ url: 'https://s.internal', auth: { bearer: 'x' } }, /\{ "apiKey": "\$\{TYPESENSE_API_KEY\}" \}/],
    [{ url: 'https://s.internal', collectionPrefix: '1x' }, /"collectionPrefix" that is not a name/],
  ] as const)
    assert.throws(() => typesenseConnectionOf({ name: 'search', ...entry }, where), message);
});

test('the provider opens each connection by its name, once, and has none it was not given', () => {
  const provider = typesenseSearch([{ name: 'search', url: fake.url, insecure: true, collectionPrefix: 'acme' }]);
  const index = provider.index('search');
  assert.ok(index);
  assert.equal(index.collectionPrefix, 'acme');
  assert.equal(provider.index('search'), index);
  assert.equal(provider.index('nope'), undefined);
  assert.throws(
    () =>
      typesenseSearch([
        { name: 'a', url: fake.url },
        { name: 'a', url: fake.url },
      ]),
    /already/,
  );
});

test("a tenant's scope is Typesense's exact match, and a value it cannot quote is refused before anything is sent", async () => {
  const search = client();
  const before = fake.requests.length;
  await search.search('tw_crm_contact', 'stone', ['name'], 5, { field: 'mistri_tenant', value: 'north' });
  assert.ok(fake.requests.slice(before).some((r) => decodeURIComponent(r.path).includes('filter_by=mistri_tenant:=`north`')));
  const sent = fake.requests.length;
  await assert.rejects(search.search('tw_crm_contact', 'x', ['name'], 5, { field: 'mistri_tenant', value: 'a`b' }), SearchUnavailable);
  assert.equal(fake.requests.length, sent);
});
