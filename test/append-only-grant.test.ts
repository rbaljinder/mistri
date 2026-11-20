/** A table a role creates but does not write (`create` without `write`) is append-only: the guard lets a row be made there and refuses everything that would edit or remove one. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InsertRequest, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import {
  accessibleSchema,
  AppAccessDenied,
  authorizeColumnWrites,
  captureGrant,
  resourceChecks,
  validateResourceView,
  type ColumnGrant,
} from '../packages/engine/src/server/columnGrants.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'Fixture',
  dialect: 'sqlite',
  readAt: '2026-11-11',
  foreignKeys: [],
  tables: [
    {
      id: 'note',
      name: 'note',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true, identity: 'always' },
        { name: 'body', type: 'text', nullable: true, primaryKey: false },
        { name: 'secret', type: 'text', nullable: true, primaryKey: false },
      ],
    },
  ],
};
const sql = { text: 'fixture', params: [] };
const fixture = (grant: ColumnGrant) => {
  const calls: string[] = [];
  const writer: WriteTransaction = {
    query: async () => ({ columns: [], rows: [], ms: 0, sql }),
    count: async () => 0,
    insert: async (request: InsertRequest) => {
      calls.push('insert');
      return { key: { id: 1 }, applied: request.values, sql };
    },
    insertMany: async (requests) => {
      calls.push('insertMany');
      return requests.map((request) => ({ key: { id: 1 }, applied: request.values, sql }));
    },
    update: async (request) => {
      calls.push('update');
      return { affected: 1, applied: request.values, sql };
    },
    updateMany: async (requests) => {
      calls.push('updateMany');
      return requests.map((request) => ({ affected: 1, applied: request.values, sql }));
    },
    remove: async () => {
      calls.push('remove');
      return { affected: 1, sql };
    },
    lockRecord: async () => {
      calls.push('lock');
    },
  };
  return { calls, tx: authorizeColumnWrites(schema, grant, writer) };
};
const appended = (): ColumnGrant => ({
  readable: new Set(['note']),
  writable: new Set(['note']),
  creatable: new Set(['note']),
  appendOnly: new Set(['note']),
  // The role's fields.write: the body, never the secret.
  fields: new Map([['note', { read: new Set(['id', 'body', 'secret']), write: new Set(['body']) }]]),
});
const key = { id: 1 };

test('an append-only table takes a new row and refuses every edit, removal, batch and lock', async () => {
  const { calls, tx } = fixture(appended());
  await tx.insert({ table: 'note', values: { body: 'hello' } });
  await tx.insertMany!([
    { table: 'note', values: { body: 'a' } },
    { table: 'note', values: { body: 'b' } },
  ]);
  assert.deepEqual(calls, ['insert', 'insertMany']);
  calls.length = 0;
  await assert.rejects(async () => tx.update({ table: 'note', key, values: { body: 'x' } }), AppAccessDenied);
  await assert.rejects(
    async () =>
      tx.updateMany!([
        { table: 'note', key, values: { body: 'x' } },
        { table: 'note', key: { id: 2 }, values: { body: 'y' } },
      ]),
    AppAccessDenied,
  );
  await assert.rejects(async () => tx.remove({ table: 'note', key }), AppAccessDenied);
  await assert.rejects(async () => tx.lockRecord!({ table: 'note', key }), AppAccessDenied);
  assert.deepEqual(calls, [], 'nothing reached the database');
});

test("an append is still held to the role's fields.write", async () => {
  const { calls, tx } = fixture(appended());
  await assert.rejects(async () => tx.insert({ table: 'note', values: { body: 'x', secret: 'no' } }), AppAccessDenied);
  assert.deepEqual(calls, []);
});

test('the same grant without appendOnly edits, so the refusal is the append and nothing else', async () => {
  const { appendOnly: _dropped, ...plain } = appended();
  const { calls, tx } = fixture(plain);
  await tx.update({ table: 'note', key, values: { body: 'x' } });
  assert.deepEqual(calls, ['update']);
});

test('the served catalog says append-only and not deletable, and leaves the columns writable for New', () => {
  const [table] = accessibleSchema(schema, appended()).tables;
  assert.equal(table.appendOnly, true);
  assert.equal(table.deletable, false);
  assert.notEqual(table.insertable, false);
  assert.equal(table.columns.find((column) => column.name === 'body')!.writable, true);
  assert.equal(table.columns.find((column) => column.name === 'secret')!.writable, false);
  // Only a grant that says so: a table the reader edits carries no word of it.
  const { appendOnly: _dropped, ...plain } = appended();
  assert.equal(accessibleSchema(schema, plain).tables[0].appendOnly, undefined);
});

test('a captured grant keeps appendOnly, in a copy the caller cannot change', () => {
  const grant = appended();
  const kept = captureGrant(grant);
  assert.deepEqual(kept.appendOnly, new Set(['note']));
  assert.notEqual(kept.appendOnly, grant.appendOnly);
});

test('a write reply carries no column the role cannot read, even one the server filled in', async () => {
  const filled = { sql, key: { id: 1 } };
  const writer = {
    insert: async (request: InsertRequest) => ({
      ...filled,
      row: { id: 1, body: request.values.body, secret: 'server fill' },
      applied: { ...request.values, secret: 'server fill' },
    }),
    update: async (request: { values: Record<string, unknown> }) => ({
      affected: 1,
      applied: { ...request.values, secret: 'server stamp' },
      sql,
    }),
    lockRecord: async () => {},
  } as unknown as WriteTransaction;
  const grant: ColumnGrant = {
    readable: new Set(['note']),
    writable: new Set(['note']),
    fields: new Map([['note', { read: new Set(['id', 'body']), write: new Set(['body']) }]]),
  };
  const tx = authorizeColumnWrites(schema, grant, writer);
  const made = await tx.insert({ table: 'note', values: { body: 'hello' } });
  assert.deepEqual(made.applied, { body: 'hello' });
  assert.deepEqual(made.row, { id: 1, body: 'hello' });
  const changed = await tx.update({ table: 'note', key, values: { body: 'edited' } });
  assert.deepEqual(changed.applied, { body: 'edited' });
});

test('lanes.by on a column the role cannot read is refused by queryFor and viewFor', () => {
  const grant: ColumnGrant = {
    readable: new Set(['note']),
    writable: new Set(),
    fields: new Map([['note', { read: new Set(['id', 'body']), write: new Set() }]]),
  };
  const checks = resourceChecks(schema, grant);
  assert.throws(
    () =>
      checks.queryFor({
        table: 'note',
        columns: ['id', 'body'],
        limit: 10,
        offset: 0,
        lanes: { by: 'secret', limit: 5 },
      }),
    AppAccessDenied,
  );
  assert.throws(
    () =>
      validateResourceView(schema, grant, {
        kind: 'list',
        table: 'note',
        columns: ['id', 'body'],
        lanes: { by: 'secret', limit: 5 },
      } as never),
    AppAccessDenied,
  );
  // Allowed column passes.
  assert.doesNotThrow(() =>
    checks.queryFor({
      table: 'note',
      columns: ['id', 'body'],
      limit: 10,
      offset: 0,
      lanes: { by: 'body', limit: 5 },
    }),
  );
});
