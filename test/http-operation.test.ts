import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { HttpAdapter } from '../packages/engine/src/adapters/http/httpAdapter.js';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { operationRefusal } from '../packages/engine/src/server/http/httpOperationRoutes.js';
import { createApp } from './support/createApp.js';
import { Refusal } from '../packages/engine/src/shared/refusal.js';
import { startFakeRest } from './support/fakeRest.js';

/* The explorer's API tab, server side: a resource's documented reads,
   described from the description and sent only as it declares them. Each
   test asserts what reached the API (the fake keeps every request) as well as
   what came back, and that the credential rode in a header and nowhere else. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const description = draftDescription(readOpenApi(spec));
const KEY = 'op-key-5e1a';
let api: Awaited<ReturnType<typeof startFakeRest>>;
let adapter: HttpAdapter;
let dir: string;
before(async () => {
  api = await startFakeRest();
  adapter = new HttpAdapter({
    base: new URL(`${api.origin}/v1/`),
    description,
    label: 'Desk',
    auth: { header: 'x-api-key', value: KEY },
    policy: { ...DEFAULT_POLICY, insecure: true },
  });
  dir = mkdtempSync(join(tmpdir(), 'tablewalk-http-operation-'));
});
after(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});
const last = () => api.seen.at(-1)!;
const refusal = (pattern: RegExp) => (error: unknown) => error instanceof Refusal && pattern.test(error.message);

test('the operations are what the description declares, and nothing else', () => {
  const contacts = adapter.operations('contacts');
  assert.equal(contacts.list.path, '/contacts');
  assert.deepEqual(
    contacts.list.params.map((param) => [param.name, param.kind]),
    [
      ['status', 'filter'],
      ['tag', 'filter'],
      ['q', 'search'],
      ['sort', 'sort'],
      ['offset', 'offset'],
      ['limit', 'limit'],
    ],
  );
  assert.deepEqual(contacts.list.params.find((param) => param.kind === 'sort')?.values, ['created_at', '-created_at', 'name']);
  assert.deepEqual(contacts.item, { path: '/contacts/{id}', key: 'id' });
  const tickets = adapter.operations('tickets');
  assert.deepEqual(tickets.list.params, [
    { name: 'contact_id', kind: 'filter', column: 'contact_id', many: true },
    { name: 'limit', kind: 'limit' },
    { name: 'cursor', kind: 'cursor' },
  ]);
  assert.equal(tickets.list.next, '/next_cursor');
  assert.throws(() => adapter.operations('invoices'), refusal(/No resource called "invoices"/));
});

test('a list sends exactly the declared parameters it was given, and the answer comes back whole', async () => {
  const reply = await adapter.operation('contacts', 'list', { status: 'lead', sort: 'name', limit: '3', offset: '0', tag: '' });
  assert.equal(reply.status, 200);
  assert.equal(last().path, '/v1/contacts');
  assert.deepEqual(Object.fromEntries(last().query), { status: 'lead', sort: 'name', limit: '3', offset: '0' });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(reply.request.query)), { status: 'lead', sort: 'name', limit: '3', offset: '0' });
  assert.equal(reply.request.path, '/contacts');
  // Whole: the explorer shows the API's own body, undeclared properties included.
  assert.equal((reply.json as Array<Record<string, unknown>>).length, 3);
  assert.equal((reply.json as Array<Record<string, unknown>>)[0].internal_note, 'not for tablewalk');
  assert.equal(last().headers['x-api-key'], KEY);
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(KEY));
  // A list-valued parameter takes several values, comma-separated in the box.
  await adapter.operation('tickets', 'list', { contact_id: 'c-01, c-02' });
  assert.deepEqual(last().query.getAll('contact_id'), ['c-01', 'c-02']);
});

test('an undeclared parameter, an undocumented sort or a paging value that is not a number is refused, and nothing is sent', async () => {
  const before = api.seen.length;
  await assert.rejects(
    adapter.operation('contacts', 'list', { name: 'x' }),
    refusal(/contacts's list takes status, tag, q, sort, offset, limit; not "name"/),
  );
  await assert.rejects(
    adapter.operation('contacts', 'list', { sort: 'score' }),
    refusal(/contacts sorts by created_at, -created_at, name; not "score"/),
  );
  await assert.rejects(adapter.operation('contacts', 'list', { limit: 'ten' }), refusal(/"limit" takes a whole number/));
  await assert.rejects(
    adapter.operation('contacts', 'item', { id: 'c-01', expand: 'all' }),
    refusal(/takes only its key, "id"; not "expand"/),
  );
  await assert.rejects(adapter.operation('contacts', 'item', { id: '..' }), refusal(/needs its key/));
  assert.equal(api.seen.length, before, 'no refused operation reached the API');
});

test('an item is read by its key; a status that is not 2xx comes back as the status, its body unread', async () => {
  const found = await adapter.operation('contacts', 'item', { id: 'c-03' });
  assert.deepEqual([found.status, found.request.path, (found.json as Record<string, unknown>).name], [200, '/contacts/c-03', 'Contact 3']);
  const missing = await adapter.operation('contacts', 'item', { id: 'nope' });
  assert.equal(missing.status, 404);
  assert.equal('json' in missing, false);
});

test('an application, a database or a shape-only connection is refused', () => {
  assert.equal(operationRefusal({ appConfigured: true, dialect: 'http', rowsKept: false })?.status, 403);
  assert.equal(operationRefusal({ appConfigured: false, dialect: 'sqlite', rowsKept: false })?.status, 400);
  assert.equal(operationRefusal({ appConfigured: false, dialect: 'http', rowsKept: true })?.status, 403);
  assert.equal(operationRefusal({ appConfigured: false, dialect: 'http', rowsKept: false }), undefined);
});

test('over the wire: described, tried, refused by name, and a failed call is a 502', async () => {
  const file = join(dir, 'plain.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY)');
  db.close();
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const closedPort = (reservation.address() as { port: number }).port;
  await new Promise((resolve) => reservation.close(resolve));
  const registry = new Registry();
  const http = { description, insecure: true, auth: { header: 'x-api-key', value: KEY } };
  registry.add({ name: 'desk', url: `${api.origin}/v1/`, writable: false, source: 'config', http });
  registry.add({ name: 'kept', url: `${api.origin}/v1/`, writable: false, rows: false, source: 'config', http });
  registry.add({ name: 'gone', url: `http://127.0.0.1:${closedPort}/v1/`, writable: false, source: 'config', http });
  registry.add({ name: 'db', url: file, source: 'config' });
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
      return { status: res.status, text: await res.text() };
    };
    const described = await post('/api/http/operations', { resource: 'contacts', conn: 'desk' });
    assert.equal(described.status, 200);
    assert.equal(JSON.parse(described.text).item.key, 'id');
    const tried = await post('/api/http/operation', {
      resource: 'contacts',
      operation: 'list',
      params: { status: 'lead', limit: '2' },
      conn: 'desk',
    });
    assert.equal(tried.status, 200);
    assert.equal(JSON.parse(tried.text).json.length, 2);
    assert.doesNotMatch(tried.text, new RegExp(KEY));
    const undeclared = await post('/api/http/operation', { resource: 'contacts', operation: 'list', params: { name: 'x' }, conn: 'desk' });
    assert.equal(undeclared.status, 400);
    assert.match(JSON.parse(undeclared.text).error, /not "name"/);
    assert.equal((await post('/api/http/operation', { resource: 'contacts', operation: 'delete', conn: 'desk' })).status, 400);
    assert.equal(
      (await post('/api/http/operation', { resource: 'contacts', operation: 'list', params: { limit: 3 }, conn: 'desk' })).status,
      400,
    );
    assert.equal((await post('/api/http/operations', { resource: 'thing', conn: 'db' })).status, 400);
    assert.equal((await post('/api/http/operation', { resource: 'contacts', operation: 'list', conn: 'kept' })).status, 403);
    const failed = await post('/api/http/operation', { resource: 'contacts', operation: 'list', conn: 'gone' });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(failed.text, new RegExp(KEY));
  } finally {
    server.close();
    server.closeAllConnections();
    await registry.closeAll();
  }
});
