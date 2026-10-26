import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { HttpAdapter } from '../packages/engine/src/adapters/http/httpAdapter.js';
import { describedSchema, draftDescription, readDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { Refusal } from '../packages/engine/src/shared/refusal.js';
import { startFakeRest } from './support/fakeRest.js';

/* References between an API's resources: guessed from a column's name by the
   draft, declared by the description, a foreign key to the catalog, and
   followed by the adapter one step — each target read once from its item
   path, never inside the API's own query. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const description = draftDescription(readOpenApi(spec));
let api: Awaited<ReturnType<typeof startFakeRest>>;
let adapter: HttpAdapter;
before(async () => {
  api = await startFakeRest();
  adapter = new HttpAdapter({
    base: new URL(`${api.origin}/v1/`),
    description,
    label: 'Desk',
    policy: { ...DEFAULT_POLICY, insecure: true },
  });
});
after(() => api.close());

test('a reference is a foreign key to the catalog, and a column that points', () => {
  const schema = describedSchema(description, 'Desk');
  assert.deepEqual(schema.foreignKeys, [
    { name: 'tickets_contact_id', from: { table: 'tickets', columns: ['contact_id'] }, to: { table: 'contacts', columns: ['id'] } },
  ]);
  const column = schema.tables.find((table) => table.id === 'tickets')!.columns.find((each) => each.name === 'contact_id')!;
  assert.deepEqual(column.references, { table: 'contacts', column: 'id' });
});

test('a description is refused where a reference cannot be followed', () => {
  const edited = (change: (tickets: Record<string, any>) => void) => {
    const copy = structuredClone(description) as any;
    change(copy.resources.find((each: { name: string }) => each.name === 'tickets'));
    return () => readDescription(copy, 'desk.http.json');
  };
  assert.throws(
    edited((tickets) => {
      tickets.columns.find((c: { name: string }) => c.name === 'contact_id').references = 'accounts';
    }),
    /references "accounts", which is not a resource in this description/,
  );
  assert.throws(
    edited((tickets) => {
      tickets.columns.find((c: { name: string }) => c.name === 'id').references = 'contacts';
    }),
    /key "id" cannot reference another resource/,
  );
});

test('a view follows a reference by reading each target once, and a missing one reads as empty', async () => {
  const before = api.seen.length;
  const result = await adapter.runView({
    id: 'v',
    name: 'v',
    base: 'tickets',
    limit: 10,
    columns: [{ path: 'subject' }, { path: 'contact_id.name', alias: 'contact' }],
  });
  assert.deepEqual(result.rows.slice(0, 3), [
    { subject: 'Ticket 1', contact: 'Contact 1' },
    { subject: 'Ticket 2', contact: 'Contact 2' },
    { subject: 'Ticket 3', contact: 'Contact 3' },
  ]);
  assert.equal(result.joins.length, 1);
  // Seven tickets name three contacts: the list, then three item reads, however many rows share one.
  const asked = api.seen.slice(before).map((request) => request.path);
  assert.deepEqual(asked.filter((path) => path.startsWith('/v1/contacts/')).sort(), [
    '/v1/contacts/c-01',
    '/v1/contacts/c-02',
    '/v1/contacts/c-03',
  ]);
  assert.match(result.sql.text, /GET \/contacts\/\{id\} for 3 contacts/);
});

test("what would need the targets inside the API's own query is refused, and nothing is sent", async () => {
  const before = api.seen.length;
  await assert.rejects(
    adapter.runView({
      id: 'v',
      name: 'v',
      base: 'tickets',
      columns: [{ path: 'subject' }],
      filter: { groups: [[{ path: 'contact_id.name', op: '=', value: 'Contact 1' }]] },
    }),
    (error: unknown) => error instanceof Refusal && /filters and sorts by its own columns only; "contact_id.name"/.test(error.message),
  );
  await assert.rejects(
    adapter.runView({
      id: 'v',
      name: 'v',
      base: 'tickets',
      columns: [{ path: 'subject' }],
      orderBy: [{ path: 'contact_id.name', direction: 'asc' }],
    }),
    /is on another resource/,
  );
  assert.equal(api.seen.length, before);
});

test('over the wire, a record pointed at lists its references without asking for a count', async () => {
  const registry = new Registry();
  registry.add({ name: 'desk', url: `${api.origin}/v1/`, writable: false, source: 'config', http: { description, insecure: true } });
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };
  const server = createApp({ registry, bound });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bound.port = (server.address() as { port: number }).port;
    const reply = await fetch(`http://127.0.0.1:${bound.port}/api/references`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'contacts', key: { id: 'c-01' }, conn: 'desk' }),
    });
    assert.equal(reply.status, 200);
    const { references } = (await reply.json()) as { references: Array<{ table: string; count?: number; error?: string }> };
    assert.deepEqual(
      references.map((each) => [each.table, 'count' in each, 'error' in each]),
      [['tickets', false, false]],
    );
  } finally {
    server.close();
    server.closeAllConnections();
    await registry.closeAll();
  }
});
