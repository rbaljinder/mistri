import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import {
  DESCRIPTION_FORMAT,
  describedSchema,
  draftDescription,
  readDescription,
  type HttpDescription,
} from '../packages/engine/src/adapters/http/httpDescription.js';

/* The import drafts a description; the author edits it; the adapter reads
   it. These pin the handover: a draft reads back unchanged, a hand edit that
   would change what the API is asked is refused with the field named, and the
   description becomes the same catalog shape a database produces. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const draft: HttpDescription = draftDescription(readOpenApi(spec), { file: 'openapi.json', sha256: 'a'.repeat(64) });
const copy = () => JSON.parse(JSON.stringify(draft));

test('a drafted description reads back exactly as drafted', () => {
  assert.equal(draft.format, DESCRIPTION_FORMAT);
  assert.deepEqual(readDescription(copy(), 'desk.http.json'), draft);
});

test('a hand edit that would change what the API is asked is refused, naming the field', () => {
  const cases: Array<[(d: any) => void, RegExp]> = [
    [
      (d) => {
        d.format = 'mistri.http/9';
      },
      /reads "mistri\.http\/1"/,
    ],
    [
      (d) => {
        d.resources[0].columns[1].type = 'text';
      },
      /"name" has "type": "text"/,
    ],
    [
      (d) => {
        d.resources[0].columns[1].nullable = 'false';
      },
      /needs "nullable": true or false, without quotes/,
    ],
    [
      (d) => {
        d.resources[0].key = 'email';
      },
      /needs "item": "\/contacts\/\{email\}"/,
    ],
    [
      (d) => {
        d.resources[0].filters.score = { param: 'min_score', ops: ['>='] };
      },
      /filter "score" has "ops"/,
    ],
    [
      (d) => {
        d.resources[0].filters.address = { param: 'city', ops: ['='] };
      },
      /filters "address", which is not a column that can be filtered/,
    ],
    [
      (d) => {
        d.resources[0].paging = { kind: 'cursor', param: 'cursor', next: 'next_cursor' };
      },
      /JSON Pointer/,
    ],
    [
      (d) => {
        d.resources[1].name = 'contacts';
      },
      /two resources called "contacts"/,
    ],
    [
      (d) => {
        d.spec.sha256 = 'short';
      },
      /64-character "sha256"/,
    ],
  ];
  for (const [edit, message] of cases) {
    const edited = copy();
    edit(edited);
    assert.throws(() => readDescription(edited, 'desk.http.json'), message);
  }
});

test('the description becomes the catalog every App, grant and type export already reads', () => {
  const schema = describedSchema(draft, 'Desk API', new Date('2026-09-12T00:00:00Z'));
  assert.equal(schema.dialect, 'http');
  assert.equal(schema.readAt, '2026-09-12T00:00:00.000Z');
  assert.deepEqual(
    schema.tables.map((table) => table.id),
    ['contacts', 'tickets'],
  );
  const contacts = schema.tables[0];
  assert.equal(contacts.comment, 'Contacts, newest first');
  const byName = Object.fromEntries(contacts.columns.map((column) => [column.name, column]));
  assert.deepEqual(byName.id, { name: 'id', type: 'uuid', nullable: false, primaryKey: true });
  assert.deepEqual(byName.status.allowed, ['lead', 'customer', 'churned']);
  assert.deepEqual(
    ['score', 'created_at', 'address'].map((name) => byName[name].type),
    ['numeric', 'timestamp', 'json'],
  );
  // An int64 key is a bigint column, which every display path keeps as text past 2^53.
  assert.equal(schema.tables[1].columns.find((column) => column.name === 'id')?.type, 'bigint');
  // The one reference the draft guessed by name, tickets.contact_id → contacts (test/http-references.test.ts).
  assert.deepEqual(
    schema.foreignKeys.map((fk) => fk.name),
    ['tickets_contact_id'],
  );
  // What a header may offer: the columns the documented sort values name ("-created_at" sorts by created_at), none without a sort.
  assert.deepEqual(
    schema.tables.map((table) => [table.id, table.sortable]),
    [
      ['contacts', ['created_at', 'name']],
      ['tickets', []],
    ],
  );
});
