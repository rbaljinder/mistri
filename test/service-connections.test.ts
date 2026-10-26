import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Registry, loadConfig, saveConfig } from '../packages/engine/src/server/connections.js';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { startFakeValkey } from './support/fakeValkey.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

const dir = mkdtempSync(join(tmpdir(), 'tablewalk-services-'));
const write = (name: string, body: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const DESCRIPTION = draftDescription(readOpenApi(spec));

test('a cache entry is read as a service, beside the databases it leaves alone', async () => {
  const path = write('both.json', {
    connections: [
      { name: 'crm', url: 'crm.db' },
      { name: 'cache', kind: 'cache', url: 'valkeys://cache.internal:6380/2', auth: { password: '${VALKEY_PASSWORD}' } },
    ],
  });
  const config = (await loadConfig(path, CONFIG_SECTIONS))!;
  assert.deepEqual(
    config.connections.map((c) => c.name),
    ['crm'],
  );
  assert.deepEqual(config.services, [
    { kind: 'cache', name: 'cache', url: 'valkeys://cache.internal:6380/2', auth: { password: '${VALKEY_PASSWORD}' } },
  ]);
});

for (const [label, entry, message] of [
  [
    'a plain cache URL without "insecure"',
    { kind: 'cache', url: 'valkey://cache.internal:6379' },
    /plain valkey:\/\/ "url". Use valkeys:\/\//,
  ],
  ['a credential in the URL', { kind: 'cache', url: 'valkeys://user:pw@cache.internal:6379' }, /credential in its "url"/],
  ['a key a cache does not take', { kind: 'cache', url: 'valkeys://cache.internal', description: 'x' }, /takes no "description"/],
  [
    'a cache password not in "auth"',
    { kind: 'cache', url: 'valkeys://cache.internal', auth: { bearer: 'x' } },
    /\{ "password": "\$\{VALKEY_PASSWORD\}" \}/,
  ],
  [
    'a search engine, which is a pack and not part of tablewalk',
    { kind: 'search', url: 'https://s.internal:8108', auth: { apiKey: '${TYPESENSE_API_KEY}' } },
    /has "kind": "search"\. Search providers are not part of mistri: they are packs \(Typesense is @mistriwork\/search-typesense\)/,
  ],
  ['an unknown kind', { kind: 'queue', url: 'x' }, /The kinds are "http", "cache" and "webhook"/],
  [
    'an HTTP cache that is not whole seconds',
    { kind: 'http', url: 'https://api.example/', description: DESCRIPTION, cache: { ttl: 0.5 } },
    /Write \{ "ttl": 60 \}/,
  ],
] as const) {
  test(`refused with the field named: ${label}`, async () => {
    const path = write(`bad-${label.replace(/\W+/g, '-')}.json`, { connections: [{ name: 'svc', ...entry }] });
    await assert.rejects(loadConfig(path, CONFIG_SECTIONS), message);
  });
}

test('one cache per deployment', async () => {
  const path = write('two-caches.json', {
    connections: [
      { name: 'a', kind: 'cache', url: 'valkeys://a.internal' },
      { name: 'b', kind: 'cache', url: 'valkeys://b.internal' },
    ],
  });
  await assert.rejects(loadConfig(path, CONFIG_SECTIONS), /2 cache connections \("a", "b"\); a deployment has one cache/);
});

test('saving from the UI keeps the cache entry, references intact, and an HTTP connection keeps its cache', async () => {
  const path = write('save.json', {
    connections: [
      { name: 'crm', url: 'crm.db' },
      { name: 'desk', kind: 'http', url: 'https://desk.example/', description: DESCRIPTION, cache: { ttl: 30 } },
      { name: 'cache', kind: 'cache', url: 'valkeys://cache.internal', auth: { username: 'app', password: '${VALKEY_PASSWORD}' } },
    ],
  });
  const config = (await loadConfig(path, CONFIG_SECTIONS))!;
  const registry = new Registry();
  for (const c of config.connections) registry.add({ name: c.name, url: c.url, http: c.http, source: 'config' });
  for (const service of config.services) registry.addService(service);
  await saveConfig(path, registry.configs(), registry.serviceConfigs(), CONFIG_SECTIONS);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { connections: Array<Record<string, unknown>> };
  assert.deepEqual(
    saved.connections.find((c) => c.name === 'cache'),
    { name: 'cache', kind: 'cache', url: 'valkeys://cache.internal', auth: { username: 'app', password: '${VALKEY_PASSWORD}' } },
  );
  assert.deepEqual(saved.connections.find((c) => c.name === 'desk')?.cache, { ttl: 30 });
  // Read back, the file is the same config.
  assert.deepEqual((await loadConfig(path, CONFIG_SECTIONS))!.services, config.services);
});

test("services are not databases: they are not listed, and the cache is the process's own until a cache connection is named", async () => {
  const registry = new Registry();
  assert.equal(registry.cache().kind, 'memory');
  registry.addService({ kind: 'cache', name: 'cache', url: 'valkeys://cache.internal' });
  assert.equal(registry.list().length, 0);
  assert.throws(() => registry.addService({ kind: 'cache', name: 'cache', url: 'valkeys://x.internal' }), /already/);
});

test('a configured cache is Valkey, dialed only when first used, and its password comes from the environment', async () => {
  const fake = await startFakeValkey({ password: 'env-cache-secret' });
  process.env.TEST_SERVICES_VALKEY_PASSWORD = 'env-cache-secret';
  try {
    const registry = new Registry();
    registry.addService({
      kind: 'cache',
      name: 'cache',
      url: `valkey://127.0.0.1:${fake.port}`,
      insecure: true,
      auth: { password: '${TEST_SERVICES_VALKEY_PASSWORD}' },
    });
    assert.equal(fake.commands.length, 0);
    const cache = registry.cache();
    assert.equal(cache.kind, 'valkey');
    await cache.set('tw:k', 'v', 60_000);
    assert.equal(await cache.get('tw:k'), 'v');
    await registry.closeServices();
  } finally {
    delete process.env.TEST_SERVICES_VALKEY_PASSWORD;
    await fake.close();
  }
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("a binary that keeps others' kinds leaves them unread and a save writes them back where they were", async () => {
  const { CACHE_SECTIONS } = await import('../packages/engine/src/server/cacheService.js');
  const keeping = { ...CACHE_SECTIONS, others: 'keep' as const };
  const mail = { name: 'mail', kind: 'email', url: 'smtp://localhost:25', from: 'desk@example.com' };
  const path = write('kept.json', { connections: [{ name: 'db', url: 'x.db' }, mail] });
  // The engine alone refuses a kind it does not read; the database browser keeps it.
  await assert.rejects(loadConfig(path, CACHE_SECTIONS));
  const config = (await loadConfig(path, keeping))!;
  assert.deepEqual(
    config.connections.map((c) => c.name),
    ['db'],
  );
  assert.deepEqual(config.kept, [mail]);
  const registry = new Registry();
  const saved = config.connections.map((connection) => registry.add({ ...connection, source: 'config' }));
  for (const entry of config.kept ?? []) registry.keep(entry);
  await saveConfig(path, saved, [], keeping, registry.keptEntries());
  assert.deepEqual((JSON.parse(readFileSync(path, 'utf8')) as { connections: unknown[] }).connections[1], mail);
});
