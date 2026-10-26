import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { HttpAdapter } from '../packages/engine/src/adapters/http/httpAdapter.js';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { DEFAULT_POLICY } from '../packages/engine/src/adapters/http/egress.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { Refusal } from '../packages/engine/src/shared/refusal.js';
import { appError } from '../packages/mistri/src/server/app/appErrors.js';
import { BIG_ID, CONTACTS, TICKETS, startFakeRest } from './support/fakeRest.js';

/* The adapter asks the API only what its description says the API can
   answer, and says so when asked for more. Each test asserts what reached the
   API (the fake keeps every request), not only what came back. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const description = draftDescription(readOpenApi(spec));
const TOKEN = 'Bearer test-token-9f2c';
let api: Awaited<ReturnType<typeof startFakeRest>>;
let adapter: HttpAdapter;
before(async () => {
  api = await startFakeRest();
  adapter = new HttpAdapter({
    base: new URL(`${api.origin}/v1/`),
    description,
    label: 'Desk',
    auth: { header: 'authorization', value: TOKEN },
    policy: { ...DEFAULT_POLICY, insecure: true },
  });
});
after(() => api.close());
const last = () => api.seen.at(-1)!;
const refusal = (pattern: RegExp) => (error: unknown) => error instanceof Refusal && pattern.test(error.message);

test('the catalog is the description, drawn as the tables every App reads', async () => {
  const schema = await adapter.introspect();
  assert.equal(schema.dialect, 'http');
  assert.deepEqual(
    schema.tables.map((table) => table.id),
    ['contacts', 'tickets'],
  );
});

test('a page asks the API for exactly that page, and the credential rides in a header only', async () => {
  const result = await adapter.query({ table: 'contacts', limit: 10, offset: 10 });
  assert.deepEqual(
    result.rows.map((row) => row.id),
    CONTACTS.slice(10, 20).map((row) => row.id),
  );
  assert.equal(last().path, '/v1/contacts');
  assert.deepEqual([last().query.get('offset'), last().query.get('limit')], ['10', '10']);
  assert.equal(last().headers.authorization, TOKEN);
  assert.equal(result.sql.text, 'GET /contacts?offset=10&limit=10');
  assert.doesNotMatch(JSON.stringify(result), /test-token/);
});

test('only the columns the description declares come through, each as its declared type', async () => {
  const { rows, columns } = await adapter.query({ table: 'contacts', limit: 1, offset: 0 });
  assert.deepEqual(
    columns,
    description.resources[0].columns.map((column) => column.name),
  );
  assert.equal('internal_note' in rows[0], false, 'a property the spec does not declare is dropped');
  assert.deepEqual(rows[0].address, { city: 'Porto' });
  assert.equal(rows[0].email, null);
  const some = await adapter.query({ table: 'contacts', columns: ['id', 'status'], limit: 1, offset: 0 });
  assert.deepEqual(Object.keys(some.rows[0]), ['id', 'status']);
});

test('declared filters and the documented sort become query parameters; the key tiebreak is not sent', async () => {
  const result = await adapter.query({
    table: 'contacts',
    limit: 5,
    offset: 0,
    filter: {
      groups: [
        [
          { column: 'status', op: '=', value: 'lead' },
          { column: 'tag', op: '=', value: 'retail' },
        ],
      ],
    },
    orderBy: [
      { column: 'name', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ],
  });
  assert.equal(result.sql.text, 'GET /contacts?status=lead&tag=retail&sort=name&offset=0&limit=5');
  assert.ok(result.rows.length && result.rows.every((row) => row.status === 'lead'));
  const tickets = await adapter.query({
    table: 'tickets',
    limit: 10,
    offset: 0,
    filter: { groups: [[{ column: 'contact_id', op: 'in', value: ['c-01', 'c-02'] }]] },
  });
  assert.deepEqual(last().query.getAll('contact_id'), ['c-01', 'c-02']);
  assert.deepEqual(
    tickets.rows.map((row) => row.contact_id).sort(),
    TICKETS.filter((row) => row.contact_id !== 'c-03')
      .map((row) => row.contact_id)
      .sort(),
  );
});

test('what the API cannot do is refused by name, and nothing is sent', async () => {
  const before = api.seen.length;
  const cases: Array<[Parameters<HttpAdapter['query']>[0], RegExp]> = [
    [
      {
        table: 'contacts',
        limit: 5,
        offset: 0,
        filter: { groups: [[{ column: 'status', op: '=', value: 'lead' }], [{ column: 'tag', op: '=', value: 'retail' }]] },
      },
      /cannot answer "or"\. It can filter by status =, tag =/,
    ],
    [
      { table: 'contacts', limit: 5, offset: 0, filter: { groups: [[{ column: 'name', op: 'contains', value: 'Con' }]] } },
      /cannot filter by "name contains"/,
    ],
    [
      { table: 'contacts', limit: 5, offset: 0, filter: { groups: [[{ column: 'status', op: '!=', value: 'lead' }]] } },
      /cannot filter by "status !="/,
    ],
    [
      { table: 'contacts', limit: 5, offset: 0, filter: { groups: [[{ column: 'status', op: 'in', value: ['lead'] }]] } },
      /cannot filter by "status in"/,
    ],
    [
      {
        table: 'contacts',
        limit: 5,
        offset: 0,
        filter: {
          groups: [
            [
              { column: 'status', op: '=', value: 'lead' },
              { column: 'status', op: '=', value: 'customer' },
            ],
          ],
        },
      },
      /can take status once/,
    ],
    [
      { table: 'contacts', limit: 5, offset: 0, orderBy: [{ column: 'score', direction: 'desc' }] },
      /cannot sort by score descending\. It sorts by created_at, -created_at, name/,
    ],
    [
      {
        table: 'contacts',
        limit: 5,
        offset: 0,
        orderBy: [
          { column: 'name', direction: 'asc' },
          { column: 'status', direction: 'asc' },
        ],
      },
      /one documented value at most/,
    ],
    [{ table: 'tickets', limit: 5, offset: 0, orderBy: [{ column: 'subject', direction: 'asc' }] }, /It takes no sort/],
    [{ table: 'tickets', limit: 3, offset: 2 }, /row 3 does not start one/],
    [{ table: 'invoices', limit: 5, offset: 0 }, /No resource called "invoices"/],
  ];
  for (const [request, message] of cases) await assert.rejects(adapter.query(request), refusal(message));
  assert.equal(api.seen.length, before, 'no refused request reached the API');
  await assert.rejects(adapter.count('contacts'), refusal(/reports no totals/));
});

test('a record is read by its key from the item path; a missing one is no row', async () => {
  const byKey = (value: string) =>
    adapter.query({ table: 'contacts', limit: 20, offset: 0, filter: { groups: [[{ column: 'id', op: '=', value }]] } });
  const found = await byKey('c-03');
  assert.equal(last().path, '/v1/contacts/c-03');
  assert.deepEqual(
    found.rows.map((row) => row.name),
    ['Contact 3'],
  );
  assert.deepEqual((await byKey('nope')).rows, []);
  // Encoded, so a key cannot add a path segment.
  await byKey('a/b');
  assert.equal(last().path, '/v1/contacts/a%2Fb');
  const before = api.seen.length;
  assert.deepEqual((await byKey('..')).rows, []);
  assert.equal(api.seen.length, before, '".." never becomes a step up from the item');
});

test('a cursor-paged list is walked to its page once, and the walk remembered', async () => {
  const start = api.seen.length;
  const second = await adapter.query({ table: 'tickets', limit: 3, offset: 3 });
  assert.deepEqual(
    second.rows.map((row) => row.subject),
    ['Ticket 4', 'Ticket 5', 'Ticket 6'],
  );
  assert.equal(api.seen.length - start, 2, 'the first page for its cursor, then the page itself');
  const third = await adapter.query({ table: 'tickets', limit: 3, offset: 6 });
  assert.equal(api.seen.length - start, 4, 'the remembered walk starts from page two');
  // Past 2^53 the id arrives as bare digits and leaves as the same digits.
  assert.deepEqual(
    third.rows.map((row) => row.id),
    [BIG_ID],
  );
  assert.equal(third.sql.text, 'GET /tickets?limit=3&cursor=6');
});

test('a view on one resource is read as the record or list it is; a path through a column that is not a reference is refused', async () => {
  // What a record page sends: its fields as paths, the key as a path condition, one row.
  const record = await adapter.runView({
    id: 'record:contacts',
    name: 'contacts',
    base: 'contacts',
    columns: [{ path: 'name' }, { path: 'email', alias: 'mail' }],
    filter: { groups: [[{ path: 'id', op: '=', value: 'c-03' }]] },
    limit: 1,
  });
  assert.equal(last().path, '/v1/contacts/c-03');
  assert.deepEqual(record.rows, [{ name: 'Contact 3', mail: 'contact3@example.test' }]);
  assert.deepEqual(
    record.resolved.map((column) => [column.name, column.type, column.hops]),
    [
      ['name', 'text', 0],
      ['mail', 'text', 0],
    ],
  );
  assert.deepEqual(record.joins, []);

  const listed = await adapter.runView({ id: 'v', name: 'v', base: 'tickets', columns: [{ path: 'subject' }], limit: 3 }, 3);
  assert.deepEqual(listed.rows, [{ subject: 'Ticket 4' }, { subject: 'Ticket 5' }, { subject: 'Ticket 6' }]);

  const before = api.seen.length;
  // `contact_id` is a reference (test/http-references.test.ts); `subject` is not, so there is nothing to follow.
  await assert.rejects(adapter.runView({ id: 'v', name: 'v', base: 'tickets', columns: [{ path: 'subject.name' }] }), /reference/);
  assert.equal(api.seen.length, before, 'a refused view reaches no API');
});

test('a refusal names the columns it quotes, and an App error carries them, so an App can say them in its captions', async () => {
  const refused = await adapter
    .query({ table: 'contacts', limit: 5, offset: 0, filter: { groups: [[{ column: 'name', op: 'contains', value: 'x' }]] } })
    .catch((error: unknown) => error);
  assert.ok(refused instanceof Refusal);
  assert.deepEqual(refused.columns, ['name', 'status', 'tag']);
  // Names only, never values: the App error passes the list on beside the message.
  assert.deepEqual(appError(refused).columns, ['name', 'status', 'tag']);
  const sort = await adapter
    .query({ table: 'contacts', limit: 5, offset: 0, orderBy: [{ column: 'score', direction: 'desc' }] })
    .catch((error: unknown) => error);
  assert.deepEqual((sort as Refusal).columns, ['score']);
});
