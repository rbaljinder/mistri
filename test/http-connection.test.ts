import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { Registry, loadConfig, saveConfig } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { startFakeRest } from './support/fakeRest.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';

/* An HTTP connection from the config file to an open adapter: the fields are
   checked when the file is read, the description is found beside it, and the
   credential is expanded only at open, only for the URL the operator wrote. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
let api: Awaited<ReturnType<typeof startFakeRest>>;
let dir: string;
before(async () => {
  api = await startFakeRest();
  dir = mkdtempSync(join(tmpdir(), 'tablewalk-http-connection-'));
  writeFileSync(join(dir, 'desk.http.json'), JSON.stringify(draftDescription(readOpenApi(spec))));
});
after(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const configWith = (...connections: unknown[]) => {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ connections }));
  return path;
};
const desk = (overrides: Record<string, unknown> = {}) => ({
  name: 'Desk',
  kind: 'http',
  url: `${api.origin}/v1`,
  description: 'desk.http.json',
  insecure: true,
  auth: { bearer: '${DESK_TEST_TOKEN}' },
  ...overrides,
});
async function registryFrom(path: string) {
  const registry = new Registry();
  for (const c of (await loadConfig(path, CONFIG_SECTIONS))!.connections) registry.add({ ...c, writable: false, source: 'config' });
  return registry;
}

test('each registry captures its HTTP credential references without changing the process environment', async () => {
  const inherited = process.env.DESK_TEST_TOKEN;
  const config = (await loadConfig(configWith(desk()), CONFIG_SECTIONS))!.connections[0];
  for (const token of ['first-app-token', 'second-app-token']) {
    const environment = { DESK_TEST_TOKEN: token };
    const registry = new Registry({ environment });
    environment.DESK_TEST_TOKEN = 'changed-after-construction';
    registry.add({ ...config, writable: false, source: 'config' });
    try {
      const { adapter } = await registry.open(registry.list()[0].id);
      await adapter.query({ table: 'contacts', limit: 1, offset: 0 });
      assert.equal(api.seen.at(-1)!.headers.authorization, `Bearer ${token}`);
    } finally {
      await registry.closeAll();
    }
  }
  assert.equal(process.env.DESK_TEST_TOKEN, inherited);
  const empty = new Registry({ environment: {} });
  empty.add({ ...config, writable: false, source: 'config' });
  try {
    await assert.rejects(empty.open(empty.list()[0].id), /not set/);
  } finally {
    await empty.closeAll();
  }
});

test('an http connection opens on its description, with the credential from the environment', async () => {
  process.env.DESK_TEST_TOKEN = 'tok-from-env-41';
  try {
    const registry = await registryFrom(configWith(desk()));
    const [id] = registry.list().map((each) => each.id);
    const { adapter, schema } = await registry.open(id);
    assert.deepEqual(
      schema.tables.map((table) => table.id),
      ['contacts', 'tickets'],
    );
    await adapter.query({ table: 'contacts', limit: 2, offset: 0 });
    assert.equal(api.seen.at(-1)!.headers.authorization, 'Bearer tok-from-env-41');
    // The base URL gained its "/", so /v1 was extended rather than replaced.
    assert.equal(api.seen.at(-1)!.path, '/v1/contacts');
    const [listed] = registry.list();
    assert.equal(listed.dialect, 'http');
    assert.equal(listed.secret, 'environment');
    assert.doesNotMatch(JSON.stringify(registry.list()), /tok-from-env/);
  } finally {
    delete process.env.DESK_TEST_TOKEN;
  }
});

test('a URL a browser retargets the connection to gets no credential', async () => {
  const registry = await registryFrom(configWith(desk({ auth: { header: 'X-Api-Key', value: 'inline-key-77' } })));
  const [{ id, warning }] = registry.list();
  await registry.open(id);
  assert.match(registry.list()[0].warning ?? warning ?? '', /credential written into the config/);
  await registry.update(id, { url: `${api.origin}/v1/` }, { untrusted: true });
  const { adapter } = await registry.open(id);
  await adapter.query({ table: 'contacts', limit: 1, offset: 0 });
  assert.equal(api.seen.at(-1)!.headers['x-api-key'], undefined);
});

test('the config file is refused where an http entry is wrong, naming the field', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [desk({ kind: 'rest' }), /"kind": "rest"\. The kinds are "http", "cache" and "webhook"/],
    [desk({ writable: true }), /read-only; remove "writable"/],
    [desk({ schemas: ['public'] }), /"schemas" belongs to Postgres/],
    [desk({ description: undefined }), /needs a "description"/],
    [desk({ insecure: 'yes' }), /"insecure": "yes"\. It must be true or false/],
    [desk({ insecure: undefined }), /http:\/\/ "url"\. Use https/],
    [desk({ url: 'https://user:pw@desk.example/v1' }), /credential in its "url"/],
    [desk({ url: 'https://desk.example/v1?key=1' }), /query or fragment/],
    [desk({ auth: { token: 'x' } }), /an "auth" mistri cannot read/],
    [desk({ auth: { header: 'Host', value: 'x' } }), /"auth.header": "Host"/],
    [{ name: 'db', url: 'file.db', auth: { bearer: 'x' } }, /has "auth", which only an HTTP connection takes/],
  ];
  for (const [entry, message] of cases) await assert.rejects(loadConfig(configWith(entry), CONFIG_SECTIONS), message);
});

test('a description that is missing or not one is said when the connection opens', async () => {
  const registry = await registryFrom(
    configWith(desk({ description: 'absent.json', auth: undefined }), desk({ name: 'Bad', description: 'bad.json', auth: undefined })),
  );
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ format: 'something-else' }));
  const [absent, bad] = registry.list();
  await assert.rejects(registry.open(absent.id), /Desk: the description file .*absent\.json could not be read/);
  await assert.rejects(registry.open(bad.id), /Bad: .*bad\.json/);
});

test('over the wire, an API list has no total, a count is refused and a failing API is a 502', async () => {
  process.env.DESK_TEST_TOKEN = 'tok-wire-58';
  const registry = await registryFrom(configWith(desk(), desk({ name: 'Gone', url: `${api.origin}/nowhere` })));
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };
  const server = createApp({ registry, bound });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bound.port = (server.address() as { port: number }).port;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${bound.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    const [deskId, goneId] = registry.list().map((each) => each.id);
    const run = await post('/api/run', { q: 'contacts', conn: deskId });
    assert.equal(run.status, 200);
    // The bar's default page, asked of the API as its own limit rather than cut from a larger answer.
    assert.equal(run.json.rows.length, 20);
    assert.equal(api.seen.at(-1)!.query.get('limit'), '20');
    assert.equal('total' in run.json || 'exactTotal' in run.json, false, 'an API list claims no total');
    assert.deepEqual(run.json.order.order, [], 'no default sort is sent to an API');
    assert.equal(api.seen.at(-1)!.query.has('sort'), false);

    const count = await post('/api/count', { table: 'contacts', conn: deskId });
    assert.equal(count.status, 400);
    assert.match(count.json.error, /reports no totals/);

    const failed = await post('/api/run', { q: 'contacts', conn: goneId });
    assert.equal(failed.status, 502);
    assert.match(failed.json.error, /GET \/contacts answered 404/);

    const listed = await (await fetch(`http://127.0.0.1:${bound.port}/api/connections`)).text();
    assert.match(listed, /"dialect":"http"/);
    assert.doesNotMatch(listed, /tok-wire/);
  } finally {
    server.close();
    server.closeAllConnections();
    await registry.closeAll();
    delete process.env.DESK_TEST_TOKEN;
  }
});

test('saving writes the connection back as it was written, references and relative path intact', async () => {
  const path = configWith(desk());
  const registry = await registryFrom(path);
  await saveConfig(path, registry.configs());
  const [saved] = JSON.parse(readFileSync(path, 'utf8')).connections;
  assert.deepEqual(saved, {
    name: 'Desk',
    url: `${api.origin}/v1`,
    kind: 'http',
    description: 'desk.http.json',
    auth: { bearer: '${DESK_TEST_TOKEN}' },
    insecure: true,
  });
});
